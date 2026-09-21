import { app } from "/scripts/app.js";
import { GalleryFilterControls, FILTER_DEFAULTS, normalizeFilters, normalizeRatings } from "./anima_danbooru_filter_controls.js";
import { installDOMWidgetSizeSync } from "./anima_dom_widget_size_sync.js";

(() => {
  const NODE_NAME = "DanbooruGallery";
  const STORAGE_KEY_PREFIX = "anima_danbooru_gallery_settings_v2:";
  const LEGACY_STORAGE_KEY = "anima_danbooru_gallery_settings_v1";
  const LEGACY_MIGRATED_KEY = `${STORAGE_KEY_PREFIX}legacy_migrated`;
  // 一次性标记：本浏览器里"**其它**画廊节点"的旧分类是否已并入共享库。
  // 为什么需要：分类库后端化时只迁移了"当前节点"的 settings，而 localStorage 里
  // 每个画廊节点各存一份（key = 前缀 + 节点 id）。别的节点里的归类从来没被迁移过
  // ⇒ 用户更新后会看到"我分类里的图片少了好几张"（2026-09-20 实报）。
  const OTHERS_MIGRATED_KEY = `${STORAGE_KEY_PREFIX}categories_migrated_others`;
  // ⚠️ 卡片上的「★ 收藏」功能已于 2026-09-21 移除（用户裁决：与分类功能重合且无使用入口）。
  //    实测它当时**只有装饰作用**：全文件没有任何地方读 favorites 做筛选/排序，
  //    入库时的 `isFavorite: false` 是硬编码常量、与这个按钮无关，唯一效果是卡片描边变黄。
  //    旧数据（localStorage 的 anima_danbooru_gallery_favorites_v1）留着不清理，无害。
  // 搜索历史：**每节点一份**（前缀 + nodeId，与 settings 一致），值形如
  //   { "danbooru": ["1girl solo", …], "civitai": […], "pixiv": […] }
  const SEARCH_HISTORY_KEY_PREFIX = "anima_danbooru_gallery_search_history_v1_";
  /** 每个图源各留最近多少条。12 条 ≈ 一屏可见，且 localStorage 占用可忽略（一条平均 ~20 字符）。 */
  const SEARCH_HISTORY_LIMIT = 12;
  /** 单条查询串的存储上限 —— 防手改 localStorage 塞进超长串把浮层撑爆（条数上限管不到单条长度） */
  const SEARCH_HISTORY_ITEM_MAX = 200;
  /**
   * 搜索历史的**去重键**：大小写不敏感，下划线 / 加号与空格等价
   *（D站 里 `long_hair` 与 `long hair` 是同一个标签，不该在历史里占两行）。
   * ⚠️ 只用于判重 —— 显示与实际搜索都用用户输入的**原文**。
   */
  function searchHistoryKeyOf(value) {
    return String(value || "").trim().toLowerCase().replace(/[_+]+/g, " ").replace(/\s+/g, " ");
  }
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
  // Portal/浮层自己拥有其坐标上的交互权，recoverPointer 不得穿过它们补发点击。
  // ⚠️ .adg-prompt-tooltip 只有 **D站** 卡片上的浮层才是 pointer-events: auto（.is-danbooru）；
  //    pointer-events: none 的元素不进 elementsFromPoint 的命中栈，所以这条对 C站 的浮层天然不生效 ——
  //    加进来是显式声明"浮层的点击归浮层"，不再依赖 targetNode 恰好为 null 这个隐式巧合。
  const PORTAL_INTERACTION_SELECTOR = ".adg-suggestions, .adg-portal-menu, .adg-dialog-overlay, .adg-prompt-tooltip";
  const PROMPT_CATEGORY_ORDER = Object.freeze(["artist", "copyright", "character", "general", "meta"]);
  // 悬停浮层的「延迟隐藏」窗口：鼠标要从卡片移到浮层上，中间必然穿过卡片外的一瞬。
  // 太短 = 还没移进去就没了；太长 = 鼠标已经走开了浮层还挂着。
  // 取 280ms（而不是更短的 180ms）：浮层被视口边缘翻转/钳制时可能落在离光标 300px 开外
  //（窄视口 + 光标在左半屏，见 positionTooltip 的钳制分支），180ms 内跨过去要超过 1.7 m/s
  // 的手速 —— 慢速移动就会变成"浮层先消失"。
  const PROMPT_TOOLTIP_HIDE_DELAY = 280;
  // 悬停浮层的「延迟显示」：光标停在卡片上这么久才弹。
  // 为什么必须有它（2026-09-21 真机反馈）：原实现是一进入卡片就弹 + 浮层跟着光标跑，
  // 而 2.19 给浮层里的标签加了「点击即搜索」—— 想去点标签时光标一动浮层就跟着挪，永远点不到。
  // 现在改成「停留才弹 + 位置冻结（见 positionTooltip 的锚点）」，350ms 既不会"划过就闪一堆浮层"，
  // 也不至于让用户等；再配合下面的延迟隐藏，光标才腾得出来移进浮层点标签。
  const PROMPT_TOOLTIP_SHOW_DELAY = 350;
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
   * `page_numbers` 是第 6 键（2026-09-16）：源是否支持**页码分页**。true → 页码按钮 + 跳页框
   * （page 参数）；false → 游标分页（cursor + next_cursor，只能顺序前进）。
   * ⚠️ **D站 不在 `/anima/gallery/sources` 的回包里**（真机只有 civitai / pixiv 两个源），
   *    它完全靠这张兜底表——所以 D站 的 `page_numbers: true` 必须写在这里，否则
   *    `sourceCapabilities()` 的「缺字段一律 false」会把它判成无页码能力，退化成游标分页。
   * **capabilities 是隐藏/禁用/提示文案的唯一依据**，不按源名硬编码判断。
   */
  const GALLERY_SOURCE_FALLBACK = Object.freeze({
    [DANBOORU_SOURCE_ID]: { id: DANBOORU_SOURCE_ID, label: "D站", capabilities: { tags: true, prompt: false, nsfw: false, login: false, query: true, page_numbers: true } },
    civitai: { id: "civitai", label: "C站", capabilities: { tags: false, prompt: true, nsfw: true, login: false, query: false, page_numbers: false } },
    pixiv: { id: "pixiv", label: "P站", capabilities: { tags: true, prompt: false, nsfw: false, login: true, query: true, page_numbers: true } },
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
  // C站 开了「无限加载」之后，上面那套「只在当页内过滤」的说法就过时了：搜索范围是后台已加载的整池。
  const CIVITAI_POOL_QUERY_PLACEHOLDER = "关键词（在后台已加载的内容里筛选，改词无需重新加载）";
  const CIVITAI_POOL_QUERY_HINT = "已开启 C站 无限加载：关键词在后台**已加载的全部内容**里筛选（跨页生效），"
    + "改词或重新搜索都不会再去请求上游；想搜得更宽就点分页条上的「加载更多」。";
  const CIVITAI_POOL_QUERY_HINT_SHORT = "关键词在已加载内容里筛（跨页）";
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
  /**
   * 页码模式下**每页固定张数**。P站 上游（/v1/illust/search）固定每页 30 条，
   * 后端路由把 `page` 换算成 `(page-1)*30`（与 limit 参数无关）——
   * 所以页码模式的画廊源必须发 limit=30，否则「页码 = 批次」的语义会对不上
   * （发 48 也只会回 30 条，用户看到的"每页张数"跟设置里选的完全不符）。
   */
  const GALLERY_PAGE_SIZE = 30;
  // C站「无限加载」池（2026-09-21）：档位必须与后端 anima_gallery_civitai.POOL_TARGET_OPTIONS 一致 ——
  // C站 图片接口单页上限就是 200 条，所以每一档正好对应 1~5 次请求。
  const CIVITAI_POOL_TARGET_OPTIONS = Object.freeze([200, 400, 600, 800, 1000]);
  const CIVITAI_POOL_TARGET_DEFAULT = 200;
  /** 分页条上最多渲染几个「批次 chip」（更早的折叠成「…」，避免翻几十批后按钮铺满一行） */
  const GALLERY_CURSOR_CHIP_MAX = 10;

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
      // 备注的来源：true = 用户手填（含"故意留空"），false/缺省 = 自动翻译。
      // ⚠️ 手填的绝不能被自动翻译覆盖，留空的也不能被"补全" —— 这正是「自定义备注」的语义。
      noteManual: source.noteManual === true,
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
  /**
   * 缩略图大小档位（目标列宽 pt）。**默认 116 = 旧行为（零回归）**。
   * 旧实现只用 DG_MIN_PT 算列数 ⇒ 节点越宽列数越多、单图永远 ~118px，
   * DG_MAX_PT 全仓零使用点（实测 grid 700→4000 宽，卡片 133.8→118.1px）。
   * 用户 2026-09-16 选的是「缩略图大小档位」方案：把目标列宽变成显式设置，
   * 并让 DG_MAX_PT 真正生效（cols 下限保护，见 gridMetrics）。
   */
  const DG_THUMB_TIERS = Object.freeze([
    { width: 116, label: "小" },
    { width: 150, label: "中" },
    { width: 190, label: "大" },
    { width: 240, label: "特大" },
    { width: 330, label: "巨大" },
  ]);
  /** 档位归一化：先按 [DG_MIN_PT, DG_MAX_PT] 夹，再吸附到最近档位（下拉框必须能如实呈现） */
  function clampThumbWidth(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DG_MIN_PT;
    const clamped = Math.max(DG_MIN_PT, Math.min(DG_MAX_PT, n));
    let best = DG_THUMB_TIERS[0];
    for (const tier of DG_THUMB_TIERS) {
      if (Math.abs(tier.width - clamped) < Math.abs(best.width - clamped)) best = tier;
    }
    return best.width;
  }
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
  // 渲染后「补到填满」的连续轮次上限（**按需**，不再是常量 1）。
  // 历史：2026-09-16 从 6 收到 1（用户实测「在无限变大，扩充完图片之后又触发扩充」）。
  // 现在节点尺寸被 setBounds 钉死（内容再高也不会撑大节点），"补图撑大节点"的正反馈
  // 已经不成立，所以轮次改为按缺多少张算：见 autoFillRoundsBudget()。
  // 仍然保留一个硬上限，配合下面的时间窗限流做第二道闸。
  const DG_AUTO_FILL_MAX_ROUNDS_CAP = 3;
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

  /** C站「无限加载」池设置：`enabled=false` = 完全走原有单页路径，档位非法一律回默认 200 */
  function normalizeCivitaiPool(value) {
    const saved = value && typeof value === "object" ? value : {};
    const target = Number(saved.target);
    return {
      enabled: saved.enabled === true,
      target: CIVITAI_POOL_TARGET_OPTIONS.includes(target) ? target : CIVITAI_POOL_TARGET_DEFAULT,
    };
  }

  /** P站「匹配 D站」设置：auto = 进入 P站 后自动批量反查（默认关闭 = P站 行为与改动前一致） */
  function normalizePixivMatch(value) {
    const saved = value && typeof value === "object" ? value : {};
    return { auto: saved.auto === true };
  }

  function normalizeGallerySettings(saved) {
    const source = saved && typeof saved === "object" ? saved : {};
    return {
      // limit: 0 = 自适应（按节点尺寸算该显示几张，恰好填满不留空白）；12/24/48 = 固定张数
      limit: [0, 12, 24, 48].includes(source.limit) ? source.limit : 0,
      rating: normalizeRatings(source.rating),
      gridHeight: Number.isFinite(source.gridHeight) ? Math.max(360, Math.min(1200, source.gridHeight)) : 620,
      // 缩略图大小（目标列宽 pt）：缺省 116 = 旧行为；档位 116/150/190/240/330
      thumbWidth: clampThumbWidth(source.thumbWidth),
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
      // C站「无限加载」池：缺字段 = 关闭（老工作流恢复后行为与改动前逐字节一致）
      civitaiPool: normalizeCivitaiPool(source.civitaiPool),
      // P站「匹配 D站」：缺字段 = 关闭（不自动反查）
      pixivMatch: normalizePixivMatch(source.pixivMatch),
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
      this.translationCache = new Map();
      this.presetNoteHydration = null;
      this.tooltip = null;
      this.tooltipHideTimer = null;   // 「延迟隐藏」定时器（只被 D站 的可交互浮层用到）
      this.tooltipShowTimer = null;   // 「延迟显示」定时器（悬停 PROMPT_TOOLTIP_SHOW_DELAY 才弹）
      this.tooltipHoverPoint = null;  // 光标在卡片内的最后位置：只用来定一次位，浮层不跟随它移动
      this.tooltipCard = null;        // 当前浮层对应的卡片（判「鼠标从浮层移回同一张卡」用）
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
      // 与 cursorStack 一一对应的「该批带回了几张」：用于在分页条上显示「已浏览 K 张」。
      // 只记账、不重放请求（回退 = 截断栈 + 重查一次）。
      this.cursorBatchSizes = [0];
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
      // 差分组（父子级）浏览：点卡片「差分」把搜索词临时换成 parent:<根帖id>，
      // 这里记着进入前的搜索词与页码，供搜索框旁的「← 返回」还原（见 openDiffGroup / exitDiffGroup）。
      this.diffContext = null;
      // P站 多页作品：一页搜索结果里「一作品 × N 页」会被适配器展开成 N 条 item，
      // 折叠回「一作品一张卡」后其余页存在 groups 里，点卡片「全部页」再展开（见 foldPixivPages）。
      this.pixivPageGroups = null;   // Map<illust_id, post[]>：本批结果里各多页作品的全部页
      this.pixivDetail = null;       // 非 null = 正在看某个作品的全部页（纯展示层覆盖）
      // C站「无限加载」池（仅 civitai + 设置开启时使用；关闭时这两个字段全程为空/0，不参与任何原有路径）
      //   posts = 已加载的全部内容（后端按档位预取累积），展示的是它按「每页数量」切出来的一段。
      this.sourcePool = null;        // { posts, cursor, exhausted, fingerprint }
      this.poolPageIndex = 0;        // 池内当前展示到第几段（0 起）
      // P站「匹配 D站」：illust_id → D站帖子形状（含 tag_string_*，可直接喂 rawPromptGroups）。
      // 命中的作品，其卡片会输出该 D站 帖子的规范标签作为 prompt（见 postHasPrompt / rawPromptGroups）。
      this.pixivMatches = new Map();
      this.pixivMatchBusy = new Set();  // 正在反查的 illust_id（防重复请求）
      this.diffReturnBtn = null;
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

    /** capabilities 是隐藏/禁用控件的**唯一依据**（PLAN §5.3 + `query` 第 5 键 + `page_numbers` 第 6 键）；
     *  缺字段一律按 false 处理 —— 所以 D站 的 page_numbers 必须靠 GALLERY_SOURCE_FALLBACK 兜住。 */
    sourceCapabilities(sourceId = null) {
      const caps = this.sourceEntry(sourceId)?.capabilities || {};
      return {
        tags: caps.tags === true,
        prompt: caps.prompt === true,
        nsfw: caps.nsfw === true,
        login: caps.login === true,
        // query 缺省按 true：搜索框是主要输入，后端没声明时不该因为缺字段就退回"本页过滤"文案
        query: caps.query !== false,
        // page_numbers 缺省按 false（"没声明能力"的源一律进游标分支，不猜）
        page_numbers: caps.page_numbers === true,
      };
    }

    /**
     * 该源是否**页码分页**（D站 / P站）。这是分页分支的唯一判据 ——
     * 不再用 `isDanbooruSource()`（按源名硬编码）判断翻页形态。
     * 没声明 `page_numbers` 的源拿不到 true，所以永远进不了页码分支。
     */
    pageMode(sourceId = null) {
      return this.sourceCapabilities(sourceId).page_numbers;
    }

    /** 分页条 / 状态栏里的「第几批」：页码模式的源显示页码，游标模式的源显示批号 */
    galleryBatchLabel() {
      return this.pageMode()
        ? `第 ${Math.max(1, Number(this.page) || 1)} 页`
        : `第 ${this.cursorStack.length} 批`;
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
     * 画廊源（非 D站）的查询参数。分页形态**按 capabilities.page_numbers 分支**：
     *   · page_numbers=true（P站）→ 发 `page`（绝不混进 cursor），每页固定 GALLERY_PAGE_SIZE 张；
     *   · page_numbers=false（C站）→ 发 `cursor`（栈顶 = 当前批次），回包字段 next_cursor。
     * ⚠️ 查询参数名契约里写的是"由各源自定义"，PLAN §3 阶段1/2 分别写了 `query=` 与 `word=`，
     *    这里按文档发主名，同时附带 `query` 作为别名（FastAPI 会忽略未声明的查询参数），
     *    以免两边命名分歧导致"点了搜索没反应"。
     */
    gallerySearchParams(sourceId, query) {
      const params = new URLSearchParams();
      if (this.pageMode(sourceId)) {
        params.set("page", String(Math.max(1, Number(this.page) || 1)));
        // P站 上游固定 30 条/页、page 换算写死 (page-1)*30（与 limit 无关）——
        // 发别的 limit 只会让"页码 = 批次"的语义错位，所以这里就是 30。
        params.set("limit", String(GALLERY_PAGE_SIZE));
      } else {
        params.set("cursor", String(this.cursorStack[this.cursorStack.length - 1] ?? ""));
        params.set("limit", String(this.resolveLimit()));
      }
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
      // C站「无限加载」池：告诉后端本轮要预取多少条（不发 = 后端 pool_target 默认 0 = 原有单页行为）
      if (this.poolMode()) params.set("pool_target", String(this.settings.civitaiPool.target));
      return params;
    }

    readGalleryResponse(response) {
      return response.json().catch(() => null);
    }

    resetGalleryCursor() {
      this.cursorStack = [""];
      this.cursorBatchSizes = [0];
      this.nextCursor = null;
    }

    /** 当前批次自己带回了几张（记账值；没有记录时退回当前显示张数） */
    cursorBatchSizeAt(index) {
      const value = Number(this.cursorBatchSizes?.[index]);
      return Number.isFinite(value) && value > 0 ? value : (index === this.cursorStack.length - 1 ? this.posts.length : 0);
    }

    /** 截至当前批次累计浏览了几张（游标分页没有总数，只能用「已经取回过的批」累加） */
    galleryBrowsedCount() {
      let total = 0;
      for (let i = 0; i < this.cursorStack.length; i++) total += this.cursorBatchSizeAt(i);
      return Math.max(total, this.posts.length);
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

    /** 分类库键：`<source>:<id>`。D站/P站 的帖子 id 都是纯数字，只用 id 会**跨源撞号**。 */
    postKeyOf(post) {
      // ⚠️ 前缀必须走 postSourceId()，**不能直接拿 post.source**：D站 原生 post 的 `source`
      //    是**作品来源 URL**（twitter / pixiv 链接），拿它当前缀会得到
      //    `https://twitter.com/…:4583512` 这种键 ⇒ 后端按前缀分区时落进一个不存在的源，
      //    归类静默失败（用户实报"分类建好了，却切换不进那个分类"）。
      const source = this.postSourceId(post);
      const id = String(post?.id ?? "");
      return id ? `${source}:${id}` : "";
    }

    /** 把"纯 id 或 postKey"归一成 postKey（旧调用点/旧数据传的是纯 id）。 */
    normaliseCategoryKey(entry) {
      const text = String(entry ?? "");
      if (!text) return "";
      return text.includes(":") ? text : `${this.settings.source}:${text}`;
    }

    /** 内部 post 形状 → 协议层 ITEM_KEYS 快照（后端只存这套键，与搜索返回同形状）。 */
    snapshotFromPost(post) {
      return {
        // 同样不能用 post.source（D站 那是作品来源 URL，见 postKeyOf）
        source: this.postSourceId(post),
        id: post?.id,
        preview_url: post?.preview_file_url || post?.preview_url || "",
        full_url: post?.large_file_url || post?.file_url || post?.full_url || "",
        width: post?.image_width,
        height: post?.image_height,
        tags: Array.isArray(post?.tags) ? post.tags : undefined,
        prompt: post?.prompt,
        negative_prompt: post?.negative_prompt,
        rating: post?.rating,
        score: post?.score,
        source_url: post?.source_url,
        meta: post?.meta,
        file_ext: post?.file_ext,
      };
    }

    // ── 后端分类库（跨节点共享）──────────────────────────────────────────────
    //
    // 分类以前存在**每个节点的 settings** 里，而 settings 会随工作流写进 node.properties
    // ⇒ 同一工作流里两个画廊各有一份、互不可见（用户 2026-09-20 实报"多个画廊的分类居然
    // 不是共享的，这是巨大毛病"）。现在以 `data/gallery_categories.json` 为**唯一真源**：
    //   · 加载：`initCategoryLibrary()` —— 先留一份工作流旧数据做迁移源，再拉后端覆盖内存缓存；
    //   · 写入：`pushPostCategory()` —— 落库成功后才改内存，失败如实报错不静默；
    //   · 浏览：`fetchCategoryPosts()` —— 直接读**本地快照**，不回查图源
    //     （原实现靠 `id:` 元标签回查，只有 D站 有 ⇒ P站/C站 的分类浏览永远是空的）。
    // settings 里那份仍随工作流保存，但降级为**离线只读缓存**（后端不可用时还能显示）。

    async _categoryRequest(path, options) {
      const response = await fetch(path, options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      return data || {};
    }

    /**
     * 拉后端分类库。
     *
     * ``keepLocalFallback=true``：**后端为空时不覆盖本地** —— 这是"更新后分类不丢"的关键一道闸。
     * 场景：用户刚装上带本模块的版本，后端 `data/gallery_categories.json` 还不存在（返回空库）。
     * 若无条件覆盖，用户当场看到"分类全没了"；更糟的是随后 `saveSettings()` 会把这份空值
     * **写回工作流 node.properties** —— 那才真的丢了。所以首次加载走 keepLocalFallback，
     * 等 migrate 把本地旧数据并进后端之后再拉一次（那次以后端为准）。
     */
    async loadCategoryLibrary({ keepLocalFallback = false } = {}) {
      try {
        // ★ 分类库**按图源分区**（用户 2026-09-20 第二轮实报"D站和P站的分类还不是独立的"）：
        //   拉的是当前源那一片，别源的分类不会出现在这里；同一图源内仍跨节点/跨工作流共享。
        const data = await this._categoryRequest(`/anima/gallery/categories?source=${encodeURIComponent(this.settings.source)}`);
        const remoteCategories = Array.isArray(data.categories) ? data.categories : [];
        const remotePosts = data.postCategories && typeof data.postCategories === "object"
          ? data.postCategories : {};
        const localCategories = Array.isArray(this.settings.categories) ? this.settings.categories : [];
        const localPosts = this.settings.postCategories && typeof this.settings.postCategories === "object"
          ? this.settings.postCategories : {};
        const backendEmpty = !remoteCategories.filter((c) => String(c?.id) !== "uncategorized").length
          && !Object.keys(remotePosts).length;
        if (keepLocalFallback && backendEmpty && (localCategories.length > 1 || Object.keys(localPosts).length)) {
          this.setStatus("共享分类库还是空的，已先沿用本工作流里的分类；正在迁移到共享库…", "");
          return false;
        }
        this.settings.categories = remoteCategories;
        this.settings.postCategories = remotePosts;
        this._categoryLibraryLoaded = true;
        return true;
      } catch (error) {
        // 后端不可用 → 退回工作流里保存的那份（只读缓存），**不阻塞**画廊其它功能
        this.setStatus(`分类库读取失败，暂用本工作流缓存：${error?.message || error}`, "error");
        return false;
      }
    }

    /**
     * 把**工作流里带的**旧分类并进全局库（幂等，只在本次会话跑一次）。
     *
     * 用户明确要求"不能让用户更新后原来的分类消失" —— 所以顺序是：
     * ① 先把 settings 里的旧值抓一份（迁移源），② 再拉后端覆盖内存，③ 把旧值并进后端。
     * 后端做的是**并集**：同名分类复用、冲突归属全局优先、条目只补缺 ⇒ 既不会丢旧数据，
     * 也不会把别的节点已经归好的类覆盖掉。迁移成功后会重新拉一次，让内存与后端一致。
     */
    /**
     * 收集**本浏览器 localStorage 里其它**画廊节点的旧分类（含旧版全局键）。
     *
     * 为什么必须收全：分类库后端化时只迁移了"当前节点"的 settings，而 localStorage 里
     * 每个画廊节点各存一份（key = 前缀 + 节点 id）—— 别的节点 / 别的旧工作流里的归类
     * 从来没被迁移过，用户更新后就会看到"分类里的图片少了好几张"。
     * 这些数据**就在当前浏览器里、前端完全看得到**，没有任何理由不带走。
     */
    collectStoredCategoryBackups() {
      const backups = [];
      try {
        if (localStorage.getItem(OTHERS_MIGRATED_KEY) === "1") return backups;   // 一次性
      } catch {
        return backups;
      }
      let total = 0;
      try {
        total = localStorage.length;
      } catch {
        return backups;
      }
      for (let index = 0; index < total; index += 1) {
        let key = "";
        try {
          key = localStorage.key(index) || "";
        } catch {
          continue;
        }
        const isNodeKey = key.startsWith(STORAGE_KEY_PREFIX);
        const isLegacyKey = key === LEGACY_STORAGE_KEY;
        if (!isNodeKey && !isLegacyKey) continue;
        if (key === this.settingsKey()) continue;          // 当前节点那份已单独处理
        try {
          const payload = JSON.parse(localStorage.getItem(key) || "{}");
          const posts = payload && typeof payload.postCategories === "object" ? payload.postCategories : null;
          if (posts && Object.keys(posts).length) {
            backups.push({ key, categories: payload.categories, postCategories: posts });
          }
        } catch {
          /* 某一份坏数据不影响其它节点 */
        }
      }
      return backups;
    }

    async migrateLocalCategoriesOnce() {
      if (this._categoryMigrated) return;
      this._categoryMigrated = true;
      const backup = this._localCategoryBackup || {};
      const localCategories = Array.isArray(backup.categories) ? backup.categories : [];
      const localPosts = backup.postCategories && typeof backup.postCategories === "object"
        ? backup.postCategories : {};
      // ★ 再收一遍"本浏览器里其它画廊节点"的旧分类（当前节点的那份优先，其余只补缺）
      const collected = this.collectStoredCategoryBackups();
      const mergedCategories = [...localCategories];
      const mergedPosts = { ...localPosts };
      for (const item of collected) {
        for (const category of (Array.isArray(item.categories) ? item.categories : [])) {
          if (category?.id && !mergedCategories.some((c) => String(c?.id) === String(category.id))) {
            mergedCategories.push(category);
          }
        }
        for (const [key, categoryId] of Object.entries(item.postCategories)) {
          if (!(key in mergedPosts)) mergedPosts[key] = categoryId;
        }
      }
      if (!mergedCategories.length && !Object.keys(mergedPosts).length) return;
      const source = String(this.settings.source || "danbooru");
      // 迁移**只并本图源的东西**（否则"升级后第一次打开 P站"会把 D站 的分类名搬进 P站 分区）：
      //   · 归属：只收 key 前缀 = 本源（旧的无前缀 key 视为 D站，历史来源就是它）；
      //   · 分类定义：D站 全并（旧版唯一的那套就是它的，空分类也不能丢），
      //     别的源只并"本源条目真正引用到的分类"。
      const localSourcePosts = {};
      const usedCategoryIds = new Set();
      for (const [key, categoryId] of Object.entries(mergedPosts)) {
        const prefixed = key.includes(":") ? key : `danbooru:${key}`;
        if (!prefixed.startsWith(`${source}:`)) continue;
        localSourcePosts[prefixed] = categoryId;
        usedCategoryIds.add(String(categoryId));
      }
      const sourceCategories = source === "danbooru"
        ? mergedCategories
        : mergedCategories.filter((c) => usedCategoryIds.has(String(c?.id)));
      if (!sourceCategories.length && !Object.keys(localSourcePosts).length) return;
      try {
        const data = await this._categoryRequest("/anima/gallery/categories/migrate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source,
            categories: sourceCategories,
            postCategories: localSourcePosts,
            snapshots: {},
          }),
        });
        if (data.migrated || data.created) {
          this.setStatus(
            `已把浏览器里的旧分类并入共享库：新增分类 ${data.created} 个、归类 ${data.migrated} 条`
            + (collected.length ? `（其中含其它画廊节点的 ${collected.length} 份）` : "")
            + (data.skipped ? `；${data.skipped} 条与共享库一致，未改动` : ""), "success");
        }
        // 迁移成功后打一次性标记：这些旧数据已经进共享库，别再每次加载重跑
        try {
          if (collected.length) localStorage.setItem(OTHERS_MIGRATED_KEY, "1");
        } catch { /* 存不进去就下次再来一遍，幂等 */ }
        await this.loadCategoryLibrary();
      } catch (error) {
        // 迁移失败不能吞掉旧数据：settings 里那份仍在，下次加载会再试
        this._categoryMigrated = false;
        this.setStatus(`旧分类迁移失败（本地数据仍在工作流里，下次加载会重试）：${error?.message || error}`, "error");
      }
    }

    /** 启动时调一次：抓旧数据 → 拉共享库 → 迁移。 */
    async initCategoryLibrary() {
      if (this._categoryInitStarted) return;
      this._categoryInitStarted = true;
      this._localCategoryBackup = {
        categories: Array.isArray(this.settings.categories) ? [...this.settings.categories] : [],
        postCategories: this.settings.postCategories && typeof this.settings.postCategories === "object"
          ? { ...this.settings.postCategories } : {},
      };
      // ① 首次拉取**允许本地兜底**（后端空就不覆盖，见 loadCategoryLibrary 的说明）
      await this.loadCategoryLibrary({ keepLocalFallback: true });
      // ② 把工作流里的旧分类并进共享库（幂等；失败会保留备份并下次重试）
      await this.migrateLocalCategoriesOnce();
      // ③ 迁移之后再拉一次，这次以后端为唯一真源
      await this.loadCategoryLibrary();
      // 分类下拉挂在筛选器那一排，**没有**单独的"分类刷新"方法（我原先 `?.()` 调用的
      // `refreshCategoryOptions` 根本不存在 ⇒ 后端拉回来的分类刷不到 UI）。用筛选器的刷新入口。
      this.filterControls?.refresh?.();
    }

    /**
     * key → post 索引：**归类时必须带快照**，否则分类浏览里没有图可渲染
     * （用户实报"分类创建了、却切换不到那个分类"，根因就是这里——卡片按钮传的是
     *  ``postKey`` 字符串，快照字段被整条丢掉，后端只能存一份空快照）。
     */
    rememberPostsForCategory(posts) {
      if (!Array.isArray(posts) || !posts.length) return;
      if (!this._postKeyIndex) this._postKeyIndex = new Map();
      for (const post of posts) {
        const key = this.postKeyOf(post);
        if (key) this._postKeyIndex.set(key, post);
      }
      // 画廊可以滚很多页，索引只留最近的一批（够覆盖"刚看过就归类"的用法）
      if (this._postKeyIndex.size > 4000) {
        this._postKeyIndex = new Map(Array.from(this._postKeyIndex.entries()).slice(-2000));
      }
    }

    /** 按 postKey 取快照；索引里没有就退回当前列表现查。 */
    postSnapshotForCategory(key) {
      const hit = this._postKeyIndex?.get(key);
      if (hit) return this.snapshotFromPost(hit);
      const live = (this.posts || []).find((post) => this.postKeyOf(post) === key);
      return live ? this.snapshotFromPost(live) : null;
    }

    /**
     * 归类（单张或多张）。**先落库再改内存** —— 失败时如实提示，不留下"看着归好了其实没存"的假象。
     * ``categoryId`` 传空 = 取消归类。
     */
    async pushPostCategory(posts, categoryId) {
      const list = (Array.isArray(posts) ? posts : [posts]).filter(Boolean);
      const cleanCategory = String(categoryId || "");
      let ok = 0;
      let noSnapshot = 0;
      for (const entry of list) {
        // 允许传 post 对象，也允许直接传 key 字符串（批量归类那边手里只有 key）。
        // 字符串不含 ":" 时补当前图源前缀 —— 旧数据/旧调用点传的是纯 id。
        const isKey = typeof entry === "string";
        const key = isKey
          ? (entry.includes(":") ? entry : `${this.settings.source}:${entry}`)
          : this.postKeyOf(entry);
        if (!key) continue;
        // ★ 无论传对象还是 key，都要把**快照**带上：分类浏览读的就是这份快照，
        //   缺了它那个分类点进去就是空的（这正是"切换不到分类"的根因）。
        const snapshot = isKey ? this.postSnapshotForCategory(key) : this.snapshotFromPost(entry);
        if (cleanCategory && !snapshot) noSnapshot += 1;
        try {
          await this._categoryRequest("/anima/gallery/posts/category", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              postKey: key,
              categoryId: cleanCategory,
              snapshot: snapshot || undefined,
            }),
          });
          if (cleanCategory) this.settings.postCategories[key] = cleanCategory;
          else delete this.settings.postCategories[key];
          ok += 1;
        } catch (error) {
          this.setStatus(`归类失败（${key}）：${error?.message || error}`, "error");
        }
      }
      this.saveSettings();
      if (noSnapshot) {
        this.setStatus(`已归类 ${ok} 张，其中 ${noSnapshot} 张没取到图片快照（分类里会缺这几张）`, "error");
      }
      return ok;
    }

    /**
     * 从后端分类键（``<source>:<id>``）取图源标识 —— 这是**最权威**的来源
     * （后端就是按这个前缀分区的），比快照里的 ``source`` 字段可信：
     * 旧版快照可能把 D站 原生 ``source``（作品来源 URL）存了进去。
     */
    sourceIdFromPostKey(postKey) {
      const text = String(postKey || "");
      const source = text.includes(":") ? text.split(":")[0].toLowerCase() : "";
      return GALLERY_SOURCE_ORDER.includes(source) ? source : "";
    }

    /** 分类浏览：读**该图源**的后端本地快照并复用既有的 item→post 映射，不再回查任何图源。 */
    async fetchCategoryPosts(categoryId) {
      const data = await this._categoryRequest(
        `/anima/gallery/posts?category=${encodeURIComponent(categoryId)}&source=${encodeURIComponent(this.settings.source)}`);
      const fallbackSource = this.settings.source;
      return (Array.isArray(data.items) ? data.items : [])
        // ⚠️ 用 postKey 前缀定源，**不要用 item.source**（子代理复查 2026-09-20 指出的唯一残留）：
        //    快照里的 source 若是脏值（旧版把作品来源 URL 存了进去），
        //    postKeyOf(post) 就会与后端键不一致 ⇒ 被 renderPosts 的分类过滤剔掉 ⇒ 分类浏览空视图。
        .map((item) => this.galleryItemToPost(item, this.sourceIdFromPostKey(item.postKey) || fallbackSource));
    }

    /**
     * 取分类；不存在则**在后端**新建后返回。
     *
     * ⚠️ 不能再用本地 `c_${Date.now()}` 造 id —— 分类库的唯一真源在后端，
     * 本地造的 id 落库时会被后端拒（`目标分类不存在`），或者更糟：写进去一个后端不认识的
     * id，下次加载就被"洗掉"，用户表现为"我建的分类一会儿就没了"。
     */
    async ensureCategoryByName(name) {
      const clean = String(name || "").trim();
      if (!clean) return null;
      const existing = (this.settings.categories || []).find((c) => c.name === clean);
      if (existing) return existing;
      try {
        const data = await this._categoryRequest("/anima/gallery/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create", name: clean, source: this.settings.source }),
        });
        const category = data.category;
        if (category) {
          if (!Array.isArray(this.settings.categories)) this.settings.categories = [];
          if (!this.settings.categories.some((c) => String(c.id) === String(category.id))) {
            this.settings.categories.push(category);
          }
          this.settings.categories.sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
          return category;
        }
      } catch (error) {
        this.setStatus(`新建分类失败：${error?.message || error}`, "error");
      }
      return null;
    }

    /**
     * 重命名分类 —— **必须走后端**（唯一真源）。
     *
     * 分类菜单（筛选器那一排）里的 ✎ 原先是纯前端改内存 + commit，看起来立刻生效，
     * 但下次加载时后端那份会把旧名字送回来（用户表现为"改了又变回去"）。
     */
    async renameCategoryRemote(category, nextName) {
      const clean = String(nextName || "").trim();
      if (!category?.id || !clean || clean === category.name) return false;
      try {
        await this._categoryRequest("/anima/gallery/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "rename", id: category.id, name: clean, source: this.settings.source,
          }),
        });
      } catch (error) {
        this.setStatus(`重命名分类失败：${error?.message || error}`, "error");
        return false;
      }
      await this.loadCategoryLibrary();
      this.saveSettings();
      this.filterControls?.refresh();
      this.setStatus(`已重命名分类：${category.name} → ${clean}`, "success");
      return true;
    }

    /** 删除分类 —— 同样走后端（后端把其中的条目退回「未分类」，**不删条目**）。 */
    async deleteCategoryRemote(category) {
      if (!category?.id) return false;
      try {
        await this._categoryRequest("/anima/gallery/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "delete", id: category.id, source: this.settings.source,
          }),
        });
      } catch (error) {
        this.setStatus(`删除分类失败：${error?.message || error}`, "error");
        return false;
      }
      if (this.settings.activeCategory === category.id) {
        this.settings.activeCategory = "";
        this.applyActiveCategory("");
      }
      await this.loadCategoryLibrary();
      this.saveSettings();
      this.filterControls?.refresh();
      this.renderPosts();
      this.setStatus(`已删除分类：${category.name}（其中的图片已变回未分类）`, "success");
      return true;
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
      if (resetPage) {
        this.resetGalleryCursor();
        // 页码分页的源（P站）也要回到第 1 页：否则换词/换筛选后仍停在上次翻到的页码，
        // 用户看到的"新搜索"会从第 7 页开始。
        this.page = 1;
      }
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
      // ★ C站 池模式：池已按同一套上游筛选建好 → **就在本池内重新筛**，不发任何请求。
      //   这是「搜索范围 = 已加载的全部内容」与「改关键词零请求」的落点；
      //   池不存在、或上游筛选（排序 / NSFW / 时间 / 作者）变了 → 落到下面正常请求去重建池。
      if (this.poolMode() && this.sourcePool && this.sourcePool.fingerprint === this.poolFingerprint()) {
        if (resetPage) this.poolPageIndex = 0;
        this.applyPoolView();
        this.setStatus(this.poolStatusText());
        return;
      }
      if (!query && sourceId === "pixiv") {
        // Pixiv 搜索必须有词（契约只有 search/illust，没有匿名兜底列表）→ 明确提示，
        // 而不是发一个必然失败的请求。
        this.posts = [];
        // 详情态必须一起清：`displayPosts()` 在 pixivDetail 非空时会**忽略 this.posts**，
        // 只清 posts 的话网格仍显示上一个作品的整组页，而状态栏写着"请输入关键词"。
        this.pixivDetail = null;
        this.syncReturnButton();
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
        const nextCursorValue = data?.next_cursor == null || data.next_cursor === "" ? null : String(data.next_cursor);
        const incoming = items
          .map((item) => this.galleryItemToPost(item, sourceId))
          .filter((post) => post.preview_file_url || post.large_file_url);
        // ★ C站 池模式：这一轮拿到的内容**并入池**（而不是替换展示源），展示交给 poolVisiblePosts 切片。
        //   池模式的关键词筛选全在池内做，所以不参与下面的「排除标签 / pixiv 多页折叠」链路。
        if (this.poolMode()) {
          const rebuild = !this.sourcePool || this.sourcePool.fingerprint !== this.poolFingerprint();
          this.accumulatePool(incoming, { nextCursor: nextCursorValue, reset: rebuild });
          if (resetPage) this.poolPageIndex = 0;
          this.nextCursor = this.sourcePool.cursor;
          this.applyPoolView();
          this.setStatus(this.poolStatusText());
          return;
        }
        this.nextCursor = nextCursorValue;
        this.posts = incoming;
        // 折叠**前**的条数（= 含 P站 多页作品展开出来的每一条）：下面那条「缺图已跳过」要拿它比，
        // 否则被折叠掉的页会被误报成缺图。
        const loadedCount = this.posts.length;
        // 排除标签是本地按 Danbooru tag_string 过滤的（无标签体系时没有意义，控件在设置里已禁用）
        const excludeTags = caps.tags ? (this.settings.excludeTags || []) : [];
        let excludedCount = 0;
        if (excludeTags.length) {
          const tagSet = new Set(excludeTags);
          const before = this.posts.length;
          this.posts = this.posts.filter((post) => !String(post.tag_string || "").split(" ").some((tag) => tagSet.has(tag)));
          excludedCount = before - this.posts.length;
        }
        // 新一批结果 = 离开 P站 作品详情；并把多页作品折成「一作品一张卡」（见 foldPixivPages）
        const beforeFold = this.posts.length;
        this.pixivDetail = null;
        this.posts = this.foldPixivPages(this.posts);
        const foldedCount = beforeFold - this.posts.length;
        this.syncReturnButton();
        this.renderPosts();
        // P站：设置里开了「自动关联」就把本批作品一次批量反查 D站（1 次请求），命中的就地刷成已匹配
        void this.autoMatchPixiv(this.posts);
        this.renderPagination();
        const batch = this.cursorStack.length;
        // 记账：本批带回了几张（分页条的「已浏览 K 张」就是这些批次累加，见 galleryBrowsedCount）
        if (batch >= 1) this.cursorBatchSizes[batch - 1] = this.posts.length;
        // 后端的 warnings（契约允许的可选键）**必须让用户看见** —— 例如 C站 不支持关键词检索时
        // 后端会在这一页内本地过滤并回报"关键词未生效"；不说的话用户以为搜了却没反应（静默错误）。
        const warnings = Array.isArray(data?.warnings) ? data.warnings.map((w) => String(w || "").trim()).filter(Boolean) : [];
        const notices = [...warnings];
        if (excludedCount) notices.push(`已排除 ${excludedCount} 张（${excludeTags.join("、")}）`);
        if (items.length > loadedCount + excludedCount) notices.push(`${items.length - loadedCount - excludedCount} 张缺图已跳过`);
        if (foldedCount) notices.push(`已折叠 ${foldedCount} 页多页作品（点卡片「全部页」展开）`);
        if (!this.pageMode(sourceId) && !this.nextCursor) notices.push("已到末页");
        if (caps.login && sourceId === "pixiv") notices.push("P站标签与 Danbooru 词库不通用");
        if (caps.prompt === false && sourceId === "pixiv") notices.push("P站无提示词，可下载原图喂 WD14 反推");
        this.setStatus(`${this.sourceLabel(sourceId)}：${this.posts.length} 张 · ${this.galleryBatchLabel()}` + (notices.length ? `（${notices.join("；")}）` : ""));
        // 空结果 + 有警告时，网格里也写一格：状态栏那一行很容易被忽略
        if (!this.posts.length && warnings.length) this.appendGridNotice(warnings.join("；"));
      } catch (error) {
        if (timedOut) {
          this.posts = [];
          this.pixivDetail = null;   // 同上：不清详情态的话网格仍显示旧作品的整组页
          this.syncReturnButton();
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
        this.pixivDetail = null;   // 同上：不清详情态的话网格仍显示旧作品的整组页
        this.syncReturnButton();
        this.renderPosts();
        this.renderPagination();
        this.setStatus(`${this.sourceLabel(sourceId)} 搜索失败：${error?.message || "未知错误"}`, "error");
      } finally {
        if (currentRequest === this.requestId && this.grid) this.grid.removeAttribute("aria-busy");
      }
    }

    /** cursor 分页：前进压栈（next_cursor），后退弹栈后重查 —— 契约只有 next_cursor，没有 prev */
    async stepGalleryCursor(delta) {
      // C站 池模式：翻页 = 切池里已有的一段（不够才补），与上游 cursor 栈无关
      if (this.poolMode()) return this.stepPoolPage(delta);
      if (delta > 0) {
        if (!this.nextCursor) return;
        this.cursorStack.push(this.nextCursor);
        // 记账数组必须与 cursorStack 同长，否则「已浏览 K 张」会把不存在的批次算进去
        this.cursorBatchSizes.length = this.cursorStack.length;
        this.cursorBatchSizes[this.cursorStack.length - 1] = 0;
      } else {
        if (this.cursorStack.length <= 1) return;
        this.cursorStack.pop();
        this.cursorBatchSizes.length = this.cursorStack.length;
      }
      await this.searchGallerySource({ resetPage: false });
    }

    /**
     * 一键回退到第 index+1 批（index 从 0 起）。
     * ⚠️ **截断栈 + 重查一次**，不是"重放压栈" —— 后者要按批次数量打 N 次接口
     * （回退 8 批 = 8 个请求），而 cursor 栈里本来就存着每一批的 cursor，直接截断即可。
     */
    async jumpGalleryBatch(index) {
      const target = Math.max(0, Math.min(Number(index) || 0, this.cursorStack.length - 1));
      if (target === this.cursorStack.length - 1) return;
      this.cursorStack.length = target + 1;
      this.cursorBatchSizes.length = target + 1;
      await this.searchGallerySource({ resetPage: false });
    }

    async switchGallerySource(nextId) {
      const id = String(nextId || "");
      if (!GALLERY_SOURCE_ORDER.includes(id) || id === this.activeSourceId()) return;
      // 差分组是 D站 的查询语义（parent:<id>），换源后必须退出，否则「← 返回」会把 D站 的词带到别的源。
      // ⚠️ 顺序要紧（独立审查抓到的 S1）：**先取出要保存的搜索词、再退出差分组**。差分组期间搜索框里
      //    是临时的 `parent:<id>`，直接把它记进 sourceQueries[previous]，那个栏目下次被切回时搜索框
      //    会永久变成 `parent:<id>`（此时返回按钮已经不在了，用户无法还原）。要保存的是 returnQuery。
      const carryQuery = this.diffContext
        ? String(this.diffContext.returnQuery ?? "")
        : this.gallerySourceQuery();
      this.leaveDiffGroup();
      const previous = this.activeSourceId();
      this.settings.sourceQueries[previous] = carryQuery;
      this.settings.source = id;
      // 本地分类浏览是 D站 的实现（按 id: 回查 D站 帖子），换源时退出该模式，
      // 否则新源会带着一个永远匹配不上的分类过滤。
      this.settings.activeCategory = "";
      this.saveSettings();
      this.resetGalleryCursor();
      this.page = 1;
      this.posts = [];
      // 换源必须退出 P站 作品详情：否则在"P站 模块未装"之类**提前 return** 的路径上，
      // 网格会一直显示上一个源的作品页（审查指出的问题 3）。
      this.pixivDetail = null;
      this.syncReturnButton();
      this.hidePromptTooltip();
      this.hideSuggestions();
      this.applySourceCapabilities();
      // ★ 分类库**按图源分区** ⇒ 换源必须重新拉该源的分类与归属
      //   （否则 D站 的分类会留在 P站 的下拉里 —— 用户实报"分类还不是独立的"）
      await this.loadCategoryLibrary();
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
        // C站 开了「无限加载」时，那套「只在当页内过滤」的说明就过时了 → 换成池的说法
        const poolQuery = this.poolMode();
        this.queryInput.placeholder = caps.query
          ? (GALLERY_SOURCE_PLACEHOLDERS[sourceId] || GALLERY_SOURCE_PLACEHOLDERS[DANBOORU_SOURCE_ID])
          : (poolQuery ? CIVITAI_POOL_QUERY_PLACEHOLDER : GALLERY_LOCAL_QUERY_PLACEHOLDER);
        this.queryInput.title = caps.query ? "" : (poolQuery ? CIVITAI_POOL_QUERY_HINT : GALLERY_LOCAL_QUERY_HINT);
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
        // ② 分类下拉 = **进入分类的入口**，三个图源都要有：分类浏览读的是本地快照
        //    （`/anima/gallery/posts`），早就不靠 D站 的 `id:` 回查了 ——
        //    旧代码在这里 `hidden = !isDanbooru`，用户实报"没有进入分类的按钮"。
        this.filterControls.categoryDropdown.element.hidden = false;
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
        const poolQuery = this.poolMode();
        hint.hidden = caps.query;
        hint.textContent = caps.query ? "" : (poolQuery ? CIVITAI_POOL_QUERY_HINT_SHORT : GALLERY_LOCAL_QUERY_HINT_SHORT);
        hint.title = caps.query ? "" : (poolQuery ? CIVITAI_POOL_QUERY_HINT : GALLERY_LOCAL_QUERY_HINT);
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
      const active = this.activeSourceId();
      // ⚠️ D站 的 post 自带 `source`，含义是**作品来源 URL**（twitter / pixiv 链接），
      //    不是图源标识 —— D站 下一律用当前源，**不去猜值域**。
      //    （子代理 2026-09-20 复查：靠白名单猜值域时，若某张 D站 图的 source 恰好是小写
      //     "pixiv"/"civitai"，就会被当成对应图源，归类报"目标分类不存在"。）
      if (active === DANBOORU_SOURCE_ID) return active;
      const id = String(post?.source || "");
      return GALLERY_SOURCE_ORDER.includes(id) ? id : active;
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

    /** 目标列宽（pt）：设置里的「缩略图大小」档位；缺省 DG_MIN_PT(116) = 旧行为 */
    thumbTargetPt() {
      return clampThumbWidth(this.settings?.thumbWidth);
    }

    /**
     * 改「缩略图大小」档位。返回是否真的变了。
     * ⚠️ 必须同时丢掉 `lastColStep` 反推基准：gridMetrics() 优先按上次的列步长反推列数
     * （那是为了抵消滚动条出现/消失的十几像素，见 §4.1），档位一变、旧基准还在，
     * 列数就会原样沿用 ⇒ 换档看起来"没反应"。这与「宽度大改丢基准」是同一套保险。
     * **不碰节点尺寸**：本方法绝不调 applyGridHeight()/setGridHeight()。
     */
    setThumbWidth(value) {
      const next = clampThumbWidth(value);
      if (next === this.thumbTargetPt()) return false;
      this.settings.thumbWidth = next;
      this.lastColStep = 0;
      this.lastCols = 0;
      return true;
    }

    /**
     * 网格几何。列数优先由「上次布局算出的列步长」反推 —— 垂直滚动条出现后 clientWidth
     * 会比 layout 时小十几像素，直接除会让卡片宽出容器、产生横向滚动条（实测 rightEdge 1295 > 1283）。
     */
    gridMetrics(precomputedStyle = null) {
      if (!this.grid) return { width: 780, cols: 3, cardWidth: 240, usable: 756 };
      const width = this.grid.clientWidth || 780;
      // 允许调用方把**刚取过的** computed style 传进来：applyMasonryLayout 为了 paddingTop/
      // paddingLeft 已经 getComputedStyle 过一次，而这里只差 paddingLeft/Right —— 同一次布局里
      // 重复取值等于白多一次样式重算（且它落在每页 48 张图的重排路径上）。
      // 只在确认两次取值之间**没有写过样式**时才可复用，见 applyMasonryLayout 的调用点。
      const style = precomputedStyle || getComputedStyle(this.grid);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      // ⚠️ 这个下限保护必须**原样保留**（§4.1 第一处保险）：首帧 clientWidth=0 时 usable 退化成
      //    DG_MIN_PT ⇒ cols=1，配合 dgSpanFor 的 Math.min(2, cols) 与布局侧的 !isFinite(top) 兜底，
      //    才不会回到"span=2 → top=Infinity → 卡片被甩出可视区且不自愈"的老坑。
      const usable = Math.max(DG_MIN_PT, width - padX);
      const target = this.thumbTargetPt();   // 目标列宽：设置档位，缺省 116 = 旧公式
      const cols = this.lastColStep > DG_GAP
        ? Math.max(1, Math.round((usable + DG_GAP) / this.lastColStep))
        : Math.max(1, Math.floor((usable + DG_GAP) / (target + DG_GAP)));
      // 列数**下限**保护：让 DG_MAX_PT 真正生效（旧代码它只有定义、零使用点）——
      // 窄节点 + 大档位时卡宽不得宽过 DG_MAX_PT，否则"想放大缩略图"会得到比预期更夸张的巨图。
      // 对缺省档位无影响：usable 最小时 minCols = ceil(123/337) = 1。
      const minCols = Math.max(1, Math.ceil((usable + DG_GAP) / (DG_MAX_PT + DG_GAP)));
      const finalCols = Math.max(cols, minCols);
      const cardWidth = Math.max(1, (usable - DG_GAP * (finalCols - 1)) / finalCols);
      return { width, cols: finalCols, cardWidth, usable };
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
      // 复用上面刚取的 gridStyle：此处到取值之间只写过 JS 字段（lastColStep/_lastLayoutUsable），
      // 没有任何 DOM 样式写入 ⇒ 样式没有失效，不必再 getComputedStyle 一次。
      const { usable, cols } = this.gridMetrics(gridStyle);
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
        && (this.pageMode() || this.nextCursor)) return;
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
     *
     * ⚠️ 调用方只剩**用户显式操作**（设置面板改高度）。初始化路径（build / onConfigure）
     * 已经全部改走 syncGridHeightFromNode()：它们只记录、不改尺寸 —— 尺寸真源是 node.size[1]。
     */
    setGridHeight(height) {
      this.programmaticResizeAt = Date.now();
      if (this.domSizeSync) {
        // ⚠️ 必须先**解锁区间**再改尺寸。setBounds 一旦被调用过（用户拖动过节点就会，
        //    见 onResize 里的 setBounds(nowHeight, nowHeight)），min/max 就被钉成 [h,h]，
        //    于是 setContentHeight 内部的 clamp(height, min, max) 会把任何目标高度夹回 h
        //    ⇒ 设置面板的「画廊高度」输入框**静默失效**（实测：拖过节点后再输入新高度没反应）。
        //    一次把 min/max 都设成目标值即可解锁；随后 setContentHeight 写 size 并复位区间。
        this.domSizeSync.setBounds?.(height, height);
        this.domSizeSync.setContentHeight(height);
        return;
      }
      if (this.root) {
        this.root.style.height = `${height}px`;
        this.root.style.minHeight = "0px";
        this.root.style.maxHeight = "none";
      }
      // 宽度下限与 anima_dom_widget_size_sync.js 的 getNodeWidth 对齐（那里是 280）：
      // 原先这里写 360，两处不一致 ⇒ 窄节点（用户拖到 300 宽）走这条 fallback 时会被
      // 悄悄撑到 360。真正该决定宽度的是用户/工作流，这里只是兜底，不该顺手改宽。
      this.node?.setSize?.([Math.max(280, this.node.size?.[0] || 780), height + 95]);
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
          // P站 作品详情是纯展示层（不重取数据）：列数变化只需重排 —— 而重取会顺手清掉详情态、
          // 把用户静默踢回搜索结果（审查指出的问题 4）。布局在上面 scheduleMasonryLayout() 已排过。
          if (this.pixivDetail) return;
          // 列数变化 ⇒ 同一屏能放的张数变了（原有行为：重取一页）
          // ⚠️ 但这是**尺寸变化引起的**，不是用户发起的搜索：不能借它重置补图预算，
          //    否则「补图撑大节点 → 列数变化 → 重置 → 再补」就是死循环。
          const keepRounds = this.autoFillRounds;
          const keepTarget = this._autoFillTarget;
          // ⚠️ 「池子已取空」也必须一起保回来：search(resetPage) 内部会把它清成 false，
          //    不清回来就会拿同一个**已知取空**的游标再打一次上游接口（有硬闸兜底不会死循环，
          //    但纯属白打一轮）。列数变化不是新结果集，这三项都该原样保留。
          const keepExhausted = this.fillMoreExhausted;
          this.search({ resetPage: true });
          this.autoFillRounds = keepRounds;
          this._autoFillTarget = keepTarget;
          this.fillMoreExhausted = keepExhausted;
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
      // 本地分类浏览（activeCategory）是**有限的本地集合**（按 id 回查已归类图片）：没有"下一页"可补，
      // 而补图走的是 search()，它开头就会清掉 activeCategory ⇒ 用户会被静默踢出分类视图。
      if (this.settings.activeCategory) return;
      // P站 作品详情同理：这里的"卡片"是同一个作品的全部页，没有下一页可补，
      // 而补图会重搜 ⇒ 用户会被静默踢出作品详情。
      if (this.pixivDetail) return;
      // ⚠️ 这里**不再**按 autoLimit() 早退：固定张数档位（"至少 N 张"）一屏放不下时也要补，
      //    否则节点一大就只剩半屏空白（2026-09-16 用户 limit=12 的真实场景）。
      //    真正的闸门是下面的 gridUnderfilled()：一屏放得下就一张都不多取。
      if (!this.posts.length) return;
      if (!this.gridUnderfilled()) return;
      // 游标模式的源：契约只有 next_cursor，没有它就到底了；页码模式的源由后端按 page 换算 offset
      if (!this.pageMode() && !this.nextCursor) {
        this.fillMoreExhausted = true;
        return;
      }
      const before = this.posts.slice();
      const seen = new Set(before.map((post) => String(post.id)));
      // ⚠️ 补图过程中 search() 会用**新批**重建 pixivPageGroups（1426 → foldPixivPages），
      //    只保留新批的页 ⇒ 早批作品的「全部页」会静默失效（按钮还在，点了没反应）。
      //    先把当前分组留下来，合并完再并回去（见下面的合并与 catch 恢复）。
      const keepPixivGroups = this.pixivPageGroups;
      this.fillMoreBusy = true;
      try {
        if (this.pageMode()) {
          // 页码模式（D站 page / P站 page）：取下一页（D站 老路由/老参数一个字节没改）
          this.page += 1;
          await this.search();
        } else {
          // 游标模式（C站）：cursor 栈前进一批
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
          // 把两批的多页作品分组并起来（同 id 以新批为准）：否则早批卡片的「全部页」点了没反应
          const groups = new Map(keepPixivGroups || []);
          for (const [id, pages] of (this.pixivPageGroups || new Map())) groups.set(id, pages);
          this.pixivPageGroups = groups.size ? groups : null;
          this.setStatus(`${this.sourceLabel()}：已补到 ${merged.length} 张（填满本屏）`);
        }
        this.renderPosts();
        this.renderPagination();
      } catch (error) {
        // 补图失败不该打断用户：恢复原结果集（连同多页分组），把原因写在状态栏
        this.posts = before;
        this.pixivPageGroups = keepPixivGroups;
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
      // 分类浏览不补图（有限本地集合 + 补图会静默退出分类视图，理由见 fillMoreForHeight 顶部）
      if (this.settings.activeCategory) return;
      // P站 作品详情也不补图（理由同上：作品的全部页已铺满，补图只会把人踢出详情）
      if (this.pixivDetail) return;
      // ⚠️ 固定张数档位（"至少 N 张"）同样允许补图 —— 旧实现在这里 `!this.autoLimit()` 直接早退，
      //    于是「limit=12 + 大节点」永远只有 12 张、剩下的格子全空（用户真机就是这个形态）。
      //    放行不等于乱补：下面 gridUnderfilled() 才是分界（一屏放得下就一张都不补），
      //    再加按需的轮次上限 + 30s/4 批时间窗 + 1.5s grace 三道闸。
      if (!this.posts.length) return;
      const target = this.autoFillTargetHeight();
      if (!(target > 0)) return;
      if (!this.gridUnderfilled(target)) return;
      // ② 轮次上限：**按还差几张算**（旧实现硬编码 1 轮，大节点根本补不满）
      if (this.autoFillRounds >= this.autoFillRoundsBudget(target)) return;
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
      // 游标模式的源：契约只有 next_cursor，没有它就到底了
      if (!this.pageMode() && !this.nextCursor) {
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

    /** 一轮补图大约能带回多少张（与实际请求发的 limit 同源） */
    autoFillPerRound() {
      // 页码模式的非 D站 源：P站 上游固定每页 GALLERY_PAGE_SIZE 张（gallerySearchParams 也发这个值）
      if (this.pageMode() && !this.isDanbooruSource()) return GALLERY_PAGE_SIZE;
      const limit = Number(this.resolveLimit());
      return limit > 0 ? limit : DG_MAX_PER_REQUEST;
    }

    /** 距离「填满一屏」还差几张（估算：缺口高度 ÷ 单卡高 × 列数） */
    autoFillNeed(target) {
      const total = Number(this._layoutTotal) || 0;
      const minCol = Number(this._layoutMinCol) || total;
      const filled = Math.max(0, Math.min(total, minCol));
      const shortfall = Math.max(0, Number(target) * DG_UNDERFILL_RATIO - filled);
      if (!(shortfall > 0)) return 0;
      const cardH = Math.max(DG_MIN_CARD_H, Number(this._measuredAvgCardH) || 0);
      const cols = Math.max(1, this.gridMetrics().cols);
      return Math.ceil(cols * (shortfall / cardH));
    }

    /**
     * 本轮结果集内允许自动补几批：= ceil(还差几张 / 一轮带回几张)，夹在 [1, DG_AUTO_FILL_MAX_ROUNDS_CAP]。
     * 旧实现是常量 1（最多补一批）—— 节点一大就明显补不满（用户 2026-09-16："还是填充不满节点"）。
     * 不会滚成无限循环：① 每补完一批都重新判 gridUnderfilled（真填满就停）；② 池子取空置 fillMoreExhausted；
     * ③ 30 秒内最多 DG_AUTO_FILL_MAX_PER_WINDOW 批的**时间窗**（不受任何重置影响）是硬闸。
     */
    autoFillRoundsBudget(target) {
      const need = this.autoFillNeed(target);
      if (!(need > 0)) return 0;
      return Math.max(1, Math.min(DG_AUTO_FILL_MAX_ROUNDS_CAP, Math.ceil(need / this.autoFillPerRound())));
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
      // ⚠️ 这里**不再** applyGridHeight()：refreshSettingsUI 的职责是「把 settings 刷进面板 UI」，
      //    不是「把 settings 灌进节点尺寸」。它挂在 onConfigure（工作流载入）路径上，原来会用
      //    settings.gridHeight 覆盖掉**工作流里保存的节点尺寸** —— 用户实报的「节点大小被动改变」
      //    正是这条（此刻 userResizedAt 仍是 0，所有"用户已手动改过尺寸"的守卫都还没生效）。
      //    现在尺寸真源只有一个：node.size[1]；settings.gridHeight 降级为它的记录副本。
      this.syncGridHeightFromNode();
      // 工作流里保存的图源要恢复成对应的控件可见性（P站 隐藏提示词类控件等）
      this.applySourceCapabilities();
    }

    /**
     * 把「节点当前高度」反写进 settings.gridHeight —— **只记录，绝不改尺寸**。
     *
     * 尺寸真源唯一：`node.size[1]`（用户拖出来的、或工作流里保存的那个）。
     * settings.gridHeight 只剩两个用途：① 设置面板输入框的显示值；② 节点尺寸异常时的兜底。
     * 反向（settings → 尺寸）**只允许发生在用户显式改设置面板时**，见 applyGridHeight()。
     *
     * 95 = 节点 chrome（标题栏/端口等）高度，与下方 installDOMWidgetSizeSync 的
     * `nodeChromeHeight: 95`、以及 onResize 里 `size[1] - 95` 是同一个值。
     */
    syncGridHeightFromNode() {
      const raw = Math.round((Number(this.node?.size?.[1]) || 0) - 95);
      if (!(raw > 0)) return;
      this.settings.gridHeight = Math.max(360, Math.min(1200, raw));
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

    /**
     * 轻量持久化：只写 localStorage，**不碰 node.properties、不标脏画布**。
     *
     * 用于 search() 这类**高频**路径（用户搜索 / 翻页 / 自动补图 / 列数变化重取 / 随机发现）：
     * 它们只改 `lastQuery` 这种"本机 UI 便利状态"，对节点在画布上的显示毫无影响，
     * 也不该跟着工作流走 —— 重开工作流并不会自动重搜一次，带过去只是白白撑大 properties。
     *
     * 与 saveSettings() 的分工：凡是改了**要跟工作流走**的（分类 / 预设 / 筛选 / 档位 / 开关）
     * 一律仍走 saveSettings()；只有纯 UI 状态才走这里。
     * ⚠️ 这里的**不标脏**才是收益主体：`setDirtyCanvas(true, true)` 会让下一帧整块画布重绘，
     *    而它原先挂在每一次搜索/翻页/补图上（这些操作一步都没改画布内容）。
     *
     * ⚠️ localStorage 仍写**全量**（含 postCategories）：后端虽是分类真源，但后端不可用时
     *    这份本机副本是唯一兜底，不能为了省序列化把它扔掉。
     */
    saveUiState() {
      try { localStorage.setItem(this.settingsKey(), JSON.stringify(this.settings)); } catch {}
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

    // ── 搜索历史（需求 2026-09-21：记录最近几次搜索、点一下就重新用）──
    // 设计取舍（用户只说了大意，细节由实现补足，均可按需放宽）：
    //  · 存**用户在搜索框里输入的原始串**，不是 `currentQuery()` 拼完筛选 token 的最终请求串 ——
    //    点击复用的语义是"再搜一次我当时输的东西"，而不是把当时的 age:/ratio: 也一起复活。
    //  · **按图源分开**：D站 的 tag 语法与 C站/P站 的关键词不通用，混在一起点了必然搜不到。
    //  · **每节点一份**（`getNodeStorageKey`，与 settings 一致；文档写明多节点搜索设置互相独立）。
    //  · **只写 localStorage、不写工作流属性**：历史是本地使用痕迹，不该随工作流分享给别人
    //    （settings 会用 `WORKFLOW_SETTINGS_PROPERTY` 跟着工作流走，历史刻意不跟）。
    //  · 去重按规范化键（见 searchHistoryKeyOf），命中的旧条目**提到最前**而不是新增一条。
    searchHistoryKey() {
      return `${SEARCH_HISTORY_KEY_PREFIX}${String(this.node?.id ?? "").trim() || "unassigned"}`;
    }

    /** 读出全部图源的历史；任何坏数据都退化成空对象，绝不阻塞搜索框 */
    loadSearchHistory() {
      try {
        const raw = JSON.parse(localStorage.getItem(this.searchHistoryKey()) || "{}");
        if (!raw || typeof raw !== "object") return {};
        const out = {};
        for (const source of GALLERY_SOURCE_ORDER) {
          const list = raw[source];
          if (!Array.isArray(list)) continue;
          // 只收**字符串**并限长：手改过 localStorage 的话，`[{"a":1}]` 会渲染成可点的
          // "[object Object]"；超长串则会把浮层撑爆（条数上限管不到单条长度）。
          out[source] = list
            .filter((v) => typeof v === "string")
            .map((v) => v.trim().slice(0, SEARCH_HISTORY_ITEM_MAX))
            .filter(Boolean)
            .slice(0, SEARCH_HISTORY_LIMIT);
        }
        return out;
      } catch {
        return {};
      }
    }

    saveSearchHistory(history) {
      try {
        localStorage.setItem(this.searchHistoryKey(), JSON.stringify(history || {}));
      } catch {
        /* 配额满：历史是可选功能，写不进去也不该影响搜索本身 */
      }
    }

    /** 当前图源（或指定图源）的历史列表，最新在前 */
    searchHistoryFor(sourceId = null) {
      const id = sourceId || this.activeSourceId();
      return this.loadSearchHistory()[id] || [];
    }

    /**
     * 记一次搜索。**只在"用户主动发起"的入口调用** ——
     * 别在工作流恢复的初次搜索 / 翻页 / 补图 / 竞态中被丢弃的搜索里调（那些不是用户的一次检索）。
     */
    recordSearchHistory(query) {
      const text = String(query || "").trim();
      if (!text) return;
      const id = this.activeSourceId();
      const key = searchHistoryKeyOf(text);
      const history = this.loadSearchHistory();
      const list = (history[id] || []).filter((item) => searchHistoryKeyOf(item) !== key);
      list.unshift(text);
      history[id] = list.slice(0, SEARCH_HISTORY_LIMIT);
      this.saveSearchHistory(history);
    }

    /** 删一条（按规范化键匹配；显示用的是原文） */
    removeSearchHistory(query, sourceId = null) {
      const id = sourceId || this.activeSourceId();
      const key = searchHistoryKeyOf(query);
      const history = this.loadSearchHistory();
      history[id] = (history[id] || []).filter((item) => searchHistoryKeyOf(item) !== key);
      this.saveSearchHistory(history);
    }

    /** 清空当前图源的历史 */
    clearSearchHistory(sourceId = null) {
      const id = sourceId || this.activeSourceId();
      const history = this.loadSearchHistory();
      delete history[id];
      this.saveSearchHistory(history);
    }

    /**
     * 在联想浮层的位置显示「最近搜索」。
     * 复用 `.adg-suggestions` 容器（它是挂在 body 上的 portal）—— 定位、点外部关闭、blur 收起、
     * 画布操作收起全部是现成的；互斥也因此**天然成立**：非空查询走联想、空查询走历史，同一个容器
     * 不可能同时显示两样。别另起一个浮层（那要再付一套单例清理 + 手写互斥的代价）。
     */
    showSearchHistory() {
      const suggestions = this.suggestions;
      if (!suggestions) return;
      // 多节点场景：后构建的节点在 build() 里会移除 body 上所有 `.adg-suggestions`（那是为修
      // "关不掉的联想条"事故加的单例清理），于是**先构建**的那个节点的浮层已经脱离文档。
      // 这里补挂一次，否则它的历史（以及联想）会静默失效。
      if (!suggestions.isConnected) document.body.append(suggestions);
      // ⚠️ 必须**同步**渲染（不能借 180ms 防抖）：聚焦那一刻就该看到历史。
      // 同时清掉联想可能在途的定时器/请求，避免它稍后把历史覆盖掉。
      if (this.suggestionTimer) { clearTimeout(this.suggestionTimer); this.suggestionTimer = null; }
      this.suggestionController?.abort();
      this.suggestionController = null;
      this.suggestionRequestId += 1;

      const items = this.searchHistoryFor();
      suggestions.classList.remove("is-localized");
      suggestions.replaceChildren();

      const head = document.createElement("div");
      head.className = "adg-search-history-head";
      const title = document.createElement("span");
      title.textContent = items.length ? `最近搜索 · ${items.length}` : "最近搜索";
      head.append(title);
      if (items.length) {
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "adg-search-history-clear";
        clear.textContent = "清空";
        clear.title = `清空「${this.sourceLabel?.(this.activeSourceId()) || "当前栏目"}」的搜索历史`;
        clear.addEventListener("pointerdown", (event) => event.stopPropagation());
        clear.addEventListener("mousedown", (event) => event.stopPropagation());
        clear.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.clearSearchHistory();
          this.refreshSearchHistoryView();
        });
        head.append(clear);
      }
      suggestions.append(head);

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "adg-search-history-empty";
        empty.textContent = "还没有搜索记录 —— 搜一次就会出现在这里";
        suggestions.append(empty);
      } else {
        suggestions.append(...items.map((text) => this.buildSearchHistoryRow(text)));
      }
      // ⚠️ 顺序不能反：`positionSuggestions()` 首行是「display === 'none' 就 return」，
      //    而浮层创建时 inline 就是 display:none（CSS 兜底的 top/left 是 0）——
      //    先 position 再 display 会让**首次**显示落在视口左上角。
      //    （fetchSuggestions 就是先 display 后 position，照它抄。）
      suggestions.style.display = "block";
      this.positionSuggestions();
    }

    /** 增删后原地重绘，并把焦点交还搜索框（否则 focus 落在被移除的按钮上，blur 逻辑会收起浮层） */
    refreshSearchHistoryView() {
      this.showSearchHistory();
      this.queryInput?.focus();
    }

    buildSearchHistoryRow(text) {
      const row = document.createElement("div");
      row.className = "adg-search-history-item";
      row.title = `搜索「${text}」`;
      // 与联想候选项同样的防抢：ComfyUI 画布 / 节点激活面罩会吃掉这几帧的点击
      row.addEventListener("pointerdown", (event) => event.stopPropagation());
      // ⚠️ mousedown 必须 `preventDefault`（不能只 stopPropagation）：否则默认行为会让搜索框失焦 →
      //    blur 逻辑 160ms 后收起浮层 → 这次点击的 mouseup 落在已被清空的容器上，click 根本不触发
      //   （表现：按住一会儿再松手 = 点了没反应）；而且节点侧的"补发点击"会把这次 mouseup 当成
      //    被面罩吃掉的点击、补发给下层卡片按钮。preventDefault 阻止焦点转移，搜索框保持聚焦，浮层不被收起。
      row.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });

      const label = document.createElement("span");
      label.className = "adg-search-history-text";
      label.textContent = text;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "adg-search-history-remove";
      remove.textContent = "✕";
      remove.title = "从历史里删掉这一条";
      remove.addEventListener("pointerdown", (event) => event.stopPropagation());
      // 同上：不 preventDefault 的话，按住删除键也会先被 blur 收起浮层、点击落空
      remove.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.removeSearchHistory(text);
        this.refreshSearchHistoryView();
      });

      row.append(label, remove);
      row.addEventListener("click", () => this.applySearchHistoryQuery(text));
      return row;
    }

    /**
     * 用户主动提交一次搜索的统一收口 = 填搜索框 + 记历史 + 收起浮层 + 滚回顶部 + 发起搜索。
     * 覆盖「用户意图明确」的入口：搜索框回车 / 「搜索」按钮 / 点联想候选 / 点 prompt 标签 / 点历史条目。
     * ⚠️ **不要**用它覆盖：翻页、补图、换源重搜、筛选与设置变更重搜、模糊纠错与重试递归、
     * build() 的初次搜索 —— 那些都不是"用户的一次检索"（`search()` 有 30 个调用点，其中 ≥14 个是状态驱动）。
     */
    submitSearch(query) {
      // 任何「用户主动提交搜索」都意味着离开差分组浏览（回车 / 「搜索」按钮 / 点联想候选 /
      // 点 prompt 标签 / 点历史条目 / 预设）——「← 返回」不该与搜索框状态打架。
      // 差分跳转自己**不走**这里（见 openDiffGroup）：它不是用户的一次检索，不该进搜索历史。
      this.leaveDiffGroup();
      const text = String(query ?? "").trim();
      if (text) {
        this.setQuery(text);
        // ⚠️ 必须在这里就取原文：`search()` 内部会用 setQuery(lastQuery) 把输入框改写成规范化结果
        //（小写、丢掉 order:、截断到 8 个标签），到那时"用户输入的原文"已经没了。
        this.recordSearchHistory(text);
      }
      this.hideSuggestions();
      if (this.grid) this.grid.scrollTop = 0;
      void this.search({ resetPage: true }).catch((error) => {
        // 不打断 UI，但也别把错误吞干净 —— 这几个入口原本会把失败冒到 console
        console.warn("[画廊] 搜索失败:", error);
      });
    }

    /** 点历史条目 = 与其它用户搜索入口走同一条路径 */
    applySearchHistoryQuery(text) {
      this.submitSearch(text);
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
      const query = String(value ?? "");
      // 空查询 = 显示「最近搜索」（占用联想浮层的位置）。
      // 历史是本地数据、与图源无关，所以这条要放在 D站 守卫**之前**判：
      // 三个图源都有搜索框 —— C站 的 `capability.query=false` 只是把它切到"页内本地过滤"模式
      //（框还在、照样能输入），P站 是正常的关键词搜索。所以历史对三者都适用。
      if (!query.trim()) {
        this.showSearchHistory();
        return;
      }
      // 联想走的是 D站 /anima/danbooru/suggest（Danbooru tag 词典）：非 D站 图源没有这套词典，
      // 弹出来的候选一定插不进去 —— 直接不弹（capabilities.tags=false 的 C站 尤其如此）。
      if (!this.isDanbooruSource()) {
        this.hideSuggestions();
        return;
      }
      if (this.suggestionTimer) clearTimeout(this.suggestionTimer);
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
      // ★ 一旦发起搜索，联想浮层就必须收起 —— 这是**所有**搜索入口（回车 / 搜索按钮 /
      //   点候选词 / 模糊纠错重搜）的统一收敛点。
      //   用户 2026-09-20 实报"点了上面的按钮搜索之后（联想）会重新出现"：点候选走的是
      //   `setQuery()`，而它在输入框仍聚焦时会再排一次联想（180ms 后弹）—— 在这里清掉
      //   定时器即可（hideSuggestions 内部会 clearTimeout）。
      this.hideSuggestions();
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
      // 切到 D站 取数 = 离开 P站 作品详情（两种上下文分属不同图源，留着会互相打架）
      this.pixivDetail = null;
      this.pixivPageGroups = null;
      this.syncReturnButton();
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
      // 高频路径：只落 localStorage。这里改的是"本机搜索框回填值"，与画布显示无关，
      // 不该写 properties、更不该 setDirtyCanvas 标脏整块画布（见 saveUiState 注释）。
      this.saveUiState();
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
        // 差分浏览时状态栏明说当前是差分组，而不是让用户以为搜索词被悄悄改了
        const source = this.diffContext ? `差分组 parent:${this.diffContext.rootId}` : (data.cached ? "缓存" : "D站");
        const notices = [];
        if (Array.isArray(data.warnings) && data.warnings.length) notices.push(...data.warnings.map(String));
        // 差分组只剩根帖自己 = 子帖已删除/隐藏，别让用户以为「差分」按钮坏了
        if (this.diffContext && this.posts.length <= 1) notices.push("未找到该作品的可显示差分（子帖可能已删除或隐藏）");
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
      // 分类浏览与 P站 作品详情是两种**互斥**的"展示层覆盖"：同时开着会让网格与分页条各说各话
      //（分页徽章写"本地分类浏览"、网格却是某个作品的全部页）。进分类就先退出作品详情（问题 2）。
      this.pixivDetail = null;
      this.syncReturnButton();
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
      const known = Object.values(this.settings.postCategories).filter((cid) => cid === catId).length;
      if (!known) {
        this.posts = [];
        this.renderPosts();
        this.renderPagination();
        this.setStatus(`分类「${catName}」还没有图片：在搜索页点图片卡片的「分类」即可归类`, "");
        return;
      }
      const targetId = catId;
      this.setStatus(`正在加载分类「${catName}」${known} 张…`);
      if (this.grid) this.grid.setAttribute("aria-busy", "true");
      let posts = [];
      try {
        // ★ 读**本地快照**（`/anima/gallery/posts?category=`），不再按 `id:` 元标签回查图源 ——
        //   旧实现只有 D站 能被回查（`id:` 是 D站 专有），所以 P站/C站 的分类浏览永远是空的
        //   （用户实报"P站画廊的分类是个摆设"）。
        posts = await this.fetchCategoryPosts(targetId);
        // 竞态：期间用户又切换了分类/发起了搜索 → 放弃本次渲染
        if (this.settings.activeCategory !== targetId) return;
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
      const missing = Math.max(0, known - posts.length);
      this.setStatus(
        `分类「${catName}」：${posts.length} 张已归类图片（读本地快照，三个图源通用）`
        + (missing ? `，${missing} 张还没有快照（旧数据迁移而来，下次归类时会补上）` : ""));
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
            // 记历史要记**替换后的完整标签串** —— 用户敲的半截串不算一次检索
            this.submitSearch(empty ? target : replaceWordAt(raw, pos, target));
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
      // O(1) 去重：原实现用 `orderedKeys.includes(key)`，选满 n 张时退化成 O(n²)
      // （`selectionOrder` 本身可能含重复项，所以这里的去重语义必须保留）。
      const seenKeys = new Set();
      for (const key of this.selectionOrder) {
        if (cardsByKey.has(key) && !seenKeys.has(key)) { seenKeys.add(key); orderedKeys.push(key); }
      }
      for (const card of selectedCards) {
        const key = this.selectionKey(card);
        if (key && !seenKeys.has(key)) { seenKeys.add(key); orderedKeys.push(key); }
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
          throw new Error("当前工作流模板中没有启用的 TK 多重画廊节点");
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
      // P站 作品已匹配 D站 → 用 D站 帖子的规范标签（字段名与 posts 完全一致，同一套解析直接复用）。
      // 这条必须放在最前：匹配的意义就是拿 D站 标签取代 pixiv 那套模型不认识的词。
      const matched = this.pixivMatchOf(post);
      if (matched) {
        for (const category of PROMPT_CATEGORY_ORDER) {
          for (const tag of String(matched[`tag_string_${category}`] || "").split(" ")) add(category, tag);
        }
        if (Object.values(groups).every((tags) => tags.length === 0)) {
          for (const tag of String(matched.tag_string || "").split(" ")) add("general", tag);
        }
        return groups;
      }
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
      // P站 作品一旦匹配到 D站 帖子，就有规范 prompt 可用（这才是模型认识的那套标签）
      if (this.pixivMatchOf(post)) return true;
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
      // 去冗余：不同标签译成同一个中文时（如 `1girl` 与 `solo`/同义译名）只保留第一条，
      // 否则备注会变成「口交、口交、口交…」这种重复串。
      const seen = new Set();
      const labels = [];
      for (const { tag, sign } of parts) {
        const translated = String(translations[tag] || "").trim();
        const fallback = tag.replace(/_/g, " ");
        const label = translated || fallback;
        const text = sign === "-" ? `排除${label}` : sign === "~" ? `近似${label}` : label;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        labels.push(text);
      }
      return labels.join("、").slice(0, 240);
    }

    async hydratePresetNotes(onUpdated) {
      if (this.presetNoteHydration) {
        const changed = await this.presetNoteHydration;
        if (changed) onUpdated?.();
        return changed;
      }
      // ⚠️ `noteManual` 的预设不参与自动补全：用户手填的（或故意留空的）备注必须原样保留，
      // 否则下次打开面板就被自动翻译覆盖 —— 这是「自定义备注」的关键约束。
      const missing = this.settings.presets.filter((preset) => preset.query && !preset.note && !preset.noteManual);
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

    /**
     * 差分组根帖 id。D站 的 `parent:<id>` 语义是 `parent_id = id OR id = id`
     * （2026-09-21 实测 posts.json?tags=parent%3A10994513 同时回父帖与它的子帖），
     * 所以有父级时用父帖 id 当根，一次就能取到「父帖 + 全部同级差分」；没有父级但有
     * 活跃子帖时用自己当根。返回 0 = 该帖不存在差分关系（不画按钮、不画角标）。
     */
    diffRootId(post) {
      const parentId = Number(post?.parent_id);
      if (Number.isFinite(parentId) && parentId > 0) return parentId;
      // has_children 为真但子帖全被删除/隐藏（has_active_children=false）时，parent:<id> 只会回自己一张
      const hasActiveChildren = post?.has_active_children === true || post?.has_active_children === "t";
      if (hasActiveChildren) return Number(post?.id) || 0;
      return 0;
    }

    /**
     * 进入差分组浏览：把搜索词换成 `parent:<根帖id>` 重搜，并亮出搜索框旁的「← 返回」。
     * 与 D站 网页点 "This post has N child" 之后的 `?q=parent%3A<id>` 是同一套查询，
     * 复用现有搜索/分页/多选/入库/下载全链路，不新造一套取数路径。
     * ⚠️ 刻意**不走** submitSearch：那是"用户的一次检索"，会记进搜索历史（parent:<id> 是噪音）。
     */
    openDiffGroup(post) {
      const rootId = this.diffRootId(post);
      if (!rootId) return;
      const previous = this.diffContext;
      this.diffContext = {
        rootId,
        // 在差分组里再点别的卡片的「差分」时，返回按钮仍回到**最初**那次搜索词，而不是层层回退
        returnQuery: previous ? previous.returnQuery : String(this.queryWidget?.value ?? ""),
        returnPage: previous ? previous.returnPage : this.page,
      };
      this.setQuery(`parent:${rootId}`);
      // setQuery 在输入框仍聚焦时会再排一次联想（键盘触发「差分」的场景）——立刻收起，
      // 与 submitSearch 的收口行为对齐（浮层不该盖在刚重搜的画廊上）。
      this.hideSuggestions();
      this.syncReturnButton();
      if (this.grid) this.grid.scrollTop = 0;
      // force：绕过 30s 搜索缓存 —— 刚从同一个 parent:<id> 退出来再点进去，否则拿到的是旧页
      void this.search({ resetPage: true, force: true });
    }

    /** 退出差分组浏览：还原进入前的搜索词与页码 */
    exitDiffGroup() {
      const context = this.diffContext;
      if (!context) return;
      this.leaveDiffGroup();
      this.setQuery(context.returnQuery);
      this.hideSuggestions();
      this.page = context.returnPage || 1;
      // 回到原视图时滚回顶部：否则会停在差分组里滚动到的位置，看起来像"没返回成功"
      if (this.grid) this.grid.scrollTop = 0;
      void this.search({ resetPage: false, force: true });
    }

    /** 离开差分组浏览：只收状态与按钮，**不改搜索词也不重搜**（用户自己改词 / 换图源时用） */
    leaveDiffGroup() {
      if (!this.diffContext) return;
      this.diffContext = null;
      this.syncReturnButton();
    }

    // ──────────────────────── P站 多页作品（折叠 / 展开） ────────────────────────
    // P站 适配器把「一个作品 × N 页」展开成 N 条 item（id = `<illust_id>_p<page>`，meta 带
    // page / page_count / illust_id，见 anima_gallery_pixiv.illust_to_items）——那是为了修
    // "P站 只显示第一页"。但把 N 条全铺进瀑布流会让一页变成上百张卡片：节点视口放不下，
    // 视口外的卡片永远点不到（2026-09-21 真机实报）。这里折回「一作品一张卡」，
    // 其余页等卡片「全部页」按钮再展开 —— 与 Pixiv 网页「缩略图带页数、点进作品才看全部页」一致。

    /**
     * 按 illust_id 折叠多页作品：一个作品只出一张卡（它的第一页），其余页收进 pixivPageGroups。
     * 单页作品（无 illust_id）与其它图源**原样返回**（零影响）。
     */
    foldPixivPages(posts) {
      const groups = new Map();
      for (const post of posts) {
        const illustId = String(post?.meta?.illust_id || "");
        if (!illustId) continue;
        const bucket = groups.get(illustId);
        if (bucket) bucket.push(post);
        else groups.set(illustId, [post]);
      }
      this.pixivPageGroups = groups.size ? groups : null;
      if (!groups.size) return posts;
      const seen = new Set();
      const cards = [];
      for (const post of posts) {
        const illustId = String(post?.meta?.illust_id || "");
        if (!illustId) { cards.push(post); continue; }   // 单页作品：没有 illust_id，原样出卡
        if (seen.has(illustId)) continue;                 // 同一作品的第 2..N 页：不再单独出卡
        seen.add(illustId);
        cards.push(post);                                 // 适配器按 page 升序 push ⇒ 首条就是第一页
      }
      return cards;
    }

    /** 当前该渲染哪些卡片：P站「全部页」详情模式下是单个作品的全部页，否则是搜索结果本身 */
    displayPosts() {
      return this.pixivDetail?.pages?.length ? this.pixivDetail.pages : this.posts;
    }

    // ──────────────────────── C站「无限加载」池 ────────────────────────
    // 由来（2026-09-21）：C站 的图片接口忽略 query，关键词只能在本地筛；而原实现每批只取当页
    //（设置里最多 48 张）—— 于是「搜索」实际上只在那 24~48 条里找，基本等于没有。
    // 这里把「取数」与「展示」拆开：后端按档位预取一整池，展示只切池里的一段，
    // 搜索则在**整池**上筛 —— 跨页生效，且改关键词零请求。
    // 开关关闭时 poolMode() 恒为 false，以下分支一个都不会进入。

    /** 是否处于 C站池模式（图源是 C站 且设置里开了「无限加载」） */
    poolMode() {
      return this.activeSourceId() === "civitai" && this.settings.civitaiPool?.enabled === true;
    }

    /** 池模式下「一页」切多少张：跟随设置里的每页数量；自适应档位回退到 GALLERY_PAGE_SIZE */
    poolPageSize() {
      const configured = Number(this.settings.limit) || 0;
      return configured > 0 ? configured : GALLERY_PAGE_SIZE;
    }

    /** 池的上游参数指纹：排序 / NSFW / 时间 / 作者 变了就得重建池；关键词**不在**其中（那是本地筛的事） */
    poolFingerprint() {
      return JSON.stringify(this.gallerySourceFilters("civitai") || {});
    }

    /** 池内关键词过滤：与后端 `_item_matches` 同源语义（prompt / 负面词 / 作者 三处「全词命中」AND） */
    poolFilterPosts(posts) {
      const terms = String(this.gallerySourceQuery() || "").toLowerCase().replace(/，/g, " ").split(/\s+/).filter(Boolean);
      if (!terms.length) return posts;
      return posts.filter((post) => {
        const meta = post?.meta && typeof post.meta === "object" ? post.meta : {};
        const haystack = [post?.prompt, post?.negative_prompt, meta.username]
          .map((value) => String(value || "")).join(" ").toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }

    /** 池内已被关键词筛出的条数（分页与状态栏都用它） */
    poolFilteredCount() {
      return this.poolFilterPosts(this.sourcePool?.posts || []).length;
    }

    /** 池模式下当前该展示的卡片：整池 → 按关键词筛 → 按页切一段 */
    poolVisiblePosts() {
      const filtered = this.poolFilterPosts(this.sourcePool?.posts || []);
      const size = this.poolPageSize();
      // ⚠️ `poolPageIndex` 会**超出**过滤结果的页数：搜索态下关键词一改、或翻过头，
      //    匹配数可能只剩一两页 —— 此时 slice 越界返回空数组，表现就是「卡片全部消失、
      //    整页空白」，而分页条因为用了 min() 仍显示"第 N/M 批"，显示与内容脱节
      //（2026-09-21 真机实报：搜索态点「下一批」翻过头、或点「加载更多」后页面保持空白，
      //  必须手动点一次「搜索」才恢复 —— 因为那次带 resetPage，会把下标归零）。
      // 所以这里必须夹回有效范围，并**同步写回状态**，让分页条与实际切片保持一致。
      const pages = Math.max(1, Math.ceil(filtered.length / size));
      const index = Math.min(Math.max(0, this.poolPageIndex || 0), pages - 1);
      if (index !== this.poolPageIndex) this.poolPageIndex = index;
      const start = index * size;
      return filtered.slice(start, start + size);
    }

    /**
     * 把新拿到的内容并入池（按 id 去重、保持上游顺序）。
     * `reset=true` = 重建池（首批 / 换了档位 / 换了上游筛选），旧池整个丢掉。
     */
    accumulatePool(posts, { nextCursor = null, reset = false } = {}) {
      if (reset || !this.sourcePool) {
        this.sourcePool = { posts: [], cursor: null, exhausted: false, fingerprint: this.poolFingerprint() };
        this.poolPageIndex = 0;
      }
      const seen = new Set(this.sourcePool.posts.map((post) => String(post.id)));
      for (const post of posts) {
        const key = String(post.id);
        if (key && !seen.has(key)) {
          seen.add(key);
          this.sourcePool.posts.push(post);
        }
      }
      this.sourcePool.cursor = nextCursor || null;
      if (!nextCursor) this.sourcePool.exhausted = true;
    }

    /** 池模式：把展示源切成当前页并重渲染（翻页 / 改词 / 补池后都走它） */
    applyPoolView() {
      this.posts = this.poolVisiblePosts();
      this.renderPosts();
      this.renderPagination();
    }

    /** 池模式的状态栏文案：搜索态说清「已累计加载 N 条 + 筛出 M 条」 */
    poolStatusText() {
      const pool = this.sourcePool;
      if (!pool) return "";
      const loaded = pool.posts.length;
      const query = String(this.gallerySourceQuery() || "").trim();
      if (!query) {
        return `C站 已加载 ${loaded} 条${pool.exhausted ? "（上游已到底）" : ""} · 第 ${(this.poolPageIndex || 0) + 1} 批`;
      }
      return `C站 关键词本地筛选：本次已累计加载 ${loaded} 条，按『${query}』筛出 ${this.poolFilteredCount()} 条`
        + (pool.exhausted ? "" : "（可点「加载更多」继续往后加载）");
    }

    /**
     * 池模式下的翻页：优先切池里已有的一段；要看的这段还没加载到、且上游还有 → 补「一页」的量。
     * 这是「直接浏览」（没有关键词）的行为；搜索态看到底时由分页条上的「加载更多」补一个档位。
     */
    async stepPoolPage(delta) {
      const pool = this.sourcePool;
      if (!pool) return;
      const next = (this.poolPageIndex || 0) + (delta > 0 ? 1 : -1);
      if (next < 0) return;
      const size = this.poolPageSize();
      // ⚠️ 补池判据必须用**过滤后**的条数，不能用池内总条数：搜索态下池里也许有 200 条，
      //    但匹配的只有 20 条 —— 按池总长判断会以为"还有得翻"，于是翻出空白页。
      if (delta > 0 && (next + 1) * size > this.poolFilteredCount() && !pool.exhausted) {
        await this.growPool({ target: size });
      }
      this.poolPageIndex = next;
      this.applyPoolView();
      this.setStatus(this.poolStatusText());
    }

    /**
     * 补池：从池尾游标继续往后拉 `target` 条（浏览态传「一页数量」，搜索态「加载更多」传设置档位）。
     * 刻意复用 `gallerySearchParams` 构参 —— 上游筛选（排序 / NSFW / 时间 / 作者）与首批完全一致。
     */
    async growPool({ target = 0 } = {}) {
      const pool = this.sourcePool;
      if (!this.poolMode() || !pool || !pool.cursor) return false;
      const sourceId = "civitai";
      const amount = Math.max(1, Number(target) || this.settings.civitaiPool.target);
      const parameters = this.gallerySearchParams(sourceId, this.gallerySourceQuery());
      parameters.set("cursor", pool.cursor);      // 从池尾继续，而不是从当前展示页
      parameters.set("pool_target", String(amount));
      try {
        this.setStatus(`正在后台加载 ${amount} 条…`);
        const response = await fetch(`/anima/gallery/${encodeURIComponent(sourceId)}/search?${parameters}`);
        const data = await this.readGalleryResponse(response);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        const items = Array.isArray(data?.items) ? data.items : [];
        const incoming = items
          .map((item) => this.galleryItemToPost(item, sourceId))
          .filter((post) => post.preview_file_url || post.large_file_url);
        const nextCursor = data?.next_cursor == null || data.next_cursor === "" ? null : String(data.next_cursor);
        this.accumulatePool(incoming, { nextCursor });
        return true;
      } catch (error) {
        this.setStatus(`后台加载失败：${error?.message || "未知错误"}`, "error");
        return false;
      }
    }

    /**
     * 显式重建池：丢掉现有池，按当前档位与上游筛选重新拉一遍（池模式下的「强制刷新」）。
     * 为什么需要它：池模式下改关键词**不会**重建池（那是本地筛，正是省请求的地方），
     * 于是「我想重新取一遍」就没有入口了 —— 排序/NSFW/时间/作者变化会自动重建，其余情况点这个按钮。
     */
    async rebuildPool() {
      if (!this.poolMode()) return;
      this.sourcePool = null;
      this.poolPageIndex = 0;
      this.setStatus(`正在重建池（档位 ${this.settings.civitaiPool.target} 条）…`);
      // 池已置空 ⇒ searchGallerySource 入口的「池内短路」不会命中，这里会真的去请求
      await this.searchGallerySource({ resetPage: true });
    }

    // ──────────────────────── P站 作品 → D站 帖子 匹配 ────────────────────────
    // P站 标签模型不认识，而 D站 收录了大量 P站 作品、帖子自带 pixiv_id。
    // 于是「按作品 id 反查 D站 帖子、用它的规范标签当 prompt」—— 不翻译、不 WD14 反推。
    // 默认关闭；手动入口是卡片上的「匹配D站」按钮，成功即变灰 + 绿字「已匹配」（防重复请求）。

    /** pixiv 作品 id：多页作品在 meta.illust_id；单页作品就是它自己的 id（适配器不加页码后缀） */
    pixivIllustId(post) {
      const meta = post?.meta && typeof post.meta === "object" ? post.meta : {};
      return String(meta.illust_id || post?.id || "").split("_p")[0];
    }

    /** pixiv 页号（0 起）：适配器写在 meta.page；详情页的卡片 id 形如 `<illust_id>_p2` 也能兜底 */
    pixivPageOf(post) {
      const meta = post?.meta && typeof post.meta === "object" ? post.meta : {};
      const fromMeta = Number(meta.page);
      if (Number.isFinite(fromMeta) && fromMeta >= 0) return fromMeta;
      const match = String(post?.id || "").match(/_p(\d+)$/);
      return match ? Number(match[1]) : 0;
    }

    /**
     * 该 **页** 对应到哪个 D站 帖子（其它图源 / 未匹配 → null）。
     * 后端按页归并返回 `{pages: {"0": 帖子, ...}, root: 帖子}`：首页取 p0 那贴、第二页取 p1 那贴 ——
     * 这样首页**不会**被后几页的 NSFW 标签污染（2026-09-21 修：早先整个作品共用一条帖子的标签）。
     * 该页在 D站 没有独立帖子时，退到 `root` 兜底。
     */
    pixivMatchOf(post) {
      if (this.postSourceId(post) !== "pixiv") return null;
      const illustId = this.pixivIllustId(post);
      const entry = illustId ? this.pixivMatches.get(illustId) : null;
      if (!entry) return null;
      const pages = entry.pages && typeof entry.pages === "object" ? entry.pages : null;
      if (pages) {
        return pages[String(this.pixivPageOf(post))] || entry.root || null;
      }
      // 兼容上一版的扁平回包（单条帖子）：当成 root 用，免得半更新状态下取不到
      return entry.post_id ? entry : null;
    }

    /** 批量反查并写回 pixivMatches（值 = `{pages, root}`）；返回一个代表条目供手工路径反馈 */
    async fetchPixivMatches(illustIds) {
      const pending = [...new Set(illustIds)].filter((id) => id && !this.pixivMatches.has(id));
      if (!pending.length) return null;
      const response = await fetch(`/anima/danbooru/pixiv_match?ids=${encodeURIComponent(pending.join(","))}`);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      const matches = data?.matches && typeof data.matches === "object" ? data.matches : {};
      let first = null;
      for (const [id, entry] of Object.entries(matches)) {
        this.pixivMatches.set(String(id), entry);
        // 反馈用的代表：优先第 0 页，其次 root（调用方只拿它显示"匹配到哪一贴"）
        const sample = entry?.pages?.["0"] || entry?.root || null;
        if (!first && sample) first = sample;
      }
      return first;
    }

    /** 匹配成功后**就地**刷新这张卡的 prompt 相关字段（不重建网格 → 不丢选中状态） */
    refreshCardPrompt(card, post) {
      if (!card || !post) return;
      const result = this.buildPromptForPost(post);
      card.dataset.prompt = result.prompt;
      card.dataset.tags = JSON.stringify(result.tags);
      card.dataset.promptGroups = JSON.stringify(result.groups);
      card.dataset.promptParts = JSON.stringify(splitPromptParts(result.prompt));
    }

    /** 把一张卡的「匹配D站」按钮切成成功态（变灰 + 绿字，防重复请求） */
    markMatchButton(button) {
      if (!button) return;
      button.disabled = true;
      button.textContent = "已匹配";
      button.classList.add("is-matched");
    }

    /** 手工「匹配D站」：只反查这一张；未收录时按钮恢复可点，允许以后重试 */
    async matchPixivPost(post, button) {
      const illustId = this.pixivIllustId(post);
      if (!illustId || this.pixivMatches.has(illustId) || this.pixivMatchBusy.has(illustId)) return;
      this.pixivMatchBusy.add(illustId);
      if (button) { button.disabled = true; button.textContent = "匹配中…"; }
      try {
        const found = await this.fetchPixivMatches([illustId]);
        if (found) {
          this.markMatchButton(button);
          this.refreshCardPrompt(button?.closest?.(".adg-card"), post);
          // 提示里报的是**当前页**对应的那贴（不是代表条目）——用户点的就是这一页
          const mine = this.pixivMatchOf(post) || found;
          this.setStatus(`已匹配到 D站 #${mine.post_id}（P站 第 ${this.pixivPageOf(post) + 1} 页 · ${mine.tag_count} 个 Danbooru 标签）—— 输出将使用它`, "success");
          return;
        }
        if (button) {
          button.disabled = false;
          button.textContent = "匹配D站";
          button.title = "Danbooru 未收录这个 pixiv 作品（或尚未收录）；收录后可再点一次";
        }
        this.setStatus("D站 未收录这个 pixiv 作品，暂时拿不到 Danbooru 标签", "error");
      } catch (error) {
        if (button) { button.disabled = false; button.textContent = "匹配D站"; }
        this.setStatus(`匹配失败：${error?.message || "未知错误"}`, "error");
      } finally {
        this.pixivMatchBusy.delete(illustId);
      }
    }

    /**
     * 自动关联（设置开关开启、且当前是 P站）：对本批结果**一次**批量反查，命中的就地刷成已匹配。
     * 刻意不重建网格 —— 用户可能已经选中了几张，重建会丢选中状态。
     */
    async autoMatchPixiv(posts) {
      if (this.settings.pixivMatch?.auto !== true) return;
      if (this.activeSourceId() !== "pixiv") return;
      const ids = (posts || [])
        .filter((post) => this.postSourceId(post) === "pixiv")
        .map((post) => this.pixivIllustId(post));
      if (!ids.length) return;
      try {
        const before = new Set(this.pixivMatches.keys());
        await this.fetchPixivMatches(ids);
        const added = [...this.pixivMatches.keys()].filter((id) => !before.has(id));
        if (!added.length) return;
        let updated = 0;
        for (const card of this.grid?.querySelectorAll(".adg-card") || []) {
          const cardId = String(card.dataset.postId || "").split("_p")[0];
          if (!this.pixivMatches.has(cardId)) continue;
          const post = (this.posts || []).find((item) => String(item.id) === String(card.dataset.postId));
          if (post) this.refreshCardPrompt(card, post);
          this.markMatchButton([...card.querySelectorAll(".adg-card-actions button")]
            .find((button) => button.textContent === "匹配D站" || button.textContent === "匹配中…"));
          updated += 1;
        }
        if (updated) {
          this.setStatus(`P站：已自动匹配 ${updated} 个作品的 Danbooru 标签（输出将使用它们）`, "success");
        }
      } catch (error) {
        this.setStatus(`P站 自动匹配失败：${error?.message || "未知错误"}`, "error");
      }
    }

    /**
     * 进入 P站 作品详情 = 展开该作品的全部页，等价于 Pixiv 网页点进 /artworks/<id>。
     * **只在展示层覆盖**（不动 this.posts / 光标栈 / 页码），所以「← 返回」不需要重新请求。
     */
    openPixivPages(post) {
      const illustId = String(post?.meta?.illust_id || "");
      const pages = this.pixivPageGroups?.get(illustId);
      if (!illustId || !pages?.length) return;
      this.pixivDetail = { illustId, pages: pages.slice() };
      if (this.grid) this.grid.scrollTop = 0;
      this.syncReturnButton();
      this.renderPosts();
      this.renderPagination();
      this.setStatus(`P站 作品 #${illustId}：全部 ${pages.length} 页（点搜索框旁「← 返回」回到搜索结果）`);
    }

    /** 离开 P站 作品详情：只收状态 + 重渲染（搜索结果本身从未被动过，不必重搜） */
    closePixivPages() {
      if (!this.pixivDetail) return;
      this.pixivDetail = null;
      this.syncReturnButton();
      this.renderPosts();
      this.renderPagination();
      this.setStatus(`${this.sourceLabel(this.activeSourceId())}：${this.posts.length} 张 · ${this.galleryBatchLabel()}`);
    }

    // ──────────────────────── 搜索框旁的「← 返回」 ────────────────────────

    /**
     * 「← 返回」按钮的唯一数据源：当前所处的**上一层视图**。
     * · D站 差分组（换过搜索词）→ 返回 = 还原原搜索词与页码并重搜（数据要重新取）；
     * · P站 作品详情（只是展示层覆盖）→ 返回 = 直接还原本地结果，不必重搜。
     * 两者分属不同图源、不会同时存在，所以共用搜索框旁这一颗按钮。
     */
    returnTarget() {
      if (this.pixivDetail) {
        return { label: "搜索结果", title: "回到 P站 搜索结果（不重新请求）", apply: () => this.closePixivPages() };
      }
      if (this.diffContext) {
        const original = String(this.diffContext.returnQuery || "").trim();
        return { label: original, title: `退出差分组，回到搜索：${original || "（无关键词）"}`, apply: () => this.exitDiffGroup() };
      }
      return null;
    }

    /** 按钮与当前「上一层视图」同步（没有可返回的层时整颗按钮不占位） */
    syncReturnButton() {
      const button = this.diffReturnBtn;
      if (!button) return;
      const target = this.returnTarget();
      button.hidden = !target;
      if (!target) return;
      const label = String(target.label || "").trim();
      button.textContent = label ? `← 返回 ${label}` : "← 返回";
      button.title = target.title || "返回上一层视图";
    }

    /** 点「← 返回」：回到上一层视图（差分组 / 作品详情各自处理） */
    goBack() {
      const target = this.returnTarget();
      if (!target) return;
      target.apply();
    }

    renderPosts() {
      // 浮层收尾 —— **只收可交互浮层（D站）**：C站 浮层的生命周期必须保持改动前那样
      // （一直留到鼠标离开），否则就成了"仅 D站"之外的行为变化（独立审计抓到的外溢）。
      // 这里**无条件**收：下面会 replaceChildren 整体重建全部卡片，浮层指向的那张卡必然失效
      //（"自动填图只是追加卡片"是错的 —— fillMoreForHeight 也是走 renderPosts 全量重建）。
      // ⚠️ 不要改成"判断卡片 isConnected"：那样求值时旧卡片还在文档里，守卫恒为 false（死代码）。
      if (this.tooltip?.classList.contains("is-danbooru")) this.hidePromptTooltip();
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
      // 渲染源：P站 作品详情模式下是「该作品全部页」，否则是搜索结果本身（见 displayPosts）
      const posts = this.displayPosts();
      // 见过的 post 登记进 key→post 索引：归类时靠它取快照（见 pushPostCategory / openCategoryPicker）。
      // ⚠️ **两份都要登记**：搜索结果 this.posts 折叠后只剩每个多页作品的第一页，
      //    详情页里给第 2..N 页归类时就得靠这些被折叠的页也在索引里。
      this.rememberPostsForCategory(this.posts);
      if (posts !== this.posts) this.rememberPostsForCategory(posts);
      if (!posts.length) {
        const empty = document.createElement("div");
        empty.className = "adg-empty";
        empty.textContent = "没有可显示的图片";
        this.grid.append(empty);
        return;
      }
      // 布局按「本页实际渲染的卡片」下标对齐（见 applyMasonryLayout 读 this._layoutPosts），
      // 因此这里必须把过滤后真正渲染的 post 记下来，不能直接用 this.posts 下标。
      const rendered = [];
      for (const post of posts) {
        if (this.settings.activeCategory && this.settings.postCategories[this.postKeyOf(post)] !== this.settings.activeCategory) continue;
        const imageUrl = this.postImageUrl(post);
        if (!imageUrl) continue;
        rendered.push(post);
        const card = document.createElement("article");
        card.className = "adg-card";
        // 类别色条：D站 帖子的主类别（artist/copyright/character/general），一眼分得出这页的构图来源
        const categoryClass = dgCardCategoryClass(post);
        if (categoryClass) card.classList.add(categoryClass);
        const postId = String(post.id || "");
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
        // P站 的标签**不是 prompt**（capabilities.prompt=false ⇒ buildPromptForPost 把 tags 短路成 []，
        // 见那里的注释），但 pixiv 标签本身是真标签，浮层拿它做展示 / 翻译 / 点击检索都成立。
        // 所以另开一个**浮层专用**字段，绝不复用 card.dataset.tags —— 后者喂着选中输出
        //（selectionFromCard）与 Prompt 编辑器，填进去等于把日文标签当提示词灌给下游。
        if (postSourceId === "pixiv") {
          // ⚠️ 主文本必须取 `meta.tag_details[].name`（**原文**），不能用 post.tags：
          //    后端把「原文 + 翻译」一起 append 进了 item.tags（见 anima_gallery_pixiv.illust_to_item），
          //    拿它当浮层主文本会让每个标签重复出现两遍（翻译那份已由小字承担，见 pixivTagTranslations）。
          const details = Array.isArray(post?.meta?.tag_details) ? post.meta.tag_details : [];
          const names = [...new Set(details.map((entry) => String(entry?.name || "").trim()).filter(Boolean))];
          const hoverTags = names.length
            ? names
            : (Array.isArray(post?.tags) ? post.tags : String(post?.tag_string || "").split(" "));
          card.dataset.hoverTags = JSON.stringify(hoverTags.map((tag) => String(tag || "").trim()).filter(Boolean));
        }
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
        // ⚠️ 只有**元数据缺宽高**时才需要 onload 兜底重排：布局只按 post 元数据算盒高
        //    （cardAspect 读的是 image_width/height，不是图片的渲染尺寸），元数据齐全时
        //    上面已预设 width/height/aspectRatio，盒子尺寸在摆放时就已定死，图片解码**不会**
        //    改变布局（applyMasonryLayout 末尾有同一条结论）。原先无条件重排 ⇒ 一页最多 48 张图
        //    陆续到达 = 最多 48 次全量重排（每次 querySelectorAll + getComputedStyle + 逐卡写
        //    5 处 style）；rAF 只合并同一帧内的多次调用，而图片是陆续到达的，合并不掉。
        if (!(imageWidth > 0 && imageHeight > 0)) {
          preview.onload = () => this.scheduleMasonryLayout();
        }
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
        // D站 差分（父子级）作品：parent_id / has_active_children 是 D站 posts.json 自带字段，
        // 点「差分」把搜索词换成 parent:<根帖id>，一次拿到「父帖 + 全部直接子帖」。
        // 张数接口不回（post.children 是空串），所以按钮不带数量，只给关系本身。
        if (!isGallerySource) {
          const diffRootId = this.diffRootId(post);
          if (diffRootId) {
            addAction("差分", `查看该作品的差分组：搜索 parent:${diffRootId}（父帖与全部子帖）`, () => this.openDiffGroup(post));
          }
        }
        // P站 多页作品：卡片只代表第一页，点「全部页」展开全作品（等价点进 Pixiv 的 /artworks/<id>）。
        // 页数来自适配器写进 meta 的 page_count（见 anima_gallery_pixiv.illust_to_items）。
        // 已经在作品详情里时不再给这个按钮 —— 那只会重新打开同一个作品，属于"点了没反应"的控件。
        const pageCount = Number(post?.meta?.page_count) || 0;
        if (pageCount > 1 && !this.pixivDetail) {
          addAction("全部页", `查看该作品全部 ${pageCount} 页（相当于 P站 作品详情页）`, () => this.openPixivPages(post));
        }
        // P站 卡片：把该作品匹配到 D站 帖子（命中后用它更全的 Danbooru 标签作为 Prompt）。
        // 成功后按钮变灰 + 绿字「已匹配」—— 既是状态显示，也避免用户误触重复发起请求。
        if (postSourceId === "pixiv") {
          const matchedPost = this.pixivMatchOf(post);
          const matchButton = addAction(
            matchedPost ? "已匹配" : "匹配D站",
            matchedPost
              ? `已匹配到 D站 #${matchedPost.post_id}（本页 · ${matchedPost.tag_count} 个标签）：输出使用该帖的 Danbooru 标签`
              : "在 Danbooru 按 pixiv 作品 id 反查同款作品；命中后用它更全的规范标签作为 Prompt",
            () => this.matchPixivPost(post, matchButton),
          );
          if (matchedPost) {
            matchButton.disabled = true;
            matchButton.classList.add("is-matched");
          }
        }
        // capabilities.prompt=false 的图源（P站）没有提示词可看/可入库 → 不收这两个按钮，
        // 否则点下去只会得到空内容（项目 UI 规范：不要留点了没反应的控件）。
        const promptActionsApplicable = postCaps.prompt || !isGallerySource;
        const promptAction = addAction("Prompt", "查看、编辑和复制 Prompt", () => this.openPromptEditor(card, post));
        // tooltip 压到一行：原 30+ 字挂在 9px 的小按钮上，既读不完也把按钮撑得难看；
        // 具体两项操作在弹窗里自解释（那里有 intro 与折叠区）。文案锚点「入库」二字不动。
        const libraryAction = addAction("入库", "入库 / 归类这张图", () => this.saveToPromptLibrary(post, { includeLocalCategory: true }));
        if (!promptActionsApplicable) {
          promptAction.hidden = true;
          libraryAction.hidden = true;
        }
        // 「下载原图」对 P站 是主用途（下载后喂 WD14 反推）→ 走 full_url（original 优先，见 downloadPost）
        addAction("下载", "下载原图（原图优先 full_url）", () => this.downloadPost(post));
        // ★ 卡片上的「分类」按钮（用户 2026-09-20 要求"真正的在对应图片有按钮进行分类"）。
        //   原先归类入口藏在「入库」弹窗里（要先点入库 → 再勾"写入本地分类" → 再选分类），
        //   而且该按钮在 prompt=false 的图源（P站）会被隐藏 ⇒ P站 根本没法归类。
        //   分类是**本地**属性，与图源有没有 prompt 无关，所以这个按钮永远显示。
        addAction("分类", "把这张图归入本地分类（跨画廊节点共享）", () => this.openCategoryPicker([this.postKeyOf(post)]));
        // ★ 收藏按钮已于 2026-09-21 移除：它只有装饰作用（描边变黄），没有任何读取入口
        //   （无"只看收藏"筛选、无排序、入库时的 isFavorite 是硬编码常量），且与上面的
        //   「分类」功能重合。用户裁决：去除。
        // 分类徽章：已归类的卡片左上角显示分类名
        const catId = this.settings.postCategories[this.postKeyOf(post)];
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
        // 差分角标：对应 D站 网页给缩略图描的绿框 / 橙框（绿=有子级、橙=有父级）。
        // 左上角已被本地分类徽章占用，故走右上角；常驻可见，用来在瀑布流里一眼认出差分组。
        if (!isGallerySource) {
          const parentPostId = Number(post.parent_id);
          const marks = [];
          // ⚠️ 文案说的是「这张图**是**什么」，不是「这张图**有**什么」：
          //    D站 的 has_active_children 表示"它是父帖（有子级差分）"，parent_id 表示"它是某帖的子帖"。
          //    早先写成「有子级 / 有父级」两个单字，用户实测一眼读成"这张是子帖 / 这张是父帖"，
          //    于是一个「1 父 + 3 子」的差分组看着整个反掉（2026-09-21 真机实报）。
          const hasChildren = post.has_active_children === true || post.has_active_children === "t";
          if (hasChildren) {
            marks.push(["adg-diff-has-children", "父帖", "差分组父帖：存在子级差分作品（对应 D站 网页的绿框）"]);
          }
          if (Number.isFinite(parentPostId) && parentPostId > 0) {
            marks.push(["adg-diff-has-parent", "子帖", `差分组子帖：父帖 #${parentPostId}（对应 D站 网页的橙框）`]);
          }
          if (marks.length) {
            const badge = document.createElement("span");
            badge.className = "adg-diff-marks";
            badge.title = `${marks.map(([, , hint]) => hint).join("；")}——点卡片「差分」看整组`;
            for (const [className, text] of marks) {
              const dot = document.createElement("span");
              dot.className = className;
              dot.textContent = text;
              badge.append(dot);
            }
            card.append(badge);
          }
        }
        // P站 多页标识：等价 Pixiv 网页缩略图右上角的多页角标。
        // 搜索结果里写总页数（「12页」）；已进作品详情则写进度（「3/12」）—— 那正是 Pixiv 详情页的读法。
        if (pageCount > 1) {
          const pageNo = Number(post?.meta?.page) || 0;
          const badge = document.createElement("span");
          badge.className = "adg-pages-badge";
          badge.textContent = this.pixivDetail ? `${pageNo + 1}/${pageCount}` : `${pageCount}页`;
          badge.title = this.pixivDetail
            ? `P站 多页作品：第 ${pageNo + 1} 页 / 共 ${pageCount} 页`
            : `P站 多页作品：共 ${pageCount} 页（当前显示第 1 页，点卡片「全部页」展开）`;
          card.append(badge);
        }
        card.append(selectButton, actions);
        card.addEventListener("mouseenter", (event) => {
          this.cancelHidePromptTooltip();
          // 浮层已经是这张卡的（鼠标从浮层移回来）→ 只取消隐藏、**不要重建**：
          // 重建会让占位文案闪一下、锚点被重置导致位置跳，反复进出时就是肉眼可见的闪烁。
          if (this.tooltip && this.tooltipCard === card) return;
          // 悬停 PROMPT_TOOLTIP_SHOW_DELAY 才弹（不是一进入就弹）：快速划过一串卡片不该弹一堆浮层
          this.tooltipHoverPoint = { clientX: event.clientX, clientY: event.clientY };
          this.scheduleShowPromptTooltip(card);
        });
        // ⚠️ mousemove **只记录光标停留点，绝不移动浮层**：浮层跟随光标时，2.19 新加的
        //    「点标签即搜索」永远点不到（光标一动浮层就跟着挪）。定位只在浮层创建时做一次，
        //    之后锚点冻结 —— 内容异步加载完再定位也只是用同一个锚点（见 positionTooltip）。
        card.addEventListener("mousemove", (event) => {
          this.tooltipHoverPoint = { clientX: event.clientX, clientY: event.clientY };
          // 浮层若被 renderPosts 收掉（补图 / 筛选 / 分类都会重建卡片）而光标仍停在**同一张卡**上，
          // mouseenter 不会再触发 ⇒ 这里补排一次显示；否则要"移出再移入"才会重新弹（审查指出的 N1）。
          if (!this.tooltip && !this.tooltipShowTimer) this.scheduleShowPromptTooltip(card);
        });
        card.addEventListener("mouseleave", () => {
          // 还没弹出来就离开了 → 取消这次悬停，别让浮层在光标走了之后才蹦出来
          this.cancelShowPromptTooltip();
          // D站 的浮层可交互（鼠标能移进去），必须**延迟**隐藏：鼠标从卡片移到浮层上要穿过
          // 卡片外的一瞬，而浮层是 body 子元素、卡片收不到它的事件，只能靠这条延迟窗口把两者
          // 接起来（浮层的 mouseenter 会取消它）。
          // ⚠️ 其它图源（C站）保持**即时**隐藏 —— 它们与 D站 共用同一个浮层函数，但浮层没有
          //    .is-danbooru（仍是 pointer-events: none），鼠标本来就进不去，延迟只会让它白挂。
          if (this.isPromptTooltipInteractiveCard(card)) this.scheduleHidePromptTooltip();
          else this.hidePromptTooltip();
        });
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
      // P站 作品详情：这不是"搜索结果的一页"，页码/游标条没有意义（该作品的全部页已一次铺满）。
      // 借用分类浏览那枚 chip 的样式，只换文案。
      if (this.pixivDetail) {
        const badge = document.createElement("span");
        badge.className = "adg-cat-mode-badge";
        badge.textContent = `P站 作品 #${this.pixivDetail.illustId} · 全部 ${this.pixivDetail.pages.length} 页`;
        badge.title = "正在看单个作品的全部页；点搜索框旁的「← 返回」回到搜索结果";
        this.pagination.append(badge);
        return;
      }
      // C站「无限加载」池：分页基于**池内已过滤内容**，与上游 cursor 无关。
      // 浏览态翻页优先切池、不够才补一页；搜索态看到底时给「加载更多」（补一个设置档位再筛）。
      if (this.poolMode() && this.sourcePool) {
        const size = this.poolPageSize();
        const filtered = this.poolFilteredCount();
        const pages = Math.max(1, Math.ceil(filtered / size));
        const index = Math.min(this.poolPageIndex || 0, pages - 1);
        const previous = document.createElement("button");
        previous.type = "button";
        previous.className = "adg-cursor-step";
        previous.textContent = "‹ 上一批";
        previous.disabled = index <= 0;
        previous.title = previous.disabled ? "已经是第一批" : "回到池里的上一批（不重新请求）";
        previous.onclick = () => { void this.stepPoolPage(-1); };
        const label = document.createElement("span");
        label.className = "adg-cursor-batch";
        label.textContent = `第 ${index + 1}/${pages} 批 · 本批 ${this.posts.length} 张 · 已加载 ${this.sourcePool.posts.length} 条`
          + (this.sourcePool.exhausted ? " · 上游已到底" : "");
        label.title = "「已加载」= 后台池里累积的条数；搜索与翻页都在这个池里进行";
        const next = document.createElement("button");
        next.type = "button";
        next.className = "adg-cursor-step";
        next.textContent = "下一批 ›";
        next.disabled = index >= pages - 1 && this.sourcePool.exhausted;
        next.title = next.disabled ? "没有更多了" : "优先切池里已加载的内容，不够时自动补";
        next.onclick = () => { void this.stepPoolPage(1); };
        this.pagination.append(previous, label, next);
        // 搜索态：已经把池内符合条件的内容看到底了，但上游还有 → 给一个明确的「加载更多」
        const searching = String(this.gallerySourceQuery() || "").trim().length > 0;
        if (searching && index >= pages - 1 && !this.sourcePool.exhausted && this.sourcePool.cursor) {
          const more = document.createElement("button");
          more.type = "button";
          // ⚠️ 必须带 adg-cursor-step：`.adg-pagination button` 是固定 24px 宽，
          //    不带这个类的中文按钮会被压成竖排（一个字一行，白占三行高度）
          more.className = "adg-cursor-step";
          more.textContent = "加载更多";
          more.title = `再往后加载 ${this.settings.civitaiPool.target} 条，然后在本池内重新筛选`;
          more.onclick = async () => {
            more.disabled = true;
            const ok = await this.growPool({ target: this.settings.civitaiPool.target });
            if (ok) {
              this.applyPoolView();
              this.setStatus(this.poolStatusText());
            } else {
              more.disabled = false;
            }
          };
          this.pagination.append(more);
        }
        // 显式「重建池」：池模式下的强制刷新。改关键词**不会**重建池（那是本地筛，省请求的地方），
        // 所以想重新从上游取一遍就得有这个入口（排序/NSFW/时间/作者变化时会自动重建，无需点它）。
        const rebuild = document.createElement("button");
        rebuild.type = "button";
        // 同上：中文按钮必须带 adg-cursor-step，否则被 24px 固定宽压成竖排文字
        rebuild.className = "adg-cursor-step";
        rebuild.textContent = "重建池";
        rebuild.title = `丢掉当前已加载的 ${this.sourcePool.posts.length} 条，按档位 ${this.settings.civitaiPool.target} 条重新从上游拉取`;
        rebuild.onclick = () => {
          rebuild.disabled = true;
          void this.rebuildPool();
        };
        this.pagination.append(rebuild);
        return;
      }
      // 分页形态**按 capabilities.page_numbers 分支**（不再按源名硬编码）：
      //   · 声明了页码能力（D站 / P站，见 GALLERY_SOURCE_FALLBACK）→ 页码按钮 + 跳页框 + ‹ ›；
      //   · 没声明或声明 false（C站，以及任何后端回包里没有这个键的源）→ 游标分页。
      // 为什么"没声明能力的源进不到页码分支"：sourceCapabilities() 是「缺字段一律 false」语义
      // （`caps.page_numbers === true`），而 pageMode() 只读这个布尔 —— 只有**显式声明 true**
      // 的源才能拿到页码 UI；D站 不在 /anima/gallery/sources 回包里，靠兜底表声明 true。
      if (!this.pageMode()) {
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
        // 进度三件套：批次 / 本批张数 / 累计已浏览张数；没有 next_cursor = 已到底（用户不用猜还有没有）
        label.textContent = `第 ${batch} 批 · 本批 ${this.posts.length} 张 · 已浏览 ${this.galleryBrowsedCount()} 张`
          + (this.nextCursor ? "" : " · 已到底");
        label.title = "游标分页：只能顺序前进，没有跳页；点右侧批次块可直接回退到看过的批次";
        const next = document.createElement("button");
        next.type = "button";
        next.className = "adg-cursor-step";
        next.textContent = "下一批 ›";
        next.disabled = !this.nextCursor;
        next.title = this.nextCursor ? "按后端返回的 next_cursor 取下一批" : "没有更多了";
        next.onclick = () => { void this.stepGalleryCursor(1); };
        this.pagination.append(previous, label, next);
        // ── 批次 chip：一键回退到任意看过的批次 ──
        // cursor 栈里每批的 cursor 都还在，回退 = 截断栈 + **重查一次**（不是重放压栈，
        // 后者回退 8 批要打 8 次接口）。只渲染最近 GALLERY_CURSOR_CHIP_MAX 批，更早的折叠成「…」，
        // 免得翻几十批后分页条变成一堵按钮墙。
        const chipStart = Math.max(0, batch - GALLERY_CURSOR_CHIP_MAX);
        if (chipStart > 0) {
          const more = document.createElement("span");
          more.className = "adg-cursor-more";
          more.textContent = "…";
          more.title = `更早的 ${chipStart} 批已折叠，可用「‹ 上一批」逐批回退`;
          this.pagination.append(more);
        }
        for (let i = chipStart; i < batch; i++) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "adg-cursor-chip";
          chip.textContent = `第${i + 1}批`;
          chip.classList.toggle("active", i === batch - 1);
          chip.disabled = i === batch - 1;
          chip.title = i === batch - 1
            ? "当前批次"
            : `回到第 ${i + 1} 批（用栈里已有的 cursor 重查一次，不重放中间的批次）`;
          chip.onclick = () => { void this.jumpGalleryBatch(i); };
          this.pagination.append(chip);
        }
        return;
      }
      for (const page of this.pageWindow()) {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = String(page); button.classList.toggle("active", page === this.page);
        button.onclick = () => { this.page = page; this.search(); };
        this.pagination.append(button);
      }
      const input = document.createElement("input");
      input.type = "number"; input.min = "1"; input.value = String(this.page);
      input.title = this.isDanbooruSource() ? "输入页码跳转" : `输入页码跳转（该源每页固定 ${GALLERY_PAGE_SIZE} 张）`;
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
      // 文案收敛（2026-09-21）：原首句 40 字，把"怎么操作"写成了正文，而下面那两个
      // checkbox 与折叠区本身已自解释。压到一行，信息量不减。
      intro.textContent = includeLocalCategory
        ? "两项操作可任选其一，也可同时执行。"
        : "选择 Prompt 库分类与要写入的 D 站标签类别；不改动全局 Prompt 设置。";
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
        const localCategoryId = String(this.settings.postCategories[this.postKeyOf(post)] || "");
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

        // ── 旧路径折叠（2026-09-21）──
        // 「本地分类 / 新建分类 / 标签快捷新建」这一整套，卡片上已经有独立入口
        // （renderPosts 里的「分类」按钮；下面 4231-4235 那处注释也写明归类入口已从弹窗搬出）。
        // 留在弹窗里 = 同一件事两个入口，还把弹窗撑到 26 个控件、一屏看不完。
        // 默认折叠，需要时展开；功能一个不删（用户 2026-09-21 裁决：折叠而非删除）。
        const legacyGroup = document.createElement("details");
        legacyGroup.className = "adg-save-legacy-group";
        const legacySummary = document.createElement("summary");
        legacySummary.textContent = "本地分类 / 快捷新建（也可用卡片上的「分类」按钮）";
        legacyGroup.append(legacySummary);

        const localTitle = document.createElement("div");
        localTitle.className = "adg-prompt-settings-title";
        // 「勾选…后生效」这个条件说明交给上面那个 checkbox 自己表达（它就在同一屏内），
        // 标题里不再嵌套另一个控件的文案。
        localTitle.textContent = "本地分类";
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
          // ★ 新建分类必须由**后端**发 id。本地造的 `c_${Date.now()}` 后端不认：归类会被拒
          //   （"目标分类不存在"），或写进去一个后端不认识的 id、下次加载被洗掉
          //   —— 用户表现为"刚建的分类一会儿就没了"。
          this.ensureCategoryByName(name).then((category) => {
            if (!category) return;
            renderLocalCategoryOptions();
            localCategorySelect.value = category.id;
          });
          assignLocalCategoryInput.checked = true;
          localCategoryNameInput.value = "";
        };
        localNewRow.append(localCategoryNameInput, localNewButton);
        legacyGroup.append(localTitle, localCategorySelect, localNewRow);
        // 保留原“分类”按钮的快捷能力：点当前图片标签即可新建并选中本地分类。
        const tagChoices = this.postTags(post).slice(0, 10);
        if (tagChoices.length) {
          const tagTitle = document.createElement("div");
          tagTitle.className = "adg-prompt-settings-tip";
          tagTitle.textContent = "快速新建：";
          const tagWrap = document.createElement("div");
          tagWrap.className = "adg-category-tags";
          for (const tag of tagChoices) {
            const tagButton = document.createElement("button");
            tagButton.type = "button";
            tagButton.className = "adg-category-tag";
            tagButton.textContent = tag.replace(/_/g, " ");
            tagButton.onclick = () => {
              const name = tag.replace(/_/g, " ");
              this.ensureCategoryByName(name).then((category) => {
                if (!category) return;
                renderLocalCategoryOptions();
                localCategorySelect.value = category.id;
              });
              assignLocalCategoryInput.checked = true;
            };
            tagWrap.append(tagButton);
          }
          legacyGroup.append(tagTitle, tagWrap);
        }
        content.append(legacyGroup);
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

      // ── 就地错误反馈（2026-09-21）──
      // 此前校验失败只调 setStatus()，而状态栏在**节点内部**，被 z-index:100000 的弹窗遮罩
      // 完全盖住 ⇒ 用户看到的现象是「点『应用』毫无反应」。这里在弹窗内补一条 role="alert"，
      // 与 setStatus 并存（后者仍供关闭弹窗后回看，语义不变）。
      const errorBox = document.createElement("div");
      errorBox.className = "adg-dialog-error";
      errorBox.setAttribute("role", "alert");
      errorBox.hidden = true;
      const showError = (message) => {
        errorBox.textContent = message;
        errorBox.hidden = false;
        try { errorBox.scrollIntoView({ block: "nearest" }); } catch {}
      };
      content.append(errorBox);

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
              showError("至少勾选一项：存入 Prompt 库 / 写入本地分类");
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
              showError("至少保留一个 Prompt 类别");
              return false;
            }
            const excludePattern = excludeInput.value.trim();
            if (excludePattern) {
              try { new RegExp(excludePattern, "i"); } catch (error) {
                this.setStatus(`排除正则无效：${error.message || error}`, "error");
                showError(`排除正则无效：${error.message || error}`);
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
              showError("排除规则过滤后没有可保存的 Prompt（检查上面的排除正则）");
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
        // 走后端（跨节点共享）：pushPostCategory 先落库、成功后才改内存；失败会如实提示
        await this.pushPostCategory(post, saveOptions.localCategoryId || "");
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

    /**
     * 该卡片的悬停浮层是否可交互 = 可移入 + 标签可点。**D站 与 P站** 都算（P站 为 2026-09-21 新增）。
     * 判据取自**卡片自己的** dataset.source（D站 为空串、C站 "civitai"、P站 "pixiv"），
     * 而不是 this.settings.source —— 卡片自带来源，切源时 switchGallerySource 会 renderPosts
     * 重建全部卡片，行为因此天然跟随，不需要额外的清理代码（也别把这个判据缓存进实例字段）。
     * · D站 / P站：主文本都是**真标签**，点一下就能直接拿去检索；
     * · C站 不可交互：它的「标签」是别人写好的整段提示词拆出来的自然语言分句，
     *   且上游 /api/v1/images 忽略关键词参数 —— 点了搜不出东西，保持 pointer-events: none。
     * ⚠️ 返回 true 会让浮层带上 `.is-danbooru` 类（CSS 里那句 `pointer-events: auto` 的开关）；
     *    类名是历史遗留（原本只有 D站），语义其实就是「可交互浮层」。
     */
    isPromptTooltipInteractiveCard(card) {
      const source = String(card?.dataset?.source || "");
      return !source || source === "pixiv";
    }

    /**
     * P站 标签 → pixiv 官方翻译（`meta.tag_details[].translated_name`，见 anima_gallery_pixiv）。
     * 该字段的语言由后端 Accept-Language 决定，出厂即「中文优先、其次英文」
     *（`PIXIV_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7"`），
     * 所以这里拿到的正是用户要的那一份翻译，不必再去抓 pixiv 网页的 Crowdin 数据。
     * 与原文相同的条目直接丢掉：pixiv 没给这条翻译时，别显示一条重复的小字。
     * 其余图源没有这个字段 → 返回空表，浮层小字退回本地词典那条老路。
     */
    pixivTagTranslations(card) {
      let meta = {};
      try { meta = JSON.parse(card.dataset.galleryMeta || "{}"); } catch { return {}; }
      const details = Array.isArray(meta.tag_details) ? meta.tag_details : [];
      const map = {};
      for (const entry of details) {
        const name = String(entry?.name || "").trim();
        const translated = String(entry?.translated_name || "").trim();
        if (name && translated && translated !== name) map[name] = translated;
      }
      return map;
    }

    async showPromptTooltip(card, event) {
      let tags = [];
      // 标签源：P站 走 hoverTags —— 它的 dataset.tags 恒为空（P站 标签不是 prompt，
      // buildPromptForPost 会把 tags 短路掉，见 renderPosts 里写 hoverTags 的注释）；
      // 其余图源没有 hoverTags，行为与改动前完全一致。
      try { tags = JSON.parse(card.dataset.hoverTags || card.dataset.tags || "[]"); } catch { tags = []; }
      // 无标签的卡片（D站 偶有、C站 未给提示词时）：先收掉可能还挂着的旧浮层再退出。
      // 否则「移出卡片 A（已排 280ms 隐藏）→ 移进无标签卡 B」会取消隐藏定时器并把 A 的浮层
      // 留在屏幕上（还跟着光标跑、吃点击）。
      if (!tags.length) { this.hidePromptTooltip(); return; }
      // 这个浮层是否可交互（D站 / P站 = 可移入 + 标签可点）。只算一次，下面各分支复用。
      const interactive = this.isPromptTooltipInteractiveCard(card);
      // P站 的官方标签翻译；其余图源恒为空表（浮层小字退回本地词典那条老路）
      const tagTranslations = this.pixivTagTranslations(card);
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
      // 只有 D站 的浮层可交互（CSS: .adg-prompt-tooltip.is-danbooru { pointer-events: auto }）。
      // D站 与 C站 共用同一个浮层元素，C站 没有这个类 ⇒ 保持 pointer-events: none、不吃点击。
      if (interactive) tooltip.classList.add("is-danbooru");
      tooltip.textContent = "正在加载双语 Prompt…";
      document.body.append(tooltip);
      this.tooltip = tooltip;
      this.tooltipCard = card;   // 供 mouseenter 判断「浮层已经是这张卡的」，避免来回移动时重建闪烁
      if (interactive) {
        // 鼠标移进浮层 → 取消卡片 mouseleave 排下的延迟隐藏，这样才能停留、滚动、点标签。
        tooltip.addEventListener("mouseenter", () => this.cancelHidePromptTooltip());
        tooltip.addEventListener("mouseleave", () => this.scheduleHidePromptTooltip());
        // 标签点击走**容器级委托**：浮层内容会被 replaceChildren 整体重建，逐个标签绑会丢。
        tooltip.addEventListener("click", (clickEvent) => this.handlePromptTooltipClick(clickEvent));
      }
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
          // 小字翻译：先本地中文词典（D站 词表命中的那些），再退到 pixiv 官方翻译
          //（translated_name，出厂已按「中文优先、其次英文」取过，见 pixivTagTranslations）。
          // 两者都没有就不显示小字 —— 与 pixiv 网页版「没翻译就不附小字」的行为一致。
          const translated = String(this.translationCache.get(tag) || tagTranslations[tag] || "").trim();
          line.append(english);
          if (translated && translated !== tag) {
            line.append(Object.assign(document.createElement("small"), { textContent: translated }));
          }
          if (interactive) {
            // ⚠️ 显示文本上面已被空格化，检索必须用**下划线原文**，所以把原文写进 dataset，
            //    点击时读它；绝不从 textContent 反推（Danbooru 检索用的就是标签原文）。
            line.dataset.tag = tag;
            line.classList.add("is-searchable");
            line.title = `点击搜索「${tag.replace(/_/g, " ")}」`;
          }
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
      // P站 已匹配 D站：顶部提示（b）+ 横线分割后并列 Danbooru 标签（c）。
      // 卡片 id 可能是 `<illust_id>_p<页>`，按 `_p` 截断回作品 id 再查匹配表。
      const cardPostId = String(card?.dataset?.postId || "");
      const cardIllustId = cardPostId.split("_p")[0];
      const cardEntry = cardIllustId ? this.pixivMatches.get(cardIllustId) : null;
      // 浮层也必须**按页**取：作品详情里每张卡是不同页，取错页就会显示别的页的标签
      const cardPage = Number((cardPostId.match(/_p(\d+)$/) || [])[1] || 0);
      const matched = cardEntry
        ? ((cardEntry.pages && cardEntry.pages[String(cardPage)]) || cardEntry.root || (cardEntry.post_id ? cardEntry : null))
        : null;
      if (matched && this.tooltip === tooltip) {
        const danbooruTags = PROMPT_CATEGORY_ORDER
          .flatMap((category) => String(matched[`tag_string_${category}`] || "").split(" "))
          .filter(Boolean);
        // 顺带把 D站 标签的中文也取来（本地词典，几乎瞬时）——这样下半区也带翻译小字
        await this.ensureTagTranslations(danbooruTags);
        if (this.tooltip !== tooltip) return;
        const note = document.createElement("div");
        note.className = "adg-prompt-tooltip-note";
        note.textContent = `已匹配 D站 #${matched.post_id}（${matched.tag_count} 个标签）：`
          + "分隔线以下是该帖的 Danbooru 规范标签，也正是实际输出的 Prompt（上半区仍是 pixiv 自己的标签）。";
        tooltip.prepend(note);
        // 横线分割：直接复用 .adg-prompt-tooltip-extra 的 border-top，不新增样式
        const danbooru = document.createElement("section");
        danbooru.className = "adg-prompt-tooltip-extra";
        const heading = document.createElement("div");
        heading.className = "adg-prompt-tooltip-category";
        heading.textContent = `D站 #${matched.post_id} 的标签（${matched.tag_count} 个）`;
        danbooru.append(heading);
        for (const category of PROMPT_CATEGORY_ORDER) {
          const values = String(matched[`tag_string_${category}`] || "").split(" ").filter(Boolean);
          if (!values.length) continue;
          const section = document.createElement("section");
          section.className = "adg-prompt-tooltip-section";
          const categoryLabel = document.createElement("div");
          categoryLabel.className = "adg-prompt-tooltip-category";
          categoryLabel.textContent = PROMPT_CATEGORY_LABELS[category] || category;
          section.append(categoryLabel, ...values.map((tag) => {
            const line = document.createElement("div");
            line.className = "adg-prompt-tooltip-line";
            const name = document.createElement("span");
            name.textContent = tag.replace(/_/g, " ");
            line.append(name);
            const zh = String(this.translationCache.get(tag) || "").trim();
            if (zh && zh !== tag) {
              line.append(Object.assign(document.createElement("small"), { textContent: zh }));
            }
            // 刻意**不加** .is-searchable：这些是 Danbooru 标签，点了拿去搜 pixiv 语义不对
            return line;
          }));
          danbooru.append(section);
        }
        tooltip.append(danbooru);
        this.positionTooltip(); // 内容又长了，同一个锚点再算一次
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
          ? "P站标签是 pixiv 自己的词表（与 Danbooru 不通用，不进 Prompt 输出）；小字为 pixiv 官方翻译，点标签可直接搜索"
          : "C站无标签体系，这里显示的是原作者写的提示词与采样参数";
        extras.push(note);
      }
      if (!extras.length) return null;
      const wrap = document.createElement("div");
      wrap.className = "adg-prompt-tooltip-extra";
      wrap.append(...extras);
      return wrap;
    }

    /**
     * 按锚点定位浮层。`event` 可以是真实事件，也可以是 `{ clientX, clientY }` 点对象
     * （见 scheduleShowPromptTooltip 传进来的光标停留点）。
     * ⚠️ **不要传 `{ x, y }`**：这里认的是 `clientX/clientY`；字段名不对就判定不出坐标、
     *    一个 left/top 都不会设 —— 没有定位的 `position: fixed` 会渲染在静态位置，
     *    浮层整个掉到屏幕左上角（2026-09-21 踩过这个坑）。
     */
    positionTooltip(event) {
      if (!this.tooltip) return;
      // 记住锚点：内容异步加载完（"正在加载双语 Prompt…" → 真面板）尺寸会变，
      // 那时必须用**同一个锚点**重新定位，否则会以小尺寸算出的位置承载大尺寸内容，
      // 直接盖住画廊并溢出视口。锚点只在这里被写入，且只在浮层创建时由外部传点进来 ——
      // 「浮层不再跟随光标」正是靠这一点实现的。
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

    /**
     * 延迟显示：光标在卡片上停够 PROMPT_TOOLTIP_SHOW_DELAY 才弹浮层。
     * 锚点取「光标停留点」（mousemove 只记录、不移动浮层），弹出后就冻在那里 ——
     * 于是光标得以腾出来移进浮层点标签，这正是 2.19 想给却给不了的能力。
     */
    scheduleShowPromptTooltip(card) {
      this.cancelShowPromptTooltip();
      this.tooltipShowTimer = setTimeout(() => {
        this.tooltipShowTimer = null;
        void this.showPromptTooltip(card, this.tooltipHoverPoint || this.cardCenterPoint(card));
      }, PROMPT_TOOLTIP_SHOW_DELAY);
    }

    cancelShowPromptTooltip() {
      if (!this.tooltipShowTimer) return;
      clearTimeout(this.tooltipShowTimer);
      this.tooltipShowTimer = null;
    }

    /** 没有光标坐标时的兜底锚点（例如卡片被键盘聚焦）：弹在卡片中心 */
    cardCenterPoint(card) {
      const rect = card?.getBoundingClientRect?.();
      if (!rect) return null;
      return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    }

    hidePromptTooltip() {
      this.cancelShowPromptTooltip();
      this.cancelHidePromptTooltip();
      this.tooltip?.remove();
      this.tooltip = null;
      this.tooltipCard = null;
    }

    /** 延迟隐藏（只被 D站 的可交互浮层路径调用）：给鼠标留出从卡片移到浮层上的时间窗口 */
    scheduleHidePromptTooltip() {
      this.cancelHidePromptTooltip();
      this.tooltipHideTimer = setTimeout(() => {
        this.tooltipHideTimer = null;
        this.hidePromptTooltip();
      }, PROMPT_TOOLTIP_HIDE_DELAY);
    }

    cancelHidePromptTooltip() {
      if (!this.tooltipHideTimer) return;
      clearTimeout(this.tooltipHideTimer);
      this.tooltipHideTimer = null;
    }

    /**
     * 浮层里的标签被点击 → 直接用该标签重新搜索。
     * 只对**可交互浮层**成立（D站 / P站，见 isPromptTooltipInteractiveCard）：两边的标签都是真标签，
     * 点了能直接拿去检索（D站 走 /anima/danbooru/posts，P站 走 /anima/gallery/pixiv/search）。
     * C站 的「标签」是自然语言分句且上游忽略关键词 → 浮层不可交互，走不到这里。
     */
    handlePromptTooltipClick(event) {
      const line = event.target?.closest?.(".adg-prompt-tooltip-line.is-searchable");
      if (!line || !this.tooltip?.contains(line)) {
        // 点在浮层空白处 = 一个明确的「收起」手势（否则浮层只能等鼠标移开 280ms 才消失）。
        if (this.tooltip?.contains(event.target)) this.hidePromptTooltip();
        return;
      }
      const rawTag = String(line.dataset.tag || "").trim();
      if (!rawTag) return;
      // 必须拦住这次事件：节点侧另有一层「把点击补发给同坐标下宿主按钮」的恢复逻辑
      // （见 pointer 恢复处理），不拦会让一次点击同时触发卡片上的按钮。
      event.preventDefault();
      event.stopPropagation();
      this.hidePromptTooltip();  // 搜索会整体重渲染，浮层留着只会指向旧卡片
      // 填搜索框 / 记历史 / 收起浮层 / 滚回顶部 / 发起搜索 —— 全走用户搜索的统一收口
      this.submitSearch(rawTag);
    }

    async downloadPost(post) {
      const sourceId = this.postSourceId(post);
      const isGallerySource = sourceId !== DANBOORU_SOURCE_ID;
      // P站 的用途是「下载原图 → WD14 反推」（PLAN §5.7），所以画廊源一律原图优先：
      // full_url 就是契约里的 original（各源适配器保证 original 优先、退回 large）。
      // ⚠️ 2026-09-18 修（用户反馈「画廊的下载固定长边为 850，要能下原图」）：
      // D站 的 `large_file_url` 是 **sample 档 —— 最长边恒为 850**，`file_url` 才是原图。
      // 此前 D站 分支把 `large_file_url` 排在 `file_url` **前面**，所以下载到的永远是 850 的 sample。
      // 现在两层保险：
      //   ① 原图字段优先（file_url）；
      //   ② 若 file_url 缺失，把 sample 直链**改写成 original 直链** ——
      //      实测（真机 D站 API）：同一张图只差两处，`/sample/` → `/original/`、
      //      文件名去掉 `sample-` 前缀，例如
      //        .../sample/18/02/sample-1802cdbb….jpg → .../original/18/02/1802cdbb….jpg
      //      （原图 3135×4000，sample 只有 850 长边）。
      const danbooruOriginal = (url) => {
        const s = String(url || "");
        if (!s || !/\/sample\//i.test(s)) return "";
        return s.replace(/\/sample\//i, "/original/").replace(/\/(sample-)/i, "/");
      };
      const imageUrl = isGallerySource
        ? (post.full_url || post.large_file_url || post.file_url || post.preview_url || post.preview_file_url)
        : (post.file_url || danbooruOriginal(post.large_file_url) || post.full_url
           || danbooruOriginal(post.sample_url) || post.large_file_url || post.preview_file_url);
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
        // 扩展名从**实际取到的 URL** 推断：D站 sample 常被转成 jpg，而原图可能是 png/webp，
        // 直接用 post.file_ext 会把 png 存成 .jpg（下载链路改成原图后必须跟着改）。
        const extFromUrl = (u) => (String(u).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i) || [])[1] || "";
        link.download = `${prefix}_${post.id || "image"}.${extFromUrl(imageUrl) || post.file_ext || "jpg"}`;
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

      const assign = async (catId, catName) => {
        // 落库优先（跨节点共享）：ids 里是纯 id 或 postKey 都能处理
        let ok = ids.length;
        if (ids.length) ok = await this.pushPostCategory(ids, catId || "");
        this.renderPosts();
        this.filterControls?.refresh();
        this.removeDialog();
        // ⚠️ 失败时**不能**再报"已归类"：pushPostCategory 已经在状态栏写了具体错误，
        //    这里覆盖成成功文案会让用户以为归好了，实际库里没有（本轮的静默失败就是这么藏的）。
        if (ids.length && ok < ids.length) {
          this.setStatus(`归类未完成：${ids.length - ok}/${ids.length} 张没写进分类库（见上一条错误）`, "error");
          return;
        }
        this.setStatus(ids.length ? `已归类 ${ids.length} 张 → ${catName}` : `已创建分类：${catName}`, "success");
      };

      if (ids.length) {
        // 当前归类状态（单张时显示）
        const currentCatId = ids.length === 1 ? this.settings.postCategories[this.normaliseCategoryKey(ids[0])] || "" : "";

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
            remove.onclick = async (event) => {
              event.stopPropagation();
              // ★ 删除必须走**后端**（唯一真源）：后端会把该分类下的条目移回「未分类」；
              //   只改前端内存的话，下次加载时这个分类会"复活"（别的节点/工作流仍指向它）。
              try {
                await this._categoryRequest("/anima/gallery/categories", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "delete", id: cat.id, source: this.settings.source }),
                });
              } catch (error) {
                this.setStatus(`删除分类失败：${error?.message || error}`, "error");
                return;
              }
              if (this.settings.activeCategory === cat.id) this.settings.activeCategory = "";
              await this.loadCategoryLibrary();      // 以后端为准重建内存缓存
              this.saveSettings();
              this.filterControls?.refresh();
              renderExisting();
              this.setStatus(`已删除分类：${cat.name}（其中的图片已变回未分类）`);
            };
            ops.append(remove);
            row.append(pick, ops);
            existingWrap.append(row);
          }
        };
        renderExisting();
        content.append(existingWrap);

        // 从标签一键建分类（单张时取该图标签；点标签 = 建分类并归类，零打字）
        // ⚠️ ids 里是 **postKey**（`<source>:<id>`），早先这里拿 `String(p.id) === ids[0]` 比，
        //    永远匹配不上 ⇒ 标签 chips 从来不显示。按 postKey 比，并兼容旧调用点传的纯 id。
        const firstKey = ids.length === 1 ? ids[0] : "";
        const firstPost = firstKey
          ? (this.posts.find((p) => this.postKeyOf(p) === firstKey)
            || this.posts.find((p) => String(p.id) === firstKey)
            || this._postKeyIndex?.get(firstKey)
            || null)
          : null;
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
                this.ensureCategoryByName(displayName).then((cat) => {
                  if (cat) assign(cat.id, displayName);
                });
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
        this.ensureCategoryByName(name).then((cat) => {
          if (cat) assign(cat.id, name);
        });
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
      // 中文备注：**可留空**（留空 = 自动翻译）；填了就以手填为准，且不会被自动翻译覆盖。
      const noteInput = document.createElement("input");
      noteInput.className = "adg-preset-note-input";
      noteInput.placeholder = "中文备注（留空 = 自动翻译）";
      noteInput.setAttribute("aria-label", "预设中文备注（可留空）");
      saveButton.onclick = async () => {
        const name = nameInput.value.trim();
        if (!name) {
          nameInput.focus();
          this.setStatus("请输入预设名称", "error");
          return;
        }
        // ⚠️ 搜索词必须**以搜索框里的实时输入为准**（2026-09-17 修）：
        // 此前是 `this.queryWidget?.value || this.settings.lastQuery` —— `lastQuery` 只在**点搜索时**
        // 才更新（见 search() 里的赋值），于是「改了词但没点搜索就保存」会保存成**上一次搜索的词**，
        // 备注也随之翻成上一个词的翻译（用户实测：「保存前的第一个之后，其他几个词会跟随第一个的翻译；
        // 保存前先搜索一次就正确」）。现在按 输入框 → 序列化值 → lastQuery 依次取值，绝不用"上次搜索"顶替当前输入。
        const query = String(
          this.queryInput?.value ?? this.queryWidget?.value ?? this.settings.lastQuery ?? ""
        ).trim();
        const manualNote = noteInput.value.trim().slice(0, 240);
        const oldText = saveButton.textContent;
        saveButton.disabled = true;
        saveButton.textContent = manualNote ? "保存中…" : "生成中文备注…";
        try {
          const preset = {
            name,
            query,
            note: manualNote || await this.buildPresetNote(query),
            noteManual: !!manualNote,
            rating: [...this.settings.rating],
            filters: { ...this.settings.filters },
          };
          const existing = this.settings.presets.findIndex((item) => item.name === name);
          if (existing >= 0) this.settings.presets[existing] = preset;
          else this.settings.presets.push(preset);
          this.saveSettings();
          this.renderPresetOptions();
          nameInput.value = "";
          noteInput.value = "";
          renderRows();
          // 提示里带上实际保存的搜索词：改词没点搜索时，用户能立刻看出存进去的是哪一条
          this.setStatus(`${existing >= 0 ? "已更新" : "已保存"}搜索预设：${name}${query ? ` · ${query}` : ""}`, "success");
        } catch (error) {
          this.setStatus(`保存搜索预设失败：${error?.message || "未知错误"}`, "error");
        } finally {
          saveButton.disabled = false;
          saveButton.textContent = oldText;
        }
      };
      nameInput.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); saveButton.click(); } };
      noteInput.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); saveButton.click(); } };
      saveRow.append(nameInput, saveButton);
      const noteRow = document.createElement("div");
      noteRow.className = "adg-preset-note-row";
      noteRow.append(noteInput);
      content.append(saveRow, noteRow);

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
          if (preset.noteManual) pick.dataset.manual = "1";
          pick.append(name, meta);
          pick.onclick = () => {
            this.setQuery(preset.query);
            this.settings.rating = normalizeRatings(preset.rating);
            this.settings.filters = normalizeFilters(preset.filters);
            this.saveSettings();
            this.filterControls.refresh();
            // 预设是「查询 + 筛选」的复合动作：筛选上面已经设好，查询本身走用户搜索的统一收口（含记历史）
            this.submitSearch(preset.query);
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
          // 自定义中文备注：行内编辑。手填（含"清空"）后不再被自动翻译覆盖。
          const noteBtn = document.createElement("button");
          noteBtn.type = "button";
          noteBtn.className = "adg-preset-note-edit";
          noteBtn.textContent = preset.noteManual ? "改备注" : "备注";
          noteBtn.title = preset.noteManual
            ? "编辑自定义中文备注（清空 = 保持为空，不再自动翻译）"
            : "自定义中文备注（填过之后就不再自动翻译）";
          noteBtn.setAttribute("aria-label", `${noteBtn.textContent}：${preset.name}`);
          noteBtn.onclick = (event) => {
            event.stopPropagation();
            const input = document.createElement("input");
            input.className = "adg-preset-note-input-inline";
            input.value = preset.note || "";
            input.placeholder = "中文备注（留空 = 不再自动翻译）";
            input.setAttribute("aria-label", `编辑预设备注：${preset.name}`);
            // 备注框显示在 pick 按钮内部：必须挡掉冒泡，否则点输入框会顺手"应用预设"
            input.onpointerdown = (e) => e.stopPropagation();
            input.onclick = (e) => e.stopPropagation();
            meta.replaceWith(input);
            input.focus();
            input.select();
            let settled = false;
            const commit = (save) => {
              if (settled) return;
              settled = true;
              if (save) {
                const value = input.value.trim().slice(0, 240);
                preset.note = value;
                // 填过（哪怕是清空）就算"手动备注"：留空表示故意不要备注，不该被自动翻译补回来
                preset.noteManual = true;
                this.saveSettings();
                this.renderPresetOptions();
                this.setStatus(value ? `已保存备注：${value}` : `已设为无备注（不再自动翻译）：${preset.name}`);
              }
              renderRows();
            };
            input.onkeydown = (e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(true); }
              else if (e.key === "Escape") { e.preventDefault(); commit(false); }
            };
            input.onblur = () => commit(true);
          };
          ops.append(noteBtn, remove);
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

    openDialog({ title, content, onApply, onCancel, showApply = true, applyLabel = "应用" }) {
      this.removeDialog();
      const overlay = document.createElement("div");
      overlay.id = this.dialogId;
      overlay.className = "adg-dialog-overlay";
      const dialog = document.createElement("section");
      dialog.className = "adg-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const heading = document.createElement("h3");
      // 无障碍：模态必须能被读出标题。此前只有 role/aria-modal，屏幕阅读器只会念「对话框」。
      heading.id = `${this.dialogId}-title`;
      dialog.setAttribute("aria-labelledby", heading.id);
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
        // ⚠️ 默认值必须**保持「应用」**：tests/verify_tk_prompt_output.py 断言设置弹窗的
        //    footerButtons === ["取消","应用"]。要按场景改文案的调用方传 applyLabel 即可，
        //    绝不能改默认值（改了会挂测试，且会让所有复用它的弹窗一起变）。
        apply.textContent = applyLabel;
        apply.onclick = () => {
          if (onApply?.() === false) return;
          this.removeDialog();
        };
        actions.append(apply);
      }
      dialog.append(heading, content, actions);
      overlay.append(dialog);
      overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
      // ── 键盘可达性（2026-09-21）：模态对话框三件套 ──
      // 此前**完全没有** keydown 处理：习惯性按 Esc 关不掉，Tab 会一路跑到背后的画布上。
      // 监听挂在 overlay 上而不是 document：overlay 是 position:fixed inset:0 的全屏层，
      // 移除它时监听随之消失，不需要额外的解绑与泄漏防护。
      const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
      const focusables = () => [...dialog.querySelectorAll(FOCUSABLE)]
        .filter((el) => !el.disabled && el.getClientRects().length > 0);
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (event.key !== "Tab") return;
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        // 焦点还没进来（刚打开就按 Tab）或已跑到弹窗外 ⇒ 拉回弹窗内
        if (!dialog.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      document.body.append(overlay);
      // 初始焦点：优先落到第一个真正的输入控件，没有才退到首个可聚焦元素。
      // 用 rAF 排到下一帧（与文件里既有的补焦点写法一致），并复查仍在文档里。
      requestAnimationFrame(() => {
        if (!overlay.isConnected) return;
        const preferred = dialog.querySelector("input:not([type='hidden']), select, textarea")
          || focusables()[0];
        try { preferred?.focus?.({ preventScroll: true }); } catch {}
      });
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
      pageLabel.textContent = "每页图片数（至少）";
      const select = document.createElement("select");
      // 0 = 自适应：按节点尺寸算出「刚好填满一屏」的张数（列数 × 可视行数），
      // 节点越宽越高，自动显示越多，不再固定 24/48 让大节点半屏空白。
      select.add(new Option("自适应（按节点大小）", "0", false, !this.settings.limit));
      // 固定档位语义 = **至少 N 张**：一屏放不下更多时仍会自动补（见 autoFillIfUnderfilled），
      // 所以文案必须写明，否则用户会以为"设了 12 就永远只有 12 张"。
      [12, 24, 48].forEach((limit) => {
        const option = new Option(String(limit), String(limit), false, limit === this.settings.limit);
        // 页码模式的源（P站）上游固定每页 GALLERY_PAGE_SIZE 条 → 48 档根本拿不到，
        // 禁用 + 写明原因，而不是留一个选了也不生效的假选项。
        if (limit > GALLERY_PAGE_SIZE && this.pageMode()) {
          option.disabled = true;
          option.textContent = `${limit}（该源每页固定 ${GALLERY_PAGE_SIZE}，不可用）`;
        }
        select.append(option);
      });
      select.title = this.pageMode()
        ? `自适应 = 按节点宽高算出刚好填满的张数；固定档位 = 至少 N 张（不足一屏会自动补满）。`
          + `当前图源用页码分页、上游每页固定 ${GALLERY_PAGE_SIZE} 张，所以 ${GALLERY_PAGE_SIZE} 以上的档位不可用。`
        : "自适应 = 按节点宽高算出刚好填满的图片数量；固定档位 = 至少 N 张（不足一屏会自动补满，"
          + "实际张数可能多于所选值）；拖动节点改变大小后会自动重算";
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
      const thumbLabel = document.createElement("label");
      thumbLabel.className = "adg-field";
      thumbLabel.textContent = "缩略图大小";
      const thumbSelect = document.createElement("select");
      for (const tier of DG_THUMB_TIERS) {
        thumbSelect.add(new Option(
          `${tier.label}（${tier.width}px${tier.width === DG_MIN_PT ? " · 默认" : ""}）`,
          String(tier.width),
          false,
          tier.width === this.thumbTargetPt(),
        ));
      }
      thumbSelect.title = "缩略图目标列宽：档位越大、列数越少、单图越大（图片仍是零裁切 contain）。"
        + `实际卡宽会≥档位、且不超过 ${DG_MAX_PT}px（列数有下限保护，窄节点不会被撑出巨图）。`
        + "只影响网格排版，不改变节点尺寸。默认「小 116px」= 旧行为。";
      thumbLabel.append(thumbSelect);
      viewGrid.append(pageLabel, heightLabel, thumbLabel);
      viewSection.append(viewTitle, viewGrid);
      content.append(viewSection);

      // ── C站 无限加载（仅 C站 生效；关闭时该图源行为与改动前逐字节相同）──
      const poolSection = document.createElement("section");
      poolSection.className = "adg-settings-section adg-civitai-pool";
      const poolTitle = document.createElement("div");
      poolTitle.className = "adg-settings-title";
      poolTitle.textContent = "C站 无限加载";
      // 开关与功能名同行（.adg-settings-switch），不单开一行 —— 否则两个开关叠起来很占纵向空间
      const poolEnableLabel = document.createElement("label");
      const poolEnable = document.createElement("input");
      poolEnable.type = "checkbox";
      poolEnable.checked = this.settings.civitaiPool.enabled;
      poolEnableLabel.append(poolEnable, document.createTextNode("开启"));
      const poolHead = document.createElement("div");
      poolHead.className = "adg-settings-switch";
      poolHead.append(poolTitle, poolEnableLabel);
      const poolTargetLabel = document.createElement("label");
      poolTargetLabel.className = "adg-settings-switch";
      poolTargetLabel.textContent = "后台加载档位";
      const poolTargetSelect = document.createElement("select");
      for (const option of CIVITAI_POOL_TARGET_OPTIONS) {
        poolTargetSelect.add(new Option(
          `${option} 条（${option / 200} 次请求）`, String(option), false, option === this.settings.civitaiPool.target));
      }
      poolTargetSelect.title = "后台目标加载量。C站 单页最多 200 条，所以每档正好 1~5 次请求（批间隔 1 秒）。";
      poolTargetLabel.append(poolTargetSelect);
      const poolTip = document.createElement("div");
      poolTip.className = "adg-settings-help";
      poolTip.textContent = "C站 上游不支持关键词检索：关键词只在已加载的内容里筛。"
        + "开启后按上方档位在后台预取（每批 200 条、间隔 1 秒），搜索即覆盖已加载的全部内容、改词不再请求；"
        + "翻页优先用池里的内容，不够才补。";
      poolSection.append(poolHead, poolTargetLabel, poolTip);
      content.append(poolSection);

      // ── P站 匹配 D站（用 Danbooru 的规范标签替代 pixiv 标签）──
      const matchSection = document.createElement("section");
      matchSection.className = "adg-settings-section adg-pixiv-match";
      const matchTitle = document.createElement("div");
      matchTitle.className = "adg-settings-title";
      matchTitle.textContent = "P站 匹配 D站";
      // 同上：开关与功能名同行
      const matchAutoLabel = document.createElement("label");
      const matchAuto = document.createElement("input");
      matchAuto.type = "checkbox";
      matchAuto.checked = this.settings.pixivMatch.auto;
      matchAutoLabel.append(matchAuto, document.createTextNode("自动关联"));
      const matchHead = document.createElement("div");
      matchHead.className = "adg-settings-switch";
      matchHead.append(matchTitle, matchAutoLabel);
      const matchTip = document.createElement("div");
      matchTip.className = "adg-settings-help";
      matchTip.textContent = "P站 标签模型不认识，故默认不输出 Prompt。"
        + "Danbooru 收录了大量 P站 作品且帖子自带作品 id：开启后按 id 反查，命中就用该帖更全的 Danbooru 标签当 Prompt。"
        + "代价：每批多 1 次 D站 请求；未收录的仍不输出；反查是作品级的（多页共用一组标签）。"
        + "卡片上也可单张「匹配D站」。";
      matchSection.append(matchHead, matchTip);
      content.append(matchSection);

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
          // C站「无限加载」：开关或档位变了就**丢掉旧池**（旧池是按旧档位/旧上游筛选建的）
          const poolNext = normalizeCivitaiPool({
            enabled: poolEnable.checked,
            target: Number(poolTargetSelect.value),
          });
          if (poolNext.enabled !== this.settings.civitaiPool.enabled
              || poolNext.target !== this.settings.civitaiPool.target) {
            this.sourcePool = null;
          }
          this.settings.civitaiPool = poolNext;
          // P站 匹配 D站：开关变化不需要丢弃已有匹配（匹配是作品级的、与设置无关）
          this.settings.pixivMatch = normalizePixivMatch({ auto: matchAuto.checked });
          // 缩略图档位：setThumbWidth 只改设置 + 丢列步长反推基准，**不碰节点尺寸**；
          // 让新档位生效走的是下面既有的 applyGridHeight() + search(resetPage) 两条原有行为。
          this.setThumbWidth(Number(thumbSelect.value));
          this.saveSettings();
          this.applyGridHeight();
          this.search({ resetPage: true });
        },
      });
    }

    build() {
      // 重入守卫：重复 build 会**双绑** 5 个 window/document 级监听（见 dispose 的移除清单），
      // 而 dispose 只摘一次 ⇒ 监听泄漏，且此后每次松手/滚动都要多跑一遍别人的处理器。
      // 当前唯一调用点已被 `_animaDanbooruGallery` 标志挡着，现存代码不会触发；这里是第二道，
      // 防的是将来新增调用点。dispose 后也一并挡住（那时 disposed=true，DOM 已拆）。
      if (this.root || this.disposed) return;
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
          this.submitSearch(queryInput.value);
        }
      };
      // 差分组浏览的「← 返回」：与搜索框同排，只有进入差分组后才占位（见 syncReturnButton）。
      // 和搜索框一样必须 stopPropagation，否则点击会被 ComfyUI 捕获阶段抢给节点容器。
      const diffReturn = document.createElement("button");
      diffReturn.type = "button";
      diffReturn.className = "adg-diff-return";
      diffReturn.hidden = true;
      diffReturn.onpointerdown = (event) => event.stopPropagation();
      diffReturn.onmousedown = (event) => event.stopPropagation();
      diffReturn.onclick = (event) => { event.stopPropagation(); this.goBack(); };
      queryRow.append(queryInput, diffReturn);
      this.queryInput = queryInput;
      this.diffReturnBtn = diffReturn;
      this.queryRow = queryRow;
      this.syncReturnButton();
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
      addAction("搜索", "按上方标签搜索", () => this.submitSearch(this.queryInput?.value ?? this.queryWidget?.value ?? ""), mainGroup).className = "adg-primary-action";
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
        // 分类的重命名 / 删除走后端（唯一真源）——只改前端内存的话，下次加载会"复活"
        onRenameCategory: (category, nextName) => this.renameCategoryRemote(category, nextName),
        onDeleteCategory: (category) => this.deleteCategoryRemote(category),
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
        // 同预设管理器：筛选已经设好，查询走统一收口（含记历史）
        this.submitSearch(p.query);
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
      // ★ 联想浮层**必须单例**：它挂在 document.body 上（fixed 定位），而构建面板会被
      //   多次调用（节点重绘 / 面板重建）。旧代码每次都 append 一个新 div，而销毁只在
      //   teardown 里做 —— 于是 body 下会堆着若干"上一代"浮层：`this.suggestions` 只指
      //   最新的那个，hideSuggestions() **关不到旧的**，屏幕上就永久漂着一条关不掉的联想条
      //   （用户 2026-09-20 实报"无论如何都去不掉"+ 截图）。创建前先把残留清干净。
      document.querySelectorAll("body > .adg-suggestions").forEach((el) => el.remove());
      const suggestions = document.createElement('div'); suggestions.className = 'adg-suggestions'; suggestions.style.display = 'none'; this.suggestions = suggestions;
      document.body.append(suggestions);
      window.addEventListener("resize", this.positionSuggestionsHandler);
      document.addEventListener("scroll", this.positionSuggestionsHandler, true);
      // ★ 画布平移/缩放**既不发 window resize 也不发 document scroll**，所以浮层会僵在
      //   旧坐标上（用户实报"一直漂浮在屏幕上"，实测漂到节点下方约 250px）。
      //   画布一被操作就收起浮层 —— 此刻用户注意力在画布，联想本来也不该继续占屏。
      this.canvasDismissHandler = (event) => {
        if (!(event.target instanceof HTMLCanvasElement)) return;
        this.hideSuggestions();
      };
      window.addEventListener("pointerdown", this.canvasDismissHandler, true);
      window.addEventListener("wheel", this.canvasDismissHandler, { capture: true, passive: true });
      root.append(queryRow, toolbar, paginationRow, info, status, galleryBatchPanel, grid);
      this.root = root;
      this.status = status;
      this.grid = grid;
      this.setupImageLoading();
      // ⚠️ 这里**不再** applyGridHeight()。build() 跑在 onNodeCreated 里，此刻
      //    installDOMWidgetSizeSync 还没执行（在本函数更下方才装），domSizeSync 仍是 null
      //    ⇒ setGridHeight() 只能走 fallback 直接 node.setSize(...)，**宽度和高度一起改**
      //    （窄节点会被 Math.max(360, w) 撑到 360 宽），而且绕开了 setBounds 的区间钉死
      //    与 setContentHeight 的 clamp —— 用户实报的「新建节点后尺寸自己变了」就是这条。
      //    正确的初始化在下方：lockedHeight 直接取「节点当前高度」，即工作流保存的/默认的尺寸。
      //    这里只把 settings.gridHeight 同步成节点真实高度（只记录，不改尺寸）。
      this.syncGridHeightFromNode();
      // 分类库（唯一真源在后端，跨节点共享）：抓工作流里的旧数据 → 拉后端 → 迁移。
      // 异步执行、不阻塞首屏；失败也只是"分类暂时用工作流缓存"。
      this.initCategoryLibrary();
      // Chrome 下新 ComfyUI 节点激活层可能先命中 node-body，导致 DOM
      // 控件“看得见但鼠标点不到”。只从同一节点的命中栈中恢复控件点击，
      // 不穿透到被其他节点遮住的画廊，避免误触别的节点。
      const recoverPointer = (event) => {
        if (!this.root?.isConnected) return;
        // ⚡ 把「事件目标的节点归属」判据提到 hit-test **之前** —— 判据一字未改，只是提前。
        //    target 不属于任何节点时（点画布空白、拖画布框选、点 ComfyUI 自己的工具栏/菜单，
        //    这些才是绝大多数 mouseup）下面无论如何都会在同一个判据处 return，
        //    但那时 `elementsFromPoint`（hit-test + 强制布局刷新）与两轮 `closest`
        //    （命中栈常有 10~40 个元素）已经白跑完了 —— 而这笔开销每次松手都要付。
        //    closest 是纯树遍历、**不读布局**，所以这次预筛本身几乎免费。
        const earlyTargetNode = (event.target instanceof Element
          ? event.target.closest?.("[data-node-id]")?.dataset.nodeId
          : undefined) ?? null;
        if (!earlyTargetNode) return;
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
        //    （上面的 earlyTargetNode 预筛已经保证它非空，这里直接复用同一个值。）
        const targetNode = earlyTargetNode;
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
      if (this.canvasDismissHandler) {
        window.removeEventListener("pointerdown", this.canvasDismissHandler, true);
        window.removeEventListener("wheel", this.canvasDismissHandler, true);
        this.canvasDismissHandler = null;
      }
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
              // ⚠️⚠️ 这里必须记「内容区高度」，**不是** grid.clientHeight。
              //     两者的语义与数值都不同：settings.gridHeight 是 setContentHeight() 的入参
              //     （= node.size[1] - chrome），而 .adg-grid 只是 root 的最后一个子元素 ——
              //     它上面还有 queryrow / toolbar / 分页 / info / 状态栏，实测占掉约 190px。
              //     真机实测（2026-09-21，节点 2000×720）：
              //       node.size[1] = 720 → 内容区可用 625（720-95），而 grid.clientHeight = 434。
              //     原实现写的是后者 ⇒ settings.gridHeight 被记成 434，于是下一次
              //     applyGridHeight()（设置面板「应用」）按 434 调 setContentHeight ⇒
              //     node.size[1] = 434 + 95 = 529，**比用户设定的 720 矮 191px**。
              //     这正是「被动改变节点尺寸」中最隐蔽的一条：它不在拖动时发作，而在用户
              //     下一次动设置面板时发作，看起来就像"节点自己变矮了"。
              //     getContentHeight() = clamp(size[1] - chrome, min, max)，而此刻区间正是
              //     setBounds(nowHeight, nowHeight) 刚钉的 [size[1]-95, size[1]-95] ⇒ 自洽。
              const height = Math.round(Number(uiRef.domSizeSync?.getContentHeight?.()) || 0);
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
