// TK String Router 节点面板：单选/多选接口开关 + 可保存的接口别名。
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
        result.enabled = Array.from({ length: INPUT_COUNT }, (_, i) => Boolean(parsed.enabled[i]));
      }
      if (Array.isArray(parsed.names)) {
        result.names = Array.from({ length: INPUT_COUNT }, (_, i) => String(parsed.names[i] ?? "").trim() || String(i + 1));
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
      .tk-string-router { box-sizing:border-box; display:flex; flex-direction:column; gap:6px; padding:7px; color:#d7d9df; background:rgba(17,19,23,.92); border:1px solid rgba(255,255,255,.09); border-radius:8px; font:11px/1.35 system-ui,sans-serif; }
      .tk-string-router * { box-sizing:border-box; }
      .tk-string-router-toolbar { display:flex; align-items:center; gap:7px; }
      .tk-string-router-toolbar label { color:#9da3ad; white-space:nowrap; }
      .tk-string-router-mode { flex:1; min-width:0; color:#e8e9ec; background:#24272d; border:1px solid #41454d; border-radius:5px; padding:3px 5px; font-size:11px; }
      .tk-string-router-help { color:#8c929d; font-size:10px; line-height:1.45; }
      .tk-string-router-list { display:flex; flex-direction:column; gap:4px; }
      .tk-string-router-row { display:flex; align-items:center; gap:5px; min-height:27px; padding:3px 4px; border:1px solid rgba(255,255,255,.06); border-radius:5px; background:rgba(255,255,255,.025); }
      .tk-string-router-row.is-enabled { border-color:rgba(105,160,255,.3); background:rgba(73,117,190,.12); }
      .tk-string-router-control { width:14px; height:14px; margin:0; accent-color:#76a9ff; flex:0 0 auto; cursor:pointer; }
      .tk-string-router-index { width:34px; color:#a8adb7; font-variant-numeric:tabular-nums; white-space:nowrap; }
      .tk-string-router-name { min-width:0; flex:1; color:#eceef2; background:#15171b; border:1px solid #3a3e46; border-radius:4px; padding:4px 6px; outline:none; font-size:11px; }
      .tk-string-router-name:focus { border-color:#76a9ff; box-shadow:0 0 0 2px rgba(118,169,255,.15); }
      .tk-string-router-state { width:29px; color:#737984; text-align:right; font-size:10px; }
      .tk-string-router-row.is-enabled .tk-string-router-state { color:#8bb8ff; }
    `;
    document.head.appendChild(style);
  }

  class StringRouterUI {
    constructor(node) {
      this.node = node;
      this.settingsWidget = null;
      this.settings = cloneDefaults();
      this.container = null;
      this.list = null;
      this.summary = null;
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
      if (this.settingsWidget) {
        const value = JSON.stringify(this.settings);
        if (this.settingsWidget.value !== value) this.settingsWidget.value = value;
      }
      this.node.graph?.change();
      this.updateSummary();
    }

    updateSummary() {
      if (!this.summary) return;
      const count = this.settings.enabled.filter(Boolean).length;
      this.summary.textContent = `${this.settings.mode === "single" ? "单选" : "多选"} · 已开启 ${count}/${INPUT_COUNT}`;
    }

    renderRows() {
      if (!this.list) return;
      this.list.innerHTML = "";
      const inputType = this.settings.mode === "single" ? "radio" : "checkbox";
      this.settings.selected = this.settings.mode === "single" ? firstEnabled(this.settings.enabled) : firstEnabled(this.settings.enabled);
      for (let index = 0; index < INPUT_COUNT; index += 1) {
        const row = document.createElement("div");
        row.className = `tk-string-router-row${this.settings.enabled[index] ? " is-enabled" : ""}`;

        const control = document.createElement("input");
        control.className = "tk-string-router-control";
        control.type = inputType;
        control.name = `tk-string-router-${this.node.id}`;
        control.checked = this.settings.enabled[index];
        control.title = this.settings.mode === "single" ? "选择唯一放行接口" : "开关此接口的放行状态";
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

        const indexLabel = document.createElement("span");
        indexLabel.className = "tk-string-router-index";
        indexLabel.textContent = `接口 ${index + 1}`;

        const nameInput = document.createElement("input");
        nameInput.className = "tk-string-router-name";
        nameInput.type = "text";
        nameInput.value = this.settings.names[index];
        nameInput.placeholder = `接口 ${index + 1}名称`;
        nameInput.title = "自定义接口名称（仅作为节点内别名，不改变底层连线名称）";
        nameInput.addEventListener("input", () => {
          this.settings.names[index] = nameInput.value.trim() || String(index + 1);
          this.commit();
        });

        const state = document.createElement("span");
        state.className = "tk-string-router-state";
        state.textContent = this.settings.enabled[index] ? "放行" : "关闭";
        row.append(control, indexLabel, nameInput, state);
        this.list.appendChild(row);
      }
      this.updateSummary();
    }

    build() {
      injectStyles();
      const container = document.createElement("div");
      container.className = "tk-string-router";
      this.container = container;

      const toolbar = document.createElement("div");
      toolbar.className = "tk-string-router-toolbar";
      const modeLabel = document.createElement("label");
      modeLabel.textContent = "接口模式";
      const mode = document.createElement("select");
      mode.className = "tk-string-router-mode";
      mode.innerHTML = '<option value="single">单选：只放行一个接口</option><option value="multi">多选：放行多个接口</option>';
      mode.value = this.settings.mode;
      mode.addEventListener("change", () => {
        const nextMode = mode.value;
        if (nextMode === "single") {
          const selected = firstEnabled(this.settings.enabled);
          this.settings.enabled = this.settings.enabled.map((_, index) => index === selected);
          this.settings.selected = selected;
        } else {
          const selected = this.settings.selected;
          this.settings.enabled = this.settings.enabled.map((_, index) => index === selected);
        }
        this.settings.mode = nextMode;
        this.commit();
        this.renderRows();
      });
      this.summary = document.createElement("span");
      this.summary.className = "tk-string-router-help";
      toolbar.append(modeLabel, mode, this.summary);

      const help = document.createElement("div");
      help.className = "tk-string-router-help";
      help.textContent = "关闭的字符串不会进入输出；多选时按接口 1→6 顺序合并，分隔符在节点标准控件中设置。";
      this.list = document.createElement("div");
      this.list.className = "tk-string-router-list";
      container.append(toolbar, help, this.list);
      this.renderRows();
      return container;
    }

    load() {
      if (this.settingsWidget) this.settings = parseSettings(this.settingsWidget.value);
      if (this.container) {
        const mode = this.container.querySelector(".tk-string-router-mode");
        if (mode) mode.value = this.settings.mode;
        this.renderRows();
      }
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
          if (typeof this.addDOMWidget === "function") {
            const domWidget = this.addDOMWidget("tk_string_router", "custom", element, { serialize: false, hideOnZoom: false });
            if (domWidget) domWidget.computeSize = () => [0, 220];
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
