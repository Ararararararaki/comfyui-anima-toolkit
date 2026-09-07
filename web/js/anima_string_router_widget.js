// TK String Router：ComfyUI 原生风格的六路字符串放行面板。
(function () {
  const NODE_NAME = "TK String Router";
  const INPUT_COUNT = 6;
  const DEFAULT_SETTINGS = {
    mode: "single",
    enabled: [true, false, false, false, false, false],
    selected: 0,
    names: ["1", "2", "3", "4", "5", "6"],
    order: [0, 1, 2, 3, 4, 5],
    labelSource: "custom",
  };

  function cloneDefaults() {
    return {
      mode: DEFAULT_SETTINGS.mode,
      enabled: [...DEFAULT_SETTINGS.enabled],
      selected: DEFAULT_SETTINGS.selected,
      names: [...DEFAULT_SETTINGS.names],
      order: [...DEFAULT_SETTINGS.order],
      labelSource: DEFAULT_SETTINGS.labelSource,
    };
  }

  function normalizeOrder(raw) {
    const result = [];
    const seen = new Set();
    if (Array.isArray(raw)) {
      for (const value of raw) {
        const index = Number.parseInt(value, 10);
        if (Number.isInteger(index) && index >= 0 && index < INPUT_COUNT && !seen.has(index)) {
          result.push(index);
          seen.add(index);
        }
      }
    }
    for (let index = 0; index < INPUT_COUNT; index += 1) {
      if (!seen.has(index)) result.push(index);
    }
    return result;
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
      if (parsed.labelSource === "custom" || parsed.labelSource === "original") {
        result.labelSource = parsed.labelSource;
      }
      const selected = Number.parseInt(parsed.selected, 10);
      if (Number.isInteger(selected) && selected >= 0 && selected < INPUT_COUNT) result.selected = selected;
      result.order = normalizeOrder(parsed.order ?? parsed.output_order);
    } catch (_) {
      // 损坏的工作流配置回退到安全默认值。
    }
    return result;
  }

  function firstEnabled(enabled) {
    const index = enabled.findIndex(Boolean);
    return index >= 0 ? index : 0;
  }

  function sourceNodeLabel(source, originId, labelSource = "custom") {
    const originalLabel = String(
      source?.properties?.["Node name for S&R"] || source?.comfyClass || source?.type || `节点 ${originId}`,
    ).trim();
    if (labelSource === "original") return originalLabel;

    // LiteGraph 的 title 就是画布上显示的节点名（包括用户通过节点菜单修改的自定义名称）。
    // 只有没有标题时才回退到原始节点名，避免把 PrimitiveStringMultiline 等内部类型显示出来。
    const displayTitle = String(source?.title || "").trim();
    return displayTitle || originalLabel;
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
      .tk-sr-row { display:flex; align-items:center; min-width:0; min-height:35px; padding:3px 4px; border:1px solid transparent; border-radius:3px; background:rgba(0,0,0,.13); cursor:grab; transition:background 180ms cubic-bezier(.22,1,.36,1), border-color 180ms cubic-bezier(.22,1,.36,1), transform 180ms cubic-bezier(.22,1,.36,1), opacity 180ms cubic-bezier(.22,1,.36,1), box-shadow 180ms cubic-bezier(.22,1,.36,1); }
      .tk-sr-row:hover { background:rgba(255,255,255,.055); }
      .tk-sr-row.is-enabled { border-color:rgba(255,255,255,.14); background:rgba(255,255,255,.075); }
      .tk-sr-row.is-dragging { opacity:.42; border-color:#8376d7; }
      .tk-sr-row.is-drag-over { border-color:#9b8cff; background:rgba(126,110,220,.22); box-shadow:0 0 0 1px rgba(155,140,255,.28), 0 4px 12px rgba(0,0,0,.28); transform:scale(1.018); }
      .tk-sr-control { width:13px; height:13px; margin:0 5px 0 0; flex:0 0 auto; accent-color:#bcbcbc; cursor:pointer; }
      .tk-sr-drag-handle { width:13px; flex:0 0 auto; margin-right:2px; color:#858585; font-size:13px; line-height:1; text-align:center; cursor:grab; user-select:none; }
      .tk-sr-index { width:20px; flex:0 0 auto; color:#bdbdbd; text-align:center; font-size:11px; font-variant-numeric:tabular-nums; }
      .tk-sr-name-wrap { min-width:0; flex:1; display:flex; flex-direction:column; gap:2px; margin-left:4px; }
      .tk-sr-name { width:100%; min-width:0; padding:3px 5px; color:#dddddd; background:#343434; border:1px solid #505050; border-radius:2px; outline:none; font:11px Arial,sans-serif; }
      .tk-sr-name:focus { border-color:#999; }
      .tk-sr-name::placeholder { color:#777; }
      .tk-sr-source { min-width:0; overflow:hidden; color:#8e8e8e; font-size:9px; line-height:1.1; text-overflow:ellipsis; white-space:nowrap; }
      .tk-sr-source.is-connected { color:#aaa2dc; }
      .tk-sr-row:has(.tk-sr-name:focus) { cursor:text; }
      @media (prefers-reduced-motion: reduce) { .tk-sr-row { transition:none; } }
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
      this.labelSource = null;
      this.count = null;
      this.controls = new Map();
      this.draggingSlot = null;
      this.dragOverSlot = null;
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

    getConnectionLabel(slotIndex) {
      const input = this.node.inputs?.[slotIndex];
      if (!input || input.link == null) return "";
      const graph = this.node.graph || window.app?.graph || window.app?.rootGraph || null;
      if (!graph) return "";
      let link = null;
      if (graph.links instanceof Map) link = graph.links.get(input.link) || graph.links.get(Number(input.link));
      else if (Array.isArray(graph.links)) link = graph.links.find((item) => String(item?.id ?? item?.[0]) === String(input.link));
      else if (graph.links && typeof graph.links === "object") link = graph.links[input.link];
      const originId = Array.isArray(link) ? link[1] : (link?.origin_id ?? link?.originId);
      const originSlot = Array.isArray(link) ? link[2] : (link?.origin_slot ?? link?.originSlot);
      if (originId == null) return "";
      let source = graph.getNodeById?.(originId) || graph.getNodeById?.(String(originId));
      if (!source) {
        const nodes = Array.isArray(graph.nodes) ? graph.nodes : (graph.nodes instanceof Map ? [...graph.nodes.values()] : Object.values(graph.nodes || {}));
        source = nodes.find((item) => String(item?.id) === String(originId));
      }
      if (!source) return `节点 ${originId}`;
      const nodeLabel = sourceNodeLabel(source, originId, this.settings?.labelSource);
      const output = Number.isInteger(Number(originSlot)) ? source.outputs?.[Number(originSlot)] : null;
      const outputLabel = String(output?.name || output?.label || "").trim();
      return outputLabel ? `${nodeLabel} · ${outputLabel}` : nodeLabel;
    }

    clearDragState() {
      this.draggingSlot = null;
      this.dragOverSlot = null;
      this.grid?.querySelectorAll(".is-dragging, .is-drag-over").forEach((row) => row.classList.remove("is-dragging", "is-drag-over"));
    }

    swapOrder(fromSlot, toSlot) {
      const from = this.settings.order.indexOf(fromSlot);
      const to = this.settings.order.indexOf(toSlot);
      if (from < 0 || to < 0 || from === to) return;
      [this.settings.order[from], this.settings.order[to]] = [this.settings.order[to], this.settings.order[from]];
      this.commit();
      this.renderRows();
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
      this.settings.order = normalizeOrder(this.settings.order);
      const inputType = this.settings.mode === "single" ? "radio" : "checkbox";
      if (this.settings.mode === "single" && !this.settings.enabled.some(Boolean)) {
        this.settings.enabled[0] = true;
        this.settings.selected = 0;
      }
      if (this.settings.mode === "single") this.settings.selected = firstEnabled(this.settings.enabled);

      for (const [position, slotIndex] of this.settings.order.entries()) {
        const row = document.createElement("div");
        row.className = "tk-sr-row";
        row.draggable = true;
        row.dataset.slot = String(slotIndex);
        row.dataset.position = String(position);
        row.setAttribute("aria-label", `输出 ${position + 1}，输入接口 ${slotIndex + 1}`);
        row.addEventListener("pointerdown", (event) => event.stopPropagation());
        row.addEventListener("mousedown", (event) => event.stopPropagation());
        const control = document.createElement("input");
        control.className = "tk-sr-control";
        control.type = inputType;
        control.name = `tk-string-router-${this.node.id}`;
        control.checked = Boolean(this.settings.enabled[slotIndex]);
        control.title = this.settings.mode === "single" ? "选择唯一放行接口" : "切换接口放行状态";
        const dragHandle = document.createElement("span");
        dragHandle.className = "tk-sr-drag-handle";
        dragHandle.textContent = "⠿";
        dragHandle.title = "拖拽交换输出顺序";
        dragHandle.setAttribute("aria-hidden", "true");
        const number = document.createElement("span");
        number.className = "tk-sr-index";
        number.textContent = String(position + 1);
        number.title = `输出顺序 ${position + 1} · 输入 ${slotIndex + 1}`;
        const nameWrap = document.createElement("div");
        nameWrap.className = "tk-sr-name-wrap";
        const name = document.createElement("input");
        name.className = "tk-sr-name";
        name.type = "text";
        const alias = String(this.settings.names[slotIndex] || "").trim();
        const sourceLabel = this.getConnectionLabel(slotIndex);
        name.value = alias && alias !== String(slotIndex + 1) ? alias : "";
        name.placeholder = sourceLabel || `接口 ${slotIndex + 1}`;
        name.title = "可填写自定义别名；留空时自动显示连接源节点名称";
        const source = document.createElement("span");
        source.className = "tk-sr-source" + (sourceLabel ? " is-connected" : "");
        source.textContent = sourceLabel ? `↳ ${sourceLabel}` : "↳ 未连接（自动读取源节点名称）";
        source.title = sourceLabel || "连接 STRING 后会自动显示源节点标题和输出名称";
        nameWrap.append(name, source);

        control.addEventListener("change", () => {
          if (this.settings.mode === "single") {
            this.settings.enabled = this.settings.enabled.map((_, item) => item === slotIndex);
            this.settings.selected = slotIndex;
          } else {
            this.settings.enabled[slotIndex] = control.checked;
            this.settings.selected = firstEnabled(this.settings.enabled);
          }
          this.commit();
          this.renderRows();
        });
        name.addEventListener("input", () => {
          this.settings.names[slotIndex] = name.value.trim() || String(slotIndex + 1);
          this.commit();
        });
        row.addEventListener("dragstart", (event) => {
          this.draggingSlot = slotIndex;
          row.classList.add("is-dragging");
          try {
            event.dataTransfer.setData("text/plain", `tk-string-router:${slotIndex}`);
            event.dataTransfer.effectAllowed = "move";
          } catch (_) { /* 某些嵌入式浏览器没有 dataTransfer */ }
          event.stopPropagation();
        });
        row.addEventListener("dragend", () => this.clearDragState());
        row.addEventListener("dragover", (event) => {
          if (this.draggingSlot == null || this.draggingSlot === slotIndex) return;
          event.preventDefault();
          event.stopPropagation();
          try { event.dataTransfer.dropEffect = "move"; } catch (_) { /* noop */ }
          this.grid.querySelectorAll(".is-drag-over").forEach((item) => item.classList.remove("is-drag-over"));
          row.classList.add("is-drag-over");
          this.dragOverSlot = slotIndex;
        });
        row.addEventListener("dragleave", (event) => {
          if (!row.contains(event.relatedTarget)) row.classList.remove("is-drag-over");
        });
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const fromSlot = this.draggingSlot;
          this.clearDragState();
          if (fromSlot != null && fromSlot !== slotIndex) this.swapOrder(fromSlot, slotIndex);
        });
        row.addEventListener("click", (event) => {
          if (event.target === control || event.target === name || event.target === dragHandle || source.contains(event.target)) return;
          control.click();
        });
        row.append(control, dragHandle, number, nameWrap);
        this.grid.appendChild(row);
        this.controls.set(slotIndex, { row, input: control });
      }
      this.updateVisualState();
    }

    refreshConnectionLabels() {
      if (this.grid) this.renderRows();
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
      const labelTitle = document.createElement("span");
      labelTitle.className = "tk-sr-title";
      labelTitle.textContent = "名称";
      this.labelSource = document.createElement("select");
      this.labelSource.className = "tk-sr-mode";
      this.labelSource.title = "选择连接源的显示名称";
      this.labelSource.innerHTML = '<option value="custom">界面节点名</option><option value="original">原始节点名</option>';
      this.labelSource.value = this.settings.labelSource;
      this.labelSource.addEventListener("change", () => {
        this.settings.labelSource = this.labelSource.value === "original" ? "original" : "custom";
        this.commit();
        this.renderRows();
      });
      this.count = document.createElement("span");
      this.count.className = "tk-sr-count";
      header.append(title, this.mode, labelTitle, this.labelSource, this.count);

      const note = document.createElement("div");
      note.className = "tk-sr-note";
      note.textContent = "拖拽 ⠿ 交换输出顺序 · 关闭的接口不会进入输出";
      this.grid = document.createElement("div");
      this.grid.className = "tk-sr-grid";
      container.append(header, note, this.grid);
      this.renderRows();
      return container;
    }

    load() {
      if (this.settingsWidget) this.settings = parseSettings(this.settingsWidget.value);
      if (this.mode) this.mode.value = this.settings.mode;
      if (this.labelSource) this.labelSource.value = this.settings.labelSource;
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
        const originalConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onNodeCreated = function () {
          const result = originalCreated?.apply(this, arguments);
          if (this._tkStringRouterUI) return result;
          const ui = new StringRouterUI(this);
          this._tkStringRouterUI = ui;
          ui.installSettingsWidget();
          const element = ui.build();
          const domWidget = this.addDOMWidget?.("tk_string_router", "custom", element, { serialize: false, hideOnZoom: false });
          if (domWidget) {
            domWidget.computeSize = () => [0, 172];
            this.setSize?.([Math.max(300, this.size?.[0] || 300), 420]);
          }
          return result;
        };
        nodeType.prototype.onConnectionsChange = function () {
          const result = originalConnectionsChange?.apply(this, arguments);
          this._tkStringRouterUI?.refreshConnectionLabels();
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
