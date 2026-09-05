import { installDOMWidgetSizeSync } from "./anima_dom_widget_size_sync.js";
import {
  getClothingCard,
  getClothingCardPreview,
  getClothingCards,
  getClothingCategories,
  libraryErrorMessage,
  makeSelectionCard,
  renameClothingCard,
  stablePick,
} from "./anima_clothing_library_adapter.js";

(function () {
  "use strict";

  const NODE_NAME = "AnimaClothingDraw";
  const MODES = new Set(["随机抽取", "手动选择"]);
  const SCOPE_ALL = "";
  const SCOPE_FAVORITE = "__favorite__";
  const CSS_ID = "tk-clothing-draw-style";
  // Bump when the standalone picker stylesheet changes.  ComfyUI serves
  // extension assets from stable URLs, and Chrome can otherwise keep an old
  // picker layout in its document cache after a node update.
  const CSS_VERSION = "20260903-2";

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

  const safeJson = (value, fallback = {}) => {
    try {
      const parsed = JSON.parse(value || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  const randomSeed = () => {
    try {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      return Number(bytes[0]);
    } catch {
      return Math.floor(Math.random() * 0xffffffff);
    }
  };

  function injectStylesheet() {
    if (document.getElementById(CSS_ID)) return;
    const link = document.createElement("link");
    link.id = CSS_ID;
    link.rel = "stylesheet";
    link.href = `/extensions/ComfyUI-Anima-Batch-LoRA/css/anima_clothing_draw.css?v=${CSS_VERSION}`;
    document.head.appendChild(link);
  }

  function stopCanvasEvent(event) {
    event.stopPropagation();
  }

  // LiteGraph listens on the surrounding canvas/document for pointer events.
  // A DOM widget must shield its whole interactive surface, not only buttons
  // and inputs, otherwise clicking preview/text areas can open a node value
  // editor or start dragging the node in Chrome.
  const CANVAS_EVENT_TYPES = [
    "pointerdown", "pointerup", "pointermove", "pointercancel",
    "mousedown", "mouseup", "mousemove", "click", "dblclick",
    "auxclick", "contextmenu", "touchstart", "touchend", "touchmove",
    "wheel", "keydown", "keyup", "dragstart",
  ];

  function shieldCanvasInteractions(element, { keyboard = true } = {}) {
    if (!element) return;
    const eventTypes = keyboard
      ? CANVAS_EVENT_TYPES
      : CANVAS_EVENT_TYPES.filter((type) => type !== "keydown" && type !== "keyup");
    eventTypes.forEach((type) => {
      element.addEventListener(type, stopCanvasEvent, type === "wheel" ? { passive: true } : undefined);
    });
  }

  function nativeWidget(node, name) {
    return node.widgets?.find((widget) => widget?.name === name) || null;
  }

  class ClothingDrawUI {
    constructor(node, modeWidget, seedWidget, selectionWidget) {
      this.node = node;
      this.modeWidget = modeWidget;
      this.seedWidget = seedWidget;
      this.selectionWidget = selectionWidget;
      this.root = null;
      this.categorySelect = null;
      this.previewImg = null;
      this.previewPlaceholder = null;
      this.nameEl = null;
      this.categoryEl = null;
      this.promptEl = null;
      this.statusEl = null;
      this.renameBtn = null;
      this.cards = [];
      this.allCards = [];
      this.categories = [];
      this.selected = null;
      this.scope = SCOPE_ALL;
      this.scopeName = "全部";
      this.mode = "随机抽取";
      this.disposed = false;
      this.previewUrl = null;
      this.previewUrlRevocable = false;
      this.loadSeq = 0;
      this.picker = null;
      this._originalModeCallback = modeWidget?.callback;
      this._originalSeedCallback = seedWidget?.callback;
    }

    build() {
      const root = document.createElement("div");
      root.className = "tk-clothing-draw";
      root.innerHTML = `
        <div class="tk-clothing-draw-head">
          <span class="tk-clothing-draw-title">服装抽卡</span>
          <span class="tk-clothing-draw-state" data-role="state">正在连接服装库…</span>
        </div>
        <div class="tk-clothing-draw-controls">
          <label class="tk-clothing-draw-field">
            <span>范围</span>
            <select data-role="scope" aria-label="服装抽卡范围"></select>
          </label>
          <button type="button" class="tk-clothing-draw-button" data-action="refresh" title="重新读取 TK Toolkit 服装库">刷新库</button>
        </div>
        <div class="tk-clothing-draw-preview" data-role="preview">
          <div class="tk-clothing-draw-placeholder" data-role="placeholder">暂无服装</div>
          <img data-role="image" alt="服装预览" draggable="false">
          <div class="tk-clothing-draw-badge" data-role="badge"></div>
        </div>
        <div class="tk-clothing-draw-cardline">
          <div class="tk-clothing-draw-name" data-role="name">尚未选择服装</div>
          <div class="tk-clothing-draw-category" data-role="category"></div>
        </div>
        <textarea class="tk-clothing-draw-prompt" data-role="prompt" readonly spellcheck="false" placeholder="抽取或选择后显示服装提示词"></textarea>
        <div class="tk-clothing-draw-actions">
          <button type="button" class="tk-clothing-draw-button primary" data-action="draw">随机抽取</button>
          <button type="button" class="tk-clothing-draw-button" data-action="choose">选择服装</button>
          <button type="button" class="tk-clothing-draw-button" data-action="rename" disabled>重命名</button>
        </div>
        <div class="tk-clothing-draw-hint" data-role="hint">图片只用于节点预览，输出为服装提示词和卡片数据。</div>
      `;
      this.root = root;
      this.categorySelect = root.querySelector('[data-role="scope"]');
      this.previewImg = root.querySelector('[data-role="image"]');
      this.previewPlaceholder = root.querySelector('[data-role="placeholder"]');
      this.nameEl = root.querySelector('[data-role="name"]');
      this.categoryEl = root.querySelector('[data-role="category"]');
      this.promptEl = root.querySelector('[data-role="prompt"]');
      this.statusEl = root.querySelector('[data-role="state"]');
      this.renameBtn = root.querySelector('[data-action="rename"]');

      shieldCanvasInteractions(root);
      root.querySelectorAll("button, input, select, textarea").forEach((element) => {
        element.addEventListener("pointerdown", stopCanvasEvent);
        element.addEventListener("mousedown", stopCanvasEvent);
        element.addEventListener("click", stopCanvasEvent);
      });
      this.categorySelect.addEventListener("change", () => this.setScope(this.categorySelect.value));
      root.querySelector('[data-action="refresh"]').addEventListener("click", () => this.refreshLibrary());
      root.querySelector('[data-action="draw"]').addEventListener("click", () => this.drawRandom(true));
      root.querySelector('[data-action="choose"]').addEventListener("click", () => this.openPicker());
      this.renameBtn.addEventListener("click", () => this.renameSelected());
      this.restorePayload();
      this.updateView();
      return root;
    }

    mount(domWidget) {
      this.domWidget = domWidget;
      this.domSizeSync = installDOMWidgetSizeSync({
        node: this.node,
        domWidget,
        element: this.root,
        minHeight: 300,
        maxHeight: 1000,
        initialContentHeight: 330,
        nodeChromeHeight: 70,
      });
      this.bindNativeWidgets();
      setTimeout(() => this.initialize(), 0);
    }

    bindNativeWidgets() {
      if (this.modeWidget) {
        this.modeWidget.callback = (value) => {
          this._originalModeCallback?.call(this.node, value);
          this.onModeChanged(value);
        };
      }
      if (this.seedWidget) {
        this.seedWidget.callback = (value) => {
          this._originalSeedCallback?.call(this.node, value);
          this.onSeedChanged(value);
        };
      }
    }

    restorePayload() {
      const payload = safeJson(this.selectionWidget?.value, {});
      const payloadMode = MODES.has(payload.mode) ? payload.mode : null;
      this.mode = payloadMode || (MODES.has(this.modeWidget?.value) ? this.modeWidget.value : "随机抽取");
      this.scope = String(payload.scope ?? payload.categoryId ?? "");
      this.scopeName = String(payload.categoryName || (this.scope === SCOPE_FAVORITE ? "收藏" : "全部"));
      this.selected = payload.selected && typeof payload.selected === "object" ? payload.selected : null;
      if (this.modeWidget && MODES.has(this.mode)) this.modeWidget.value = this.mode;
    }

    async initialize() {
      if (this.disposed) return;
      await this.refreshLibrary();
    }

    async refreshLibrary() {
      const seq = ++this.loadSeq;
      this.setStatus("正在读取服装库…", "loading");
      try {
        const [categories, allCards] = await Promise.all([
          getClothingCategories(),
          getClothingCards({}),
        ]);
        if (this.disposed || seq !== this.loadSeq) return;
        this.categories = categories;
        this.allCards = allCards;
        this.cards = allCards.filter((card) => {
          if (this.scope === SCOPE_FAVORITE) return card.favorite;
          return !this.scope || card.categoryId === this.scope;
        });
        this.renderScopeOptions();
        if (this.mode === "随机抽取") {
          this.resolveRandomSelection(false);
        } else {
          // Keep a manually selected snapshot even if the source card was
          // removed later; a library refresh only replaces it when a live
          // card with the same id is available.
          const live = this.selected && allCards.find((card) => card.id === this.selected.id);
          if (live) this.selected = makeSelectionCard(live, live.categoryName);
          this.writePayload();
          this.updateView();
        }
        this.setStatus(
          this.cards.length ? `已读取 ${this.cards.length} 张` : `${this.scopeName}中没有可用的服装卡片`,
          this.cards.length ? "ready" : "error",
        );
      } catch (error) {
        if (this.disposed || seq !== this.loadSeq) return;
        this.cards = [];
        this.allCards = [];
        this.renderScopeOptions();
        this.setStatus(libraryErrorMessage(error), "error");
        this.updateView();
      }
    }

    scopeOptions() {
      if (this.scope === SCOPE_FAVORITE) return { favorite: true };
      return this.scope ? { categoryId: this.scope } : {};
    }

    renderScopeOptions() {
      if (!this.categorySelect) return;
      const allCards = this.allCards;
      const current = this.scope;
      const favoriteCount = allCards.filter((card) => card.favorite).length;
      const categories = this.categories.map((category) => {
        const count = allCards.filter((card) => card.categoryId === category.id).length;
        return `<option value="${esc(category.id)}">${esc(category.name)} (${count})</option>`;
      }).join("");
      this.categorySelect.innerHTML = `<option value="">全部 (${allCards.length})</option><option value="${SCOPE_FAVORITE}">收藏 (${favoriteCount})</option>${categories}`;
      this.categorySelect.value = [...this.categorySelect.options].some((option) => option.value === current) ? current : "";
      if (this.categorySelect.value !== current) {
        this.scope = this.categorySelect.value;
        this.scopeName = this.scope === SCOPE_FAVORITE ? "收藏" : "全部";
      }
    }

    async setScope(scope) {
      this.scope = String(scope || "");
      const option = [...(this.categorySelect?.options || [])].find((item) => item.value === this.scope);
      this.scopeName = option ? option.textContent.replace(/\s*\(\d+\)$/, "") : (this.scope === SCOPE_FAVORITE ? "收藏" : "全部");
      await this.refreshLibrary();
    }

    onModeChanged(value) {
      this.mode = MODES.has(value) ? value : "随机抽取";
      if (this.mode === "随机抽取") this.refreshLibrary();
      else {
        this.writePayload();
        this.updateView();
      }
    }

    onSeedChanged(value) {
      if (this.mode !== "随机抽取") return;
      this.resolveRandomSelection(false, Number(value) || 0);
    }

    currentSeed(override) {
      const value = Number(override ?? this.seedWidget?.value ?? 0);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    }

    setSeed(value) {
      if (!this.seedWidget) return;
      const next = Math.max(0, Math.min(2 ** 63 - 1, Math.floor(Number(value) || 0)));
      this.seedWidget.value = next;
      this.seedWidget.callback?.(next);
    }

    resolveRandomSelection(changeSeed, seedOverride) {
      if (changeSeed) this.setSeed(randomSeed());
      const seed = this.currentSeed(seedOverride);
      const pool = this.cards.map((card) => makeSelectionCard(card, card.categoryName)).filter(Boolean);
      this.selected = stablePick(pool, seed);
      this.writePayload(pool, seed);
      this.updateView();
      if (!this.selected) this.setStatus(`${this.scopeName}中没有可用的服装卡片`, "error");
    }

    async drawRandom(changeSeed) {
      // The action is an explicit mode switch as well as a draw.  This keeps
      // a manual selection from remaining the execution source after the user
      // clicks the visible "随机抽取" button.
      this.mode = "随机抽取";
      if (this.modeWidget) this.modeWidget.value = this.mode;
      if (changeSeed) this.setSeed(randomSeed());
      if (!this.cards.length) {
        await this.refreshLibrary();
        if (!this.cards.length) return;
      }
      this.resolveRandomSelection(false);
    }

    writePayload(pool = null, seedOverride) {
      if (!this.selectionWidget) return;
      const seed = this.currentSeed(seedOverride);
      const selected = this.selected ? makeSelectionCard(this.selected, this.selected.categoryName) : null;
      const payload = {
        version: 1,
        mode: this.mode,
        scope: this.scope,
        categoryId: this.scope && this.scope !== SCOPE_FAVORITE ? this.scope : "",
        categoryName: this.scopeName,
        seed,
        selected,
        pool: this.mode === "随机抽取" ? (pool || this.cards.map((card) => makeSelectionCard(card, card.categoryName)).filter(Boolean)) : [],
      };
      const value = JSON.stringify(payload);
      this.selectionWidget.value = value;
      this.selectionWidget.callback?.(value);
      this.node.graph?.setDirtyCanvas?.(true, true);
    }

    async selectCard(card) {
      if (!card) return;
      this.mode = "手动选择";
      if (this.modeWidget) {
        this.modeWidget.value = this.mode;
        this.modeWidget.callback?.(this.mode);
      }
      this.scope = card.categoryId || SCOPE_ALL;
      this.scopeName = card.categoryName || "未分类";
      if (this.categorySelect && [...this.categorySelect.options].some((option) => option.value === this.scope)) {
        this.categorySelect.value = this.scope;
      }
      this.cards = this.allCards.filter((item) => {
        if (this.scope === SCOPE_FAVORITE) return item.favorite;
        return !this.scope || item.categoryId === this.scope;
      });
      this.selected = makeSelectionCard(card, this.scopeName);
      this.writePayload();
      this.updateView();
      this.closePicker();
    }

    async renameSelected() {
      if (!this.selected?.id) return;
      const current = this.selected.name || "";
      const next = window.prompt("输入新的服装名称", current);
      if (next == null || !String(next).trim() || String(next).trim() === current) return;
      try {
        const updated = await renameClothingCard(this.selected.id, String(next).trim());
        this.selected = makeSelectionCard(updated, this.selected.categoryName);
        this.writePayload();
        this.updateView();
        if (this.picker) await this.renderPicker();
      } catch (error) {
        this.setStatus(libraryErrorMessage(error), "error");
      }
    }

    applyExecutionResult(message) {
      const output = message?.output && typeof message.output === "object" ? message.output : message;
      const raw = output?.clothing_draw ?? output?.clothingDraw;
      const record = Array.isArray(raw) ? raw[raw.length - 1] : raw;
      if (!record || typeof record !== "object" || !String(record.prompt || "").trim()) return;
      const selected = makeSelectionCard({
        id: record.id,
        name: record.name,
        prompt: record.prompt,
        categoryId: record.category_id ?? record.categoryId,
        categoryName: record.category ?? record.categoryName,
        imageUrl: record.image_url ?? record.imageUrl,
        hasImage: record.has_image !== undefined
          ? Boolean(record.has_image)
          : Boolean(record.image_url ?? record.imageUrl),
      }, record.category ?? record.categoryName);
      if (!selected) return;
      // The execution result is authoritative: it accounts for ComfyUI's
      // seed randomization and keeps the visible preview aligned with the
      // card that actually reached downstream nodes.
      this.selected = selected;
      this.updateView();
      this.setStatus(`本次抽取：${selected.name}`, "ready");
    }

    updateView() {
      if (!this.root) return;
      const selected = this.selected;
      this.nameEl.textContent = selected?.name || "尚未选择服装";
      this.nameEl.title = selected?.name || "";
      this.categoryEl.textContent = selected?.categoryName || "";
      this.promptEl.value = selected?.prompt || "";
      this.renameBtn.disabled = !selected?.id;
      if (!selected) {
        this.releasePreviewUrl();
        this.previewImg.removeAttribute("src");
        this.previewImg.hidden = true;
        this.previewPlaceholder.hidden = false;
        return;
      }
      this.previewPlaceholder.hidden = false;
      this.previewPlaceholder.textContent = selected.hasImage === false ? "无预览图" : "读取预览图…";
      this.previewImg.hidden = true;
      this.loadPreview(selected.id, selected.imageUrl);
    }

    async loadPreview(id, fallbackUrl) {
      const currentId = id;
      try {
        const preview = await getClothingCardPreview(id);
        if (this.disposed || this.selected?.id !== currentId) {
          if (preview?.revoke) URL.revokeObjectURL(preview.url);
          return;
        }
        this.releasePreviewUrl();
        if (preview?.url) {
          this.previewUrl = preview.url;
          this.previewUrlRevocable = preview.revoke;
          this.previewImg.src = preview.url;
          this.previewImg.hidden = false;
          this.previewPlaceholder.hidden = true;
        } else if (fallbackUrl) {
          this.previewImg.src = fallbackUrl;
          this.previewImg.hidden = false;
          this.previewPlaceholder.hidden = true;
        } else {
          this.previewPlaceholder.textContent = "无预览图";
        }
      } catch {
        if (fallbackUrl && this.selected?.id === currentId) {
          this.previewImg.src = fallbackUrl;
          this.previewImg.hidden = false;
          this.previewPlaceholder.hidden = true;
        } else if (this.selected?.id === currentId) {
          this.previewPlaceholder.textContent = "预览图读取失败";
        }
      }
    }

    releasePreviewUrl() {
      if (this.previewUrl && this.previewUrlRevocable) URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
      this.previewUrlRevocable = false;
    }

    setStatus(text, type = "ready") {
      if (!this.statusEl) return;
      this.statusEl.textContent = text;
      this.statusEl.dataset.state = type;
    }

    openPicker() {
      if (this.picker) return;
      const overlay = document.createElement("div");
      overlay.className = "tk-clothing-picker-overlay";
      overlay.innerHTML = `
        <div class="tk-clothing-picker-modal" role="dialog" aria-modal="true" aria-label="选择服装">
          <div class="tk-clothing-picker-head">
            <strong>选择服装</strong><span data-role="picker-total"></span>
            <button type="button" class="tk-clothing-picker-close" data-action="close" title="关闭">×</button>
          </div>
          <div class="tk-clothing-picker-body">
            <aside class="tk-clothing-picker-sidebar" data-role="picker-sidebar"></aside>
            <main class="tk-clothing-picker-main">
              <div class="tk-clothing-picker-search-row">
                <input type="search" data-role="picker-search" placeholder="搜索名称、提示词、标签…" autocomplete="off" spellcheck="false">
                <button type="button" class="tk-clothing-picker-refresh" data-action="picker-refresh">刷新</button>
              </div>
              <div class="tk-clothing-picker-grid" data-role="picker-grid"></div>
              <div class="tk-clothing-picker-foot" data-role="picker-status"></div>
            </main>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const modal = overlay.querySelector(".tk-clothing-picker-modal");
      const picker = {
        overlay,
        modal,
        sidebar: overlay.querySelector('[data-role="picker-sidebar"]'),
        grid: overlay.querySelector('[data-role="picker-grid"]'),
        search: overlay.querySelector('[data-role="picker-search"]'),
        total: overlay.querySelector('[data-role="picker-total"]'),
        status: overlay.querySelector('[data-role="picker-status"]'),
        scope: this.scope,
        keyword: "",
        urls: new Map(),
        seq: 0,
        observer: null,
      };
      this.picker = picker;
      overlay.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Escape") this.closePicker();
      });
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) this.closePicker();
      });
      // Keep keyboard events available to the overlay's Escape handler while
      // still isolating all pointer/mouse events from the LiteGraph canvas.
      shieldCanvasInteractions(modal, { keyboard: false });
      overlay.querySelector('[data-action="close"]').addEventListener("click", () => this.closePicker());
      overlay.querySelector('[data-action="picker-refresh"]').addEventListener("click", () => this.renderPicker());
      picker.search.addEventListener("input", () => {
        picker.keyword = picker.search.value;
        clearTimeout(picker.searchTimer);
        picker.searchTimer = setTimeout(() => this.renderPicker(), 120);
      });
      picker.sidebar.addEventListener("click", (event) => {
        const button = event.target.closest("[data-scope]");
        if (!button) return;
        picker.scope = button.dataset.scope || "";
        this.renderPicker();
      });
      picker.grid.addEventListener("click", (event) => {
        const action = event.target.closest("[data-card-action]");
        if (!action) return;
        const card = picker.cards?.find((item) => item.id === action.dataset.id);
        if (!card) return;
        if (action.dataset.cardAction === "rename") this.renamePickerCard(card);
        else this.selectCard(card);
      });
      this.renderPicker();
      setTimeout(() => picker.search.focus(), 0);
    }

    async renamePickerCard(card) {
      const next = window.prompt("输入新的服装名称", card.name || "");
      if (next == null || !String(next).trim() || String(next).trim() === card.name) return;
      try {
        const updated = await renameClothingCard(card.id, String(next).trim());
        card.name = updated.name;
        if (this.selected?.id === card.id) {
          this.selected = makeSelectionCard(updated, card.categoryName);
          this.writePayload();
          this.updateView();
        }
        await this.renderPicker();
      } catch (error) {
        if (this.picker) this.picker.status.textContent = libraryErrorMessage(error);
      }
    }

    async renderPicker() {
      const picker = this.picker;
      if (!picker || this.disposed) return;
      const seq = ++picker.seq;
      picker.status.textContent = "正在读取…";
      try {
        const all = await getClothingCards({});
        if (!this.picker || picker.seq !== seq) return;
        this.categories = await getClothingCategories();
        const categoryMap = new Map(this.categories.map((category) => [category.id, category.name]));
        const filtered = all.filter((card) => {
          if (picker.scope === SCOPE_FAVORITE && !card.favorite) return false;
          if (picker.scope && picker.scope !== SCOPE_FAVORITE && card.categoryId !== picker.scope) return false;
          const tokens = String(picker.keyword || "").toLocaleLowerCase().split(/\s+/).filter(Boolean);
          if (!tokens.length) return true;
          const haystack = [card.name, card.prompt, card.categoryName, ...card.tags].join(" ").toLocaleLowerCase();
          return tokens.every((token) => haystack.includes(token));
        });
        const visible = filtered.slice(0, 120);
        picker.cards = visible;
        picker.total.textContent = `${filtered.length} 张`;
        picker.sidebar.innerHTML = this.renderPickerSidebar(all, categoryMap, picker.scope);
        this.releasePickerUrls();
        picker.grid.innerHTML = visible.length
          ? visible.map((card) => this.renderPickerCard(card)).join("")
          : '<div class="tk-clothing-picker-empty">没有匹配的服装卡片</div>';
        picker.status.textContent = filtered.length > 120 ? `显示前 120 张，请继续搜索缩小范围（共 ${filtered.length} 张）` : "点击卡片选择服装";
        this.lazyLoadPickerImages(seq);
      } catch (error) {
        if (this.picker && picker.seq === seq) {
          picker.grid.innerHTML = `<div class="tk-clothing-picker-empty">${esc(libraryErrorMessage(error))}</div>`;
          picker.status.textContent = "读取失败";
        }
      }
    }

    renderPickerSidebar(all, categoryMap, scope) {
      const buttons = [];
      const active = (value) => value === scope ? " active" : "";
      buttons.push(`<button type="button" data-scope="" class="tk-clothing-picker-scope${active("")}"><span>全部</span><em>${all.length}</em></button>`);
      buttons.push(`<button type="button" data-scope="${SCOPE_FAVORITE}" class="tk-clothing-picker-scope${active(SCOPE_FAVORITE)}"><span>收藏</span><em>${all.filter((card) => card.favorite).length}</em></button>`);
      this.categories.forEach((category) => {
        const count = all.filter((card) => card.categoryId === category.id).length;
        buttons.push(`<button type="button" data-scope="${esc(category.id)}" class="tk-clothing-picker-scope${active(category.id)}"><span>${esc(category.name)}</span><em>${count}</em></button>`);
      });
      return buttons.join("");
    }

    renderPickerCard(card) {
      const selected = this.selected?.id === card.id;
      return `<article class="tk-clothing-picker-card${selected ? " selected" : ""}" data-card-action="select" data-id="${esc(card.id)}">
        <div class="tk-clothing-picker-card-image" data-preview-id="${esc(card.id)}"><span>🖼</span></div>
        <div class="tk-clothing-picker-card-info">
          <div class="tk-clothing-picker-card-title" title="${esc(card.name)}">${esc(card.name)}</div>
          <div class="tk-clothing-picker-card-meta">${esc(card.categoryName)}${card.favorite ? " · ★" : ""}</div>
          <div class="tk-clothing-picker-card-prompt" title="${esc(card.prompt)}">${esc(card.prompt)}</div>
        </div>
        <button type="button" class="tk-clothing-picker-card-rename" data-card-action="rename" data-id="${esc(card.id)}" title="重命名">✎</button>
      </article>`;
    }

    async lazyLoadPickerImages(seq) {
      const picker = this.picker;
      if (!picker) return;
      picker.observer?.disconnect();
      picker.observer = null;
      const targets = [...picker.grid.querySelectorAll("[data-preview-id]")].slice(0, 120);
      const observer = "IntersectionObserver" in window
        ? new IntersectionObserver((entries) => entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          this.loadPickerImage(entry.target, entry.target.dataset.previewId, seq);
        }), { root: picker.grid, rootMargin: "240px" })
        : null;
      picker.observer = observer;
      targets.forEach((target) => observer ? observer.observe(target) : this.loadPickerImage(target, target.dataset.previewId, seq));
    }

    async loadPickerImage(container, id, seq) {
      const picker = this.picker;
      if (!picker || picker.seq !== seq) return;
      try {
        const preview = await getClothingCardPreview(id);
        if (!this.picker || picker.seq !== seq || !container.isConnected) {
          if (preview?.revoke) URL.revokeObjectURL(preview.url);
          return;
        }
        if (preview?.url) {
          if (preview.revoke) picker.urls.set(id, preview.url);
          container.innerHTML = `<img src="${esc(preview.url)}" alt="" loading="lazy">`;
        } else {
          container.innerHTML = "<span>无图</span>";
        }
      } catch {
        if (container.isConnected) container.innerHTML = "<span>无图</span>";
      }
    }

    releasePickerUrls() {
      if (!this.picker) return;
      this.picker.observer?.disconnect();
      this.picker.observer = null;
      this.picker.urls.forEach((url) => URL.revokeObjectURL(url));
      this.picker.urls.clear();
    }

    closePicker() {
      if (!this.picker) return;
      this.releasePickerUrls();
      clearTimeout(this.picker.searchTimer);
      this.picker.overlay.remove();
      this.picker = null;
    }

    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.closePicker();
      this.releasePreviewUrl();
      this.domSizeSync?.dispose?.();
    }
  }

  function prepareSelectionWidget(node) {
    let widget = nativeWidget(node, "selection_data");
    if (!widget) widget = node.addWidget?.("text", "selection_data", "{}", () => {}, { serialize: true });
    if (widget) {
      widget.computeSize = () => [0, -4];
      widget.draw = () => {};
      widget.type = "hidden";
      widget.serialize = true;
    }
    return widget;
  }

  function init() {
    const app = window.comfyAPI?.app?.app;
    if (!app?.registerExtension) return setTimeout(init, 500);
    injectStylesheet();
    app.registerExtension({
      name: "TK.ClothingDraw.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalConfigure = nodeType.prototype.onConfigure;
        const originalRemoved = nodeType.prototype.onRemoved;
        const originalExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onNodeCreated = function () {
          const result = originalCreated?.apply(this, arguments);
          if (this._tkClothingDrawUI) return result;
          const modeWidget = nativeWidget(this, "mode");
          const seedWidget = nativeWidget(this, "seed");
          const selectionWidget = prepareSelectionWidget(this);
          const ui = new ClothingDrawUI(this, modeWidget, seedWidget, selectionWidget);
          this._tkClothingDrawUI = ui;
          const element = ui.build();
          const domWidget = this.addDOMWidget?.("tk_clothing_draw", "custom", element, { serialize: false, hideOnZoom: false });
          ui.mount(domWidget);
          if (!this.properties?.tkClothingDrawInitialized) {
            this.setSize?.([360, 400]);
            this.properties = { ...(this.properties || {}), tkClothingDrawInitialized: true };
          }
          return result;
        };
        nodeType.prototype.onConfigure = function () {
          const result = originalConfigure?.apply(this, arguments);
          setTimeout(() => {
            const ui = this._tkClothingDrawUI;
            if (!ui) return;
            ui.restorePayload();
            ui.updateView();
            ui.refreshLibrary();
          }, 0);
          return result;
        };
        nodeType.prototype.onRemoved = function () {
          this._tkClothingDrawUI?.dispose();
          return originalRemoved?.apply(this, arguments);
        };
        nodeType.prototype.onExecuted = function (message) {
          const result = originalExecuted?.apply(this, arguments);
          setTimeout(() => this._tkClothingDrawUI?.applyExecutionResult(message), 0);
          return result;
        };
      },
    });
  }

  init();
})();
