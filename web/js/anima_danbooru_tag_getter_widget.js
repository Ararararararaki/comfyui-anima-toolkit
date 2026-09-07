// TK Danbooru Tag Getter：用 ComfyUI 原生风格整理 12 个分类开关与独立权重。
(function () {
  const NODE_NAME = "AnimaTKDanbooruTagGetter";
  const CATEGORY_NAMES = [
    "画师词",
    "背景词",
    "人物对象词",
    "角色特征词",
    "角色五官词",
    "角色部位词",
    "性征部位词",
    "服饰词",
    "动作词",
    "角色表情词",
    "镜头词",
    "未归类词",
  ];

  function injectStyles() {
    const styleId = "tk-danbooru-tag-getter-style";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .tk-dtb-panel { box-sizing:border-box; width:100%; padding:3px 5px 4px; color:#b8b8b8; font:12px/1.25 Arial, sans-serif; }
      .tk-dtb-panel * { box-sizing:border-box; }
      .tk-dtb-header { display:flex; align-items:center; justify-content:space-between; min-height:22px; padding:0 1px 3px; border-bottom:1px solid rgba(255,255,255,.10); }
      .tk-dtb-title { color:#bdbdbd; font-weight:normal; }
      .tk-dtb-count { color:#858585; font-size:11px; font-variant-numeric:tabular-nums; }
      .tk-dtb-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:2px 5px; padding-top:4px; }
      .tk-dtb-row { display:flex; align-items:center; min-width:0; min-height:22px; padding:2px 4px; border:1px solid transparent; border-radius:2px; background:rgba(0,0,0,.13); cursor:pointer; }
      .tk-dtb-row:hover { background:rgba(255,255,255,.055); }
      .tk-dtb-row.is-selected { color:#e1e1e1; border-color:rgba(255,255,255,.13); background:rgba(255,255,255,.08); }
      .tk-dtb-toggle { width:12px; height:12px; margin:0 5px 0 0; flex:0 0 auto; accent-color:#bcbcbc; cursor:pointer; }
      .tk-dtb-label { min-width:0; overflow:hidden; color:#9f9f9f; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
      .tk-dtb-row.is-selected .tk-dtb-label { color:#dedede; }
      .tk-dtb-weight-control { display:flex; align-items:center; gap:2px; flex:0 0 auto; margin-left:3px; color:#777; cursor:default; }
      .tk-dtb-weight-prefix { font-size:10px; line-height:16px; }
      .tk-dtb-weight-input { box-sizing:border-box; width:36px; height:17px; padding:1px 2px; color:#d7d7d7; background:#292929; border:1px solid #4a4a4a; border-radius:2px; outline:none; font:10px/1 Arial,sans-serif; text-align:right; }
      .tk-dtb-weight-input:focus { border-color:#999; }
      .tk-dtb-filters { margin-top:5px; padding-top:5px; border-top:1px solid rgba(255,255,255,.10); }
      .tk-dtb-filter-title { color:#bdbdbd; font-size:11px; }
      .tk-dtb-filter-row { display:flex; align-items:flex-start; gap:5px; margin-top:4px; }
      .tk-dtb-filter-label { flex:0 0 52px; padding-top:4px; color:#929292; font-size:10px; white-space:nowrap; }
      .tk-dtb-filter-input { min-width:0; width:100%; flex:1; padding:4px 5px; color:#dedede; background:#343434; border:1px solid #505050; border-radius:2px; outline:none; font:11px/1.35 Arial,sans-serif; resize:vertical; }
      .tk-dtb-filter-input:focus { border-color:#999; }
      .tk-dtb-filter-input::placeholder { color:#777; }
      textarea.tk-dtb-filter-input { min-height:39px; max-height:82px; }
      .tk-dtb-natural-hint { margin-top:5px; padding-top:5px; border-top:1px solid rgba(255,255,255,.10); color:#858585; font-size:10px; }
      .tk-dtb-natural-toggle { display:flex; align-items:center; gap:5px; margin-top:4px; color:#a5a5a5; font-size:10px; cursor:pointer; }
      .tk-dtb-natural-toggle input { width:12px; height:12px; margin:0; accent-color:#bcbcbc; cursor:pointer; }
    `;
    document.head.appendChild(style);
  }

  class DanbooruTagGetterUI {
    constructor(node) {
      this.node = node;
      this.panel = null;
      this.count = null;
      this.controls = new Map();
      this.filterControls = new Map();
      this.weightControls = new Map();
    }

    widgetFor(category) {
      return this.node.widgets?.find((widget) => widget.name === category) || null;
    }

    weightWidgetFor(category) {
      return this.node.widgets?.find((widget) => widget.name === `${category}_weight`) || null;
    }

    formatWeight(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return "1.0";
      return numeric.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") || "0";
    }

    updateCount() {
      if (!this.count) return;
      const selected = CATEGORY_NAMES.reduce((total, category) => {
        const widget = this.widgetFor(category);
        return total + (widget?.value ? 1 : 0);
      }, 0);
      this.count.textContent = `${selected} / ${CATEGORY_NAMES.length}`;
    }

    setWidgetValue(category, value) {
      const widget = this.widgetFor(category);
      if (!widget) return;
      widget.value = Boolean(value);
      if (typeof widget.callback === "function") widget.callback(widget.value);
      this.node.graph?.change();
      this.updateCount();
      const row = this.controls.get(category)?.row;
      row?.classList.toggle("is-selected", widget.value);
    }

    setFilterValue(name, value) {
      const widget = this.widgetFor(name);
      if (!widget) return;
      widget.value = String(value ?? "");
      if (typeof widget.callback === "function") widget.callback(widget.value);
      this.node.graph?.change();
    }

    setWeightValue(category, value) {
      const widget = this.weightWidgetFor(category);
      if (!widget) return;
      const numeric = Number(value);
      const next = Number.isFinite(numeric) ? Math.max(0.05, Math.min(2, Math.round(numeric / 0.05) * 0.05)) : 1;
      widget.value = Number(next.toFixed(2));
      if (typeof widget.callback === "function") widget.callback(widget.value);
      this.node.graph?.change();
      const control = this.weightControls.get(category);
      if (control && control.value !== this.formatWeight(widget.value)) control.value = this.formatWeight(widget.value);
    }

    hideNativeWidget(widget) {
      if (!widget) return;
      widget.hidden = true;
      widget.options = widget.options || {};
      widget.options.hidden = true;
      widget.computeSize = () => [0, -4];
      widget.draw = () => {};
      if (widget.element) widget.element.style.display = "none";
    }

    build() {
      injectStyles();
      const panel = document.createElement("div");
      panel.className = "tk-dtb-panel";
      this.panel = panel;

      const header = document.createElement("div");
      header.className = "tk-dtb-header";
      const title = document.createElement("span");
      title.className = "tk-dtb-title";
      title.textContent = "选择分类";
      this.count = document.createElement("span");
      this.count.className = "tk-dtb-count";
      header.append(title, this.count);

      const grid = document.createElement("div");
      grid.className = "tk-dtb-grid";
      CATEGORY_NAMES.forEach((category) => {
        const widget = this.widgetFor(category);
        if (!widget) return;
        const row = document.createElement("div");
        row.className = "tk-dtb-row";
        const toggle = document.createElement("input");
        toggle.className = "tk-dtb-toggle";
        toggle.type = "checkbox";
        toggle.checked = Boolean(widget.value);
        toggle.setAttribute("aria-label", category);
        toggle.addEventListener("change", () => this.setWidgetValue(category, toggle.checked));
        const label = document.createElement("span");
        label.className = "tk-dtb-label";
        label.textContent = category;
        const weightWidget = this.weightWidgetFor(category);
        let weightInput = null;
        if (weightWidget) {
          const weightControl = document.createElement("span");
          weightControl.className = "tk-dtb-weight-control";
          weightControl.title = `${category} Tag 权重（0.05–2.0；1.0 保持原样）`;
          const prefix = document.createElement("span");
          prefix.className = "tk-dtb-weight-prefix";
          prefix.textContent = "×";
          weightInput = document.createElement("input");
          weightInput.className = "tk-dtb-weight-input";
          weightInput.type = "number";
          weightInput.min = "0.05";
          weightInput.max = "2";
          weightInput.step = "0.05";
          weightInput.inputMode = "decimal";
          weightInput.value = this.formatWeight(weightWidget.value);
          weightInput.setAttribute("aria-label", `${category} Tag 权重`);
          weightInput.addEventListener("click", (event) => event.stopPropagation());
          weightInput.addEventListener("mousedown", (event) => event.stopPropagation());
          weightInput.addEventListener("change", () => this.setWeightValue(category, weightInput.value));
          weightInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); weightInput.blur(); }
          });
          weightControl.append(prefix, weightInput);
          row.append(toggle, label, weightControl);
          this.weightControls.set(category, weightInput);
          this.hideNativeWidget(weightWidget);
        } else {
          row.append(toggle, label);
        }
        row.addEventListener("click", (event) => {
          if (event.target === toggle || event.target.closest?.(".tk-dtb-weight-control")) return;
          toggle.checked = !toggle.checked;
          this.setWidgetValue(category, toggle.checked);
        });
        row.classList.toggle("is-selected", Boolean(widget.value));
        grid.appendChild(row);
        this.controls.set(category, { row, toggle });
        this.hideNativeWidget(widget);
      });

      const filters = document.createElement("div");
      filters.className = "tk-dtb-filters";
      const filterTitle = document.createElement("div");
      filterTitle.className = "tk-dtb-filter-title";
      filterTitle.textContent = "排除";
      filters.appendChild(filterTitle);

      const makeFilter = (name, labelText, placeholder, multiline) => {
        const widget = this.widgetFor(name);
        if (!widget) return;
        const row = document.createElement("div");
        row.className = "tk-dtb-filter-row";
        const label = document.createElement("span");
        label.className = "tk-dtb-filter-label";
        label.textContent = labelText;
        const field = document.createElement(multiline ? "textarea" : "input");
        field.className = "tk-dtb-filter-input";
        field.value = String(widget.value || "");
        field.placeholder = placeholder;
        field.title = name;
        if (multiline) {
          field.rows = 2;
          field.spellcheck = false;
        }
        field.addEventListener("input", () => this.setFilterValue(name, field.value));
        row.append(label, field);
        filters.appendChild(row);
        this.hideNativeWidget(widget);
        this.filterControls.set(name, field);
      };
      makeFilter("regex_blacklist", "正则排除", "censor|watermark", false);
      makeFilter("tag_blacklist", "精准排除", "每行一个 Tag，也可用逗号分隔", true);
      const makeNaturalToggle = (name, labelText) => {
        const widget = this.widgetFor(name);
        if (!widget) return;
        const label = document.createElement("label");
        label.className = "tk-dtb-natural-toggle";
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = widget.value !== false;
        toggle.setAttribute("aria-label", labelText);
        toggle.addEventListener("change", () => this.setWidgetValue(name, toggle.checked));
        const text = document.createElement("span");
        text.textContent = labelText;
        label.append(toggle, text);
        filters.appendChild(label);
        this.hideNativeWidget(widget);
        this.filterControls.set(name, toggle);
      };
      const naturalWidget = this.widgetFor("natural_language");
      if (naturalWidget) {
        this.hideNativeWidget(naturalWidget);
        const hint = document.createElement("div");
        hint.className = "tk-dtb-natural-hint";
        hint.textContent = "统一输入：普通 Prompt / Packer ALL_TAGS → natural_language；勾选具体分类后自动识别已知 Tag，未知句子由“保留自然语言”控制。tag_bundle 仅用于兼容已分类包。";
        filters.appendChild(hint);
      }
      makeNaturalToggle("include_natural_language", "保留自然语言");
      makeNaturalToggle("filter_natural_language", "过滤自然语言");

      panel.append(header, grid, filters);
      this.updateCount();
      return panel;
    }

    load() {
      for (const category of CATEGORY_NAMES) {
        const control = this.controls.get(category);
        const widget = this.widgetFor(category);
        if (!control || !widget) continue;
        control.toggle.checked = Boolean(widget.value);
        control.row.classList.toggle("is-selected", Boolean(widget.value));
        const weightWidget = this.weightWidgetFor(category);
        const weightControl = this.weightControls.get(category);
        if (weightWidget && weightControl) {
          const numeric = Number(weightWidget.value);
          // 旧工作流没有这些新增权重字段时，ComfyUI 可能恢复成 0；
          // 写回 1.0 并标记工作流变更，避免节点执行得到 (tag:0)。
          if (!Number.isFinite(numeric) || numeric <= 0) {
            weightWidget.value = 1.0;
            if (typeof weightWidget.callback === "function") weightWidget.callback(1.0);
            this.node.graph?.change();
          }
          weightControl.value = this.formatWeight(weightWidget.value);
        }
      }
      for (const name of ["regex_blacklist", "tag_blacklist"]) {
        const widget = this.widgetFor(name);
        const field = this.filterControls.get(name);
        if (widget && field && field.value !== String(widget.value || "")) field.value = String(widget.value || "");
      }
      for (const name of ["include_natural_language", "filter_natural_language"]) {
        const widget = this.widgetFor(name);
        const control = this.filterControls.get(name);
        if (widget && control) control.checked = widget.value !== false;
      }
      this.updateCount();
    }
  }

  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);
    api.registerExtension({
      name: "TK.DanbooruTagGetter.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onNodeCreated = function () {
          const result = originalCreated?.apply(this, arguments);
          if (this._tkDanbooruTagGetterUI) return result;
          const ui = new DanbooruTagGetterUI(this);
          this._tkDanbooruTagGetterUI = ui;
          const unifiedInput = this.inputs?.find((input) => input.name === "natural_language");
          if (unifiedInput) {
            unifiedInput.label = "统一 Prompt";
            unifiedInput.tooltip = "普通 Prompt 或 Packer ALL_TAGS；已知 Danbooru Tag 自动分类，未知段落可选择保留";
          }
          const legacyInput = this.inputs?.find((input) => input.name === "tag_bundle");
          if (legacyInput) legacyInput.label = "兼容·分类包";
          const element = ui.build();
          const domWidget = this.addDOMWidget?.("tk_danbooru_tag_getter", "custom", element, { serialize: false, hideOnZoom: false });
          if (domWidget) {
            domWidget.computeSize = () => [0, 270];
            this.setSize?.([Math.max(300, this.size?.[0] || 300), 335]);
          }
          return result;
        };
        nodeType.prototype.onConfigure = function () {
          const result = originalConfigure?.apply(this, arguments);
          this._tkDanbooruTagGetterUI?.load();
          return result;
        };
      },
    });
  }

  init();
})();
