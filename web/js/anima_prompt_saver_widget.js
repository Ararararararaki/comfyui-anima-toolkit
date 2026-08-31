// TK Prompt Saver：执行节点时自动把已开启的提示词写入共享 Prompt 库。
(function () {
  const NODE_NAME = "AnimaTKPromptSaver";
  const INPUT_COUNT = 6;
  const DB_NAME = "anima-lora";
  const PROMPT_STORE = "prompts";
  const CATEGORY_STORE = "promptCategories";
  const DEFAULT_CATEGORIES = [
    { id: "uncategorized", name: "未分类", icon: "", sortOrder: 0 },
    { id: "cat_faces", name: "人物", icon: "", sortOrder: 1 },
    { id: "cat_style", name: "画师风格", icon: "", sortOrder: 2 },
    { id: "cat_env", name: "背景环境", icon: "", sortOrder: 3 },
    { id: "cat_light", name: "光影氛围", icon: "", sortOrder: 4 },
    { id: "cat_detail", name: "细节增强", icon: "", sortOrder: 5 },
    { id: "cat_fav", name: "常用", icon: "", sortOrder: 6 },
  ];
  const DEFAULT_SETTINGS = {
    mode: "single",
    enabled: [true, false, false, false, false, false],
    selected: 0,
    names: ["提示词 1", "提示词 2", "提示词 3", "提示词 4", "提示词 5", "提示词 6"],
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
        result.names = Array.from({ length: INPUT_COUNT }, (_, index) => String(parsed.names[index] ?? "").trim() || `提示词 ${index + 1}`);
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

  function openPromptDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROMPT_STORE)) db.createObjectStore(PROMPT_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(CATEGORY_STORE)) db.createObjectStore(CATEGORY_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开 Prompt 库"));
    });
  }

  function storeAll(db, name) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, "readonly");
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error(`无法读取 ${name}`));
    });
  }

  function storePut(db, name, value) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, "readwrite");
      transaction.objectStore(name).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error(`无法写入 ${name}`));
    });
  }

  function genId() {
    return `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function splitPromptTags(prompt) {
    return [...new Set(String(prompt || "").split(/[,，、;；\n]+/).map((tag) => tag.trim()).filter(Boolean))];
  }

  function getApi() {
    return window.comfyAPI?.api?.api || window.api;
  }

  function injectStyles() {
    const styleId = "tk-prompt-saver-style";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .tk-ps-panel { box-sizing:border-box; width:100%; padding:4px 5px 5px; color:#b8b8b8; font:12px/1.25 Arial,sans-serif; }
      .tk-ps-panel * { box-sizing:border-box; }
      .tk-ps-header { display:flex; align-items:center; gap:6px; min-height:23px; padding:0 1px 3px; border-bottom:1px solid rgba(255,255,255,.10); }
      .tk-ps-title { color:#bdbdbd; white-space:nowrap; }
      .tk-ps-mode, .tk-ps-category { min-width:0; padding:3px 5px; color:#d5d5d5; background:#353535; border:1px solid #555; border-radius:2px; outline:none; font:11px Arial,sans-serif; }
      .tk-ps-mode { flex:1; }
      .tk-ps-category { width:100%; }
      .tk-ps-mode:focus, .tk-ps-category:focus { border-color:#999; }
      .tk-ps-count { min-width:27px; color:#858585; font-size:11px; text-align:right; font-variant-numeric:tabular-nums; }
      .tk-ps-note { padding:4px 1px 3px; color:#858585; font-size:10px; }
      .tk-ps-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:3px 5px; }
      .tk-ps-row { display:flex; align-items:center; min-width:0; min-height:25px; padding:2px 4px; border:1px solid transparent; border-radius:2px; background:rgba(0,0,0,.13); cursor:pointer; }
      .tk-ps-row:hover { background:rgba(255,255,255,.055); }
      .tk-ps-row.is-enabled { border-color:rgba(255,255,255,.14); background:rgba(255,255,255,.075); }
      .tk-ps-control { width:13px; height:13px; margin:0 5px 0 0; flex:0 0 auto; accent-color:#bcbcbc; cursor:pointer; }
      .tk-ps-index { width:17px; flex:0 0 auto; color:#929292; text-align:center; font-size:11px; font-variant-numeric:tabular-nums; }
      .tk-ps-name { min-width:0; flex:1; margin-left:5px; padding:3px 5px; color:#dddddd; background:#343434; border:1px solid #505050; border-radius:2px; outline:none; font:11px Arial,sans-serif; }
      .tk-ps-name:focus { border-color:#999; }
      .tk-ps-name::placeholder { color:#777; }
      .tk-ps-library { display:flex; align-items:center; gap:5px; margin-top:5px; padding-top:5px; border-top:1px solid rgba(255,255,255,.10); }
      .tk-ps-library-label { flex:0 0 auto; color:#929292; font-size:10px; }
      .tk-ps-status { min-height:15px; padding:3px 1px 0; color:#858585; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    `;
    document.head.appendChild(style);
  }

  class PromptSaverUI {
    constructor(node) {
      this.node = node;
      this.settings = cloneDefaults();
      this.settingsWidget = null;
      this.categoryWidget = null;
      this.container = null;
      this.grid = null;
      this.mode = null;
      this.count = null;
      this.category = null;
      this.status = null;
      this.controls = new Map();
      this.executionApi = null;
      this.executionHandler = null;
    }

    widgetFor(name) {
      return this.node.widgets?.find((widget) => widget.name === name) || null;
    }

    installStateWidgets() {
      this.settingsWidget = this.widgetFor("router_settings");
      if (!this.settingsWidget && typeof this.node.addWidget === "function") {
        this.settingsWidget = this.node.addWidget("text", "router_settings", JSON.stringify(this.settings), () => {}, { serialize: true });
      }
      this.categoryWidget = this.widgetFor("prompt_category");
      if (!this.categoryWidget && typeof this.node.addWidget === "function") {
        this.categoryWidget = this.node.addWidget("text", "prompt_category", "uncategorized", () => {}, { serialize: true });
      }
      if (this.settingsWidget) {
        this.settings = parseSettings(this.settingsWidget.value);
        this.hideNativeWidget(this.settingsWidget);
      }
      if (this.categoryWidget) this.hideNativeWidget(this.categoryWidget);
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

    commitSettings() {
      if (this.settingsWidget) this.settingsWidget.value = JSON.stringify(this.settings);
      this.node.graph?.change();
      this.updateVisualState();
    }

    commitCategory(value) {
      if (this.categoryWidget) this.categoryWidget.value = String(value || "uncategorized");
      this.node.graph?.change();
    }

    updateVisualState() {
      if (this.count) {
        const count = this.settings.enabled.filter(Boolean).length;
        this.count.textContent = `${count}/${INPUT_COUNT}`;
      }
      for (const [index, control] of this.controls) {
        const enabled = Boolean(this.settings.enabled[index]);
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
      this.commitSettings();
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
        row.className = "tk-ps-row";
        const control = document.createElement("input");
        control.className = "tk-ps-control";
        control.type = inputType;
        control.name = `tk-prompt-saver-${this.node.id}`;
        control.checked = Boolean(this.settings.enabled[index]);
        control.title = this.settings.mode === "single" ? "选择唯一保存接口" : "切换保存接口";
        const number = document.createElement("span");
        number.className = "tk-ps-index";
        number.textContent = String(index + 1);
        const name = document.createElement("input");
        name.className = "tk-ps-name";
        name.type = "text";
        name.value = this.settings.names[index];
        name.placeholder = `提示词 ${index + 1}`;
        name.title = "保存到 Prompt 库时使用的显示名称";

        control.addEventListener("change", () => {
          if (this.settings.mode === "single") {
            this.settings.enabled = this.settings.enabled.map((_, item) => item === index);
            this.settings.selected = index;
          } else {
            this.settings.enabled[index] = control.checked;
            this.settings.selected = firstEnabled(this.settings.enabled);
          }
          this.commitSettings();
          this.renderRows();
        });
        name.addEventListener("input", () => {
          this.settings.names[index] = name.value.trim() || `提示词 ${index + 1}`;
          this.commitSettings();
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

    async loadCategories() {
      let categories = DEFAULT_CATEGORIES;
      try {
        const db = await openPromptDB();
        const saved = await storeAll(db, CATEGORY_STORE);
        if (saved.length) categories = saved.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      } catch (_) {
        // Prompt 库尚未初始化时使用与面板一致的默认分类。
      }
      if (!this.category) return;
      const current = this.categoryWidget?.value || "uncategorized";
      this.category.innerHTML = categories.map((item) => `<option value="${String(item.id).replace(/"/g, "&quot;")}">${String(item.name || "未分类")}</option>`).join("");
      this.category.value = categories.some((item) => item.id === current) ? current : "uncategorized";
      this.commitCategory(this.category.value);
    }

    setStatus(text) {
      if (this.status) this.status.textContent = text;
    }

    async persistExecution(records) {
      if (!Array.isArray(records) || !records.length) {
        this.setStatus("本次没有可保存的提示词");
        return;
      }
      try {
        const db = await openPromptDB();
        const existing = await storeAll(db, PROMPT_STORE);
        const sourceNodeId = String(this.node.id);
        let saved = 0;
        for (const record of records) {
          const prompt = String(record?.prompt || "").trim();
          if (!prompt) continue;
          const sourceInput = String(record.sourceInput || "");
          const old = existing.find((item) => item.source === "tk-prompt-saver" && String(item.sourceNodeId) === sourceNodeId && item.sourceInput === sourceInput);
          const now = Date.now();
          const previewImage = String(record.previewImage || "").trim();
          const oldImages = Array.isArray(old?.images) ? old.images : [];
          const entry = {
            id: old?.id || genId(),
            prompt,
            displayText: String(record.displayText || prompt.slice(0, 40)).trim() || prompt.slice(0, 40),
            images: previewImage ? [previewImage] : oldImages,
            primaryImage: previewImage || String(old?.primaryImage || ""),
            tags: splitPromptTags(prompt),
            loras: [],
            categoryId: String(record.categoryId || this.categoryWidget?.value || "uncategorized"),
            notes: "",
            isFavorite: Boolean(old?.isFavorite),
            kind: "prompt",
            source: "tk-prompt-saver",
            sourceNodeId,
            sourceInput,
            createdAt: old?.createdAt || now,
            updatedAt: now,
          };
          await storePut(db, PROMPT_STORE, entry);
          saved += 1;
        }
        window.dispatchEvent(new CustomEvent("anima-prompt-cards-updated"));
        try { localStorage.setItem("anima_prompt_library_updated", String(Date.now())); } catch (_) {}
        this.setStatus(`已自动保存 ${saved} 条`);
      } catch (error) {
        this.setStatus(`自动保存失败：${error.message || error}`);
        console.error("[TK Prompt Saver] 自动保存失败:", error);
      }
    }

    attachExecutionListener() {
      const api = getApi();
      if (!api || typeof api.addEventListener !== "function") {
        setTimeout(() => this.attachExecutionListener(), 500);
        return;
      }
      this.executionApi = api;
      this.executionHandler = (event) => {
        const detail = event?.detail || {};
        const nodeId = detail.node ?? detail.node_id ?? detail.nodeId;
        if (String(nodeId) !== String(this.node.id)) return;
        const output = detail.output || {};
        const records = output.prompt_saver || output.promptSaver || [];
        this.persistExecution(records);
      };
      api.addEventListener("executed", this.executionHandler);
      const originalRemoved = this.node.onRemoved;
      this.node.onRemoved = (...args) => {
        this.executionApi?.removeEventListener?.("executed", this.executionHandler);
        return originalRemoved?.apply(this.node, args);
      };
    }

    build() {
      injectStyles();
      const panel = document.createElement("div");
      panel.className = "tk-ps-panel";
      this.container = panel;

      const header = document.createElement("div");
      header.className = "tk-ps-header";
      const title = document.createElement("span");
      title.className = "tk-ps-title";
      title.textContent = "模式";
      this.mode = document.createElement("select");
      this.mode.className = "tk-ps-mode";
      this.mode.innerHTML = '<option value="single">单选</option><option value="multi">多选</option>';
      this.mode.value = this.settings.mode;
      this.mode.addEventListener("change", () => this.selectMode(this.mode.value));
      this.count = document.createElement("span");
      this.count.className = "tk-ps-count";
      header.append(title, this.mode, this.count);

      const note = document.createElement("div");
      note.className = "tk-ps-note";
      note.textContent = "执行时自动保存已开启输入；image_1…image_6 为对应预览图";
      this.grid = document.createElement("div");
      this.grid.className = "tk-ps-grid";

      const library = document.createElement("div");
      library.className = "tk-ps-library";
      const libraryLabel = document.createElement("span");
      libraryLabel.className = "tk-ps-library-label";
      libraryLabel.textContent = "分类";
      this.category = document.createElement("select");
      this.category.className = "tk-ps-category";
      this.category.addEventListener("change", () => this.commitCategory(this.category.value));
      library.append(libraryLabel, this.category);
      this.status = document.createElement("div");
      this.status.className = "tk-ps-status";
      this.status.textContent = "等待执行";

      panel.append(header, note, this.grid, library, this.status);
      this.renderRows();
      this.loadCategories();
      return panel;
    }

    load() {
      if (this.settingsWidget) this.settings = parseSettings(this.settingsWidget.value);
      if (this.mode) this.mode.value = this.settings.mode;
      if (this.category && this.categoryWidget) this.category.value = this.categoryWidget.value || "uncategorized";
      this.renderRows();
    }
  }

  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);
    api.registerExtension({
      name: "TK.PromptSaver.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const originalCreated = nodeType.prototype.onNodeCreated;
        const originalConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onNodeCreated = function () {
          const result = originalCreated?.apply(this, arguments);
          if (this._tkPromptSaverUI) return result;
          const ui = new PromptSaverUI(this);
          this._tkPromptSaverUI = ui;
          ui.installStateWidgets();
          const element = ui.build();
          const domWidget = this.addDOMWidget?.("tk_prompt_saver", "custom", element, { serialize: false, hideOnZoom: false });
          if (domWidget) {
            domWidget.computeSize = () => [0, 205];
            this.setSize?.([Math.max(300, this.size?.[0] || 300), 380]);
          }
          ui.attachExecutionListener();
          return result;
        };
        nodeType.prototype.onConfigure = function () {
          const result = originalConfigure?.apply(this, arguments);
          this._tkPromptSaverUI?.load();
          return result;
        };
      },
    });
  }

  init();
})();

