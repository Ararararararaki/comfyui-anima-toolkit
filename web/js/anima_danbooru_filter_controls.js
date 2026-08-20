import { PortalDropdown } from "./anima_dropdown_menu.js";

// 注意：新增筛选字段必须同步 ① 这里 FILTER_DEFAULTS/normalizeFilters 白名单 ② widget currentQuery 拼词
// ③ 前端 FREE_METATAGS（anima_danbooru_gallery_widget.js）与后端 FREE_METATAGS（anima_danbooru_gallery.py）
export const FILTER_DEFAULTS = Object.freeze({
  age: "", ageDays: "", minScore: "", minFavs: "", order: "",
  minMpixels: "", ratio: "", filetype: "",
});
const RATING_VALUES = ["g", "s", "q", "e"];
const RATING_OPTIONS = [["g", "普通"], ["s", "敏感"], ["q", "可疑"], ["e", "明确"]];
// age 值语义为「近 N 时间单位」（拼词时加 age:< 前缀）；D站 的 age:1day 是等值（恰好一天前），会显示过期内容
const AGE_OPTIONS = [["", "全部"], ["1day", "近 24 小时"], ["3days", "近 3 天"], ["1week", "近 1 周"], ["1month", "近 1 月"], ["1year", "近 1 年"]];
const SCORE_OPTIONS = [["", "不限"], ["10", "≥ 10"], ["50", "≥ 50"], ["100", "≥ 100"], ["500", "≥ 500"]];
const FAVORITE_OPTIONS = [["", "不限"], ["5", "≥ 5"], ["10", "≥ 10"], ["20", "≥ 20"], ["50", "≥ 50"]];
const ORDER_OPTIONS = [["", "最新"], ["score", "评分"], ["favcount", "收藏"], ["rank", "综合"], ["random", "随机"]];
const MPIXEL_OPTIONS = [["", "不限"], ["1", "≥ 1MP"], ["2", "≥ 2MP"], ["4", "≥ 4MP"], ["8", "≥ 8MP"]];
const RATIO_OPTIONS = [["", "全部"], ["wide", "横图"], ["tall", "竖图"], ["square", "方形"], ["ultrawide", "宽幅(≥1.5)"]];
const FILETYPE_OPTIONS = [["", "全部"], ["static", "静态图"], ["gif", "GIF 动图"], ["video", "视频 MP4"]];

// 一键快捷预设（筛选菜单底部）：点击即应用 + 搜索
const QUICK_PRESETS = [
  { label: "🔥 本周热门", filters: { age: "1week", minScore: "100", order: "score" }, hint: "近 1 周评分 ≥100 按评分排序" },
  { label: "🖼 高清壁纸", filters: { minMpixels: "4", ratio: "wide" }, hint: "≥4MP 横图" },
  { label: "📱 竖图精选", filters: { ratio: "tall" }, hint: "竖图" },
  { label: "🎞 动图", filters: { filetype: "video" }, hint: "视频/GIF（视频自动抽帧）" },
];

export function normalizeRatings(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(source.map((item) => String(item).trim().toLowerCase()).filter((item) => RATING_VALUES.includes(item)))];
}

export function normalizeFilters(value) {
  const source = value && typeof value === "object" ? value : {};
  const age = ["", "1day", "3days", "1week", "1month", "1year"].includes(source.age) ? source.age : "";
  return {
    age,
    ageDays: /^\d{1,3}$/.test(String(source.ageDays || "")) ? String(Number(source.ageDays)) : "",
    minScore: /^\d+$/.test(String(source.minScore || "")) ? String(source.minScore) : "",
    minFavs: /^\d+$/.test(String(source.minFavs || "")) ? String(source.minFavs) : "",
    order: ["", "score", "favcount", "rank", "random"].includes(source.order) ? source.order : "",
    minMpixels: /^\d+$/.test(String(source.minMpixels || "")) ? String(source.minMpixels) : "",
    ratio: ["", "wide", "tall", "square", "ultrawide"].includes(source.ratio) ? source.ratio : "",
    filetype: ["", "static", "gif", "video"].includes(source.filetype) ? source.filetype : "",
  };
}

export class GalleryFilterControls {
  constructor({ readSettings, commit }) {
    this.readSettings = readSettings;
    this.commit = commit;
    this.dropdowns = [];
    this.ratingDropdown = new PortalDropdown({
      label: "分级",
      title: "选择图片分级（可多选）",
      menuClass: "adg-rating-menu",
      content: () => this.buildRatingMenu(),
    });
    this.filterDropdown = new PortalDropdown({
      label: "筛选",
      title: "设置时间、最低评分、最低收藏和排序",
      menuClass: "adg-filter-menu",
      content: () => this.buildFilterMenu(),
    });
    this.categoryDropdown = new PortalDropdown({
      label: "全部分类",
      title: "按本地分类筛选",
      menuClass: "adg-category-menu",
      content: () => this.buildCategoryMenu(),
    });
    this.dropdowns.push(this.ratingDropdown, this.filterDropdown, this.categoryDropdown);
    this.refresh();
  }

