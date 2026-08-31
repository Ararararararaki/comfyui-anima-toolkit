// TK Danbooru Tag Getter：用 ComfyUI 原生风格整理 12 个 BOOLEAN 分类开关。
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
      .tk-dtb-filters { margin-top:5px; padding-top:5px; border-top:1px solid rgba(255,255,255,.10); }
      .tk-dtb-filter-title { color:#bdbdbd; font-size:11px; }
      .tk-dtb-filter-row { display:flex; align-items:flex-start; gap:5px; margin-top:4px; }
      .tk-dtb-filter-label { flex:0 0 52px; padding-top:4px; color:#929292; font-size:10px; white-space:nowrap; }
      .tk-dtb-filter-input { min-width:0; width:100%; flex:1; padding:4px 5px; color:#dedede; background:#343434; border:1px solid #505050; border-radius:2px; outline:none; font:11px/1.35 Arial,sans-serif; resize:vertical; }
      .tk-dtb-filter-input:focus { border-color:#999; }
      .tk-dtb-filter-input::placeholder { color:#777; }
      textarea.tk-dtb-filter-input { min-height:39px; max-height:82px; }
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
    }

    widgetFor(category) {
      return this.node.widgets?.find((widget) => widget.name === category) || null;
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
        row.append(toggle, label);
        row.addEventListener("click", (event) => {
          if (event.target === toggle) return;
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
      }
      for (const name of ["regex_blacklist", "tag_blacklist"]) {
        const widget = this.widgetFor(name);
        const field = this.filterControls.get(name);
        if (widget && field && field.value !== String(widget.value || "")) field.value = String(widget.value || "");
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

