import { app } from "/scripts/app.js";
import { GalleryFilterControls, FILTER_DEFAULTS, normalizeFilters, normalizeRatings } from "./anima_danbooru_filter_controls.js";

(() => {
  const NODE_NAME = "DanbooruGallery";
  const STORAGE_KEY = "anima_danbooru_gallery_settings_v1";
  const FAVORITES_STORAGE_KEY = "anima_danbooru_gallery_favorites_v1";

  // 新 ComfyUI 前端会在节点内容上叠一层“激活面罩”：节点未激活时，第一次点击 DOM 控件会被面罩吃掉。
  // 这里用文档级捕获监听：只要指针落在某个画廊搜索框矩形内，就在下一帧（等节点完成激活）把焦点给输入框。
  const _danQueryFocusTargets = new Set();
  document.addEventListener("pointerdown", (event) => {
    if (!_danQueryFocusTargets.size) return;
    for (const ui of _danQueryFocusTargets) {
      const inp = ui.queryInput;
      if (!inp || !inp.isConnected) continue;
      const rect = inp.getBoundingClientRect();
      const x = event.clientX, y = event.clientY;
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        requestAnimationFrame(() => {
          try { if (inp.isConnected && document.activeElement !== inp) inp.focus({ preventScroll: true }); } catch {}
        });
      }
    }
  }, true);

  const MAX_TAGS = 5;
  const FREE_METATAGS = new Set(["rating", "status", "is", "age", "date", "id", "limit", "score", "downvotes", "favcount", "width", "height", "ratio", "mpixels", "filesize", "filetype", "duration", "md5", "pixiv_id", "pixiv", "parent", "child", "upvote", "embedded", "tagcount"]);
  // 慢排序：D站 对无时间窗的评分/收藏/随机排序会数据库超时 500，前端自动附带一个免费 metatag 时间窗（与后端常量一致）。
  const SLOW_ORDERS = new Set(["score", "favcount", "random"]);
  const DEFAULT_SLOW_ORDER_AGE = "1week";
  const DANBOORU_TAG_LIMIT = 2;
  const ORDER_LABELS = { score: "评分", favcount: "收藏", random: "随机", rank: "综合" };

  function normalizeTags(rawValue) {
    const seen = new Set();
    const tokens = [];
    for (const rawToken of String(rawValue ?? "").trim().split(/\s+/)) {
      const token = rawToken.trim().toLowerCase();
      // 排序只能由 settings.filters.order 维护，避免搜索框与筛选菜单产生两个 order owner。
      if (!token || token.startsWith("order:") || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
      if (tokens.length >= MAX_TAGS) break;
    }
    return tokens.join(" ");
  }

  function countedSearchTerms(query) {
    return String(query || "").split(/\s+/).filter(Boolean).filter((rawToken) => {
      const token = rawToken.replace(/^[-~]+/, "").toLowerCase();
      if (token === "or" || token === "(" || token === ")") return false;
      const colon = token.indexOf(":");
      return colon < 0 || !FREE_METATAGS.has(token.slice(0, colon));
    }).length;
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        limit: [12, 24, 48].includes(saved.limit) ? saved.limit : 24,
        rating: normalizeRatings(saved.rating),
        gridHeight: Number.isFinite(saved.gridHeight) ? Math.max(360, Math.min(1200, saved.gridHeight)) : 620,
        categories: Array.isArray(saved.categories) ? saved.categories : [],
        postCategories: saved.postCategories && typeof saved.postCategories === "object" ? saved.postCategories : {},
        presets: Array.isArray(saved.presets) ? saved.presets : [],
        activeCategory: typeof saved.activeCategory === "string" ? saved.activeCategory : "",
        filters: normalizeFilters(saved.filters),
        lastQuery: typeof saved.lastQuery === "string" ? saved.lastQuery : "",
      };
    } catch {
      return { limit: 24, rating: [], gridHeight: 620, categories: [], postCategories: {}, presets: [], activeCategory: "", filters: { ...FILTER_DEFAULTS }, lastQuery: "" };
    }
  }

  class DanbooruGalleryUI {
    constructor(node) {
      this.node = node;
      this.settings = loadSettings();
      this.page = 1;
      this.posts = [];
      this.requestId = 0;
      this.controller = null;
      this.root = null;
      this.grid = null;
      this.status = null;
      this.suggestions = null;
      this.selectionWidget = null;
      this.queryWidget = null;
      this.queryInput = null;
      this.dialogId = `anima-danbooru-dialog-${node.id}`;
      this.favorites = this.loadFavorites();
      this.translationCache = new Map();
      this.tooltip = null;
      this.domWidget = null;
      this.filterControls = null;
      this.registered = false; // 是否已登录 Danbooru
      this.tagLimitValue = 2;  // 计数标签上限（后端按账号等级动态：Member=2 / Gold+=6，随 /account 刷新）
    }

    async refreshAccount() {
      try {
        const d = await (await fetch("/anima/danbooru/account")).json();
        this.registered = Boolean(d?.logged_in);
        if (typeof d?.tag_limit === "number") this.tagLimitValue = d.tag_limit;
      } catch {
        this.registered = false;
      }
      return this.registered;
    }

    saveSettings() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    }

    applyGridHeight() {
      const height = this.settings.gridHeight;
      if (this.root) {
        this.root.style.height = `${height}px`;
        this.root.style.minHeight = `${height}px`;
        this.root.style.maxHeight = `${height}px`;
      }
      this.node.setSize?.([this.node.size?.[0] || 780, height + 95]);
      this.node.graph?.setDirtyCanvas?.(true, true);
    }

    loadFavorites() {
      try {
        return new Set(JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "[]").map(String));
      } catch {
        return new Set();
      }
    }

    saveFavorites() {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...this.favorites]));
    }

    toggleFavorite(postId) {
      const id = String(postId || "");
      if (!id) return false;
      if (this.favorites.has(id)) this.favorites.delete(id);
      else this.favorites.add(id);
      this.saveFavorites();
      return this.favorites.has(id);
    }

    setStatus(message, tone = "") {
      if (!this.status) return;
      this.status.textContent = message;
      this.status.dataset.tone = tone;
    }

    // 同步搜索框内容到 DOM 输入 + 隐藏的序列化 widget（两者始终一致）
    setQuery(value) {
      const v = String(value ?? "");
      if (this.queryInput) this.queryInput.value = v;
      if (this.queryWidget) this.queryWidget.value = v;
      this.fetchSuggestions(v);
    }

    currentQuery() {
      const raw = this.queryWidget?.value || this.settings.lastQuery || "";
      const f = this.settings.filters;
      // 评分/收藏/随机排序若不带时间窗，D站 会对全库排序造成数据库超时 500：
      // 自动附带一个时间窗（age 是免费 metatag，不占计数槽）。用户显式设置了 age 时尊重用户选择。
      const autoWindow = Boolean(f.order && SLOW_ORDERS.has(f.order) && !f.age);
      this._autoWindow = autoWindow;
      const age = autoWindow ? DEFAULT_SLOW_ORDER_AGE : f.age;
      const parts = [normalizeTags(raw), this.settings.rating.length ? `rating:${this.settings.rating.join(",")}` : "", age ? `age:${age}` : "", f.minScore ? `score:>${f.minScore}` : "", f.minFavs ? `favcount:>${f.minFavs}` : "", f.order ? `order:${f.order}` : ""];
      return parts.filter(Boolean).join(" ");
    }

    tagLimit() {
      // 计数标签上限：匿名/Member=2，Gold+=6。后端按账号等级动态返回（/account、/posts 响应带 tag_limit），
      // 前端优先用后端值，拉取前用保守默认 2。
      return typeof this.tagLimitValue === "number" && this.tagLimitValue > 0 ? this.tagLimitValue : DANBOORU_TAG_LIMIT;
    }

    async search({ resetPage = false, force = false, skipFuzzy = false } = {}) {
      this._droppedOrder = false;
      // 工作流恢复/外部修改时，确保输入框与序列化 widget 一致（widget 是权威值）
      if (this.queryInput && this.queryWidget && String(this.queryInput.value) !== String(this.queryWidget.value ?? "")) {
        this.queryInput.value = this.queryWidget.value ?? "";
      }
      let query = this.currentQuery();
      if (!query) {
        this.posts = [];
        this.renderPosts();
        this.setStatus("输入 Danbooru 标签后点“搜索”。例如：1girl solo");
        return;
      }
      let counted = countedSearchTerms(query);
      if (counted > this.tagLimit() && this.settings.filters.order) {
        // 匿名搜索最多 2 个计数标签，而排序会占 1 个；内容标签/分级/筛选才是用户意图，
        // 因此超限时优先保留这些、只自动降级排序（改用默认最新）而不是死路报错。
        const droppedOrder = this.settings.filters.order;
        this.settings.filters.order = "";
        this.saveSettings();
        this.filterControls.refresh();
        this._droppedOrder = droppedOrder;
        query = this.currentQuery();
        counted = countedSearchTerms(query);
      }
      if (counted > this.tagLimit()) {
        const hint = this.registered
          ? `D站 登录账号最多 ${this.tagLimit()} 个计数标签。请减少普通标签，或改用评级/时间/评分/收藏筛选。`
          : `D站 匿名搜索最多 ${this.tagLimit()} 个计数标签（普通标签与排序各占 1 个）。请减少普通标签或改用评级/时间/评分/收藏筛选；或在「设置」里登录 Danbooru 账号可解除限制。`;
        this.setStatus(hint, "error");
        return;
      }
      if (resetPage) this.page = 1;
      this.settings.lastQuery = normalizeTags(this.queryWidget?.value || "");
      this.saveSettings();
      this.setQuery(this.settings.lastQuery);

      this.controller?.abort();
      this.controller = new AbortController();
      const currentRequest = ++this.requestId;
      this.setStatus(`正在搜索：${query}`);
      if (this.grid) this.grid.setAttribute("aria-busy", "true");
      try {
        const parameters = new URLSearchParams({
          tags: query,
          page: String(this.page),
          limit: String(this.settings.limit),
          force: force ? "1" : "0",
        });
        // 45s 兜底超时（后端已多路重试，正常远快于此；防极端网络下无限转圈）
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; this.controller?.abort(); }, 45000);
        let response, data;
        try {
          response = await fetch(`/anima/danbooru/posts?${parameters}`, { signal: this.controller.signal });
          data = await response.json();
        } finally {
          clearTimeout(timer);
        }
        if (typeof data?.tag_limit === "number") this.tagLimitValue = data.tag_limit;
        if (currentRequest !== this.requestId) return;
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        this.posts = Array.isArray(data.posts) ? data.posts : [];
        if (!this.posts.length) {
          this.fetchSuggestions(this.queryWidget?.value || query, true);
          // 精确搜索无结果 → 模糊纠错（把近似标签替换成真实标签）自动重搜一次
          if (!skipFuzzy) await this.fuzzyRetry(query);
        }
        this.renderPosts();
        this.renderPagination();
        const source = data.cached ? "缓存" : "D站";
        const notices = [];
        if (Array.isArray(data.warnings) && data.warnings.length) notices.push(...data.warnings.map(String));
        if (this._autoWindow && this.settings.filters.order) notices.push(`「${ORDER_LABELS[this.settings.filters.order] || this.settings.filters.order}」排序已自动限定近 1 周，否则 D站 会超时`);
        if (this._droppedOrder) notices.push(`已自动移除「${ORDER_LABELS[this._droppedOrder] || this._droppedOrder}」排序，按最新显示（匿名最多 2 个计数标签）`);
        this.setStatus(`${source}：${this.posts.length} 张 · 第 ${this.page} 页` + (notices.length ? `（${notices.join("；")}）` : ""));
      } catch (error) {
        if (timedOut) {
          this.posts = [];
          this.renderPosts();
          this.setStatus("搜索超时（45 秒）：D站 或代理网络不稳定，已自动多路重试仍失败。请检查 Clash 节点后重试", "error");
          return;
        }
        if (error?.name === "AbortError") return;
        if (currentRequest !== this.requestId) return;
        this.posts = [];
        this.renderPosts();
        this.setStatus(`搜索失败：${error?.message || "未知错误"}`, "error");
      } finally {
        if (currentRequest === this.requestId && this.grid) this.grid.removeAttribute("aria-busy");
      }
    }
    async fetchSuggestions(q, empty = false) { if (!this.suggestions || !q?.trim()) return; try { const d = await (await fetch(`/anima/danbooru/suggest?q=${encodeURIComponent(q)}`)).json(); const a = empty ? d.didYouMean : d.suggestions; const r = d.rewrites || []; this.suggestions.innerHTML = a?.length ? `${empty ? '你是不是想搜：' : '智能提示：'}${a.map(x => `<button data-q="${x}">${x}</button>`).join('')} ${r.length ? `扩展：${r.join(' / ')}` : ''}` : ''; this.suggestions.querySelectorAll('button').forEach(b => b.onclick = () => { this.setQuery(b.dataset.q); this.search({resetPage:true}); }); } catch {} }

    // 模糊纠错后自动重搜（仅执行一次；此后用户再点搜索会走新的精确词）
    async fuzzyRetry(query) {
      try {
        const fz = await (await fetch(`/anima/danbooru/fuzzy?tags=${encodeURIComponent(query)}`)).json();
        if (fz && fz.changed && fz.corrected && fz.corrected !== query) {
          const note = Object.entries(fz.replacements || {}).map(([a, b]) => `${a} → ${b}`).join("，");
          this.setQuery(fz.corrected);
          this.setStatus(`模糊匹配：${note}，已自动换用完整标签搜索`);
          return this.search({ resetPage: false, force: false, skipFuzzy: true });
        }
      } catch { /* 模糊接口失败则不打扰，保留原有“你是不是想搜”提示 */ }
    }

    updateSelection() {
      const selected = [...this.grid.querySelectorAll(".adg-card.is-selected")].map((card) => ({
        image_url: card.dataset.imageUrl || "",
        prompt: card.dataset.prompt || "",
      }));
      const value = JSON.stringify({ selections: selected });
      this.selectionWidget.value = value;
      this.selectionWidget.callback?.(value);
      this.node.graph?.change?.();
      this.setStatus(selected.length ? `已选择 ${selected.length} 张图片` : "已清除选择");
    }

    postTags(post) {
      const groups = ["tag_string_character", "tag_string_copyright", "tag_string_general"];
      const seen = new Set();
      const tags = [];
      for (const group of groups) {
        for (const tag of String(post[group] || "").split(" ")) {
          if (tag && !seen.has(tag)) {
            seen.add(tag);
            tags.push(tag);
          }
        }
      }
      return tags;
    }

    postPrompt(post) {
      return this.postTags(post).map((tag) => tag.replace(/_/g, " ")).join(", ");
    }

    renderPosts() {
      if (!this.grid) return;
      this.grid.replaceChildren();
      if (!this.posts.length) {
        const empty = document.createElement("div");
        empty.className = "adg-empty";
        empty.textContent = "没有可显示的图片";
        this.grid.append(empty);
        return;
      }
      for (const post of this.posts) {
        if (this.settings.activeCategory && this.settings.postCategories[String(post.id)] !== this.settings.activeCategory) continue;
        const imageUrl = post.large_file_url || post.file_url || post.preview_file_url || "";
        if (!imageUrl) continue;
        const card = document.createElement("article");
        card.className = "adg-card";
        card.dataset.imageUrl = imageUrl;
        card.dataset.prompt = this.postPrompt(post);
        card.dataset.tags = JSON.stringify(this.postTags(post));
        card.dataset.postId = String(post.id || "");
        const selectButton = document.createElement("button");
        selectButton.type = "button";
        selectButton.className = "adg-card-select";
        selectButton.setAttribute("aria-pressed", "false");
        selectButton.title = `选择 #${post.id || ""}`;
        const preview = document.createElement("img");
        preview.loading = "lazy";
        preview.alt = `Danbooru #${post.id || ""}`;
        preview.src = `/anima/danbooru/image?url=${encodeURIComponent(post.preview_file_url || imageUrl)}`;
        preview.onerror = () => {
          preview.replaceWith(Object.assign(document.createElement("span"), { className: "adg-image-error", textContent: "预览加载失败" }));
        };
        const caption = document.createElement("span");
        caption.className = "adg-caption";
        const isVid = this.isVideoPost(post);
        caption.textContent = `#${post.id || "?"} · ${post.image_width || "?"}×${post.image_height || "?"}${isVid ? " · MP4" : ""}`;
        selectButton.append(preview, caption);
        if (isVid) {
          const badge = document.createElement("span");
          badge.className = "adg-video-badge";
          badge.textContent = "视频";
          badge.style.cssText = "position:absolute;top:6px;left:6px;z-index:3;background:rgba(0,0,0,.72);color:#fbbf24;font-size:10px;line-height:1.4;padding:1px 6px;border-radius:4px;pointer-events:none;";
          selectButton.prepend(badge);
        }
        selectButton.addEventListener("click", () => {
          const wasSelected = card.classList.contains("is-selected");
          this.grid.querySelectorAll(".adg-card.is-selected").forEach((other) => {
            other.classList.remove("is-selected");
            other.querySelector(".adg-card-select")?.setAttribute("aria-pressed", "false");
          });
          card.classList.toggle("is-selected", !wasSelected);
          selectButton.setAttribute("aria-pressed", !wasSelected ? "true" : "false");
          this.updateSelection();
        });
        const actions = document.createElement("div");
        actions.className = "adg-card-actions";
        const addAction = (label, title, handler) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.title = title;
          button.onclick = (event) => { event.stopPropagation(); handler(); };
          actions.append(button);
          return button;
        };
        addAction("看图", "查看原图", () => this.openImagePreview(post));
        addAction("Prompt", "查看、编辑和复制 Prompt", () => this.openPromptEditor(card, post));
        addAction("入库", "保存图片和 Prompt 到本地工具箱 Prompt 库", () => this.saveToPromptLibrary(post));
        addAction("下载", "下载原图", () => this.downloadPost(post));
        addAction("分类", "设置本地分类", () => { const names = ["无分类", ...this.settings.categories.map(c => c.name)]; const choice = prompt(`输入分类名称：\n${names.join(" / ")}`, this.settings.categories.find(c => c.id === this.settings.postCategories[String(post.id)])?.name || "无分类"); if (choice === null) return; const found = this.settings.categories.find(c => c.name === choice.trim()); if (choice.trim() === "" || choice.trim() === "无分类") delete this.settings.postCategories[String(post.id)]; else if (found) this.settings.postCategories[String(post.id)] = found.id; else { const c = { id: `c_${Date.now()}`, name: choice.trim() }; this.settings.categories.push(c); this.settings.postCategories[String(post.id)] = c.id; } this.saveSettings(); this.renderPosts(); });
        card.append(selectButton, actions);
        card.addEventListener("mouseenter", (event) => this.showPromptTooltip(card, event));
        card.addEventListener("mousemove", (event) => this.positionTooltip(event));
        card.addEventListener("mouseleave", () => this.hidePromptTooltip());
        this.grid.append(card);
      }
    }

    pageWindow() {
      const start = Math.max(1, this.page - 2);
      return Array.from({ length: 5 }, (_, index) => start + index);
    }

    renderPagination() {
      if (!this.pagination) return;
      this.pagination.replaceChildren();
      for (const page of this.pageWindow()) {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = String(page); button.classList.toggle("active", page === this.page);
        button.onclick = () => { this.page = page; this.search(); };
        this.pagination.append(button);
      }
      const input = document.createElement("input");
      input.type = "number"; input.min = "1"; input.value = String(this.page); input.title = "输入页码跳转";
      input.onkeydown = (event) => { if (event.key === "Enter") { this.page = Math.max(1, Number(input.value) || 1); this.search(); } };
      this.pagination.append(input);
      for (const [label, delta] of [["‹", -1], ["›", 1]]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = delta < 0 && this.page === 1;
        button.onclick = () => { this.page = Math.max(1, this.page + delta); this.search(); }; this.pagination.append(button);
      }
    }

    async saveToPromptLibrary(post) {
      const imageUrl = post.large_file_url || post.file_url || post.preview_file_url;
      if (!imageUrl) return;
      this.setStatus(`正在保存 #${post.id || ""} 到 Prompt 库…`);
      try {
        const imageResponse = await fetch(`/anima/danbooru/image?url=${encodeURIComponent(imageUrl)}`);
        if (!imageResponse.ok) throw new Error(`预览图 HTTP ${imageResponse.status}`);
        const imageBlob = await imageResponse.blob();
        const imageDataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("预览图转换失败"));
          reader.readAsDataURL(imageBlob);
        });
        const tags = this.postTags(post);
        const prompt = tags.map((tag) => tag.replace(/_/g, " ")).join(", ");
        const now = Date.now();
        const entry = {
          id: `p_${now}_${Math.random().toString(36).slice(2, 8)}`,
          prompt,
          displayText: `Danbooru #${post.id || ""}`,
          images: [imageDataUrl],
          primaryImage: imageDataUrl,
          tags,
          loras: [],
          categoryId: "uncategorized",
          notes: `来源：Danbooru #${post.id || ""}`,
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        };
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open("anima-lora");
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("prompts")) {
              const store = db.createObjectStore("prompts", { keyPath: "id" });
              store.createIndex("sourceModelId", "sourceModelId"); store.createIndex("tags", "tags", { multiEntry: true }); store.createIndex("categoryId", "categoryId"); store.createIndex("isFavorite", "isFavorite"); store.createIndex("displayText", "displayText"); store.createIndex("createdAt", "createdAt");
            }
            if (!db.objectStoreNames.contains("promptCategories")) db.createObjectStore("promptCategories", { keyPath: "id" });
            if (!db.objectStoreNames.contains("artists")) db.createObjectStore("artists", { keyPath: "tag" });
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || new Error("无法打开 Prompt 库"));
        });
        await new Promise((resolve, reject) => {
          const transaction = database.transaction(["prompts", "promptCategories"], "readwrite");
          const categories = transaction.objectStore("promptCategories");
          categories.get("uncategorized").onsuccess = (event) => { if (!event.target.result) categories.add({ id: "uncategorized", name: "未分类", icon: "", sortOrder: 0 }); };
          transaction.objectStore("prompts").add(entry);
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("写入 Prompt 库失败"));
        });
        database.close();
        this.setStatus(`已保存 #${post.id || ""} 到 Prompt 库`);
      } catch (error) {
        this.setStatus(`保存 Prompt 库失败：${error?.message || "未知错误"}`, "error");
      }
    }

    async showPromptTooltip(card, event) {
      let tags = [];
      try { tags = JSON.parse(card.dataset.tags || "[]"); } catch { tags = []; }
      if (!tags.length) return;
      this.hidePromptTooltip();
      const tooltip = document.createElement("div");
      tooltip.className = "adg-prompt-tooltip";
      tooltip.textContent = "正在加载双语 Prompt…";
      document.body.append(tooltip);
      this.tooltip = tooltip;
      this.positionTooltip(event);
      const missing = tags.filter((tag) => !this.translationCache.has(tag));
      if (missing.length) {
        try {
          const response = await fetch("/anima/danbooru/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: missing }) });
          const data = await response.json();
          for (const tag of missing) this.translationCache.set(tag, data.translations?.[tag] || "");
        } catch {
          for (const tag of missing) this.translationCache.set(tag, "");
        }
      }
      if (this.tooltip !== tooltip) return;
      tooltip.replaceChildren(...tags.map((tag) => {
        const line = document.createElement("div");
        line.className = "adg-prompt-tooltip-line";
        const english = document.createElement("span");
        english.textContent = tag.replace(/_/g, " ");
        const chinese = this.translationCache.get(tag);
        line.append(english);
        if (chinese) line.append(Object.assign(document.createElement("small"), { textContent: chinese }));
        return line;
      }));
    }

    positionTooltip(event) {
      if (!this.tooltip) return;
      const padding = 14;
      const rect = this.tooltip.getBoundingClientRect();
      const left = Math.min(window.innerWidth - rect.width - padding, event.clientX + padding);
      const top = Math.min(window.innerHeight - rect.height - padding, event.clientY + padding);
      this.tooltip.style.left = `${Math.max(padding, left)}px`;
      this.tooltip.style.top = `${Math.max(padding, top)}px`;
    }

    hidePromptTooltip() {
      this.tooltip?.remove();
      this.tooltip = null;
    }

    async downloadPost(post) {
      const imageUrl = post.large_file_url || post.file_url || post.preview_file_url;
      if (!imageUrl) return;
      this.setStatus(`正在下载 #${post.id || ""}…`);
      try {
        const response = await fetch(`/anima/danbooru/image?url=${encodeURIComponent(imageUrl)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = `danbooru_${post.id || "image"}.${post.file_ext || "jpg"}`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        this.setStatus(`已开始下载 #${post.id || ""}`);
      } catch (error) {
        this.setStatus(`下载失败：${error?.message || "未知错误"}`, "error");
      }
    }

    isVideoPost(post) {
      return String(post.file_ext || "").toLowerCase() === "mp4"
        || /\.(mp4|webm|m4v|mov|mkv)$/i.test(post.file_url || post.large_file_url || "");
    }

    openImagePreview(post) {
      const isVid = this.isVideoPost(post);
      // 视频帖没有可显示的"大图"（large 是 mp4）→ 用封面 jpg 兜底
      const imageUrl = isVid
        ? (post.preview_file_url || post.large_file_url || "")
        : (post.large_file_url || post.file_url || post.preview_file_url);
      if (!imageUrl) return;
      this.removeDialog();
      const overlay = document.createElement("div");
      overlay.id = this.dialogId;
      overlay.className = "adg-dialog-overlay adg-image-preview-overlay";
      const image = document.createElement("img");
      image.className = "adg-image-preview";
      image.alt = `Danbooru #${post.id || ""}`;
      image.src = `/anima/danbooru/image?url=${encodeURIComponent(imageUrl)}`;
      overlay.append(image);
      if (isVid) {
        const hint = document.createElement("div");
        hint.className = "adg-image-preview-hint";
        hint.textContent = "视频帖：此处显示封面（原文件为 MP4，点卡片「下载」可获取原视频）";
        hint.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fbbf24;font-size:12px;padding:6px 12px;border-radius:8px;z-index:5;";
        overlay.append(hint);
      }
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) this.removeDialog(); });
      document.body.append(overlay);
    }

    openPromptEditor(card, post) {
      const content = document.createElement("div");
      content.className = "adg-prompt-editor";
      const textarea = document.createElement("textarea");
      textarea.value = card.dataset.prompt || this.postPrompt(post);
      textarea.spellcheck = false;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "复制 Prompt";
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(textarea.value);
          this.setStatus("Prompt 已复制");
        } catch {
          textarea.select();
          document.execCommand("copy");
          this.setStatus("Prompt 已复制");
        }
      };
      content.append(textarea, copy);
      this.openDialog({
        title: `Prompt #${post.id || ""}`,
        content,
        onApply: () => {
          card.dataset.prompt = textarea.value.trim();
          if (card.classList.contains("is-selected")) this.updateSelection();
          this.setStatus("Prompt 已更新");
        },
      });
    }

    removeDialog() {
      document.getElementById(this.dialogId)?.remove();
    }

    openDialog({ title, content, onApply }) {
      this.removeDialog();
      const overlay = document.createElement("div");
      overlay.id = this.dialogId;
      overlay.className = "adg-dialog-overlay";
      const dialog = document.createElement("section");
      dialog.className = "adg-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const heading = document.createElement("h3");
      heading.textContent = title;
      const actions = document.createElement("div");
      actions.className = "adg-dialog-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      cancel.onclick = () => this.removeDialog();
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "primary";
      apply.textContent = "应用";
      apply.onclick = () => {
        onApply();
        this.removeDialog();
      };
      actions.append(cancel, apply);
      dialog.append(heading, content, actions);
      overlay.append(dialog);
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) this.removeDialog(); });
      document.body.append(overlay);
    }

    openSettings() {
      const content = document.createElement("div");
      content.className = "adg-settings-fields";
      const pageLabel = document.createElement("label");
      pageLabel.className = "adg-field";
      pageLabel.textContent = "每页图片数";
      const select = document.createElement("select");
      [12, 24, 48].forEach((limit) => select.add(new Option(String(limit), String(limit), false, limit === this.settings.limit)));
      pageLabel.append(select);
      const heightLabel = document.createElement("label");
      heightLabel.className = "adg-field";
      heightLabel.textContent = "画廊高度（px）";
      const heightInput = document.createElement("input");
      heightInput.type = "number";
      heightInput.min = "360";
      heightInput.max = "1200";
      heightInput.step = "20";
      heightInput.value = String(this.settings.gridHeight);
      heightLabel.append(heightInput);
      content.append(pageLabel, heightLabel);

      // ── D站 账号（登录后解除匿名 2 标签限制，更少限流）──
      this.refreshAccount().then((reg) => {
        content.querySelector(".adg-account-status")?.remove();
        const status = document.createElement("div");
        status.className = "adg-account-status";
        status.style.cssText = "font-size:11px;color:var(--text2,#999);margin-top:4px;";
        status.textContent = reg ? "✓ 已登录 Danbooru（标签上限 6 个，多筛选更自由）" : "ℹ 未登录：匿名最多 2 个计数标签。登录后可同时组合更多标签+排序。";
        content.append(status);
      });
      const accTitle = document.createElement("div");
      accTitle.className = "adg-field";
      accTitle.textContent = "Danbooru 登录（解除标签上限）";
      const userLabel = document.createElement("label");
      userLabel.className = "adg-field";
      userLabel.textContent = "用户名";
      const userInput = document.createElement("input");
      userInput.placeholder = "danbooru 用户名";
      userLabel.append(userInput);
      const keyLabel = document.createElement("label");
      keyLabel.className = "adg-field";
      keyLabel.textContent = "API Key（个人设置页 -> API Key 生成）";
      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.placeholder = "粘贴 API Key";
      keyLabel.append(keyInput);
      const tip = document.createElement("div");
      tip.style.cssText = "font-size:10px;color:var(--text2,#999);";
      tip.textContent = "凭证仅存本机插件目录，不上传。清空保存 = 退出登录。";
      content.append(accTitle, userLabel, keyLabel, tip);
      const accBtn = document.createElement("button");
      accBtn.type = "button";
      accBtn.className = "primary";
      accBtn.textContent = "保存登录";
      accBtn.style.cssText = "margin-top:6px;padding:4px 10px;border-radius:6px;background:#8b5cf6;color:#fff;border:none;cursor:pointer;font-size:11px;";
      accBtn.onclick = async () => {
        accBtn.disabled = true;
        accBtn.textContent = "保存中…";
        try {
          const ud = userInput.value.trim();
          const kd = keyInput.value.trim();
          const r = await fetch("/anima/danbooru/account", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: ud, api_key: kd }),
          });
          const j = await r.json();
          this.registered = Boolean(j?.logged_in);
          if (typeof j?.tag_limit === "number") this.tagLimitValue = j.tag_limit;
          const st = content.querySelector(".adg-account-status");
          if (st) st.textContent = this.registered ? `✓ 已登录 · ${j?.username || ""}` : "ℹ 已退出（匿名 2 标签限制）";
          this.setStatus(this.registered ? `D站 登录成功，当前计数标签上限 ${this.tagLimitValue} 个` : "D站 已退出登录", "success");
          this.search({ resetPage: true });
        } catch {
          this.setStatus("保存登录失败，请重试", "error");
        }
        accBtn.disabled = false;
        accBtn.textContent = "保存登录";
      };
      content.append(accBtn);

      this.openDialog({
        title: "画廊设置",
        content,
        onApply: () => {
          this.settings.limit = Number(select.value);
          this.settings.gridHeight = Math.max(360, Math.min(1200, Number(heightInput.value) || 620));
          this.saveSettings();
          this.applyGridHeight();
          this.search({ resetPage: true });
        },
      });
    }

    build() {
      this.filterControls?.destroy();
      const root = document.createElement("section");
      root.className = "anima-danbooru-gallery";
      // ── 搜索输入框：真实 DOM 输入（替代画布文本 widget），回车直接搜索 ──
      const queryRow = document.createElement("div");
      queryRow.className = "adg-queryrow";
      const queryInput = document.createElement("input");
      queryInput.className = "adg-query";
      queryInput.type = "text";
      queryInput.placeholder = "标签（模糊匹配，回车直接搜）如：1girl long hair…";
      queryInput.value = this.settings.lastQuery || "";
      // 让搜索框能被正常点击聚焦：ComfyUI 在捕获阶段会把点击/焦点抢给节点容器，
      // stopPropagation 挡不住；这里 mousedown preventDefault + 下一帧强制 focus，确保输入落在框内
      const focusLock = () => {
        requestAnimationFrame(() => {
          try { if (document.activeElement !== queryInput) queryInput.focus({ preventScroll: true }); } catch {}
        });
      };
      queryInput.addEventListener("pointerdown", (e) => { e.stopPropagation(); focusLock(); });
      queryInput.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); focusLock(); });
      queryInput.addEventListener("click", (e) => { e.stopPropagation(); focusLock(); });
      queryInput.oninput = () => {
        if (this.queryWidget) this.queryWidget.value = queryInput.value;
        this.fetchSuggestions(queryInput.value);
      };
      queryInput.onkeydown = (event) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          this.search({ resetPage: true });
        }
      };
      queryRow.append(queryInput);
      this.queryInput = queryInput;
      _danQueryFocusTargets.add(this);
      const toolbar = document.createElement("div");
      toolbar.className = "adg-toolbar";
      const addAction = (label, title, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.onpointerdown = (event) => event.stopPropagation();
        button.onmousedown = (event) => event.stopPropagation();
        button.onclick = (event) => { event.stopPropagation(); action(); };
        toolbar.append(button);
      };
      addAction("搜索", "按上方标签搜索", () => this.search({ resetPage: true }));
      addAction("设置", "设置每页图片数", () => this.openSettings());
      this.filterControls = new GalleryFilterControls({
        readSettings: () => this.settings,
        commit: (patch, { search = false, render = false } = {}) => {
          if (patch.rating) patch.rating = normalizeRatings(patch.rating);
          if (patch.filters) patch.filters = normalizeFilters(patch.filters);
          Object.assign(this.settings, patch);
          this.saveSettings();
          if (render) this.renderPosts();
          if (search) this.search({ resetPage: true });
        },
      });
      this.filterControls.mountFilters(toolbar);
      addAction("刷新", "绕过缓存重新搜索", () => this.search({ force: true }));
      this.filterControls.mountCategory(toolbar);
      addAction("＋类", "新建分类", () => {
        const name = prompt("分类名称");
        if (!name?.trim()) return;
        this.settings.categories.push({ id: `c_${Date.now()}`, name: name.trim() });
        this.saveSettings();
        this.filterControls.refresh();
      });
      const preset = document.createElement("select"); preset.title = "搜索预设";
      preset.innerHTML = `<option value="">搜索预设</option>${this.settings.presets.map((p, i) => `<option value="${i}">${p.name}</option>`).join("")}`;
      preset.onchange = () => {
        if (preset.value === "") return;
        const p = this.settings.presets[Number(preset.value)];
        if (!p) return;
        this.setQuery(p.query);
        this.settings.rating = normalizeRatings(p.rating);
        this.settings.filters = normalizeFilters(p.filters);
        this.saveSettings();
        this.filterControls.refresh();
        this.search({ resetPage: true });
        preset.value = "";
      };
      toolbar.append(preset);
      addAction("存预设", "保存当前搜索和筛选", () => {
        const name = prompt("预设名称");
        if (!name?.trim()) return;
        this.settings.presets.push({ name: name.trim(), query: this.queryWidget.value, rating: [...this.settings.rating], filters: { ...this.settings.filters } });
        this.saveSettings();
        preset.add(new Option(name.trim(), String(this.settings.presets.length - 1)));
      });
      const pagination = document.createElement("div"); pagination.className = "adg-pagination"; toolbar.append(pagination); this.pagination = pagination;
      const info = document.createElement("div");
      info.className = "adg-info";
      info.textContent = "图片操作在卡片悬浮工具条。";
      const status = document.createElement("div");
      status.className = "adg-status";
      const grid = document.createElement("div");
      grid.className = "adg-grid";
      const suggestions = document.createElement('div'); suggestions.className = 'adg-suggestions'; this.suggestions = suggestions;
      root.append(queryRow, toolbar, suggestions, info, status, grid);
      this.root = root;
      this.status = status;
      this.grid = grid;
      this.applyGridHeight();
      const initialQuery = this.settings.lastQuery || "1girl";
      this.setQuery(initialQuery);
      this.setStatus("正在自动加载图片…");
      this.renderPosts();
      this.renderPagination();
      this.refreshAccount(); // 异步刷新登录状态（标签上限 2/6），不阻塞初始搜索
      setTimeout(() => this.search({ resetPage: true }), 0);
      return root;
    }

    dispose() {
      _danQueryFocusTargets.delete(this);
      this.controller?.abort();
      this.filterControls?.destroy();
      this.hidePromptTooltip();
      this.removeDialog();
    }
  }

  function injectStylesheet() {
    if (document.getElementById("anima-danbooru-gallery-style")) return;
    const link = document.createElement("link");
    link.id = "anima-danbooru-gallery-style";
    link.rel = "stylesheet";
    link.href = "/extensions/ComfyUI-Anima-Batch-LoRA/css/anima_danbooru_gallery.css";
    document.head.append(link);
  }

  app.registerExtension({
    name: "Anima.DanbooruGallery",
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_NAME) return;
      injectStylesheet();
      const originalCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const result = originalCreated?.apply(this, arguments);
        if (this._animaDanbooruGallery) return result;
        const ui = new DanbooruGalleryUI(this);
        this._animaDanbooruGallery = ui;
        const selectionWidget = this.addWidget?.("text", "selection_data", "{}", () => {}, { serialize: true });
        if (selectionWidget) {
          selectionWidget.computeSize = () => [0, -4];
          selectionWidget.draw = () => {};
          selectionWidget.type = "hidden";
          ui.selectionWidget = selectionWidget;
        }
        // 搜索改由组件顶部真实 DOM 输入框承载；不再创建画布 text widget——
        // 旧 ComfyUI 前端会把 hidden widget 当可点击对象，触发「Value」编辑弹窗并从 LGraphCanvas.active_canvas 解构而崩溃。
        ui.queryWidget = { value: ui.settings.lastQuery };
        const element = ui.build();
        const domWidget = this.addDOMWidget?.("anima_danbooru_gallery", "custom", element, { serialize: false, hideOnZoom: false });
        if (domWidget) domWidget.computeSize = (width) => [Math.max(360, width || 760), 620];
        this.setSize?.([780, 700]);
        const originalRemoved = this.onRemoved;
        this.onRemoved = function () {
          this._animaDanbooruGallery?.dispose();
          return originalRemoved?.apply(this, arguments);
        };
        return result;
      };
    },
  });
})();
