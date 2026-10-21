// Shared presentation language. The toolbox settings remain the single owner.
// Importing this module must be safe in offline tests without a browser.
const SETTINGS_KEY = 'anima_settings';
const CHANGE_EVENT = 'tk-toolkit-locale-change';
const listeners = new Set();
let boundWindow = null;

export function getNodeLocale() {
  try {
    const storage = globalThis.window?.localStorage ?? globalThis.localStorage;
    const settings = JSON.parse(storage?.getItem(SETTINGS_KEY) || '{}');
    return settings?.locale === 'en' ? 'en' : 'zh-CN';
  } catch { return 'zh-CN'; }
}

export function uiText(chinese, english, params = {}) {
  const source = getNodeLocale() === 'en' ? english : chinese;
  return String(source ?? chinese ?? '').replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key] ?? '') : match);
}

const BUILTIN_CATEGORIES = {
  uncategorized: ['未分类', 'Uncategorized'], cat_faces: ['人物', 'Characters'],
  cat_style: ['画师风格', 'Artist styles'], cat_env: ['背景环境', 'Backgrounds'],
  cat_light: ['光影氛围', 'Lighting'], cat_detail: ['细节增强', 'Details'], cat_fav: ['常用', 'Frequent'],
  card_all: ['通用', 'General'], card_char: ['角色', 'Characters'], card_style: ['画风', 'Style'],
  card_pose: ['姿势', 'Pose'], card_scene: ['场景', 'Scene'], card_quality: ['质量词', 'Quality'],
  card_lora: ['LoRA 触发词', 'LoRA trigger words'],
};

export function builtinCategoryLabel(category) {
  const name = String(category?.name || '');
  const entry = BUILTIN_CATEGORIES[category?.id];
  return entry && name === entry[0] ? uiText(entry[0], entry[1]) : name;
}

function notify() {
  for (const callback of [...listeners]) {
    try { callback(getNodeLocale()); } catch (error) { console.warn('[TK locale]', error); }
  }
}

export function onNodeLocaleChange(callback) {
  const view = globalThis.window;
  if (view && view !== boundWindow) {
    boundWindow = view;
    view.addEventListener?.('storage', event => {
      if (event.key === SETTINGS_KEY || event.key === null) notify();
    });
    view.addEventListener?.(CHANGE_EVENT, notify);
  }
  listeners.add(callback);
  return () => listeners.delete(callback);
}
