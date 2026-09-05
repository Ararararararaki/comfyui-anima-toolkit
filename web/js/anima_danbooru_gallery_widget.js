import { app } from "/scripts/app.js";
import { GalleryFilterControls, FILTER_DEFAULTS, normalizeFilters, normalizeRatings } from "./anima_danbooru_filter_controls.js";
import { installDOMWidgetSizeSync } from "./anima_dom_widget_size_sync.js";

(() => {
  const NODE_NAME = "DanbooruGallery";
  const STORAGE_KEY_PREFIX = "anima_danbooru_gallery_settings_v2:";
  const LEGACY_STORAGE_KEY = "anima_danbooru_gallery_settings_v1";
  const LEGACY_MIGRATED_KEY = `${STORAGE_KEY_PREFIX}legacy_migrated`;
  const FAVORITES_STORAGE_KEY = "anima_danbooru_gallery_favorites_v1";

  function getNodeStorageKey(nodeId) {
    const id = String(nodeId ?? "").trim() || "unassigned";
    return `${STORAGE_KEY_PREFIX}${id}`;
  }

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

  const MAX_TAGS = 8; // 搜索框最多保留 8 个标签（后端 MAX_SEARCH_TAGS=12；Member 上限 2、Gold 6，足够覆盖）
  const FREE_METATAGS = new Set(["rating", "status", "is", "age", "date", "id", "limit", "score", "downvotes", "favcount", "width", "height", "ratio", "mpixels", "filesize", "filetype", "duration", "md5", "pixiv_id", "pixiv", "parent", "child", "upvote", "embedded", "tagcount"]);
  const DANBOORU_TAG_LIMIT = 2;
  const ORDER_LABELS = { score: "评分", favcount: "收藏", random: "随机", rank: "综合" };
  const PROMPT_CATEGORY_ORDER = Object.freeze(["artist", "copyright", "character", "general", "meta"]);
  const PROMPT_CATEGORY_LABELS = Object.freeze({
    artist: "画师",
    copyright: "版权/作品",
    character: "角色",
    general: "通用",
    meta: "元数据",
  });
  // 保持旧工作流默认结果：角色 → 版权/作品 → 通用。
  const DEFAULT_PROMPT_OUTPUT = Object.freeze({
    categories: ["character", "copyright", "general"],
    replaceUnderscores: true,
    escapeBrackets: false,
  });
  const DEFAULT_PROMPT_LIBRARY_CATEGORIES = Object.freeze([
    { id: "uncategorized", name: "未分类", icon: "", sortOrder: 0 },
    { id: "cat_faces", name: "人物", icon: "", sortOrder: 1 },
    { id: "cat_style", name: "画师风格", icon: "", sortOrder: 2 },
    { id: "cat_env", name: "背景环境", icon: "", sortOrder: 3 },
    { id: "cat_light", name: "光影氛围", icon: "", sortOrder: 4 },
    { id: "cat_detail", name: "细节增强", icon: "", sortOrder: 5 },
    { id: "cat_fav", name: "常用", icon: "", sortOrder: 6 },
  ]);

  function normalizePromptOutputSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const categories = Array.isArray(source.categories)
      ? [...new Set(source.categories.map(String).filter((name) => PROMPT_CATEGORY_ORDER.includes(name)))]
      : [];
    return {
      categories: categories.length ? categories : [...DEFAULT_PROMPT_OUTPUT.categories],
      replaceUnderscores: source.replaceUnderscores !== false,
      escapeBrackets: source.escapeBrackets === true,
    };
  }

  function formatPromptTag(tag, settings) {
    let formatted = String(tag || "").trim();
    if (settings.replaceUnderscores) formatted = formatted.replace(/_/g, " ");
    if (settings.escapeBrackets) {
      formatted = formatted.replace(/\\([()])/g, "$1");
      formatted = formatted.replaceAll("(", "\\(").replaceAll(")", "\\)");
    }
    return formatted;
  }

  function promptCardKey(value) {
    return String(value || "")
      .replace(/\\([()])/g, "$1")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function splitPromptParts(value) {
    return [...new Set(String(value || "")
      .split(/[、，,;；\n]/)
      .map((part) => part.trim())
      .filter(Boolean))];
  }

  // 排除标签内部允许空格（如 long hair），保存时转换为 Danbooru 的下划线格式。
  // 只有逗号、顿号、分号和换行才表示多个排除标签。
  function normalizeExcludeTag(value) {
    const tag = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "_").replace(/^[-~]+/, "");
    return /^[a-z0-9_]+$/.test(tag) ? tag : "";
  }

  function splitExcludeTags(value) {
    return [...new Set(String(value || "")
      .split(/[,，、;；\r\n]+/)
      .map(normalizeExcludeTag)
      .filter(Boolean))];
  }

  function displayExcludeTag(value) {
    return String(value || "").replace(/_/g, " ");
  }

  function openPromptLibraryDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("anima-lora");
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("prompts")) {
          const store = db.createObjectStore("prompts", { keyPath: "id" });
          store.createIndex("sourceModelId", "sourceModelId");
          store.createIndex("tags", "tags", { multiEntry: true });
          store.createIndex("categoryId", "categoryId");
          store.createIndex("isFavorite", "isFavorite");
          store.createIndex("displayText", "displayText");
          store.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains("promptCategories")) db.createObjectStore("promptCategories", { keyPath: "id" });
        if (!db.objectStoreNames.contains("artists")) db.createObjectStore("artists", { keyPath: "tag" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开 Prompt 库"));
    });
  }

  function readPromptLibraryCategories(database) {
    return new Promise((resolve) => {
      if (!database.objectStoreNames.contains("promptCategories")) {
        resolve(DEFAULT_PROMPT_LIBRARY_CATEGORIES.map((category) => ({ ...category })));
        return;
      }
      const request = database.transaction("promptCategories", "readonly").objectStore("promptCategories").getAll();
      request.onsuccess = () => {
        const categories = (request.result || []).filter((category) => category && category.id).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        resolve(categories.length ? categories : DEFAULT_PROMPT_LIBRARY_CATEGORIES.map((category) => ({ ...category })));
      };
      request.onerror = () => resolve(DEFAULT_PROMPT_LIBRARY_CATEGORIES.map((category) => ({ ...category })));
    });
  }

  // 搜索栏按空格分词的词级替换：点击补全建议时只替换光标所在的那一个标签，
  // 保留其余标签与空格（光标在词后/词中/空白处均正确处理；空栏 = 直接填入）。
  function replaceWordAt(raw, pos, replacement) {
    const str = String(raw ?? "");
    const at = Math.max(0, Math.min(str.length, Number.isFinite(pos) ? pos : str.length));
    let end = at;
    while (end < str.length && str[end] !== " ") end++;
    let start = at;
    while (start > 0 && str[start - 1] !== " ") start--;
    return str.slice(0, start) + replacement + str.slice(end);
  }

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

  function formatCount(value) {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) return "";
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}m`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
    return String(Math.round(count));
  }

  function countedSearchTerms(query) {
    return String(query || "").split(/\s+/).filter(Boolean).filter((rawToken) => {
      const token = rawToken.replace(/^[-~]+/, "").toLowerCase();
      if (token === "or" || token === "(" || token === ")") return false;
      const colon = token.indexOf(":");
      return colon < 0 || !FREE_METATAGS.has(token.slice(0, colon));
    }).length;
  }

  function loadSettings(nodeId) {
    try {
      const storageKey = getNodeStorageKey(nodeId);
      let raw = localStorage.getItem(storageKey);
      // 只把旧版全局设置迁移给第一个尚未初始化的节点，避免两个节点再次共享同一份配置。
      if (!raw && !localStorage.getItem(LEGACY_MIGRATED_KEY)) {
        raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (raw) {
          localStorage.setItem(storageKey, raw);
          localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
        }
      }
      const saved = JSON.parse(raw || "{}");
      return {
        limit: [12, 24, 48].includes(saved.limit) ? saved.limit : 24,
        rating: normalizeRatings(saved.rating),
        gridHeight: Number.isFinite(saved.gridHeight) ? Math.max(360, Math.min(1200, saved.gridHeight)) : 620,
        categories: Array.isArray(saved.categories) ? saved.categories : [],
        postCategories: saved.postCategories && typeof saved.postCategories === "object" ? saved.postCategories : {},
        presets: Array.isArray(saved.presets) ? saved.presets : [],
        activeCategory: typeof saved.activeCategory === "string" ? saved.activeCategory : "",
        filters: normalizeFilters(saved.filters),
        excludeTags: Array.isArray(saved.excludeTags) ? [...new Set(saved.excludeTags.map(normalizeExcludeTag).filter(Boolean))].slice(0, 8) : [],
        promptOutput: normalizePromptOutputSettings(saved.promptOutput),
        promptOutputEnabled: saved.promptOutputEnabled !== false,
        promptExcludePattern: typeof saved.promptExcludePattern === "string" ? saved.promptExcludePattern.slice(0, 500) : "",
        lastQuery: typeof saved.lastQuery === "string" ? saved.lastQuery : "",
      };
    } catch {
      return { limit: 24, rating: [], gridHeight: 620, categories: [], postCategories: {}, presets: [], activeCategory: "", filters: { ...FILTER_DEFAULTS }, excludeTags: [], promptOutput: normalizePromptOutputSettings(), promptOutputEnabled: true, promptExcludePattern: "", lastQuery: "" };
    }
  }

  class DanbooruGalleryUI {
    constructor(node) {
      this.node = node;
      this.settings = loadSettings(node.id);
      this.page = 1;
      this.posts = [];
      this.requestId = 0;
      this.controller = null;
      this.root = null;
      this.grid = null;
      this.status = null;
      this.suggestions = null;
      this.suggestionRequestId = 0;
      this.suggestionTimer = null;
      this.suggestionController = null;
      this.positionSuggestionsHandler = () => this.positionSuggestions();
      this.selectionWidget = null;
      this.queryWidget = null;
      this.queryInput = null;
      // 记录多选卡片的实际点击顺序；不能用 DOM 顺序代替，因为翻页/筛选后的显示顺序可能不同。
      this.selectionOrder = [];
      this.dialogId = `anima-danbooru-dialog-${node.id}`;
      this.favorites = this.loadFavorites();
      this.translationCache = new Map();
      this.tooltip = null;
      this.domWidget = null;
      this.domSizeSync = null;
      this.pointerRecoveryHandler = null;
      this.filterControls = null;
      this.promptEdits = new Map();
      this.registered = false; // 是否已登录 Danbooru
      this.tagLimitValue = 2;  // 计数标签上限（后端按账号等级动态：Member=2 / Gold+=6，随 /account 刷新）
      this.initialSearchTimer = null;
      this.galleryBatchId = null;
      this.galleryBatchState = null;
      this.galleryBatchJobs = [];
      this.galleryBatchTimer = null;
      this.galleryBatchPollBusy = false;
      this.galleryBatchPollFailures = 0;
      this.galleryBatchBusy = false;
      this.galleryBatchBtn = null;
      this.galleryBatchPanel = null;
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

    settingsKey() {
      return getNodeStorageKey(this.node?.id);
    }

    saveSettings() {
      localStorage.setItem(this.settingsKey(), JSON.stringify(this.settings));
    }

    // 重建工具栏「搜索预设」下拉选项（保存/删除预设后调用）
    renderPresetOptions() {
      if (!this.presetSelect) return;
      const keepValue = this.presetSelect.value;
      this.presetSelect.innerHTML = `<option value="">搜索预设</option>${this.settings.presets.map((p, i) => `<option value="${i}">${p.name}</option>`).join("")}`;
      if (keepValue !== "") this.presetSelect.value = keepValue;
    }

    applyGridHeight() {
      const height = Math.max(360, Math.min(1200, Number(this.settings.gridHeight) || 620));
      this.settings.gridHeight = height;
      if (this.domSizeSync) {
        this.domSizeSync.setContentHeight(height);
        return;
      }
      if (this.root) {
        this.root.style.height = `${height}px`;
        this.root.style.minHeight = "0px";
        this.root.style.maxHeight = "none";
      }
      this.node.setSize?.([Math.max(360, this.node.size?.[0] || 780), height + 95]);
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

    hideSuggestions() {
      if (this.suggestionTimer) {
        clearTimeout(this.suggestionTimer);
        this.suggestionTimer = null;
      }
      this.suggestionController?.abort();
      this.suggestionController = null;
      this.suggestionRequestId += 1;
      if (!this.suggestions) return;
      this.suggestions.textContent = "";
      this.suggestions.classList.remove("is-localized");
      this.suggestions.style.display = "none";
    }

    positionSuggestions() {
      const input = this.queryInput;
      const suggestions = this.suggestions;
      if (!input || !suggestions || suggestions.style.display === "none") return;
      const rect = input.getBoundingClientRect();
      suggestions.style.top = `${Math.round(rect.bottom + 3)}px`;
      suggestions.style.left = `${Math.round(rect.left)}px`;
      suggestions.style.width = `${Math.round(rect.width)}px`;
    }

    scheduleSuggestions(value) {
      if (this.suggestionTimer) clearTimeout(this.suggestionTimer);
      const query = String(value ?? "");
      if (!query.trim()) {
        this.hideSuggestions();
        return;
      }
      this.suggestionTimer = setTimeout(() => {
        this.suggestionTimer = null;
        this.fetchSuggestions(query);
      }, 180);
    }

    // 同步搜索框内容到 DOM 输入 + 隐藏的序列化 widget（两者始终一致）
    setQuery(value) {
      const v = String(value ?? "");
      if (this.queryInput) this.queryInput.value = v;
      if (this.queryWidget) this.queryWidget.value = v;
      if (this.queryInput && document.activeElement === this.queryInput) this.scheduleSuggestions(v);
      else this.hideSuggestions();
    }

    currentQuery() {
      const raw = this.queryWidget?.value || this.settings.lastQuery || "";
      const f = this.settings.filters;
      // 评分/收藏/随机排序不再默认附加时间窗（用户显式设置 age/天数时遵循用户选择）。
      // 全库排序被 D站 拒绝时由后端自动降级附加时间窗重试（响应 warnings 会提示）。
      const age = f.age || (f.ageDays ? `${f.ageDays}days` : "");
      // ⚠️ age 必须带 < 前缀（D站 的 age:1day 是「恰好一天前」等值语义，会显示过期内容；< 才是近 N 天）
      const ageToken = age ? `age:<${age}` : "";
      const RATIO_TOKENS = { wide: "ratio:>1", tall: "ratio:<1", square: "ratio:>=0.9 ratio:<=1.1", ultrawide: "ratio:>=1.5" };
      const FILETYPE_TOKENS = { static: "-filetype:gif -filetype:mp4 -filetype:webm", gif: "filetype:gif", video: "filetype:mp4" };
      const parts = [
        normalizeTags(raw),
        this.settings.rating.length ? `rating:${this.settings.rating.join(",")}` : "",
        ageToken,
        f.minScore ? `score:>${f.minScore}` : "",
        f.minFavs ? `favcount:>${f.minFavs}` : "",
        f.minMpixels ? `mpixels:>=${f.minMpixels}` : "",
        RATIO_TOKENS[f.ratio] || "",
        FILETYPE_TOKENS[f.filetype] || "",
        f.order ? `order:${f.order}` : "",
      ];
      // 排除标签不拼进查询词（D站 把 -tag 当普通标签计数，会占搜索槽位）：
      // 改为拿到结果后本地过滤（见 search()），槽位零占用、可任意添加。
      return parts.filter(Boolean).join(" ");
    }

    tagLimit() {
      // 计数标签上限：匿名/Member=2，Gold+=6。后端按账号等级动态返回（/account、/posts 响应带 tag_limit），
      // 前端优先用后端值，拉取前用保守默认 2。
      return typeof this.tagLimitValue === "number" && this.tagLimitValue > 0 ? this.tagLimitValue : DANBOORU_TAG_LIMIT;
    }

    async readSearchResponse(response) {
      // response.json() 遇到 BOM、代理残片或拼接响应时只给出模糊的 JSON.parse
      // 错误，且无法区分“接口返回异常”和“搜索没有结果”。先完整读取文本，
      // 清理 UTF-8 BOM，并把可重试的协议错误标记给 search()。
      const body = (await response.text()).replace(/^\uFEFF/, "").trim();
      try {
        return JSON.parse(body);
      } catch {
        const error = new Error("D站接口返回了无效的 JSON 响应");
        error.name = "InvalidJSONResponseError";
        error.httpStatus = response.status;
        error.contentType = response.headers.get("content-type") || "";
        throw error;
      }
    }

    async search({ resetPage = false, force = false, skipFuzzy = false, retryCount = 0 } = {}) {
      // 分类浏览模式下发起新搜索 = 回到普通搜索视图（分类只作用于本地浏览，搜索条件与分类无关）
      if (this.settings.activeCategory) {
        this.settings.activeCategory = "";
        this.saveSettings();
        this.filterControls?.refresh();
      }
      this._searchSnapshot = null; // 新搜索后 posts 即将被覆盖，分类快照失效
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
      const requestController = this.controller;
      const currentRequest = ++this.requestId;
      // 45s 兜底超时标记（声明在 try 外：catch 需要读它；若声明在 try 内，
      // 快速切换筛选触发 abort 竞态时 catch 会抛 ReferenceError 导致状态栏卡死）
      let timedOut = false;
      this.setStatus(`正在搜索：${query}`);
      if (this.grid) this.grid.setAttribute("aria-busy", "true");
      try {
        const parameters = new URLSearchParams({
          tags: query,
          page: String(this.page),
          limit: String(this.settings.limit),
          force: force ? "1" : "0",
        });
        const timer = setTimeout(() => { timedOut = true; requestController.abort(); }, 45000);
        let response, data;
        try {
          response = await fetch(`/anima/danbooru/posts?${parameters}`, { signal: requestController.signal });
          data = await this.readSearchResponse(response);
        } finally {
          clearTimeout(timer);
        }
        if (typeof data?.tag_limit === "number") this.tagLimitValue = data.tag_limit;
        if (currentRequest !== this.requestId) return;
        if (!response.ok) {
          const error = new Error(data?.error || `HTTP ${response.status}`);
          error.name = "DanbooruSearchHTTPError";
          error.httpStatus = response.status;
          throw error;
        }
        const rawPosts = Array.isArray(data.posts) ? data.posts : [];
        // 本地排除过滤：排除标签不占 D站 计数槽（查询不含 -tag），拿到结果后按 tag_string 过滤
        const excludeTags = this.settings.excludeTags || [];
        let excludedCount = 0;
        if (excludeTags.length) {
          const tagSet = new Set(excludeTags);
          const filtered = [];
          for (const post of rawPosts) {
            const postTags = String(post?.tag_string || "").split(" ");
            if (postTags.some((t) => tagSet.has(t))) excludedCount += 1;
            else filtered.push(post);
          }
          this.posts = filtered;
        } else {
          this.posts = rawPosts;
        }
        if (!rawPosts.length) {
          this.fetchSuggestions(this.queryWidget?.value || query, true);
          // 精确搜索无结果 → 模糊纠错（把近似标签替换成真实标签）自动重搜一次
          if (!skipFuzzy) await this.fuzzyRetry(query);
        } else if (!this.posts.length) {
          this.setStatus(`该页 ${rawPosts.length} 张全部被排除标签过滤（${excludeTags.join("、")}），请调整排除标签`, "error");
        }
        this.renderPosts();
        this.renderPagination();
        const source = data.cached ? "缓存" : "D站";
        const notices = [];
        if (Array.isArray(data.warnings) && data.warnings.length) notices.push(...data.warnings.map(String));
        if (this._droppedOrder) notices.push(`已自动移除「${ORDER_LABELS[this._droppedOrder] || this._droppedOrder}」排序，按最新显示（匿名最多 2 个计数标签）`);
          const exclNotice = excludeTags.length ? `已排除 ${excludeTags.map(displayExcludeTag).join("、")} ${excludedCount} 张` : "";
        this.setStatus(`${source}：${this.posts.length} 张 · 第 ${this.page} 页` + (exclNotice ? `（${exclNotice}）` : "") + (notices.length ? `（${notices.join("；")}）` : ""));
      } catch (error) {
        if (timedOut) {
          this.posts = [];
          this.renderPosts();
          this.setStatus("搜索超时（45 秒）：D站 或代理网络不稳定，已自动多路重试仍失败。请检查 Clash 节点后重试", "error");
          return;
        }
        if (error?.name === "AbortError") return;
        if (currentRequest !== this.requestId) return;
        const retryable = error?.name === "InvalidJSONResponseError"
          || error?.name === "TypeError"
          || [502, 503, 504].includes(Number(error?.httpStatus));
        if (retryable && retryCount < 2) {
          const attempt = retryCount + 1;
          this.setStatus(`首次搜索响应异常，正在自动重试（${attempt}/2）…`);
          await new Promise((resolve) => setTimeout(resolve, 250 + retryCount * 500));
          if (currentRequest !== this.requestId) return;
          return this.search({ resetPage: false, force, skipFuzzy, retryCount: attempt });
        }
        this.posts = [];
        this.renderPosts();
        this.setStatus(`搜索失败：${error?.message || "未知错误"}`, "error");
      } finally {
        if (currentRequest === this.requestId && this.grid) this.grid.removeAttribute("aria-busy");
      }
    }
    // 分类切换 = 本地分类浏览模式：不再过滤当前搜索页，而是按 id 从 D站 拉取
    // 该分类全部已归类图片（id 是免费 metatag，不占计数槽；一次最多 48 个 id，分批合取）。
    async applyActiveCategory(catId) {
      this.settings.activeCategory = catId;
      this.saveSettings();
      this.filterControls?.refresh();
      this.controller?.abort();
      if (!catId) {
        // 全部分类：恢复进入分类浏览前的普通搜索视图
        this.posts = this._searchSnapshot || this.posts;
        this.renderPosts();
        this.renderPagination();
        this.setStatus(this.posts.length ? "已切换为全部分类（恢复之前的搜索结果）" : "");
        return;
      }
      // 进入分类浏览前保存普通搜索视图快照（切回时恢复）
      this._searchSnapshot = this._searchSnapshot || this.posts;
      const catName = this.settings.categories.find((c) => c.id === catId)?.name || catId;
      const ids = Object.entries(this.settings.postCategories)
        .filter(([, cid]) => cid === catId)
        .map(([pid]) => pid);
      if (!ids.length) {
        this.posts = [];
        this.renderPosts();
        this.renderPagination();
        this.setStatus(`分类「${catName}」还没有图片：在搜索页点图片卡片的「分类」即可归类`, "");
        return;
      }
      const targetId = catId;
      this.setStatus(`正在加载分类「${catName}」${ids.length} 张…`);
      if (this.grid) this.grid.setAttribute("aria-busy", "true");
      const posts = [];
      try {
        for (let i = 0; i < ids.length; i += 48) {
          const batch = ids.slice(i, i + 48).join(",");
          const params = new URLSearchParams({ tags: `id:${batch}`, page: "1", limit: "48" });
          const response = await fetch(`/anima/danbooru/posts?${params}`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
          if (Array.isArray(data.posts)) posts.push(...data.posts);
          // 竞态：期间用户又切换了分类/发起了搜索 → 放弃本次渲染
          if (this.settings.activeCategory !== targetId) return;
        }
      } catch (error) {
        if (this.settings.activeCategory === targetId) {
          this.posts = [];
          this.renderPosts();
          this.renderPagination();
          this.setStatus(`加载分类「${catName}」失败：${error?.message || "未知错误"}`, "error");
        }
        return;
      } finally {
        if (this.grid) this.grid.removeAttribute("aria-busy");
      }
      this.posts = posts;
      this.renderPosts();
      this.renderPagination();
      const missing = ids.length - posts.length;
      this.setStatus(`分类「${catName}」：${posts.length} 张已归类图片（覆盖全部搜索历史）${missing ? `，${missing} 张原图已失效跳过` : ""}`);
    }

    async fetchSuggestions(q, empty = false) {
      if (!this.suggestions || !q?.trim()) {
        this.hideSuggestions();
        return;
      }
      this.suggestionController?.abort();
      this.suggestionController = new AbortController();
      const requestId = ++this.suggestionRequestId;
      try {
        const response = await fetch(`/anima/danbooru/suggest?q=${encodeURIComponent(q)}`, { signal: this.suggestionController.signal });
        const d = await response.json();
        if (requestId !== this.suggestionRequestId || !this.suggestions) return;
        const names = empty ? d.didYouMean : d.suggestions;
        const details = !empty && Array.isArray(d.suggestionDetails) ? d.suggestionDetails : [];
        const choices = details.length ? details : (Array.isArray(names) ? names : []);
        const rewrites = Array.isArray(d.rewrites) ? d.rewrites : [];
        const chineseQuery = [...String(q)].some((char) => /[\u4e00-\u9fff]/.test(char));
        this.suggestions.textContent = "";
        this.suggestions.classList.toggle("is-localized", details.length > 0);
        this.suggestions.style.display = choices.length ? "flex" : "none";
        if (!choices.length) return;
        this.positionSuggestions();

        const label = document.createElement("span");
        label.className = "adg-suggestions-label";
        label.textContent = details.length
          ? (chineseQuery ? "中文匹配" : "智能提示")
          : (empty ? "你是不是想搜" : "智能提示");
        this.suggestions.append(label);

        for (const choice of choices) {
          const item = choice && typeof choice === "object" ? choice : { tag: choice };
          const target = String(item.tag || item.query || "").trim();
          if (!target) continue;
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.q = target;
          button.onpointerdown = (event) => event.stopPropagation();
          button.onmousedown = (event) => event.stopPropagation();
          if (details.length) {
            button.className = "adg-localized-suggestion";
            const tag = document.createElement("span");
            const translation = document.createElement("span");
            const arrow = document.createElement("span");
            const count = document.createElement("span");
            tag.className = "adg-suggestion-tag";
            translation.className = "adg-suggestion-translation";
            arrow.className = "adg-suggestion-arrow";
            count.className = "adg-suggestion-count";
            tag.textContent = target.replaceAll("_", " ");
            translation.textContent = String(item.translation || "");
            arrow.textContent = translation.textContent ? " → " : "";
            count.textContent = Number(item.postCount) > 0 ? formatCount(item.postCount) : "";
            button.append(...(chineseQuery ? [translation, arrow, tag, count] : [tag, arrow, translation, count]));
          } else {
            button.textContent = target.replaceAll("_", " ");
          }
          button.onclick = () => {
            // 智能提示 = 词级替换：只替换光标所在标签（保留其余标签）；「你是不是想搜」整栏替换
            const input = this.queryInput;
            const raw = input?.value ?? this.queryWidget?.value ?? "";
            const pos = input?.selectionStart ?? raw.length;
            this.setQuery(empty ? target : replaceWordAt(raw, pos, target));
            this.search({ resetPage: true });
          };
          this.suggestions.append(button);
        }
        if (rewrites.length) {
          const extension = document.createElement("span");
          extension.className = "adg-suggestions-extension";
          extension.textContent = `扩展：${rewrites.join(" / ")}`;
          this.suggestions.append(extension);
        }
      } catch {}
    }

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

    selectionFromCard(card) {
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      let promptGroups = {};
      let tags = [];
      try { promptGroups = JSON.parse(card.dataset.promptGroups || "{}"); } catch { promptGroups = {}; }
      try { tags = card.dataset.tags ? JSON.parse(card.dataset.tags) : []; } catch { tags = []; }
      const promptOutputEnabled = this.settings.promptOutputEnabled !== false;
      return {
        image_url: card.dataset.imageUrl || "",
        prompt: promptOutputEnabled ? (card.dataset.prompt || "") : "",
        post_id: card.dataset.postId || "",
        tags: Array.isArray(tags) ? tags : [],
        prompt_groups: promptGroups,
        rating: card.dataset.rating || "",
        score: num(card.dataset.score),
        favcount: num(card.dataset.favcount),
        width: num(card.dataset.width),
        height: num(card.dataset.height),
        file_ext: card.dataset.fileExt || "",
        video: card.dataset.video === "1",
        source_url: card.dataset.sourceUrl || "",
      };
    }

    selectionKey(card) {
      return String(card?.dataset?.postId || card?.dataset?.imageUrl || "").trim();
    }

    rememberCardSelection(card, selected) {
      const key = this.selectionKey(card);
      if (!key) return;
      this.selectionOrder = this.selectionOrder.filter((item) => item !== key);
      if (selected) this.selectionOrder.push(key);
    }

    selectedGallerySelections() {
      if (!this.grid) return [];
      const selectedCards = [...this.grid.querySelectorAll(".adg-card.is-selected")];
      const cardsByKey = new Map();
      selectedCards.forEach((card) => {
        const key = this.selectionKey(card);
        if (key && !cardsByKey.has(key)) cardsByKey.set(key, card);
      });
      // 老节点/恢复工作流时可能没有点击记录：保留 DOM 顺序作为一次性兜底，
      // 之后这些卡片也会进入明确的顺序记录。
      const orderedKeys = [];
      for (const key of this.selectionOrder) {
        if (cardsByKey.has(key) && !orderedKeys.includes(key)) orderedKeys.push(key);
      }
      for (const card of selectedCards) {
        const key = this.selectionKey(card);
        if (key && !orderedKeys.includes(key)) orderedKeys.push(key);
      }
      this.selectionOrder = orderedKeys;
      return orderedKeys
        .map((key) => this.selectionFromCard(cardsByKey.get(key)))
        .filter((selection) => selection.image_url);
    }

    singleGallerySelectionData(selection) {
      return JSON.stringify({
        prompt_output_enabled: this.settings.promptOutputEnabled !== false,
        prompt_settings: this.promptOutputSettings(),
        selections: [selection],
        image_selections: [{ image_url: selection.image_url }],
      });
    }

    updateSelection() {
      const selected = this.selectedGallerySelections();
      const imageSelections = selected.map((selection) => ({ image_url: selection.image_url }));
      const promptOutputEnabled = this.settings.promptOutputEnabled !== false;
      const value = JSON.stringify({ prompt_output_enabled: promptOutputEnabled, prompt_settings: this.promptOutputSettings(), selections: selected, image_selections: imageSelections });
      this.selectionWidget.value = value;
      this.selectionWidget.callback?.(value);
      this.node.graph?.change?.();
      this.setStatus(selected.length ? `已选择 ${selected.length} 张图片` : "已清除选择");
      this.updateGalleryBatchControls(selected.length);
      // 批量归类按钮联动（选中 ≥2 张可用）
      if (this.batchCatBtn) {
        this.batchCatBtn.disabled = selected.length < 2;
        this.batchCatBtn.textContent = selected.length >= 2 ? `归类选中 ${selected.length} 张` : "归类选中";
      }
    }

    updateGalleryBatchControls(selectedCount = null) {
      if (!this.galleryBatchBtn) return;
      const count = selectedCount == null ? this.selectedGallerySelections().length : selectedCount;
      const state = this.galleryBatchState?.state || "";
      const active = state === "running" || state === "paused";
      this.galleryBatchBtn.textContent = count >= 2 ? `批量入队 ${count}` : "批量入队";
      this.galleryBatchBtn.disabled = this.galleryBatchBusy || count < 2 || active;
      this.galleryBatchBtn.title = active
        ? "当前已有画廊批次运行中，请先完成、暂停或取消"
        : "将选中的画廊卡片按点击顺序拆成独立任务，逐张执行";
    }

    async readGalleryBatchResponse(response) {
      const body = (await response.text()).replace(/^\uFEFF/, "").trim();
      let data = null;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("批量入队接口返回了无效响应");
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      return data;
    }

    async currentWorkflowTemplate() {
      const comfyApp = window.comfyAPI?.app?.app || app;
      if (comfyApp && typeof comfyApp.graphToPrompt === "function") {
        try {
          const result = await comfyApp.graphToPrompt();
          const template = result?.output ?? result?.prompt ?? result;
          if (template && typeof template === "object" && !Array.isArray(template)) return template;
        } catch {}
      }
      const api = window.comfyAPI?.api?.api || window.api;
      if (api && typeof api.getPrompt === "function") {
        try {
          const result = await api.getPrompt();
          const template = result?.output ?? result?.prompt ?? result;
          if (template && typeof template === "object" && !Array.isArray(template)) return template;
        } catch {}
      }
      return null;
    }

    currentComfyClientId() {
      const api = window.comfyAPI?.api?.api || window.api;
      return String(api?.clientId || api?.client_id || window.name || "").trim();
    }

    async startGalleryBatch() {
      if (this.galleryBatchBusy) return;
      const selections = this.selectedGallerySelections();
      if (selections.length < 2) {
        this.setStatus("请先使用 Ctrl/⌘ + 点击选择至少两张画廊图片", "error");
        return;
      }
      const state = this.galleryBatchState?.state || "";
      if (state === "running" || state === "paused") {
        this.setStatus("当前已有画廊批次正在运行，请先完成或取消", "error");
        return;
      }
      this.galleryBatchBusy = true;
      this.updateGalleryBatchControls(selections.length);
      this.setGalleryBatchPanelMessage("正在读取当前工作流…");
      try {
        const template = await this.currentWorkflowTemplate();
        if (!template) throw new Error("无法获取当前工作流模板，请先保存或打开一个工作流");
        const nodeId = String(this.node.id || "");
        const galleryNode = template[nodeId];
        if (!galleryNode || typeof galleryNode !== "object") {
          throw new Error("当前工作流模板中没有启用的 TK D站画廊节点");
        }
        if (!galleryNode.inputs || typeof galleryNode.inputs !== "object") galleryNode.inputs = {};
        // 某些 ComfyUI 版本的 graphToPrompt 会省略 hidden 输入；补回当前字段，
        // 让服务端能够安全校验并替换每个批次任务的 selection_data。
        if (!("selection_data" in galleryNode.inputs)) galleryNode.inputs.selection_data = this.selectionWidget?.value || "{}";
        if (!("selection_data" in galleryNode.inputs)) throw new Error("当前画廊节点缺少 selection_data 输入");
        const jobs = selections.map((selection, index) => ({
          group: `D站图片 #${selection.post_id || index + 1}`,
          patches: [{
            nodeId,
            input: "selection_data",
            value: this.singleGallerySelectionData(selection),
          }],
        }));
        const response = await fetch("/anima/batch/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template,
            node_ref: nodeId,
            jobs,
        // 与 ComfyUI api.queuePrompt 使用同一客户端 ID，保证执行状态、
            // PreviewImage 和其他 websocket 事件回到当前画布。
            client_id: this.currentComfyClientId(),
          }),
        });
        const data = await this.readGalleryBatchResponse(response);
        if (!data?.ok || !data.batchId) throw new Error(data?.error || "批次创建失败");
        this.galleryBatchId = String(data.batchId);
        this.galleryBatchState = data.summary || { id: this.galleryBatchId, state: "running", total: jobs.length, counts: {} };
        this.galleryBatchJobs = [];
        this.galleryBatchPollFailures = 0;
        this.renderGalleryBatchPanel();
        this.setStatus(`已创建画廊批次：${jobs.length} 张图片将依次执行`, "success");
        this.scheduleGalleryBatchPoll(0);
      } catch (error) {
        this.setGalleryBatchPanelMessage(`批量入队失败：${error?.message || "未知错误"}`, true);
        this.setStatus(`批量入队失败：${error?.message || "未知错误"}`, "error");
      } finally {
        this.galleryBatchBusy = false;
        this.updateGalleryBatchControls(selections.length);
      }
    }

    setGalleryBatchPanelMessage(message, isError = false) {
      if (!this.galleryBatchPanel) return;
      this.galleryBatchPanel.hidden = false;
      this.galleryBatchPanel.replaceChildren();
      const line = document.createElement("div");
      line.className = `adg-batch-message${isError ? " is-error" : ""}`;
      line.textContent = message;
      this.galleryBatchPanel.append(line);
    }

    stopGalleryBatchPolling() {
      if (this.galleryBatchTimer) {
        clearTimeout(this.galleryBatchTimer);
        this.galleryBatchTimer = null;
      }
    }

    scheduleGalleryBatchPoll(delay = 1200) {
      this.stopGalleryBatchPolling();
      if (!this.galleryBatchId) return;
      this.galleryBatchTimer = setTimeout(() => {
        this.galleryBatchTimer = null;
        this.pollGalleryBatch();
      }, delay);
    }

    async pollGalleryBatch() {
      if (!this.galleryBatchId || this.galleryBatchPollBusy) return;
      const batchId = this.galleryBatchId;
      this.galleryBatchPollBusy = true;
      try {
        const response = await fetch(`/anima/batch/${encodeURIComponent(batchId)}/status`);
        const data = await this.readGalleryBatchResponse(response);
        if (batchId !== this.galleryBatchId) return;
        this.galleryBatchPollFailures = 0;
        this.galleryBatchState = data.summary || this.galleryBatchState;
        this.galleryBatchJobs = Array.isArray(data.jobs) ? data.jobs : [];
        this.renderGalleryBatchPanel();
        const state = this.galleryBatchState?.state || data.batch?.state || "";
        if (state === "running" || state === "paused") this.scheduleGalleryBatchPoll();
        else this.stopGalleryBatchPolling();
      } catch (error) {
        if (batchId === this.galleryBatchId) {
          this.galleryBatchPollFailures += 1;
          const retrySeconds = Math.min(15, Math.max(1, 2 ** Math.min(this.galleryBatchPollFailures - 1, 4)));
          // 保留最近一次成功状态，让用户仍能看到已完成/执行中的任务；
          // 只把当前连接状态标记为重连中，不把网络断开当成批次失败。
          if (this.galleryBatchState) {
            this.renderGalleryBatchPanel();
          } else {
            this.setGalleryBatchPanelMessage(`正在连接批次状态接口…${error?.message || ""}`.trim());
          }
          this.setStatus(`批次状态暂时断开，${retrySeconds} 秒后自动重连；后端任务仍会继续`, "warning");
          this.scheduleGalleryBatchPoll(retrySeconds * 1000);
        }
      } finally {
        this.galleryBatchPollBusy = false;
      }
    }

    async galleryBatchAction(action, index = null) {
      if (!this.galleryBatchId) return;
      const batchId = this.galleryBatchId;
      try {
        const response = await fetch(`/anima/batch/${encodeURIComponent(batchId)}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: index == null ? "{}" : JSON.stringify({ idx: index }),
        });
        await this.readGalleryBatchResponse(response);
        await this.pollGalleryBatch();
      } catch (error) {
        this.setGalleryBatchPanelMessage(`批次操作失败：${error?.message || "未知错误"}`, true);
      }
    }

    renderGalleryBatchPanel() {
      if (!this.galleryBatchPanel) return;
      const state = this.galleryBatchState;
      if (!this.galleryBatchId || !state) {
        this.galleryBatchPanel.hidden = true;
        return;
      }
      this.galleryBatchPanel.hidden = false;
      this.galleryBatchPanel.replaceChildren();
      const counts = state.counts || {};
      const total = Number(state.total) || this.galleryBatchJobs.length;
      const done = Number(counts.done) || 0;
      const running = Number(counts.running) || 0;
      const waiting = (Number(counts.pending) || 0) + (Number(counts.queued) || 0) + (Number(counts.retry) || 0);
      const failed = (Number(counts.failed) || 0) + (Number(counts.interrupted) || 0);
      const statusLine = document.createElement("div");
      statusLine.className = "adg-batch-statusline";
      const reconnecting = this.galleryBatchPollFailures > 0;
      statusLine.textContent = `批次 ${this.galleryBatchId.slice(-8)} · 完成 ${done}/${total} · 执行 ${running} · 等待 ${waiting}${failed ? ` · 失败 ${failed}` : ""}${reconnecting ? ` · 状态重连中（第 ${this.galleryBatchPollFailures} 次）` : ""}`;
      statusLine.classList.toggle("is-reconnecting", reconnecting);
      this.galleryBatchPanel.append(statusLine);
      const controls = document.createElement("div");
      controls.className = "adg-batch-controls";
      const stateName = state.state || "";
      const addControl = (label, action, title) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.onclick = () => this.galleryBatchAction(action);
        controls.append(button);
      };
      if (stateName === "running") addControl("暂停", "pause", "暂停提交后续任务，当前任务自然完成");
      if (stateName === "paused") addControl("继续", "resume", "继续执行未完成任务");
      if (stateName !== "finished" && stateName !== "cancelled") addControl("取消", "cancel", "取消未执行任务");
      if (controls.childElementCount) this.galleryBatchPanel.append(controls);
      const labels = { pending: "等待", queued: "已入队", running: "执行中", done: "完成", failed: "失败", skipped: "跳过", retry: "重试中", interrupted: "中断" };
      const jobs = [...this.galleryBatchJobs].sort((a, b) => Number(a.idx || 0) - Number(b.idx || 0));
      if (jobs.length) {
        const list = document.createElement("div");
        list.className = "adg-batch-jobs";
        for (const job of jobs) {
          const row = document.createElement("div");
          row.className = `adg-batch-job adg-batch-job-${job.status || "pending"}`;
          const text = document.createElement("span");
          text.textContent = `#${Number(job.idx || 0) + 1} ${job.group || "D站图片"} · ${labels[job.status] || job.status || "等待"}${job.error ? ` · ${String(job.error).slice(0, 100)}` : ""}`;
          row.append(text);
          if (["failed", "interrupted", "skipped"].includes(job.status)) {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.textContent = "重试";
            retry.title = "重新执行该图片任务";
            retry.onclick = () => this.galleryBatchAction("retry", Number(job.idx));
            row.append(retry);
          }
          list.append(row);
        }
        this.galleryBatchPanel.append(list);
      }
      this.updateGalleryBatchControls();
    }

    setPromptOutputEnabled(enabled) {
      const next = enabled !== false;
      this.settings.promptOutputEnabled = next;
      this.saveSettings();
      this.updatePromptOutputButton();
      // 重新写入 selection_data，确保 ComfyUI 后端不会继续使用关闭时的空 Prompt。
      this.updateSelection();
      this.node.graph?.setDirtyCanvas?.(true, true);
      return next;
    }

    promptOutputSettings() {
      const settings = normalizePromptOutputSettings(this.settings.promptOutput);
      this.settings.promptOutput = settings;
      return settings;
    }

    updatePromptOutputButton() {
      if (!this.promptOutputBtn) return;
      const enabled = this.settings.promptOutputEnabled !== false;
      this.promptOutputBtn.textContent = enabled ? "Prompt 输出 开" : "Prompt 输出 关";
      this.promptOutputBtn.setAttribute("aria-pressed", String(enabled));
      this.promptOutputBtn.title = enabled
        ? "关闭后即使下游连线，节点也不会输出正向 Prompt"
        : "已关闭 Prompt 输出，点击恢复节点正向 Prompt 输出";
      this.promptOutputBtn.classList.toggle("is-disabled", !enabled);
    }

    rawPromptGroups(post) {
      const groups = Object.fromEntries(PROMPT_CATEGORY_ORDER.map((category) => [category, []]));
      const seen = new Set();
      const add = (category, tag) => {
        const clean = String(tag || "").trim();
        if (!clean || seen.has(clean)) return;
        groups[category].push(clean);
        seen.add(clean);
      };
      for (const category of PROMPT_CATEGORY_ORDER) {
        for (const tag of String(post?.[`tag_string_${category}`] || "").split(" ")) add(category, tag);
      }
      // 兼容某些接口只返回总 tag_string 的旧数据。
      if (Object.values(groups).every((tags) => tags.length === 0)) {
        for (const tag of String(post?.tag_string || "").split(" ")) add("general", tag);
      }
      return groups;
    }

    buildPromptForPost(post, promptOutput = null, excludePattern = "") {
      const settings = normalizePromptOutputSettings(promptOutput || this.promptOutputSettings());
      let excludeRegex = null;
      if (String(excludePattern || "").trim()) {
        try { excludeRegex = new RegExp(String(excludePattern).trim(), "i"); } catch { excludeRegex = null; }
      }
      const rawGroups = this.rawPromptGroups(post);
      const groups = Object.fromEntries(PROMPT_CATEGORY_ORDER.map((category) => [category, []]));
      const tags = [];
      const seen = new Set();
      for (const category of settings.categories) {
        for (const tag of rawGroups[category] || []) {
          if (seen.has(tag)) continue;
          if (excludeRegex && excludeRegex.test(tag)) continue;
          seen.add(tag);
          groups[category].push(tag);
          tags.push(tag);
        }
      }
      return {
        prompt: tags.map((tag) => formatPromptTag(tag, settings)).filter(Boolean).join(", "),
        tags,
        groups,
        settings: { ...settings, categories: [...settings.categories] },
      };
    }

    postTags(post) {
      return this.buildPromptForPost(post).tags;
    }

    postPrompt(post) {
      return this.buildPromptForPost(post).prompt;
    }

    async ensureTagTranslations(tags) {
      const unique = [...new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))];
      const missing = unique.filter((tag) => !this.translationCache.has(tag));
      if (missing.length) {
        try {
          const response = await fetch("/anima/danbooru/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tags: missing }),
          });
          const data = await response.json();
          for (const tag of missing) this.translationCache.set(tag, String(data.translations?.[tag] || "").trim());
        } catch {
          for (const tag of missing) this.translationCache.set(tag, "");
        }
      }
      return Object.fromEntries(unique
        .map((tag) => [tag, String(this.translationCache.get(tag) || "").trim()])
        .filter(([, zh]) => zh));
    }

    async ensurePromptTranslations(parts) {
      const unique = splitPromptParts(parts.join(", "));
      const lookupTags = [...new Set(unique.flatMap((part) => [part, part.replace(/\s+/g, "_")]))];
      const source = await this.ensureTagTranslations(lookupTags);
      const byKey = new Map(Object.entries(source).map(([key, value]) => [promptCardKey(key), value]));
      return Object.fromEntries(unique.map((part) => [part, byKey.get(promptCardKey(part)) || ""]));
    }

    renderBilingualPromptEditor(container, parts, translations, { prefix = "adg-save-bilingual", onInput, excluded = [] } = {}) {
      container.replaceChildren();
      const unique = splitPromptParts(parts.join(", "));
      const translationMap = new Map(Object.entries(translations || {}).map(([key, value]) => [promptCardKey(key), String(value || "").trim()]));
      const excludedKeys = new Set((excluded || []).map(promptCardKey));
      const header = document.createElement("div");
      header.className = `${prefix}-header`;
      const englishHeader = document.createElement("span");
      englishHeader.textContent = "英文 Prompt";
      const chineseHeader = document.createElement("span");
      chineseHeader.textContent = "中文翻译";
      header.append(englishHeader, chineseHeader);
      const list = document.createElement("div");
      list.className = `${prefix}-list`;
      const rows = [];
      let updateSelectionTools = () => {};
      const readEntries = (filter = () => true) => rows
        .filter(filter)
        .map(({ en, zh }) => ({ en: en.value.trim(), zh: zh.value.trim() }))
        .filter(({ en }) => en);
      const editor = {
        rows,
        read: () => {
          const entries = readEntries(({ excluded: isExcluded }) => !isExcluded);
          const allEntries = readEntries();
          return {
            parts: entries.map(({ en }) => en),
            prompt: entries.map(({ en }) => en).join(", "),
            translations: Object.fromEntries(entries.map(({ en, zh }) => [en, zh])),
            allParts: allEntries.map(({ en }) => en),
            allTranslations: Object.fromEntries(allEntries.map(({ en, zh }) => [en, zh])),
            excludedParts: rows.filter(({ excluded: isExcluded }) => isExcluded).map(({ en }) => en.value.trim()).filter(Boolean),
          };
        },
        readSelected: () => {
          const entries = readEntries(({ select, excluded: isExcluded }) => select.checked && !isExcluded);
          return {
            parts: entries.map(({ en }) => en),
            prompt: entries.map(({ en }) => en).join(", "),
            translations: Object.fromEntries(entries.map(({ en, zh }) => [en, zh])),
          };
        },
      };
      const selectionTools = document.createElement("div");
      selectionTools.className = `${prefix}-selection-tools`;
      const selectAllLabel = document.createElement("label");
      selectAllLabel.className = `${prefix}-select-all`;
      const selectAll = document.createElement("input");
      selectAll.type = "checkbox";
      selectAll.className = `${prefix}-select-all-input`;
      const selectAllText = document.createElement("span");
      selectAllText.textContent = "全选";
      selectAllLabel.append(selectAll, selectAllText);
      const clearSelection = document.createElement("button");
      clearSelection.type = "button";
      clearSelection.textContent = "清除选择";
      const selectionCount = document.createElement("span");
      selectionCount.className = `${prefix}-selection-count`;
      selectionCount.textContent = "未选择";
      const copySelected = document.createElement("button");
      copySelected.type = "button";
      copySelected.textContent = "复制选中";
      copySelected.title = "复制选中的 Prompt";
      copySelected.setAttribute("aria-label", "复制选中的 Prompt");
      copySelected.disabled = true;
      selectionTools.append(selectAllLabel, clearSelection, selectionCount, copySelected);
      updateSelectionTools = () => {
        const activeRows = rows.filter(({ excluded: isExcluded }) => !isExcluded);
        const selectedCount = activeRows.filter(({ select }) => select.checked).length;
        const clearedCount = rows.length - activeRows.length;
        selectionCount.textContent = `${selectedCount ? `已选 ${selectedCount} 个` : "未选择"}${clearedCount ? ` · 已清除 ${clearedCount} 个（不输出）` : ""}`;
        copySelected.disabled = selectedCount === 0;
        selectAll.checked = activeRows.length > 0 && selectedCount === activeRows.length;
        selectAll.indeterminate = selectedCount > 0 && selectedCount < activeRows.length;
        rows.forEach(({ card, select, excluded: isExcluded }) => {
          card.classList.toggle("is-selected", !isExcluded && select.checked);
          card.classList.toggle("is-cleared", isExcluded);
        });
      };
      selectAll.addEventListener("change", () => {
        rows.forEach(({ select, excluded: isExcluded }) => { select.checked = !isExcluded && selectAll.checked; });
        updateSelectionTools();
      });
      clearSelection.addEventListener("click", () => {
        rows.forEach(({ select }) => { select.checked = false; });
        updateSelectionTools();
      });
      copySelected.addEventListener("click", async () => {
        const value = editor.readSelected().prompt;
        if (!value) {
          this.setStatus("请先选择要复制的 Prompt", "error");
          return;
        }
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const fallback = document.createElement("textarea");
          fallback.value = value;
          document.body.append(fallback);
          fallback.select();
          document.execCommand("copy");
          fallback.remove();
        }
        this.setStatus(`已复制 ${editor.readSelected().parts.length} 个 Prompt`);
      });
      for (const part of unique) {
        const row = document.createElement("div");
        row.className = `${prefix}-card`;
        const select = document.createElement("input");
        select.type = "checkbox";
        select.className = `${prefix}-select`;
        select.setAttribute("aria-label", `选择 Prompt：${part}`);
        const en = document.createElement("input");
        en.type = "text";
        en.className = `${prefix}-en`;
        en.value = part;
        en.setAttribute("aria-label", `英文 Prompt：${part}`);
        const zh = document.createElement("input");
        zh.type = "text";
        zh.className = `${prefix}-zh`;
        zh.value = translationMap.get(promptCardKey(part)) || "";
        zh.placeholder = "待翻译，可手动修改";
        zh.setAttribute("aria-label", `中文翻译：${part}`);
        const fields = document.createElement("div");
        fields.className = `${prefix}-fields`;
        fields.append(en, zh);
        const clearState = document.createElement("span");
        clearState.className = `${prefix}-clear-state`;
        clearState.textContent = "已清除 · 不输出";
        fields.append(clearState);
        const clearButton = document.createElement("button");
        clearButton.type = "button";
        clearButton.className = `${prefix}-clear`;
        clearButton.setAttribute("aria-label", `清除提示词：${part}`);
        const rowState = { card: row, select, en, zh, clearButton, clearState, excluded: excludedKeys.has(promptCardKey(part)) };
        const syncClearState = (notify = false) => {
          const isExcluded = rowState.excluded;
          row.classList.toggle("is-cleared", isExcluded);
          clearState.hidden = !isExcluded;
          clearButton.textContent = isExcluded ? "恢复" : "清除";
          clearButton.title = isExcluded ? "恢复该提示词并允许输出" : "清除该提示词；应用后不会输出";
          clearButton.setAttribute("aria-label", isExcluded ? `恢复提示词：${en.value}` : `清除提示词：${en.value}`);
          select.disabled = isExcluded;
          en.disabled = isExcluded;
          zh.disabled = isExcluded;
          if (isExcluded) select.checked = false;
          updateSelectionTools();
          if (notify) onInput?.(editor, "clear", rowState);
        };
        clearButton.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          rowState.excluded = !rowState.excluded;
          syncClearState(true);
        };
        rows.push(rowState);
        select.addEventListener("change", updateSelectionTools);
        en.addEventListener("input", () => onInput?.(editor, "en", rowState));
        zh.addEventListener("input", () => onInput?.(editor, "zh", rowState));
        row.append(select, fields, clearButton);
        list.append(row);
        syncClearState();
      }
      container.append(header, list, selectionTools);
      updateSelectionTools();
      if (!unique.length) {
        const empty = document.createElement("div");
        empty.className = `${prefix}-empty`;
        empty.textContent = "没有可编辑的 Prompt 片段";
        container.append(empty);
      }
      return editor;
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
        const promptResult = this.buildPromptForPost(post);
        const promptEdit = this.promptEdits.get(String(post.id || ""));
        const promptText = promptEdit ? String(promptEdit.prompt || "") : promptResult.prompt;
        const promptTags = promptEdit && Array.isArray(promptEdit.tags) ? promptEdit.tags : promptResult.tags;
        card.dataset.prompt = promptText;
        card.dataset.tags = JSON.stringify(promptTags);
        card.dataset.promptParts = JSON.stringify(promptEdit?.allParts || splitPromptParts(promptText));
        card.dataset.promptExcluded = JSON.stringify(promptEdit?.excluded || []);
        card.dataset.promptTranslations = JSON.stringify(promptEdit?.translations || {});
        card.dataset.promptGroups = JSON.stringify(promptResult.groups);
        card.dataset.postId = String(post.id || "");
        // 结构化元数据（2026-08-24：metadata_json 输出数据源）
        card.dataset.rating = String(post.rating || "");
        card.dataset.score = String(post.score ?? "");
        card.dataset.favcount = String(post.fav_count ?? "");
        card.dataset.width = String(post.image_width ?? "");
        card.dataset.height = String(post.image_height ?? "");
        card.dataset.fileExt = String(post.file_ext || "");
        card.dataset.video = this.isVideoPost(post) ? "1" : "0";
        card.dataset.sourceUrl = post.file_url || post.large_file_url || imageUrl;
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
        selectButton.addEventListener("click", (event) => {
          const multi = event.ctrlKey || event.metaKey || event.shiftKey;
          const wasSelected = card.classList.contains("is-selected");
          if (multi) {
            // Ctrl/Shift + 点击：切换该卡选中状态（不清其他）→ 多选用于批量归类/批量选择
            card.classList.toggle("is-selected", !wasSelected);
            selectButton.setAttribute("aria-pressed", !wasSelected ? "true" : "false");
            this.rememberCardSelection(card, !wasSelected);
          } else {
            this.grid.querySelectorAll(".adg-card.is-selected").forEach((other) => {
              other.classList.remove("is-selected");
              other.querySelector(".adg-card-select")?.setAttribute("aria-pressed", "false");
            });
            this.selectionOrder = [];
            card.classList.toggle("is-selected", !wasSelected);
            selectButton.setAttribute("aria-pressed", !wasSelected ? "true" : "false");
            this.rememberCardSelection(card, !wasSelected);
          }
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
        addAction("预览", "预览图片", () => this.openImagePreview(post));
        addAction("Prompt", "查看、编辑和复制 Prompt", () => this.openPromptEditor(card, post));
        addAction("入库", "保存图片和 Prompt 到本地工具箱 Prompt 库", () => this.saveToPromptLibrary(post));
        addAction("下载", "下载原图", () => this.downloadPost(post));
        addAction("分类", "设置本地分类（点选，支持标签一键建分类）", () => this.openCategoryPicker([post.id]));
        // 分类徽章：已归类的卡片左上角显示分类名
        const catId = this.settings.postCategories[String(post.id)];
        if (catId) {
          const catName = this.settings.categories.find((c) => c.id === catId)?.name;
          if (catName) {
            const badge = document.createElement("span");
            badge.className = "adg-cat-badge";
            badge.textContent = catName;
            badge.title = `本地分类：${catName}（点卡片「分类」可修改）`;
            badge.style.cssText = "position:absolute;top:6px;left:6px;z-index:3;background:rgba(109,85,240,.85);color:#fff;font-size:10px;line-height:1.4;padding:1px 6px;border-radius:4px;pointer-events:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            card.append(badge);
          }
        }
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
      if (this.settings.activeCategory) {
        const badge = document.createElement("span");
        badge.className = "adg-cat-mode-badge";
        badge.textContent = "本地分类浏览";
        badge.title = "当前为该分类全部已归类图片；搜索或翻页即返回普通搜索";
        this.pagination.append(badge);
        return;
      }
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

    async choosePromptSaveOptions(post) {
      let database = null;
      let categories = DEFAULT_PROMPT_LIBRARY_CATEGORIES.map((category) => ({ ...category }));
      try {
        database = await openPromptLibraryDB();
        categories = await readPromptLibraryCategories(database);
      } catch {
        // 保存阶段仍会再次打开数据库；这里使用默认分类保证选项弹层可用。
      } finally {
        database?.close();
      }

      const current = this.promptOutputSettings();
      const rawGroups = this.rawPromptGroups(post);
      const content = document.createElement("div");
      content.className = "adg-prompt-settings adg-save-options";
      const intro = document.createElement("div");
      intro.className = "adg-prompt-settings-tip";
      intro.textContent = "选择本次入库的 Prompt 库分类，以及要写入 Prompt 和双语卡片的 D 站标签类别。不会修改全局 Prompt 设置。";
      content.append(intro);

      const libraryTitle = document.createElement("div");
      libraryTitle.className = "adg-prompt-settings-title";
      libraryTitle.textContent = "Prompt 库分类";
      const librarySelect = document.createElement("select");
      librarySelect.className = "adg-save-category-select";
      librarySelect.setAttribute("aria-label", "Prompt 库分类");
      for (const category of categories) {
        const option = document.createElement("option");
        option.value = String(category.id);
        option.textContent = category.icon ? `${category.icon} ${category.name}` : String(category.name || category.id);
        librarySelect.append(option);
      }
      const preferred = categories.find((category) => category.id === "uncategorized") || categories[0];
      if (preferred) librarySelect.value = String(preferred.id);
      content.append(libraryTitle, librarySelect);

      const promptTitle = document.createElement("div");
      promptTitle.className = "adg-prompt-settings-title";
      promptTitle.textContent = "本次 Prompt 包含";
      const promptList = document.createElement("div");
      promptList.className = "adg-prompt-category-list";
      const categoryInputs = new Map();
      for (const category of PROMPT_CATEGORY_ORDER) {
        const tags = rawGroups[category] || [];
        const label = document.createElement("label");
        label.className = "adg-prompt-category-choice";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = category;
        input.checked = current.categories.includes(category) && tags.length > 0;
        input.disabled = tags.length === 0;
        const text = document.createElement("span");
        text.textContent = `${PROMPT_CATEGORY_LABELS[category]}（${tags.length}）`;
        label.append(input, text);
        promptList.append(label);
        categoryInputs.set(category, input);
      }
      content.append(promptTitle, promptList);

      const excludeTitle = document.createElement("div");
      excludeTitle.className = "adg-prompt-settings-title";
      excludeTitle.textContent = "排除提示词（可选）";
      const excludeInput = document.createElement("input");
      excludeInput.type = "text";
      excludeInput.className = "adg-save-exclude-input";
      excludeInput.value = this.settings.promptExcludePattern || "";
      excludeInput.placeholder = "例如：censor|text|logo|username|hair|eyes";
      excludeInput.title = "大小写不敏感正则，匹配到的 D 站标签不会进入本次 Prompt 或双语卡片";
      const excludeHelp = document.createElement("div");
      excludeHelp.className = "adg-prompt-settings-tip";
      excludeHelp.textContent = "按标签原文模糊匹配，例如 hair 会排除 long_hair、hair ornament 等；只影响本次入库。";
      content.append(excludeTitle, excludeInput, excludeHelp);

      const defaultSaveTitle = `D站 #${post.id || ""}`;
      const titleTitle = document.createElement("div");
      titleTitle.className = "adg-prompt-settings-title";
      titleTitle.textContent = "Prompt 标题";
      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.className = "adg-save-title-input";
      titleInput.value = defaultSaveTitle;
      titleInput.placeholder = defaultSaveTitle;
      titleInput.maxLength = 120;
      content.append(titleTitle, titleInput);

      const promptContentTitle = document.createElement("div");
      promptContentTitle.className = "adg-prompt-settings-title";
      promptContentTitle.textContent = "入库 Prompt 内容（可编辑）";
      const promptInput = document.createElement("textarea");
      promptInput.className = "adg-save-prompt-input";
      promptInput.rows = 4;
      promptInput.spellcheck = false;
      const selectedSettings = () => ({
        categories: PROMPT_CATEGORY_ORDER.filter((category) => categoryInputs.get(category)?.checked),
        replaceUnderscores: current.replaceUnderscores,
        escapeBrackets: current.escapeBrackets,
      });
      const savedEdit = this.promptEdits.get(String(post.id || ""));
      promptInput.value = savedEdit ? String(savedEdit.prompt || "") : this.buildPromptForPost(post, selectedSettings(), excludeInput.value).prompt;
      content.append(promptContentTitle, promptInput);

      const previewTitle = document.createElement("div");
      previewTitle.className = "adg-prompt-settings-title";
      previewTitle.textContent = "双语卡片预览";
      const previewStatus = document.createElement("div");
      previewStatus.className = "adg-save-preview-status";
      const previewGrid = document.createElement("div");
      previewGrid.className = "adg-save-bilingual-grid";
      content.append(previewTitle, previewStatus, previewGrid);
      let promptDirty = Boolean(savedEdit?.prompt);
      let previewEditor = null;
      const manualTranslations = new Map(Object.entries(savedEdit?.translations || {}).map(([key, value]) => [promptCardKey(key), String(value || "").trim()]));
      let previewRequest = 0;
      const captureManualTranslations = () => {
        for (const { en, zh } of previewEditor?.rows || []) {
          const key = promptCardKey(en.value);
          if (key) manualTranslations.set(key, zh.value.trim());
        }
      };
      const renderPreview = (parts, translations) => {
        if (!parts.length) {
          previewGrid.replaceChildren();
          previewEditor = null;
          previewStatus.textContent = "当前没有可预览的 Prompt 片段";
          return;
        }
        previewStatus.textContent = `共 ${parts.length} 张双语卡片`;
        captureManualTranslations();
        previewEditor = this.renderBilingualPromptEditor(previewGrid, parts, {
          ...translations,
          ...Object.fromEntries(manualTranslations),
        }, {
          prefix: "adg-save-bilingual",
          onInput: (editor, field) => {
            captureManualTranslations();
            promptDirty = true;
            if (field === "en" || field === "clear") promptInput.value = editor.read().prompt;
          },
        });
      };
      const refreshPreview = async () => {
        const requestId = ++previewRequest;
        captureManualTranslations();
        const generated = this.buildPromptForPost(post, selectedSettings(), excludeInput.value);
        if (!promptDirty) promptInput.value = generated.prompt;
        const parts = splitPromptParts(promptInput.value);
        previewStatus.textContent = "正在加载双语预览…";
        const translations = await this.ensurePromptTranslations(parts);
        if (requestId !== previewRequest) return;
        renderPreview(parts, translations);
      };
      for (const input of categoryInputs.values()) input.addEventListener("change", () => { if (!promptDirty) refreshPreview(); });
      excludeInput.addEventListener("input", () => { if (!promptDirty) refreshPreview(); });
      promptInput.addEventListener("input", () => { promptDirty = true; refreshPreview(); });

      return new Promise((resolve) => {
        refreshPreview();
        this.openDialog({
          title: `保存 D 站 #${post.id || ""} 到 Prompt 库`,
          content,
          onCancel: () => resolve(null),
          onApply: () => {
            const selectedCategories = PROMPT_CATEGORY_ORDER.filter((category) => categoryInputs.get(category)?.checked);
            if (!selectedCategories.length) {
              this.setStatus("至少选择一个 Prompt 类别", "error");
              return false;
            }
            const excludePattern = excludeInput.value.trim();
            if (excludePattern) {
              try { new RegExp(excludePattern, "i"); } catch (error) {
                this.setStatus(`排除正则无效：${error.message || error}`, "error");
                excludeInput.focus();
                return false;
              }
            }
            this.settings.promptExcludePattern = excludePattern;
            this.saveSettings();
            const generated = this.buildPromptForPost(post, {
              categories: selectedCategories,
              replaceUnderscores: current.replaceUnderscores,
              escapeBrackets: current.escapeBrackets,
            }, excludePattern);
            const previewResult = previewEditor?.read();
            const promptText = (promptDirty ? promptInput.value : generated.prompt).trim();
            if (!promptText && !previewResult?.allParts?.length) {
              this.setStatus("排除规则过滤后没有可保存的 Prompt", "error");
              promptInput.focus();
              return false;
            }
            resolve({
              categoryId: librarySelect.value || "uncategorized",
              categoryOptions: categories,
              excludePattern,
              title: titleInput.value.trim() || defaultSaveTitle,
              promptText,
              tagTranslations: previewResult?.translations || {},
              promptOutput: {
                categories: selectedCategories,
                replaceUnderscores: current.replaceUnderscores,
                escapeBrackets: current.escapeBrackets,
              },
            });
          },
        });
      });
    }

    async savePromptCards(promptResult, translations, postId) {
      const response = await fetch("/anima/cards");
      if (!response.ok) throw new Error(`卡片库读取 HTTP ${response.status}`);
      const library = await response.json();
      const categories = Array.isArray(library.categories) && library.categories.length
        ? library.categories
        : [{ id: "card_all", name: "通用", icon: "", sortOrder: 0 }];
      const categoryId = categories.find((category) => category.id === "card_all")?.id || categories[0].id;
      const cards = Array.isArray(library.cards) ? library.cards : [];
      const byPrompt = new Map();
      for (const card of cards) {
        const key = promptCardKey(card?.en);
        if (key && !byPrompt.has(key)) byPrompt.set(key, card);
      }

      const now = Date.now();
      let created = 0;
      let updated = 0;
      let translatedCount = 0;
      for (const tag of promptResult.tags || []) {
        const en = formatPromptTag(tag, promptResult.settings);
        if (!en) continue;
        const zh = String(translations?.[tag] || "").trim();
        if (zh) translatedCount++;
        const key = promptCardKey(en);
        const existing = byPrompt.get(key);
        if (existing) {
          // 不覆盖用户手工修订过的译文，只补全历史空译文。
          if (zh && !String(existing.zh || "").trim()) {
            existing.zh = zh;
            existing.ts = now;
            updated++;
          }
          continue;
        }
        const card = {
          id: `danbooru_${postId || "unknown"}_${now}_${created}`,
          en,
          zh,
          weight: "",
          star: false,
          lora: "",
          src: `danbooru:${postId || ""}`,
          ts: now,
          multi: false,
          categories: [categoryId],
        };
        cards.push(card);
        byPrompt.set(key, card);
        created++;
      }
      if (created || updated) {
        library.version = 2;
        library.categories = categories;
        library.cards = cards;
        const saveResponse = await fetch("/anima/cards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(library),
        });
        const saved = await saveResponse.json();
        if (!saveResponse.ok || !saved?.ok) throw new Error(saved?.error || `卡片库保存 HTTP ${saveResponse.status}`);
        window.dispatchEvent(new CustomEvent("anima-prompt-cards-updated", { detail: { source: "danbooru" } }));
      }
      return { created, updated, translated: translatedCount, total: (promptResult.tags || []).length };
    }

    async saveToPromptLibrary(post) {
      const imageUrl = post.large_file_url || post.file_url || post.preview_file_url;
      if (!imageUrl) return;
      const saveOptions = await this.choosePromptSaveOptions(post);
      if (!saveOptions) return;
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
        const generatedPromptResult = this.buildPromptForPost(post, saveOptions.promptOutput, saveOptions.excludePattern);
        const prompt = String(saveOptions.promptText || generatedPromptResult.prompt).trim();
        const tags = splitPromptParts(prompt);
        const fetchedTranslations = await this.ensurePromptTranslations(tags);
        const customTranslations = new Map(Object.entries(saveOptions.tagTranslations || {}).map(([key, value]) => [promptCardKey(key), String(value || "").trim()]));
        const translations = Object.fromEntries(tags.map((tag) => [
          tag,
          customTranslations.has(promptCardKey(tag)) ? customTranslations.get(promptCardKey(tag)) : (fetchedTranslations[tag] || ""),
        ]));
        const promptResult = { ...generatedPromptResult, prompt, tags };
        const now = Date.now();
        const entry = {
          id: `p_${now}_${Math.random().toString(36).slice(2, 8)}`,
          prompt,
          displayText: saveOptions.title || `D站 #${post.id || ""}`,
          images: [imageDataUrl],
          primaryImage: imageDataUrl,
          tags,
          promptGroups: promptResult.groups,
          tagTranslations: translations,
          loras: [],
          categoryId: saveOptions.categoryId || "uncategorized",
          notes: `来源：Danbooru #${post.id || ""}`,
          isFavorite: false,
          createdAt: now,
          updatedAt: now,
        };
        const database = await openPromptLibraryDB();
        await new Promise((resolve, reject) => {
          const transaction = database.transaction(["prompts", "promptCategories"], "readwrite");
          const categories = transaction.objectStore("promptCategories");
          for (const category of saveOptions.categoryOptions || []) categories.put(category);
          transaction.objectStore("prompts").add(entry);
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("写入 Prompt 库失败"));
        });
        database.close();
        let cardResult = null;
        let cardError = null;
        try {
          cardResult = await this.savePromptCards(promptResult, translations, post.id);
        } catch (error) {
          cardError = error;
        }
        if (cardResult) {
          const missing = Math.max(0, cardResult.total - cardResult.translated);
          this.setStatus(`已保存 #${post.id || ""}：Prompt 库 + 卡片库 ${cardResult.created} 张${cardResult.updated ? `，补全 ${cardResult.updated} 张` : ""}${missing ? `，${missing} 张待翻译` : ""}`);
        } else {
          this.setStatus(`已保存 #${post.id || ""} 到 Prompt 库，但卡片库同步失败：${cardError?.message || "未知错误"}`, "error");
        }
      } catch (error) {
        this.setStatus(`保存 Prompt 库失败：${error?.message || "未知错误"}`, "error");
      }
    }

    async showPromptTooltip(card, event) {
      let tags = [];
      try { tags = JSON.parse(card.dataset.tags || "[]"); } catch { tags = []; }
      if (!tags.length) return;
      let promptGroups = {};
      try { promptGroups = JSON.parse(card.dataset.promptGroups || "{}"); } catch { promptGroups = {}; }
      const tagKeys = new Set(tags.map(promptCardKey));
      const seen = new Set();
      const grouped = [];
      const addGroup = (category, values) => {
        const groupTags = [];
        for (const rawTag of Array.isArray(values) ? values : []) {
          const tag = String(rawTag || "").trim();
          const key = promptCardKey(tag);
          if (!tag || !tagKeys.has(key) || seen.has(key)) continue;
          seen.add(key);
          groupTags.push(tag);
        }
        if (groupTags.length) grouped.push({ category, tags: groupTags });
      };
      for (const category of PROMPT_CATEGORY_ORDER) addGroup(category, promptGroups[category]);
      const ungrouped = tags.filter((tag) => !seen.has(promptCardKey(tag)));
      if (ungrouped.length) addGroup("general", ungrouped);
      if (!grouped.length) grouped.push({ category: "general", tags });
      const groupedTags = grouped.flatMap(({ tags: values }) => values);
      this.hidePromptTooltip();
      const tooltip = document.createElement("div");
      tooltip.className = "adg-prompt-tooltip";
      tooltip.textContent = "正在加载双语 Prompt…";
      document.body.append(tooltip);
      this.tooltip = tooltip;
      this.positionTooltip(event);
      await this.ensureTagTranslations(groupedTags);
      if (this.tooltip !== tooltip) return;
      tooltip.replaceChildren(...grouped.map(({ category, tags: values }) => {
        const section = document.createElement("section");
        section.className = "adg-prompt-tooltip-section";
        const heading = document.createElement("div");
        heading.className = "adg-prompt-tooltip-category";
        heading.textContent = PROMPT_CATEGORY_LABELS[category] || category;
        section.append(heading, ...values.map((tag) => {
          const line = document.createElement("div");
          line.className = "adg-prompt-tooltip-line";
          const english = document.createElement("span");
          english.textContent = tag.replace(/_/g, " ");
          const chinese = this.translationCache.get(tag);
          line.append(english);
          if (chinese) line.append(Object.assign(document.createElement("small"), { textContent: chinese }));
          return line;
        }));
        return section;
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

    async openPromptEditor(card, post) {
      const prompt = card.dataset.prompt ?? this.postPrompt(post);
      const savedEdit = this.promptEdits.get(String(post.id || ""));
      let storedParts = Array.isArray(savedEdit?.allParts) ? savedEdit.allParts : [];
      let storedExcluded = Array.isArray(savedEdit?.excluded) ? savedEdit.excluded : [];
      let storedTranslations = savedEdit?.translations;
      try {
        if (!storedParts.length) storedParts = JSON.parse(card.dataset.promptParts || "[]");
        if (!storedExcluded.length) storedExcluded = JSON.parse(card.dataset.promptExcluded || "[]");
        if (!storedTranslations) storedTranslations = JSON.parse(card.dataset.promptTranslations || "{}");
      } catch {
        // 兼容旧卡片数据：下方使用当前 Prompt 作为完整可编辑内容。
      }
      const parts = storedParts.length ? storedParts : splitPromptParts(prompt);
      let savedTranslations = {};
      savedTranslations = storedTranslations && typeof storedTranslations === "object" ? storedTranslations : {};
      const fetchedTranslations = await this.ensurePromptTranslations(parts);
      const translations = { ...fetchedTranslations, ...savedTranslations };
      const content = document.createElement("div");
      content.className = "adg-prompt-editor";
      const intro = document.createElement("div");
      intro.className = "adg-dialog-intro";
      intro.textContent = "每行对应一个提示词；修改英文会更新 Prompt，修改中文会更新翻译。点击卡片右侧「清除」可保留记录但不输出，应用后生效。";
      const groupSummary = document.createElement("div");
      groupSummary.className = "adg-prompt-groups";
      let promptGroups = {};
      try { promptGroups = JSON.parse(card.dataset.promptGroups || "{}"); } catch { promptGroups = {}; }
      for (const category of PROMPT_CATEGORY_ORDER) {
        const count = Array.isArray(promptGroups[category]) ? promptGroups[category].length : 0;
        if (!count) continue;
        const chip = document.createElement("span");
        chip.textContent = `${PROMPT_CATEGORY_LABELS[category]} ${count}`;
        groupSummary.append(chip);
      }
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "复制 Prompt";
      copy.onclick = async () => {
        const current = editor.read().prompt;
        try {
          await navigator.clipboard.writeText(current);
          this.setStatus("Prompt 已复制");
        } catch {
          const fallback = document.createElement("textarea");
          fallback.value = current;
          document.body.append(fallback);
          fallback.select();
          document.execCommand("copy");
          fallback.remove();
          this.setStatus("Prompt 已复制");
        }
      };
      const bilingualEditor = document.createElement("div");
      bilingualEditor.className = "adg-prompt-bilingual-editor";
      const editor = this.renderBilingualPromptEditor(bilingualEditor, parts, translations, {
        prefix: "adg-prompt-bilingual",
        excluded: storedExcluded,
      });
      content.append(intro, groupSummary, bilingualEditor, copy);
      this.openDialog({
        title: `Prompt #${post.id || ""}`,
        content,
        onApply: () => {
          const result = editor.read();
          if (!result.prompt && !result.allParts.length) {
            this.setStatus("Prompt 不能为空", "error");
            return false;
          }
          const edit = {
            prompt: result.prompt,
            tags: result.parts,
            translations: result.allTranslations,
            allParts: result.allParts,
            excluded: result.excludedParts,
          };
          this.promptEdits.set(String(post.id || ""), edit);
          card.dataset.prompt = edit.prompt;
          card.dataset.tags = JSON.stringify(edit.tags);
          card.dataset.promptParts = JSON.stringify(edit.allParts);
          card.dataset.promptExcluded = JSON.stringify(edit.excluded);
          card.dataset.promptTranslations = JSON.stringify(edit.translations);
          let groups = {};
          try { groups = JSON.parse(card.dataset.promptGroups || "{}"); } catch { groups = {}; }
          const excludedKeys = new Set(edit.excluded.map(promptCardKey));
          card.dataset.promptGroups = JSON.stringify(Object.fromEntries(
            PROMPT_CATEGORY_ORDER.map((category) => [category, (groups[category] || []).filter((tag) => !excludedKeys.has(promptCardKey(tag)))])
          ));
          this.updateSelection();
          this.setStatus(edit.excluded.length ? `Prompt 已更新，已清除 ${edit.excluded.length} 个词条（不输出）` : "Prompt 已更新");
        },
      });
    }

    removeDialog() {
      document.getElementById(this.dialogId)?.remove();
    }

    openPromptSettings() {
      const current = this.promptOutputSettings();
      const content = document.createElement("div");
      content.className = "adg-prompt-settings";
      const intro = document.createElement("div");
      intro.className = "adg-prompt-settings-tip";
      intro.textContent = "控制卡片 Prompt、节点 prompts 输出，以及 metadata_json 里的分组。默认保持旧输出顺序。";
      content.append(intro);

      const categoryTitle = document.createElement("div");
      categoryTitle.className = "adg-prompt-settings-title";
      categoryTitle.textContent = "输出类别（按 Danbooru 类别去重）";
      const categoryList = document.createElement("div");
      categoryList.className = "adg-prompt-category-list";
      const categoryInputs = new Map();
      for (const category of PROMPT_CATEGORY_ORDER) {
        const label = document.createElement("label");
        label.className = "adg-prompt-category-choice";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = category;
        input.checked = current.categories.includes(category);
        const text = document.createElement("span");
        text.textContent = PROMPT_CATEGORY_LABELS[category];
        label.append(input, text);
        categoryList.append(label);
        categoryInputs.set(category, input);
      }
      content.append(categoryTitle, categoryList);

      const formatTitle = document.createElement("div");
      formatTitle.className = "adg-prompt-settings-title";
      formatTitle.textContent = "格式";
      const formatList = document.createElement("div");
      formatList.className = "adg-prompt-format-list";
      const makeFormatChoice = (name, labelText, checked) => {
        const label = document.createElement("label");
        label.className = "adg-prompt-format-choice";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        const text = document.createElement("span");
        text.textContent = labelText;
        label.append(input, text);
        formatList.append(label);
        return input;
      };
      const replaceUnderscores = makeFormatChoice("replaceUnderscores", "下划线转空格（long_hair → long hair）", current.replaceUnderscores);
      const escapeBrackets = makeFormatChoice("escapeBrackets", "转义括号（(tag) → \\(tag\\)）", current.escapeBrackets);
      content.append(formatTitle, formatList);

      this.openDialog({
        title: "Prompt 输出设置",
        content,
        onApply: () => {
          const categories = PROMPT_CATEGORY_ORDER.filter((category) => categoryInputs.get(category)?.checked);
          this.settings.promptOutput = normalizePromptOutputSettings({
            categories,
            replaceUnderscores: replaceUnderscores.checked,
            escapeBrackets: escapeBrackets.checked,
          });
          this.saveSettings();
          const selectedIds = new Set([...this.grid.querySelectorAll(".adg-card.is-selected")].map((card) => card.dataset.postId));
          this.renderPosts();
          for (const card of this.grid.querySelectorAll(".adg-card")) {
            if (!selectedIds.has(card.dataset.postId)) continue;
            card.classList.add("is-selected");
            card.querySelector(".adg-card-select")?.setAttribute("aria-pressed", "true");
          }
          this.updateSelection();
          this.setStatus(`Prompt 输出已更新：${this.settings.promptOutput.categories.map((category) => PROMPT_CATEGORY_LABELS[category]).join("、")}`, "success");
        },
      });
    }

    // 点选式分类菜单（替代原 prompt 打字）：
    // 已有分类点即归类；「从标签新建」用该图标签一键建分类；内联输入新建兜底
    // postIds 为空 = 纯新建分类模式（不归类任何图）
    openCategoryPicker(postIds) {
      const ids = (postIds || []).map(String);
      const content = document.createElement("div");
      content.className = "adg-category-picker";

      const head = document.createElement("div");
      head.className = "adg-menu-title";
      head.textContent = ids.length ? `将 ${ids.length} 张图归入：` : "新建分类：";
      content.append(head);

      const assign = (catId, catName) => {
        if (catId) ids.forEach((id) => { this.settings.postCategories[id] = catId; });
        else ids.forEach((id) => { delete this.settings.postCategories[id]; });
        this.saveSettings();
        this.renderPosts();
        this.filterControls?.refresh();
        this.removeDialog();
        this.setStatus(ids.length ? `已归类 ${ids.length} 张 → ${catName}` : `已创建分类：${catName}`, "success");
      };

      if (ids.length) {
        // 当前归类状态（单张时显示）
        const currentCatId = ids.length === 1 ? this.settings.postCategories[ids[0]] || "" : "";

        // 无分类
        const none = document.createElement("button");
        none.type = "button";
        none.className = "adg-category-item";
        none.textContent = "✕ 无分类（移除归类）";
        none.onclick = () => assign("", "无分类");
        content.append(none);

        // 已有分类（带计数与当前勾选；✕ 删除——其中的图片变回未分类）
        const existingWrap = document.createElement("div");
        existingWrap.className = "adg-category-existing";
        const renderExisting = () => {
          existingWrap.innerHTML = "";
          const counts = {};
          for (const cid of Object.values(this.settings.postCategories)) counts[cid] = (counts[cid] || 0) + 1;
          for (const cat of this.settings.categories) {
            const row = document.createElement("div");
            row.className = "adg-category-row";
            row.classList.toggle("is-selected", cat.id === currentCatId);
            const pick = document.createElement("button");
            pick.type = "button";
            pick.className = "adg-menu-choice adg-category-pick";
            const name = document.createElement("span");
            name.className = "adg-menu-choice-text";
            name.textContent = cat.name;
            const meta = document.createElement("span");
            meta.className = "adg-category-item-meta";
            meta.textContent = `${counts[cat.id] || 0} 张${cat.id === currentCatId ? " · 当前" : ""}`;
            pick.append(name, meta);
            pick.onclick = () => assign(cat.id, cat.name);
            const ops = document.createElement("span");
            ops.className = "adg-category-ops";
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "adg-category-op adg-category-op-remove";
            remove.title = "删除分类（其中的图片变回未分类）";
            remove.textContent = "✕";
            remove.onclick = (event) => {
              event.stopPropagation();
              const cats = this.settings.categories.filter((c) => c.id !== cat.id);
              const postCategories = {};
              for (const [pid, cid] of Object.entries(this.settings.postCategories)) {
                if (cid !== cat.id) postCategories[pid] = cid;
              }
              this.settings.categories = cats;
              this.settings.postCategories = postCategories;
              if (this.settings.activeCategory === cat.id) this.settings.activeCategory = "";
              this.saveSettings();
              this.filterControls?.refresh();
              renderExisting();
              this.setStatus(`已删除分类：${cat.name}`);
            };
            ops.append(remove);
            row.append(pick, ops);
            existingWrap.append(row);
          }
        };
        renderExisting();
        content.append(existingWrap);

        // 从标签一键建分类（单张时取该图标签；点标签 = 建分类并归类，零打字）
        const firstPost = ids.length === 1 ? this.posts.find((p) => String(p.id) === ids[0]) : null;
        if (firstPost) {
          const tags = this.postTags(firstPost).slice(0, 10);
          if (tags.length) {
            const tagTitle = document.createElement("div");
            tagTitle.className = "adg-menu-title";
            tagTitle.textContent = "从标签一键建分类（点标签即归类）：";
            content.append(tagTitle);
            const tagWrap = document.createElement("div");
            tagWrap.className = "adg-category-tags";
            for (const tag of tags) {
              const chip = document.createElement("button");
              chip.type = "button";
              chip.className = "adg-category-tag";
              chip.textContent = tag.replace(/_/g, " ");
              chip.onclick = () => {
                const displayName = tag.replace(/_/g, " ");
                const existing = this.settings.categories.find((c) => c.name === displayName);
                const cat = existing || { id: `c_${Date.now()}`, name: displayName };
                if (!existing) this.settings.categories.push(cat);
                assign(cat.id, displayName);
              };
              tagWrap.append(chip);
            }
            content.append(tagWrap);
          }
        }
      }

      // 新建分类（内联输入兜底）
      const newTitle = document.createElement("div");
      newTitle.className = "adg-menu-title";
      newTitle.textContent = ids.length ? "新建分类：" : "输入分类名称（回车确认）：";
      const newRow = document.createElement("div");
      newRow.className = "adg-category-newrow";
      const newInput = document.createElement("input");
      newInput.type = "text";
      newInput.placeholder = "输入分类名称，回车确认";
      const create = () => {
        const name = newInput.value.trim();
        if (!name) return;
        const existing = this.settings.categories.find((c) => c.name === name);
        const cat = existing || { id: `c_${Date.now()}`, name };
        if (!existing) this.settings.categories.push(cat);
        assign(cat.id, name);
      };
      newInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); create(); } };
      const newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "primary";
      newBtn.textContent = ids.length ? "创建并归类" : "创建";
      newBtn.onclick = create;
      newRow.append(newInput, newBtn);
      content.append(newTitle, newRow);

      this.openDialog({ title: ids.length ? "设置分类" : "新建分类", content, onApply: () => {}, showApply: false });
      setTimeout(() => newInput.focus(), 50);
    }

    // 搜索预设统一管理：保存当前搜索、点行应用、行尾删除。
    openPresetManager() {
      const content = document.createElement("div");
      content.className = "adg-preset-manager";
      const head = document.createElement("div");
      head.className = "adg-dialog-intro";
      head.textContent = "保存当前标签、分级和筛选条件；点击预设名称即可应用。";
      content.append(head);

      const saveRow = document.createElement("div");
      saveRow.className = "adg-preset-save-row";
      const nameInput = document.createElement("input");
      nameInput.className = "adg-preset-name-input";
      nameInput.placeholder = "新预设名称";
      nameInput.setAttribute("aria-label", "新预设名称");
      const saveButton = document.createElement("button");
      saveButton.type = "button";
      saveButton.className = "primary";
      saveButton.textContent = "保存当前";
      saveButton.onclick = () => {
        const name = nameInput.value.trim();
        if (!name) {
          nameInput.focus();
          this.setStatus("请输入预设名称", "error");
          return;
        }
        const preset = {
          name,
          query: this.queryWidget?.value || this.settings.lastQuery || "",
          rating: [...this.settings.rating],
          filters: { ...this.settings.filters },
        };
        const existing = this.settings.presets.findIndex((item) => item.name === name);
        if (existing >= 0) this.settings.presets[existing] = preset;
        else this.settings.presets.push(preset);
        this.saveSettings();
        this.renderPresetOptions();
        nameInput.value = "";
        renderRows();
        this.setStatus(`${existing >= 0 ? "已更新" : "已保存"}搜索预设：${name}`, "success");
      };
      nameInput.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); saveButton.click(); } };
      saveRow.append(nameInput, saveButton);
      content.append(saveRow);

      const list = document.createElement("div");
      list.className = "adg-preset-list";
      const renderRows = () => {
        list.innerHTML = "";
        if (!this.settings.presets.length) {
          const empty = document.createElement("div");
          empty.className = "adg-preset-empty";
          empty.textContent = "暂无预设";
          list.append(empty);
          return;
        }
        this.settings.presets.forEach((preset, index) => {
          const row = document.createElement("div");
          row.className = "adg-preset-row";
          const pick = document.createElement("button");
          pick.type = "button";
          pick.className = "adg-preset-pick";
          pick.title = `应用预设：${preset.name}`;
          const name = document.createElement("span");
          name.className = "adg-preset-row-name";
          name.textContent = preset.name;
          const meta = document.createElement("span");
          meta.className = "adg-preset-row-meta";
          meta.textContent = preset.query || "（无查询词）";
          pick.append(name, meta);
          pick.onclick = () => {
            this.setQuery(preset.query);
            this.settings.rating = normalizeRatings(preset.rating);
            this.settings.filters = normalizeFilters(preset.filters);
            this.saveSettings();
            this.filterControls.refresh();
            this.search({ resetPage: true });
            this.removeDialog();
          };
          const ops = document.createElement("span");
          ops.className = "adg-preset-row-ops";
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "adg-preset-remove";
          remove.title = "删除该搜索预设";
          remove.setAttribute("aria-label", `删除预设：${preset.name}`);
          remove.textContent = "删除";
          remove.onclick = (event) => {
            event.stopPropagation();
            this.settings.presets.splice(index, 1);
            this.saveSettings();
            this.renderPresetOptions();
            renderRows();
            this.setStatus(`已删除搜索预设：${preset.name}`);
          };
          ops.append(remove);
          row.append(pick, ops);
          list.append(row);
        });
      };
      renderRows();
      content.append(list);
      this.openDialog({ title: "搜索预设管理", content, onApply: () => {}, showApply: false });
      setTimeout(() => nameInput.focus(), 50);
    }

    openDialog({ title, content, onApply, onCancel, showApply = true }) {
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
      const close = () => {
        onCancel?.();
        this.removeDialog();
      };
      cancel.onclick = close;
      actions.append(cancel);
      if (showApply) {
        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "primary";
        apply.textContent = "应用";
        apply.onclick = () => {
          if (onApply?.() === false) return;
          this.removeDialog();
        };
        actions.append(apply);
      }
      dialog.append(heading, content, actions);
      overlay.append(dialog);
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
      document.body.append(overlay);
    }

    openSettings() {
      const content = document.createElement("div");
      content.className = "adg-settings-fields adg-settings-dialog";
      const viewSection = document.createElement("section");
      viewSection.className = "adg-settings-section";
      const viewTitle = document.createElement("div");
      viewTitle.className = "adg-settings-title";
      viewTitle.textContent = "显示";
      const viewGrid = document.createElement("div");
      viewGrid.className = "adg-settings-grid";
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
      viewGrid.append(pageLabel, heightLabel);
      viewSection.append(viewTitle, viewGrid);
      content.append(viewSection);

      // ── 排除标签（搜索结果不含这些标签；每个占 1 个计数槽）──
      const excludeSection = document.createElement("section");
      excludeSection.className = "adg-settings-section";
      const exclTitle = document.createElement("div");
      exclTitle.className = "adg-settings-title";
      exclTitle.textContent = "排除标签（搜索不含这些）";
      const exclTip = document.createElement("div");
      exclTip.className = "adg-settings-help";
      exclTip.textContent = "不占计数标签名额，可任意添加；标签内部空格会转为下划线，逗号/换行才会分隔多个标签。例：long hair → long_hair";
      const exclInput = document.createElement("textarea");
      exclInput.className = "adg-settings-input";
      exclInput.rows = 2;
      exclInput.wrap = "off";
      exclInput.placeholder = "输入标签，逗号/换行分隔，如：long hair, censor";
      const exclList = document.createElement("div");
      exclList.className = "adg-exclude-list";
      const renderExcl = () => {
        exclList.innerHTML = "";
        if (!this.settings.excludeTags.length) {
          const empty = document.createElement("span");
          empty.className = "adg-exclude-empty";
          empty.textContent = "（无）";
          exclList.append(empty);
          return;
        }
        for (const tag of this.settings.excludeTags) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "adg-exclude-chip";
          chip.textContent = `− ${displayExcludeTag(tag)} ✕`;
          chip.title = "点击移除";
          chip.onclick = () => {
            this.settings.excludeTags = this.settings.excludeTags.filter((t) => t !== tag);
            this.saveSettings();
            renderExcl();
            this.setStatus(`已移除排除标签：${tag}`);
            this.search({ resetPage: true });
          };
          exclList.append(chip);
        }
      };
      const addExcl = () => {
        const tags = splitExcludeTags(exclInput.value);
        if (!tags.length) return;
        const merged = [...new Set([...this.settings.excludeTags, ...tags])].slice(0, 8);
        this.settings.excludeTags = merged;
        this.saveSettings();
        exclInput.value = "";
        renderExcl();
        this.setStatus(`已添加排除标签：${tags.map(displayExcludeTag).join("、")}（本地过滤）`, "success");
        this.search({ resetPage: true });
      };
      const exclAdd = document.createElement("button");
      exclAdd.type = "button";
      exclAdd.className = "primary adg-settings-inline-button";
      exclAdd.textContent = "添加";
      exclAdd.onclick = addExcl;
      exclInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addExcl(); } };
      const exclRow = document.createElement("div");
      exclRow.className = "adg-settings-inline-row";
      exclRow.append(exclInput, exclAdd);
      renderExcl();
      excludeSection.append(exclTitle, exclTip, exclRow, exclList);
      content.append(excludeSection);

      // ── D站 账号（登录后解除匿名 2 标签限制，更少限流）──
      const accountSection = document.createElement("section");
      accountSection.className = "adg-settings-section adg-account-section";
      const accTitle = document.createElement("div");
      accTitle.className = "adg-settings-title";
      accTitle.textContent = "Danbooru 账号";
      this.refreshAccount().then((reg) => {
        content.querySelector(".adg-account-status")?.remove();
        const status = document.createElement("div");
        status.className = "adg-account-status";
        status.textContent = reg ? "✓ 已登录 Danbooru（标签上限 6 个，多筛选更自由）" : "ℹ 未登录：匿名最多 2 个计数标签。登录后可同时组合更多标签+排序。";
        accountSection.prepend(status);
      });
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
      tip.className = "adg-settings-help";
      tip.textContent = "凭证仅存本机插件目录，不上传。清空保存 = 退出登录。";
      accountSection.append(accTitle, userLabel, keyLabel, tip);
      const accBtn = document.createElement("button");
      accBtn.type = "button";
      accBtn.className = "primary adg-settings-save-button";
      accBtn.textContent = "保存登录";
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
      accountSection.append(accBtn);
      content.append(accountSection);

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
      queryInput.placeholder = "标签（多个用空格分隔，回车直接搜）如：1girl long hair…";
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
        this.scheduleSuggestions(queryInput.value);
      };
      queryInput.addEventListener("focus", () => this.scheduleSuggestions(queryInput.value));
      queryInput.addEventListener("blur", () => setTimeout(() => {
        if (document.activeElement !== queryInput && !this.suggestions?.contains(document.activeElement)) this.hideSuggestions();
      }, 160));
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
      const makeToolbarGroup = (label, className) => {
        const group = document.createElement("div");
        group.className = `adg-toolbar-group ${className || ""}`.trim();
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", label);
        toolbar.append(group);
        return group;
      };
      const mainGroup = makeToolbarGroup("主要操作", "adg-toolbar-main");
      const filterGroup = makeToolbarGroup("筛选操作", "adg-toolbar-filters");
      const categoryGroup = makeToolbarGroup("分类操作", "adg-toolbar-categories");
      const presetGroup = makeToolbarGroup("搜索预设", "adg-toolbar-presets");
      const addAction = (label, title, action, group = toolbar) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-label", title);
        button.onpointerdown = (event) => event.stopPropagation();
        button.onmousedown = (event) => event.stopPropagation();
        button.onclick = (event) => { event.stopPropagation(); action(); };
        group.append(button);
        return button;
      };
      addAction("搜索", "按上方标签搜索", () => this.search({ resetPage: true }), mainGroup);
      addAction("设置", "设置画廊显示、排除标签和 Danbooru 登录", () => this.openSettings(), mainGroup);
      addAction("Prompt设置", "控制 Prompt 输出类别与格式", () => this.openPromptSettings(), mainGroup);
      this.promptOutputBtn = addAction("", "", () => {
        const enabled = this.setPromptOutputEnabled(this.settings.promptOutputEnabled === false);
        this.setStatus(enabled ? "Prompt 输出已开启" : "Prompt 输出已关闭：下游将收到空 Prompt", "success");
      }, mainGroup);
      this.updatePromptOutputButton();
      this.galleryBatchBtn = addAction("批量入队", "将选中的画廊卡片按显示顺序拆成独立任务，逐张执行", () => this.startGalleryBatch(), mainGroup);
      this.galleryBatchBtn.className = "adg-batch-queue";
      this.galleryBatchBtn.disabled = true;
      this.filterControls = new GalleryFilterControls({
        readSettings: () => this.settings,
        commit: (patch, { search = false, render = false } = {}) => {
          if (patch.rating) patch.rating = normalizeRatings(patch.rating);
          if (patch.filters) patch.filters = normalizeFilters(patch.filters);
          Object.assign(this.settings, patch);
          this.saveSettings();
          // 分类切换 = 本地浏览模式（按 id 全量拉取），不走通用渲染/搜索
          if (patch.activeCategory !== undefined) {
            this.applyActiveCategory(patch.activeCategory);
            return;
          }
          if (render) this.renderPosts();
          if (search) this.search({ resetPage: true });
        },
      });
      this.filterControls.mountFilters(filterGroup);
      addAction("刷新", "绕过缓存重新搜索", () => this.search({ force: true }), filterGroup);
      this.filterControls.mountCategory(categoryGroup);
      // 批量归类：选中 ≥2 张后可用（点选分类菜单，替代逐张 prompt）
      const batchCatBtn = document.createElement("button");
      batchCatBtn.type = "button";
      batchCatBtn.className = "adg-batch-cat";
      batchCatBtn.textContent = "归类选中";
      batchCatBtn.disabled = true;
      batchCatBtn.title = "先点选多张卡片，再批量归入同一分类";
      batchCatBtn.onclick = () => {
        const ids = [...this.grid.querySelectorAll(".adg-card.is-selected")]
          .map((c) => c.dataset.postId).filter(Boolean);
        if (ids.length) this.openCategoryPicker(ids);
      };
      categoryGroup.append(batchCatBtn);
      this.batchCatBtn = batchCatBtn;
      addAction("＋类", "新建分类（点选弹层）", () => this.openCategoryPicker([]), categoryGroup);
      const preset = document.createElement("select"); preset.title = "搜索预设";
      preset.setAttribute("aria-label", "搜索预设");
      this.presetSelect = preset;
      this.renderPresetOptions();
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
      presetGroup.append(preset);
      addAction("预设管理", "保存、应用或删除搜索预设", () => this.openPresetManager(), presetGroup);
      const paginationRow = document.createElement("div");
      paginationRow.className = "adg-pagination-row";
      const pagination = document.createElement("div");
      pagination.className = "adg-pagination";
      paginationRow.append(pagination);
      this.pagination = pagination;
      const info = document.createElement("div");
      info.className = "adg-info";
      info.textContent = "图片操作在卡片悬浮工具条。";
      const status = document.createElement("div");
      status.className = "adg-status";
      const galleryBatchPanel = document.createElement("div");
      galleryBatchPanel.className = "adg-batch-panel";
      galleryBatchPanel.hidden = true;
      this.galleryBatchPanel = galleryBatchPanel;
      const grid = document.createElement("div");
      grid.className = "adg-grid";
      const suggestions = document.createElement('div'); suggestions.className = 'adg-suggestions'; suggestions.style.display = 'none'; this.suggestions = suggestions;
      document.body.append(suggestions);
      window.addEventListener("resize", this.positionSuggestionsHandler);
      document.addEventListener("scroll", this.positionSuggestionsHandler, true);
      root.append(queryRow, toolbar, paginationRow, info, status, galleryBatchPanel, grid);
      this.root = root;
      this.status = status;
      this.grid = grid;
      this.applyGridHeight();
      // Chrome 下新 ComfyUI 节点激活层可能先命中 node-body，导致 DOM
      // 控件“看得见但鼠标点不到”。只从同一节点的命中栈中恢复控件点击，
      // 不穿透到被其他节点遮住的画廊，避免误触别的节点。
      const recoverPointer = (event) => {
        if (!this.root?.isConnected) return;
        const stack = document.elementsFromPoint(event.clientX, event.clientY);
        const candidate = stack
          .map((element) => element.closest?.("button, input, select, textarea, [role='button']"))
          .find((element) => element && this.root.contains(element));
        if (!candidate || event.target === candidate || candidate.contains(event.target)) return;
        const topNode = stack.find((element) => element.matches?.("[data-node-id]"))?.dataset.nodeId;
        const candidateNode = candidate.closest?.("[data-node-id]")?.dataset.nodeId;
        if (topNode && candidateNode && topNode !== candidateNode) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        requestAnimationFrame(() => {
          if (candidate.isConnected) candidate.click();
        });
      };
      this.pointerRecoveryHandler = recoverPointer;
      window.addEventListener("mouseup", recoverPointer, true);
      const initialQuery = this.settings.lastQuery || "1girl";
      this.setQuery(initialQuery);
      this.setStatus("正在自动加载图片…");
      this.renderPosts();
      this.renderPagination();
      this.refreshAccount(); // 异步刷新登录状态（标签上限 2/6），不阻塞初始搜索
      this.initialSearchTimer = setTimeout(() => {
        this.initialSearchTimer = null;
        // addDOMWidget 的挂载可能晚于 build()，但 root 已经是当前节点的权威界面；
        // 不以 isConnected 为条件，避免 Chrome 首次绘制较慢时直接漏掉自动搜索。
        if (this.root) this.search({ resetPage: true });
      }, 120);
      return root;
    }

    dispose() {
      _danQueryFocusTargets.delete(this);
      this.controller?.abort();
      if (this.initialSearchTimer) {
        clearTimeout(this.initialSearchTimer);
        this.initialSearchTimer = null;
      }
      this.stopGalleryBatchPolling();
      this.domSizeSync?.dispose();
      this.domSizeSync = null;
      this.filterControls?.destroy();
      this.hidePromptTooltip();
      window.removeEventListener("resize", this.positionSuggestionsHandler);
      document.removeEventListener("scroll", this.positionSuggestionsHandler, true);
      if (this.pointerRecoveryHandler) {
        window.removeEventListener("mouseup", this.pointerRecoveryHandler, true);
        this.pointerRecoveryHandler = null;
      }
      this.suggestions?.remove();
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
        ui.domWidget = domWidget;
        ui.domSizeSync = installDOMWidgetSizeSync({
          node: this,
          domWidget,
          element,
          minHeight: 360,
          maxHeight: 1200,
          initialContentHeight: ui.settings.gridHeight,
          nodeChromeHeight: 95,
          onContentHeight: (height, { commit }) => {
            ui.settings.gridHeight = height;
            if (commit) ui.saveSettings();
          },
        });
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
