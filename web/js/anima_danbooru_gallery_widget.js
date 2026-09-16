import { app } from "/scripts/app.js";
import { GalleryFilterControls, FILTER_DEFAULTS, normalizeFilters, normalizeRatings } from "./anima_danbooru_filter_controls.js";
import { installDOMWidgetSizeSync } from "./anima_dom_widget_size_sync.js";

(() => {
  const NODE_NAME = "DanbooruGallery";
  const STORAGE_KEY_PREFIX = "anima_danbooru_gallery_settings_v2:";
  const LEGACY_STORAGE_KEY = "anima_danbooru_gallery_settings_v1";
  const LEGACY_MIGRATED_KEY = `${STORAGE_KEY_PREFIX}legacy_migrated`;
  const FAVORITES_STORAGE_KEY = "anima_danbooru_gallery_favorites_v1";
  // localStorage 只适合记住浏览器偏好；工作流本身也必须带上画廊设置，
  // 否则 ComfyUI 重建节点时 node.id 尚未分配，按 id 读取会落到空设置。
  const WORKFLOW_SETTINGS_PROPERTY = "tk_danbooru_gallery_settings_v1";

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
  const FREE_METATAGS = new Set(["rating", "status", "is", "age", "date", "id", "limit", "score", "downvotes", "favcount", "width", "height", "ratio", "mpixels", "filesize", "filetype", "duration", "md5", "pixiv_id", "pixiv", "parent", "child", "upvote", "embedded", "tagcount", "order"]);
  // ⚠️ order 是 metatag（不该被当成标签记进预设备注），但它**占一个 D站 计数槽**
  // （与后端 count_restricted_search_tags 一致：order 不在后端 FREE_METATAGS 里）。
  // 历史上这两件事共用一个 Set，导致 countedSearchTerms 把 order 当免费 → 计数永不超限
  // →「自动移除排序」分支与其提示条变成死代码（tests/test_danbooru_gallery_interactions.py 长期红）。
  const FREE_METATAGS_THAT_STILL_COUNT = new Set(["order"]);
  const DANBOORU_TAG_LIMIT = 2;
  /**
   * 筛选面板独占管理的 token 前缀（顺序即用户可能手打的形态）。
   * 「筛选面板是这些 token 的唯一 owner」——搜索框里如果还留着同一份（历史写入的
   * `rating:g` / `-filetype:mp4`），拼查询词时会出现两份，白占计数槽、还会让
   * 「重试/退化」逻辑拿到一模一样的查询（实测随机发现退化重试失效的真因）。
   * order 早就有同样的规矩（normalizeTags 会丢弃搜索框里的 order:）。
   */
  const FILTER_OWNED_PREFIXES = ["rating", "age", "score", "favcount", "mpixels", "ratio", "filetype", "order", "limit", "status", "is", "date", "id"];
  const ORDER_LABELS = { score: "评分", favcount: "收藏", random: "随机", rank: "综合" };
  // 这些控件为了脱离 LiteGraph 的裁剪层而挂在 body 上；命中它们时，不能再把同一坐标
  // 下的节点按钮当成“丢失的点击”补发，否则联想项/筛选菜单/弹窗会同时点到下面的按钮。
  const PORTAL_INTERACTION_SELECTOR = ".adg-suggestions, .adg-portal-menu, .adg-dialog-overlay";
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

  // ── 多源画廊（D站 / C站 / P站）──────────────────────────────────────────────
  // 契约唯一事实源：docs/PLAN-2026-09-15-P站C站画廊接入.md §5.2 item schema / §5.3 路由 +
  // capabilities / §5.5 密钥 / §5.7 P站用途。前端**只按契约里的路由名 fetch**，不猜后端实现。
  // D站 继续走老路由 /anima/danbooru/posts（page 分页），一个字节都不改。
  const DANBOORU_SOURCE_ID = "danbooru";
  const GALLERY_SOURCE_ORDER = Object.freeze([DANBOORU_SOURCE_ID, "civitai", "pixiv"]);
  /**
   * /anima/gallery/sources 未就绪或请求失败时的兜底（另两个 agent 并行实现后端）。
   * 数值与 PLAN §5.3 钉死的 capabilities 一致：C站 tags=false / prompt=true / nsfw=true；
   * P站 tags=true / prompt=false / login=true。
   * `query` 是 2026-09-15 协调者拍板新增的第 5 键（C站 实测**上游不支持关键词检索**：
   * /api/v1/images 忽略 query/q/search/text/prompt/tag/keyword 七个参数名，
   * 后端只在已取回的那一页内做本地过滤并用 warnings 说明）→ C站 query=false。
   * **capabilities 是隐藏/禁用/提示文案的唯一依据**，不按源名硬编码判断。
   */
  const GALLERY_SOURCE_FALLBACK = Object.freeze({
    [DANBOORU_SOURCE_ID]: { id: DANBOORU_SOURCE_ID, label: "D站", capabilities: { tags: true, prompt: false, nsfw: false, login: false, query: true } },
    civitai: { id: "civitai", label: "C站", capabilities: { tags: false, prompt: true, nsfw: true, login: false, query: false } },
    pixiv: { id: "pixiv", label: "P站", capabilities: { tags: true, prompt: false, nsfw: false, login: true, query: true } },
  });
  const GALLERY_SOURCE_PLACEHOLDERS = Object.freeze({
    [DANBOORU_SOURCE_ID]: "标签（多个用空格分隔，回车直接搜）如：1girl long hair…",
    civitai: "关键词（C站仅支持按排序 / 分级浏览，关键词只在已取回的当页内过滤）",
    pixiv: "关键词（日文 / 英文均可；P站无匿名搜索，先在设置里完成授权）",
  });
  /** capabilities.query=false 的源要显式说明"搜了为什么没变"，不能静默（协调者 2026-09-15 要求）。 */
  const GALLERY_LOCAL_QUERY_HINT = "上游接口不支持关键词检索：这里的关键词只在已取回的当页内过滤，排序 / 分级才是真正的浏览条件。";
  /** 工具栏里的短版（完整说明挂 title，别让一行提示把工具条撑成两行） */
  const GALLERY_LOCAL_QUERY_HINT_SHORT = "关键词只在当页内过滤";
  /** 同上，搜索框占位文案 —— 按能力分支，**不按源名硬编码** */
  const GALLERY_LOCAL_QUERY_PLACEHOLDER = "关键词（上游不支持检索：只在已取回的当页内过滤）";
  /** C站 search 的参数值域（契约：查询参数由各源自定义，前端按源给控件） */
  const CIVITAI_NSFW_OPTIONS = Object.freeze([
    ["", "不限"],
    ["None", "None（安全）"],
    ["Soft", "Soft"],
    ["Mature", "Mature"],
    ["X", "X"],
  ]);
  /**
   * C站 sort 的合法值**只有**这六个（PLAN §6 实测：`Relevance`/`Most Recent` 之类会 400
   * ZodError；后端也会先本地校验再回中文 400）—— 前端下拉不能给出非法值。
   */
  const CIVITAI_SORT_OPTIONS = Object.freeze([
    ["Newest", "最新"],
    ["Oldest", "最早"],
    ["Most Reactions", "点赞最多"],
    ["Most Comments", "评论最多"],
    ["Most Collected", "收藏最多"],
    ["Random", "随机"],
  ]);
  const PIXIV_TARGET_OPTIONS = Object.freeze([
    ["partial_match_for_tags", "标签部分匹配"],
    ["exact_match_for_tags", "标签精确匹配"],
    ["title_and_caption", "标题与说明"],
  ]);
  const PIXIV_SORT_OPTIONS = Object.freeze([
    ["date_desc", "最新"],
    ["date_asc", "最早"],
    ["popular_desc", "人气顺（需 Pixiv 会员）"],
  ]);

  function normalizeSourceFilters(saved) {
    const source = saved && typeof saved === "object" ? saved : {};
    const civitai = source.civitai && typeof source.civitai === "object" ? source.civitai : {};
    const pixiv = source.pixiv && typeof source.pixiv === "object" ? source.pixiv : {};
    const pick = (options, value, fallback) => (options.some(([id]) => id === String(value)) ? String(value) : fallback);
    return {
      civitai: {
        nsfw: pick(CIVITAI_NSFW_OPTIONS, civitai.nsfw, ""),
        sort: pick(CIVITAI_SORT_OPTIONS, civitai.sort, "Newest"),
      },
      pixiv: {
        target: pick(PIXIV_TARGET_OPTIONS, pixiv.target, "partial_match_for_tags"),
        sort: pick(PIXIV_SORT_OPTIONS, pixiv.sort, "date_desc"),
      },
    };
  }

  /** 每个图源各自的搜索框内容 —— D站 标签语法与 C站/P站 关键词不该互相污染 */
  function normalizeSourceQueries(saved) {
    const source = saved && typeof saved === "object" ? saved : {};
    const out = {};
    for (const id of GALLERY_SOURCE_ORDER) out[id] = typeof source[id] === "string" ? source[id] : "";
    return out;
  }

  /** 内联 SVG 图标（项目 UI 规范：禁 emoji；24×24、stroke=currentColor） */
  const GALLERY_ICON_PATHS = Object.freeze({
    image: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M11 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0z", "m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"],
    key: ["M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z", "M16.5 7.5h.01"],
    link: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
    check: ["M20 6 9 17l-5-5"],
  });

  function galleryIcon(name, size = 14, className = "adg-icon") {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);
    for (const d of GALLERY_ICON_PATHS[name] || []) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  /** 文件名/扩展名：P站 original 多为 .jpg/.png，C站是 .jpeg；拿不到就退回 jpg */
  function galleryFileExt(url, fallback = "jpg") {
    const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url || "").split("?")[0]);
    return match ? match[1].toLowerCase() : fallback;
  }

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

  // 搜索预设备注只取真正的 Danbooru 标签；rating/order/score 等筛选元数据
  // 已经会在预设本身保存，不应被翻译成备注中的“标签”。
  function presetTagParts(query) {
    return String(query || "").split(/\s+/).map((raw) => raw.trim()).filter(Boolean).map((raw) => {
      const sign = /^[~-]/.test(raw) ? raw[0] : "";
      const tag = raw.replace(/^[~-]+/, "");
      const colon = tag.indexOf(":");
      if (!tag || tag === "or" || tag === "(" || tag === ")" || (colon > 0 && FREE_METATAGS.has(tag.slice(0, colon).toLowerCase()))) {
        return null;
      }
      return { tag, sign };
    }).filter(Boolean);
  }

  function normalizePreset(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      name: String(source.name || "").trim(),
      query: String(source.query || "").trim(),
      note: String(source.note || source.description || "").trim().slice(0, 240),
      rating: normalizeRatings(source.rating),
      filters: normalizeFilters(source.filters),
    };
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

  /**
   * 清掉搜索框里由筛选面板管理的 token（rating/age/score/filetype/... 含 `-` 否定前缀）。
   * 筛选面板是这些 token 的唯一 owner：搜索框里残留的那份会被 currentQuery 再拼一次，
   * 既多占计数槽，又会让「退化重试」拿到与上次完全相同的查询而形同没重试。
   */
  function stripFilterOwnedTokens(rawValue) {
    const tokens = String(rawValue ?? "").trim().split(/\s+/).filter(Boolean);
    return tokens.filter((token) => {
      const body = token.replace(/^[-~]+/, "").toLowerCase();
      const colon = body.indexOf(":");
      if (colon < 0) return true;
      return !FILTER_OWNED_PREFIXES.includes(body.slice(0, colon));
    }).join(" ");
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
      if (colon < 0) return true;
      const prefix = token.slice(0, colon);
      // order 虽然是 metatag，但在 D站 侧照样占一个计数槽（见 FREE_METATAGS_THAT_STILL_COUNT 注释）。
      if (FREE_METATAGS_THAT_STILL_COUNT.has(prefix)) return true;
      return !FREE_METATAGS.has(prefix);
    }).length;
  }

  // ---------- 真·瀑布流布局（列填充 + 超宽图跨列），移植自面板 Outputs 的 masonry 算法 ----------
  // 与旧实现的区别：旧实现靠 CSS Grid 的 grid-row-end:span，卡片宽度恒等于列宽、
  // 且同一行里各卡高度不一致会留下成片空白；这里改为**逐张放进当前最矮的列**，
  // 并允许超宽图横跨 2~3 列（盒子更宽同时更矮），横向留白与竖向缝隙都被吃掉。
  const DG_GAP = 7;
  /** 列宽上下限（pt）：下限保证小节点仍能看清缩略图，上限避免大节点出现巨图 */
  const DG_MIN_PT = 116;
  const DG_MAX_PT = 330;
  /** 竖图盒比上限（h/w）：超过按上限截断，渲染层用 object-fit:contain 完整嵌入 */
  const DG_CLAMP_MAX_ASPECT = 2.2;
  /** 盒比（h/w）≤ 此值 → 跨 2 列；≤ 再下一档 → 跨 3 列 */
  const DG_SPAN2_MAX_ASPECT = 0.45;
  const DG_SPAN3_MAX_ASPECT = 0.25;
  /** 无宽高数据的旧记录按 3:4 竖图兜底（N站/D站绝大多数是竖图） */
  const DG_FALLBACK_ASPECT = 0.75;
  /** 单次 D站 请求上限（后端 MAX_PAGE_SIZE=48） */
  const DG_MAX_PER_REQUEST = 48;
  /** 自适应模式的显示张数下限（节点很小时也不要只剩两三张） */
  const DG_MIN_AUTO_COUNT = 12;
  /** 每卡「最小屏幕高」分档：卡片不要太扁也不要太高 */
  const DG_MIN_CARD_H = 96;
  /**
   * 「这批填不满可视区」的判据（内容总高 < 视口高 × 此比例）。
   * 2026-09-15 用户真机反馈：「画廊底部拖拽但是没有加载新的图片挤进来」
   * —— 纵向拉大不改变列数，旧的 handleGridResize 只在列数变化时重取，所以永远不补图。
   */
  const DG_UNDERFILL_RATIO = 0.9;
  // 渲染后「补到填满」的连续轮次上限：图源池子取空时会自然停（fillMoreExhausted），
  // 这个上限是第二道闸，防的是「判据始终差一点」导致的无限打接口。
  // 2026-09-16 从 6 收到 3：用户实测「会莫名放大特别多」—— 补图轮次越多，越容易
  // 把节点撑大（见 autoFillIfUnderfilled 里关于正反馈的注释）。
  // 渲染后「补到填满」的连续轮次上限。
  // 2026-09-16 用户实测「在无限变大，扩充完图片之后又触发扩充，一直扩充」→ 定为 **1**：
  // 渲染后最多自动补一批（够补上首屏差的那点），再多必须由用户主动拉大节点触发。
  // 配合下面的时间窗限流，即使还有未预料的触发路径也滚不起来。
  const DG_AUTO_FILL_MAX_ROUNDS = 1;
  // ③ 时间窗限流（**不受任何重置影响**的最后一道闸，见 autoFillIfUnderfilled）：
  //    列数变化会走 handleGridResize → search(resetPage) → autoFillRounds 归零，
  //    单靠轮次上限拦不住「补图撑大节点 → 列数变化 → 重置 → 再补」的无限循环。
  const DG_AUTO_FILL_WINDOW_MS = 30000;
  const DG_AUTO_FILL_MAX_PER_WINDOW = 4;
  // 用户刚动过节点尺寸后的「冷静期」：这段时间内一律不补图。
  // 否则补图会和用户的手对着干 —— 拖动过程里判定"不满"就补，补完又改尺寸，
  // 用户看到的就是「一缩小就放大多次」（2026-09-16 真机实测）。
  const DG_USER_RESIZE_GRACE_MS = 1500;
  /** 「高度显著增大」的阈值：至少 +120px 且 ≥15%，与 450ms 防抖一起挡住拖拽抖动 */
  const DG_TALLER_MIN_DELTA = 120;
  const DG_TALLER_MIN_RATIO = 1.15;

  // ---------- 随机发现（产品向）----------
  // 裸 order:random 是「全库随机」，实测返回的多是无人点赞的冷门帖（score 个位数、有没有人贴都不知道），
  // 正是用户说的「不要冷门没贴的」。这里给随机加**质量地板**：随机池 = 满足分数/收藏门槛的帖子。
  // ⚠️ 刻意**不加时间窗**（age:<Ndays）：实测 `miku_day score:>100 age:<30days order:random` = 0 结果，
  // 而 `miku_day score:>100 order:random` = 31 结果 —— 时间窗会把随机池掐死。
  // 后端本来就有兜底：慢排序在全库超时时自动降级附加 age:<1week 重试并回报 warning。
  const RANDOM_QUALITY_TIERS = Object.freeze([
    { id: "hot", label: "热门随机", hint: "评分 ≥100 · 随机", minScore: "100", minFavs: "" },
    { id: "good", label: "优质随机", hint: "评分 ≥50 · 随机", minScore: "50", minFavs: "" },
    { id: "popular", label: "高收藏随机", hint: "收藏 ≥30 · 随机", minScore: "", minFavs: "30" },
  ]);
  const RANDOM_HISTORY_MAX = 240;

  /** 一张卡要跨几列（受总列数限制） */
  function dgSpanFor(aspect, cols) {
    if (cols < 2) return 1;
    if (aspect <= DG_SPAN3_MAX_ASPECT && cols >= 3) return 3;
    // ⚠️ 必须夹到 cols：首次布局时容器宽度可能还没稳定（clientWidth=0 → usable=DG_MIN_PT
    // → cols=1），此时横图若返回 2，下面的「找起点」循环一次都不执行、top 停在 Infinity，
    // 卡片被甩到看不见的地方且**不会自我恢复**（只有 resize 重排才回来）
    // —— 用户 2026-09-16 实测："图片在抖动，要我手动改变一次节点大小才恢复正常"。
    if (aspect <= DG_SPAN2_MAX_ASPECT) return Math.min(2, cols);
    return 1;
  }

  /** 新增结果里是否含计数标签（用于给卡片加类别色条；失败时静默返回空串） */
  function dgCardCategoryClass(post) {
    const raw = String(post?.tag_string_category || "");
    if (!raw) return "";
    for (const part of raw.split(" ")) {
      const name = part.split(":")[0];
      if (PROMPT_CATEGORY_ORDER.includes(name) && name !== "meta") return `is-${name}`;
    }
    return "";
  }

  /** 自适应模式：由容器几何算出「刚好填满」的图片数量（cols/usable 由调用方一次算好传入） */
  function dgComputeAutoCount(grid, metrics, measuredCardH = 0) {
    if (!grid) return 24;
    const rect = grid.getBoundingClientRect();
    const height = grid.clientHeight || rect.height || 620;
    const { cols, cardWidth } = metrics || { cols: 3, cardWidth: 240 };
    // 优先用「上一次实际渲染出来的平均卡高」：混排里横图占多数时，按 DG_FALLBACK_ASPECT
    // (0.75，偏竖图) 猜出来的卡高会明显偏大 → 行数算少 → 张数算少 → 首屏就填不满。
    const cardH = measuredCardH > 0
      ? Math.max(DG_MIN_CARD_H, measuredCardH + DG_GAP)
      : Math.max(DG_MIN_CARD_H, cardWidth / DG_FALLBACK_ASPECT);
    const rows = Math.max(2, Math.ceil((height + DG_GAP) / (cardH + DG_GAP)));
    const count = Math.round(cols * (rows + 1));
    return Math.max(DG_MIN_AUTO_COUNT, Math.min(DG_MAX_PER_REQUEST, count));
  }

  function normalizeGallerySettings(saved) {
    const source = saved && typeof saved === "object" ? saved : {};
    return {
      // limit: 0 = 自适应（按节点尺寸算该显示几张，恰好填满不留空白）；12/24/48 = 固定张数
      limit: [0, 12, 24, 48].includes(source.limit) ? source.limit : 0,
      rating: normalizeRatings(source.rating),
      gridHeight: Number.isFinite(source.gridHeight) ? Math.max(360, Math.min(1200, source.gridHeight)) : 620,
      categories: Array.isArray(source.categories) ? source.categories : [],
      postCategories: source.postCategories && typeof source.postCategories === "object" ? source.postCategories : {},
      presets: Array.isArray(source.presets) ? source.presets.map(normalizePreset).filter((preset) => preset.name) : [],
      activeCategory: typeof source.activeCategory === "string" ? source.activeCategory : "",
      filters: normalizeFilters(source.filters),
      excludeTags: Array.isArray(source.excludeTags) ? [...new Set(source.excludeTags.map(normalizeExcludeTag).filter(Boolean))].slice(0, 8) : [],
      promptOutput: normalizePromptOutputSettings(source.promptOutput),
      promptOutputEnabled: source.promptOutputEnabled !== false,
      promptExcludePattern: typeof source.promptExcludePattern === "string" ? source.promptExcludePattern.slice(0, 500) : "",
      // 随机发现档位（""=未启用；hot/good/fresh 见 RANDOM_QUALITY_TIERS）
      randomQuality: RANDOM_QUALITY_TIERS.some((t) => t.id === source.randomQuality) ? source.randomQuality : "",
      lastQuery: typeof source.lastQuery === "string" ? source.lastQuery : "",
      // 多源画廊：当前图源 + 各源自己的筛选 + 各源各自的搜索框内容。
      // 注意 D站 的筛选仍住在 filters/rating 里（老工作流恢复后不变），这里只放新源的东西。
      source: GALLERY_SOURCE_ORDER.includes(source.source) ? source.source : DANBOORU_SOURCE_ID,
      sourceFilters: normalizeSourceFilters(source.sourceFilters),
      sourceQueries: normalizeSourceQueries(source.sourceQueries),
    };
  }

  function parseGallerySettings(raw) {
    if (!raw) return null;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === "object" ? normalizeGallerySettings(parsed) : null;
    } catch {
      return null;
    }
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
      return parseGallerySettings(raw) || normalizeGallerySettings({});
    } catch {
      return normalizeGallerySettings({});
    }
  }

  class DanbooruGalleryUI {
    constructor(node) {
      this.node = node;
      this.settings = loadSettings(node.id);
      this._settingsNodeId = String(node.id ?? "");
      this.node.properties = this.node.properties || {};
      if (this.node.properties[WORKFLOW_SETTINGS_PROPERTY] == null) {
        this.node.properties[WORKFLOW_SETTINGS_PROPERTY] = JSON.stringify(this.settings);
      }
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
      this.presetNoteHydration = null;
      this.tooltip = null;
      this.domWidget = null;
      this.domSizeSync = null;
      this.pointerRecoveryHandler = null;
      this.filterControls = null;
      this.promptEdits = new Map();
      this.imageLoadObserver = null;
      this.gridResizeObserver = null;
      this.masonryLayoutFrame = null;
      this.lastCols = 0;            // 上次布局的列数（列数变化 → 自适应模式重取一页）
      this.lastColStep = 0;         // 上次布局的列步长（列宽+间距），用于抵消滚动条造成的宽度抖动
      this.resizeSearchTimer = null;
      // 纵向拉大 → 补图（2026-09-15 用户："画廊底部拖拽但是没有加载新的图片挤进来"）
      this.lastVisibleHeight = 0;   // 上次网格可视高度（判「高度显著增大」）
      this.fillMoreBusy = false;    // 补图请求在途：同一时刻只允许一次
      this.fillMoreExhausted = false; // 到底了（末页/末批/全是重复）→ 不再打接口
      // 渲染后自动补满（2026-09-16 用户真机反馈："还是填充不满节点，用一半以上的空位"）：
      // 首屏 / 翻页 / 换源 渲染完就先检查一次「填满没有」，不再只等用户纵向拉大节点。
      this.autoFillTimer = null;
      this.autoFillRounds = 0;       // 本轮结果集内已自动补了几次（上限 DG_AUTO_FILL_MAX_ROUNDS）
      // 补图的目标可视高：**一经确定就在本轮结果集内锁死**。
      // 为什么不每轮重读 grid.clientHeight：新前端布局器会按 DOM 内容把节点撑高，
      // 于是「补图 → 内容变高 → 节点变高 → 视口更大 → 更显不满 → 再补」成正反馈
      // （用户 2026-09-16 真机反馈："会莫名放大特别多，而且缩小节点还会自己变回去"）。
      this._autoFillTarget = 0;
      this._autoFillWindowAt = 0;    // 限流窗口起点
      this._autoFillWindowCount = 0; // 本窗口内已补几次
      this._layoutMinCol = 0;        // 最矮列高度：判「填满」用它，比最高列更贴近肉眼
      this._measuredAvgCardH = 0;    // 实测平均卡高：下次估算张数用，替代按 fallback 比例猜
      // 尺寸收缩防护（2026-09-15）：自动收缩会与「滚动条出现/消失 → 列数变化 → 卡片高度变化」
      // 互相触发，一轮轮把节点缩小（用户："老是自己慢慢变小"）；而用户手动放大后又会立刻被
      // 缩回去（用户："放回大小后就不填充满"）。用两个时间戳断开这个循环。
      this.programmaticResizeAt = 0;   // 我们自己改尺寸的时刻
      this.userResizedAt = 0;          // 用户手动调过尺寸的时刻（本次结果集内不再自动收缩）
      this.shrunkTotal = null;         // 已为哪个内容高度缩过（同一内容不重复缩）
      this._layoutTotal = 0;
      this._layoutPosts = null;
      this.failedImageCount = 0;
      this.renderedPostCount = 0;
      this._randomTrimmed = false;
      this._randomPoolExhausted = false;
      this.randomTierButtons = null; // 由工具条注入：随机档位按钮的状态刷新回调
      this.randomHistory = new Map(); // query → 已看过的 post id（随机发现去重，避免翻来覆去同几张）
      this.registered = false; // 是否已登录 Danbooru
      this.tagLimitValue = 2;  // 计数标签上限（后端按账号等级动态：Member=2 / Gold+=6，随 /account 刷新）
      this.accountReady = null; // 首次搜索必须等待登录状态/标签上限同步完成
      this.disposed = false;
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
      // ── 多源画廊 ──
      this.gallerySources = null;      // /anima/gallery/sources 覆盖兜底表后的结果
      this.gallerySourcesReady = null; // 首次拉取能力的 Promise（搜索/渲染等它一次）
      this.cursorStack = [""];         // C站/P站 cursor 分页：栈顶 = 当前批次（""=首批）
      this.nextCursor = null;          // 回包 next_cursor（null = 没有下一批）
      this.sourceSelect = null;
      this.sourcePicker = null;
      this.queryRow = null;
      this.sourceFilterHost = null;    // 源专属筛选容器（不是 .adg-toolbar-group，别动分组计数）
      this.sourceFilterControls = null;
      this.filterGroup = null;
      this.categoryGroup = null;
      this.randomTierButtonList = null;
      this.randomReshuffleBtn = null;
      this.promptSettingsBtn = null;
      this.gallerySecretState = null;
    }

    // ──────────────────────────── 多源画廊（D站 / C站 / P站）────────────────────────────
    // 契约见 PLAN §5.3。**D站 的取数/分页/筛选全部走下面的老实现**，这里只服务新图源。

    isDanbooruSource() {
      return this.activeSourceId() === DANBOORU_SOURCE_ID;
    }

    activeSourceId() {
      const id = String(this.settings?.source || "");
      return GALLERY_SOURCE_ORDER.includes(id) ? id : DANBOORU_SOURCE_ID;
    }

    sourceEntry(sourceId = null) {
      const id = String(sourceId || this.activeSourceId());
      const fromBackend = this.gallerySources?.get?.(id);
      return fromBackend || GALLERY_SOURCE_FALLBACK[id] || GALLERY_SOURCE_FALLBACK[DANBOORU_SOURCE_ID];
    }

    sourceLabel(sourceId = null) {
      return String(this.sourceEntry(sourceId)?.label || sourceId || "");
    }

    /** capabilities 是隐藏/禁用控件的**唯一依据**（PLAN §5.3 + `query` 第 5 键）；缺字段一律按 false 处理 */
    sourceCapabilities(sourceId = null) {
      const caps = this.sourceEntry(sourceId)?.capabilities || {};
      return {
        tags: caps.tags === true,
        prompt: caps.prompt === true,
        nsfw: caps.nsfw === true,
        login: caps.login === true,
        // query 缺省按 true：搜索框是主要输入，后端没声明时不该因为缺字段就退回"本页过滤"文案
        query: caps.query !== false,
      };
    }

    /**
     * 读 /anima/gallery/sources（能力表）。后端未就绪 / 请求失败 → 保留兜底表，
     * 界面照常可用（D站 一定在，新源按契约的固定值显示）。
     */
    async loadGallerySources() {
      if (this.gallerySourcesReady) return this.gallerySourcesReady;
      const task = (async () => {
        try {
          const response = await fetch("/anima/gallery/sources");
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          const list = Array.isArray(data?.sources) ? data.sources : [];
          const map = new Map();
          for (const id of GALLERY_SOURCE_ORDER) map.set(id, GALLERY_SOURCE_FALLBACK[id]);
          for (const row of list) {
            const id = String(row?.id || "").trim();
            if (!GALLERY_SOURCE_ORDER.includes(id)) continue;
            map.set(id, {
              id,
              label: String(row?.label || GALLERY_SOURCE_FALLBACK[id].label),
              capabilities: { ...GALLERY_SOURCE_FALLBACK[id].capabilities, ...(row?.capabilities || {}) },
            });
          }
          this.gallerySources = map;
        } catch {
          this.gallerySources = this.gallerySources || null;
        }
        return this.gallerySources;
      })();
      this.gallerySourcesReady = task;
      return task;
    }

    /** 画廊源的搜索词：原样透传用户输入（不做 D站 的 normalizeTags/截断/小写化） */
    gallerySourceQuery() {
      return String(this.queryWidget?.value ?? this.settings.lastQuery ?? "").trim();
    }

    gallerySourceFilters(sourceId = null) {
      const id = String(sourceId || this.activeSourceId());
      const all = this.settings.sourceFilters || (this.settings.sourceFilters = normalizeSourceFilters({}));
      if (!all[id]) all[id] = normalizeSourceFilters({})[id] || {};
      return all[id];
    }

    /**
     * C站/P站 的查询参数。分页**只用 cursor**（契约钉死：参数名 cursor、回包字段 next_cursor）。
     * ⚠️ 查询参数名契约里写的是"由各源自定义"，PLAN §3 阶段1/2 分别写了 `query=` 与 `word=`，
     *    这里按文档发主名，同时附带 `query` 作为别名（FastAPI 会忽略未声明的查询参数），
     *    以免两边命名分歧导致"点了搜索没反应"。
     */
    gallerySearchParams(sourceId, query) {
      const params = new URLSearchParams();
      params.set("cursor", String(this.cursorStack[this.cursorStack.length - 1] ?? ""));
      params.set("limit", String(this.resolveLimit()));
      if (sourceId === "pixiv") {
        params.set("word", query);
        params.set("query", query);
        const f = this.gallerySourceFilters(sourceId);
        params.set("target", String(f.target || "partial_match_for_tags"));
        params.set("sort", String(f.sort || "date_desc"));
      } else {
        params.set("query", query);
        const f = this.gallerySourceFilters(sourceId);
        if (f.nsfw) params.set("nsfw", String(f.nsfw));
        params.set("sort", String(f.sort || "Newest"));
      }
      return params;
    }

    readGalleryResponse(response) {
      return response.json().catch(() => null);
    }

    resetGalleryCursor() {
      this.cursorStack = [""];
      this.nextCursor = null;
    }

    /** 统一 item schema（PLAN §5.2）→ 内部 post 形状（渲染/预览/下载链路一条都不用分叉） */
    galleryItemToPost(item, sourceId) {
      const id = item?.id == null ? "" : String(item.id);
      const full = String(item?.full_url || item?.preview_url || "");
      const preview = String(item?.preview_url || full || "");
      const tags = Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [];
      const width = Number(item?.width);
      const height = Number(item?.height);
      return {
        id,
        source: sourceId,
        // D站 帖子字段名复用：renderPosts / buildPromptForPost / selectionFromCard 都不必知道图源
        preview_file_url: preview,
        large_file_url: full,
        file_url: full,
        full_url: full,
        preview_url: preview,
        image_width: Number.isFinite(width) && width > 0 ? width : 0,
        image_height: Number.isFinite(height) && height > 0 ? height : 0,
        file_ext: galleryFileExt(full || preview),
        rating: item?.rating == null ? "" : String(item.rating),
        score: item?.score == null ? null : Number(item.score),
        fav_count: item?.meta?.fav_count ?? item?.meta?.bookmarks ?? null,
        tag_string: tags.join(" "),
        tags,
        prompt: item?.prompt == null ? "" : String(item.prompt),
        negative_prompt: item?.negative_prompt == null ? "" : String(item.negative_prompt),
        source_url: item?.source_url == null ? "" : String(item.source_url),
        meta: item?.meta && typeof item.meta === "object" ? item.meta : {},
      };
    }

    /**
     * C站 / P站 搜索。与 D站 的差别只有三处：路由（/anima/gallery/{source}/search）、
     * 分页（cursor + next_cursor）、以及没有 D站 的计数标签上限。
     */
    async searchGallerySource({ resetPage = false, retryCount = 0 } = {}) {
      const sourceId = this.activeSourceId();
      const caps = this.sourceCapabilities(sourceId);
      const query = this.gallerySourceQuery();
      if (this.settings.activeCategory) {
        this.settings.activeCategory = "";
        this.saveSettings();
        this.filterControls?.refresh();
      }
      if (resetPage) this.resetGalleryCursor();
      // 新一批搜索（cursor 归零）＝ 新结果集 → 重新允许「拉大补图」与「自动补满」
      if (resetPage) {
        this.fillMoreExhausted = false;
        this.autoFillRounds = 0;
        this._autoFillTarget = 0;   // 新结果集 = 新目标，重新按当前尺寸评估
      }
      this.settings.sourceQueries[sourceId] = query;
      this.settings.lastQuery = query;
      this.saveSettings();
      this.setQuery(query);
      if (!query && sourceId === "pixiv") {
        // Pixiv 搜索必须有词（契约只有 search/illust，没有匿名兜底列表）→ 明确提示，
        // 而不是发一个必然失败的请求。
        this.posts = [];
        this.renderPosts();
        this.renderPagination();
        this.setStatus("P站：请输入关键词后回车搜索（日文 / 英文均可）");
        return;
      }
      this.controller?.abort();
      this.controller = new AbortController();
      const requestController = this.controller;
      const currentRequest = ++this.requestId;
      let timedOut = false;
      this.setStatus(`正在搜索：${query || "（最新）"} · ${this.sourceLabel(sourceId)}`);
      if (this.grid) this.grid.setAttribute("aria-busy", "true");
      try {
        const parameters = this.gallerySearchParams(sourceId, query);
        const timer = setTimeout(() => { timedOut = true; requestController.abort(); }, 45000);
        let response, data;
        try {
          response = await fetch(`/anima/gallery/${encodeURIComponent(sourceId)}/search?${parameters}`, { signal: requestController.signal });
          data = await this.readGalleryResponse(response);
        } finally {
          clearTimeout(timer);
        }
        if (currentRequest !== this.requestId) return;
        if (!response.ok) {
          const error = new Error(data?.error || `HTTP ${response.status}`);
          error.name = "GallerySearchHTTPError";
          error.httpStatus = response.status;
          throw error;
        }
        const items = Array.isArray(data?.items) ? data.items : [];
        this.nextCursor = data?.next_cursor == null || data.next_cursor === "" ? null : String(data.next_cursor);
        this.posts = items
          .map((item) => this.galleryItemToPost(item, sourceId))
          .filter((post) => post.preview_file_url || post.large_file_url);
        // 排除标签是本地按 Danbooru tag_string 过滤的（无标签体系时没有意义，控件在设置里已禁用）
        const excludeTags = caps.tags ? (this.settings.excludeTags || []) : [];
        let excludedCount = 0;
        if (excludeTags.length) {
          const tagSet = new Set(excludeTags);
          const before = this.posts.length;
          this.posts = this.posts.filter((post) => !String(post.tag_string || "").split(" ").some((tag) => tagSet.has(tag)));
          excludedCount = before - this.posts.length;
        }
        this.renderPosts();
        this.renderPagination();
        const batch = this.cursorStack.length;
        // 后端的 warnings（契约允许的可选键）**必须让用户看见** —— 例如 C站 不支持关键词检索时
        // 后端会在这一页内本地过滤并回报"关键词未生效"；不说的话用户以为搜了却没反应（静默错误）。
        const warnings = Array.isArray(data?.warnings) ? data.warnings.map((w) => String(w || "").trim()).filter(Boolean) : [];
        const notices = [...warnings];
        if (excludedCount) notices.push(`已排除 ${excludedCount} 张（${excludeTags.join("、")}）`);
        if (items.length > this.posts.length + excludedCount) notices.push(`${items.length - this.posts.length - excludedCount} 张缺图已跳过`);
        if (!this.nextCursor) notices.push("已到末页");
        if (caps.login && sourceId === "pixiv") notices.push("P站标签与 Danbooru 词库不通用");
        if (caps.prompt === false && sourceId === "pixiv") notices.push("P站无提示词，可下载原图喂 WD14 反推");
        this.setStatus(`${this.sourceLabel(sourceId)}：${this.posts.length} 张 · 第 ${batch} 批` + (notices.length ? `（${notices.join("；")}）` : ""));
        // 空结果 + 有警告时，网格里也写一格：状态栏那一行很容易被忽略
        if (!this.posts.length && warnings.length) this.appendGridNotice(warnings.join("；"));
      } catch (error) {
        if (timedOut) {
          this.posts = [];
          this.renderPosts();
          this.setStatus("搜索超时（45 秒）：图源或代理网络不稳定，请检查 Clash 节点后重试", "error");
          return;
        }
        if (error?.name === "AbortError") return;
        if (currentRequest !== this.requestId) return;
        const retryable = error?.name === "TypeError" || [502, 503, 504].includes(Number(error?.httpStatus));
        if (retryable && retryCount < 2) {
          const attempt = retryCount + 1;
          this.setStatus(`首次搜索响应异常，正在自动重试（${attempt}/2）…`);
          await new Promise((resolve) => setTimeout(resolve, 250 + retryCount * 500));
          if (currentRequest !== this.requestId) return;
          return this.searchGallerySource({ resetPage: false, retryCount: attempt });
        }
        this.posts = [];
        this.renderPosts();
        this.renderPagination();
        this.setStatus(`${this.sourceLabel(sourceId)} 搜索失败：${error?.message || "未知错误"}`, "error");
      } finally {
        if (currentRequest === this.requestId && this.grid) this.grid.removeAttribute("aria-busy");
      }
    }

    /** cursor 分页：前进压栈（next_cursor），后退弹栈后重查 —— 契约只有 next_cursor，没有 prev */
    async stepGalleryCursor(delta) {
      if (delta > 0) {
        if (!this.nextCursor) return;
        this.cursorStack.push(this.nextCursor);
      } else {
        if (this.cursorStack.length <= 1) return;
        this.cursorStack.pop();
      }
      await this.searchGallerySource({ resetPage: false });
    }

    async switchGallerySource(nextId) {
      const id = String(nextId || "");
      if (!GALLERY_SOURCE_ORDER.includes(id) || id === this.activeSourceId()) return;
      const previous = this.activeSourceId();
      this.settings.sourceQueries[previous] = this.gallerySourceQuery();
      this.settings.source = id;
      // 本地分类浏览是 D站 的实现（按 id: 回查 D站 帖子），换源时退出该模式，
      // 否则新源会带着一个永远匹配不上的分类过滤。
      this.settings.activeCategory = "";
      this.saveSettings();
      this.resetGalleryCursor();
      this.page = 1;
      this.posts = [];
      this.hidePromptTooltip();
      this.hideSuggestions();
      this.applySourceCapabilities();
      this.filterControls?.refresh();
      const restored = String(this.settings.sourceQueries[id] || "");
      this.setQuery(restored);
      this.renderPosts();
      this.renderPagination();
      this.setStatus(`已切换到${this.sourceLabel(id)}${this.sourceCapabilities(id).login ? "（需要授权，见设置→图源密钥）" : ""}`);
      // P站 后端模块没装时不发这个必然失败的请求（状态来自 /anima/gallery/secrets 的 pixiv.available）
      if (id === "pixiv" && this.gallerySecretState?.pixiv?.available === false) {
        this.setStatus("P站 后端模块未安装（anima_gallery_pixiv.py）—— 该图源不可用，请用 C站 或 D站", "error");
        return;
      }
      await this.search({ resetPage: true });
    }

    /**
     * 用 capabilities 驱动界面：**不适用的控件直接隐藏/禁用**，不留"点了没反应"的开关
     * （项目 UI 规范：控件噪音也是失败）。D站 全功能，所以下面每条对 D站 都是空操作。
     */
    applySourceCapabilities() {
      const sourceId = this.activeSourceId();
      const caps = this.sourceCapabilities(sourceId);
      const isDanbooru = sourceId === DANBOORU_SOURCE_ID;
      if (this.sourceSelect && this.sourceSelect.value !== sourceId) this.sourceSelect.value = sourceId;
      if (this.queryInput) {
        // 搜索框文案按 capabilities.query 走（不按源名硬编码）：
        // C站 实测上游 /api/v1/images 忽略全部关键词参数，只能"本页过滤"→ 必须说清楚。
        this.queryInput.placeholder = caps.query
          ? (GALLERY_SOURCE_PLACEHOLDERS[sourceId] || GALLERY_SOURCE_PLACEHOLDERS[DANBOORU_SOURCE_ID])
          : GALLERY_LOCAL_QUERY_PLACEHOLDER;
        this.queryInput.title = caps.query ? "" : GALLERY_LOCAL_QUERY_HINT;
        this.queryInput.dataset.queryMode = caps.query ? "server" : "local";
      }
      if (this.queryRow) this.queryRow.dataset.queryMode = caps.query ? "server" : "local";
      if (this.sourcePicker) this.sourcePicker.dataset.source = sourceId;
      // ① D站 的「分级 / 筛选」全是 Danbooru metatag（rating:/score:/age:/favcount:…），
      //    只有 D站 能消费它们 —— capabilities.tags 说的是"这个源有没有标签体系"，
      //    而 P站 的 tags=true 是**日文**标签，照样吃不下 rating:/score:，
      //    所以这里判的是 isDanbooru（否则 P站 会留着两个点了没反应的筛选下拉）。
      const tagFiltersApplicable = isDanbooru && caps.tags;
      if (this.filterControls) {
        this.filterControls.ratingDropdown.element.hidden = !tagFiltersApplicable;
        this.filterControls.filterDropdown.element.hidden = !tagFiltersApplicable;
        // ② 分类浏览器按 `id:` 回查 D站 帖子 → 只有 D站 有意义（本地归类按钮仍可用）
        this.filterControls.categoryDropdown.element.hidden = !isDanbooru;
      }
      // ③ 随机发现是 order:random + D站 评分地板，纯 D站 语义
      for (const button of this.randomTierButtonList || []) button.hidden = !isDanbooru;
      if (this.randomReshuffleBtn) this.randomReshuffleBtn.hidden = !isDanbooru;
      // ④ 提示词相关控件跟着 capabilities.prompt（P站 prompt=false → 隐藏，不留死按钮）
      const promptApplicable = caps.prompt || isDanbooru;
      if (this.promptSettingsBtn) this.promptSettingsBtn.hidden = !promptApplicable;
      if (this.promptOutputBtn) this.promptOutputBtn.hidden = !promptApplicable;
      if (this.sourceFilterHost) {
        this.sourceFilterHost.hidden = isDanbooru;
        this.syncSourceFilterControls();
      }
    }

    /** 源专属筛选控件（C站：nsfw/排序；P站：匹配方式/排序） */
    buildSourceFilterControls() {
      const host = document.createElement("div");
      host.className = "adg-source-filters";
      host.setAttribute("role", "group");
      host.setAttribute("aria-label", "图源筛选");
      host.hidden = true;
      const makeSelect = (label, options) => {
        const wrap = document.createElement("label");
        wrap.className = "adg-source-field";
        const text = document.createElement("span");
        text.textContent = label;
        const select = document.createElement("select");
        select.setAttribute("aria-label", label);
        for (const [value, name] of options) select.append(new Option(name, value));
        wrap.append(text, select);
        host.append(wrap);
        return select;
      };
      const civitaiNsfw = makeSelect("分级", CIVITAI_NSFW_OPTIONS);
      const civitaiSort = makeSelect("排序", CIVITAI_SORT_OPTIONS);
      const pixivTarget = makeSelect("匹配", PIXIV_TARGET_OPTIONS);
      const pixivSort = makeSelect("排序", PIXIV_SORT_OPTIONS);
      const apply = () => {
        const id = this.activeSourceId();
        if (id === "civitai") {
          const f = this.gallerySourceFilters(id);
          f.nsfw = civitaiNsfw.value;
          f.sort = civitaiSort.value;
        } else if (id === "pixiv") {
          const f = this.gallerySourceFilters(id);
          f.target = pixivTarget.value;
          f.sort = pixivSort.value;
        } else {
          return;
        }
        this.saveSettings();
        this.search({ resetPage: true });
      };
      for (const select of [civitaiNsfw, civitaiSort, pixivTarget, pixivSort]) select.onchange = apply;
      // capabilities.query=false（C站）时在筛选条尾部挂一行说明：控件没坏，是上游不支持关键词
      const hint = document.createElement("span");
      hint.className = "adg-source-hint";
      hint.hidden = true;
      host.append(hint);
      this.sourceFilterControls = { civitaiNsfw, civitaiSort, pixivTarget, pixivSort, hint };
      return host;
    }

    syncSourceFilterControls() {
      if (!this.sourceFilterControls) return;
      const id = this.activeSourceId();
      const caps = this.sourceCapabilities(id);
      const f = this.gallerySourceFilters(id);
      const { civitaiNsfw, civitaiSort, pixivTarget, pixivSort, hint } = this.sourceFilterControls;
      const show = (element, on) => { element.parentElement.hidden = !on; };
      civitaiNsfw.value = f.nsfw || "";
      civitaiSort.value = f.sort || "Newest";
      pixivTarget.value = f.target || "partial_match_for_tags";
      pixivSort.value = f.sort || "date_desc";
      show(civitaiNsfw, id === "civitai");
      show(civitaiSort, id === "civitai");
      show(pixivTarget, id === "pixiv");
      show(pixivSort, id === "pixiv");
      if (hint) {
        hint.hidden = caps.query;
        hint.textContent = caps.query ? "" : GALLERY_LOCAL_QUERY_HINT_SHORT;
        hint.title = caps.query ? "" : GALLERY_LOCAL_QUERY_HINT;
        hint.dataset.queryMode = caps.query ? "server" : "local";
      }
      if (this.sourceFilterHost) {
        this.sourceFilterHost.title = id === "civitai"
          ? "C站筛选：分级（None/Soft/Mature/X，匿名也可读）与排序（上游只认 Newest/Oldest/Most */Random）"
          : "P站筛选：匹配方式与排序（标签与 Danbooru 词库不通用）";
      }
    }

    imageProxyUrl(imageUrl, version = "", sourceId = null) {
      // 多源：图片一律经后端代理（PLAN §5.4，前端不许 <img src="第三方 CDN">）。
      // D站 保持原样往下走；非 D站 走 /anima/gallery/{source}/image（P站 的 Referer 由
      // 后端按 images_headers() 附加，前端不参与）。
      const active = String(sourceId || this.activeSourceId() || DANBOORU_SOURCE_ID);
      if (active !== DANBOORU_SOURCE_ID) {
        let gallerySource = String(imageUrl || "");
        if (version && !/[?&]v=/.test(gallerySource)) {
          gallerySource += `${gallerySource.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(version))}`;
        }
        return `/anima/gallery/${encodeURIComponent(active)}/image?url=${encodeURIComponent(gallerySource)}`;
      }
      let source = String(imageUrl || "");
      if (version && !/[?&]v=/.test(source)) {
        source += `${source.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(version))}`;
      }
      return `/anima/danbooru/image?url=${encodeURIComponent(source)}`;
    }

    /** 某张帖子自己的图源（画廊 item 自带 source；D站 帖子没有 → 用当前源） */
    postSourceId(post) {
      const id = String(post?.source || "");
      return GALLERY_SOURCE_ORDER.includes(id) ? id : this.activeSourceId();
    }

    postImageUrl(post) {
      return post?.large_file_url || post?.file_url || post?.preview_file_url || "";
    }

    loadPreviewImage(image) {
      if (!image || !image.isConnected) return;
      const source = image.dataset.src;
      if (!source || image.getAttribute("src")) return;
      image.removeAttribute("data-src");
      image.src = source;
    }

    observePreviewImage(image) {
      if (!image) return;
      if (this.imageLoadObserver) this.imageLoadObserver.observe(image);
      else this.loadPreviewImage(image);
    }

    scheduleMasonryLayout() {
      if (this.masonryLayoutFrame || !this.grid) return;
      this.masonryLayoutFrame = requestAnimationFrame(() => {
        this.masonryLayoutFrame = null;
        this.applyMasonryLayout();
      });
    }

    /**
     * 网格几何。列数优先由「上次布局算出的列步长」反推 —— 垂直滚动条出现后 clientWidth
     * 会比 layout 时小十几像素，直接除会让卡片宽出容器、产生横向滚动条（实测 rightEdge 1295 > 1283）。
     */
    gridMetrics() {
      if (!this.grid) return { width: 780, cols: 3, cardWidth: 240, usable: 756 };
      const width = this.grid.clientWidth || 780;
      const style = getComputedStyle(this.grid);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const usable = Math.max(DG_MIN_PT, width - padX);
      const cols = this.lastColStep > DG_GAP
        ? Math.max(1, Math.round((usable + DG_GAP) / this.lastColStep))
        : Math.max(1, Math.floor((usable + DG_GAP) / (DG_MIN_PT + DG_GAP)));
      const cardWidth = Math.max(1, (usable - DG_GAP * (cols - 1)) / cols);
      return { width, cols, cardWidth, usable };
    }

    /** 每张卡盒子实际使用的宽高比（宽/高）：超高图按上限截断，其余保留真实比例（零裁切） */
    cardAspect(post) {
      const w = Number(post?.image_width);
      const h = Number(post?.image_height);
      if (!(w > 0) || !(h > 0)) return DG_FALLBACK_ASPECT;
      return Math.min(Math.max(h / w, 1e-6), DG_CLAMP_MAX_ASPECT);
    }

    /**
     * 真·瀑布流：逐张放进当前最矮的列，超宽图整组列对齐到同一 top。
     * 卡片改用绝对定位（不是 grid-row-end:span）——这样才能让「跨列宽盒」与
     * 「真实盒比」同时成立，并彻底消除旧实现同一行里高矮不一留下的成片空白。
     */
    applyMasonryLayout() {
      if (!this.grid) return;
      const cards = [...this.grid.querySelectorAll(".adg-card")];
      if (!cards.length) {
        this.grid.style.minHeight = "";
        return;
      }
      // ⚠️ 宽度**大改**（拖动节点 / 缩放画布）必须丢掉 lastColStep 反推基准：
      //    反推本来只为抗「滚动条出现/消失造成的那十几像素」，但宽度大改后继续反推会
      //    **收敛到错误列数** —— 实测 1743px 宽：正确 14 列被反推成 10 列（卡片宽 124.8 → 174.7），
      //    用户看到的就是"图片在抖动/错位"。CSS 已加 scrollbar-gutter:stable 从源头稳住宽度，
      //    这里再加一道：宽度相对上次变化超过阈值就直接用真实宽度重算。
      const gridStyle = getComputedStyle(this.grid);
      const padX = (parseFloat(gridStyle.paddingLeft) || 0) + (parseFloat(gridStyle.paddingRight) || 0);
      const rawUsable = Math.max(DG_MIN_PT, (this.grid.clientWidth || 780) - padX);
      const previousUsable = Number(this._lastLayoutUsable) || 0;
      if (previousUsable > 0 && (rawUsable > previousUsable * 1.25 || rawUsable < previousUsable * 0.8)) {
        this.lastColStep = 0;
      }
      this._lastLayoutUsable = rawUsable;
      const { usable, cols } = this.gridMetrics();
      const padTop = parseFloat(gridStyle.paddingTop) || 0;
      const colStep = (usable - DG_GAP * (cols - 1)) / cols + DG_GAP;
      const cardWidth = (usable - DG_GAP * (cols - 1)) / cols;
      this.lastColStep = colStep;
      // 左内边距每次都要重读：横向滚动条/样式变更都会改它
      const padLeft = parseFloat(gridStyle.paddingLeft) || 0;
      const colHeights = new Array(cols).fill(0);

      // 数据侧只读一次：卡片下标必须与 renderPosts 记录的「实际渲染列表」一致
      const posts = this._layoutPosts || this.posts || [];
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const post = posts[i];
        const aspect = this.cardAspect(post);
        let span = dgSpanFor(aspect, cols);
        // 兜底：span 任何情况下都不得超出列数，否则下面「找起点」循环一次都不执行，
        // top 会停在 Infinity（卡片被甩出可视区，且不自愈）。
        if (span > cols) span = 1;
        const boxW = cardWidth * span + DG_GAP * (span - 1);
        const boxH = boxW / (1 / aspect);
        let start = 0;
        let top = Infinity;
        for (let c = 0; c + span <= cols; c++) {
          let maxH = 0;
          for (let k = c; k < c + span; k++) if (colHeights[k] > maxH) maxH = colHeights[k];
          if (maxH < top) { top = maxH; start = c; }
        }
        // 最后一道闸：绝不把 Infinity 写进 style（那会让卡片彻底消失且无法自愈）
        if (!Number.isFinite(top)) { top = 0; start = 0; }
        const drop = top + boxH + DG_GAP;
        for (let k = start; k < start + span; k++) colHeights[k] = drop;
        card.style.position = "absolute";
        card.style.left = `${Math.round(padLeft + start * colStep)}px`;
        card.style.top = `${Math.round(padTop + top)}px`;
        card.style.width = `${Math.round(boxW)}px`;
        card.style.height = `${Math.round(boxH)}px`;
        // 供 CSS/探针读的盒比（图片渲染由 .adg-card img 的宽高 100% + object-fit 承接）
        card.dataset.adgSpan = String(span);
      }
      let total = 0;
      let minCol = Infinity;
      for (const ch of colHeights) {
        if (ch > total) total = ch;
        if (ch < minCol) minCol = ch;
      }
      total = Math.max(0, total - DG_GAP);
      this._layoutTotal = total;
      // 最矮列：用户眼里的「填满」由最短的那一列决定 —— 最长列会掩盖参差（见 gridUnderfilled）
      this._layoutMinCol = Number.isFinite(minCol) ? Math.max(0, minCol - DG_GAP) : total;
      // 实测平均卡高（每列张数 ≈ 卡片数 / 列数）→ 下一次算张数别再用 fallback 比例猜
      const perCol = Math.max(1, Math.ceil(cards.length / Math.max(1, cols)));
      this._measuredAvgCardH = Math.max(DG_MIN_CARD_H, (total + DG_GAP) / perCol - DG_GAP);
      // ── 布局自愈（2026-09-16 用户实测："图片在抖动，要我手动改变一次节点大小才恢复正常"）──
      // 症状的本质是「算错一次就一直错下去」：gridMetrics() 用上一次的 lastColStep 反推列数
      // （这是为了不受滚动条出现/消失影响），但首次布局时容器尺寸可能还没稳定；一旦基准被算歪，
      // 后续每次都沿用脏基准，卡片就会错位/被裁 —— 只有 resize 触发列数重算才能恢复。
      // 这里做一次廉价校验：最右卡片的右边缘若超出内容区，就丢掉脏基准并立刻重排一次。
      if (!this._layoutSelfHeal && this.lastColStep > DG_GAP) {
        let rightEdge = 0;
        for (const card of cards) {
          const right = (parseFloat(card.style.left) || 0) + (parseFloat(card.style.width) || 0);
          if (right > rightEdge) rightEdge = right;
        }
        if (rightEdge > usable + padLeft + 2) {
          this.lastColStep = 0;   // 逼 gridMetrics() 用真实宽度重新估算列数
          this.lastCols = 0;
          this._layoutSelfHeal = true;
          try {
            this.applyMasonryLayout();
          } finally {
            this._layoutSelfHeal = false;
          }
          return;                 // 本轮作废：重排那次已经写好布局与统计
        }
      }
      // ⚠️ 不把内容总高写进 min-height，也不再自动收缩 ——
      //    用户要求（2026-09-16）：「节点大小完全限制于我的设定，不要因为图像而改变，
      //    也不要自主变大变小」。实测把内容高写进 min-height 后（grid 661px→1708px），
      //    前端布局器会把节点从 900 顶到 1994；CSS 的 flex-basis:auto 是另一半原因。
      //    现在网格高度完全交给节点空间（CSS: flex:1 1 0% + height:0 + overflow-y:auto），
      //    内容多了就滚动，绝不反向影响节点尺寸。
      this.grid.style.minHeight = "0";
      if (this.lastCols !== cols) this.lastCols = cols;
    }

    /**
     * 整页铺不满时收掉底部空白：把画廊高度收到「内容实际高度」，
     * 而不是让用户对着半屏空网格（页面填满时不动，保留用户设定的高度）。
     * 只缩不放，且带 24px 迟滞，避免与 domSizeSync 来回抖动。
     */
    shrinkGridToContent(total) {
      const root = this.root;
      if (!root || !(total > 0)) return;
      // ⓪ 自适应模式下「还能继续补图」时，先补满，**不要**用缩小节点来消灭空白 ——
      //    用户原话：「应该是图片适配节点，而不是节点适配图片」（2026-09-15），
      //    2026-09-16 又复报「还是填充不满节点，用一半以上的空位」。
      //    只有补到池子取空（fillMoreExhausted / 没有 next_cursor）才允许收缩兜底，
      //    这样"节点尺寸是用户定的、图片负责填满它"才是默认行为。
      if (this.autoLimit() && !this.fillMoreExhausted
        && (this.isDanbooruSource() || this.nextCursor)) return;
      // ① 用户手动调过尺寸 → 本次结果集内**不再自动收缩**。否则「放回大小」会被下一帧
      //    缩回去，用户看到的就是「手动放大也不填满」。
      if (this.userResizedAt) return;
      // ② 同一个内容高度只缩一次。否则「缩 → 竖向滚动条消失 → 内容区变宽 → 列数 +1
      //    → 卡片变矮 → 内容总高变小 → 再缩」会一轮轮互相触发，节点就"慢慢变小"。
      if (this.shrunkTotal !== null && Math.abs(this.shrunkTotal - total) < 8) return;
      const current = root.clientHeight || 0;
      if (!(current > 0)) return;
      const target = Math.max(360, Math.min(1200, Math.ceil(total + 8)));
      if (target >= current - 24) return;
      // ③ 只收「**明显**填不满」的情况：内容不到可视高度的 60% 才收。
      //    否则用户「拉大节点想看更多图」会被立刻缩回去 —— 用户原话：
      //    「应该是图片适配节点，而不是节点适配图片」（2026-09-15 真机反馈）。
      if (target > current * 0.6) return;
      if (Math.abs((this.settings.gridHeight || 0) - target) < 2) return;
      this.settings.gridHeight = target;
      this.shrunkTotal = target;
      this.setGridHeight(target);
    }

    /**
     * 把网格高度应用到节点。**所有程序化改尺寸都必须走这里** ——
     * 记下时刻，供 noteExternalResize() 区分「用户拖动」与「我们自己改的」。
     */
    setGridHeight(height) {
      this.programmaticResizeAt = Date.now();
      if (this.domSizeSync) {
        this.domSizeSync.setContentHeight(height);
        return;
      }
      if (this.root) {
        this.root.style.height = `${height}px`;
        this.root.style.minHeight = "0px";
        this.root.style.maxHeight = "none";
      }
      this.node?.setSize?.([Math.max(360, this.node.size?.[0] || 780), height + 95]);
      this.node?.graph?.setDirtyCanvas?.(true, true);
    }

    /** 节点尺寸被外部改变时调用：距上次程序化改尺寸足够久 ⇒ 判定为用户手动拖动。 */
    noteExternalResize() {
      if (Date.now() - this.programmaticResizeAt > 350) {
        this.userResizedAt = Date.now();
        // 用户重新定了尺寸 = 新目标：解锁目标高度、给足补图轮次。
        // 否则补图链还拿着**旧的大目标**把节点钉回去 ⇒「缩小节点还会自己变回去」。
        this._autoFillTarget = 0;
        this.autoFillRounds = 0;
      }
    }

    /**
     * 节点/网格尺寸变化后：列数变了 → 重取一页；**纵向显著拉大且这批填不满** → 再补一批。
     *
     * 2026-09-15 用户真机反馈：「画廊底部拖拽但是没有加载新的图片挤进来」。
     * 根因：纵向拉大不改变列数，而旧实现只有 `cols !== lastCols` 才重取 ⇒ 拉高永远不补图。
     * 与「自动收缩」方向相反但同样要克制：只在自适应张数模式、只在明显填不满、450ms 防抖、末批不再取。
     */
    handleGridResize() {
      if (!this.grid) return;
      const { cols } = this.gridMetrics();
      const changed = this.lastCols && cols !== this.lastCols;
      // 「高度显著增大」必须在 scheduleMasonryLayout() 之前读：布局是下一帧才跑的，
      // 这里比较的是「用户拉大后的可视高」与「上一次记录的可视高」。
      const grewTaller = this.noteTallerResize();
      this.scheduleMasonryLayout();
      if (this.disposed) return;
      if (!changed && !grewTaller) return;
      // 固定张数模式：用户已显式指定每页几张，只重排、不擅自取数
      if (!this.autoLimit()) return;
      if (this.resizeSearchTimer) clearTimeout(this.resizeSearchTimer);
      // 防抖：拖动节点缩放时不要每帧都打上游接口
      this.resizeSearchTimer = setTimeout(() => {
        this.resizeSearchTimer = null;
        if (this.disposed || !this.posts.length) return;
        if (changed) {
          // 列数变化 ⇒ 同一屏能放的张数变了（原有行为：重取一页）
          // ⚠️ 但这是**尺寸变化引起的**，不是用户发起的搜索：不能借它重置补图预算，
          //    否则「补图撑大节点 → 列数变化 → 重置 → 再补」就是死循环。
          const keepRounds = this.autoFillRounds;
          const keepTarget = this._autoFillTarget;
          this.search({ resetPage: true });
          this.autoFillRounds = keepRounds;
          this._autoFillTarget = keepTarget;
          return;
        }
        // 纵向拉大 ⇒ 补图填满（追加，不重置用户已翻到的位置）
        void this.fillMoreForHeight();
      }, 450);
    }

    /** 记录网格可视高度；返回本次是否为「显著增大」（用户纵向拖大节点） */
    noteTallerResize() {
      const visible = Number(this.grid?.clientHeight) || 0;
      const previous = Number(this.lastVisibleHeight) || 0;
      this.lastVisibleHeight = visible;
      if (!(visible > 0) || !(previous > 0)) return false;
      return visible - previous >= DG_TALLER_MIN_DELTA && visible >= previous * DG_TALLER_MIN_RATIO;
    }

    /**
     * 当前这批是否明显填不满可视区。
     * ⚠️ 分母用 **grid.clientHeight**（网格自己的视口），不是 `root.clientHeight`
     * —— root 还包含搜索框/工具条/分页/状态栏等固定 chrome（实测 ~130–150px），
     * 拿它当可视高会让「明明填满了」也恒判填不满，一拉大就无限补图。
     */
    gridUnderfilled(targetHeight = 0) {
      const total = Number(this._layoutTotal) || 0;
      const minCol = Number(this._layoutMinCol) || total;
      const visible = Number(targetHeight) > 0
        ? Number(targetHeight)
        : (Number(this.grid?.clientHeight) || 0);
      if (!(total > 0) || !(visible > 0)) return false;
      // 判据取**最矮列**（与总高取较小者）：瀑布流里「最长列到顶、旁边一列只到一半」
      // 在肉眼看来依然是没填满，而只看最高列会把它判成"满了"从而停止补图
      // —— 2026-09-16 用户复报「还是填充不满节点，用一半以上的空位」的真根因。
      return Math.min(total, minCol) < visible * DG_UNDERFILL_RATIO;
    }

    /**
     * 纵向拉大后「取更多图挤进来」：D站 走 page+1、C站/P站 走 next_cursor 前进
     * （都复用现有取数路径，D站 路由/参数一个字节没改），结果**追加**在已显示的图后面。
     * 末批（无更多）与「取回来的全是重复」都记进 fillMoreExhausted，之后不再打接口。
     */
    async fillMoreForHeight() {
      if (this.disposed || this.fillMoreBusy || this.fillMoreExhausted) return;
      if (!this.autoLimit()) return;
      if (!this.posts.length) return;
      if (!this.gridUnderfilled()) return;
      // C站/P站：契约只有 next_cursor，没有它就到底了
      if (!this.isDanbooruSource() && !this.nextCursor) {
        this.fillMoreExhausted = true;
        return;
      }
      const before = this.posts.slice();
      const seen = new Set(before.map((post) => String(post.id)));
      this.fillMoreBusy = true;
      try {
        if (this.isDanbooruSource()) {
          // D站：page 分页（老路由/老参数不变），取下一页
          this.page += 1;
          await this.search();
        } else {
          // C站/P站：cursor 栈前进一批
          await this.stepGalleryCursor(1);
        }
        const fetched = this.posts.slice();
        const merged = [...before, ...fetched.filter((post) => !seen.has(String(post.id)))];
        if (!fetched.length || merged.length <= before.length) {
          // 空页 / 全是重复 ⇒ 池子取光了，别再打接口
          this.fillMoreExhausted = true;
          this.posts = before;
        } else {
          this.posts = merged;
          this.setStatus(`${this.sourceLabel()}：已补到 ${merged.length} 张（填满本屏）`);
        }
        this.renderPosts();
        this.renderPagination();
      } catch (error) {
        // 补图失败不该打断用户：恢复原结果集，把原因写在状态栏
        this.posts = before;
        this.renderPosts();
        this.renderPagination();
        this.setStatus(`补图失败：${error?.message || "未知错误"}`, "error");
      } finally {
        this.fillMoreBusy = false;
      }
    }

    /**
     * 渲染完成后检查「填满没有」，没填满就继续补 —— 首屏、翻页、换源、换筛选都会走到这里。
     * 2026-09-16 用户真机反馈：「还是填充不满节点，用一半以上的空位」。
     * 根因：补图原先只在 handleGridResize 里触发（列数变化 / 纵向拉大），首屏与翻页后
     * 即便明显没填满也无人过问，空白就一直留着。
     */
    scheduleAutoFill() {
      if (this.autoFillTimer || this.disposed) return;
      // 等一拍：applyMasonryLayout 由 rAF 调度，且同一帧里可能刚触发过一次「自动收缩」
      this.autoFillTimer = setTimeout(() => {
        this.autoFillTimer = null;
        void this.autoFillIfUnderfilled();
      }, 80);
    }

    /** 补图的目标可视高 = 判定那一刻的**真实视口**，随后锁死。
     *  ⚠️ 不要用 settings.gridHeight：它会被"被撑大的尺寸"污染成上限值，
     *  拿它当目标就会在用户缩小时把节点又放大回去（用户 2026-09-16："我一要缩小节点，就放大多次"）。 */
    autoFillTargetHeight() {
      if (this._autoFillTarget > 0) return this._autoFillTarget;
      return Number(this.grid?.clientHeight) || 0;
    }

    async autoFillIfUnderfilled() {
      if (this.disposed || this.fillMoreBusy || this.fillMoreExhausted) return;
      if (!this.autoLimit() || !this.posts.length) return;
      if (this.autoFillRounds >= DG_AUTO_FILL_MAX_ROUNDS) return;
      // ③ 时间窗限流：不受任何「重置」影响的最后一道闸。
      //    列数变化会走 handleGridResize → search(resetPage) → autoFillRounds 归零，
      //    于是「补图 → 内容变高 → 布局器把节点撑大 → 列数变化 → 重置 → 再补」会**无限**循环
      //    （用户 2026-09-16 真机反馈："在无限变大，扩充完图片之后又触发扩充，一直扩充"）。
      const now = Date.now();
      if (!this._autoFillWindowAt || now - this._autoFillWindowAt > DG_AUTO_FILL_WINDOW_MS) {
        this._autoFillWindowAt = now;
        this._autoFillWindowCount = 0;
      }
      if (this._autoFillWindowCount >= DG_AUTO_FILL_MAX_PER_WINDOW) return;
      // ⓪ 用户刚动过尺寸 → 静默 1.5s：绝不和用户的手抢尺寸（见 DG_USER_RESIZE_GRACE_MS）
      if (this.userResizedAt && now - this.userResizedAt < DG_USER_RESIZE_GRACE_MS) return;
      const target = this.autoFillTargetHeight();
      if (!(target > 0)) return;
      if (!this.gridUnderfilled(target)) return;
      // C站/P站：契约只有 next_cursor，没有它就到底了
      if (!this.isDanbooruSource() && !this.nextCursor) {
        this.fillMoreExhausted = true;
        return;
      }
      this._autoFillTarget = target;   // 锁定：补图期间目标高度不变
      this.autoFillRounds += 1;
      this._autoFillWindowCount += 1;
      // fillMoreForHeight 收尾会 renderPosts → 再次 scheduleAutoFill，
      // 于是「补一批 → 仍不满 → 再补」自动链到填满 / 取空 / 达到上限为止。
      await this.fillMoreForHeight();
      // ⚠️ **绝不**在这里调 setGridHeight / setSize 把尺寸"钉回去"：那会在用户拖动缩小的
      //    同时和用户对着干（用户实测"我一要缩小节点，就放大多次"）。
      //    补图只负责往列里塞图；节点尺寸永远由用户（或前端布局器）决定。
    }

    /** 当前是否为「自适应张数」模式 */
    autoLimit() {
      return !this.settings.limit;
    }

    /** 随机发现的去重键 = 去掉筛选 token 后的查询主体（筛选变化不该重置「已看过」） */
    randomHistoryKey() {
      return normalizeTags(stripFilterOwnedTokens(this.queryWidget?.value || ""));
    }

    rememberRandomResults(query) {
      // 空结果不记历史：否则自动退化重试那一轮会把「空集」当成一批存进去
      if (!this.settings.randomQuality || !this.posts.length) return;
      const key = this.randomHistoryKey();
      const seen = this.randomHistory.get(key) || [];
      const seenSet = new Set(seen);
      for (const post of this.posts) {
        const id = String(post?.id || "");
        if (id && !seenSet.has(id)) { seenSet.add(id); seen.push(id); }
      }
      // 只保留最近 N 个：够避开「翻来覆去同几张」，又不至于把随机池抽干
      this.randomHistory.set(key, seen.slice(-RANDOM_HISTORY_MAX));
    }

    /**
     * 一键随机发现：order:random + 质量地板（分数/时间窗），可选「换一批」避开已看过的。
     * 产品意图：用户要的是「有灵感的高质量惊喜」，不是「全库随手捞一张没人贴过的冷门图」。
     */
    async discoverRandom(tierId = null, { reshuffle = false } = {}) {
      const tier = RANDOM_QUALITY_TIERS.find((t) => t.id === tierId)
        || RANDOM_QUALITY_TIERS.find((t) => t.id === this.settings.randomQuality)
        || RANDOM_QUALITY_TIERS[1];
      const prevQuality = this.settings.randomQuality;
      const prevFilters = this.settings.filters;
      const historyKey = this.randomHistoryKey();
      // 「换一批」：先记住换之前池子里已经看过哪些，用来判断这次是不是真的换出了新图
      const seenBefore = reshuffle ? new Set(this.randomHistory.get(historyKey) || []) : null;
      this.settings.randomQuality = tier.id;
      this.settings.filters = normalizeFilters({
        ...this.settings.filters,
        order: "random",
        minScore: tier.minScore,
        minFavs: tier.minFavs,
        // 时间窗会把随机池掐死（实测 miku_day + score:>100 从 31 结果掉到 0），这里显式清空；
        // 真需要时间范围由后端慢排序兜底的 age:<1week 负责。
        age: "",
        ageDays: "",
      });
      if (reshuffle) {
        // 「换一批」：清掉随机历史，让同一档位能给出新的一批
        this.randomHistory.delete(this.randomHistoryKey());
      }
      this.saveSettings();
      this.filterControls?.refresh();
      this.randomTierButtons?.();
      this.setStatus(`随机发现：${tier.label}（${tier.hint}）…`);
      // force：随机排序若命中后端 30s 缓存会给出完全相同的一批，失去「随机」的意义
      await this.search({ resetPage: true, force: true });
      // 内容标签 ∩ 随机池 可能是空集（实测 miku_day + score:>100 + 近 30 天 = 0 结果，
      // miku_day 是「星期几」标签、几乎不会有高分帖）。随机发现的语义是「探索」，
      // 这时自动退化为「纯质量地板随机」并明确告知，而不是给用户一个空网格。
      if (!this.posts.length && normalizeTags(stripFilterOwnedTokens(this.queryWidget?.value || ""))) {
        this._randomTrimmed = true;
        this.setStatus(`随机发现：${tier.label} —— 当前标签在该质量档下没有结果，已忽略标签只看随机…`);
        await this.search({ resetPage: true, force: true });
      }
      if (!this.posts.length && (this.settings.randomQuality !== prevQuality)) {
        // 连纯随机也空（档位太苛刻）→ 回滚设置，避免用户卡在空网格里
        this.settings.randomQuality = prevQuality;
        this.settings.filters = prevFilters;
        this.saveSettings();
        this.filterControls?.refresh();
        this.randomTierButtons?.();
        this.setStatus(`随机发现失败：${tier.label} 没有返回结果，可换一档或检查代理（D站 可能被 Cloudflare 风控）`, "error");
        return;
      }
      // 「换一批」把池子取光了：这一页跟上一页完全是同一批（如 miku_day + score:>100 全站仅 31 张，
      // 一页 48 就把池子拿完）。与其假装换过，不如明说并建议换档/加标签。
      if (reshuffle && seenBefore && this.posts.length) {
        const fresh = this.posts.filter((p) => !seenBefore.has(String(p.id || ""))).length;
        if (!fresh) {
          this._randomPoolExhausted = true;
          this.setStatus(`「${tier.label}」这一档能给的都看过了（本页 ${this.posts.length} 张全部重复）——换个档位、加个标签，或用筛选面板缩小范围`);
        }
      }
    }

    /** 退出随机发现（回到普通搜索） */
    async exitRandom() {
      if (!this.settings.randomQuality) return;
      this.settings.randomQuality = "";
      this.settings.filters = normalizeFilters({ ...this.settings.filters, order: "" });
      this.saveSettings();
      this.filterControls?.refresh();
      this.randomTierButtons?.();
      await this.search({ resetPage: true });
    }

    /** 本次请求实际要几张 */
    resolveLimit() {
      if (this.autoLimit()) return dgComputeAutoCount(this.grid, this.gridMetrics(), this._measuredAvgCardH);
      return this.settings.limit;
    }

    setupImageLoading() {
      if (!this.grid) return;
      this.imageLoadObserver?.disconnect();
      this.imageLoadObserver = null;
      // 节点内滚动时按视口裁剪请求：只加载「网格可视区 ± 一屏」内的图，
      // 避免一次性把整页 48 张的代理请求全推给后端（后端并发只有 3）。
      if (typeof IntersectionObserver === "function") {
        this.imageLoadObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            this.imageLoadObserver?.unobserve(entry.target);
            this.loadPreviewImage(entry.target);
          }
        }, { root: this.grid, rootMargin: "320px 0px", threshold: 0.01 });
      }
      this.gridResizeObserver?.disconnect();
      this.gridResizeObserver = null;
      if (typeof ResizeObserver === "function") {
        this.gridResizeObserver = new ResizeObserver(() => this.handleGridResize());
        this.gridResizeObserver.observe(this.grid);
      }
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

    workflowSettings() {
      return parseGallerySettings(this.node?.properties?.[WORKFLOW_SETTINGS_PROPERTY]);
    }

    refreshSettingsUI() {
      this.setQuery(this.settings.lastQuery || "");
      this.filterControls?.refresh();
      this.renderPresetOptions();
      void this.hydratePresetNotes();
      this.updatePromptOutputButton();
      this.applyGridHeight();
      // 工作流里保存的图源要恢复成对应的控件可见性（P站 隐藏提示词类控件等）
      this.applySourceCapabilities();
    }

    loadWorkflowSettings() {
      const raw = this.node?.properties?.[WORKFLOW_SETTINGS_PROPERTY];
      const fromWorkflow = this.workflowSettings();
      const nodeId = String(this.node?.id ?? "");
      // 工作流设置优先于 localStorage：它代表用户保存的那个画廊实例。
      // 没有工作流设置时，兼容旧版本并在 node.id 分配完成后重新读取节点作用域存储。
      if (fromWorkflow) {
        this.settings = fromWorkflow;
        try { localStorage.setItem(this.settingsKey(), JSON.stringify(this.settings)); } catch {}
      } else if (nodeId !== this._settingsNodeId) {
        this.settings = loadSettings(this.node?.id);
      }
      this._settingsNodeId = nodeId;
      this.refreshSettingsUI();
    }

    saveSettings() {
      const serialized = JSON.stringify(this.settings);
      try { localStorage.setItem(this.settingsKey(), serialized); } catch {}
      if (this.node) {
        this.node.properties = this.node.properties || {};
        this.node.properties[WORKFLOW_SETTINGS_PROPERTY] = serialized;
        this.node.graph?.setDirtyCanvas?.(true, true);
      }
    }

    // 重建工具栏「搜索预设」下拉选项（保存/删除预设后调用）
    renderPresetOptions() {
      if (!this.presetSelect) return;
      const keepValue = this.presetSelect.value;
      this.presetSelect.replaceChildren(new Option("搜索预设", ""));
      this.settings.presets.forEach((preset, index) => {
        const label = preset.note ? `${preset.name} · ${preset.note}` : preset.name;
        this.presetSelect.append(new Option(label, String(index)));
      });
      if (keepValue !== "") this.presetSelect.value = keepValue;
    }

    applyGridHeight() {
      const height = Math.max(360, Math.min(1200, Number(this.settings.gridHeight) || 620));
      this.settings.gridHeight = height;
      // 用户在设置面板里指定高度 = 明确意图 → 本次结果集内不要再自动收缩
      this.userResizedAt = Date.now();
      this.setGridHeight(height);
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
      // 联想走的是 D站 /anima/danbooru/suggest（Danbooru tag 词典）：非 D站 图源没有这套词典，
      // 弹出来的候选一定插不进去 —— 直接不弹（capabilities.tags=false 的 C站 尤其如此）。
      if (!this.isDanbooruSource()) {
        this.hideSuggestions();
        return;
      }
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
        normalizeTags(stripFilterOwnedTokens(raw)),
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
      // 去重（不区分大小写）：用户可能把 rating:g / -filetype:mp4 也手打进搜索框，
      // 与筛选面板产生的同名 token 撞车 → 查询词里出现两份，白白多占计数槽。
      const seen = new Set();
      const deduped = [];
      for (const part of parts) {
        if (!part) continue;
        const key = String(part).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(part);
      }
      return deduped.join(" ");
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
      // 多源画廊：非 D站 走统一画廊协议 /anima/gallery/{source}/search（cursor 分页）。
      // ⚠️ D站 分支（下面这一整段）保持原样：路由 /anima/danbooru/posts、page 分页、
      //    计数标签上限、模糊纠错、排除标签本地过滤全部不动。
      if (!this.isDanbooruSource()) return this.searchGallerySource({ resetPage, retryCount });
      // build() 中的初次搜索与 refreshAccount 并发时，不能先按默认匿名上限移除排序。
      // 等待一次账号状态后，后续搜索只会 await 一个已完成的 Promise，不增加网络请求。
      if (this.accountReady) {
        try { await this.accountReady; } catch {}
      }
      // 分类浏览模式下发起新搜索 = 回到普通搜索视图（分类只作用于本地浏览，搜索条件与分类无关）
      if (this.settings.activeCategory) {
        this.settings.activeCategory = "";
        this.saveSettings();
        this.filterControls?.refresh();
      }
      this._searchSnapshot = null; // 新搜索后 posts 即将被覆盖，分类快照失效
      this._droppedOrder = false;
      this._randomTrimmed = false;
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
      // 计数槽超限时的取舍：**随机发现模式下保留 order:random**（用户点的就是它），
      // 改为丢弃内容标签；普通模式下优先保内容标签、自动降级排序（旧行为）。
      if (counted > this.tagLimit() && this.settings.randomQuality) {
        this._randomTrimmed = true;
        query = query.split(/\s+/).filter((t) => /^order:/.test(t) || /^(rating|age|score|favcount|mpixels|ratio|filetype):/.test(t)).join(" ");
        counted = countedSearchTerms(query);
      }
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
          ? `D站 登录账号当前最多 ${this.tagLimit()} 个计数标签（按等级：Member=2，Gold=6）。请减少普通标签，或改用评级/时间/评分/收藏筛选。`
          : `D站 匿名搜索最多 ${this.tagLimit()} 个计数标签（普通标签与排序各占 1 个）。登录后上限按账号等级提升：Member 仍为 2，Gold 为 6。`;
        this.setStatus(hint, "error");
        return;
      }
      if (resetPage) this.page = 1;
      // 新一轮搜索（点搜索/换筛选/列数变化）＝ 新结果集 → 重新允许「拉大补图」与「自动补满」
      if (resetPage) {
        this.fillMoreExhausted = false;
        this.autoFillRounds = 0;
        this._autoFillTarget = 0;   // 新结果集 = 新目标，重新按当前尺寸评估
      }
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
          // 自适应模式：按节点尺寸算出「刚好填满」的张数（上限=后端 MAX_PAGE_SIZE=48）
          limit: String(this.resolveLimit()),
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
        if (typeof data?.registered === "boolean") this.registered = data.registered;
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
        let visiblePosts = rawPosts;
        if (excludeTags.length) {
          const tagSet = new Set(excludeTags);
          const filtered = [];
          for (const post of rawPosts) {
            const postTags = String(post?.tag_string || "").split(" ");
            if (postTags.some((t) => tagSet.has(t))) excludedCount += 1;
            else filtered.push(post);
          }
          visiblePosts = filtered;
        }
        // D站 偶尔会返回已删除/失效帖子，只剩元数据而没有任何图片 URL。
        // 不把它计入“可显示图片”，避免状态写 24 张、DOM 实际只有 23 张。
        let unavailableCount = 0;
        this.posts = visiblePosts.filter((post) => {
          if (this.postImageUrl(post)) return true;
          unavailableCount += 1;
          return false;
        });
        if (!rawPosts.length) {
          this.fetchSuggestions(this.queryWidget?.value || query, true);
          // 精确搜索无结果 → 模糊纠错（把近似标签替换成真实标签）自动重搜一次
          if (!skipFuzzy) await this.fuzzyRetry(query);
        } else if (!this.posts.length) {
          this.setStatus(`该页 ${rawPosts.length} 张全部被排除标签过滤（${excludeTags.join("、")}），请调整排除标签`, "error");
        }
        this.renderPosts();
        this.renderPagination();
        this.rememberRandomResults(query);
        const source = data.cached ? "缓存" : "D站";
        const notices = [];
        if (Array.isArray(data.warnings) && data.warnings.length) notices.push(...data.warnings.map(String));
        if (unavailableCount) notices.push(`${unavailableCount} 张原图已失效，已跳过`);
        if (this._droppedOrder) {
          const limitHint = this.registered
            ? `登录账号当前最多 ${this.tagLimit()} 个计数标签`
            : `匿名最多 ${this.tagLimit()} 个计数标签`;
          notices.push(`已自动移除「${ORDER_LABELS[this._droppedOrder] || this._droppedOrder}」排序，按最新显示（${limitHint}）`);
        }
        const exclNotice = excludeTags.length ? `已排除 ${excludeTags.map(displayExcludeTag).join("、")} ${excludedCount} 张` : "";
        const tier = this.settings.randomQuality ? RANDOM_QUALITY_TIERS.find((t) => t.id === this.settings.randomQuality) : null;
        if (tier) notices.push(`${tier.label}（${tier.hint}）`);
        if (this._randomTrimmed) notices.push("为保住随机排序已忽略内容标签");
        this.setStatus(`${source}：${this.posts.length} 张 · 第 ${this.page} 页` + (exclNotice ? `（${exclNotice}）` : "") + (notices.length ? `（${notices.join("；")}）` : ""));
        // 换一批把池子取光了：search 的常规状态文案刚写上去，这里覆盖成明确提示
        if (this._randomPoolExhausted) {
          this._randomPoolExhausted = false;
          this.setStatus(`这一档能给的都看过了（本页 ${this.posts.length} 张全部重复）——换个档位、加个标签，或用筛选面板缩小范围`);
        }
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
      // C站（capabilities.prompt=true、tags=false）：回包里带的是别人写好的**整段提示词**
      // （PLAN §5.2 的 item.prompt）。这里把它拆成词条喂进现有的分组链路，
      // 于是既有的悬停浮层 / Prompt 编辑器 / 入库弹窗都能直接复用，不必新造一套 UI。
      // ⚠️ D站 帖子没有 post.prompt，这条分支对 D站 永远不成立。
      const galleryPrompt = String(post?.prompt || "").trim();
      if (galleryPrompt && !String(post?.tag_string || "").trim()) {
        for (const part of splitPromptParts(galleryPrompt)) add("general", part);
        return groups;
      }
      for (const category of PROMPT_CATEGORY_ORDER) {
        for (const tag of String(post?.[`tag_string_${category}`] || "").split(" ")) add(category, tag);
      }
      // 兼容某些接口只返回总 tag_string 的旧数据。
      if (Object.values(groups).every((tags) => tags.length === 0)) {
        for (const tag of String(post?.tag_string || "").split(" ")) add("general", tag);
      }
      return groups;
    }

    /** 该条目所在图源是否真的有提示词（P站 capabilities.prompt=false → 没有，只有日文标签） */
    postHasPrompt(post) {
      const sourceId = this.postSourceId(post);
      if (sourceId === DANBOORU_SOURCE_ID) return true;
      // 用「明确声明 false 才禁用」的语义：capabilities 尚未拉到时不要误伤 C站（prompt=true）
      return this.sourceCapabilities(sourceId)?.prompt !== false;
    }

    buildPromptForPost(post, promptOutput = null, excludePattern = "") {
      const settings = normalizePromptOutputSettings(promptOutput || this.promptOutputSettings());
      // ⚠️ P站 没有提示词（capabilities.prompt=false）：它的 tags 是 Pixiv 用户自由打的
      // **日文/多语言标签**（实测同一张图会同时出现 初音ミク / 初音未来 / hatsunemiku），
      // 把 tags 当 prompt 吐给下游 = 往提示词里灌非 Danbooru 规范的词。
      // UI 早已按 capabilities 隐藏了 Prompt/入库 按钮，但**输出端口**之前没短路
      // （rawPromptGroups 会回退到 tag_string 拼 general），这里补上。
      if (!this.postHasPrompt(post)) {
        return {
          prompt: "",
          tags: [],
          groups: Object.fromEntries(PROMPT_CATEGORY_ORDER.map((category) => [category, []])),
          settings: { ...settings, categories: [...settings.categories] },
        };
      }
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

    async buildPresetNote(query) {
      const parts = presetTagParts(query);
      if (!parts.length) return String(query || "").trim() ? "筛选条件" : "";
      const translations = await this.ensureTagTranslations(parts.map(({ tag }) => tag));
      return parts.map(({ tag, sign }) => {
        const translated = String(translations[tag] || "").trim();
        const fallback = tag.replace(/_/g, " ");
        const label = translated || fallback;
        if (sign === "-") return `排除${label}`;
        if (sign === "~") return `近似${label}`;
        return label;
      }).join("、").slice(0, 240);
    }

    async hydratePresetNotes(onUpdated) {
      if (this.presetNoteHydration) {
        const changed = await this.presetNoteHydration;
        if (changed) onUpdated?.();
        return changed;
      }
      const missing = this.settings.presets.filter((preset) => preset.query && !preset.note);
      if (!missing.length) return false;
      const task = (async () => {
        let changed = false;
        for (const preset of missing) {
          const note = await this.buildPresetNote(preset.query);
          if (note) {
            preset.note = note;
            changed = true;
          }
        }
        if (changed) {
          this.saveSettings();
          this.renderPresetOptions();
        }
        return changed;
      })();
      this.presetNoteHydration = task;
      try {
        const changed = await task;
        onUpdated?.();
        return changed;
      } finally {
        if (this.presetNoteHydration === task) this.presetNoteHydration = null;
      }
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

    /** 网格内错误格：把失败原因渲染成可见的一格，而不是只写状态栏 */
    appendGridNotice(message) {
      if (!this.grid || !message) return;
      const cell = document.createElement("div");
      cell.className = "adg-grid-notice";
      cell.textContent = message;
      this.grid.append(cell);
    }

    renderPosts() {
      if (!this.grid) return;
      this.imageLoadObserver?.disconnect();
      this.grid.replaceChildren();
      this.grid.style.minHeight = "";
      this.lastCols = 0;
      this.lastColStep = 0;
      this.failedImageCount = 0;
      // 新一批结果 → 允许重新评估一次自动收缩。
      this.shrunkTotal = null;
      // ⚠️ **不要**在这里重置 userResizedAt：用户手动调过的节点尺寸是**跨批次**的意图。
      // 之前在这里重置它 ⇒「拉大节点 → 点下一批 → 节点又缩回内容高度」，
      // 用户看到的是「节点适配图片」而不是「图片适配节点」（2026-09-15 真机反馈）。
      this.renderedPostCount = 0;
      if (!this.posts.length) {
        const empty = document.createElement("div");
        empty.className = "adg-empty";
        empty.textContent = "没有可显示的图片";
        this.grid.append(empty);
        return;
      }
      // 布局按「本页实际渲染的卡片」下标对齐（见 applyMasonryLayout 读 this._layoutPosts），
      // 因此这里必须把过滤后真正渲染的 post 记下来，不能直接用 this.posts 下标。
      const rendered = [];
      for (const post of this.posts) {
        if (this.settings.activeCategory && this.settings.postCategories[String(post.id)] !== this.settings.activeCategory) continue;
        const imageUrl = this.postImageUrl(post);
        if (!imageUrl) continue;
        rendered.push(post);
        const card = document.createElement("article");
        card.className = "adg-card";
        // 类别色条：D站 帖子的主类别（artist/copyright/character/general），一眼分得出这页的构图来源
        const categoryClass = dgCardCategoryClass(post);
        if (categoryClass) card.classList.add(categoryClass);
        const postId = String(post.id || "");
        const isFavorite = this.favorites.has(postId);
        card.classList.toggle("is-favorite", isFavorite);
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
        // 图源标记：卡片自己的来源（画廊 item 自带 source；D站 为空 = 当前源 D站）
        const postSourceId = this.postSourceId(post);
        const isGallerySource = postSourceId !== DANBOORU_SOURCE_ID;
        const postCaps = this.sourceCapabilities(postSourceId);
        card.dataset.source = isGallerySource ? postSourceId : "";
        if (isGallerySource) {
          // C站 的负面提示词 + 采样参数、P站 的日文标签/作者：同一浮层里展示，不另造弹窗
          card.dataset.negativePrompt = String(post.negative_prompt || "");
          card.dataset.galleryMeta = JSON.stringify(post.meta || {});
        }
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
        // 请求时机已经由本节点的 IntersectionObserver 控制；再叠加浏览器原生
        // loading=lazy 会让已设置 src 的后半页图片永久停在 pending，形成空卡片。
        preview.loading = "eager";
        preview.decoding = "async";
        preview.alt = `${isGallerySource ? this.sourceLabel(postSourceId) : "Danbooru"} #${post.id || ""}`;
        const previewUrl = post.preview_file_url || imageUrl;
        const imageWidth = Number(post.image_width);
        const imageHeight = Number(post.image_height);
        if (imageWidth > 0 && imageHeight > 0) {
          // Reserve the real aspect ratio before the request starts. This
          // keeps the masonry placement stable while the image is loading.
          preview.width = imageWidth;
          preview.height = imageHeight;
          preview.style.aspectRatio = `${imageWidth} / ${imageHeight}`;
        }
        preview.dataset.src = this.imageProxyUrl(previewUrl, post.md5, postSourceId);
        preview.onerror = () => {
          // 单张失败不再整卡塌陷成一行文字（会打乱瀑布流）：保留占位并标红
          preview.classList.add("is-failed");
          preview.removeAttribute("src");
          card.classList.add("is-image-failed");
          this.failedImageCount = (this.failedImageCount || 0) + 1;
        };
        preview.onload = () => this.scheduleMasonryLayout();
        const caption = document.createElement("span");
        caption.className = "adg-caption";
        const isVid = this.isVideoPost(post);
        caption.textContent = `#${post.id || "?"} · ${post.image_width || "?"}×${post.image_height || "?"}${isVid ? " · MP4" : ""}${isGallerySource ? ` · ${this.sourceLabel(postSourceId)}` : ""}`;
        selectButton.append(preview, caption);
        if (isVid) {
          const badge = document.createElement("span");
          badge.className = "adg-video-badge";
          badge.textContent = "视频";
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
        // capabilities.prompt=false 的图源（P站）没有提示词可看/可入库 → 不收这两个按钮，
        // 否则点下去只会得到空内容（项目 UI 规范：不要留点了没反应的控件）。
        const promptActionsApplicable = postCaps.prompt || !isGallerySource;
        const promptAction = addAction("Prompt", "查看、编辑和复制 Prompt", () => this.openPromptEditor(card, post));
        const libraryAction = addAction("入库", "分类 / 入库：在同一弹窗中分别选择本地分类和 Prompt 入库，可只执行其中一项", () => this.saveToPromptLibrary(post, { includeLocalCategory: true }));
        if (!promptActionsApplicable) {
          promptAction.hidden = true;
          libraryAction.hidden = true;
        }
        // 「下载原图」对 P站 是主用途（下载后喂 WD14 反推）→ 走 full_url（original 优先，见 downloadPost）
        addAction("下载", "下载原图（原图优先 full_url）", () => this.downloadPost(post));
        const favoriteButton = addAction(isFavorite ? "★" : "☆", isFavorite ? "取消收藏" : "收藏", () => {
          const next = this.toggleFavorite(post.id);
          card.classList.toggle("is-favorite", next);
          favoriteButton.classList.toggle("is-favorite", next);
          favoriteButton.textContent = next ? "★" : "☆";
          favoriteButton.title = next ? "取消收藏" : "收藏";
          favoriteButton.setAttribute("aria-label", next ? "取消收藏" : "收藏");
          favoriteButton.setAttribute("aria-pressed", next ? "true" : "false");
        });
        favoriteButton.classList.toggle("is-favorite", isFavorite);
        favoriteButton.setAttribute("aria-label", isFavorite ? "取消收藏" : "收藏");
        favoriteButton.setAttribute("aria-pressed", isFavorite ? "true" : "false");
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
        this.observePreviewImage(preview);
      }
      this._layoutPosts = rendered;
      this.renderedPostCount = rendered.length;
      // 布局按下标与 _layoutPosts 对齐，因此在途的懒加载图完成后不需要重排
      //（盒子尺寸在摆放时就已按真实盒比定死，图片解码不会改变布局）。
      this.applyMasonryLayout();
      // 图片全部失败时给一格可见说明，别只在状态栏写一行小字
      if (rendered.length && this.failedImageCount >= rendered.length) {
        this.appendGridNotice(`本页 ${this.failedImageCount} 张预览全部加载失败 —— 检查 Clash 代理，或点工具条「刷新」绕过缓存重试`);
      }
      // 渲染完立即检查「填满没有」：首屏 / 翻页 / 换源 / 换筛选都要（见 scheduleAutoFill）
      this.scheduleAutoFill();
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
      // C站 / P站：契约只有 cursor + next_cursor（没有页码语义），所以只给「上一批 / 下一批」。
      // 不摆页码输入框 —— 那会变成一个"输了没反应"的控件（见 PLAN §5.3 分页一节）。
      if (!this.isDanbooruSource()) {
        const batch = this.cursorStack.length;
        const previous = document.createElement("button");
        previous.type = "button";
        previous.className = "adg-cursor-step"; // 页码按钮是固定 24px 宽，"下一批 ›" 会被挤成竖排
        previous.textContent = "‹ 上一批";
        previous.disabled = batch <= 1;
        previous.title = previous.disabled ? "已经是第一批" : "回到上一批（cursor 栈回退）";
        previous.onclick = () => { void this.stepGalleryCursor(-1); };
        const label = document.createElement("span");
        label.className = "adg-cursor-batch";
        label.textContent = `第 ${batch} 批`;
        label.title = "C站 / P站 用游标分页：只能顺序前进，没有跳页";
        const next = document.createElement("button");
        next.type = "button";
        next.className = "adg-cursor-step";
        next.textContent = "下一批 ›";
        next.disabled = !this.nextCursor;
        next.title = this.nextCursor ? "按后端返回的 next_cursor 取下一批" : "没有更多了";
        next.onclick = () => { void this.stepGalleryCursor(1); };
        this.pagination.append(previous, label, next);
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

    async choosePromptSaveOptions(post, { includeLocalCategory = false } = {}) {
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
      intro.textContent = includeLocalCategory
        ? "可在同一弹窗中分别勾选本地分类和 Prompt 入库；两项可同时执行，也可只执行其中一项。"
        : "选择本次入库的 Prompt 库分类，以及要写入 Prompt 和双语卡片的 D 站标签类别。不会修改全局 Prompt 设置。";
      content.append(intro);

      let saveLibraryInput = null;
      let assignLocalCategoryInput = null;
      let localCategorySelect = null;
      let localCategoryNameInput = null;
      if (includeLocalCategory) {
        const actionTitle = document.createElement("div");
        actionTitle.className = "adg-prompt-settings-title";
        actionTitle.textContent = "本次执行操作";
        const actionRow = document.createElement("div");
        actionRow.className = "adg-save-action-row";
        const localCategoryId = String(this.settings.postCategories[String(post.id || "")] || "");
        const makeAction = (label, checked) => {
          const wrapper = document.createElement("label");
          wrapper.className = "adg-save-action-choice";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = checked;
          const text = document.createElement("span");
          text.textContent = label;
          wrapper.append(input, text);
          actionRow.append(wrapper);
          return input;
        };
        // 兼容原“入库”按钮：默认仍然入 Prompt 库；若图片已有本地分类则同时保持该分类。
        saveLibraryInput = makeAction("存入 Prompt 库", true);
        assignLocalCategoryInput = makeAction("写入本地分类", Boolean(localCategoryId));
        content.append(actionTitle, actionRow);

        const localTitle = document.createElement("div");
        localTitle.className = "adg-prompt-settings-title";
        localTitle.textContent = "本地分类（勾选“写入本地分类”后生效）";
        localCategorySelect = document.createElement("select");
        localCategorySelect.className = "adg-save-category-select";
        localCategorySelect.setAttribute("aria-label", "本地分类");
        const renderLocalCategoryOptions = () => {
          const selected = localCategorySelect.value || localCategoryId;
          localCategorySelect.replaceChildren(new Option("无分类（移除归类）", ""));
          for (const category of (this.settings.categories || [])) {
            const option = new Option(String(category.name || category.id), String(category.id));
            localCategorySelect.append(option);
          }
          localCategorySelect.value = [...localCategorySelect.options].some((option) => option.value === selected) ? selected : "";
        };
        renderLocalCategoryOptions();
        const localNewRow = document.createElement("div");
        localNewRow.className = "adg-save-local-newrow";
        localCategoryNameInput = document.createElement("input");
        localCategoryNameInput.className = "adg-save-title-input";
        localCategoryNameInput.placeholder = "新建本地分类（可选）";
        const localNewButton = document.createElement("button");
        localNewButton.type = "button";
        localNewButton.className = "primary";
        localNewButton.textContent = "新建并选择";
        localNewButton.onclick = () => {
          const name = localCategoryNameInput.value.trim();
          if (!name) { localCategoryNameInput.focus(); return; }
          const existing = (this.settings.categories || []).find((category) => category.name === name);
          const category = existing || { id: `c_${Date.now()}`, name };
          if (!existing) this.settings.categories.push(category);
          renderLocalCategoryOptions();
          localCategorySelect.value = category.id;
          assignLocalCategoryInput.checked = true;
          localCategoryNameInput.value = "";
        };
        localNewRow.append(localCategoryNameInput, localNewButton);
        content.append(localTitle, localCategorySelect, localNewRow);
        // 保留原“分类”按钮的快捷能力：点当前图片标签即可新建并选中本地分类。
        const tagChoices = this.postTags(post).slice(0, 10);
        if (tagChoices.length) {
          const tagTitle = document.createElement("div");
          tagTitle.className = "adg-prompt-settings-tip";
          tagTitle.textContent = "从本图标签快速新建分类：";
          const tagWrap = document.createElement("div");
          tagWrap.className = "adg-category-tags";
          for (const tag of tagChoices) {
            const tagButton = document.createElement("button");
            tagButton.type = "button";
            tagButton.className = "adg-category-tag";
            tagButton.textContent = tag.replace(/_/g, " ");
            tagButton.onclick = () => {
              const name = tag.replace(/_/g, " ");
              const existing = (this.settings.categories || []).find((category) => category.name === name);
              const category = existing || { id: `c_${Date.now()}`, name };
              if (!existing) this.settings.categories.push(category);
              renderLocalCategoryOptions();
              localCategorySelect.value = category.id;
              assignLocalCategoryInput.checked = true;
            };
            tagWrap.append(tagButton);
          }
          content.append(tagTitle, tagWrap);
        }
      }

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
          title: includeLocalCategory ? `分类/入库 D 站 #${post.id || ""}` : `保存 D 站 #${post.id || ""} 到 Prompt 库`,
          content,
          onCancel: () => resolve(null),
          onApply: () => {
            const saveToLibrary = saveLibraryInput ? saveLibraryInput.checked : true;
            const assignLocalCategory = assignLocalCategoryInput ? assignLocalCategoryInput.checked : false;
            if (!saveToLibrary && !assignLocalCategory) {
              this.setStatus("至少选择“存入 Prompt 库”或“写入本地分类”其中一项", "error");
              return false;
            }
            const localCategoryId = localCategorySelect?.value || "";
            const localCategoryName = localCategorySelect?.selectedOptions?.[0]?.textContent || "无分类";
            if (!saveToLibrary) {
              resolve({ saveToLibrary: false, assignLocalCategory, localCategoryId, localCategoryName });
              return;
            }
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
              saveToLibrary: true,
              assignLocalCategory,
              localCategoryId,
              localCategoryName,
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

    async saveToPromptLibrary(post, { includeLocalCategory = false } = {}) {
      const imageUrl = post.large_file_url || post.file_url || post.preview_file_url;
      const saveOptions = await this.choosePromptSaveOptions(post, { includeLocalCategory });
      if (!saveOptions) return;
      const saveToLibrary = saveOptions.saveToLibrary !== false;
      if (saveOptions.assignLocalCategory) {
        const postId = String(post.id || "");
        if (saveOptions.localCategoryId) this.settings.postCategories[postId] = saveOptions.localCategoryId;
        else delete this.settings.postCategories[postId];
        this.saveSettings();
        this.renderPosts();
        this.filterControls?.refresh();
      }
      if (!saveToLibrary) {
        this.setStatus(`已更新 #${post.id || ""} 本地分类：${saveOptions.localCategoryName || "无分类"}`, "success");
        return;
      }
      if (!imageUrl) {
        this.setStatus(`保存 #${post.id || ""} 失败：帖子没有可用图片地址`, "error");
        return;
      }
      this.setStatus(`正在保存 #${post.id || ""} 到 Prompt 库…`);
      try {
        const imageResponse = await fetch(this.imageProxyUrl(imageUrl, "", this.postSourceId(post)));
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
          const categoryText = saveOptions.assignLocalCategory ? `，本地分类：${saveOptions.localCategoryName || "无分类"}` : "";
          this.setStatus(`已保存 #${post.id || ""}：Prompt 库 + 卡片库 ${cardResult.created} 张${cardResult.updated ? `，补全 ${cardResult.updated} 张` : ""}${missing ? `，${missing} 张待翻译` : ""}${categoryText}`);
        } else {
          const categoryText = saveOptions.assignLocalCategory ? `；本地分类已更新为${saveOptions.localCategoryName || "无分类"}` : "";
          this.setStatus(`已保存 #${post.id || ""} 到 Prompt 库，但卡片库同步失败：${cardError?.message || "未知错误"}${categoryText}`, "error");
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
      // 占位文案 → 真面板会让尺寸跳变（标签多时尤其明显），必须用同一个锚点重算位置，
      // 否则按"正在加载"的小尺寸定位出来的坐标，会被大面板直接撑到画廊上并溢出视口。
      this.positionTooltip();
      // 画廊源（C站/P站）的补充信息（负面提示词 / 采样参数 / 作者·收藏）追加在**同一个浮层**里。
      const galleryExtra = this.buildGalleryTooltipExtra(card);
      if (galleryExtra && this.tooltip === tooltip) {
        tooltip.append(galleryExtra);
        this.positionTooltip(); // 又长高了，同一个锚点再算一次
      }
    }

    /**
     * C站：负面提示词 + 采样参数（PLAN §5.2 item.meta）；P站：作者 / 收藏 / 标签体系提示。
     * 复用浮层现有的 section / line 类，不新增浮层、不新增控件。
     */
    buildGalleryTooltipExtra(card) {
      const sourceId = String(card?.dataset?.source || "");
      if (!sourceId || sourceId === DANBOORU_SOURCE_ID) return null;
      let meta = {};
      try { meta = JSON.parse(card.dataset.galleryMeta || "{}"); } catch { meta = {}; }
      const negative = String(card.dataset.negativePrompt || "").trim();
      const rows = [];
      const push = (label, value) => {
        const text = String(value ?? "").trim();
        if (text) rows.push([label, text]);
      };
      if (negative) push("负面", negative);
      if (sourceId === "civitai") {
        push("采样", [meta.sampler, meta.steps ? `${meta.steps} 步` : "", meta.cfgScale ? `CFG ${meta.cfgScale}` : ""].filter(Boolean).join(" · "));
        push("种子", meta.seed);
        // PLAN §6：meta.Model 不存在（那是模型版本端点的字段）→ 只用条目级 baseModel
        push("底模", meta.baseModel || meta.model);
      } else if (sourceId === "pixiv") {
        push("作者", meta.user_name || meta.author || meta.user);
        push("收藏", meta.bookmarks ?? meta.fav_count);
      }
      const hasPrompt = this.sourceCapabilities(sourceId).prompt;
      const extras = [];
      if (rows.length) {
        const section = document.createElement("section");
        section.className = "adg-prompt-tooltip-section";
        const heading = document.createElement("div");
        heading.className = "adg-prompt-tooltip-category";
        heading.textContent = sourceId === "civitai" ? "C站生成参数" : "P站信息";
        section.append(heading, ...rows.map(([label, value]) => {
          const line = document.createElement("div");
          line.className = "adg-prompt-tooltip-line";
          const name = document.createElement("span");
          name.textContent = label;
          const text = document.createElement("small");
          text.textContent = value;
          line.append(name, text);
          return line;
        }));
        extras.push(section);
      }
      if (!hasPrompt || sourceId === "pixiv") {
        const note = document.createElement("div");
        note.className = "adg-prompt-tooltip-note";
        note.textContent = sourceId === "pixiv"
          ? "P站标签为日文体系，与 Danbooru 词库不通用；用途是下载原图后交给 WD14 反推"
          : "C站无标签体系，这里显示的是原作者写的提示词与采样参数";
        extras.push(note);
      }
      if (!extras.length) return null;
      const wrap = document.createElement("div");
      wrap.className = "adg-prompt-tooltip-extra";
      wrap.append(...extras);
      return wrap;
    }

    positionTooltip(event) {
      if (!this.tooltip) return;
      // 记住锚点：内容异步加载完（"正在加载双语 Prompt…" → 真面板）尺寸会变，
      // 那时必须用**同一个锚点**重新定位，否则会以小尺寸算出的位置承载大尺寸内容，
      // 直接盖住画廊并溢出视口。
      if (event && typeof event.clientX === "number") {
        this.tooltipAnchor = { x: event.clientX, y: event.clientY };
      }
      const anchor = this.tooltipAnchor;
      if (!anchor) return;
      const padding = 12;
      const gap = 14;
      const rect = this.tooltip.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 先试右侧 / 下方；放不下就**翻到反侧**（而不是贴边硬塞 —— 那正是用户说的
      // "被浏览器边框挤着硬显示"）。两侧都放不下时才退回贴边钳制。
      let left = anchor.x + gap;
      if (left + rect.width + padding > vw) {
        const flipped = anchor.x - gap - rect.width;
        left = flipped >= padding ? flipped : Math.max(padding, vw - rect.width - padding);
      }
      let top = anchor.y + gap;
      if (top + rect.height + padding > vh) {
        const flipped = anchor.y - gap - rect.height;
        top = flipped >= padding ? flipped : Math.max(padding, vh - rect.height - padding);
      }
      this.tooltip.style.left = `${Math.round(left)}px`;
      this.tooltip.style.top = `${Math.round(top)}px`;
    }

    hidePromptTooltip() {
      this.tooltip?.remove();
      this.tooltip = null;
    }

    async downloadPost(post) {
      const sourceId = this.postSourceId(post);
      const isGallerySource = sourceId !== DANBOORU_SOURCE_ID;
      // P站 的用途是「下载原图 → WD14 反推」（PLAN §5.7），所以画廊源一律原图优先：
      // full_url 就是契约里的 original（各源适配器保证 original 优先、退回 large）。
      const imageUrl = isGallerySource
        ? (post.full_url || post.large_file_url || post.file_url || post.preview_url || post.preview_file_url)
        : (post.large_file_url || post.file_url || post.preview_file_url);
      if (!imageUrl) return;
      this.setStatus(`正在下载 #${post.id || ""}…`);
      try {
        // 一律走后端代理（P站 的 Referer 由后端按 images_headers() 附加）
        const response = await fetch(this.imageProxyUrl(imageUrl, "", sourceId));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = objectUrl;
        const prefix = isGallerySource ? sourceId : "danbooru";
        link.download = `${prefix}_${post.id || "image"}.${post.file_ext || "jpg"}`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        this.setStatus(`已开始下载 #${post.id || ""}${isGallerySource ? `（${this.sourceLabel(sourceId)} 原图）` : ""}`);
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
      const sourceId = this.postSourceId(post);
      // 视频帖没有可显示的"大图"（large 是 mp4）→ 用封面 jpg 兜底
      const imageUrl = isVid
        ? (post.preview_file_url || post.preview_url || post.large_file_url || "")
        : (post.large_file_url || post.full_url || post.file_url || post.preview_file_url || post.preview_url);
      if (!imageUrl) return;
      this.removeDialog();
      const overlay = document.createElement("div");
      overlay.id = this.dialogId;
      overlay.className = "adg-dialog-overlay adg-image-preview-overlay";
      const image = document.createElement("img");
      image.className = "adg-image-preview";
      image.alt = `${this.sourceLabel(sourceId)} #${post.id || ""}`;
      // 预览同样走后端代理（第三方 CDN 直连会踩防盗链：i.pximg.net 无 Referer 一律 403）
      image.src = this.imageProxyUrl(imageUrl, "", sourceId);
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
      saveButton.onclick = async () => {
        const name = nameInput.value.trim();
        if (!name) {
          nameInput.focus();
          this.setStatus("请输入预设名称", "error");
          return;
        }
        const query = this.queryWidget?.value || this.settings.lastQuery || "";
        const oldText = saveButton.textContent;
        saveButton.disabled = true;
        saveButton.textContent = "生成中文备注…";
        try {
          const preset = {
            name,
            query,
            note: await this.buildPresetNote(query),
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
        } catch (error) {
          this.setStatus(`生成中文备注失败：${error?.message || "未知错误"}`, "error");
        } finally {
          saveButton.disabled = false;
          saveButton.textContent = oldText;
        }
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
          const metaText = preset.note
            ? `${preset.note} · ${preset.query || "（无查询词）"}`
            : (preset.query || "（无查询词）");
          meta.textContent = metaText;
          meta.title = metaText;
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
      void this.hydratePresetNotes(renderRows);
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

    /**
     * 读密钥状态（PLAN §5.5）。C站 走 /anima/gallery/secrets（**只回掩码，绝不回明文**）；
     * P站 走 /anima/gallery/pixiv/auth/status。两处分别读，互不依赖。
     */
    async refreshGallerySecretState() {
      const state = {
        civitai: { configured: false, masked: "", error: "" },
        pixiv: { logged_in: false, available: true, error: "" },
      };
      try {
        const response = await fetch("/anima/gallery/secrets");
        const data = await response.json().catch(() => null);
        if (response.ok) {
          state.civitai.configured = Boolean(data?.civitai?.configured);
          // 后端只给 `前4…后4` 掩码；前端**不得**把它当明文用，也不得回显用户刚输入的 key
          state.civitai.masked = String(data?.civitai?.masked || "");
        } else {
          state.civitai.error = String(data?.error || `HTTP ${response.status}`);
        }
        // P站：available=false = 后端模块没装；true+logged_in=false = 装了没登录。
        // 两种状态文案必须分开（协调者 2026-09-15：否则用户会去点"去授权"点不动）。
        if (data?.pixiv && typeof data.pixiv === "object") {
          state.pixiv.available = data.pixiv.available !== false;
          state.pixiv.logged_in = Boolean(data.pixiv.logged_in);
        }
      } catch (error) {
        state.civitai.error = error?.message || "请求失败";
      }
      try {
        const response = await fetch("/anima/gallery/pixiv/auth/status");
        const data = await response.json().catch(() => null);
        if (response.ok) {
          state.pixiv.logged_in = Boolean(data?.logged_in);
          if (data?.available === false) state.pixiv.available = false;
        } else {
          state.pixiv.error = String(data?.error || `HTTP ${response.status}`);
        }
      } catch (error) {
        state.pixiv.error = error?.message || "请求失败";
      }
      this.gallerySecretState = state;
      return state;
    }

    /** P站 三种状态的文案：没装 / 装了没登录 / 已授权（不能混成两种） */
    pixivStatusText(info = {}) {
      if (info.error) return `读取失败：${info.error}`;
      if (info.available === false) return "后端未安装 P站 模块（anima_gallery_pixiv.py）—— 该图源不可用";
      if (info.logged_in) return "已授权（refresh_token 已存 data/pixiv_token.json）";
      return "未授权：P站 没有匿名搜索，必须先授权一次";
    }

    /**
     * C站 诊断入口（GET /anima/gallery/civitai/diag，仿 D站 /anima/danbooru/diag）。
     * ⚠️ 只渲染**白名单标量字段**：任何形如 token/secret/verifier 的键一律不显示，
     *    key 只显示后端给的掩码字段（`masked`），避免把诊断面板变成明文泄露面。
     */
    async renderCivitaiDiag(target) {
      if (!target) return;
      target.textContent = "正在读取诊断信息…";
      try {
        const response = await fetch("/anima/gallery/civitai/diag");
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        const blocked = /token|secret|verifier|password/i;
        const lines = [];
        const walk = (value, prefix = "") => {
          if (value == null || lines.length >= 12) return;
          if (typeof value === "object") {
            for (const [key, child] of Object.entries(value)) {
              if (blocked.test(key)) continue;
              walk(child, prefix ? `${prefix}.${key}` : key);
              if (lines.length >= 12) return;
            }
            return;
          }
          const name = prefix.toLowerCase();
          const text = String(value);
          // 兜底：形如 api_key 的字段若没带掩码省略号（=> 可能是真明文），一律不显示原值
          const looksLikeRawKey = /(^|[._])key$/.test(name) && text.length > 12 && !text.includes("…");
          lines.push(`${prefix || "值"}：${looksLikeRawKey ? "（已隐藏：只允许显示掩码）" : text}`);
        };
        walk(data);
        target.textContent = lines.length ? lines.join("\n") : "诊断返回空";
      } catch (error) {
        target.textContent = `诊断失败：${error?.message || "未知错误"}`;
      }
    }

    /** 状态点 + 一行说明（颜色走主题变量，不用 emoji） */
    makeSecretStatusRow(label) {
      const row = document.createElement("div");
      row.className = "adg-secret-status";
      const dot = document.createElement("span");
      dot.className = "adg-secret-dot";
      dot.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "adg-secret-name";
      name.textContent = label;
      const text = document.createElement("span");
      text.className = "adg-secret-text";
      row.append(dot, name, text);
      return { row, dot, text };
    }

    /**
     * 「图源密钥」一节（PLAN §5.5）。C站：key 输入 + 测试 + 状态点；P站：登录状态 + 去授权 + 粘 code。
     * ⚠️ 明文 key 只存在于用户当前输入的那个 input 里，保存后立刻清空并重新读掩码 —— 不落 dataset、
     *    不写日志、不进 title/aria-label。
     */
    buildSourceSecretsSection() {
      const section = document.createElement("section");
      section.className = "adg-settings-section adg-source-secrets";
      const title = document.createElement("div");
      title.className = "adg-settings-title";
      title.textContent = "图源密钥";
      const help = document.createElement("div");
      help.className = "adg-settings-help";
      // PLAN §6 实测修正：key 对 /api/v1/images **没有可见影响**（无 key / 真 key / 假 key 回包逐字节相同，
      // 连 nsfw=X 都匿名可读）→ key 的价值是**账号校验**（GET /api/v1/me），不是 NSFW 开关。
      help.textContent = "C站 key 仅用于账号校验（/api/v1/me）；图片端点匿名即可读，含 Mature / X —— key 不会改变 /images 回包。两个源的凭证都只存本机 data/（不进 git），界面只显示掩码。";
      section.append(title, help);

      // ── C站 ──
      const civitai = this.makeSecretStatusRow("C站 API Key");
      const civitaiMask = document.createElement("code");
      civitaiMask.className = "adg-secret-mask";
      civitaiMask.title = "只显示掩码，明文不会回显";
      const civitaiRow = document.createElement("div");
      civitaiRow.className = "adg-settings-inline-row";
      const civitaiInput = document.createElement("input");
      civitaiInput.type = "password";
      civitaiInput.className = "adg-settings-input";
      civitaiInput.autocomplete = "off";
      civitaiInput.placeholder = "粘贴新的 API Key（保存后只显示掩码）";
      const civitaiSave = document.createElement("button");
      civitaiSave.type = "button";
      civitaiSave.className = "primary adg-settings-inline-button";
      civitaiSave.textContent = "保存";
      const civitaiTest = document.createElement("button");
      civitaiTest.type = "button";
      civitaiTest.className = "adg-settings-inline-button";
      civitaiTest.textContent = "测试";
      const civitaiClear = document.createElement("button");
      civitaiClear.type = "button";
      civitaiClear.className = "adg-settings-inline-button";
      civitaiClear.textContent = "清除";
      civitaiRow.append(civitaiInput, civitaiSave, civitaiTest, civitaiClear);
      civitai.row.append(civitaiMask);
      const civitaiDiagBtn = document.createElement("button");
      civitaiDiagBtn.type = "button";
      civitaiDiagBtn.className = "adg-settings-inline-button";
      civitaiDiagBtn.textContent = "诊断";
      civitaiDiagBtn.title = "读取 /anima/gallery/civitai/diag（注册状态 / 代理 / key 掩码），不显示任何明文";
      const civitaiDiag = document.createElement("pre");
      civitaiDiag.className = "adg-diag-output";
      civitaiDiag.hidden = true;
      civitaiDiagBtn.onclick = async () => {
        civitaiDiag.hidden = false;
        await this.renderCivitaiDiag(civitaiDiag);
      };
      civitaiRow.append(civitaiDiagBtn);
      section.append(civitai.row, civitaiRow, civitaiDiag);

      const syncCivitai = (state = this.gallerySecretState) => {
        const info = state?.civitai || {};
        civitai.dot.classList.toggle("is-on", Boolean(info.configured));
        civitai.dot.classList.toggle("is-off", !info.configured);
        civitai.text.textContent = info.error
          ? `读取失败：${info.error}`
          : (info.configured ? `已配置（${info.masked || "掩码不可用"}）` : "未配置");
        civitaiMask.textContent = info.configured ? String(info.masked || "••••") : "—";
        civitaiClear.disabled = !info.configured;
      };
      const postCivitaiSecret = async (key) => {
        const response = await fetch("/anima/gallery/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "civitai", key: String(key || "") }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        return data;
      };
      civitaiSave.onclick = async () => {
        const value = civitaiInput.value.trim();
        if (!value) { civitaiInput.focus(); return; }
        civitaiSave.disabled = true;
        try {
          await postCivitaiSecret(value);
          civitaiInput.value = ""; // 明文立刻丢弃：只保留后端回的掩码
          const state = await this.refreshGallerySecretState();
          syncCivitai(state);
          this.setStatus("C站 API Key 已保存（明文不回显，界面只显示掩码）", "success");
        } catch (error) {
          this.setStatus(`保存 C站 Key 失败：${error?.message || "未知错误"}`, "error");
        }
        civitaiSave.disabled = false;
      };
      civitaiClear.onclick = async () => {
        civitaiClear.disabled = true;
        try {
          await postCivitaiSecret("");
          const state = await this.refreshGallerySecretState();
          syncCivitai(state);
          this.setStatus("已清除 C站 API Key");
        } catch (error) {
          this.setStatus(`清除失败：${error?.message || "未知错误"}`, "error");
        }
        civitaiClear.disabled = false;
      };
      civitaiTest.onclick = async () => {
        civitaiTest.disabled = true;
        civitaiTest.textContent = "测试中…";
        try {
          const response = await fetch("/anima/gallery/secrets/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: "civitai" }),
          });
          const data = await response.json().catch(() => null);
          const ok = response.ok && data?.ok !== false;
          civitai.dot.classList.toggle("is-on", ok);
          civitai.dot.classList.toggle("is-off", !ok);
          civitai.text.textContent = String(data?.message || (ok ? "连接正常" : `HTTP ${response.status}`));
          this.setStatus(`C站 Key 测试：${data?.message || (ok ? "连接正常" : "失败")}`, ok ? "success" : "error");
        } catch (error) {
          civitai.text.textContent = `测试失败：${error?.message || "未知错误"}`;
          this.setStatus(`C站 Key 测试失败：${error?.message || "未知错误"}`, "error");
        }
        civitaiTest.disabled = false;
        civitaiTest.textContent = "测试";
      };

      // ── P站（OAuth 2.0 + PKCE：拿授权 URL → 用户粘 code 回来）──
      const pixiv = this.makeSecretStatusRow("P站 登录");
      const pixivRow = document.createElement("div");
      pixivRow.className = "adg-settings-inline-row";
      const pixivAuth = document.createElement("button");
      pixivAuth.type = "button";
      pixivAuth.className = "primary adg-settings-inline-button";
      pixivAuth.textContent = "去授权";
      pixivAuth.title = "在新标签页打开 Pixiv 授权页；授权后把回调地址里的 code 粘回下面的输入框";
      const pixivCode = document.createElement("input");
      pixivCode.className = "adg-settings-input";
      pixivCode.autocomplete = "off";
      pixivCode.placeholder = "粘贴授权后拿到的 code（或完整回调地址）";
      const pixivSubmit = document.createElement("button");
      pixivSubmit.type = "button";
      pixivSubmit.className = "adg-settings-inline-button";
      pixivSubmit.textContent = "完成授权";
      const pixivLink = document.createElement("span");
      pixivLink.className = "adg-settings-help";
      pixivRow.append(pixivAuth, pixivCode, pixivSubmit);
      section.append(pixiv.row, pixivRow, pixivLink);

      const syncPixiv = (state = this.gallerySecretState) => {
        const info = state?.pixiv || {};
        const available = info.available !== false;
        pixiv.dot.classList.toggle("is-on", Boolean(info.logged_in));
        pixiv.dot.classList.toggle("is-off", !info.logged_in);
        pixiv.text.textContent = this.pixivStatusText(info);
        // 模块没装 → 授权按钮没有意义，禁用而不是让人点了报错
        pixivAuth.disabled = !available;
        pixivSubmit.disabled = !available;
        pixivCode.disabled = !available;
        pixivAuth.title = available
          ? "在新标签页打开 Pixiv 授权页；授权后把回调地址里的 code 粘回下面的输入框"
          : "后端没有 anima_gallery_pixiv.py，P站 图源不可用";
        if (this.sourceSelect) {
          const option = [...this.sourceSelect.options].find((o) => o.value === "pixiv");
          if (option) option.title = available ? "" : "后端未安装 P站 模块";
        }
      };
      this.pixivVerifier = "";
      pixivAuth.onclick = async () => {
        pixivAuth.disabled = true;
        try {
          const response = await fetch("/anima/gallery/pixiv/auth/url");
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.url) throw new Error(data?.error || `HTTP ${response.status}`);
          // PKCE verifier 由后端持有也行；若它回传了就带回去（契约字段 verifier_hint）
          this.pixivVerifier = String(data?.verifier || data?.verifier_hint || "");
          window.open(String(data.url), "_blank", "noopener,noreferrer");
          pixivLink.textContent = "已打开授权页：登录 Pixiv 后把地址栏里的 code（或回调整条 URL）粘到上面输入框，点「完成授权」。";
          pixivCode.focus();
        } catch (error) {
          pixivLink.textContent = `获取授权地址失败：${error?.message || "未知错误"}`;
          this.setStatus(`P站 授权失败：${error?.message || "未知错误"}`, "error");
        }
        pixivAuth.disabled = false;
      };
      pixivSubmit.onclick = async () => {
        const raw = pixivCode.value.trim();
        if (!raw) { pixivCode.focus(); return; }
        // 用户可能整条回调 URL 粘进来 → 取出 code 参数
        let code = raw;
        try {
          const parsed = new URL(raw);
          code = parsed.searchParams.get("code") || raw;
        } catch { /* 不是 URL，就当 code 用 */ }
        pixivSubmit.disabled = true;
        pixivSubmit.textContent = "授权中…";
        try {
          const response = await fetch("/anima/gallery/pixiv/auth/code", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, verifier: this.pixivVerifier || "" }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
          pixivCode.value = "";
          const state = await this.refreshGallerySecretState();
          syncPixiv(state);
          const ok = data?.ok !== false && state.pixiv.logged_in;
          this.setStatus(`P站 授权：${data?.message || (ok ? "成功" : "未确认登录状态")}`, ok ? "success" : "error");
        } catch (error) {
          this.setStatus(`P站 授权失败：${error?.message || "未知错误"}`, "error");
        }
        pixivSubmit.disabled = false;
        pixivSubmit.textContent = "完成授权";
      };

      syncCivitai();
      syncPixiv();
      void this.refreshGallerySecretState().then((state) => {
        syncCivitai(state);
        syncPixiv(state);
      });
      return section;
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
      // 0 = 自适应：按节点尺寸算出「刚好填满一屏」的张数（列数 × 可视行数），
      // 节点越宽越高，自动显示越多，不再固定 24/48 让大节点半屏空白。
      select.add(new Option("自适应（按节点大小）", "0", false, !this.settings.limit));
      [12, 24, 48].forEach((limit) => select.add(new Option(String(limit), String(limit), false, limit === this.settings.limit)));
      select.title = "自适应 = 按节点宽高算出刚好填满的图片数量；拖动节点改变大小后会自动重算";
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
      // 排除标签是**按 Danbooru 标签**本地过滤的（见 search 里的 tag_string 过滤），
      // 因此只在 D站 有意义：C站 无标签体系、P站 是日文标签，控件禁用而不是留个"填了没用"的输入框。
      const excludeApplicable = this.isDanbooruSource();
      if (!excludeApplicable) {
        exclInput.disabled = true;
        exclAdd.disabled = true;
        exclTip.textContent = `排除标签按 Danbooru 标签本地过滤，只在 D站 生效；当前图源是${this.sourceLabel()}。`;
      }
      content.append(excludeSection);
      // ── 图源密钥（C站 API Key / P站 OAuth）：PLAN §5.5 ──
      content.append(this.buildSourceSecretsSection());

      // ── D站 账号（上限按等级：Member=2、Gold=6、Platinum+=不限；登录后限流更宽）──
      const accountSection = document.createElement("section");
      accountSection.className = "adg-settings-section adg-account-section";
      const accTitle = document.createElement("div");
      accTitle.className = "adg-settings-title";
      accTitle.textContent = "Danbooru 账号";
      this.refreshAccount().then((reg) => {
        content.querySelector(".adg-account-status")?.remove();
        const status = document.createElement("div");
        status.className = "adg-account-status";
        status.textContent = reg
          ? `✓ 已登录 Danbooru（账号等级上限 ${this.tagLimit()} 个计数标签；Gold 及以上为 6）`
          : "ℹ 未登录：最多 2 个计数标签。登录后上限按账号等级计算（Member 仍为 2，Gold 为 6，Platinum 及以上不限）。";
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
      tip.textContent = "凭证仅存本机插件目录，不上传。清空保存 = 退出登录。只影响 D站 图源（C站/P站 的凭证见上一节「图源密钥」）。";
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
          if (!r.ok) throw new Error(j?.error || "保存登录失败");
          this.registered = Boolean(j?.logged_in);
          if (typeof j?.tag_limit === "number") this.tagLimitValue = j.tag_limit;
          // POST 返回的上限是权威值；刷新 accountReady，避免 search() 等待仍指向旧登录状态。
          this.accountReady = Promise.resolve(this.registered);
          const st = content.querySelector(".adg-account-status");
          if (st) st.textContent = this.registered ? `✓ 已登录 · ${j?.username || ""}` : "ℹ 已退出（匿名 2 标签限制）";
          this.setStatus(this.registered ? `D站 登录成功，账号当前计数标签上限 ${this.tagLimitValue} 个` : "D站 已退出登录", "success");
          await this.search({ resetPage: true });
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
      // 通过阻止事件继续冒泡 + 下一帧补焦点来激活输入框，但不能 preventDefault，
      // 否则浏览器无法根据鼠标落点更新原生 input 的 caret。
      const focusLock = () => {
        requestAnimationFrame(() => {
          try { if (document.activeElement !== queryInput) queryInput.focus({ preventScroll: true }); } catch {}
        });
      };
      queryInput.addEventListener("pointerdown", (e) => { e.stopPropagation(); focusLock(); });
      queryInput.addEventListener("mousedown", (e) => { e.stopPropagation(); focusLock(); });
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
      this.queryRow = queryRow;
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
      this.filterGroup = filterGroup;
      this.categoryGroup = categoryGroup;
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
      // ── 图源下拉（D站 / C站 / P站）──
      // 注意：这个容器用**新类名** adg-source-picker，不占 .adg-toolbar-group ——
      // tests/verify_tk_prompt_output.py 断言分组数恰为 4，新增分组会把它弄红。
      {
        const picker = document.createElement("label");
        picker.className = "adg-source-picker";
        picker.title = "切换图源：D站 / C站 / P站（切换后筛选控件按该源的能力自动收放）";
        const icon = galleryIcon("image", 13, "adg-icon adg-source-icon");
        const select = document.createElement("select");
        select.className = "adg-source-select";
        select.setAttribute("aria-label", "图源");
        for (const id of GALLERY_SOURCE_ORDER) {
          select.append(new Option(GALLERY_SOURCE_FALLBACK[id].label, id));
        }
        select.value = this.activeSourceId();
        select.onchange = () => { void this.switchGallerySource(select.value); };
        picker.append(icon, select);
        this.sourcePicker = picker;
        this.sourceSelect = select;
        mainGroup.append(picker);
      }
      addAction("搜索", "按上方标签搜索", () => this.search({ resetPage: true }), mainGroup).className = "adg-primary-action";
      // ── 随机发现：order:random + 质量地板。三档质量让用户挑口味，而不是给一个
      //    「随机」开关把没人贴过的冷门图倒进来（见 RANDOM_QUALITY_TIERS 注释）。
      {
        const tierButtons = [];
        for (const tier of RANDOM_QUALITY_TIERS) {
          const btn = addAction(tier.label, `随机发现：${tier.hint}（再点一次退出随机）`, () => {
            if (this.settings.randomQuality === tier.id) void this.exitRandom();
            else void this.discoverRandom(tier.id);
          }, mainGroup);
          btn.className = "adg-random-btn";
          btn.dataset.tier = tier.id;
          tierButtons.push(btn);
        }
        const reshuffleBtn = addAction("换一批", "重新随机一次，并避开本档已看过的图", () => {
          void this.discoverRandom(this.settings.randomQuality || "good", { reshuffle: true });
        }, mainGroup);        reshuffleBtn.className = "adg-random-reshuffle";
        this.randomTierButtons = () => {
          for (const btn of tierButtons) btn.classList.toggle("active", this.settings.randomQuality === btn.dataset.tier);
          const on = Boolean(this.settings.randomQuality);
          // 工具栏按钮的禁用样式由 .is-disabled 承载（CSS 里没有 :disabled 规则）
          reshuffleBtn.disabled = !on;
          reshuffleBtn.classList.toggle("is-disabled", !on);
          reshuffleBtn.title = on ? "重新随机一次，并避开本档已看过的图" : "先选一个随机档位";
        };
        this.randomTierButtons();
        // 随机发现是 order:random + D站 评分地板：换源时整组隐藏（capabilities 驱动）
        this.randomTierButtonList = tierButtons;
        this.randomReshuffleBtn = reshuffleBtn;
      }
      addAction("设置", "设置画廊显示、排除标签和 Danbooru 登录", () => this.openSettings(), mainGroup);
      this.promptSettingsBtn = addAction("Prompt设置", "控制 Prompt 输出类别与格式", () => this.openPromptSettings(), mainGroup);
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
      // 源专属筛选（C站 分级/排序、P站 匹配/排序）：容器用新类名 adg-source-filters，
      // **不占** .adg-toolbar-group（E2E 断言分组数恰为 4，新分组会把它弄红）。
      this.sourceFilterHost = this.buildSourceFilterControls();
      mainGroup.after(this.sourceFilterHost);
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
      this.setupImageLoading();
      this.applyGridHeight();
      // Chrome 下新 ComfyUI 节点激活层可能先命中 node-body，导致 DOM
      // 控件“看得见但鼠标点不到”。只从同一节点的命中栈中恢复控件点击，
      // 不穿透到被其他节点遮住的画廊，避免误触别的节点。
      const recoverPointer = (event) => {
        if (!this.root?.isConnected) return;
        const stack = document.elementsFromPoint(event.clientX, event.clientY);
        // Portal/Modal 自己拥有该坐标的交互权。recoverPointer 只负责修复
        // LiteGraph 面罩遮住的“节点内控件”，不能穿过任何外部浮层。
        if (stack.some((element) => element.closest?.(PORTAL_INTERACTION_SELECTOR))) return;
        const candidate = stack
          .map((element) => element.closest?.("button, input, select, textarea, [role='button']"))
          .find((element) => element && this.root.contains(element));
        if (!candidate || event.target === candidate || candidate.contains(event.target)) return;
        const candidateNode = candidate.closest?.("[data-node-id]")?.dataset.nodeId;
        // ⚠️ 判据必须是「事件真正的目标属于哪个节点」，不能用“栈里第一个带 data-node-id 的元素”。
        //    点 ComfyUI 自己的按钮（画布工具栏 / 顶部菜单）时，那个按钮不属于任何节点，
        //    旧写法会一路往下找到**下面的画廊节点本身**，于是判定为“同一个节点”而放行 →
        //    补发点击 → 穿透到同坐标下的卡片，参考图被换成用户没想选的图。
        //    现在要求目标本身落在本节点内（含节点激活面罩），否则一律不补发。
        const targetNode = (event.target instanceof Element
          ? event.target.closest?.("[data-node-id]")?.dataset.nodeId
          : undefined) ?? null;
        if (!targetNode || (candidateNode && targetNode !== candidateNode)) return;
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
      // 图源能力（capabilities）驱动控件可见性；/anima/gallery/sources 是异步补全，
      // 拿不到就用契约兜底表，界面不会因为后端没就绪而缺控件或报错。
      this.applySourceCapabilities();
      void this.loadGallerySources().then(() => {
        if (!this.disposed && this.root) this.applySourceCapabilities();
      });
      // 密钥/授权状态也预热一次：换源到 P站 时要立刻知道"模块没装"还是"没登录"（见 switchGallerySource）
      void this.refreshGallerySecretState();
      this.accountReady = this.refreshAccount();
      this.initialSearchTimer = setTimeout(async () => {
        this.initialSearchTimer = null;
        try { await this.accountReady; } catch {}
        // addDOMWidget 的挂载可能晚于 build()，但 root 已经是当前节点的权威界面；
        // 不以 isConnected 为条件，避免 Chrome 首次绘制较慢时直接漏掉自动搜索。
        if (!this.disposed && this.root) this.search({ resetPage: true });
      }, 120);
      return root;
    }

    dispose() {
      this.disposed = true;
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
      this.imageLoadObserver?.disconnect();
      this.imageLoadObserver = null;
      this.gridResizeObserver?.disconnect();
      this.gridResizeObserver = null;
      if (this.masonryLayoutFrame) {
        cancelAnimationFrame(this.masonryLayoutFrame);
        this.masonryLayoutFrame = null;
      }
      if (this.resizeSearchTimer) {
        clearTimeout(this.resizeSearchTimer);
        this.resizeSearchTimer = null;
      }
      // 自动补满的定时器：节点销毁后不能再排补图请求
      if (this.autoFillTimer) {
        clearTimeout(this.autoFillTimer);
        this.autoFillTimer = null;
      }
      if (this.grid) this.grid.style.minHeight = "";
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
    link.href = new URL("../css/anima_danbooru_gallery.css", import.meta.url).href;
    document.head.append(link);
  }

  app.registerExtension({
    name: "Anima.DanbooruGallery",
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_NAME) return;
      injectStylesheet();
      const originalCreated = nodeType.prototype.onNodeCreated;
      const originalConfigured = nodeType.prototype.onConfigure;
      nodeType.prototype.onNodeCreated = function () {
        const result = originalCreated?.apply(this, arguments);
        if (this._animaDanbooruGallery) return result;
        const ui = new DanbooruGalleryUI(this);
        this._animaDanbooruGallery = ui;
        const selectionWidget = this.addWidget?.("text", "selection_data", "{}", () => {}, { serialize: true });
        if (selectionWidget) {
          // hidden/options.hidden 必须「就地」写入（见 3D 相机同名注释），
          // 否则新前端仍会渲染该行并留一个整宽遗留 <canvas>。
          selectionWidget.hidden = true;
          selectionWidget.options = selectionWidget.options || {};
          selectionWidget.options.hidden = true;
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
        // 尺寸 owner = **用户/工作流保存的节点尺寸**，不是图片内容。
        // ① 初始高度取「节点当前高度」而不是 settings.gridHeight —— 后者可能已被历史撑大污染成上限；
        // ② min/max 钉成同一个值 ⇒ 新前端布局器没有"按内容分配"的余地；
        // ③ 用户拖动后由 onResize 把这两个值跟到新尺寸（见下），布局器始终没有自主权。
        //    （2026-09-16 用户：「节点大小完全限制于我的设定，不要因为图像而改变，也不要自主变大变小」）
        const lockedHeight = Math.max(360, Math.round((this.size?.[1] || 0) - 95) || ui.settings.gridHeight || 620);
        ui.lockedHeight = lockedHeight;
        ui.domSizeSync = installDOMWidgetSizeSync({
          node: this,
          domWidget,
          element,
          minHeight: lockedHeight,
          maxHeight: lockedHeight,
          initialContentHeight: lockedHeight,
          nodeChromeHeight: 95,
          onContentHeight: (height) => {
            // 只记录，**绝不**用内容高度反过来改节点尺寸
            ui.settings.gridHeight = height;
          },
        });
        // installDOMWidgetSizeSync 已经包了一层 node.onResize；这里**再包一层**（链式调用，
        // 不影响它）。目的是把「用户拖动节点尺寸」与「程序化 setSize」区分开：前者一经发生，
        // 本次结果集内的自动收缩就此停手 —— 否则用户手动放大的尺寸会被下一帧缩回去，
        // 表现就是"放回大小后不填充满"。
        const sizeSyncOnResize = this.onResize;
        this.onResize = function (...args) {
          const result = sizeSyncOnResize?.apply(this, args);
          const uiRef = this._animaDanbooruGallery;
          uiRef?.noteExternalResize?.();
          // 用户拖动结束后把新高度写进工作流属性：过去只改内存（syncNow 走的是
          // notifyContentHeight(false) ⇒ 从不 commit），于是刷新/重启又回到旧的大高度
          // —— 用户看到的"缩小了又自己变回去"有这一半原因。
          if (uiRef) {
            // ① **立即**把「固定区间」跟到当前尺寸：否则拖动过程中 min/max 还停在旧值，
            //    布局器会按旧区间把节点拉回去（表现为拖不动 / 回弹）。
            const nowHeight = Math.round((this.size?.[1] || 0) - 95);
            if (nowHeight > 0) {
              uiRef.domSizeSync?.setBounds?.(nowHeight, nowHeight);
              uiRef.lockedHeight = nowHeight;
            }
            // ② 拖动结束后再持久化（写工作流属性 + 标记改动，需要节流）
            clearTimeout(uiRef.gridHeightCommitTimer);
            uiRef.gridHeightCommitTimer = setTimeout(() => {
              const height = Number(uiRef.grid?.clientHeight) || 0;
              if (!(height > 0)) return;
              if (Math.abs(height - (Number(uiRef.settings?.gridHeight) || 0)) > 2) {
                uiRef.settings.gridHeight = height;
                uiRef.saveSettings();
              }
            }, 400);
          }
          return result;
        };
        const originalRemoved = this.onRemoved;
        this.onRemoved = function () {
          this._animaDanbooruGallery?.dispose();
          return originalRemoved?.apply(this, arguments);
        };
        return result;
      };
      nodeType.prototype.onConfigure = function () {
        const result = originalConfigured?.apply(this, arguments);
        this._animaDanbooruGallery?.loadWorkflowSettings();
        return result;
      };
    },
  });
})();
