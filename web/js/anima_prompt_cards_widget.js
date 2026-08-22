// TK Prompt Cards 节点前端 —— 卡片库提示词编辑器
//
// 数据层：直接读写 TK Toolkit（civitai 面板）的 IndexedDB「anima-lora」
//   （面板由 ComfyUI 同域服务，节点与面板共享同一 prompt 库，改动即时互见）
//   prompts 表：面板条目（整段提示词）与节点卡片（tag 级，kind='card'）共存；
//     prompt=英文文本 / notes=中文注释 / isFavorite=星标 / 扩展字段 weight/lora/multi/kind
//   promptCategories 表：分类（与面板共用）
//
// 三区布局：
//   ① 工具箱 prompt 库：分类 + 条目列表 + 搜索；点击条目 = 仅替换当前提示词（不自动入队）；
//      「批文件导入」页签：input/prompts 批文件浏览 → 整组导入为库条目
//   ② 当前提示词：textarea + 逗号拆分卡片流（逐卡删除/存卡）+ 草稿自动暂存/恢复 +
//      剪切板导入 + PNG 解析 + 整段存为组合卡
//   ③ 卡片视图：kind=card 条目网格（分类页签/全部）；点击追加（智能去重）、双击就地编辑、
//      右键软删除+撤销、星标置顶、批量补翻、浏览 LoRA 存触发词卡（同步 lora_syntax）、
//      导出批文件
//
// 后端复用：/api/translate（五源回退）、/anima/cards/image（PNG 解析）、
//   /anima/cards/lora-triggers /anima/loras、/anima/cards/export（导出批文件）、
//   /anima/prompt/list|parse（批文件浏览/导入）
//
// 2026-08-17 新建；08-18 存储层切换为 TK Toolkit IndexedDB 联动。

