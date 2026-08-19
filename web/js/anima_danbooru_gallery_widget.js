import { app } from "/scripts/app.js";

(() => {
  const NODE_NAME = "DanbooruGallery";
  const STORAGE_KEY = "anima_danbooru_gallery_settings_v1";
  const FAVORITES_STORAGE_KEY = "anima_danbooru_gallery_favorites_v1";
  const MAX_TAGS = 5;

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function normalizeTags(rawValue) {
    const seen = new Set();
    const tokens = [];
    for (const rawToken of String(rawValue ?? "").trim().split(/\s+/)) {
      const token = rawToken.trim().toLowerCase();
      if (!token || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
      if (tokens.length >= MAX_TAGS) break;
    }
    return tokens.join(" ");
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        limit: [12, 24, 48].includes(saved.limit) ? saved.limit : 24,
        rating: ["", "g", "s", "q", "e"].includes(saved.rating) ? saved.rating : "",
        gridHeight: Number.isFinite(saved.gridHeight) ? Math.max(360, Math.min(1200, saved.gridHeight)) : 620,
        categories: Array.isArray(saved.categories) ? saved.categories : [],
        postCategories: saved.postCategories && typeof saved.postCategories === "object" ? saved.postCategories : {},
        presets: Array.isArray(saved.presets) ? saved.presets : [],
        activeCategory: typeof saved.activeCategory === "string" ? saved.activeCategory : "",
        filters: saved.filters && typeof saved.filters === "object" ? saved.filters : { age: "", minScore: "", minFavs: "", order: "" },
        lastQuery: typeof saved.lastQuery === "string" ? saved.lastQuery : "",
      };
    } catch {
      return { limit: 24, rating: "", lastQuery: "" };
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
      this.dialogId = `anima-danbooru-dialog-${node.id}`;
      this.favorites = this.loadFavorites();
      this.translationCache = new Map();
      this.tooltip = null;
      this.domWidget = null;
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

    currentQuery() {
      const raw = this.queryWidget?.value || this.settings.lastQuery || "";
      const f = this.settings.filters;
      const parts = [normalizeTags(raw), this.settings.rating ? `rating:${this.settings.rating}` : "", f.age ? `age:${f.age}` : "", f.minScore ? `score:>${f.minScore}` : "", f.minFavs ? `favcount:>${f.minFavs}` : "", f.order ? `order:${f.order}` : ""];
      return parts.filter(Boolean).join(" ");
    }

    async search({ resetPage = false, force = false } = {}) {
      const query = this.currentQuery();
      if (!query) {
        this.posts = [];
        this.renderPosts();
        this.setStatus("输入 Danbooru 标签后点“搜索”。例如：1girl solo");
        return;
      }
      if (resetPage) this.page = 1;
      this.settings.lastQuery = normalizeTags(this.queryWidget?.value || query);
      this.saveSettings();
      this.queryWidget.value = this.settings.lastQuery;

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
        const response = await fetch(`/anima/danbooru/posts?${parameters}`, { signal: this.controller.signal });
        const data = await response.json();
        if (currentRequest !== this.requestId) return;
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        this.posts = Array.isArray(data.posts) ? data.posts : [];
        if (!this.posts.length) this.fetchSuggestions(this.queryWidget.value, true);
        this.renderPosts();
        this.renderPagination();
        const source = data.cached ? "缓存" : "D站";
        this.setStatus(`${source}：${this.posts.length} 张 · 第 ${this.page} 页`);
      } catch (error) {
        if (error?.name === "AbortError") return;
        if (currentRequest !== this.requestId) return;
        this.posts = [];
        this.renderPosts();
        this.setStatus(`搜索失败：${error?.message || "未知错误"}`, "error");
      } finally {
        if (currentRequest === this.requestId && this.grid) this.grid.removeAttribute("aria-busy");
      }
    }
    async fetchSuggestions(q, empty = false) { if (!this.suggestions || !q?.trim()) return; try { const d = await (await fetch(`/anima/danbooru/suggest?q=${encodeURIComponent(q)}`)).json(); const a = empty ? d.didYouMean : d.suggestions; const r = d.rewrites || []; this.suggestions.innerHTML = a?.length ? `${empty ? '你是不是想搜：' : '智能提示：'}${a.map(x => `<button data-q="${x}">${x}</button>`).join('')} ${r.length ? `扩展：${r.join(' / ')}` : ''}` : ''; this.suggestions.querySelectorAll('button').forEach(b => b.onclick = () => { this.queryWidget.value = b.dataset.q; this.search({resetPage:true}); }); } catch {} }

    toggleRanking() {
      this.settings.filters.order = this.settings.filters.order === "rank" ? "" : "rank";
      this.saveSettings();
      this.search({ resetPage: true });
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
        caption.textContent = `#${post.id || "?"} · ${post.image_width || "?"}×${post.image_height || "?"}`;
        selectButton.append(preview, caption);
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

    openImagePreview(post) {
      const imageUrl = post.large_file_url || post.file_url || post.preview_file_url;
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

    openControlDock() {
      this.removeDialog();
      const overlay = document.createElement("div");
      overlay.id = this.dialogId;
      overlay.className = "adg-dialog-overlay";
      const dialog = document.createElement("section");
      dialog.className = "adg-dialog adg-control-dock";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const title = document.createElement("h3");
      title.textContent = "画廊操作";
      const controls = document.createElement("div");
      controls.className = "adg-control-grid";
      const addControl = (label, titleText, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = titleText;
        button.onclick = () => {
          this.removeDialog();
          action();
        };
        controls.append(button);
      };
      addControl("搜索", "按当前标签搜索", () => this.search({ resetPage: true }));
      addControl("筛选", "按分级筛选", () => this.openFilter());
      addControl("设置", "设置每页数量", () => this.openSettings());
      addControl("刷新", "绕过缓存重新搜索", () => this.search({ force: true }));
      addControl("排行榜", "切换 order:rank", () => this.toggleRanking());
      addControl("上一页", "上一页结果", () => { if (this.page > 1) { this.page -= 1; this.search(); } });
      addControl("下一页", "下一页结果", () => { this.page += 1; this.search(); });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "adg-control-close";
      close.textContent = "关闭";
      close.onclick = () => this.removeDialog();
      dialog.append(title, controls, close);
      overlay.append(dialog);
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) this.removeDialog(); });
      document.body.append(overlay);
    }

    openGallery() {
      this.removeDialog();
      const overlay = document.createElement("div");
      overlay.id = this.dialogId;
      overlay.className = "adg-dialog-overlay";
      const dialog = document.createElement("section");
      dialog.className = "adg-gallery-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const header = document.createElement("div");
      header.className = "adg-gallery-header";
      const input = document.createElement("input");
      input.value = this.queryWidget?.value || this.settings.lastQuery || "";
      input.placeholder = "Danbooru 标签，例如：1girl solo";
      input.oninput = () => { this.queryWidget.value = input.value; };
      input.onkeydown = (event) => { if (event.key === "Enter") this.search({ resetPage: true }); };
      const add = (label, title, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.onclick = action;
        header.append(button);
      };
      header.append(input);
      add("搜索", "按当前标签搜索", () => this.search({ resetPage: true }));
      add("刷新", "绕过缓存重新搜索", () => this.search({ force: true }));
      add("排行榜", "切换 order:rank", () => this.toggleRanking());
      const rating = document.createElement("select");
      rating.title = "分级筛选";
      [["", "全部分级"], ["g", "General"], ["s", "Sensitive"], ["q", "Questionable"], ["e", "Explicit"]].forEach(([value, label]) => rating.add(new Option(label, value, false, value === this.settings.rating)));
      rating.onchange = () => { this.settings.rating = rating.value; this.saveSettings(); this.search({ resetPage: true }); };
      header.append(rating);
      const limit = document.createElement("select");
      limit.title = "每页图片数";
      [12, 24, 48].forEach((value) => limit.add(new Option(`${value} 张/页`, String(value), false, value === this.settings.limit)));
      limit.onchange = () => { this.settings.limit = Number(limit.value); this.saveSettings(); this.search({ resetPage: true }); };
      header.append(limit);
      add("上一页", "上一页结果", () => { if (this.page > 1) { this.page -= 1; this.search(); } });
      add("下一页", "下一页结果", () => { this.page += 1; this.search(); });
      add("关闭", "关闭画廊", () => this.removeDialog());
      const status = document.createElement("div");
      status.className = "adg-status";
      const grid = document.createElement("div");
      grid.className = "adg-grid";
      dialog.append(header, status, grid);
      overlay.append(dialog);
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) this.removeDialog(); });
      document.body.append(overlay);
      this.root = dialog;
      this.status = status;
      this.grid = grid;
      this.renderPosts();
      this.setStatus(this.posts.length ? `已载入 ${this.posts.length} 张图片 · 第 ${this.page} 页` : "输入标签后点击“搜索”");
    }

    openFilter() {
      const content = document.createElement("label");
      content.className = "adg-field";
      content.textContent = "分级";
      const select = document.createElement("select");
      [["", "全部"], ["g", "General"], ["s", "Sensitive"], ["q", "Questionable"], ["e", "Explicit"]].forEach(([value, label]) => {
        const option = new Option(label, value, false, value === this.settings.rating);
        select.add(option);
      });
      content.append(select);
      const age = document.createElement("input"); age.placeholder = "时间，如 1week / 1month"; age.value = this.settings.filters.age || ""; content.append(age);
      const score = document.createElement("input"); score.type = "number"; score.placeholder = "最低评分"; score.value = this.settings.filters.minScore || ""; content.append(score);
      const favs = document.createElement("input"); favs.type = "number"; favs.placeholder = "最低收藏数"; favs.value = this.settings.filters.minFavs || ""; content.append(favs);
      const order = document.createElement("select"); [["","默认最新"],["score","评分"],["favcount","收藏数"],["rank","综合排行"],["random","随机"]].forEach(([v,l]) => order.add(new Option(l,v,false,v === this.settings.filters.order))); content.append(order);
      this.openDialog({
        title: "筛选图片",
        content,
        onApply: () => {
          this.settings.rating = select.value;
          this.settings.filters = { age: age.value.trim(), minScore: score.value, minFavs: favs.value, order: order.value };
          this.saveSettings();
          this.search({ resetPage: true });
        },
      });
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
      const root = document.createElement("section");
      root.className = "anima-danbooru-gallery";
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
      const ratingMenu = document.createElement("details"); ratingMenu.className = "adg-dropdown";
      ratingMenu.innerHTML = `<summary>分级</summary><div class="adg-menu">${[["g","普通"],["s","敏感"],["q","可疑"],["e","明确"]].map(([v,l]) => `<label><input type="checkbox" value="${v}" ${(this.settings.rating || "").split(",").includes(v) ? "checked" : ""}>${l}</label>`).join("")}</div>`;
      ratingMenu.querySelectorAll("input").forEach(x => x.onchange = () => { this.settings.rating = [...ratingMenu.querySelectorAll("input:checked")].map(y => y.value).join(","); this.saveSettings(); this.search({resetPage:true}); }); toolbar.append(ratingMenu);
      const filterMenu = document.createElement("details"); filterMenu.className = "adg-dropdown";
      filterMenu.innerHTML = `<summary>筛选</summary><div class="adg-menu"><label>时间 <select data-f="age"><option value="">全部</option><option value="1day">今天</option><option value="1week">本周</option><option value="1month">本月</option></select></label><label>评分 <input data-f="minScore" type="number"></label><label>收藏 <input data-f="minFavs" type="number"></label><label>排序 <select data-f="order"><option value="">最新</option><option value="score">评分</option><option value="favcount">收藏</option><option value="rank">综合</option><option value="random">随机</option></select></label></div>`;
      filterMenu.querySelectorAll("[data-f]").forEach(x => { x.value = this.settings.filters[x.dataset.f] || ""; x.onchange = () => { filterMenu.querySelectorAll("[data-f]").forEach(y => this.settings.filters[y.dataset.f] = y.value); this.saveSettings(); this.search({resetPage:true}); }; }); toolbar.append(filterMenu);
      addAction("刷新", "绕过缓存重新搜索", () => this.search({ force: true }));
      addAction("排行", "切换排行榜", () => this.toggleRanking());
      const category = document.createElement("select");
      const categories = [{ id: "", name: "无分类" }, ...this.settings.categories];
      category.innerHTML = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
      category.value = this.settings.activeCategory; category.title = "按本地分类筛选";
      category.onchange = () => { this.settings.activeCategory = category.value; this.saveSettings(); this.renderPosts(); };
      toolbar.append(category);
      addAction("＋类", "新建分类", () => { const name = prompt("分类名称"); if (!name?.trim()) return; this.settings.categories.push({ id: `c_${Date.now()}`, name: name.trim() }); this.saveSettings(); this.root?.replaceWith(this.build()); });
      const preset = document.createElement("select"); preset.title = "搜索预设";
      preset.innerHTML = `<option value="">搜索预设</option>${this.settings.presets.map((p, i) => `<option value="${i}">${p.name}</option>`).join("")}`;
      preset.onchange = () => { const p = this.settings.presets[Number(preset.value)]; if (!p) return; this.queryWidget.value = p.query; this.settings.rating = p.rating; this.settings.filters = p.filters; this.search({ resetPage: true }); };
      toolbar.append(preset);
      addAction("存预设", "保存当前搜索和筛选", () => { const name = prompt("预设名称"); if (!name?.trim()) return; this.settings.presets.push({ name: name.trim(), query: this.queryWidget.value, rating: this.settings.rating, filters: this.settings.filters }); this.saveSettings(); this.root?.replaceWith(this.build()); });
      const pagination = document.createElement("div"); pagination.className = "adg-pagination"; toolbar.append(pagination); this.pagination = pagination;
      const info = document.createElement("div");
      info.className = "adg-info";
      info.textContent = "图片操作在卡片悬浮工具条。";
      const status = document.createElement("div");
      status.className = "adg-status";
      const grid = document.createElement("div");
      grid.className = "adg-grid";
      const suggestions = document.createElement('div'); suggestions.className = 'adg-suggestions'; this.suggestions = suggestions;
      root.append(toolbar, suggestions, info, status, grid);
      this.root = root;
      this.status = status;
      this.grid = grid;
      this.applyGridHeight();
      const initialQuery = this.settings.lastQuery || "1girl";
      this.queryWidget.value = initialQuery;
      this.setStatus("正在自动加载图片…");
      this.renderPosts();
      this.renderPagination();
      setTimeout(() => this.search({ resetPage: true }), 0);
      return root;
    }

    dispose() {
      this.controller?.abort();
      this.hidePromptTooltip();
      this.removeDialog();
    }
  }

  function injectStyles() {
    if (document.getElementById("anima-danbooru-gallery-style")) return;
    const style = document.createElement("style");
    style.id = "anima-danbooru-gallery-style";
    style.textContent = `
      .anima-danbooru-gallery { box-sizing:border-box; height:620px; min-height:620px; max-height:620px; display:flex; flex-direction:column; gap:7px; padding:8px; overflow:hidden; color:#d9d9de; font:12px/1.35 system-ui,sans-serif; background:rgba(20,20,26,.78); border:1px solid rgba(255,255,255,.1); border-radius:8px; }
      .adg-toolbar { display:flex; flex-wrap:wrap; gap:5px; align-items:center; } .adg-toolbar button,.adg-toolbar select { min-width:0; padding:4px 9px; border:1px solid #55566a; border-radius:5px; color:#e9e9ef; background:#353540; font-size:11px; cursor:pointer; } .adg-toolbar button:hover,.adg-toolbar button.active { border-color:#a895ff; background:#6758c9; } .adg-pagination { display:flex; gap:3px; align-items:center; margin-left:auto; } .adg-pagination button { width:24px; padding:4px 0; } .adg-pagination input { width:42px; padding:4px; border:1px solid #55566a; border-radius:5px; color:#eee; background:#1b1b22; font-size:11px; } .adg-pagination button:disabled { opacity:.35; cursor:not-allowed; }
      .anima-danbooru-summary { padding:7px 9px; color:#aeb1bd; font:12px/1.4 system-ui,sans-serif; }
      .adg-info { color:#aeb1bd; } .adg-status { min-height:17px; color:#8e94a7; } .adg-status[data-tone="error"] { color:#ff8b8b; }
      .adg-grid { flex:1 1 auto; min-height:0; overflow-y:auto; columns:150px; column-gap:7px; padding-right:3px; }
      .adg-card { position:relative; break-inside:avoid; margin:0 0 7px; overflow:hidden; padding:3px; border:2px solid rgba(255,255,255,.1); border-radius:7px; background:#16161d; transition:border-color .15s,box-shadow .15s,transform .15s; } .adg-card:hover { border-color:#7668d8; transform:translateY(-1px); } .adg-card.is-selected { border-color:#b49cff; background:rgba(109,86,210,.24); box-shadow:0 0 0 2px rgba(180,156,255,.45),0 0 22px rgba(125,92,255,.72); } .adg-card.is-selected::after { content:"已选"; position:absolute; top:8px; left:8px; z-index:2; padding:3px 7px; border-radius:999px; color:#fff; background:#765ee8; box-shadow:0 2px 8px rgba(0,0,0,.45); font-size:10px; font-weight:700; }
      .adg-card-select { display:flex; width:100%; flex-direction:column; gap:4px; border:0; padding:0; color:inherit; background:transparent; text-align:left; cursor:pointer; } .adg-card-select:focus-visible { outline:2px solid #a895ff; outline-offset:1px; } .adg-card img { display:block; width:100%; height:auto; aspect-ratio:auto; object-fit:contain; background:#292934; } .adg-caption { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aeb1bd; font-size:10px; } .adg-image-error,.adg-empty { display:grid; min-height:90px; place-items:center; color:#ff9f9f; background:#292934; } .adg-empty { column-span:all; color:#9296a5; }
      .adg-card-actions { position:absolute; top:7px; right:7px; display:flex; gap:3px; opacity:0; transform:translateY(-3px); transition:opacity .15s,transform .15s; } .adg-card:hover .adg-card-actions,.adg-card:focus-within .adg-card-actions { opacity:1; transform:translateY(0); } .adg-card-actions button { min-width:24px; padding:3px 5px; border:1px solid rgba(255,255,255,.2); border-radius:4px; color:#fff; background:rgba(0,0,0,.76); font-size:9px; cursor:pointer; } .adg-card-actions button:hover,.adg-card-actions button.is-favorite { background:#6758c9; border-color:#9988ff; }
      .adg-prompt-tooltip { position:fixed; z-index:100001; display:flex; flex-wrap:wrap; align-content:flex-start; gap:5px; max-width:min(620px,70vw); max-height:55vh; overflow:auto; padding:9px; border:1px solid rgba(180,156,255,.7); border-radius:7px; color:#ecebff; background:rgba(19,18,28,.96); box-shadow:0 10px 28px rgba(0,0,0,.55); font:11px/1.35 system-ui,sans-serif; pointer-events:none; } .adg-prompt-tooltip-line { display:inline-flex; flex:0 0 auto; gap:5px; align-items:baseline; max-width:100%; padding:3px 6px; border:1px solid rgba(255,255,255,.1); border-radius:4px; background:rgba(255,255,255,.045); } .adg-prompt-tooltip-line span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .adg-prompt-tooltip-line small { color:#bcaeff; white-space:nowrap; } .adg-prompt-tooltip::-webkit-scrollbar { width:12px; height:12px; } .adg-prompt-tooltip::-webkit-scrollbar-track { border-radius:8px; background:#171521; } .adg-prompt-tooltip::-webkit-scrollbar-thumb { min-height:42px; border:3px solid #171521; border-radius:8px; background:#9d8cff; } .adg-prompt-tooltip::-webkit-scrollbar-thumb:hover { background:#c0b4ff; }
      .adg-dialog-overlay { position:fixed; inset:0; z-index:100000; display:grid; place-items:center; background:rgba(0,0,0,.6); } .adg-dialog { min-width:280px; max-width:90vw; padding:18px; border:1px solid rgba(255,255,255,.15); border-radius:10px; color:#eee; background:#24242d; box-shadow:0 20px 50px rgba(0,0,0,.5); } .adg-dialog h3 { margin:0 0 14px; } .adg-settings-fields { display:flex; flex-direction:column; gap:12px; } .adg-field { display:flex; flex-direction:column; gap:6px; color:#bfc2ce; } .adg-field select,.adg-field input { min-width:190px; padding:6px; color:#eee; background:#17171d; border:1px solid #55566a; border-radius:5px; } .adg-dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; } .adg-dialog-actions button,.adg-prompt-editor button { padding:6px 12px; color:#eee; border:1px solid #55566a; border-radius:5px; background:#353540; cursor:pointer; } .adg-dialog-actions .primary { border-color:#7766df; background:#6657c9; }
      .adg-control-dock { min-width:390px; } .adg-control-grid { display:grid; grid-template-columns:repeat(4,minmax(72px,1fr)); gap:7px; } .adg-control-grid button,.adg-control-close { padding:8px 6px; border:1px solid #55566a; border-radius:6px; color:#eee; background:#353540; cursor:pointer; } .adg-control-grid button:hover { border-color:#9988ff; background:#6758c9; } .adg-control-close { display:block; margin:12px 0 0 auto; }
      .adg-prompt-editor { display:flex; flex-direction:column; gap:8px; } .adg-prompt-editor textarea { width:min(620px,76vw); height:220px; resize:vertical; box-sizing:border-box; padding:8px; border:1px solid #55566a; border-radius:6px; color:#eee; background:#17171d; font:12px/1.45 ui-monospace,monospace; } .adg-image-preview { max-width:90vw; max-height:90vh; object-fit:contain; border-radius:8px; box-shadow:0 20px 50px rgba(0,0,0,.6); }
      .adg-gallery-dialog { display:flex; flex-direction:column; width:min(1180px,94vw); height:min(820px,88vh); padding:12px; border:1px solid rgba(255,255,255,.16); border-radius:10px; color:#eee; background:#202027; box-shadow:0 20px 50px rgba(0,0,0,.55); } .adg-gallery-header { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:8px; } .adg-gallery-header input { min-width:240px; flex:1; padding:8px 10px; border:1px solid #55566a; border-radius:6px; color:#eee; background:#15151b; } .adg-gallery-header button,.adg-gallery-header select { padding:7px 10px; border:1px solid #55566a; border-radius:6px; color:#eee; background:#353540; cursor:pointer; } .adg-gallery-header button:hover { border-color:#9988ff; background:#6758c9; } .adg-gallery-dialog .adg-grid { min-height:0; }
    `;
    document.head.append(style);
  }

  app.registerExtension({
    name: "Anima.DanbooruGallery",
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_NAME) return;
      injectStyles();
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
        const queryWidget = this.addWidget?.("text", "搜索标签", ui.settings.lastQuery, () => {}, { serialize: true });
        ui.queryWidget = queryWidget || { value: ui.settings.lastQuery };
        if (queryWidget) { const cb = queryWidget.callback; queryWidget.callback = function(v){ cb?.apply(this, arguments); ui.fetchSuggestions(v); }; }
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
