// AnimaDex 浮窗多语言（i18n）基础设施（2026-09-27）
//
// 定位（小而专）：只服务 `anima_animadex_panel.js` 的用户可见文案，不搞通用 i18n 框架。
// 组织方式参考 `newtextdoc1111/ComfyUI-Autocomplete-Plus`（MIT，193★）的 locales 思路：
// 按语言分表、按 key 取文案、`{name}` 占位插值 —— 但**文案表内联在本模块里**，
// 不建 `locales/*.json`：本插件的 web 静态资源经 ComfyUI 扩展路由加载，
// 运行时再 fetch 一个 JSON 会多一条可能失败的链路（且离线场景下是纯粹的额外风险），
// 内联进模块由 ESM 一次性带进来最稳。
//
// API（4 个导出）：
//   t(key, params)         取当前语言文案；`{name}` 占位用 params 插值；缺 key 回落 zh 再回落 key 本身
//   setLocale(locale)      切语言（写 localStorage + 广播订阅者）；非法值回落 zh；返回生效的语言
//   detectLocale()         localStorage 优先，其次 navigator.language，识别不到回落 zh
//   onLocaleChange(fn)     订阅语言变化，返回取消订阅函数（浮窗用它做「切换即重渲染文案」）
//   （另有 getLocale() / LOCALES / DEFAULT_LOCALE 供调用方读状态，不参与渲染逻辑）
//
// 惰性初始化：模块顶层**不读** localStorage / navigator（只定义数据），首次用到才探测。
// 理由：本模块被 `anima_animadex_panel.js` 顶层 import，而面板模块会被 Node 测试直接 import
// （`tests/js/test_animadex_panel_keys.mjs` 在最小 DOM 桩下跑）—— 顶层零副作用才保证
// 「import 这个模块」在任何环境都不会抛错。
//
// ⚠️ 本文件由浏览器直接加载，**禁止任何 TypeScript 类型注解**（node --check 会骗你通过）。

/** 默认语言：识别不到就用它（zh 是原硬编码文案的语言，回落到它 = 行为与改造前一致）。 */
export const DEFAULT_LOCALE = "zh";

/** 语言选择的持久化 key（只存语言代码字符串）。 */
const STORAGE_KEY = "anima_animadex_locale_v1";

/**
 * 文案表。key 一律 `域_名` 命名，两个语言**必须同 key 同数量**（漏一个会静默回落 zh）。
 * zh 表就是改造前 `anima_animadex_panel.js` 里的硬编码原文，逐字照抄 —— 不许顺手改措辞，
 * 否则「多语言改造」会夹带一次文案变更，回归时无法判断是谁的锅。
 */
const MESSAGES = {
  zh: {
    // 入口按钮
    trigger: "角色",
    trigger_title: "AnimaDex 角色浮窗：查角色并把它写入节点 Prompt 输出（换人物用）",
    // 头部
    title: "AnimaDex 角色",
    search_placeholder: "角色 / 作品名（中英皆可）",
    close_title: "关闭（Esc）",
    lang_title: "切换语言（中文 / English）",
    lang_badge: "中",
    // 开关行
    switch_series: "人物+作品",
    switch_outfit: "服饰配件",
    key_hint: "↑↓←→ 选择 · Enter 使用 · 1~9 快选 · f 收藏 · Ctrl+1/2/3 切 tab",
    // tab
    tab_all: "全部",
    tab_favorites: "收藏",
    tab_recent: "最近",
    // 作品筛选
    series_label: "作品",
    series_aria: "作品筛选（可搜索）",
    series_input_title: "输入作品 / 系列名即时过滤候选（↑↓ 选择、Enter 确认、Esc 收起；清空 = 全部作品）",
    series_clear_title: "清除作品筛选（回到全部作品）",
    series_all: "全部作品",
    series_all_count: "全部作品（{count}）",
    series_all_search: "全部作品 · 搜索 {count} 个",
    series_loading: "作品列表加载中…",
    series_limited: "仅显示前 {shown} / {matched} 项，继续输入以缩小范围",
    // 状态栏
    status_loading: "加载中…",
    status_querying: "查询中…",
    status_query_failed: "查询失败：{message}",
    status_hydrating: "加载 {count} 个角色详情…",
    status_all: "{count} / {total} 个角色{series} · 点击卡片写入 Prompt 输出（换人物用）",
    status_favorites: "收藏 {count} 个{series} · 点 ★ 取消收藏（点卡片写入 Prompt 输出）",
    status_recent: "最近使用 {count} / {limit} 个{series} · 点卡片写入 Prompt 输出",
    status_series_suffix: " · 作品「{name}」",
    // 空态
    empty_series: "作品「{name}」下没有匹配的角色（清空作品输入框恢复）",
    empty_favorites_loading: "收藏的角色正在加载…",
    empty_favorites_none: "还没有收藏：点卡片右上角 ☆ 加入",
    empty_recent_loading: "最近的角色正在加载…",
    empty_recent_none: "还没有使用记录：用过的角色会出现在这里",
    empty_query: "没有匹配「{query}」的角色",
    empty_all: "角色库为空（检查 anima_animadex.json.gz）",
    // 收藏星标
    fav_add_title: "收藏（加入「收藏」tab）",
    fav_remove_title: "取消收藏",
  },
  en: {
    trigger: "Characters",
    trigger_title: "AnimaDex character window: find a character and write it to the node's Prompt output (for swapping characters)",
    title: "AnimaDex Characters",
    search_placeholder: "Character / series name (Chinese or English)",
    close_title: "Close (Esc)",
    lang_title: "Switch language (中文 / English)",
    lang_badge: "EN",
    switch_series: "Character + series",
    switch_outfit: "Outfit & accessories",
    key_hint: "↑↓←→ select · Enter use · 1~9 quick pick · f favorite · Ctrl+1/2/3 switch tab",
    tab_all: "All",
    tab_favorites: "Favorites",
    tab_recent: "Recent",
    series_label: "Series",
    series_aria: "Series filter (searchable)",
    series_input_title: "Type a series name to filter candidates (↑↓ select, Enter confirm, Esc collapse; clear = all series)",
    series_clear_title: "Clear series filter (back to all series)",
    series_all: "All series",
    series_all_count: "All series ({count})",
    series_all_search: "All series · search {count}",
    series_loading: "Loading series list…",
    series_limited: "Showing first {shown} / {matched}; keep typing to narrow down",
    status_loading: "Loading…",
    status_querying: "Searching…",
    status_query_failed: "Search failed: {message}",
    status_hydrating: "Loading {count} character detail(s)…",
    status_all: "{count} / {total} characters{series} · click a card to write it to Prompt output (for swapping characters)",
    status_favorites: "{count} favorite(s){series} · click ★ to unfavorite (click a card to write it to Prompt output)",
    status_recent: "Recent {count} / {limit}{series} · click a card to write it to Prompt output",
    status_series_suffix: " · series '{name}'",
    empty_series: "No matching characters under series '{name}' (clear the series input to reset)",
    empty_favorites_loading: "Loading favorited characters…",
    empty_favorites_none: "No favorites yet: click ☆ at a card's top-right corner to add",
    empty_recent_loading: "Loading recent characters…",
    empty_recent_none: "No history yet: characters you use will appear here",
    empty_query: "No characters matching '{query}'",
    empty_all: "Character library is empty (check anima_animadex.json.gz)",
    fav_add_title: "Favorite (add to the Favorites tab)",
    fav_remove_title: "Remove from favorites",
  },
};

