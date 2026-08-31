// TK String Router：ComfyUI 原生风格的六路字符串放行面板。
(function () {
  const NODE_NAME = "TK String Router";
  const INPUT_COUNT = 6;
  const DEFAULT_SETTINGS = {
    mode: "single",
    enabled: [true, false, false, false, false, false],
    selected: 0,
    names: ["1", "2", "3", "4", "5", "6"],
  };

  function cloneDefaults() {
    return {
      mode: DEFAULT_SETTINGS.mode,
      enabled: [...DEFAULT_SETTINGS.enabled],
      selected: DEFAULT_SETTINGS.selected,
      names: [...DEFAULT_SETTINGS.names],
    };
  }

  function parseSettings(raw) {
    const result = cloneDefaults();
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
      if (!parsed || typeof parsed !== "object") return result;
      if (parsed.mode === "single" || parsed.mode === "multi") result.mode = parsed.mode;
      if (Array.isArray(parsed.enabled)) {
        result.enabled = Array.from({ length: INPUT_COUNT }, (_, index) => Boolean(parsed.enabled[index]));
      }
      if (Array.isArray(parsed.names)) {
        result.names = Array.from({ length: INPUT_COUNT }, (_, index) => String(parsed.names[index] ?? "").trim() || String(index + 1));
      }
      const selected = Number.parseInt(parsed.selected, 10);
      if (Number.isInteger(selected) && selected >= 0 && selected < INPUT_COUNT) result.selected = selected;
    } catch (_) {
      // 损坏的工作流配置回退到安全默认值。
    }
    return result;
  }

  function firstEnabled(enabled) {
    const index = enabled.findIndex(Boolean);
    return index >= 0 ? index : 0;
  }

  function injectStyles() {
    const styleId = "tk-string-router-style";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .tk-sr-panel { box-sizing:border-box; width:100%; padding:4px 5px 5px; color:#b8b8b8; font:12px/1.25 Arial,sans-serif; }
      .tk-sr-panel * { box-sizing:border-box; }
      .tk-sr-header { display:flex; align-items:center; gap:6px; min-height:23px; padding:0 1px 3px; border-bottom:1px solid rgba(255,255,255,.10); }
      .tk-sr-title { color:#bdbdbd; font-weight:normal; white-space:nowrap; }
      .tk-sr-mode { min-width:0; flex:1; padding:3px 5px; color:#d5d5d5; background:#353535; border:1px solid #555; border-radius:2px; font:11px Arial,sans-serif; outline:none; }
      .tk-sr-mode:focus { border-color:#8d8d8d; }
      .tk-sr-count { min-width:27px; color:#858585; font-size:11px; text-align:right; font-variant-numeric:tabular-nums; }
      .tk-sr-note { padding:4px 1px 3px; color:#858585; font-size:10px; }
      .tk-sr-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:3px 5px; }
      .tk-sr-row { display:flex; align-items:center; min-width:0; min-height:25px; padding:2px 4px; border:1px solid transparent; border-radius:2px; background:rgba(0,0,0,.13); cursor:pointer; }
      .tk-sr-row:hover { background:rgba(255,255,255,.055); }
      .tk-sr-row.is-enabled { border-color:rgba(255,255,255,.14); background:rgba(255,255,255,.075); }
      .tk-sr-control { width:13px; height:13px; margin:0 5px 0 0; flex:0 0 auto; accent-color:#bcbcbc; cursor:pointer; }
      .tk-sr-index { width:17px; flex:0 0 auto; color:#929292; text-align:center; font-size:11px; font-variant-numeric:tabular-nums; }
      .tk-sr-name { min-width:0; flex:1; margin-left:5px; padding:3px 5px; color:#dddddd; background:#343434; border:1px solid #505050; border-radius:2px; outline:none; font:11px Arial,sans-serif; }
      .tk-sr-name:focus { border-color:#999; }
      .tk-sr-name::placeholder { color:#777; }
    `;
    document.head.appendChild(style);
  }

  class StringRouterUI {
    constructor(node) {
      this.node = node;
      this.settingsWidget = null;
      this.settings = cloneDefaults();
      this.container = null;
      this.grid = null;
      this.mode = null;
      this.count = null;
      this.controls = new Map();
    }

    installSettingsWidget() {
      this.settingsWidget = this.node.widgets?.find((widget) => widget.name === "router_settings") || null;
      if (!this.settingsWidget && typeof this.node.addWidget === "function") {
        this.settingsWidget = this.node.addWidget("text", "router_settings", JSON.stringify(this.settings), () => {}, { serialize: true });
      }
      if (this.settingsWidget) {
        this.settings = parseSettings(this.settingsWidget.value);
        this.settingsWidget.computeSize = () => [0, -4];
        this.settingsWidget.draw = () => {};
        this.settingsWidget.type = "hidden";
        this.settingsWidget.hidden = true;
        this.settingsWidget.options = this.settingsWidget.options || {};
        this.settingsWidget.options.hidden = true;
      }
    }

    commit() {
      if (this.settingsWidget) this.settingsWidget.value = JSON.stringify(this.settings);
      this.node.graph?.change();
      this.updateVisualState();
    }

    updateVisualState() {
      if (this.count) {
        const count = this.settings.enabled.filter(Boolean).length;
        this.count.textContent = `${count}/${INPUT_COUNT}`;
      }
      for (const [category, control] of this.controls) {
        const enabled = Boolean(this.settings.enabled[category]);
        control.input.checked = enabled;
        control.row.classList.toggle("is-enabled", enabled);
      }
    }

    selectMode(nextMode) {
      if (nextMode === "single") {
        const selected = firstEnabled(this.settings.enabled);
        this.settings.enabled = this.settings.enabled.map((_, index) => index === selected);
        this.settings.selected = selected;
      } else {
        const selected = Number.isInteger(this.settings.selected) ? this.settings.selected : firstEnabled(this.settings.enabled);
        this.settings.enabled = this.settings.enabled.map((_, index) => index === selected);
      }
      this.settings.mode = nextMode === "multi" ? "multi" : "single";
      this.renderRows();
      this.commit();
    }

    renderRows() {
      if (!this.grid) return;
      this.grid.innerHTML = "";
      this.controls.clear();
      const inputType = this.settings.mode === "single" ? "radio" : "checkbox";
      if (this.settings.mode === "single" && !this.settings.enabled.some(Boolean)) {
        this.settings.enabled[0] = true;
        this.settings.selected = 0;
      }
      if (this.settings.mode === "single") this.settings.selected = firstEnabled(this.settings.enabled);

      for (let index = 0; index < INPUT_COUNT; index += 1) {
        const row = document.createElement("div");
        row.className = "tk-sr-row";
        const control = document.createElement("input");
        control.className = "tk-sr-control";
        control.type = inputType;
        control.name = `tk-string-router-${this.node.id}`;
        control.checked = Boolean(this.settings.enabled[index]);
        control.title = this.settings.mode === "single" ? "选择唯一放行接口" : "切换接口放行状态";
        const number = document.createElement("span");
        number.className = "tk-sr-index";
        number.textContent = String(index + 1);
        const name = document.createElement("input");
        name.className = "tk-sr-name";
        name.type = "text";
        name.value = this.settings.names[index];
        name.placeholder = `接口 ${index + 1}`;
        name.title = "接口名称仅作为节点内别名，不改变底层连线名称";

        control.addEventListener("change", () => {
          if (this.settings.mode === "single") {
            this.settings.enabled = this.settings.enabled.map((_, item) => item === index);
            this.settings.selected = index;
          } else {
            this.settings.enabled[index] = control.checked;
            this.settings.selected = firstEnabled(this.settings.enabled);
          }
          this.commit();
          this.renderRows();
        });
        name.addEventListener("input", () => {
          this.settings.names[index] = name.value.trim() || String(index + 1);
          this.commit();
        });
        row.addEventListener("click", (event) => {
          if (event.target === control || event.target === name) return;
          control.click();
        });
        row.append(control, number, name);
        this.grid.appendChild(row);
        this.controls.set(index, { row, input: control });
      }
      this.updateVisualState();
    }

    build() {
      injectStyles();
      const container = document.createElement("div");
      container.className = "tk-sr-panel";
      this.container = container;

      const header = document.createElement("div");
      header.className = "tk-sr-header";
      const title = document.createElement("span");
      title.className = "tk-sr-title";
      title.textContent = "模式";
      this.mode = document.createElement("select");
      this.mode.className = "tk-sr-mode";
      this.mode.innerHTML = '<option value="single">单选</option><option value="multi">多选</option>';
      this.mode.value = this.settings.mode;
      this.mode.addEventListener("change", () => this.selectMode(this.mode.value));
      this.count = document.createElement("span");
      this.count.className = "tk-sr-count";
      header.append(title, this.mode, this.count);

      const note = document.createElement("div");
      note.className = "tk-sr-note";
      note.textContent = "关闭的接口不会进入输出";
      this.grid = document.createElement("div");
      this.grid.className = "tk-sr-grid";
      container.append(header, note, this.grid);
      this.renderRows();
      return container;
    }

    load() {
      if (this.settingsWidget) this.settings = parseSettings(this.settingsWidget.value);
      if (this.mode) this.mode.value = this.settings.mode;
      this.renderRows();
    }
  }

  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);
    api.registerExtension({
      name: "TK.StringRouter.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onNodeCreated = function () {
          const result = originalCreated?.apply(this, arguments);
          if (this._tkStringRouterUI) return result;
          const ui = new StringRouterUI(this);
          this._tkStringRouterUI = ui;
          ui.installSettingsWidget();
          const element = ui.build();
          const domWidget = this.addDOMWidget?.("tk_string_router", "custom", element, { serialize: false, hideOnZoom: false });
          if (domWidget) {
            domWidget.computeSize = () => [0, 137];
            this.setSize?.([Math.max(300, this.size?.[0] || 300), 380]);
          }
          return result;
        };
        nodeType.prototype.onConfigure = function () {
          const result = originalConfigure?.apply(this, arguments);
          this._tkStringRouterUI?.load();
          return result;
        };
      },
    });
  }

  init();
})();