  mountFilters(toolbar) {
    toolbar.append(this.ratingDropdown.element, this.filterDropdown.element);
  }

  mountCategory(toolbar) {
    toolbar.append(this.categoryDropdown.element);
  }

  filterCount(filters = this.readSettings().filters) {
    return Object.values(filters).filter(Boolean).length;
  }

  refresh() {
    const settings = this.readSettings();
    this.ratingDropdown.setSummary("分级", settings.rating.length);
    this.filterDropdown.setSummary("筛选", this.filterCount(settings.filters));
    const active = settings.categories.find((category) => category.id === settings.activeCategory);
    this.categoryDropdown.setSummary(active?.name || "全部分类");
  }

  createChoice(label, { type = "checkbox", checked = false, onChange }) {
    const row = document.createElement("label");
    row.className = "adg-menu-choice";
    const input = document.createElement("input");
    input.type = type;
    input.checked = checked;
    const text = document.createElement("span");
    text.className = "adg-menu-choice-text";
    text.textContent = label;
    row.classList.toggle("is-selected", checked);
    input.addEventListener("change", () => {
      row.classList.toggle("is-selected", input.checked);
      onChange?.(input.checked, input);
    });
    row.append(input, text);
    return { row, input };
  }

  createMenuActions(onReset, onApply) {
    const actions = document.createElement("div");
    actions.className = "adg-menu-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "重置";
    reset.onclick = onReset;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary";
    apply.textContent = "应用筛选";
    apply.onclick = onApply;
    actions.append(reset, apply);
    return actions;
  }

  createCascadeRow({ label, value, options, onSelect, customLabel = "", customFormat = null }) {
    let selectedValue = String(value || "");
    const row = document.createElement("div");
    row.className = "adg-cascade-row";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "adg-menu-row-button";
    const name = document.createElement("span");
    name.className = "adg-menu-choice-text";
    name.textContent = label;
    const current = document.createElement("span");
    current.className = "adg-menu-current";
    const arrow = document.createElement("span");
    arrow.className = "adg-menu-arrow";
    arrow.textContent = "›";
    trigger.append(name, current, arrow);
    const submenu = document.createElement("div");
    submenu.className = "adg-submenu adg-menu-section";
    const optionButtons = [];
    const updateSelection = () => {
      const match = options.find(([optionValue]) => String(optionValue) === selectedValue);
      current.textContent = match?.[1]
        || (selectedValue ? (customFormat ? customFormat(selectedValue) : `≥ ${selectedValue}`) : "不限");
      optionButtons.forEach(({ button, optionValue }) => {
        const selected = optionValue === selectedValue;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-checked", selected ? "true" : "false");
      });
    };
    for (const [optionValueRaw, optionLabel] of options) {
      const optionValue = String(optionValueRaw);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "adg-menu-choice";
      button.setAttribute("role", "menuitemradio");
      button.textContent = optionLabel;
      button.onclick = (event) => {
        event.stopPropagation();
        selectedValue = optionValue;
        onSelect(optionValue);
        updateSelection();
      };
      optionButtons.push({ button, optionValue });
      submenu.append(button);
    }
    if (customLabel) {
      const divider = document.createElement("div");
      divider.className = "adg-menu-divider";
      const custom = document.createElement("label");
      custom.className = "adg-custom-number";
      const labelElement = document.createElement("span");
      labelElement.textContent = customLabel;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.placeholder = "自定义";
      if (selectedValue && !options.some(([optionValue]) => String(optionValue) === selectedValue)) input.value = selectedValue;
      input.oninput = () => {
        selectedValue = /^\d+$/.test(input.value) ? input.value : "";
        onSelect(selectedValue);
        updateSelection();
      };
      custom.append(labelElement, input);
      submenu.append(divider, custom);
    }
    updateSelection();
    row.append(trigger, submenu);
    return row;
  }

  buildRatingMenu() {
    const settings = this.readSettings();
    const draft = new Set(settings.rating);
    const root = document.createElement("div");
    root.className = "adg-menu-section";
    const title = document.createElement("div");
    title.className = "adg-menu-title";
    title.textContent = "图片分级（可多选）";
    const all = this.createChoice("全部分级（不限制）", { type: "radio", checked: draft.size === 0 });
    const choices = [];
    const sync = () => {
      all.input.checked = draft.size === 0;
      all.row.classList.toggle("is-selected", all.input.checked);
      choices.forEach(({ value, row, input }) => {
        input.checked = draft.has(value);
        row.classList.toggle("is-selected", input.checked);
      });
    };
    all.input.onchange = () => { draft.clear(); sync(); };
    root.append(title, all.row);
    for (const [value, label] of RATING_OPTIONS) {
      const choice = this.createChoice(label, {
        checked: draft.has(value),
        onChange: (checked) => { if (checked) draft.add(value); else draft.delete(value); sync(); },
      });
      choices.push({ value, ...choice });
      root.append(choice.row);
    }
    const divider = document.createElement("div");
    divider.className = "adg-menu-divider";
    const actions = this.createMenuActions(
      () => { draft.clear(); sync(); },
      () => {
        this.commit({ rating: RATING_VALUES.filter((value) => draft.has(value)) }, { search: true });
        this.refresh();
        this.ratingDropdown.close();
      },
    );
    root.append(divider, actions);
    return root;
  }

