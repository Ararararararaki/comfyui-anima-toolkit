// Anima 预设空 Latent 图像：简洁的分辨率快捷预设与本地预设管理。
(function () {
  const NODE_NAME = "AnimaPresetEmptyLatent";
  const STORAGE_KEY = "anima-preset-empty-latent-presets-v1";
  const BUILT_IN_PRESETS = [
    { id: "square", name: "1:1", width: 1024, height: 1024 },
    { id: "landscape", name: "16:9", width: 1536, height: 864 },
    { id: "portrait", name: "9:16", width: 864, height: 1536 },
    { id: "four-three", name: "4:3", width: 1152, height: 864 },
    { id: "three-four", name: "3:4", width: 864, height: 1152 },
  ];

  function loadUserPresets() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(saved)) return [];
      return saved.filter(isValidPreset).map((preset) => ({
        id: String(preset.id || crypto.randomUUID()),
        name: String(preset.name).trim(),
        width: Number(preset.width),
        height: Number(preset.height),
      }));
    } catch {
      return [];
    }
  }

  function saveUserPresets(presets) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  }

  function isValidPreset(preset) {
    const width = Number(preset?.width);
    const height = Number(preset?.height);
    return typeof preset?.name === "string"
      && preset.name.trim().length > 0
      && Number.isInteger(width) && Number.isInteger(height)
      && width >= 16 && height >= 16
      && width % 16 === 0 && height % 16 === 0;
  }

  function newId() {
    return globalThis.crypto?.randomUUID?.() || `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function setWidgetValue(node, widget, value) {
    if (!widget || widget.value === value) return;
    widget.value = value;
    if (typeof widget.callback === "function") widget.callback(value);
    node.graph?.change();
  }

  function ensureStyles() {
    if (document.getElementById("anima-preset-latent-style")) return;
    const style = document.createElement("style");
    style.id = "anima-preset-latent-style";
    style.textContent = `
      .anima-preset-latent { position:relative; z-index:2; pointer-events:auto; display:flex; flex-direction:column; gap:6px; padding:6px; min-width:230px; font-family:Inter,system-ui,sans-serif; }
      .anima-preset-latent-row { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
      .anima-preset-latent button { border:1px solid rgba(255,255,255,.1); border-radius:5px; background:rgba(255,255,255,.05); color:#c8c9cb; cursor:pointer; font-size:10px; line-height:20px; padding:0 7px; transition:.15s ease; }
      .anima-preset-latent button:hover { background:rgba(94,106,210,.2); color:#fff; border-color:rgba(122,134,230,.55); }
      .anima-preset-latent button.is-active { background:#5e6ad2; color:#fff; border-color:#7b83e0; }
      .anima-preset-latent .apl-current { color:#8a8f98; font-size:10px; min-height:14px; }
      .apl-modal-backdrop { position:fixed; inset:0; z-index:100000; display:grid; place-items:center; background:rgba(0,0,0,.58); }
      .apl-modal { width:min(420px,calc(100vw - 32px)); max-height:70vh; overflow:auto; box-sizing:border-box; padding:14px; border:1px solid rgba(255,255,255,.12); border-radius:10px; background:#17171b; color:#e8e8eb; box-shadow:0 18px 55px rgba(0,0,0,.55); font:12px Inter,system-ui,sans-serif; }
      .apl-modal h3 { margin:0 0 10px; font-size:14px; }
      .apl-form, .apl-item { display:grid; grid-template-columns:1fr 72px 72px auto; gap:6px; align-items:center; margin:6px 0; }
      .apl-modal input { min-width:0; box-sizing:border-box; border:1px solid rgba(255,255,255,.13); border-radius:5px; background:#0e0e11; color:#e8e8eb; padding:6px; }
      .apl-modal button { border:1px solid rgba(255,255,255,.12); border-radius:5px; background:rgba(255,255,255,.07); color:#e8e8eb; cursor:pointer; padding:5px 8px; }
      .apl-modal button:hover { background:rgba(94,106,210,.35); }
      .apl-modal .apl-remove:hover { background:rgba(220,70,70,.35); }
      .apl-modal .apl-actions { display:flex; justify-content:flex-end; gap:6px; margin-top:12px; }
      .apl-modal .apl-help { margin:0 0 8px; color:#9da3ae; font-size:11px; }
    `;
    document.head.appendChild(style);
  }

  class PresetLatentUI {
    constructor(node, widthWidget, heightWidget) {
      this.node = node;
      this.widthWidget = widthWidget;
      this.heightWidget = heightWidget;
      this.container = null;
    }

    presets() {
      return [...BUILT_IN_PRESETS, ...loadUserPresets()];
    }

    currentPreset() {
      const width = Number(this.widthWidget?.value);
      const height = Number(this.heightWidget?.value);
      return this.presets().find((preset) => preset.width === width && preset.height === height) || null;
    }

    applyPreset(preset) {
      setWidgetValue(this.node, this.widthWidget, preset.width);
      setWidgetValue(this.node, this.heightWidget, preset.height);
      this.render();
    }

    render() {
      if (!this.container) return;
      const presetRow = this.container.querySelector(".apl-presets");
      const current = this.container.querySelector(".apl-current");
      presetRow.replaceChildren();
      const selected = this.currentPreset();
      for (const preset of this.presets()) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = preset.name;
        button.title = `${preset.name} · ${preset.width}×${preset.height}`;
        button.classList.toggle("is-active", selected?.width === preset.width && selected?.height === preset.height);
        button.onclick = () => this.applyPreset(preset);
        presetRow.appendChild(button);
      }
      const width = Number(this.widthWidget?.value);
      const height = Number(this.heightWidget?.value);
      current.textContent = selected
        ? `${selected.name} · ${width}×${height}`
        : `自定义 · ${width}×${height}`;
    }

    openManager() {
      const backdrop = document.createElement("div");
      backdrop.className = "apl-modal-backdrop";
      const modal = document.createElement("section");
      modal.className = "apl-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.innerHTML = "<h3>管理个人尺寸预设</h3><p class=\"apl-help\">宽高必须是 16 的倍数；内置预设保持只读。</p>";

      const renderRows = () => {
        modal.querySelectorAll(".apl-item").forEach((item) => item.remove());
        const presets = loadUserPresets();
        for (const preset of presets) {
          const row = document.createElement("div");
          row.className = "apl-item";
          const name = document.createElement("input");
          name.value = preset.name;
          name.placeholder = "名称";
          const width = document.createElement("input");
          width.type = "number"; width.min = "16"; width.step = "16"; width.value = String(preset.width);
          const height = document.createElement("input");
          height.type = "number"; height.min = "16"; height.step = "16"; height.value = String(preset.height);
          const remove = document.createElement("button");
          remove.type = "button"; remove.className = "apl-remove"; remove.textContent = "删除";
          const commit = () => {
            const all = loadUserPresets();
            const index = all.findIndex((item) => item.id === preset.id);
            const next = { ...preset, name: name.value.trim(), width: Number(width.value), height: Number(height.value) };
            if (index >= 0 && isValidPreset(next)) { all[index] = next; saveUserPresets(all); this.render(); }
          };
          name.onchange = commit; width.onchange = commit; height.onchange = commit;
          remove.onclick = () => { saveUserPresets(loadUserPresets().filter((item) => item.id !== preset.id)); renderRows(); this.render(); };
          row.append(name, width, height, remove);
          modal.appendChild(row);
        }
      };

      const form = document.createElement("form");
      form.className = "apl-form";
      const currentWidth = Number(this.widthWidget.value);
      const currentHeight = Number(this.heightWidget.value);
      form.innerHTML = `<input name="name" placeholder="例如：角色立绘" required><input name="width" type="number" min="16" step="16" value="${currentWidth}" required><input name="height" type="number" min="16" step="16" value="${currentHeight}" required><button type="submit">新增</button>`;
      form.onsubmit = (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const preset = { id: newId(), name: String(data.get("name") || "").trim(), width: Number(data.get("width")), height: Number(data.get("height")) };
        if (!isValidPreset(preset)) { window.alert("请填写名称，且宽高必须为不小于 16 的 16 倍数。"); return; }
        saveUserPresets([...loadUserPresets(), preset]);
        form.reset();
        form.elements.width.value = String(currentWidth);
        form.elements.height.value = String(currentHeight);
        renderRows(); this.render();
      };
      modal.appendChild(form);
      renderRows();

      const actions = document.createElement("div");
      actions.className = "apl-actions";
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "完成";
      close.onclick = () => backdrop.remove();
      actions.appendChild(close);
      modal.appendChild(actions);
      backdrop.appendChild(modal);
      backdrop.onclick = (event) => { if (event.target === backdrop) backdrop.remove(); };
      document.body.appendChild(backdrop);
      modal.querySelector("input[name=name]")?.focus();
    }

    build() {
      ensureStyles();
      const container = document.createElement("div");
      container.className = "anima-preset-latent";
      const presets = document.createElement("div");
      presets.className = "anima-preset-latent-row apl-presets";
      const current = document.createElement("div");
      current.className = "apl-current";
      container.append(presets, current);
      // 新版 ComfyUI 的节点容器会把指针事件当作拖拽；控件区域必须截获它们。
      for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu"]) {
        container.addEventListener(eventName, (event) => event.stopPropagation());
      }
      this.container = container;
      this.render();

      for (const widget of [this.widthWidget, this.heightWidget]) {
        const original = widget.callback;
        widget.callback = (...args) => {
          const result = typeof original === "function" ? original.apply(widget, args) : undefined;
          this.render();
          return result;
        };
      }
      return container;
    }
  }

  function init() {
    const app = window.comfyAPI?.app?.app;
    if (!app?.registerExtension) return setTimeout(init, 500);
    app.registerExtension({
      name: "Anima.PresetEmptyLatent.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const original = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
          const result = original?.apply(this, arguments);
          const widthWidget = this.widgets?.find((widget) => widget.name === "width");
          const heightWidget = this.widgets?.find((widget) => widget.name === "height");
          if (!widthWidget || !heightWidget) return result;
          const ui = new PresetLatentUI(this, widthWidget, heightWidget);
          this._animaPresetLatentUI = ui;
          const element = ui.build();
          // 采用 ComfyUI 原生 button widget：新版画布可稳定接收点击，不会被节点拖拽层截获。
          this.addWidget?.("button", "管理预设", null, () => ui.openManager(), { serialize: false });
          if (typeof this.addDOMWidget === "function") this.addDOMWidget("anima_resolution_presets", "custom", element, { serialize: false });
          // 工作流的 widget 值在节点创建后才恢复；配置完成后重绘选中态。
          const originalConfigure = this.onConfigure;
          this.onConfigure = function () {
            const configured = typeof originalConfigure === "function" ? originalConfigure.apply(this, arguments) : undefined;
            requestAnimationFrame(() => this._animaPresetLatentUI?.render());
            return configured;
          };
          this.setSize?.(this.size || [250, 180]);
          return result;
        };
      },
    });
  }

  init();
})();
