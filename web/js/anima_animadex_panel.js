// AnimaDex 角色浮窗（2026-09-26）
//
// 定位（YG 明确要求）：**浮窗**，不是图源 —— 用来给提示词/搜索加角色基础词，方便换人物。
// 因此它不注册进画廊图源下拉，只从 /anima/animadex/* 取素材。
//
// 数据：本地打底（随包的 anima_animadex.json.gz，36,488 角色，100% 带 trigger 与预览图）
//       + 后台刷新（打开浮窗时静默触发一次 /anima/animadex/refresh，失败不影响本地）。
//
// 低占位高能效（项目追求）：入口只占工具条 1 个按钮宽；浮窗内信息密度优先 ——
//   缩略图网格 + 一行搜索 + 三个 tab + 两个开关，没有多余留白。
//
// 收藏 / 最近（2026-09-26）：顶部「全部 / 收藏 / 最近」三 tab，卡片右上角星标收藏；
//   两者都只持久化 **slug 数组** 到 localStorage —— 后端零改动，详情按 slug 回查 /anima/animadex/search。
//
// ⚠️ 本文件由浏览器直接加载，**禁止任何 TypeScript 类型注解**（node --check 会骗你通过）。
//
// 多语言（2026-09-27）：浮窗内所有**用户可见文案**都走 `anima_animadex_i18n.js` 的 t()，
// 本文件里不再出现裸中文字面量（注释除外）。语言由右上角「中 / EN」按钮切换，
// 切换后 applyLocale() 就地换文案（不重建 DOM，保住输入内容与滚动位置），选择记在 localStorage。
// 新增文案时：先在 i18n 模块的 zh/en 两张表里各加一条，再来这里 t("key")。

import { t, setLocale, getLocale, onLocaleChange, LOCALES } from "./anima_animadex_i18n.js";

/** 转义：所有插值都经它，绝不拼裸 HTML（与 widget 的 esc() 同一套纪律）。 */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/** 作品名归一化键：与后端 `anima_animadex.normalize_key` 对齐（NFKC + 小写 + 只留字母数字）。
 *  意义：/facets 给的是「该作品首个出现的原始写法」，而角色行的 series 可能是别的写法
 *  （大小写/标点差异）；两侧都过这个键，才不会「下拉里选中了却筛不出角色」。 */