  buildFilterMenu() {
    const settings = this.readSettings();
    const draft = { ...settings.filters };
    const root = document.createElement("div");
    root.className = "adg-menu-section";
    const title = document.createElement("div");
    title.className = "adg-menu-title";
    title.textContent = "高级筛选";
    root.append(
      title,
      this.createCascadeRow({
        label: "时间",
        value: draft.age || draft.ageDays,
        options: AGE_OPTIONS,
        customLabel: "天",
        customFormat: (v) => `${v} 天`,
        onSelect: (value) => {
          // 数字 = 自定义天数（age 语义「近 N 天」）；档位 = 预设时间窗
          if (/^\d+$/.test(value)) { draft.age = ""; draft.ageDays = value; }
          else { draft.age = value; draft.ageDays = ""; }
        },
      }),
      this.createCascadeRow({ label: "最低评分", value: draft.minScore, options: SCORE_OPTIONS, customLabel: "分数", onSelect: (value) => { draft.minScore = value; } }),
      this.createCascadeRow({ label: "最低收藏", value: draft.minFavs, options: FAVORITE_OPTIONS, customLabel: "收藏", onSelect: (value) => { draft.minFavs = value; } }),
      this.createCascadeRow({ label: "画质", value: draft.minMpixels, options: MPIXEL_OPTIONS, customLabel: "MP", onSelect: (value) => { draft.minMpixels = value; } }),
      this.createCascadeRow({ label: "方向", value: draft.ratio, options: RATIO_OPTIONS, onSelect: (value) => { draft.ratio = value; } }),
      this.createCascadeRow({ label: "文件类型", value: draft.filetype, options: FILETYPE_OPTIONS, onSelect: (value) => { draft.filetype = value; } }),
      this.createCascadeRow({ label: "排序", value: draft.order, options: ORDER_OPTIONS, onSelect: (value) => { draft.order = value; } }),
    );
    // 一键快捷预设：直接应用整组筛选 + 搜索
    const presets = document.createElement("div");
    presets.className = "adg-quick-presets";
    const pTitle = document.createElement("div");
    pTitle.className = "adg-menu-title";
    pTitle.textContent = "快捷筛选";
    presets.append(pTitle);
    for (const { label, filters, hint } of QUICK_PRESETS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "adg-quick-preset";
      btn.textContent = label;
      btn.title = hint;
      btn.onclick = () => {
        Object.assign(draft, JSON.parse(JSON.stringify(FILTER_DEFAULTS)), filters);
        this.commit({ filters: normalizeFilters(draft) }, { search: true });
        this.refresh();
        this.filterDropdown.close();
      };
      presets.append(btn);
    }
    const divider = document.createElement("div");
    divider.className = "adg-menu-divider";
    const actions = this.createMenuActions(
      () => {
        this.commit({ filters: { ...FILTER_DEFAULTS } }, { search: true });
        this.refresh();
        this.filterDropdown.close();
      },
      () => {
        this.commit({ filters: normalizeFilters(draft) }, { search: true });
        this.refresh();
        this.filterDropdown.close();
      },
    );
    root.append(divider, presets, actions);
    return root;
  }

  buildCategoryMenu() {
    const settings = this.readSettings();
    const root = document.createElement("div");
    root.className = "adg-menu-section";
    const title = document.createElement("div");
    title.className = "adg-menu-title";
    title.textContent = "本地分类";
    root.append(title);
    const categories = [{ id: "", name: "全部分类" }, ...settings.categories];
    for (const category of categories) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "adg-menu-choice";
      button.classList.toggle("is-selected", category.id === settings.activeCategory);
      const text = document.createElement("span");
      text.className = "adg-menu-choice-text";
      text.textContent = category.name;
      const mark = document.createElement("span");
      mark.textContent = category.id === settings.activeCategory ? "✓" : "";
      button.append(text, mark);
      button.onclick = () => {
        this.commit({ activeCategory: category.id }, { render: true });
        this.refresh();
        this.categoryDropdown.close();
      };
      root.append(button);
    }
    return root;
  }

  destroy() {
    this.dropdowns.splice(0).forEach((dropdown) => dropdown.destroy());
  }
}