(function () {
  const NODE_NAME = "TK Prompt Cards";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const escAttr = (s) => esc(s);

  function apiFetch(path) {
    const api = window.comfyAPI?.api?.api || window.api;
    if (api?.fetchApi) return api.fetchApi(path);
    return fetch(path);
  }
  async function fetchJson(path, opts) {
    // 统一 12s 超时：翻译链路最慢可到 ~1 分钟（五源回退），UI 不能被拖死
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
    try {
      const r = await apiFetch(path, ctrl ? { ...(opts || {}), signal: ctrl.signal } : opts);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function postJson(path, body) {
    return fetchJson(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── IndexedDB：TK Toolkit prompt 库（anima-lora，与面板共享）──
  const DB_NAME = "anima-lora";
  const PROMPT_STORE = "prompts";
  const CAT_STORE = "promptCategories";

  let _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      // 先尝试 v1 打开（库不存在时走 onupgradeneeded 建表）
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PROMPT_STORE)) {
          db.createObjectStore(PROMPT_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(CAT_STORE)) {
          db.createObjectStore(CAT_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        // 关键：面板升级过库版本（如 v10），请求 v1 会抛 VersionError——
        // 此时无版本重开（打开现有库、不触发升级、绝不降级）。
        if (req.error && req.error.name === "VersionError") {
          const req2 = indexedDB.open(DB_NAME);
          req2.onsuccess = () => resolve(req2.result);
          req2.onerror = () => reject(req2.error);
        } else {
          reject(req.error);
        }
      };
    });
    return _dbPromise;
  }

  function storeAll(db, name) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  function storePut(db, name, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  function storeDel(db, name, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  function storeGet(db, name, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 默认分类（与面板 DEFAULT_CATEGORIES 一致；仅在库为空时初始化）
  const DEFAULT_CATS = [
    { id: "uncategorized", name: "未分类", icon: "", sortOrder: 0 },
    { id: "cat_faces", name: "人物", icon: "", sortOrder: 1 },
    { id: "cat_style", name: "画师风格", icon: "", sortOrder: 2 },
    { id: "cat_env", name: "背景环境", icon: "", sortOrder: 3 },
    { id: "cat_light", name: "光影氛围", icon: "", sortOrder: 4 },
    { id: "cat_detail", name: "细节增强", icon: "", sortOrder: 5 },
    { id: "cat_fav", name: "常用", icon: "", sortOrder: 6 },
  ];
  const CAT_NAME = (c) => (c && c.name) || "未分类";

  function genId(prefix) {
    return (prefix || "p_") + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

  // ── 文本工具 ──

  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  // 拆分提示词 → 卡片片段（[{text, weight}]）：
  // 换行 > 中文顿号/逗号/分号 > 英文逗号兜底；>60 且含英文逗号视为整句不拆
  function splitTags(text) {
    const out = [];
    for (let rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const cnParts = line.split(/[、，;；]/).map((s) => s.trim()).filter(Boolean);
      for (let part of cnParts) {
        if (part.length > 60 && part.includes(",")) { out.push({ text: part, weight: "" }); continue; }
        const enParts = part.split(",").map((s) => s.trim()).filter(Boolean);
        for (let p of enParts) {
          const m = p.match(/^\((.+):([0-9.]+)\)$/);
          if (m) { out.push({ text: m[1].trim(), weight: m[2] }); continue; }
          out.push({ text: p, weight: "" });
        }
      }
    }
    return out;
  }

  function langOf(text) {
    const t = String(text || "");
    if (!t) return "en";
    let cjk = 0;
    for (const ch of t) if (CJK_RE.test(ch)) cjk++;
    return cjk / t.length > 0.3 ? "zh" : "en";
  }

  // 翻译（双向自动检测）
  async function translateAuto(text) {
    const q = String(text || "").trim().slice(0, 2000);
    if (!q) return "";
    const lp = langOf(q) === "zh" ? "auto|en" : "en|zh-CN";
    const r = await fetchJson("/api/translate?q=" + encodeURIComponent(q) + "&langpair=" + encodeURIComponent(lp));
    if (r.ok && r.translatedText) return r.translatedText;
    if (r.error) throw new Error(r.error);
    return "";
  }

  function cardToText(c) {
    const en = String(c.prompt || c.en || "").trim();
    if (!en) return "";
    const w = String(c.weight || "").trim();
    return w ? `(${en}:${w})` : en;
  }

  // 追加（智能去重）
  function appendCardToPrompt(cur, c, sep = ", ") {
    const piece = cardToText(c);
    if (!piece) return cur;
    const analyst = splitTags(cur).map((p) => p.text.toLowerCase().trim());
    const base = String(c.prompt || c.en || "").toLowerCase().trim();
    if (analyst.includes(base)) return cur;
    const curT = String(cur || "").replace(/[,\s]+$/, "");
    return curT ? curT + sep + piece : piece;
  }

  function removePiece(cur, piece) {
    const target = (piece.text || "").trim();
    const parts = splitTags(cur);
    const keep = [];
    let removed = false;
    for (const p of parts) {
      if (!removed && p.text.trim() === target) { removed = true; continue; }
      keep.push(p);
    }
    if (!removed) return cur;
    return keep.map((p) => p.weight ? `(${p.text}:${p.weight})` : p.text).join(", ");
  }

  // 草稿
  const DRAFT_KEY = "anima_tk_cards_draft_v1";
  function saveDraft(text) { try { localStorage.setItem(DRAFT_KEY, String(text || "")); } catch (e) {} }
  function loadDraft() { try { return localStorage.getItem(DRAFT_KEY) || ""; } catch (e) { return ""; } }

  // ── UI ──

  class CardsUI {
    constructor(node, w) {
      this.node = node;
      this.w = w; // {positive, opt_text, lora_syntax}
      this.prompts = [];   // 内存缓存（全量）
      this.cats = [];      // 分类
      this.curCat = "";    // 当前分类 id（"" = 全部）
      this.curKind = "card"; // ③区视图：card（默认）/ all
      this.search = "";
      this.deleted = new Map(); // id -> {catId, entry, timer}
      this.rootEl = null;
      this.libListEl = null;    // ①区条目列表
      this.libSearchEl = null;
      this.libTabEl = null;     // ①区 tab（库 / 批文件）
      this.fileSel = null;
      this.groupListEl = null;
      this.curTextEl = null;
      this.chipsEl = null;
      this.catTabsEl = null;
      this.cardGridEl = null;
      this.statusEl = null;
      this.batchGroups = new Map(); // 批文件路径 -> groups
    }

    _setW(widget, value) {
      if (!widget) return;
      widget.value = value;
      if (typeof widget.callback === "function") { try { widget.callback(value) } catch {} }
    }

    curText() { return this.w.positive?.value || ""; }

    // ── 库加载 ──
    async reloadAll() {
      try {
        const db = await openDB();
        const [prompts, cats] = await Promise.all([
          storeAll(db, PROMPT_STORE),
          storeAll(db, CAT_STORE),
        ]);
        this.prompts = prompts || [];
        if (!cats || !cats.length) {
          for (const c of DEFAULT_CATS) await storePut(db, CAT_STORE, c);
          this.cats = DEFAULT_CATS.slice();
        } else {
          this.cats = cats.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        }
      } catch (e) {
        console.error("[TK Prompt Cards] 库加载失败:", e);
        this._flash("IndexedDB 库加载失败：" + (e.message || e));
      }
      this._renderLibList();
      this._renderCatTabs();
      this._renderCards();
    }

    // ── ① 工具箱 prompt 库浏览 ──
    _renderLibList() {
      if (!this.libListEl) return;
      const q = (this.search || "").toLowerCase();
      let list = this.prompts.slice();
      if (this.curCat) list = list.filter((p) => p.categoryId === this.curCat);
      if (q) {
        list = list.filter((p) =>
          String(p.prompt || "").toLowerCase().includes(q) ||
          String(p.displayText || "").toLowerCase().includes(q) ||
          String(p.notes || "").toLowerCase().includes(q) ||
          (p.tags || []).some((t) => String(t).toLowerCase().includes(q))
        );
      }
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      this.libListEl.innerHTML = "";
      if (!list.length) {
        this.libListEl.innerHTML = `<div class="tk-cards-empty">库为空 — 面板提取、批文件导入或下方存卡后这里会出现条目</div>`;
        return;
      }
      for (const p of list) {
        const row = document.createElement("div");
        row.className = "tk-cards-lib-row" + (p.kind === "card" ? " is-card" : "");
        row.title = "点击切换为当前提示词（仅替换，不自动入队）";
        const head = document.createElement("div");
        head.className = "tk-cards-lib-head";
        const title = document.createElement("span");
        title.className = "tk-cards-lib-title";
        title.textContent = (p.displayText || p.prompt || "").slice(0, 60) + (p.kind === "card" ? "  [卡]" : "");
        const fav = document.createElement("span");
        fav.className = "tk-cards-lib-fav";
        fav.textContent = p.isFavorite ? "★" : "";
        head.appendChild(title);
        head.appendChild(fav);
        const sub = document.createElement("div");
        sub.className = "tk-cards-lib-sub";
        sub.textContent = String(p.prompt || "").slice(0, 90);
        row.appendChild(head);
        row.appendChild(sub);
        const save = document.createElement("button");
        save.type = "button";
        save.className = "tk-cards-btn tk-cards-lib-more";
        save.textContent = "…";
        save.title = "更多操作（待扩展）";
        row.addEventListener("click", (ev) => {
          if (ev.target === save) return;
          this._setW(this.w.positive, p.prompt || "");
          if (this.curTextEl) this.curTextEl.value = p.prompt || "";
          this._renderChips();
          this._flash(`已切换：${(p.displayText || p.prompt || "").slice(0, 30)}`);
        });
        this.libListEl.appendChild(row);
      }
    }

    // ── 批文件导入（input/prompts）──
    async _loadBatchFiles() {
      if (!this.fileSel) return;
      try {
        const j = await fetchJson("/anima/prompt/list?recursive=1");
        this.batchFiles = (j.files || []).map((f) => f.name || f.path || f);
      } catch (e) {
        this.batchFiles = [];
      }
      this._renderFileSel();
      if (this.batchFiles.length === 1) this.selectBatchFile(this.batchFiles[0]);
    }

    _renderFileSel() {
      if (!this.fileSel) return;
      const cur = this.fileSel.value || "";
      this.fileSel.innerHTML = `<option value="">（选择批文件…）</option>` +
        (this.batchFiles || []).map((f) => `<option value="${escAttr(f)}" ${f === cur ? "selected" : ""}>${esc(f)}</option>`).join("");
    }

    async selectBatchFile(path) {
      if (!path) { this.batchGroups.clear(); this._renderBatchGroups(); return; }
      this.fileSel.value = path;
      try {
        const j = await fetchJson("/anima/prompt/parse?path=" + encodeURIComponent(path));
        const groups = (j.groups || []).map((g) => ({ name: g.name, count: g.count, prompts: g.prompts || [] }));
        this.batchGroups.set(path, groups);
      } catch (e) {
        this.batchGroups.set(path, []);
      }
      this._renderBatchGroups();
    }

    _renderBatchGroups() {
      if (!this.groupListEl) return;
      const groups = this.batchGroups.get(this.fileSel?.value || "") || [];
      this.groupListEl.innerHTML = "";
      if (!groups.length) {
        this.groupListEl.innerHTML = `<div class="tk-cards-empty">选择批文件后可导入组到工具箱库</div>`;
        return;
      }
      for (const g of groups) {
        const row = document.createElement("div");
        row.className = "tk-cards-group";
        const info = document.createElement("span");
        info.className = "tk-cards-group-info";
        info.textContent = `${g.name} · ${g.count}条`;
        info.title = (g.prompts[0] || "").slice(0, 200);
        const imp = document.createElement("button");
        imp.type = "button";
        imp.className = "tk-cards-btn";
        imp.textContent = "导入库";
        imp.title = "把该组所有提示词导入工具箱 prompt 库（整段条目）";
        imp.addEventListener("click", () => this.importGroupToLib(this.fileSel.value, g));
        row.appendChild(info);
        row.appendChild(imp);
        this.groupListEl.appendChild(row);
      }
    }

    async importGroupToLib(file, g) {
      let n = 0;
      for (let i = 0; i < (g.prompts || []).length; i++) {
        const prompt = String(g.prompts[i] || "").trim();
        if (!prompt) continue;
        await this.putEntry({
          id: genId("p_"),
          prompt,
          displayText: `${g.name} #${i + 1}`,
          notes: "",
          tags: [],
          images: [],
          primaryImage: "",
          categoryId: "uncategorized",
          isFavorite: false,
          kind: "prompt",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        n++;
      }
      await this.reloadAll();
      this._flash(`已导入 ${n} 条 → 工具箱库（未分类）`);
    }

    // ── 条目 CRUD（IndexedDB）──
    async putEntry(entry) {
      const db = await openDB();
      await storePut(db, PROMPT_STORE, entry);
      const idx = this.prompts.findIndex((p) => p.id === entry.id);
      if (idx >= 0) this.prompts[idx] = entry; else this.prompts.push(entry);
    }

    async delEntry(id) {
      const db = await openDB();
      await storeDel(db, PROMPT_STORE, id);
      this.prompts = this.prompts.filter((p) => p.id !== id);
    }

    // 保存卡片（tag 级 / 组合卡）。先落库（立即可用），自动翻译异步补注释（不阻塞存卡）
    async addCard(catId, card, { multi = false } = {}) {
      const en = String(card.en || card.prompt || "").trim();
      if (!en) { this._flash("内容为空"); return; }
      const cat = catId || this.curCat || "uncategorized";
      const zh0 = String(card.zh || card.notes || "").trim();
      const entry = {
        id: genId("p_"),
        prompt: en,
        displayText: en.slice(0, 40) + (en.length > 40 ? "…" : ""),
        notes: zh0,
        tags: [],
        images: [],
        primaryImage: "",
        categoryId: cat,
        isFavorite: false,
        kind: "card",
        weight: String(card.weight || "").trim(),
        lora: String(card.lora || "").trim(),
        multi: !!multi,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.putEntry(entry);
      this.curCat = cat;
      this._renderLibList();
      this._renderCatTabs();
      this._renderCards();
      this._flash(`已保存到「${CAT_NAME(this.cats.find((c) => c.id === cat))}」`);
      // 异步翻译补中文注释（失败不阻塞，卡片保留「待翻译」）
      if (!zh0) {
        translateAuto(en).then((nz) => {
          if (!nz || nz === en) return;
          entry.notes = nz;
          this.putEntry(entry).then(() => {
            this._renderCards();
            this._renderLibList();
            this._flash(`已翻译注释：${nz.slice(0, 30)}`);
          });
        }).catch(() => { /* 翻译失败保留待翻译 */ });
      }
    }

    async removeEntry(id) {
      const entry = this.prompts.find((p) => p.id === id);
      if (!entry) return;
      await this.delEntry(id);
      this.deleted.set(id, { entry });
      this._renderLibList();
      this._renderCatTabs();
      this._renderCards();
      this._flash("已删除，3 秒内可撤销", 4000);
      setTimeout(() => this.deleted.delete(id), 3000);
    }

    async undoDelete() {
      const entries = Array.from(this.deleted.entries());
      if (!entries.length) { this._flash("没有可撤销的删除"); return; }
      for (const [, v] of entries) await this.putEntry(v.entry);
      this.deleted.clear();
      this.reloadAll();
      this._flash("已恢复删除的条目");
    }

    async toggleFavorite(id) {
      const p = this.prompts.find((x) => x.id === id);
      if (!p) return;
      p.isFavorite = !p.isFavorite;
      await this.putEntry(p);
      this._renderLibList();
      this._renderCatTabs();
      this._renderCards();
    }

    // ── ② 当前提示词区 ──
    onCurInput() {
      const v = this.curTextEl.value;
      this._setW(this.w.positive, v);
      this._renderChips();
    }

    _renderChips() {
      if (!this.chipsEl) return;
      const parts = splitTags(this.curText());
      this.chipsEl.innerHTML = "";
      if (!parts.length) {
        this.chipsEl.innerHTML = `<div class="tk-cards-empty">输入提示词后自动按逗号分组（点击片段=存为卡片；右键=移除）</div>`;
        return;
      }
      for (const p of parts) {
        const chip = document.createElement("span");
        chip.className = "tk-cards-chip";
        chip.title = "点击存为卡片；右键删除该片段";
        chip.textContent = p.weight ? `(${p.text}:${p.weight})` : p.text;
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.addCard(this.curCat, { en: p.text, zh: "", weight: p.weight });
        });
        chip.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          const next = removePiece(this.curText(), p);
          this._setW(this.w.positive, next);
          if (this.curTextEl) this.curTextEl.value = next;
          this._renderChips();
        });
        this.chipsEl.appendChild(chip);
      }
    }

    // 整段存为组合卡
    async saveCurrentAsCard() {
      const text = this.curText().trim();
      if (!text) { this._flash("当前提示词为空"); return; }
      await this.addCard(this.curCat, { en: text, zh: "", weight: "" }, { multi: true });
    }

    _stashDraft() {
      const t = this.curText();
      if (t.trim()) saveDraft(t);
    }

    restoreDraft() {
      const d = loadDraft();
      if (d) {
        this._setW(this.w.positive, d);
        if (this.curTextEl) this.curTextEl.value = d;
        this._renderChips();
        this._flash("已恢复草稿");
      }
    }

    // ── ③ 卡片视图 ──
    _renderCatTabs() {
      if (!this.catTabsEl) return;
      this.catTabsEl.innerHTML = "";
      const mk = (label, id) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "tk-cards-cat" + (this.curCat === id ? " on" : "");
        tab.textContent = label;
        tab.addEventListener("click", () => { this.curCat = id; this._renderCatTabs(); this._renderCards(); this._renderLibList(); });
        this.catTabsEl.appendChild(tab);
      };
      mk("全部", "");
      for (const c of this.cats) {
        const n = this.prompts.filter((p) => p.categoryId === c.id && (this.curKind !== "card" || p.kind === "card")).length;
        mk(`${CAT_NAME(c)} (${n})`, c.id);
      }
      const addTab = document.createElement("button");
      addTab.type = "button";
      addTab.className = "tk-cards-cat tk-cards-cat-add";
      addTab.textContent = "+ 新分类";
      addTab.addEventListener("click", async () => {
        const name = prompt("新分类名称：");
        const n = (name || "").trim();
        if (!n) return;
        const cat = { id: "cat_" + Date.now(), name: n, icon: "", sortOrder: this.cats.length, parentId: undefined };
        const db = await openDB();
        await storePut(db, CAT_STORE, cat);
        this.cats.push(cat);
        this.curCat = cat.id;
        this._renderCatTabs(); this._renderCards(); this._renderLibList();
      });
      this.catTabsEl.appendChild(addTab);
    }

    _renderCards() {
      if (!this.cardGridEl) return;
      let list = this.prompts.filter((p) => p.kind === "card");
      if (this.curKind === "all") list = this.prompts.slice();
      if (this.curCat) list = list.filter((p) => p.categoryId === this.curCat);
      list.sort((a, b) => (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
      this.cardGridEl.innerHTML = "";
      if (!list.length) {
        this.cardGridEl.innerHTML = `<div class="tk-cards-empty">${this.curKind === "card" ? "暂无卡片 — 点击②区提示词片段「存为卡片」、或「浏览 LoRA」批量收藏" : "库为空"}</div>`;
        return;
      }
      for (const c of list) {
        const el = document.createElement("div");
        el.className = "tk-cards-card" + (c.isFavorite ? " star" : "");
        el.setAttribute("data-id", c.id);
        el.title = "单击追加到当前提示词（去重） · 双击编辑 · 右键删除";
        const en = document.createElement("div");
        en.className = "tk-cards-card-en";
        en.textContent = String(c.prompt || "").length > 60 ? String(c.prompt).slice(0, 58) + "…" : (c.prompt || "");
        en.title = (c.prompt || "") + (c.lora ? `\nLoRA: ${c.lora}` : "");
        const zh = document.createElement("div");
        zh.className = "tk-cards-card-zh";
        zh.textContent = c.notes || "（待翻译）";
        const meta = document.createElement("div");
        meta.className = "tk-cards-card-meta";
        meta.innerHTML = `<span class="tk-cards-star" title="星标置顶">${c.isFavorite ? "★" : "☆"}</span>` +
          (c.weight ? `<span class="tk-cards-w">${esc(c.weight)}</span>` : "") +
          (c.lora ? `<span class="tk-cards-lora">L:${esc(String(c.lora).split("/").pop().replace(/\.safetensors$/, ""))}</span>` : "") +
          (c.multi ? `<span class="tk-cards-multi">组合</span>` : "");
        el.appendChild(en);
        el.appendChild(zh);
        el.appendChild(meta);
        el.addEventListener("click", (ev) => {
          if (ev.target.closest(".tk-cards-star")) return;
          const cur = this.curText();
          const next = appendCardToPrompt(cur, c);
          this._setW(this.w.positive, next);
          if (this.curTextEl) this.curTextEl.value = next;
          this._renderChips();
          if (next === cur) this._flash("该卡片已在提示词中（已去重）");
        });
        el.addEventListener("dblclick", (ev) => {
          if (ev.target.closest(".tk-cards-star")) return;
          this.beginEdit(c.id, el, c);
        });
        el.querySelector(".tk-cards-star").addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.toggleFavorite(c.id);
        });
        el.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          this.removeEntry(c.id);
        });
        this.cardGridEl.appendChild(el);
      }
    }

    // 就地编辑（双击卡片）
    beginEdit(id, cardEl, c) {
      const orig = cardEl.innerHTML;
      cardEl.innerHTML = `<div class="tk-cards-edit">
        <input value="${escAttr(c.prompt || "")}" data-f="en" placeholder="英文 tag">
        <input value="${escAttr(c.notes || "")}" data-f="zh" placeholder="中文注释（可自定义）">
        <input value="${escAttr(c.weight || "")}" data-f="weight" placeholder="权重(1.2)">
        <input value="${escAttr(c.lora || "")}" data-f="lora" placeholder="LoRA 文件名(可选)">
        <div class="tk-cards-edit-btns">
          <button type="button" class="tk-cards-btn" data-a="save">✓ 保存</button>
          <button type="button" class="tk-cards-btn" data-a="cancel">✕</button></div></div>`;
      const inputs = cardEl.querySelectorAll("input");
      const commit = async () => {
        c.prompt = inputs[0].value.trim() || c.prompt;
        c.notes = inputs[1].value.trim();
        c.weight = inputs[2].value.trim();
        c.lora = inputs[3].value.trim();
        c.updatedAt = Date.now();
        await this.putEntry(c);
        this._renderCards();
        this._renderLibList();
        this._flash("已保存");
      };
      cardEl.querySelector('[data-a="save"]').addEventListener("click", commit);
      cardEl.querySelector('[data-a="cancel"]').addEventListener("click", () => { cardEl.innerHTML = orig; });
      inputs.forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") cardEl.innerHTML = orig; }));
      inputs[0].focus();
    }

    // ── 工具：剪切板 / PNG / LoRA / 批量补翻 / 导出 ──

    async importClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) { this._flash("剪切板为空"); return; }
        this._setW(this.w.positive, text.trim());
        if (this.curTextEl) this.curTextEl.value = text.trim();
        this._renderChips();
        this._flash("已从剪切板导入并拆分");
      } catch (e) {
        this._flash("无法读取剪切板：" + (e.message || e));
      }
    }

    showPngDialog() {
      const path = prompt("输入图片路径（相对 input/ 或绝对路径，PNG 含工作流元数据）：");
      const p = (path || "").trim();
      if (!p) return;
      (async () => {
        try {
          const r = await postJson("/anima/cards/image", { path: p });
          if (!r.ok) { this._flash(r.error || "解析失败"); return; }
          if (!r.positive) { this._flash("该 PNG 没有可用的提示词元数据"); return; }
          this._setW(this.w.positive, r.positive);
          if (this.curTextEl) this.curTextEl.value = r.positive;
          this._renderChips();
          this._flash(`已从图片解析提示词（${r.positive.length} 字符）`);
        } catch (e) {
          this._flash("图片解析失败：" + (e.message || e));
        }
      })();
    }

    async showLoraDialog() {
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      overlay.innerHTML = `<div class="tk-cards-overlay-box">
        <div class="tk-cards-overlay-head"><b>浏览 LoRA · 一键收藏触发词卡片</b><button type="button" class="tk-cards-btn" data-a="close">✕</button></div>
        <input class="tk-cards-search" placeholder="搜索 LoRA 名称…">
        <div class="tk-cards-lora-list"></div></div>`;
      document.body.appendChild(overlay);
      const listEl = overlay.querySelector(".tk-cards-lora-list");
      const searchEl = overlay.querySelector(".tk-cards-search");
      const close = () => overlay.remove();
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      searchEl.addEventListener("input", render);
      let loras = [];
      try {
        const j = await fetchJson("/anima/loras");
        loras = (j.loras || []).slice().sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
      } catch (e) {
        listEl.innerHTML = `<div class="tk-cards-empty">LoRA 列表加载失败：${esc(e.message || e)}</div>`;
        return;
      }
      const W = [];
      async function render() {
        const q = (searchEl.value || "").toLowerCase();
        const rows = loras.filter((l) => !q || (l.name || "").toLowerCase().includes(q) || (l.filename || "").toLowerCase().includes(q)).slice(0, 60);
        listEl.innerHTML = rows.map((l) => `<div class="tk-cards-lora-row" data-name="${escAttr(l.name)}">
          <span class="tk-cards-lora-name" title="${escAttr(l.filename)}">${esc(l.name)}</span>
          <button type="button" class="tk-cards-btn" data-a="save">⊙ 存触发词卡</button>
          <button type="button" class="tk-cards-btn" data-a="add">＋ 追加触发词</button></div>`).join("") ||
          `<div class="tk-cards-empty">无匹配 LoRA</div>`;
        listEl.querySelectorAll(".tk-cards-lora-row").forEach((row) => {
          const name = row.getAttribute("data-name");
          row.querySelector('[data-a="save"]').addEventListener("click", async () => {
            if (W.includes(name)) return;
            W.push(name);
            try {
              const r = await fetchJson("/anima/cards/lora-triggers?name=" + encodeURIComponent(name));
              const words = r.triggerWords || [];
              if (!words.length) { alert(`「${name}」没有找到触发词（bridge/Civitai 均无）`); return; }
              for (const w of words) {
                const cat = this.cats.find((c) => /lora/i.test(c.name))?.id || "cat_fav";
                await this.addCard(cat, { en: w, zh: "", weight: "", lora: name + ".safetensors" });
              }
              this._flash(`已收藏 ${words.length} 张触发词卡片`);
            } catch (e) {
              this._flash("触发词获取失败：" + (e.message || e));
            } finally {
              const i = W.indexOf(name); if (i >= 0) W.splice(i, 1);
            }
          });
          row.querySelector('[data-a="add"]').addEventListener("click", async () => {
            try {
              const r = await fetchJson("/anima/cards/lora-triggers?name=" + encodeURIComponent(name));
              const words = r.triggerWords || [];
              if (!words.length) { alert(`「${name}」没有找到触发词`); return; }
              let text = this.curText();
              for (const w of words) {
                const can = appendCardToPrompt(text, { prompt: w });
                if (can !== text) text = can;
              }
              this._setW(this.w.positive, text);
              if (this.curTextEl) this.curTextEl.value = text;
              this._renderChips();
              const lw = (this.w.lora_syntax?.value || "").trim();
              this._setW(this.w.lora_syntax, lw ? lw + " <lora:" + name + ":1.0>" : "<lora:" + name + ":1.0>");
              this._flash(`已追加触发词 + <lora:${name}:1.0> → lora_syntax`);
            } catch (e) {
              this._flash("触发词获取失败：" + (e.message || e));
            }
          });
        });
      }
      render();
    }

    async batchTranslate() {
      const todo = this.prompts.filter((p) => p.kind === "card" && !String(p.notes || "").trim() && String(p.prompt || "").trim());
      if (!todo.length) { this._flash("没有待翻译的卡片"); return; }
      this._flash(`批量翻译中：${todo.length} 张（DeepLX → DashScope 回退）`);
      let okN = 0;
      const workers = Array.from({ length: 3 }, async () => {
        while (todo.length) {
          const p = todo.pop();
          try {
            const zh = await translateAuto(p.prompt);
            if (zh) { p.notes = zh; okN++; await this.putEntry(p); }
          } catch (e) { /* 单卡失败跳过 */ }
        }
      });
      await Promise.all(workers);
      this._renderCards();
      this._renderLibList();
      this._flash(`批量翻译完成：成功 ${okN} / ${todo.length + okN}`);
    }

    async exportCards() {
      const name = prompt("导出文件名（写入 input/prompts/）：", "prompt_cards_" + new Date().toISOString().slice(0, 10));
      const n = (name || "").trim();
      if (!n) return;
      const groups = [];
      for (const c of this.cats) {
        const cards = this.prompts.filter((p) => p.categoryId === c.id && p.kind === "card" && String(p.prompt || "").trim());
        if (!cards.length) continue;
        groups.push({
          name: CAT_NAME(c),
          cards: cards.map((p) => ({ en: p.prompt, zh: p.notes, weight: p.weight || "" })),
        });
      }
      if (!groups.length) { this._flash("卡片库为空"); return; }
      try {
        const r = await postJson("/anima/cards/export", { name: n, groups });
        if (r.ok) this._flash(`已导出：${r.path}`);
        else this._flash(r.error || "导出失败");
      } catch (e) {
        this._flash("导出失败：" + (e.message || e));
      }
    }

    _flash(msg, ms = 2500) {
      if (!this.statusEl) return;
      this.statusEl.textContent = msg;
      clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => { if (this.statusEl) this.statusEl.textContent = ""; }, ms);
    }

    // ── build ──
    // 防御：真实浏览器里 nodeCreated 回调可能早于节点 widgets 初始化，
    // 导致 this.w.positive 为 undefined → 所有 _setW 静默空转（"功能全挂"）。
    // 这里延迟重试直到三个核心 widget 就绪后再构建 UI。
    build() {
      const tryInit = (attempt) => {
        if (attempt > 30) {
          console.error("[TK Prompt Cards] widgets 长时间未就绪，放弃构建（请确认节点为标准 TK Prompt Cards）");
          return;
        }
        const w = (n) => this.node.widgets?.find((x) => x.name === n);
        if (!w("positive") || !w("opt_text") || !w("lora_syntax")) {
          setTimeout(() => tryInit(attempt + 1), 300);
          return;
        }
        this.w.positive = w("positive");
        this.w.opt_text = w("opt_text");
        this.w.lora_syntax = w("lora_syntax");
        this._initUI();
      };
      tryInit(0);
    }

    _initUI() {
      const container = document.createElement("div");
      container.className = "tk-cards-ui";
      this.rootEl = container;

      let mounted = false;
      try {
        if (typeof this.node.addDOMWidget === "function") {
          this.node.addDOMWidget("anima_cards_panel", "custom", container, { serialize: false, hideOnZoom: false });
          mounted = true;
        } else {
          const firstEl = this.node.widgets?.map((w) => w.element).find(Boolean);
          if (firstEl && firstEl.parentNode) { firstEl.parentNode.insertBefore(container, firstEl); mounted = true; }
          else if (this.node.element) { this.node.element.prepend(container); mounted = true; }
        }
      } catch (e) { console.error("[TK Prompt Cards] UI 挂载失败:", e); }
      if (!mounted) {
        setTimeout(() => {
          try {
            if (!container.isConnected && this.node.element) { this.node.element.prepend(container); mounted = container.isConnected; }
          } catch (e) {}
          if (!container.isConnected) console.error("[TK Prompt Cards] UI 面板挂载失败：已保留标准 widget");
        }, 0);
      }
      if (mounted) {
        for (const w of this.node.widgets || []) {
          if (!w || w.name === "anima_cards_panel") continue;
          w.hidden = true; w.options = w.options || {}; w.options.hidden = true;
          if (w.element) w.element.style.display = "none";
          if (typeof w.draw === "function") w.draw = () => {};
        }
      }

      this.statusEl = document.createElement("div");
      this.statusEl.className = "tk-cards-status";
      container.appendChild(this.statusEl);

      // ═══ ① TK Toolkit prompt 库区 ═══
      const libSec = document.createElement("div");
      libSec.className = "tk-cards-sec";
      const libHead = document.createElement("div");
      libHead.className = "tk-cards-sec-head";
      libHead.innerHTML = `<b>① 工具箱 prompt 库</b>`;
      const libBtns = document.createElement("div");
      libBtns.className = "tk-cards-sec-btns";
      const libTab = document.createElement("button");
      libTab.type = "button";
      libTab.className = "tk-cards-btn";
      libTab.textContent = "📂 批文件导入";
      libTab.addEventListener("click", () => this._switchLibPane("batch"));
      const libTabAll = document.createElement("button");
      libTabAll.type = "button";
      libTabAll.className = "tk-cards-btn tk-cards-btn-main";
      libTabAll.textContent = "📚 库浏览";
      libTabAll.addEventListener("click", () => this._switchLibPane("lib"));
      libBtns.appendChild(libTabAll);
      libBtns.appendChild(libTab);
      libHead.appendChild(libBtns);
      this.libSearchEl = document.createElement("input");
      this.libSearchEl.className = "tk-cards-search";
      this.libSearchEl.placeholder = "搜索库（prompt/标题/注释/tag）…";
      this.libSearchEl.addEventListener("input", () => { this.search = this.libSearchEl.value; this._renderLibList(); });
      this.libListEl = document.createElement("div");
      this.libListEl.className = "tk-cards-lib-list";
      this.fileSel = document.createElement("select");
      this.fileSel.className = "tk-cards-select";
      this.fileSel.style.display = "none";
      this.fileSel.addEventListener("change", () => this.selectBatchFile(this.fileSel.value));
      this.groupListEl = document.createElement("div");
      this.groupListEl.className = "tk-cards-groups";
      this.groupListEl.style.display = "none";
      libSec.appendChild(libHead);
      libSec.appendChild(this.libSearchEl);
      libSec.appendChild(this.libListEl);
      libSec.appendChild(this.fileSel);
      libSec.appendChild(this.groupListEl);
      container.appendChild(libSec);

      // ═══ ② 当前提示词区 ═══
      const curSec = document.createElement("div");
      curSec.className = "tk-cards-sec";
      const curHead = document.createElement("div");
      curHead.className = "tk-cards-sec-head";
      curHead.innerHTML = `<b>② 当前提示词</b>`;
      const curBtns = document.createElement("div");
      curBtns.className = "tk-cards-sec-btns";
      const clipboardBtn = document.createElement("button");
      clipboardBtn.type = "button"; clipboardBtn.className = "tk-cards-btn"; clipboardBtn.textContent = "📋 剪切板";
      clipboardBtn.addEventListener("click", () => this.importClipboard());
      const pngBtn = document.createElement("button");
      pngBtn.type = "button"; pngBtn.className = "tk-cards-btn"; pngBtn.textContent = "🖼 解析图片";
      pngBtn.addEventListener("click", () => this.showPngDialog());
      const draftBtn = document.createElement("button");
      draftBtn.type = "button"; draftBtn.className = "tk-cards-btn"; draftBtn.textContent = "↩ 草稿";
      draftBtn.addEventListener("click", () => this.restoreDraft());
      const clearBtn = document.createElement("button");
      clearBtn.type = "button"; clearBtn.className = "tk-cards-btn"; clearBtn.textContent = "清空";
      clearBtn.addEventListener("click", () => { this._setW(this.w.positive, ""); if (this.curTextEl) this.curTextEl.value = ""; this._renderChips(); });
      curBtns.appendChild(clipboardBtn); curBtns.appendChild(pngBtn); curBtns.appendChild(draftBtn); curBtns.appendChild(clearBtn);
      curHead.appendChild(curBtns);
      this.curTextEl = document.createElement("textarea");
      this.curTextEl.className = "tk-cards-textarea";
      this.curTextEl.placeholder = "当前提示词（点库条目/卡片/粘贴/解析图片填充）";
      this.curTextEl.value = this.w.positive?.value || "";
      this.curTextEl.addEventListener("input", () => this.onCurInput());
      this.chipsEl = document.createElement("div");
      this.chipsEl.className = "tk-cards-chips";
      const curTools = document.createElement("div");
      curTools.className = "tk-cards-cur-tools";
      const saveAllBtn = document.createElement("button");
      saveAllBtn.type = "button"; saveAllBtn.className = "tk-cards-btn tk-cards-btn-main";
      saveAllBtn.textContent = "＋ 整段存组合卡";
      saveAllBtn.title = "把当前提示词整段存入当前分类（点它=整段追加，展开=内部 tag 可拆）";
      saveAllBtn.addEventListener("click", () => this.saveCurrentAsCard());
      const undoBtn = document.createElement("button");
      undoBtn.type = "button"; undoBtn.className = "tk-cards-btn";
      undoBtn.textContent = "↩ 撤销删除";
      undoBtn.addEventListener("click", () => this.undoDelete());
      curTools.appendChild(saveAllBtn); curTools.appendChild(undoBtn);
      curSec.appendChild(curHead);
      curSec.appendChild(this.curTextEl);
      curSec.appendChild(this.chipsEl);
      curSec.appendChild(curTools);
      container.appendChild(curSec);

      // ═══ ③ 卡片视图区 ═══
      const cardSec = document.createElement("div");
      cardSec.className = "tk-cards-sec";
      const cardHead = document.createElement("div");
      cardHead.className = "tk-cards-sec-head";
      cardHead.innerHTML = `<b>③ 卡片视图</b>`;
      const cardBtns = document.createElement("div");
      cardBtns.className = "tk-cards-sec-btns";
      const kindAll = document.createElement("button");
      kindAll.type = "button"; kindAll.className = "tk-cards-btn";
      kindAll.textContent = "全部";
      kindAll.addEventListener("click", () => { this.curKind = this.curKind === "all" ? "card" : "all"; kindAll.classList.toggle("tk-cards-btn-main", this.curKind === "all"); this._renderCatTabs(); this._renderCards(); });
      const loraBtn = document.createElement("button");
      loraBtn.type = "button"; loraBtn.className = "tk-cards-btn tk-cards-btn-main"; loraBtn.textContent = "📚 浏览 LoRA";
      loraBtn.addEventListener("click", () => this.showLoraDialog());
      const tlBtn = document.createElement("button");
      tlBtn.type = "button"; tlBtn.className = "tk-cards-btn"; tlBtn.textContent = "🌐 批量补翻";
      tlBtn.addEventListener("click", () => this.batchTranslate());
      const exBtn = document.createElement("button");
      exBtn.type = "button"; exBtn.className = "tk-cards-btn"; exBtn.textContent = "⇪ 导出批文件";
      exBtn.addEventListener("click", () => this.exportCards());
      cardBtns.appendChild(kindAll); cardBtns.appendChild(loraBtn); cardBtns.appendChild(tlBtn); cardBtns.appendChild(exBtn);
      cardHead.appendChild(cardBtns);
      this.catTabsEl = document.createElement("div");
      this.catTabsEl.className = "tk-cards-cats";
      this.cardGridEl = document.createElement("div");
      this.cardGridEl.className = "tk-cards-grid";
      cardSec.appendChild(cardHead);
      cardSec.appendChild(this.catTabsEl);
      cardSec.appendChild(this.cardGridEl);
      container.appendChild(cardSec);

      // 初始
      this._renderChips();
      this._renderCatTabs();
      this._renderCards();
      this._renderLibList();
      this.reloadAll();
      this._loadBatchFiles();
      if (this.w.positive?.value) this._renderChips();
    }

    _switchLibPane(which) {
      const lib = which === "lib";
      this.libSearchEl.style.display = lib ? "" : "none";
      this.libListEl.style.display = lib ? "" : "none";
      this.fileSel.style.display = lib ? "none" : "";
      this.groupListEl.style.display = lib ? "none" : "";
      if (!lib) this._loadBatchFiles();
    }
  }

  // ── 样式 ──
  function injectStyle() {
    if (document.getElementById("anima-cards-style")) return;
    const s = document.createElement("style");
    s.id = "anima-cards-style";
    s.textContent = `
.tk-cards-ui { display:flex; flex-direction:column; gap:6px; width:100%; min-width:280px; font-size:11px; color:var(--fg-color,#ccc); }
.tk-cards-status { font-size:10px; color:#8b5cf6; min-height:12px; }
.tk-cards-sec { display:flex; flex-direction:column; gap:4px; border:1px solid var(--border-color,#2a2a2a); border-radius:6px; padding:5px; background:rgba(255,255,255,0.02); }
.tk-cards-sec-head { display:flex; align-items:center; justify-content:space-between; font-size:11px; color:#c9b8ff; }
.tk-cards-sec-btns { display:flex; gap:4px; flex-wrap:wrap; }
.tk-cards-btn { font-size:10px; padding:2px 8px; background:var(--comfy-input-bg,#222); color:var(--fg-color,#bbb); border:1px solid var(--border-color,#4a4a52); border-radius:4px; cursor:pointer; transition:border-color .15s,color .15s,background .15s; }
.tk-cards-btn:hover { border-color:#8b5cf6; color:#d6c8ff; }
.tk-cards-btn:disabled { opacity:.4; cursor:default; }
.tk-cards-btn-main { background:rgba(139,92,246,0.2); border-color:#8b5cf6; color:#d6c8ff; font-weight:600; }
.tk-cards-select { width:100%; background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#444); border-radius:4px; font-size:10px; padding:3px 4px; max-width:100%; }
.tk-cards-search { width:100%; box-sizing:border-box; background:var(--comfy-input-bg,#1b1e26); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#383d4a); border-radius:4px; font-size:10px; padding:3px 6px; }
.tk-cards-search:focus { outline:none; border-color:#8b5cf6; }
.tk-cards-lib-list { max-height:170px; overflow:auto; display:flex; flex-direction:column; gap:3px; }
.tk-cards-lib-row { border:1px solid var(--border-color,#2e2e34); border-radius:5px; padding:3px 5px; cursor:pointer; display:flex; flex-direction:column; gap:2px; }
.tk-cards-lib-row:hover { border-color:#8b5cf6; background:rgba(139,92,246,.07); }
.tk-cards-lib-row.is-card { border-left:3px solid #8b5cf6; }
.tk-cards-lib-head { display:flex; justify-content:space-between; align-items:center; gap:6px; }
.tk-cards-lib-title { font-size:10px; color:#e8e8e8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tk-cards-lib-fav { color:#f5c518; font-size:10px; }
.tk-cards-lib-sub { font-size:9px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tk-cards-groups { max-height:150px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
.tk-cards-group { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:4px; }
.tk-cards-group:hover { background:rgba(139,92,246,.08); }
.tk-cards-group-info { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:help; }
.tk-cards-textarea { width:100%; min-height:64px; box-sizing:border-box; background:var(--comfy-input-bg,#1b1e26); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#383d4a); border-radius:4px; font-size:11px; padding:4px 6px; resize:vertical; }
.tk-cards-textarea:focus { outline:none; border-color:#8b5cf6; }
.tk-cards-chips { display:flex; flex-wrap:wrap; gap:4px; max-height:90px; overflow:auto; }
.tk-cards-chip { font-size:10px; padding:2px 7px; background:rgba(139,92,246,.12); border:1px solid rgba(139,92,246,.4); border-radius:10px; cursor:pointer; color:#d6c8ff; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tk-cards-chip:hover { border-color:#8b5cf6; background:rgba(139,92,246,.25); }
.tk-cards-cur-tools { display:flex; gap:4px; }
.tk-cards-cats { display:flex; flex-wrap:wrap; gap:4px; }
.tk-cards-cat { font-size:10px; padding:2px 8px; background:var(--comfy-input-bg,#222); color:var(--fg-color,#999); border:1px solid var(--border-color,#444); border-radius:10px; cursor:pointer; }
.tk-cards-cat:hover { border-color:#8b5cf6; color:#d6c8ff; }
.tk-cards-cat.on { background:rgba(139,92,246,.2); border-color:#8b5cf6; color:#e6dcff; font-weight:600; }
.tk-cards-cat-add { border-style:dashed; color:#888; }
.tk-cards-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:5px; max-height:240px; overflow:auto; }
.tk-cards-card { border:1px solid var(--border-color,#383d4a); border-radius:6px; padding:4px 6px; cursor:pointer; background:rgba(255,255,255,.02); display:flex; flex-direction:column; gap:2px; transition:border-color .15s,background .15s; }
.tk-cards-card:hover { border-color:#8b5cf6; background:rgba(139,92,246,.08); }
.tk-cards-card.star { border-color:#f5c518; background:rgba(245,197,24,.05); }
.tk-cards-card-en { font-size:10px; color:#e8e8e8; word-break:break-all; }
.tk-cards-card-zh { font-size:9px; color:#9a9aa2; }
.tk-cards-card-meta { display:flex; gap:4px; align-items:center; font-size:9px; color:#888; }
.tk-cards-star { cursor:pointer; color:#f5c518; font-size:11px; }
.tk-cards-w { color:#c9b8ff; }
.tk-cards-lora { color:#7ec8ff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100px; }
.tk-cards-multi { color:#ffb86c; border:1px solid rgba(255,184,108,.4); border-radius:3px; padding:0 3px; }
.tk-cards-edit { display:flex; flex-direction:column; gap:3px; }
.tk-cards-edit input { background:var(--comfy-input-bg,#1b1e26); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#444); border-radius:3px; font-size:10px; padding:2px 4px; width:100%; box-sizing:border-box; }
.tk-cards-edit input:focus { outline:none; border-color:#8b5cf6; }
.tk-cards-edit-btns { display:flex; gap:4px; }
.tk-cards-empty { font-size:10px; color:var(--fg-color,#888); padding:3px 0; }
.tk-cards-overlay { position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; }
.tk-cards-overlay-box { width:min(560px,90vw); max-height:80vh; background:#1b1e26; border:1px solid #8b5cf6; border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:8px; }
.tk-cards-overlay-head { display:flex; justify-content:space-between; align-items:center; color:#c9b8ff; }
.tk-cards-lora-list { overflow:auto; display:flex; flex-direction:column; gap:3px; max-height:55vh; }
.tk-cards-lora-row { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:4px; }
.tk-cards-lora-row:hover { background:rgba(139,92,246,.08); }
.tk-cards-lora-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#ddd; }
`;
    document.head.appendChild(s);
  }

  // ── 扩展注册 ──
  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);
    api.registerExtension({
      name: "TK.PromptCards.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        const nd = nodeData || {};
        const names = [nd.name, nd.display_name, nd.title, nd.type, nd.comfyClass].filter(Boolean).map(String);
        const isOurs = names.includes(NODE_NAME) || names.includes("TKPromptCards");
        if (!isOurs) return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
          const r = orig?.apply(this, arguments);
          if (this._cardsUI) return r;
          const w = (n) => this.widgets?.find((x) => x.name === n);
          const ui = new CardsUI(this, {
            positive: w("positive"),
            opt_text: w("opt_text"),
            lora_syntax: w("lora_syntax"),
          });
          ui.w.extra_dirs = null;
          this._cardsUI = ui;
          ui.build();
          return r;
        };
      },
      async nodeCreated(node) {
        const cls = String(node?.type || node?.comfyClass || node?.constructor?.type || "");
        if (cls !== "TKPromptCards" || node._cardsUI) return;
        try {
          const w = (n) => node.widgets?.find((x) => x.name === n);
          const ui = new CardsUI(node, {
            positive: w("positive"),
            opt_text: w("opt_text"),
            lora_syntax: w("lora_syntax"),
          });
          ui.w.extra_dirs = null;
          node._cardsUI = ui;
          ui.build();
        } catch (e) {
          console.error("[TK Prompt Cards] nodeCreated 构建失败:", e);
        }
      },
      async setup() {
        window.__tkCardsDebug = window.__tkCardsDebug || {};
        window.__tkCardsDebug.splitTags = splitTags;
        window.__tkCardsDebug.appendCardToPrompt = appendCardToPrompt;
      },
    });
  }

  injectStyle();
  init();
})();