import { uiText } from "./anima_node_i18n.js";
import { PortalDropdown } from "./anima_dropdown_menu.js";

// 新增筛选字段同步这里的 defaults/normalization、anima_danbooru_query 的拼词/计数，
// 以及后端 anima_danbooru_gallery 的计数政策。控件只呈现和提交筛选。
export const FILTER_DEFAULTS = Object.freeze({
  age: "", ageDays: "", minScore: "", minFavs: "", order: "",
  minMpixels: "", ratio: "", filetype: "",
});
const RATING_VALUES = ["g", "s", "q", "e"];
const RATING_OPTIONS = [["g", uiText("普通", "General")], ["s", uiText("敏感", "Sensitive")], ["q", uiText("可疑", "Questionable")], ["e", uiText("明确", "Explicit")]];
// age 值语义为「近 N 时间单位」（拼词时加 age:< 前缀）；D站 的 age:1day 是等值（恰好一天前），会显示过期内容
const AGE_OPTIONS = [["", uiText("全部", "All")], ["1day", uiText("近 24 小时", "Last 24 hours")], ["3days", uiText("近 3 天", "Last 3 days")], ["1week", uiText("近 1 周", "Last week")], ["1month", uiText("近 1 月", "Last month")], ["1year", uiText("近 1 年", "Last year")]];
const SCORE_OPTIONS = [["", uiText("不限", "Any")], ["10", "≥ 10"], ["50", "≥ 50"], ["100", "≥ 100"], ["500", "≥ 500"]];
const FAVORITE_OPTIONS = [["", uiText("不限", "Any")], ["5", "≥ 5"], ["10", "≥ 10"], ["20", "≥ 20"], ["50", "≥ 50"]];
const ORDER_OPTIONS = [["", uiText("最新", "Newest")], ["score", uiText("评分", "Score")], ["favcount", uiText("收藏", "Favorites")], ["rank", uiText("综合", "Overall")], ["random", uiText("随机", "Random")]];
const MPIXEL_OPTIONS = [["", uiText("不限", "Any")], ["1", "≥ 1MP"], ["2", "≥ 2MP"], ["4", "≥ 4MP"], ["8", "≥ 8MP"]];
const RATIO_OPTIONS = [["", uiText("全部", "All")], ["wide", uiText("横图", "Landscape")], ["tall", uiText("竖图", "Portrait")], ["square", uiText("方形", "Square")], ["ultrawide", uiText("宽幅(≥1.5)", "Wide (≥1.5)")]];
const FILETYPE_OPTIONS = [["", uiText("全部", "All")], ["static", uiText("静态图", "Still images")], ["gif", uiText("GIF 动图", "GIF")], ["video", uiText("视频 MP4", "MP4 video")]];