function seriesKey(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 收藏 / 最近使用的持久化 key（只存 slug 数组）。 */
const FAVORITES_KEY = "anima_animadex_favorites_v1";
const RECENT_KEY = "anima_animadex_recent_v1";
const RECENT_LIMIT = 20;

/** 作品候选的 DOM 行数上限（含首行「全部作品」）。
 *  意义：**过滤范围与渲染上限解耦** —— 输入过滤覆盖全部 seriesOptions（当前 3,702 项），
 *  但浮窗里最多只挂 SERIES_RENDER_LIMIT 个候选行，几千个节点不会拖慢浮窗。 */
const SERIES_RENDER_LIMIT = 200;

/** 「全部」tab 的单页条数（浮窗**没有翻页 UI**，page 恒为 1 ⇒ 这一页就是全部）。 */
const PAGE_LIMIT = 36;

/** 选中作品时的取回条数（冷审查缺陷 10 修复）。
 *  背景：后端 `search()` 只做**子串**召回（series 命中 rank=3），等值过滤由前端 `filterBySeries` 做，
 *  而 36 条候选池过滤后常常只剩几条甚至 0 条 —— 用户会误判「这个作品没角色」。
 *  这里一次取够候选池，再本地等值过滤后渲染。
 *  ⚠️ **120 是后端硬上限**：`anima_animadex.py` 的 `search()` 里 `limit = max(1, min(120, int(limit)))`，
 *  传更大只会被静默截断（别写 200 —— 那会变成「以为 200 实际 120」的静默偏差）。 */
const SERIES_FETCH_LIMIT = 120;

/** 网格列数：与 CSS `.adg-animadex-grid { grid-template-columns: repeat(4, …) }` 严格对齐。
 *  ←→ 步长 1、↑↓ 步长 GRID_COLS；改 CSS 列数时这里必须同步，否则上下键会错行。 */
const GRID_COLS = 4;

/** tab 顺序：Ctrl+1/2/3 的落点，buildTabs 也用它 —— 一处定义，两处不漂移。 */
const TAB_IDS = ["all", "favorites", "recent"];

/** tab → 文案 key：标签文字只在 syncTabs 里写（语言切换后靠它整批刷新，不留旧语言的标签）。 */
const TAB_LABEL_KEYS = { all: "tab_all", favorites: "tab_favorites", recent: "tab_recent" };

export class AnimaDexPanel {
  /**
   * @param {object} options
   * @param {(text: string) => void} options.onInsert 用户点「用这个角色」时的回调（由画廊决定写到哪）
   */
  constructor({ onInsert } = {}) {
    this.onInsert = onInsert || (() => {});
    this.overlay = null;
    this.grid = null;
    this.statusEl = null;
    this.queryInput = null;
    this.results = [];
    // slug → 角色行：收藏/最近 tab 优先复用缓存，缺失的才按 slug 回查后端
    this.rowCache = new Map();
    this.tab = "all";            // all | favorites | recent
    this.tabButtons = null;
    this.hydrateRequestId = 0;
    this.favorites = this.loadSlugList(FAVORITES_KEY);
    this.recent = this.loadSlugList(RECENT_KEY);
    this.page = 1;
    this.total = 0;              // 后端返回的 total（子串召回全量）—— 仅在**没有**作品筛选时显示
    this.candidateCount = 0;     // 本次实际取回的候选条数：有作品筛选时状态栏用它代替 this.total
    this.query = "";
    this.loading = false;
    this.pendingFetch = false;   // 请求在飞时又来了新查询 → 收尾后补发（见 fetchPage）
    this.requestId = 0;
    this.debounceTimer = null;
    // 双语联想（中英互查）的状态
    this.suggestBox = null;
    this.suggestItems = [];
    this.suggestCursor = -1;
    this.suggestTimer = null;
    this.suggestRequestId = 0;
    this.refreshed = false;
    // 两个开关：YG 要求「人物作品等、服饰配件等可以选择开启或不开启」
    this.includeSeries = true;   // 作品词（如 vocaloid）
    this.includeOutfit = false;  // 服饰配件词（如 detached sleeves）
    // 作品 / 系列筛选（2026-09-27）：选项来自 GET /anima/animadex/facets，**首次打开浮窗拉一次**并缓存
    this.seriesFilter = "";      // "" = 全部作品
    this.seriesOptions = [];     // 后端 facets 缓存（[{name, count}, ...]，已按角色数降序）
    this.facetsLoaded = false;   // 只在首次打开时拉一次；失败会复位以便下次重试
    this.seriesInput = null;     // 可搜索输入（2026-09-27 起替代原生 <select>：3,702 项滚不动）
    this.seriesClearBtn = null;  // 一键清除筛选（仅 seriesFilter 非空时显示）
    this.seriesBox = null;       // 候选浮层（绝对定位挂在 .adg-animadex-series 上）
    this.seriesItems = [];       // 当前候选的**值**列表（首项恒为 "" = 全部作品），供键盘选择
    this.seriesCursor = -1;      // 键盘高亮的候选下标（-1 = 未选）
    // 网格键盘导航（2026-09-27）：高亮下标 + 当前渲染的卡片/角色行
    this.cursorIndex = -1;       // 网格高亮卡片下标（-1 = 无高亮）
    this.cards = [];             // 当前渲染的卡片 DOM，顺序 == renderedRows 顺序（数字键直接索引）
    this.renderedRows = [];      // 当前渲染的角色行（高亮 → 角色行必须**零查表**，避免与 visibleRows 漂移）
    this.seriesTimer = null;
    // 多语言（2026-09-27）：需要「切换语言后改文案」的元素引用（浮窗每次 open 重建 DOM，
    // 所以引用随 open 赋值、随 close 置空；applyLocale 只在浮窗开着时才会用到它们）。
    this.triggerButton = null;   // 工具条入口按钮（浮窗关着时它也在页面上，语言切换要一起改）
    this.titleEl = null;
    this.closeBtn = null;
    this.langBtn = null;
    this.keyHintEl = null;
    this.seriesLabelEl = null;
    this.switchLabelEls = new Map();   // i18n key → 开关文案的 <span>（人物+作品 / 服饰配件）
    // 订阅语言变化：任何地方调 setLocale 都会就地刷新本浮窗文案。
    // 订阅在 destroy 时注销 —— 面板实例通常与 widget 同寿命，但不留悬挂监听。
    this.offLocale = onLocaleChange(() => this.applyLocale());
  }

  /** 入口按钮（工具条上用，1 个按钮宽）。 */
  buildTrigger() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "adg-animadex-trigger";
    button.textContent = t("trigger");
    button.title = t("trigger_title");
    button.onclick = (event) => { event.stopPropagation(); this.open(); };
    this.triggerButton = button;   // 语言切换时 applyLocale 要一起改它的文案
    return button;
  }

  /** 语言切换按钮（浮窗右上角，紧挨关闭按钮）：`中` / `EN` 两态。
   *  显示的是**当前语言**的徽标（不是「点它会切到哪」）—— 用户一眼能看出界面正处于哪种语言。 */
  buildLangButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "adg-animadex-lang";
    button.textContent = t("lang_badge");
    button.title = t("lang_title");
    button.setAttribute("aria-label", t("lang_title"));
    button.onclick = (event) => { event.stopPropagation(); this.toggleLocale(); };
    return button;
  }

  /** 切到 LOCALES 里的下一个语言（当前 zh → en → zh）。走 setLocale → 广播 → applyLocale。 */
  toggleLocale() {
    const list = LOCALES.length ? LOCALES : [getLocale()];
    const index = list.indexOf(getLocale());
    setLocale(list[(index + 1) % list.length]);
  }

  /** 语言切换后**就地**把浮窗内文案全部换掉。
   *  刻意不重建 DOM：重建会丢输入框内容 / 滚动位置 / 键盘高亮，还会让缩略图重新加载。
   *  动态文案（tab 标签、状态栏、空态、星标 title）走各自的渲染函数重新算一遍。 */
  applyLocale() {
    if (this.triggerButton) {
      this.triggerButton.textContent = t("trigger");
      this.triggerButton.title = t("trigger_title");
    }
    if (!this.overlay) return;   // 浮窗没开：只有入口按钮需要改
    if (this.titleEl) this.titleEl.textContent = t("title");
    if (this.queryInput) this.queryInput.placeholder = t("search_placeholder");
    if (this.closeBtn) this.closeBtn.title = t("close_title");
    if (this.langBtn) {
      this.langBtn.textContent = t("lang_badge");
      this.langBtn.title = t("lang_title");
      this.langBtn.setAttribute("aria-label", t("lang_title"));
    }
    for (const [key, el] of this.switchLabelEls) el.textContent = t(key);
    if (this.keyHintEl) {
      this.keyHintEl.textContent = t("key_hint");
      this.keyHintEl.title = t("key_hint");
    }
    if (this.seriesLabelEl) this.seriesLabelEl.textContent = t("series_label");
    if (this.seriesInput) {
      this.seriesInput.setAttribute("aria-label", t("series_aria"));
      this.seriesInput.title = t("series_input_title");
    }
    if (this.seriesClearBtn) this.seriesClearBtn.title = t("series_clear_title");
    this.fillSeriesOptions();   // 作品输入框占位符（全部作品 · 搜索 N 个）跟着语言走
    this.syncTabs();            // tab 标签
    this.render();              // 状态栏 / 空态 / 卡片星标 title 一次刷新
    // 正开着的两个候选浮层也换语言（收起状态的不动，避免无谓重渲染）
    if (this.suggestBox && this.suggestBox.style.display !== "none") this.renderSuggest();
    if (this.seriesBox && this.seriesBox.style.display !== "none") {
      this.renderSeriesCandidates(this.seriesInput?.value || "");
    }
  }

  open() {
    if (this.overlay) { this.queryInput?.focus(); return; }
    const overlay = document.createElement("div");
    overlay.className = "adg-dialog-overlay adg-animadex-overlay";
    overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) this.close(); });
    // 键盘导航的唯一入口（挂在浮窗层，靠冒泡收全局键）。焦点不在浮窗内时收不到 —— 打开即 input.focus()，
    // 之后所有交互都在浮窗内，这个作用域足够且不会污染宿主页面的按键。
    overlay.addEventListener("keydown", (event) => this.onKeydown(event));

    const dialog = document.createElement("div");
    dialog.className = "adg-dialog adg-animadex-dialog";

    // ── 头部：标题 + 搜索 + 关闭 ──
    const head = document.createElement("div");
    head.className = "adg-animadex-head";
    const title = document.createElement("span");
    title.className = "adg-animadex-title";
    title.textContent = t("title");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "adg-animadex-search";
    input.placeholder = t("search_placeholder");
    input.autocomplete = "off";
    input.oninput = () => {
      this.clearGridCursor();   // 输入变了，旧高亮指向的卡片可能已不在结果里 —— 先撤掉再搜
      this.scheduleSearch(input.value);
      this.scheduleSuggest(input.value);
    };
    input.onkeydown = (event) => {
      // ↑↓ 在联想候选里移动、Enter 选中（替换人物的最短路径：敲两个字 → 回车）。
      // 需求 5：**有候选时网格导航绝不抢**；没有候选时不 preventDefault，让 ↑↓ 冒泡下去落进网格。
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!this.suggestOpen()) return;
        event.preventDefault();
        this.moveSuggestCursor(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const picked = this.suggestItems[this.suggestCursor];
        if (picked) { this.useRow(this.suggestRowToCard(picked)); return; }
        // 网格已有高亮（用户按 ↓ 落进网格后再回车）：回车必须用那张卡，而不是把输入重搜一遍
        if (this.cursorIndex >= 0) { this.activateCursor(); return; }
        this.searchNow(input.value);
        return;
      }
      // Esc 一律冒泡给浮窗层 onKeydown：那里按「联想候选 → 作品候选 → 关浮窗」的优先级处理
      if (event.key === "Escape") return;
    };
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "adg-animadex-close";
    closeBtn.textContent = "✕";
    closeBtn.title = t("close_title");
    closeBtn.onclick = () => this.close();

    // 语言切换（右上角，紧挨关闭按钮）：`中` / `EN` 两态，点击切到下一语言
    const langBtn = this.buildLangButton();

    // 联想下拉：绝对定位在搜索框正下方（head 是定位父级）
    const suggestBox = document.createElement("div");
    suggestBox.className = "adg-animadex-suggest";
    suggestBox.style.display = "none";
    head.append(title, input, langBtn, closeBtn, suggestBox);
    this.suggestBox = suggestBox;
    // 元素引用：applyLocale（语言切换时就地换文案）靠它们，不留 querySelector 硬编码
    this.titleEl = title;
    this.closeBtn = closeBtn;
    this.langBtn = langBtn;

    // ── tab 行：全部 / 收藏 / 最近（搜索行正下方；默认「全部」）──
    this.tab = "all";
    const tabs = this.buildTabs();

    // ── 开关行：决定「用这个角色」写入什么；行尾再挂「作品」可搜索输入（筛选与开关同一行，省高度）──
    const switches = document.createElement("div");
    switches.className = "adg-animadex-switches";
    switches.append(
      this.buildSwitch("switch_series", true, (on) => { this.includeSeries = on; }),
      this.buildSwitch("switch_outfit", false, (on) => { this.includeOutfit = on; }),
      this.buildSeriesFilter(),
      this.buildKeyHint(),
    );

    // ── 网格 ──
    const grid = document.createElement("div");
    grid.className = "adg-animadex-grid";

    const status = document.createElement("div");
    status.className = "adg-animadex-status";
    status.textContent = t("status_loading");

    dialog.append(head, tabs, switches, grid, status);
    overlay.append(dialog);
    document.body.append(overlay);

    this.overlay = overlay;
    this.grid = grid;
    this.statusEl = status;
    this.queryInput = input;
    this.page = 1;
    this.refreshLocal();
    input.focus();
    // 本地打底 + 后台刷新：先给本地结果，再静默触发一次刷新（失败也不影响）
    if (!this.refreshed) {
      this.refreshed = true;
      fetch("/anima/animadex/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .catch(() => {});
    }
  }

  /** 键位提示行（浮窗内常驻；与开关同一行，flex-wrap 时自动折行，不额外占高度）。 */
  buildKeyHint() {
    const hint = document.createElement("span");
    hint.className = "adg-animadex-keyhint";
    hint.textContent = t("key_hint");
    hint.title = t("key_hint");
    this.keyHintEl = hint;
    return hint;
  }

  /** 联想下拉是否展开且有候选 —— ↑↓ 归候选还是归网格的唯一判据。 */
  suggestOpen() {
    return !!this.suggestBox && this.suggestBox.style.display !== "none" && this.suggestItems.length > 0;
  }

  /** 浮窗层键盘总入口。优先级（需求 5）：
   *  ① Esc → onEscape（先收候选，无候选才关浮窗）；
   *  ② Ctrl+1/2/3 → 切 tab（输入框内也生效：文本输入本来不吃 Ctrl+数字）；
   *  ③ 输入框内的其余按键 → 直接放行（搜索框的 ↑↓ 归联想，作品框的 ↑↓ 归作品候选，网格不抢）；
   *  ④ 其余 → ↑↓←→ 网格导航 / Home·End / Enter 使用 / 1~9 快选 / f 收藏。 */
  onKeydown(event) {
    if (event.key === "Escape") { this.onEscape(event); return; }
    // 输入框已经消化掉的按键（↑↓ 移候选、Enter 选中）不再二次处理
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey) {
      if (!event.altKey && /^[1-3]$/.test(event.key)) {
        event.preventDefault();
        this.setTab(TAB_IDS[Number(event.key) - 1]);
        return;
      }
      return;   // 其它 Ctrl 组合键（复制/粘贴/全选…）一律不碰
    }
    const target = event.target;
    const inField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    if (inField) return;

    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -GRID_COLS, ArrowDown: GRID_COLS };
    if (step[event.key]) {
      event.preventDefault();
      this.moveGridCursor(step[event.key]);
      return;
    }
    if (event.key === "Home") { event.preventDefault(); this.setGridCursor(0); return; }
    if (event.key === "End") { event.preventDefault(); this.setGridCursor(this.cards.length - 1); return; }
    if (event.key === "Enter") {
      // 焦点在星标上：交给原生 click（= 收藏），别被「用这个角色」顶掉
      if (target && target.closest && target.closest(".adg-animadex-fav")) return;
      if (this.cursorIndex >= 0) { event.preventDefault(); this.activateCursor(); }
      return;
    }
    if (event.key === "f" || event.key === "F") {
      const row = this.cursorRow();
      if (!row) return;
      event.preventDefault();
      this.toggleFavorite(row.slug);
      return;
    }
    // 数字键 1~9 = 直接点第 N 张卡（高亮 + 立即写入，省去鼠标）；超出当前结果数则不动
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index >= this.cards.length) return;
      event.preventDefault();
      this.setGridCursor(index);
      this.activateCursor();
    }
  }

  /** Esc 优先级（需求 5）：先收联想候选 → 再收作品候选 → 都没有才关浮窗。 */
  onEscape(event) {
    if (this.suggestOpen()) {
      event.preventDefault();
      this.hideSuggest();
      return;
    }
    if (this.seriesBox && this.seriesBox.style.display !== "none") {
      event.preventDefault();
      this.hideSeriesBox();
      if (this.seriesInput && this.seriesInput.value !== this.seriesFilter) this.seriesInput.value = this.seriesFilter;
      return;
    }
    event.preventDefault();
    this.close();
  }

  /** 高亮第 index 张卡（越界钳制）；scroll=false 用于「焦点跟着走」时避免抢滚动。 */
  setGridCursor(index, scroll = true) {
    const count = this.cards.length;
    if (!count) { this.cursorIndex = -1; return; }
    const next = Math.max(0, Math.min(count - 1, index));
    this.cursorIndex = next;
    this.cards.forEach((card, i) => card.classList.toggle("is-cursor", i === next));
    if (scroll) this.cards[next]?.scrollIntoView({ block: "nearest" });
  }

  /** 撤掉高亮（重渲染 / 输入变化时调用）。 */
  clearGridCursor() {
    if (this.cursorIndex >= 0) this.cards[this.cursorIndex]?.classList.remove("is-cursor");
    this.cursorIndex = -1;
  }

  /** ↑↓←→ 移动：无高亮时任一方向都落到第一张；越界停在原地（不绕行）——
   *  绕行会让「最后一排不满」时按 → 跳到下一排开头，与直觉相反。 */
  moveGridCursor(delta) {
    if (!this.cards.length) return;
    if (this.cursorIndex < 0) { this.setGridCursor(0); return; }
    const next = this.cursorIndex + delta;
    if (next < 0 || next >= this.cards.length) return;
    this.setGridCursor(next);
  }

  /** 高亮卡片对应的角色行：读渲染时存下的 renderedRows（零查表，不会与 visibleRows 漂移）。 */
  cursorRow() {
    return this.cursorIndex >= 0 ? this.renderedRows[this.cursorIndex] || null : null;
  }

  /** 焦点掉出浮窗时收回搜索框（重渲染后卡片被移除会触发）；焦点仍在浮窗内则一律不动。 */
  restoreFocusIfLost() {
    if (!this.overlay) return;
    const active = document.activeElement;
    if (active && this.overlay.contains(active)) return;
    this.queryInput?.focus();
  }

  /** 对高亮卡片执行 useRow —— Enter / 数字键的落点，与点击卡片**同一条路径**。 */
  activateCursor() {
    const row = this.cursorRow();
    if (row) this.useRow(row);
  }

  /** 单个开关。`key` 是 i18n 文案 key（不是已翻译的文本）—— 语言切换时按 key 重取，
   *  所以文案 span 要存进 switchLabelEls 供 applyLocale 整批刷新。 */
  buildSwitch(key, initial, onChange) {
    const wrap = document.createElement("label");
    wrap.className = "adg-animadex-switch";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = initial;
    box.onchange = () => onChange(box.checked);
    const text = document.createElement("span");
    text.textContent = t(key);
    this.switchLabelEls.set(key, text);
    wrap.append(box, text);
    return wrap;
  }

  /** 「作品」**可搜索输入**（按作品/系列筛选角色）：选项来自 /anima/animadex/facets。
   *  2026-09-27 由原生 <select> 改成输入即过滤 —— facets 返回全量作品（当前 3,702 项），
   *  <select> 里 3,702 个 <option> 找一项得滚很久，体验不可接受。
   *  选型说明：不用 <input list> + <datalist>，因为 datalist 的候选无法控制渲染数量（会把
   *  全量塞进 DOM），过滤行为也不可控；自建输入 + 候选浮层才能做到「过滤全覆盖 / 渲染有上限」。
   *  语义不变：选中候选 → setSeries()（本地过滤 + 「全部」tab 走后端取全量）；清空输入 → 回到「全部作品」。 */
  buildSeriesFilter() {
    const wrap = document.createElement("div");
    wrap.className = "adg-animadex-series";
    const text = document.createElement("span");
    text.className = "adg-animadex-series-label";
    text.textContent = t("series_label");
    this.seriesLabelEl = text;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "adg-animadex-series-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", t("series_aria"));
    input.title = t("series_input_title");
    input.oninput = () => {
      this.renderSeriesCandidates(input.value);
      // 清空输入 = 回到「全部作品」；其余时刻**不改筛选** —— 否则每敲一个字都会触发一次后端请求
      if (!input.value) this.setSeries("");
    };
    input.onfocus = () => this.renderSeriesCandidates(input.value);
    input.onblur = () => {
      this.hideSeriesBox();
      // 没点候选就离开：输入框回填当前筛选值，避免「显示 A、实际筛 B」的状态脱节
      if (input.value !== this.seriesFilter) input.value = this.seriesFilter;
    };
    input.onkeydown = (event) => this.onSeriesKey(event);

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "adg-animadex-series-clear";
    clear.textContent = "✕";
    clear.title = t("series_clear_title");
    clear.onclick = (event) => { event.preventDefault(); this.setSeries(""); input.focus(); };

    const box = document.createElement("div");
    box.className = "adg-animadex-series-box";
    box.setAttribute("role", "listbox");
    box.style.display = "none";

    wrap.append(text, input, clear, box);
    this.seriesInput = input;
    this.seriesClearBtn = clear;
    this.seriesBox = box;
    // 先渲染缓存（重开浮窗时立刻恢复上次选择），再按需拉一次 facets
    this.fillSeriesOptions();
    this.loadSeriesFacets();
    return wrap;
  }

  /** 用缓存的 facets 刷新输入框显示与候选池；未加载完只有「全部作品」，不阻塞其它功能。 */
  fillSeriesOptions() {
    const input = this.seriesInput;
    if (!input) return;
    // 缓存里已没有该作品（后端刷新后消失）→ 回落到「全部作品」，避免显示与筛选状态脱节
    if (this.seriesFilter && !this.seriesOptions.some((item) => String(item?.name || "") === this.seriesFilter)) {
      this.seriesFilter = "";
      this.hideSeriesBox();
    }
    input.placeholder = this.seriesOptions.length
      ? t("series_all_search", { count: this.seriesOptions.length })
      : t("series_all");
    input.value = this.seriesFilter;
    this.syncSeriesClear();
  }

  /** 清除按钮只在有筛选时显形（平时不占视觉重量）。 */
  syncSeriesClear() {
    if (this.seriesClearBtn) this.seriesClearBtn.style.display = this.seriesFilter ? "inline-flex" : "none";
  }

  /** 过滤**全部** seriesOptions（归一化子串匹配，覆盖大小写 / 标点 / 全角差异），**不截断**。 */
  matchSeries(query) {
    const key = seriesKey(query);
    if (!key) return this.seriesOptions;
    return this.seriesOptions.filter((item) => seriesKey(item?.name).includes(key));
  }

  /** 渲染候选：首行恒为「全部作品」，其余取过滤结果的前 SERIES_RENDER_LIMIT-1 项。 */
  renderSeriesCandidates(query) {
    const box = this.seriesBox;
    if (!box) return;
    const total = this.seriesOptions.length;
    const matched = this.matchSeries(query);
    const shown = matched.slice(0, SERIES_RENDER_LIMIT - 1);
    box.replaceChildren();
    this.seriesItems = [];

    // 首行固定「全部作品」：清空筛选的最短路径（输入框清空同样回到这里）
    const allLabel = total ? t("series_all_count", { count: total }) : t("series_all");
    box.append(this.buildSeriesRow(allLabel, "", ""));
    this.seriesItems.push("");
    for (const item of shown) {
      const name = String(item?.name || "");
      box.append(this.buildSeriesRow(name, String(Number(item?.count) || 0), name));
      this.seriesItems.push(name);
    }

    let hint = "";
    if (!total) hint = t("series_loading");
    else if (matched.length > shown.length) hint = t("series_limited", { shown: shown.length, matched: matched.length });
    if (hint) {
      const note = document.createElement("div");
      note.className = "adg-animadex-series-hint";
      note.textContent = hint;
      box.append(note);
    }

    this.seriesCursor = -1;
    box.style.display = "block";
    this.alignSeriesBox();
  }

  /** 候选浮层贴到 dialog 右边缘时改为右对齐展开 —— 浮窗是 overflow:hidden，否则候选会被裁掉一截。 */
  alignSeriesBox() {
    const box = this.seriesBox;
    const wrap = box?.parentElement;
    const dialog = this.overlay?.querySelector(".adg-animadex-dialog");
    if (!box || !wrap || !dialog) return;
    const wrapRect = wrap.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const overflowRight = wrapRect.left + box.offsetWidth > dialogRect.right - 8;
    box.style.left = overflowRight ? "auto" : "0";
    box.style.right = overflowRight ? "0" : "auto";
  }

  /** 单条候选行（button：可聚焦、可点、语义正确）。 */
  buildSeriesRow(label, count, value) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "adg-animadex-series-row";
    row.setAttribute("role", "option");
    row.dataset.value = value;
    const main = document.createElement("span");
    main.className = "adg-animadex-series-row-main";
    main.textContent = label;
    row.append(main);
    if (count) {
      const num = document.createElement("span");
      num.className = "adg-animadex-series-row-count";
      num.textContent = count;
      row.append(num);
    }
    // pointerdown 而非 click：抢在输入框 blur 之前选中，避免候选先被收起、点不中
    row.onpointerdown = (event) => { event.preventDefault(); this.pickSeries(value); };
    return row;
  }

  /** 选中候选：同步输入框显示 → 收起候选 → setSeries（过滤语义与旧的 <select> 完全一致）。 */
  pickSeries(name) {
    const value = String(name || "");
    if (this.seriesInput) this.seriesInput.value = value;
    this.hideSeriesBox();
    this.setSeries(value);
    this.seriesInput?.focus();
  }

  hideSeriesBox() {
    if (this.seriesBox) {
      this.seriesBox.style.display = "none";
      this.seriesBox.replaceChildren();
    }
    this.seriesItems = [];
    this.seriesCursor = -1;
  }

  onSeriesKey(event) {
    const open = !!this.seriesBox && this.seriesBox.style.display !== "none";
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { this.renderSeriesCandidates(this.seriesInput?.value || ""); return; }
      this.moveSeriesCursor(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!open) return;
      let value = this.seriesCursor >= 0 ? this.seriesItems[this.seriesCursor] : null;
      if (value === null) {
        // 没高亮任何行：只有输入正好是某个作品名（归一化后相等）才认，避免把半截输入当筛选条件
        const key = seriesKey(this.seriesInput?.value || "");
        const hit = key ? this.seriesOptions.find((item) => seriesKey(item?.name) === key) : null;
        if (!hit) return;
        value = String(hit.name || "");
      }
      this.pickSeries(value);
      return;
    }
    if (event.key === "Escape") {
      // 与顶部搜索框的 Esc 统一成一条优先级链（见 onEscape）：候选开着只收候选，
      // stopPropagation 挡住浮窗层的「Esc 关浮窗」；没有候选可收就放行给浮窗层（需求 5 的第二段）。
      event.preventDefault();
      if (!open) return;
      event.stopPropagation();
      this.hideSeriesBox();
      if (this.seriesInput && this.seriesInput.value !== this.seriesFilter) this.seriesInput.value = this.seriesFilter;
    }
  }

  moveSeriesCursor(delta) {
    const count = this.seriesItems.length;
    if (!count || !this.seriesBox) return;
    // 光标域 [-1, count-1]（-1 = 未选）映射到 [0, count] 后取模：
    // 必须带上 `cursor + 1` 这一步，否则 -1 起按 ↓ 会被 `% (count+1)` 送回 -1（原联想下拉的公式就缺它）。
    const span = count + 1;
    this.seriesCursor = (((this.seriesCursor + 1 + delta) % span) + span) % span - 1;
    [...this.seriesBox.children].forEach((row, index) => {
      row.classList.toggle("is-active", index === this.seriesCursor);
    });
    this.seriesBox.children[this.seriesCursor]?.scrollIntoView({ block: "nearest" });
  }

  /** 首次打开浮窗拉一次 facets 并缓存（后续重开直接用 this.seriesOptions）。 */
  async loadSeriesFacets() {
    if (this.facetsLoaded) return;
    this.facetsLoaded = true;
    try {
      const response = await fetch("/anima/animadex/facets");
      const data = await response.json();
      const items = Array.isArray(data.series) ? data.series : [];
      this.seriesOptions = items.filter((item) => item && item.name);
      if (!this.seriesInput) return;   // 期间浮窗已关：缓存留着，下次打开直接用
      this.fillSeriesOptions();
    } catch {
      this.facetsLoaded = false;   // 失败复位：下次打开浮窗再试，不把「拉不到」永久记住
    }
  }

  /** 选中作品：先本地过滤即时反馈，再让「全部」tab 按作品名向后端取**候选池**（limit 见 SERIES_FETCH_LIMIT）。 */
  setSeries(name) {
    const next = String(name || "");
    if (this.seriesFilter === next) return;
    this.seriesFilter = next;
    if (this.seriesInput) this.seriesInput.value = next;   // 输入框显示与筛选状态始终一致
    this.syncSeriesClear();
    this.hideSuggest();
    this.render();
    if (this.tab !== "all") return;   // 收藏 / 最近本就是本地集合，过滤在 visibleRows 里完成
    // 60ms 合并连续切换（后端索引是毫秒级）；上一次请求还在飞也不会丢这次 —— fetchPage 的补发兜住最新一次
    if (this.seriesTimer) clearTimeout(this.seriesTimer);
    this.seriesTimer = setTimeout(() => {
      this.seriesTimer = null;
      this.page = 1;
      this.fetchPage();
    }, 60);
  }

  /** 作品过滤（叠加在关键字过滤之后）：只在选中作品时生效。 */
  filterBySeries(rows) {
    if (!this.seriesFilter) return rows;
    const key = seriesKey(this.seriesFilter);
    if (!key) return rows;
    return rows.filter((row) => seriesKey(row?.series) === key);
  }

  /** 三个 tab（全部 / 收藏 / 最近）。 */
  buildTabs() {
    const wrap = document.createElement("div");
    wrap.className = "adg-animadex-tabs";
    wrap.setAttribute("role", "tablist");
    this.tabButtons = new Map();
    // 顺序与 TAB_IDS 一致（Ctrl+1/2/3 的落点按它算，两处共用同一份定义）
    for (const id of TAB_IDS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "adg-animadex-tab";
      button.dataset.tab = id;
      // 标签文字**不在这里写**：统一由 syncTabs 按 TAB_LABEL_KEYS 落，
      // 语言切换时走同一条路径刷新，不会留下旧语言的标签
      button.onclick = (event) => { event.stopPropagation(); this.setTab(id); };
      this.tabButtons.set(id, button);
      wrap.append(button);
    }
    this.syncTabs();
    return wrap;
  }

  syncTabs() {
    if (!this.tabButtons) return;
    for (const [id, button] of this.tabButtons) {
      const active = id === this.tab;
      button.textContent = t(TAB_LABEL_KEYS[id]);
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  setTab(tab) {
    if (this.tab === tab) return;
    this.tab = tab;
    this.syncTabs();
    this.hideSuggest();
    this.render();
    this.hydrateTab();
  }

  /** 收藏 / 最近 tab 要展示的 slug 顺序（新收的 / 刚用的在最前）。 */
  tabSlugs() {
    if (this.tab === "favorites") return this.favorites.slice().reverse();
    if (this.tab === "recent") return this.recent.slice();
    return [];
  }

  /** 缓存缺失的 slug 按后端回查详情（后端不改：复用 /anima/animadex/search 的 q 检索）。 */
  async hydrateTab() {
    const missing = this.tabSlugs().filter((slug) => !this.rowCache.has(slug));
    if (!missing.length) return;
    const requestId = ++this.hydrateRequestId;
    this.setStatus(t("status_hydrating", { count: missing.length }));
    // 4 个一批：后端查的是本地索引（毫秒级），既快又不至于一次打 20 个请求
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(missing.slice(i, i + 4).map((slug) => this.fetchRowBySlug(slug)));
      if (requestId !== this.hydrateRequestId || !this.grid) return;
    }
    this.render();
  }

  async fetchRowBySlug(slug) {
    try {
      const params = new URLSearchParams({ q: slug, page: "1", limit: "5" });
      const response = await fetch(`/anima/animadex/search?${params.toString()}`);
      const data = await response.json();
      const rows = Array.isArray(data.results) ? data.results : [];
      // 只认 slug 精确命中：宁可少一条，也不把别的角色塞进收藏
      const hit = rows.find((row) => String(row.slug || "") === slug);
      if (hit) this.rowCache.set(slug, hit);
    } catch {
      // 单条失败不拖累其余；下次切 tab 会重试
    }
  }

  /** 读本地 slug 数组（坏数据当空，localStorage 抛错也不打断浮窗）。 */
  loadSlugList(key) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
      if (!Array.isArray(parsed)) return [];
      const out = [];
      for (const item of parsed) {
        const slug = String(item || "");
        if (slug && !out.includes(slug)) out.push(slug);
      }
      return out;
    } catch {
      return [];
    }
  }

  saveSlugList(key, slugs) {
    try {
      window.localStorage.setItem(key, JSON.stringify(slugs));
    } catch {
      // 隐私模式 / 配额满：只在本次会话有效，不打断使用
    }
  }

  isFavorite(slug) {
    return this.favorites.includes(String(slug || ""));
  }

  toggleFavorite(slug) {
    const key = String(slug || "");
    if (!key) return;
    const index = this.favorites.indexOf(key);
    if (index >= 0) this.favorites.splice(index, 1);
    else this.favorites.push(key);
    this.saveSlugList(FAVORITES_KEY, this.favorites);
    // 「收藏」tab 里取消要撤卡片；其余 tab 只改星标，避免整格重渲染让缩略图闪动
    if (this.tab === "favorites") this.render();
    else this.syncFavoriteMarks();
  }

  syncFavoriteMarks() {
    if (!this.grid) return;
    for (const card of this.grid.querySelectorAll(".adg-animadex-card")) {
      const star = card.querySelector(".adg-animadex-fav");
      if (!star) continue;
      const on = this.isFavorite(card.dataset.slug || "");
      star.textContent = on ? "★" : "☆";
      star.classList.toggle("is-on", on);
      star.title = on ? t("fav_remove_title") : t("fav_add_title");
      star.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  /** 成功写入 Prompt 时记一条「最近使用」（去重、最新在前、最多 20 条）。 */
  rememberRecent(row) {
    const slug = String(row?.slug || "");
    if (!slug) return;
    const index = this.recent.indexOf(slug);
    if (index >= 0) this.recent.splice(index, 1);
    this.recent.unshift(slug);
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
    this.saveSlugList(RECENT_KEY, this.recent);
  }

  /** 按 slug 顺序取缓存里的角色行（缺失的由 hydrateTab 补齐，不占位空卡）。 */
  rowsForSlugs(slugs) {
    const out = [];
    for (const slug of slugs) {
      const row = this.rowCache.get(slug);
      if (row) out.push(row);
    }
    return out;
  }

  close() {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.suggestTimer) { clearTimeout(this.suggestTimer); this.suggestTimer = null; }
    if (this.seriesTimer) { clearTimeout(this.seriesTimer); this.seriesTimer = null; }
    this.suggestRequestId += 1;
    this.requestId += 1;
    this.pendingFetch = false;   // 浮窗已关：补发无意义（且会让 fetch 白跑一趟）
    this.hydrateRequestId += 1;
    this.overlay?.remove();
    this.overlay = null;
    this.grid = null;
    this.statusEl = null;
    this.queryInput = null;
    this.suggestBox = null;
    this.suggestItems = [];
    this.suggestCursor = -1;
    this.tabButtons = null;
    // seriesInput / seriesClearBtn / seriesBox 随浮窗销毁置空；seriesFilter / seriesOptions **刻意保留**
    // —— 关掉再打开要恢复上次选中的作品，且 facets 不必重拉（缓存的意义所在）。
    this.seriesInput = null;
    this.seriesClearBtn = null;
    this.seriesBox = null;
    this.seriesItems = [];
    this.seriesCursor = -1;
    this.cards = [];
    this.renderedRows = [];
    this.cursorIndex = -1;
    // 语言相关引用随 DOM 一起销毁（switchLabelEls 保持 Map 实例 —— applyLocale 只在开窗时遍历它）
    this.titleEl = null;
    this.closeBtn = null;
    this.langBtn = null;
    this.keyHintEl = null;
    this.seriesLabelEl = null;
    this.switchLabelEls.clear();
  }

  scheduleSearch(value) {
    this.query = String(value || "");
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    // 收藏 / 最近：结果集小，只在本地过滤，不打后端（后端检索是分页语义，会覆盖 tab 内容）
    if (this.tab !== "all") { this.render(); return; }
    // 160ms：比画廊联想（180ms）略快 —— 浮窗是「查角色」，本地索引毫秒级，不必等太久
    this.debounceTimer = setTimeout(() => this.searchNow(this.query), 160);
  }

  /** 联想请求（与网格搜索并行，互不阻塞：网格给全景，联想给精确跳转）。 */
  scheduleSuggest(value) {
    const text = String(value || "").trim();
    if (this.suggestTimer) clearTimeout(this.suggestTimer);
    if (!text) { this.hideSuggest(); return; }
    this.suggestTimer = setTimeout(() => this.fetchSuggest(text), 140);
  }

  async fetchSuggest(text) {
    const requestId = ++this.suggestRequestId;
    try {
      const response = await fetch(`/anima/animadex/suggest?q=${encodeURIComponent(text)}&limit=10`);
      const data = await response.json();
      if (requestId !== this.suggestRequestId || !this.suggestBox) return;
      this.suggestItems = Array.isArray(data.suggestions) ? data.suggestions : [];
      this.suggestCursor = -1;
      this.renderSuggest();
    } catch {
      if (requestId === this.suggestRequestId) this.hideSuggest();
    }
  }

  renderSuggest() {
    const box = this.suggestBox;
    if (!box) return;
    box.replaceChildren();
    if (!this.suggestItems.length) { this.hideSuggest(); return; }
    this.suggestItems.forEach((item, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "adg-animadex-suggest-row";
      row.dataset.index = String(index);
      // 双语呈现：有中文名就「中文 → English」，没有就只给英文名
      const main = document.createElement("span");
      main.className = "adg-animadex-suggest-main";
      main.textContent = item.zh ? `${item.zh} → ${item.name}` : String(item.name || "");
      const sub = document.createElement("span");
      sub.className = "adg-animadex-suggest-sub";
      sub.textContent = item.series ? `${item.series}` : "";
      row.append(main, sub);
      row.onclick = () => this.useRow(this.suggestRowToCard(item));
      box.append(row);
    });
    box.style.display = "block";
  }

  hideSuggest() {
    if (this.suggestBox) {
      this.suggestBox.style.display = "none";
      this.suggestBox.replaceChildren();
    }
    this.suggestItems = [];
    this.suggestCursor = -1;
  }

  moveSuggestCursor(delta) {
    if (!this.suggestItems.length) return;
    const count = this.suggestItems.length;
    // 同 moveSeriesCursor：光标域 [-1, count-1] 的取模必须带 `cursor + 1`，
    // 否则 -1 起按 ↓ 会原地不动（旧公式 `(cursor + delta + count + 1) % (count + 1) - 1` 的缺陷）。
    const span = count + 1;
    this.suggestCursor = (((this.suggestCursor + 1 + delta) % span) + span) % span - 1;
    [...this.suggestBox.children].forEach((row, index) => {
      row.classList.toggle("is-active", index === this.suggestCursor);
    });
    this.suggestBox.children[this.suggestCursor]?.scrollIntoView({ block: "nearest" });
  }

  /** 联想候选 → 卡片形状（复用 composeText / useRow 的同一条路径）。 */
  suggestRowToCard(item) {
    const slug = String(item.slug || "");
    const row = this.results.find((r) => r.slug === slug);
    if (row) return row;
    return { slug, name: item.name, zh: item.zh, series: item.series, trigger: "", outfit: [], features: [] };
  }

  async searchNow(value) {
    this.query = String(value ?? this.query ?? "");
    if (this.tab !== "all") { this.render(); return; }   // 收藏/最近：本地过滤
    this.page = 1;
    return this.fetchPage();
  }

  async refreshLocal() {
    return this.fetchPage();
  }

  /** 拉「全部」tab 的一页结果（浮窗**没有翻页 UI**，page 恒为 1）。
   *
   *  守卫语义（冷审查缺陷 8 修复）：请求在飞时**不丢弃**新查询，只记 pending 标记，
   *  当前请求收尾后自动补发一次 —— 否则慢请求期间的最后一次输入永远发不出去，
   *  表现为「输入框显示 A、网格显示 B、状态栏停在上一次结果」。
   *  补发用的是最新的 page / query / seriesFilter（状态早已更新），所以补发即最新查询；
   *  被吞的那次结果用 pendingFetch 判定为**过时**，直接跳过渲染，绝不把旧结果盖到新查询上。 */
  async fetchPage() {
    if (this.loading) { this.pendingFetch = true; return; }
    this.pendingFetch = false;
    this.loading = true;
    const requestId = ++this.requestId;
    this.setStatus(t("status_querying"));
    try {
      // 空搜索 + 选了作品 → 用作品名走后端（后端 search 里 series 命中 rank=3），
      // 「全部」tab 因此拿到该作品的**候选池**（子串召回 ⊇ 等值命中），再由 visibleRows 做严格等值过滤。
      // 后端不做 series 等值过滤（不改后端），所以选了作品就把 limit 提到 SERIES_FETCH_LIMIT 一次取够，
      // 否则 36 条池子过滤后可能只剩几条甚至 0 条（缺陷 10）。
      const limit = this.seriesFilter ? SERIES_FETCH_LIMIT : PAGE_LIMIT;
      const params = new URLSearchParams({ q: this.query || this.seriesFilter, page: String(this.page), limit: String(limit) });
      const response = await fetch(`/anima/animadex/search?${params.toString()}`);
      const data = await response.json();
      // 三条件任一成立就不渲染：已被更新的请求取代 / 浮窗已关 / 已排了补发（本次结果已过时）
      if (requestId !== this.requestId || !this.grid || this.pendingFetch) return;
      this.results = Array.isArray(data.results) ? data.results : [];
      this.total = Number(data.total) || 0;
      this.candidateCount = this.results.length;
      // 顺手入缓存：切到「收藏 / 最近」时命中过的角色不必再回查后端
      for (const row of this.results) {
        const slug = String(row?.slug || "");
        if (slug) this.rowCache.set(slug, row);
      }
      this.render();
    } catch (error) {
      // 已排补发时不写失败态：那一次即将发出，让它的结果说话（避免闪一下红字又变正常）
      if (requestId === this.requestId && !this.pendingFetch) {
        this.setStatus(t("status_query_failed", { message: String(error?.message || error) }));
      }
    } finally {
      this.loading = false;
      // 补发被守卫吞掉的最新一次查询（此处 loading 已复位，同步进入下一轮，不会再被拦下）
      if (this.pendingFetch) {
        this.pendingFetch = false;
        void this.fetchPage();
      }
    }
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  /** 当前 tab 要展示的角色行（收藏/最近按本地 slug 顺序 + 本地关键字过滤 + 作品筛选）。 */
  visibleRows() {
    if (this.tab === "favorites") return this.filterBySeries(this.filterLocally(this.rowsForSlugs(this.favorites.slice().reverse())));
    if (this.tab === "recent") return this.filterBySeries(this.filterLocally(this.rowsForSlugs(this.recent)));
    return this.filterBySeries(this.results);
  }

  filterLocally(rows) {
    const query = this.query.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => (
      `${row.slug || ""} ${row.name || ""} ${row.zh || ""} ${row.series || ""}`.toLowerCase().includes(query)
    ));
  }

  emptyText() {
    if (this.seriesFilter) return t("empty_series", { name: this.seriesFilter });
    if (this.tab === "favorites") {
      return this.favorites.length ? t("empty_favorites_loading") : t("empty_favorites_none");
    }
    if (this.tab === "recent") {
      return this.recent.length ? t("empty_recent_loading") : t("empty_recent_none");
    }
    return this.query ? t("empty_query", { query: this.query }) : t("empty_all");
  }

  /** 状态栏文案（count = 实际渲染条数）。
   *  作品筛选下 total 传**本次候选池条数**而不是后端 total（缺陷 10）：后端 total 是子串召回的全量
   *  （可能 3,702），与等值过滤后的条数差着数量级，正是「显示 0 条却写着 3702」的来源。
   *  读法：`N / M 个角色 · 作品「x」` = 从本次取回的 M 条候选里，筛出属于该作品的 N 条。 */
  statusText(count) {
    const series = this.seriesFilter ? t("status_series_suffix", { name: this.seriesFilter }) : "";
    if (this.tab === "favorites") return t("status_favorites", { count, series });
    if (this.tab === "recent") return t("status_recent", { count, limit: RECENT_LIMIT, series });
    return t("status_all", { count, total: this.seriesFilter ? this.candidateCount : this.total, series });
  }

  render() {
    const grid = this.grid;
    if (!grid) return;
    grid.replaceChildren();
    // 卡片被整体换掉：焦点原本在网格里就会掉到 <body>，此后 keydown 再也到不了浮窗层
    // （表现为「切 tab / 重搜之后键位全哑」）。这里把焦点收回搜索框 —— 搜索框里没有候选时
    // ↑↓ 仍会冒泡进网格（见 input.onkeydown），键位链路不断。
    this.restoreFocusIfLost();
    const rows = this.visibleRows();
    // 重渲染即重置键盘高亮：卡片全部重建，旧下标已不指向同一张卡（数字键 1~9 的基准同步刷新）
    this.cards = [];
    this.renderedRows = rows;
    this.cursorIndex = -1;
    if (!rows.length) {
      this.setStatus(this.emptyText());
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((row, index) => {
      const card = this.buildCard(row, index);
      this.cards.push(card);
      frag.append(card);
    });
    grid.append(frag);
    this.setStatus(this.statusText(rows.length));
  }

  buildCard(row, index) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "adg-animadex-card";
    card.dataset.slug = String(row.slug || "");
    card.dataset.index = String(index);   // 数字键 1~9 的落点（0 基）
    // 焦点落到卡片 = 高亮跟着走：Tab 进网格后 f / Enter 打的就是眼前这张卡（scroll=false 不抢原生滚动）
    card.onfocus = () => this.setGridCursor(index, false);
    card.title = `${row.name}${row.series ? ` · ${row.series}` : ""}\n${this.composeText(row)}`;

    const thumb = document.createElement("img");
    thumb.className = "adg-animadex-thumb";
    thumb.loading = "lazy";
    thumb.alt = String(row.name || "");
    // 缩略图经后端代理（白名单主机 + 一天缓存），不直连第三方 CDN
    thumb.src = row.thumb ? `/anima/animadex/image?url=${encodeURIComponent(row.thumb)}` : "";
    thumb.onerror = () => { thumb.classList.add("is-broken"); };

    const label = document.createElement("span");
    label.className = "adg-animadex-name";
    label.textContent = row.zh ? `${row.zh}` : String(row.name || "");
    const sub = document.createElement("span");
    sub.className = "adg-animadex-sub";
    sub.textContent = row.series || "";

    // 星标（收藏）：卡片右上角。必须 stopPropagation —— 否则会连带触发「用这个角色」并关掉浮窗
    const star = document.createElement("button");
    star.type = "button";
    star.className = "adg-animadex-fav";
    const favorite = this.isFavorite(row.slug);
    star.textContent = favorite ? "★" : "☆";
    star.classList.toggle("is-on", favorite);
    star.title = favorite ? t("fav_remove_title") : t("fav_add_title");
    star.setAttribute("aria-pressed", favorite ? "true" : "false");
    star.onclick = (event) => {
      event.stopPropagation();
      event.preventDefault();
      this.toggleFavorite(row.slug);
    };

    card.append(thumb, star, label, sub);
    card.onclick = () => this.useRow(row);
    return card;
  }

  /** 按两个开关组合出要写入的文本（人物+作品 / 服饰配件 各自可开关）。 */
  composeText(row) {
    const parts = [];
    const trigger = String(row.trigger || row.name || "").trim();
    if (trigger) {
      const tokens = trigger.split(",").map((t) => t.trim()).filter(Boolean);
      // trigger 形如 "hatsune miku, vocaloid"：第 1 段是角色，其余是作品/系列
      parts.push(tokens[0] || "");
      if (this.includeSeries) parts.push(...tokens.slice(1));
    } else if (row.name) {
      parts.push(String(row.name));
    }
    if (this.includeOutfit && Array.isArray(row.outfit)) {
      parts.push(...row.outfit.map((t) => String(t).replaceAll("_", " ")));
    }
    return parts.filter(Boolean).join(", ");
  }

  useRow(row) {
    const text = this.composeText(row);
    if (!text) return;
    this.rememberRecent(row);   // 只有真写入成功（composeText 非空）才进「最近」
    this.onInsert(text);
    this.close();
  }

  destroy() {
    this.close();
    // 注销语言订阅：面板销毁后不该再被 setLocale 唤起（也避免监听器累积）
    this.offLocale?.();
    this.offLocale = null;
    this.triggerButton = null;
  }
}