/** 可选语言代码列表（顺序 = 语言切换按钮的轮换顺序）。 */
export const LOCALES = Object.keys(MESSAGES);

/** 当前语言；null = 尚未初始化（惰性探测，见文件头注释）。 */
let current = null;

/** 语言变化订阅者。 */
const listeners = new Set();

function hasLocale(locale) {
  return Object.prototype.hasOwnProperty.call(MESSAGES, locale);
}

function readStored() {
  try {
    return String(window.localStorage.getItem(STORAGE_KEY) || "");
  } catch {
    return "";   // 隐私模式 / 无 localStorage：当作没存过
  }
}

function writeStored(locale) {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // 写不进去只在本次会话有效，不影响切换本身
  }
}

/** 把 BCP-47 语言标签归一化到本模块支持的语言；识别不到回落 zh。 */
function normalizeLocale(tag) {
  const value = String(tag || "").trim().toLowerCase();
  if (value.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

/** 读 navigator.language（拿不到就当空串，交给 normalizeLocale 回落）。 */
function navigatorLanguage() {
  try {
    const nav = typeof navigator === "undefined" ? null : navigator;
    if (!nav) return "";
    const list = Array.isArray(nav.languages) ? nav.languages[0] : "";
    return String(nav.language || list || "");
  } catch {
    return "";
  }
}

/**
 * 探测语言：**存过的选择优先**（用户显式选过就该记住），其次 `navigator.language`，最后 zh。
 * 只认 en 系列；zh / zh-CN / zh-TW 以及任何其它语言都回落 zh。
 */
export function detectLocale() {
  const stored = readStored().trim().toLowerCase();
  if (stored && hasLocale(stored)) return stored;
  return normalizeLocale(navigatorLanguage());
}

/** 当前语言（首次调用触发探测）。 */
export function getLocale() {
  if (!current) current = detectLocale();
  return current;
}

/**
 * 切换语言：写 localStorage + 通知订阅者。
 * 非法语言代码回落 zh（不抛错 —— 浮窗不该因为一个坏参数白屏）。
 */
export function setLocale(locale) {
  const next = hasLocale(String(locale || "")) ? String(locale) : DEFAULT_LOCALE;
  const changed = next !== current;
  current = next;
  writeStored(next);
  if (changed) {
    // 复制一份再遍历：订阅者在回调里取消订阅是合法用法，直接遍历 Set 会漏掉后续项
    for (const handler of [...listeners]) {
      try {
        handler(next);
      } catch {
        // 单个订阅者出错不拖累其余订阅者，也不把异常抛回 setLocale 的调用方
      }
    }
  }
  return next;
}

/** 订阅语言变化，返回取消订阅函数（面板在 destroy 时调用，避免监听器累积）。 */
export function onLocaleChange(handler) {
  if (typeof handler !== "function") return () => {};
  listeners.add(handler);
  return () => { listeners.delete(handler); };
}

/**
 * 取文案。查表顺序：当前语言 → zh（兜底）→ key 本身（兜底，便于一眼看出漏了哪个 key）。
 * params 里没给的占位符替换成空串 —— 宁可少一段文字，也不要让 `{count}` 露在界面上。
 */
export function t(key, params) {
  const name = String(key);
  const table = MESSAGES[getLocale()] || MESSAGES[DEFAULT_LOCALE];
  let text = table[name];
  if (text === undefined) text = MESSAGES[DEFAULT_LOCALE][name];
  if (text === undefined) return name;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, slot) => (
    Object.prototype.hasOwnProperty.call(params, slot) ? String(params[slot] ?? "") : ""
  ));
}