// 一键快捷预设（筛选菜单底部）：点击即应用 + 搜索
const QUICK_PRESETS = [
  { label: uiText("🔥 本周热门", "Popular this week"), filters: { age: "1week", minScore: "100", order: "score" }, hint: uiText("近 1 周评分 ≥100 按评分排序", "Last week, score ≥100, sorted by score") },
  { label: uiText("🖼 高清壁纸", "High-resolution wallpapers"), filters: { minMpixels: "4", ratio: "wide" }, hint: uiText("≥4MP 横图", "Landscape, ≥4 MP") },
  { label: uiText("📱 竖图精选", "Portrait selection"), filters: { ratio: "tall" }, hint: uiText("竖图", "Portrait") },
  { label: uiText("🎞 动图", "Animation"), filters: { filetype: "video" }, hint: uiText("视频/GIF（视频自动抽帧）", "Video / GIF (videos are converted to frames)") },
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
  constructor({ readSettings, commit, onRenameCategory, onDeleteCategory }) {
    this.readSettings = readSettings;
    this.commit = commit;
    // 分类库的唯一真源在后端：重命名/删除必须回调给 widget 落库，
    // 只改前端内存的话下次加载就被后端那份覆盖回来（用户表现为"改了又变回去/删了又回来"）。
    this.onRenameCategory = onRenameCategory;
    this.onDeleteCategory = onDeleteCategory;
    this.dropdowns = [];
    this.ratingDropdown = new PortalDropdown({
      label: uiText("分级", "Ratings"),
      title: uiText("选择图片分级（可多选）", "Choose image ratings (multiple selection)"),
      menuClass: "adg-rating-menu",
      content: () => this.buildRatingMenu(),
    });
    this.filterDropdown = new PortalDropdown({
      label: uiText("筛选", "Filters"),
      title: uiText("设置时间、最低评分、最低收藏和排序", "Set time range, minimum score, minimum favorites and sort order"),
      menuClass: "adg-filter-menu",
      content: () => this.buildFilterMenu(),
    });
    this.categoryDropdown = new PortalDropdown({
      label: uiText("全部分类", "All categories"),
      title: uiText("按本地分类筛选", "Filter by local category"),
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
    this.ratingDropdown.setSummary(uiText("分级", "Ratings"), settings.rating.length);
    this.filterDropdown.setSummary(uiText("筛选", "Filters"), this.filterCount(settings.filters));
    const active = settings.categories.find((category) => category.id === settings.activeCategory);
    this.categoryDropdown.setSummary(active?.name || uiText("全部分类", "All categories"));
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
    reset.textContent = uiText("重置", "Reset");
    reset.onclick = onReset;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary";
    apply.textContent = uiText("应用筛选", "Apply filters");
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
        || (selectedValue ? (customFormat ? customFormat(selectedValue) : `≥ ${selectedValue}`) : uiText("不限", "Any"));
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
      input.placeholder = uiText("自定义", "Custom");
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
    root.className = "adg-menu-section adg-rating-menu-content";
    const title = document.createElement("div");
    title.className = "adg-menu-title";
    title.textContent = uiText("图片分级（可多选）", "Image ratings (multiple selection)");
    const all = this.createChoice(uiText("全部分级（不限制）", "All ratings (unrestricted)"), { type: "radio", checked: draft.size === 0 });
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
    root.className = "adg-menu-section adg-filter-menu-content";
    root.dataset.cascadeMode = "click";
    const title = document.createElement("div");
    title.className = "adg-menu-title";
    title.textContent = uiText("高级筛选", "Advanced filters");
    const filterGrid = document.createElement("div");
    filterGrid.className = "adg-filter-grid";
    filterGrid.append(
      this.createCascadeRow({
        label: uiText("时间", "Time"),
        value: draft.age || draft.ageDays,
        options: AGE_OPTIONS,
        customLabel: uiText("天", "days"),
        customFormat: (v) => uiText(`${v} 天`, `${v} days`),
        onSelect: (value) => {
          // 数字 = 自定义天数（age 语义「近 N 天」）；档位 = 预设时间窗
          if (/^\d+$/.test(value)) { draft.age = ""; draft.ageDays = value; }
          else { draft.age = value; draft.ageDays = ""; }
        },
      }),
      this.createCascadeRow({ label: uiText("最低评分", "Minimum score"), value: draft.minScore, options: SCORE_OPTIONS, customLabel: uiText("分数", "Score"), onSelect: (value) => { draft.minScore = value; } }),
      this.createCascadeRow({ label: uiText("最低收藏", "Minimum favorites"), value: draft.minFavs, options: FAVORITE_OPTIONS, customLabel: uiText("收藏", "Favorites"), onSelect: (value) => { draft.minFavs = value; } }),
      this.createCascadeRow({ label: uiText("画质", "Resolution"), value: draft.minMpixels, options: MPIXEL_OPTIONS, customLabel: "MP", onSelect: (value) => { draft.minMpixels = value; } }),
      this.createCascadeRow({ label: uiText("方向", "Orientation"), value: draft.ratio, options: RATIO_OPTIONS, onSelect: (value) => { draft.ratio = value; } }),
      this.createCascadeRow({ label: uiText("文件类型", "File type"), value: draft.filetype, options: FILETYPE_OPTIONS, onSelect: (value) => { draft.filetype = value; } }),
      this.createCascadeRow({ label: uiText("排序", "Sort"), value: draft.order, options: ORDER_OPTIONS, onSelect: (value) => { draft.order = value; } }),
    );
    root.append(title, filterGrid);
    // 一键快捷预设：直接应用整组筛选 + 搜索
    const presets = document.createElement("div");
    presets.className = "adg-quick-presets";
    const pTitle = document.createElement("div");
    pTitle.className = "adg-menu-title";
    pTitle.textContent = uiText("快捷筛选", "Quick filters");
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
    title.textContent = uiText("本地分类（点选筛选；✎ 重命名 / ✕ 删除）", "Local categories (click to filter; ✎ rename / ✕ delete)");
    root.append(title);
    const categories = [{ id: "", name: uiText("全部分类", "All categories") }, ...settings.categories];
    // 每类计数（postCategories 统计）
    const counts = {};
    for (const cid of Object.values(settings.postCategories)) counts[cid] = (counts[cid] || 0) + 1;
    for (const category of categories) {
      if (!category.id) {
        const all = document.createElement("button");
        all.type = "button";
        all.className = "adg-menu-choice";
        all.classList.toggle("is-selected", category.id === settings.activeCategory);
        const text = document.createElement("span");
        text.className = "adg-menu-choice-text";
        text.textContent = uiText(`${category.name}（${Object.keys(settings.postCategories).length} 张已归类）`, `${category.name} (${Object.keys(settings.postCategories).length} categorized images)`);
        all.append(text);
        all.onclick = () => {
          this.commit({ activeCategory: category.id }, { render: true });
          this.refresh();
          this.categoryDropdown.close();
        };
        root.append(all);
        continue;
      }
      const row = document.createElement("div");
      row.className = "adg-category-row";
      row.classList.toggle("is-selected", category.id === settings.activeCategory);
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "adg-menu-choice adg-category-pick";
      const text = document.createElement("span");
      text.className = "adg-menu-choice-text";
      text.textContent = uiText(`${category.name}（${counts[category.id] || 0}）`, `${category.name} (${counts[category.id] || 0}）`);
      const mark = document.createElement("span");
      mark.textContent = category.id === settings.activeCategory ? "✓" : "";
      pick.append(text, mark);
      pick.onclick = () => {
        this.commit({ activeCategory: category.id }, { render: true });
        this.refresh();
        this.categoryDropdown.close();
      };
      const ops = document.createElement("span");
      ops.className = "adg-category-ops";
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "adg-category-op";
      rename.title = uiText("重命名分类", "Rename category");
      rename.textContent = "✎";
      rename.onclick = async (event) => {
        event.stopPropagation();
        const name = prompt(uiText("重命名分类", "Rename category"), category.name);
        if (!name?.trim()) return;
        if (this.onRenameCategory) {
          // 走后端：成功后 widget 会重新拉库并 refresh，这里不用再改内存
          await this.onRenameCategory(category, name.trim());
          this.refresh();
          this.categoryDropdown.close();   // 菜单内容是打开时构建的，关掉免得显示旧名字
          return;
        }
        const cats = settings.categories.map((c) => (c.id === category.id ? { ...c, name: name.trim() } : c));
        this.commit({ categories: cats }, { render: true });
        this.refresh();
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "adg-category-op adg-category-op-remove";
      remove.title = uiText("删除分类（其中的图片变回未分类）", "Delete category (its images become uncategorized)");
      remove.textContent = "✕";
      remove.onclick = async (event) => {
        event.stopPropagation();
        if (this.onDeleteCategory) {
          // 走后端：后端会把该分类下的条目退回「未分类」（不删条目）
          await this.onDeleteCategory(category);
          this.refresh();
          this.categoryDropdown.close();   // 菜单内容是打开时构建的，关掉免得还列着已删的分类
          return;
        }
        const cats = settings.categories.filter((c) => c.id !== category.id);
        const postCategories = {};
        for (const [pid, cid] of Object.entries(settings.postCategories)) {
          if (cid !== category.id) postCategories[pid] = cid;
        }
        const patch = { categories: cats, postCategories };
        if (settings.activeCategory === category.id) patch.activeCategory = "";
        this.commit(patch, { render: true });
        this.refresh();
      };
      ops.append(rename, remove);
      row.append(pick, ops);
      root.append(row);
    }
    return root;
  }

  destroy() {
    this.dropdowns.splice(0).forEach((dropdown) => dropdown.destroy());
  }
}
