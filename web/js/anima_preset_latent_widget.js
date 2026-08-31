// Anima 空 Latent 图像：简洁的分辨率缩放与常用比例快捷选择。
(function () {
  const NODE_NAME = "AnimaPresetEmptyLatent";
  const RESOLUTION_MULTIPLE = 16;
  const STANDARD_LONG_EDGE = 1536;
  const RATIO_DEFINITIONS = [
    { id: "1:1", label: "1:1", width: 1, height: 1, description: "正方形" },
    { id: "4:3", label: "4:3", width: 4, height: 3, description: "横向标准" },
    { id: "3:4", label: "3:4", width: 3, height: 4, description: "竖向标准" },
    { id: "3:2", label: "3:2", width: 3, height: 2, description: "横向照片" },
    { id: "2:3", label: "2:3", width: 2, height: 3, description: "竖向照片" },
    { id: "16:9", label: "16:9", width: 16, height: 9, description: "宽屏" },
    { id: "9:16", label: "9:16", width: 9, height: 16, description: "竖屏" },
    { id: "21:9", label: "21:9", width: 21, height: 9, description: "超宽屏" },
    { id: "9:21", label: "9:21", width: 9, height: 21, description: "超长竖屏" },
    { id: "5:4", label: "5:4", width: 5, height: 4, description: "接近方形横向" },
    { id: "4:5", label: "4:5", width: 4, height: 5, description: "接近方形竖向" },
    { id: "2:1", label: "2:1", width: 2, height: 1, description: "全景横向" },
    { id: "1:2", label: "1:2", width: 1, height: 2, description: "全景竖向" },
  ];
  const RATIO_SCALE_OPTIONS = [0.5, 0.75, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 2];

  function snapResolution(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return RESOLUTION_MULTIPLE;
    return Math.max(RESOLUTION_MULTIPLE, Math.round(numeric / RESOLUTION_MULTIPLE) * RESOLUTION_MULTIPLE);
  }

  function calculateRatioResolution(longEdge = STANDARD_LONG_EDGE, ratioWidth, ratioHeight, edgeScale = 1) {
    const targetLongEdge = Math.max(RESOLUTION_MULTIPLE, Number(longEdge) * Math.max(0.01, Number(edgeScale) || 1));
    const ratio = Number(ratioWidth) / Number(ratioHeight);
    const rawWidth = ratio >= 1 ? targetLongEdge : targetLongEdge * ratio;
    const rawHeight = ratio >= 1 ? targetLongEdge / ratio : targetLongEdge;
    return { width: snapResolution(rawWidth), height: snapResolution(rawHeight) };
  }

  function longEdgeScaleOf(width, height) {
    const currentLongEdge = Math.max(Number(width) || 0, Number(height) || 0);
    return currentLongEdge / STANDARD_LONG_EDGE;
  }

  function formatScale(value) {
    return `×${Number(value).toFixed(2)}`;
  }

  function normalizeWidgetResolution(widget, value) {
    const options = widget?.options || {};
    const minimum = snapResolution(Number.isFinite(Number(options.min)) ? Number(options.min) : RESOLUTION_MULTIPLE);
    const maximumRaw = Number.isFinite(Number(options.max)) ? Number(options.max) : Number.POSITIVE_INFINITY;
    const maximum = Number.isFinite(maximumRaw)
      ? Math.max(minimum, Math.floor(maximumRaw / RESOLUTION_MULTIPLE) * RESOLUTION_MULTIPLE)
      : Number.POSITIVE_INFINITY;
    return Math.min(maximum, Math.max(minimum, snapResolution(value)));
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
      .anima-preset-latent { position:relative; z-index:2; pointer-events:auto; display:flex; flex-direction:column; gap:4px; padding:5px; min-width:210px; font-family:Inter,system-ui,sans-serif; }
      .anima-preset-latent-row { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
      .anima-preset-latent button { border:1px solid rgba(255,255,255,.1); border-radius:5px; background:rgba(255,255,255,.05); color:#c8c9cb; cursor:pointer; font-size:10px; line-height:20px; padding:0 7px; transition:.15s ease; }
      .anima-preset-latent button:hover { background:rgba(94,106,210,.2); color:#fff; border-color:rgba(122,134,230,.55); }
      .anima-preset-latent button.is-active { background:#5e6ad2; color:#fff; border-color:#7b83e0; }
      .anima-preset-latent .apl-control-row { justify-content:flex-end; }
      .anima-preset-latent .apl-control-label { margin-right:auto; color:#8a8f98; font-size:10px; }
      .anima-preset-latent .apl-scale-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:3px; }
      .anima-preset-latent .apl-scale-list { display:flex; flex-direction:column; gap:2px; min-width:0; }
      .anima-preset-latent .apl-scale-option { display:flex; align-items:center; justify-content:space-between; width:100%; min-height:22px; box-sizing:border-box; padding:0 7px; font-variant-numeric:tabular-nums; }
      .anima-preset-latent .apl-scale-option .apl-scale-factor { min-width:36px; font-weight:600; }
      .anima-preset-latent .apl-scale-option .apl-scale-resolution { color:#a9a5d9; font-size:10px; }
      .anima-preset-latent .apl-scale-option:hover .apl-scale-resolution { color:#fff; }
      .anima-preset-latent .apl-current { display:flex; justify-content:space-between; gap:8px; color:#8a8f98; font-size:10px; line-height:14px; min-height:14px; white-space:nowrap; }
      .anima-preset-latent .apl-current-main { color:#c8c9cb; }
      .anima-preset-latent .apl-ratio-trigger { display:inline-flex; align-items:center; gap:4px; margin-left:auto; }
      .anima-preset-latent .apl-ratio-trigger .apl-chevron { color:#8a8f98; font-size:9px; }
      .apl-ratio-menu { position:fixed; z-index:100010; min-width:176px; padding:5px; border:1px solid rgba(255,255,255,.13); border-radius:8px; background:linear-gradient(180deg,#24252a,#151619); color:#e8e8eb; box-shadow:0 0 0 1px rgba(255,255,255,.035),0 16px 38px rgba(0,0,0,.62),inset 0 1px rgba(255,255,255,.05); font:12px Inter,system-ui,sans-serif; }
      .apl-ratio-row { position:relative; }
      .apl-ratio-row > .apl-ratio-row-button { display:flex; align-items:center; width:100%; min-height:27px; box-sizing:border-box; border:0; border-radius:5px; background:transparent; color:#c8c9cb; text-align:left; }
      .apl-ratio-row > .apl-ratio-row-button:hover, .apl-ratio-row.is-open > .apl-ratio-row-button { background:#373342; color:#fff; }
      .apl-ratio-row-button .apl-ratio-name { font-weight:600; min-width:42px; }
      .apl-ratio-row-button .apl-ratio-description { color:#8f919a; font-size:10px; }
      .apl-ratio-row-button .apl-ratio-arrow { margin-left:auto; color:#85818e; }
      .apl-ratio-submenu { position:absolute; top:-5px; left:calc(100% + 6px); display:none; min-width:218px; padding:5px; border:1px solid rgba(255,255,255,.13); border-radius:8px; background:#1b1c20; box-shadow:0 14px 34px rgba(0,0,0,.62); }
      .apl-ratio-row.is-open > .apl-ratio-submenu { display:block; }
      .apl-ratio-row.opens-left > .apl-ratio-submenu { right:calc(100% + 6px); left:auto; }
      .apl-ratio-option { display:flex !important; align-items:center; justify-content:space-between; width:100%; min-height:28px; box-sizing:border-box; border:0 !important; border-radius:5px !important; background:transparent !important; color:#c8c9cb !important; text-align:left; }
      .apl-ratio-option:hover, .apl-ratio-option:focus-visible { background:#373342 !important; color:#fff !important; outline:none; }
      .apl-ratio-option .apl-resolution { font-variant-numeric:tabular-nums; }
      .apl-ratio-option .apl-multiplier { margin-left:12px; color:#a9a5d9; font-size:10px; font-variant-numeric:tabular-nums; }
      .apl-ratio-menu .apl-menu-caption { padding:3px 7px 5px; color:#8f919a; font-size:10px; border-bottom:1px solid rgba(255,255,255,.08); margin-bottom:3px; }
    `;
    document.head.appendChild(style);
  }

  class PresetLatentUI {
    constructor(node, widthWidget, heightWidget) {
      this.node = node;
      this.widthWidget = widthWidget;
      this.heightWidget = heightWidget;
      this.container = null;
      this.ratioMenu = null;
      this.ratioCloseTimer = 0;
      this.ratioTrigger = null;
    }

    currentResolution() {
      return {
        width: snapResolution(this.widthWidget?.value),
        height: snapResolution(this.heightWidget?.value),
      };
    }

    currentRatio() {
      const { width, height } = this.currentResolution();
      const current = width / Math.max(1, height);
      return RATIO_DEFINITIONS.find((ratio) => Math.abs(current - ratio.width / ratio.height) < 0.015) || null;
    }

    applyScale(factor) {
      const current = this.currentResolution();
      setWidgetValue(this.node, this.widthWidget, normalizeWidgetResolution(this.widthWidget, current.width * factor));
      setWidgetValue(this.node, this.heightWidget, normalizeWidgetResolution(this.heightWidget, current.height * factor));
      this.render();
      this.refreshRatioMenu();
    }

    applyRatio(ratio, edgeScale) {
      const next = calculateRatioResolution(STANDARD_LONG_EDGE, ratio.width, ratio.height, edgeScale);
      setWidgetValue(this.node, this.widthWidget, normalizeWidgetResolution(this.widthWidget, next.width));
      setWidgetValue(this.node, this.heightWidget, normalizeWidgetResolution(this.heightWidget, next.height));
      this.closeRatioMenu();
      this.render();
    }

    scheduleRatioMenuClose() {
      clearTimeout(this.ratioCloseTimer);
      this.ratioCloseTimer = window.setTimeout(() => {
        if (!this.ratioMenu?.matches(":hover") && !this.ratioTrigger?.matches(":hover")) this.closeRatioMenu();
      }, 220);
    }

    positionRatioMenu() {
      if (!this.ratioMenu || !this.ratioTrigger) return;
      const triggerRect = this.ratioTrigger.getBoundingClientRect();
      const menuRect = this.ratioMenu.getBoundingClientRect();
      const gap = 5;
      let left = triggerRect.left;
      let top = triggerRect.bottom + gap;
      if (left + menuRect.width > window.innerWidth - 8) left = Math.max(8, triggerRect.right - menuRect.width);
      if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, triggerRect.top - menuRect.height - gap);
      this.ratioMenu.style.left = `${Math.round(left)}px`;
      this.ratioMenu.style.top = `${Math.round(top)}px`;
    }

    renderRatioMenu() {
      if (!this.ratioMenu) return;
      this.ratioMenu.replaceChildren();
      const caption = document.createElement("div");
      caption.className = "apl-menu-caption";
      caption.textContent = `标准长边 ${STANDARD_LONG_EDGE}px · 比例倍率`;
      this.ratioMenu.appendChild(caption);
      for (const ratio of RATIO_DEFINITIONS) {
        const row = document.createElement("div");
        row.className = "apl-ratio-row";
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "apl-ratio-row-button";
        trigger.setAttribute("role", "menuitem");
        const name = document.createElement("span");
        name.className = "apl-ratio-name";
        name.textContent = ratio.label;
        const description = document.createElement("span");
        description.className = "apl-ratio-description";
        description.textContent = ratio.description;
        const arrow = document.createElement("span");
        arrow.className = "apl-ratio-arrow";
        arrow.textContent = "›";
        trigger.append(name, description, arrow);

        const submenu = document.createElement("div");
        submenu.className = "apl-ratio-submenu";
        submenu.setAttribute("role", "menu");
        for (const edgeScale of RATIO_SCALE_OPTIONS) {
          const resolution = calculateRatioResolution(STANDARD_LONG_EDGE, ratio.width, ratio.height, edgeScale);
          const option = document.createElement("button");
          option.type = "button";
          option.className = "apl-ratio-option";
          option.setAttribute("role", "menuitem");
          const resolutionLabel = document.createElement("span");
          resolutionLabel.className = "apl-resolution";
          resolutionLabel.textContent = `${resolution.width} × ${resolution.height}`;
          const multiplier = document.createElement("span");
          multiplier.className = "apl-multiplier";
          multiplier.textContent = formatScale(edgeScale);
          option.append(resolutionLabel, multiplier);
          option.title = `${ratio.label} · ${resolution.width}×${resolution.height} · 标准长边 ${formatScale(edgeScale)}`;
          option.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.applyRatio(ratio, edgeScale);
          });
          submenu.appendChild(option);
        }

        const openRow = () => {
          this.ratioMenu.querySelectorAll(".apl-ratio-row.is-open").forEach((other) => {
            if (other !== row) other.classList.remove("is-open", "opens-left");
          });
          row.classList.add("is-open");
          requestAnimationFrame(() => {
            const rect = submenu.getBoundingClientRect();
            row.classList.toggle("opens-left", rect.right > window.innerWidth - 8);
          });
        };
        trigger.addEventListener("mouseenter", openRow);
        trigger.addEventListener("focus", openRow);
        trigger.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openRow();
        });
        row.append(trigger, submenu);
        this.ratioMenu.appendChild(row);
      }
      this.positionRatioMenu();
    }

    refreshRatioMenu() {
      if (!this.ratioMenu) return;
      this.renderRatioMenu();
    }

    openRatioMenu() {
      clearTimeout(this.ratioCloseTimer);
      if (this.ratioMenu) return;
      const menu = document.createElement("div");
      menu.className = "apl-ratio-menu";
      menu.setAttribute("role", "menu");
      this.ratioMenu = menu;
      document.body.appendChild(menu);
      this.renderRatioMenu();
      menu.addEventListener("mouseenter", () => clearTimeout(this.ratioCloseTimer));
      menu.addEventListener("mouseleave", () => this.scheduleRatioMenuClose());
      this.handleRatioOutsidePointer = (event) => {
        if (!menu.contains(event.target) && !this.ratioTrigger?.contains(event.target)) this.closeRatioMenu();
      };
      this.handleRatioViewportChange = () => this.closeRatioMenu();
      document.addEventListener("pointerdown", this.handleRatioOutsidePointer, true);
      window.addEventListener("resize", this.handleRatioViewportChange, { once: true });
      window.addEventListener("scroll", this.handleRatioViewportChange, { capture: true, once: true });
      this.ratioTrigger?.classList.add("is-open");
      this.ratioTrigger?.setAttribute("aria-expanded", "true");
    }

    closeRatioMenu() {
      clearTimeout(this.ratioCloseTimer);
      if (!this.ratioMenu) return;
      this.ratioMenu.remove();
      this.ratioMenu = null;
      document.removeEventListener("pointerdown", this.handleRatioOutsidePointer, true);
      window.removeEventListener("resize", this.handleRatioViewportChange);
      window.removeEventListener("scroll", this.handleRatioViewportChange, true);
      this.ratioTrigger?.classList.remove("is-open");
      this.ratioTrigger?.setAttribute("aria-expanded", "false");
    }

    build() {
      ensureStyles();
      const container = document.createElement("div");
      container.className = "anima-preset-latent";
      const controlRow = document.createElement("div");
      controlRow.className = "anima-preset-latent-row apl-control-row";
      const scaleLabel = document.createElement("span");
      scaleLabel.className = "apl-control-label";
      scaleLabel.textContent = "缩放倍率";
      controlRow.appendChild(scaleLabel);
      const ratioTrigger = document.createElement("button");
      ratioTrigger.type = "button";
      ratioTrigger.className = "apl-ratio-trigger";
      ratioTrigger.setAttribute("aria-haspopup", "menu");
      ratioTrigger.setAttribute("aria-expanded", "false");
      this.ratioTrigger = ratioTrigger;
      ratioTrigger.addEventListener("mouseenter", () => this.openRatioMenu());
      ratioTrigger.addEventListener("mouseleave", () => this.scheduleRatioMenuClose());
      ratioTrigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.ratioMenu) this.closeRatioMenu();
        else this.openRatioMenu();
      });
      ratioTrigger.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
          event.preventDefault();
          this.openRatioMenu();
          requestAnimationFrame(() => this.ratioMenu?.querySelector(".apl-ratio-row-button")?.focus());
        }
      });
      controlRow.appendChild(ratioTrigger);
      const scaleColumns = document.createElement("div");
      scaleColumns.className = "apl-scale-columns";
      for (const [side, factors] of [["down", [0.5, 0.6, 0.7, 0.8, 0.9]], ["up", [1.1, 1.2, 1.3, 1.4, 1.5]]]) {
        const scaleList = document.createElement("div");
        scaleList.className = "apl-scale-list";
        scaleList.dataset.side = side;
        for (const factor of factors) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "apl-scale-option";
          const factorLabel = document.createElement("span");
          factorLabel.className = "apl-scale-factor";
          factorLabel.textContent = `×${factor}`;
          const resolutionLabel = document.createElement("span");
          resolutionLabel.className = "apl-scale-resolution";
          button.append(factorLabel, resolutionLabel);
          button.dataset.factor = String(factor);
          button.dataset.side = side;
          button.title = `宽高同时乘以 ${factor}`;
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.applyScale(factor);
          });
          scaleList.appendChild(button);
        }
        scaleColumns.appendChild(scaleList);
      }
      const current = document.createElement("div");
      current.className = "apl-current";
      const currentMain = document.createElement("span");
      currentMain.className = "apl-current-main";
      const currentScale = document.createElement("span");
      currentScale.className = "apl-current-scale";
      current.append(currentMain, currentScale);
      container.append(controlRow, scaleColumns, current);
      // 新版 ComfyUI 的节点容器会把指针事件当作拖拽；控件区域必须截获它们。
      for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "wheel"]) {
        container.addEventListener(eventName, (event) => event.stopPropagation());
      }
      this.container = container;
      this.render();

      for (const widget of [this.widthWidget, this.heightWidget]) {
        const original = widget.callback;
        widget.callback = (...args) => {
          const result = typeof original === "function" ? original.apply(widget, args) : undefined;
          this.render();
          this.refreshRatioMenu();
          return result;
        };
      }
      return container;
    }

    render() {
      if (!this.container) return;
      const currentMain = this.container.querySelector(".apl-current-main");
      const currentScale = this.container.querySelector(".apl-current-scale");
      const ratioTrigger = this.container.querySelector(".apl-ratio-trigger");
      const scaleOptions = [...this.container.querySelectorAll(".apl-scale-option")];
      if (!currentMain || !currentScale || !ratioTrigger) return;
      const current = this.currentResolution();
      const ratio = this.currentRatio();
      currentMain.textContent = `当前 ${current.width}×${current.height}`;
      currentScale.textContent = `标准长边 ${STANDARD_LONG_EDGE} · ${formatScale(longEdgeScaleOf(current.width, current.height))}`;
      for (const button of scaleOptions) {
        const factor = Number(button.dataset.factor);
        const width = normalizeWidgetResolution(this.widthWidget, current.width * factor);
        const height = normalizeWidgetResolution(this.heightWidget, current.height * factor);
        const resolution = button.querySelector(".apl-scale-resolution");
        if (resolution) resolution.textContent = `${width} × ${height}`;
        button.title = `宽高同时乘以 ${factor}：${width}×${height}`;
      }
      ratioTrigger.replaceChildren();
      const ratioLabel = document.createElement("span");
      ratioLabel.textContent = ratio ? `比例 ${ratio.label}` : "比例 自定义";
      const chevron = document.createElement("span");
      chevron.className = "apl-chevron";
      chevron.textContent = "▾";
      ratioTrigger.append(ratioLabel, chevron);
      ratioTrigger.setAttribute("aria-label", ratio ? `选择比例，当前 ${ratio.label}` : "选择自定义比例");
    }

    destroy() {
      this.closeRatioMenu();
      this.container?.remove();
      this.container = null;
      this.ratioTrigger = null;
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
          if (typeof this.addDOMWidget === "function") this.addDOMWidget("anima_resolution_presets", "custom", element, { serialize: false });
          // 工作流的 widget 值在节点创建后才恢复；配置完成后重绘选中态。
          const originalConfigure = this.onConfigure;
          this.onConfigure = function () {
            const configured = typeof originalConfigure === "function" ? originalConfigure.apply(this, arguments) : undefined;
            requestAnimationFrame(() => this._animaPresetLatentUI?.render());
            return configured;
          };
          const originalRemoved = this.onRemoved;
          this.onRemoved = function () {
            this._animaPresetLatentUI?.destroy();
            this._animaPresetLatentUI = null;
            return originalRemoved?.apply(this, arguments);
          };
          this.setSize?.(this.size || [250, 180]);
          return result;
        };
      },
    });
  }

  init();
})();
