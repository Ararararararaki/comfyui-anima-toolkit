// TK Prompt Cards 节点前端 —— 卡片库提示词编辑器
//
// 数据层（2026-08-24 统一）：
//   卡片库（tag 级词组）→ 后端 input/prompt_cards/cards.json（v2 信封，单一数据源），
//     换浏览器 / 清站点数据不丢；旧浏览器 IndexedDB「anima-tk-cards」仅作一次性迁移源；
//     支持 JSON 备份导出 / 替换式导入（「导出库 / 导入库」按钮）。
//   工具箱 prompt 库 → 直读 TK Toolkit（civitai 面板）的 IndexedDB「anima-lora」
//     （面板由 ComfyUI 同域服务，节点与面板共享同一 prompt 库，改动即时互见）
//     prompts 表：面板条目（整段提示词）与节点卡片（tag 级，kind='card'）共存；
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
//      导出批文件 / 导出库 JSON 备份 / 导入库恢复
//
// 后端复用：/api/translate（五源回退）、/anima/cards（卡片库全量读写）、
//   /anima/cards/image（PNG 解析）、/anima/cards/lora-triggers /anima/loras、
//   /anima/cards/export（导出批文件）、/anima/prompt/list|parse（批文件浏览/导入）
//
// 2026-08-17 新建；08-18 工具箱库切为 TK Toolkit IndexedDB 联动；
// 08-24 卡片库切回后端 cards.json（v2 信封，单一数据源 + 备份导出/导入）。

(function () {
  const NODE_NAME = "TK Prompt Cards";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const escAttr = (s) => esc(s);

  function apiFetch(path, opts) {
    // 新前端 fetchApi 会给路径自动加 /api 前缀（/anima/* 自定义路由会被改成
    // /api/anima/* 导致 404）：这里直接用原生 fetch（同源页面最稳），
    // 仅在 fetch 不可用时回退 fetchApi。
    if (typeof fetch === "function") return fetch(path, opts);
    const api = window.comfyAPI?.api?.api || window.api;
    if (api?.fetchApi) return api.fetchApi(path, opts);
    return Promise.reject(new Error("fetch 不可用"));
  }
  async function fetchJson(path, opts) {
    // 默认 12s 超时；opts.timeout 可覆盖（LLM 分类等长任务传更长）
    const timeoutMs = (opts && opts.timeout) || 12000;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await apiFetch(path, ctrl ? { ...(opts || {}), signal: ctrl.signal } : opts);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function postJson(path, body, timeoutMs) {
    return fetchJson(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeout: timeoutMs,
    });
  }

  // ── IndexedDB：两个独立库 ──
  // ① anima-lora  = TK Toolkit 面板的 prompt 库（完整生词条+预览图，只读浏览/切换/导入，绝不写入卡片）
  // ② anima-tk-cards = 本节点专用「词组卡片库」（tag 级短语，独立分类，避免污染 prompt 库）
  const DB_NAME = "anima-lora";
  const PROMPT_STORE = "prompts";
  const CAT_STORE = "promptCategories";
  const CARD_DB = "anima-tk-cards";
  const CARD_STORE = "cards";
  const CARD_CAT_STORE = "cardCategories";

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

  // 卡片专用库（本节点独占，版本自持）
  // 自愈：若库已存在但缺表（v1 空库被外部 open 创建过、未触发 upgradeneeded），
  // 关闭后删库重建（独占库无数据损失风险）。
  let _cardDbPromise = null;
  function openCardDB() {
    if (_cardDbPromise) return _cardDbPromise;
    _cardDbPromise = new Promise((resolve, reject) => {
      const attempt = () => {
        const req = indexedDB.open(CARD_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(CARD_STORE)) {
            db.createObjectStore(CARD_STORE, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(CARD_CAT_STORE)) {
            db.createObjectStore(CARD_CAT_STORE, { keyPath: "id" });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(CARD_STORE) || !db.objectStoreNames.contains(CARD_CAT_STORE)) {
            const name = db.name;
            db.close();
            const del = indexedDB.deleteDatabase(name);
            del.onsuccess = () => attempt();
            del.onerror = () => reject(del.error);
            return;
          }
          resolve(db);
        };
        req.onerror = () => reject(req.error);
      };
      attempt();
    });
    return _cardDbPromise;
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

  // ── 卡片库统一存储（2026-08-24：IndexedDB → 后端 cards.json v2 信封 单一数据源）──
  // 卡片库（tag 级词组）改由后端 /anima/cards 持久化（input/prompt_cards/cards.json），
  // 换浏览器/清站点数据不丢；IndexedDB 旧卡库仅做一次性迁移源。
  // 前端对象字段 {prompt, notes, isFavorite, createdAt...} ↔ v2 信封 {en, zh, star, ts...}
  let _cardLibCache = null; // {version, categories, cards} 后端正本内存镜像
  let _cardLibSaveChain = Promise.resolve();

  function cardFromEnvelope(c) {
    return {
      id: String(c.id || genId("c_")),
      prompt: String(c.en || ""),
      notes: String(c.zh || ""),
      weight: String(c.weight || ""),
      lora: String(c.lora || ""),
      src: String(c.src || ""),
      multi: !!c.multi,
      categories: Array.isArray(c.categories) ? c.categories.slice() : [],
      categoryId: (Array.isArray(c.categories) && c.categories[0]) || "",
      isFavorite: !!c.star,
      ts: Number(c.ts || Date.now()),
      createdAt: Number(c.ts || Date.now()),
      updatedAt: Number(c.ts || Date.now()),
    };
  }
  function cardToEnvelope(p) {
    return {
      id: String(p.id || genId("c_")),
      en: String(p.prompt || "").trim(),
      zh: String(p.notes || ""),
      weight: String(p.weight || ""),
      star: !!p.isFavorite,
      lora: String(p.lora || ""),
      src: String(p.src || ""),
      ts: Number(p.ts || p.updatedAt || Date.now()),
      multi: !!p.multi,
      categories: catIdsOf(p),
    };
  }

  // 一次性迁移：后端卡库为空且旧 IndexedDB 卡库有数据 → 读旧库组装 v2
  async function _migrateCardDbFromIndexedDB() {
    try {
      const db = await openCardDB();
      const [cards, ccats] = await Promise.all([
        storeAll(db, CARD_STORE),
        storeAll(db, CARD_CAT_STORE),
      ]);
      if ((!cards || !cards.length) && (!ccats || !ccats.length)) return null;
      const cats = (ccats && ccats.length)
        ? ccats.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
        : CARD_DEFAULT_CATS.map((c) => ({ ...c }));
      const list = (cards || [])
        .map((c) => cardToEnvelope({ ...(c || {}), prompt: String(c.en || c.prompt || "") }))
        .filter((c) => c.en);
      return { version: 2, updated: Date.now(), categories: cats, cards: list };
    } catch (e) {
      console.warn("[TK Prompt Cards] 旧 IndexedDB 卡片库迁移读取失败:", e);
      return null;
    }
  }

  async function loadCardLib() {
    const r = await fetchJson("/anima/cards");
    if (!r || !Array.isArray(r.cards) || !Array.isArray(r.categories)) {
      throw new Error("卡片库读取失败（后端返回异常）");
    }
    if (!r.cards.length && !r.categories.length) {
      // 后端空库且本地旧 IndexedDB 有卡 → 迁移（一次性）并写回
      const migrated = await _migrateCardDbFromIndexedDB();
      if (migrated && migrated.cards.length) {
        r.cards = migrated.cards;
        r.categories = migrated.categories;
        r.version = 2;
        await saveCardLib(r);
        console.log(`[TK Prompt Cards] 已从旧 IndexedDB 迁移 ${r.cards.length} 张卡片到后端 cards.json`);
      }
    }
    _cardLibCache = r;
    return r;
  }

  async function saveCardLib(cache) {
    if (cache) _cardLibCache = cache;
    if (!_cardLibCache) throw new Error("卡片库尚未加载");
    const body = _cardLibCache;
    const run = async () => {
      const r = await postJson("/anima/cards", body);
      if (!r || !r.ok) throw new Error((r && r.error) || "卡片库保存失败");
    };
    _cardLibSaveChain = _cardLibSaveChain.then(run, run);
    await _cardLibSaveChain;
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
  // 卡片专用库默认分类（tag 级词组，独立于 prompt 库分类）
  const CARD_DEFAULT_CATS = [
    { id: "card_all", name: "通用", icon: "", sortOrder: 0 },
    { id: "card_char", name: "角色", icon: "", sortOrder: 1 },
    { id: "card_style", name: "画风", icon: "", sortOrder: 2 },
    { id: "card_pose", name: "姿势", icon: "", sortOrder: 3 },
    { id: "card_scene", name: "场景", icon: "", sortOrder: 4 },
    { id: "card_quality", name: "质量词", icon: "", sortOrder: 5 },
    { id: "card_lora", name: "LoRA 触发词", icon: "", sortOrder: 6 },
  ];
  const CAT_NAME = (c) => (c && c.name) || "未分类";

  function genId(prefix) {
    return (prefix || "p_") + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

  // ── 卡片多分类（categories 数组；兼容存量 categoryId 单值）──
  function catIdsOf(card) {
    if (Array.isArray(card.categories)) {
      const ids = card.categories.filter(Boolean);
      if (ids.length) return ids;
    }
    if (card.categoryId) return [card.categoryId];
    return [];
  }
  // 归一化：categoryId 迁移进 categories（第一个），后续统一用 categories
  function normalizeCardCats(card) {
    const ids = catIdsOf(card);
    if (!Array.isArray(card.categories) || JSON.stringify(card.categories) !== JSON.stringify(ids)) {
      card.categories = ids;
    }
    card.categoryId = ids[0] || ""; // 兼容旧字段（主分类）
    return card;
  }
  const CAT_HINTS = {
    "通用": "未归类/通用标签",
    "角色": "动漫角色名/人名/角色昵称",
    "画风": "风格/画师/渲染方式/画质风格",
    "姿势": "动作/姿态/体位/肢体",
    "场景": "环境/背景/地点/道具",
    "质量词": "品质评分词：masterpiece、best quality、highres、score 等",
    "LoRA 触发词": "LoRA/模型的触发词",
    "服饰": "服装/穿着/配饰",
  };
  function catsInfoOf(cardCats) {
    return (cardCats || []).map((c) => ({ name: c.name, hint: c.hint || CAT_HINTS[c.name] || "" }));
  }
  function cardInCat(card, catId) {
    return catIdsOf(card).includes(catId);
  }

  // ── 文本工具 ──

  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  // 拆分提示词 → 片段列表（[{text, weight}]）：
  // 按换行分段，段内按所有逗号（中文顿号/逗号/分号/英文逗号）全部分割。
  // 2026-08-18 用户要求：所有逗号都应分割（不做长句保留；组合卡展开=内部 tag 可拆）。
  function splitTags(text) {
    const out = [];
    for (let rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/[、，,;；]/).map((s) => s.trim()).filter(Boolean);
      for (let p of parts) {
        const m = p.match(/^\((.+):([0-9.]+)\)$/);
        if (m) { out.push({ text: m[1].trim(), weight: m[2] }); continue; }
        out.push({ text: p, weight: "" });
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
  const UI_STATE_KEY = "anima_tk_cards_ui_v1";
  function saveDraft(text) { try { localStorage.setItem(DRAFT_KEY, String(text || "")); } catch (e) {} }
  function loadDraft() { try { return localStorage.getItem(DRAFT_KEY) || ""; } catch (e) { return ""; } }
  function loadUiState() {
    try {
      const raw = JSON.parse(localStorage.getItem(UI_STATE_KEY) || "{}");
      return { collapsed: { ...(raw.collapsed || {}) }, pane: raw.pane === "batch" ? "batch" : "lib" };
    } catch (e) {
      return { collapsed: {}, pane: "lib" };
    }
  }
  function saveUiState(state) {
    try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // ── UI ──

  class CardsUI {
    constructor(node, w) {
      this.node = node;
      this.w = w; // {positive, opt_text, lora_syntax}
      this.prompts = [];   // ① prompt 库缓存（anima-lora，浏览/切换/导入/删除）
      this.cats = [];      // ① prompt 库分类
      this.curLibCat = ""; // ① 当前分类过滤（"" = 全部）
      this.cards = [];     // ③ 卡片库缓存（anima-tk-cards，tag 级短语）
      this.cardCats = [];  // ③ 卡片分类
      this.curCat = "";    // ③ 当前卡片分类 id（"" = 全部）
      this.search = "";
      this.deleted = new Map(); // 卡片软删除（id -> {entry, timer}）
      this.selectedCardIds = new Set(); // Ctrl/Cmd 点击选择，供批量分类使用
      this.rootEl = null;
      this.libListEl = null;    // ①区条目列表
      this.libSearchEl = null;
      this.libCatSel = null;    // ①区分类过滤下拉
      this.cleanBtn = null;     // ①区「清理【卡】」
      this.fileSel = null;
      this.groupListEl = null;
      this.curTextEl = null;
      this.chipsEl = null;
      this.catTabsEl = null;
      this.cardGridEl = null;
      this.statusEl = null;
      this.batchGroups = new Map(); // 批文件路径 -> groups
      this.piecesZh = new Map(); // 片段文本 -> 中文译文（②区 chips 翻译显示，不入库）
      this.suggestEl = null;    // ②区联想下拉
      this._suggestIdx = -1;
      this._suggestList = [];
      this.uiState = loadUiState();
      this.sectionBodies = {};
    }

    _attachSectionBody(sec, head, key, label) {
      sec.classList.add("tk-cards-section");
      head.classList.add("tk-cards-sec-head-main");
      const title = head.querySelector("b");
      if (title) title.className = "tk-cards-sec-title";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tk-cards-section-toggle";
      toggle.setAttribute("aria-label", `折叠或展开${label}`);
      const body = document.createElement("div");
      body.className = "tk-cards-sec-body";
      this.sectionBodies[key] = body;
      const apply = () => {
        const collapsed = this.uiState.collapsed[key] === true;
        sec.classList.toggle("is-collapsed", collapsed);
        body.hidden = collapsed;
        toggle.textContent = collapsed ? "▸" : "▾";
        toggle.title = collapsed ? `展开${label}` : `折叠${label}`;
        toggle.setAttribute("aria-expanded", String(!collapsed));
      };
      toggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.uiState.collapsed[key] = this.uiState.collapsed[key] !== true;
        saveUiState(this.uiState);
        apply();
      });
      head.insertBefore(toggle, head.firstChild);
      sec.appendChild(head);
      sec.appendChild(body);
      apply();
      return body;
    }

    _setW(widget, value) {
      if (!widget) return;
      widget.value = value;
      if (typeof widget.callback === "function") { try { widget.callback(value) } catch {} }
    }

    curText() { return this.w.positive?.value || ""; }

    // ── 库加载：① prompt 库（anima-lora）＋③ 卡片库（anima-tk-cards）──
    async reloadAll() {
      await Promise.all([this.reloadLib(), this.reloadCards()]);
    }

    async reloadLib() {
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
        console.error("[TK Prompt Cards] prompt 库加载失败:", e);
        this._flash("prompt 库加载失败：" + (e.message || e));
      }
      this._renderLibCatSel();
      this._renderLibList();
    }

    // ①区分类下拉（prompt 库分类，与面板同步）
    _renderLibCatSel() {
      if (!this.libCatSel) return;
      const cur = this.curLibCat;
      this.libCatSel.innerHTML = `<option value="">全部分类</option>` +
        this.cats.map((c) => {
          const n = this.prompts.filter((p) => p.categoryId === c.id).length;
          return `<option value="${escAttr(c.id)}" ${c.id === cur ? "selected" : ""}>${esc(CAT_NAME(c))} (${n})</option>`;
        }).join("");
      if (cur && !this.cats.some((c) => c.id === cur)) {
        this.curLibCat = "";
        this.libCatSel.value = "";
      }
    }

    async reloadCards() {
      try {
        const lib = await loadCardLib();
        this.cards = (lib.cards || []).map(cardFromEnvelope);
        let ccats = (lib.categories || []).slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        if (!ccats.length) ccats = CARD_DEFAULT_CATS.map((c) => ({ ...c }));
        this.cardCats = ccats;
      } catch (e) {
        console.error("[TK Prompt Cards] 卡片库加载失败:", e);
        this._flash("卡片库加载失败：" + (e.message || e));
      }
      this._renderCatTabs();
      this._renderCards();
    }

    // 清理误入 prompt 库的卡片（历史版本把 kind=card 全写进了 anima-lora）
    async cleanMisfiledCards() {
      const victims = this.prompts.filter((p) => p.kind === "card");
      if (!victims.length) { this._flash("没有需要清理的卡片"); return; }
      if (!confirm(`确认删除 ${victims.length} 条误入 prompt 库的卡片（带【卡】标记）？\n完整生图词条不受影响。`)) return;
      const db = await openDB();
      let n = 0;
      for (const v of victims) {
        await storeDel(db, PROMPT_STORE, v.id);
        n++;
      }
      await this.reloadLib();
      this._flash(`已清理 ${n} 条误入卡片，prompt 库剩余 ${this.prompts.length} 条`);
    }

    // ── ① 工具箱 prompt 库浏览（网格 3 列 + 缩略图 + 分类过滤 + 删除）──
    _renderLibList() {
      if (!this.libListEl) return;
      const q = (this.search || "").toLowerCase();
      let list = this.prompts.slice();
      if (this.curLibCat) list = list.filter((p) => p.categoryId === this.curLibCat);
      if (q) {
        list = list.filter((p) =>
          String(p.prompt || "").toLowerCase().includes(q) ||
          String(p.displayText || "").toLowerCase().includes(q) ||
          String(p.notes || "").toLowerCase().includes(q) ||
          (p.tags || []).some((t) => String(t).toLowerCase().includes(q))
        );
      }
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      // 清理按钮可见性：存在误入卡片时显示
      if (this.cleanBtn) {
        this.cleanBtn.style.display = this.prompts.some((p) => p.kind === "card") ? "" : "none";
      }
      this.libListEl.innerHTML = "";
      if (!list.length) {
        this.libListEl.innerHTML = `<div class="tk-cards-empty">库为空 — 面板提取、批文件导入后这里会出现条目</div>`;
        return;
      }
      for (const p of list) {
        const el = document.createElement("div");
        el.className = "tk-cards-lib-item" + (p.kind === "card" ? " is-card" : "");
        el.tabIndex = 0;
        el.addEventListener("focus", () => { this.focusedLibId = p.id; });
        el.title = "点击切换为当前提示词（仅替换，不自动入队）；hover ✕ 删除该词条";
        const imgSrc = p.primaryImage || (p.images && p.images[0]) || "";
        if (imgSrc) {
          const thumb = document.createElement("div");
          thumb.className = "tk-cards-lib-thumb";
          const im = document.createElement("img");
          im.src = imgSrc;
          im.loading = "lazy";
          thumb.appendChild(im);
          el.appendChild(thumb);
        }
        const head = document.createElement("div");
        head.className = "tk-cards-lib-head";
        const title = document.createElement("span");
        title.className = "tk-cards-lib-title";
        title.textContent = (p.displayText || p.prompt || "").slice(0, 40) + (p.kind === "card" ? "  [卡]" : "");
        const fav = document.createElement("span");
        fav.className = "tk-cards-lib-fav";
        fav.textContent = p.isFavorite ? "★" : "";
        head.appendChild(title);
        head.appendChild(fav);
        const sub = document.createElement("div");
        sub.className = "tk-cards-lib-sub";
        sub.textContent = String(p.prompt || "").slice(0, 60);
        el.appendChild(head);
        el.appendChild(sub);
        // 删除按钮（hover 显示，二次确认；同步删除 prompt 库条目）
        const del = document.createElement("button");
        del.type = "button";
        del.className = "tk-cards-del";
        del.textContent = "删除";
        del.title = "从 prompt 库删除该词条（需二次确认）";
        let delArmed = false;
        const disarmDel = () => {
          delArmed = false;
          del.classList.remove("arm");
          del.textContent = "删除";
        };
        del.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (!delArmed) {
            delArmed = true;
            del.classList.add("arm");
            del.textContent = "✓删?";
            clearTimeout(del._armT);
            del._armT = setTimeout(disarmDel, 2500);
            return;
          }
          clearTimeout(del._armT);
          const db = await openDB();
          await storeDel(db, PROMPT_STORE, p.id);
          this.prompts = this.prompts.filter((x) => x.id !== p.id);
          this._renderLibList();
          this._flash("已从 prompt 库删除该词条");
        });
        el.appendChild(del);
        el.addEventListener("click", (ev) => {
          if (ev.target.closest(".tk-cards-del")) return;
          this._setW(this.w.positive, p.prompt || "");
          if (this.curTextEl) this.curTextEl.value = p.prompt || "";
          this._renderChips();
          this._flash(`已切换：${(p.displayText || p.prompt || "").slice(0, 30)}`);
        });
        // 双击就地编辑（标题/内容/注释/分类，写回 prompt 库）
        el.addEventListener("dblclick", (ev) => {
          if (ev.target.closest(".tk-cards-del")) return;
          this.beginLibEdit(p, el);
        });
        this.libListEl.appendChild(el);
      }
    }

    _bindInlineEdit(el, orig, readValues, commit, focusEl, rebuild) {
      let closed = false;
      let busy = false;
      const initial = JSON.stringify(readValues());
      const isDirty = () => JSON.stringify(readValues()) !== initial;
      const restore = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", keydown, true);
        el.innerHTML = orig;
        if (el.isConnected && typeof rebuild === "function") rebuild();
      };
      const save = async () => {
        if (busy || closed) return;
        busy = true;
        try {
          await commit(readValues());
          restore();
        } catch (e) {
          busy = false;
          this._flash("保存失败：" + (e.message || e), 5000);
        }
      };
      const showChoice = () => {
        if (closed || el.querySelector(".tk-cards-edit-warning")) return;
        const box = el.querySelector(".tk-cards-edit") || el;
        const warning = document.createElement("div");
        warning.className = "tk-cards-edit-warning";
        warning.innerHTML = `<span>有未保存改动</span><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="save-exit">保存并关闭</button><button type="button" class="tk-cards-btn" data-a="discard-exit">放弃修改</button><button type="button" class="tk-cards-btn" data-a="continue-edit">继续编辑</button>`;
        warning.querySelector('[data-a="save-exit"]').addEventListener("click", save);
        warning.querySelector('[data-a="discard-exit"]').addEventListener("click", restore);
        warning.querySelector('[data-a="continue-edit"]').addEventListener("click", () => warning.remove());
        box.appendChild(warning);
      };
      const outside = (ev) => {
        if (!el.contains(ev.target)) {
          if (isDirty()) showChoice(); else restore();
        }
      };
      const keydown = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          restore();
          return;
        }
        if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
          ev.preventDefault();
          save();
          return;
        }
        if (ev.key === "Enter" && ev.target?.tagName !== "TEXTAREA") {
          ev.preventDefault();
          save();
        }
      };
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", keydown, true);
      focusEl?.focus();
      return { save, cancel: restore };
    }

    // ①条目就地编辑（displayText 标题 / prompt / notes / 分类）
    beginLibEdit(p, el) {
      const orig = el.innerHTML;
      el.innerHTML = `<div class="tk-cards-edit">
        <label class="tk-cards-field"><span>标题</span><input value="${escAttr(p.displayText || "")}" data-f="title" placeholder="可选"></label>
        <label class="tk-cards-field"><span>提示词</span><textarea data-f="prompt" placeholder="提示词内容">${esc(p.prompt || "")}</textarea></label>
        <label class="tk-cards-field"><span>注释</span><input value="${escAttr(p.notes || "")}" data-f="notes" placeholder="可选"></label>
        <label class="tk-cards-field"><span>分类</span>
        <select data-f="cat" class="tk-cards-catpick">
          ${this.cats.map((c) => `<option value="${escAttr(c.id)}" ${c.id === p.categoryId ? "selected" : ""}>${esc(CAT_NAME(c))}</option>`).join("")}
        </select></label>
        <div class="tk-cards-edit-btns">
          <button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="save">保存</button>
          <button type="button" class="tk-cards-btn" data-a="cancel">取消</button></div></div>`;
      const readValues = () => ({
        displayText: el.querySelector('[data-f="title"]')?.value.trim() || "",
        prompt: el.querySelector('[data-f="prompt"]')?.value.trim() || "",
        notes: el.querySelector('[data-f="notes"]')?.value.trim() || "",
        categoryId: el.querySelector('[data-f="cat"]')?.value || "",
      });
      const commit = async (values) => {
        const next = { ...p, ...values, displayText: values.displayText || p.displayText, prompt: values.prompt || p.prompt, updatedAt: Date.now() };
        const db = await openDB();
        await storePut(db, PROMPT_STORE, next);
        Object.assign(p, next);
        this._renderLibList();
        this._flash("已保存到 prompt 库");
      };
      const session = this._bindInlineEdit(el, orig, readValues, commit, el.querySelector('[data-f="title"]'), () => this._renderLibList());
      el.querySelector('[data-a="save"]').addEventListener("click", session.save);
      el.querySelector('[data-a="cancel"]').addEventListener("click", session.cancel);
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
      const db = await openDB();
      for (let i = 0; i < (g.prompts || []).length; i++) {
        const prompt = String(g.prompts[i] || "").trim();
        if (!prompt) continue;
        await storePut(db, PROMPT_STORE, {
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
      await this.reloadLib();
      this._flash(`已导入 ${n} 条 → 工具箱 prompt 库（未分类）`);
    }

    // ── 卡片 CRUD（后端 cards.json 单一数据源；不污染 prompt 库）──
    async putCard(entry) {
      normalizeCardCats(entry);
      if (!_cardLibCache) await loadCardLib();
      const env = cardToEnvelope(entry);
      const arr = _cardLibCache.cards;
      const idx = arr.findIndex((x) => x.id === env.id);
      if (idx >= 0) arr[idx] = env; else arr.push(env);
      await saveCardLib();
      const fIdx = this.cards.findIndex((p) => p.id === entry.id);
      if (fIdx >= 0) this.cards[fIdx] = entry; else this.cards.push(entry);
    }

    async delCard(id) {
      if (!_cardLibCache) await loadCardLib();
      _cardLibCache.cards = _cardLibCache.cards.filter((x) => x.id !== id);
      await saveCardLib();
      this.cards = this.cards.filter((p) => p.id !== id);
    }

    // 保存卡片（tag 级 / 组合卡）→ 卡片库。先落库（立即可用），自动翻译异步补注释。
    // 查重：同一英文文本支持多个分类——
    //   目标分类已有该词 → 跳过提示；
    //   同词存在于其他分类 → 给已有卡追加该分类（合并，不新建重复卡）。
    async addCard(catId, card, { multi = false } = {}) {
      const en = String(card.en || card.prompt || "").trim();
      if (!en) { this._flash("内容为空"); return { skipped: true }; }
      const enKey = en.toLowerCase();
      const dup = this.cards.find((c) => String(c.prompt || "").trim().toLowerCase() === enKey);
      const cat = catId || this.curCat || (this.cardCats[0] && this.cardCats[0].id) || "uncategorized";
      const catName = CAT_NAME(this.cardCats.find((c) => c.id === cat));
      if (dup) {
        if (cardInCat(dup, cat)) {
          this._flash(`已跳过：「${en.slice(0, 24)}」已存在于「${catName}」`, 3000);
          return { skipped: true, dupCat: cat };
        }
        // 同词其他分类 → 合并追加分类（不新建重复卡；注释取已有优先，缺失时补翻译）
        const hasCats = catIdsOf(dup);
        if (!hasCats.includes(cat)) {
          dup.categories = hasCats.concat([cat]);
          dup.updatedAt = Date.now();
          await this.putCard(dup);
        }
        this.curCat = cat;
        this._renderCatTabs();
        this._renderCards();
        this._flash(`「${en.slice(0, 24)}」已添加分类「${catName}」`);
        if (!String(dup.notes || "").trim()) {
          translateAuto(en).then((nz) => {
            if (!nz || nz === en) return;
            dup.notes = nz;
            dup.updatedAt = Date.now();
            this.putCard(dup).then(() => { this._renderCards(); this._flash(`已翻译注释：${nz.slice(0, 30)}`); });
          }).catch(() => {});
        }
        return { skipped: false, merged: true };
      }
      const zh0 = String(card.zh || card.notes || "").trim();
      const entry = {
        id: genId("p_"),
        prompt: en,
        notes: zh0,
        weight: String(card.weight || "").trim(),
        lora: String(card.lora || "").trim(),
        multi: !!multi,
        categories: [cat],
        categoryId: cat,
        isFavorite: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.putCard(entry);
      this.curCat = cat;
      this._renderCatTabs();
      this._renderCards();
      this._flash(`已存入卡片库「${CAT_NAME(this.cardCats.find((c) => c.id === cat))}」`);
      // 异步翻译补中文注释（失败不阻塞，卡片保留「待翻译」）
      if (!zh0) {
        translateAuto(en).then((nz) => {
          if (!nz || nz === en) return;
          entry.notes = nz;
          entry.updatedAt = Date.now();
          this.putCard(entry).then(() => {
            this._renderCards();
            this._flash(`已翻译注释：${nz.slice(0, 30)}`);
          });
        }).catch(() => { /* 翻译失败保留待翻译 */ });
      }
      return { skipped: false };
    }

    async removeEntry(id) {
      const entry = this.cards.find((p) => p.id === id);
      if (!entry) return;
      await this.delCard(id);
      this.deleted.set(id, { entry });
      this._renderCatTabs();
      this._renderCards();
      this._flash("已删除，3 秒内可撤销", 4000);
      setTimeout(() => this.deleted.delete(id), 3000);
    }

    async undoDelete() {
      const entries = Array.from(this.deleted.entries());
      if (!entries.length) { this._flash("没有可撤销的删除"); return; }
      for (const [, v] of entries) await this.putCard(v.entry);
      this.deleted.clear();
      this.reloadCards();
      this._flash("已恢复删除的卡片");
    }

    async toggleFavorite(id) {
      const p = this.cards.find((x) => x.id === id);
      if (!p) return;
      p.isFavorite = !p.isFavorite;
      await this.putCard(p);
      this._renderCatTabs();
      this._renderCards();
    }

    // ── ② 当前提示词区 ──
    onCurInput() {
      const v = this.curTextEl.value;
      this._setW(this.w.positive, v);
      this._renderChips();
      this._updateSuggest();
    }

    // ── 卡片库联想补全（形态 A：输入时从卡片库匹配，Enter/点击替换光标处词）──
    _wordBounds(t, caret) {
      const isSep = (ch) => ch && /[，,、;；\n]/.test(ch);
      let ws = caret;
      while (ws > 0 && !isSep(t[ws - 1])) ws--;
      // 词前空格保留在替换区间外（替换后结构不变：", bl" → ", 新词"）
      while (ws < caret && t[ws] === " ") ws++;
      let we = caret;
      while (we < t.length && !isSep(t[we])) we++;
      return [ws, we];
    }

    _updateSuggest() {
      if (!this.curTextEl || !this.suggestEl) return;
      const t = this.curTextEl.value;
      const caret = this.curTextEl.selectionStart ?? t.length;
      const [ws] = this._wordBounds(t, caret);
      const prefix = t.slice(ws, caret).trim().toLowerCase();
      if (!prefix || !this.cards.length) { this._hideSuggest(); return; }
      const star = (c) => (c.isFavorite ? 0 : 1);
      const order = (c) => (c.order != null ? c.order : Number.MAX_SAFE_INTEGER);
      const list = this.cards
        .filter((c) => {
          const p = String(c.prompt || "").toLowerCase();
          return p.startsWith(prefix) || p.includes(prefix);
        })
        .sort((a, b) => {
          const ap = String(a.prompt || "").toLowerCase().startsWith(prefix) ? 0 : 1;
          const bp = String(b.prompt || "").toLowerCase().startsWith(prefix) ? 0 : 1;
          return ap - bp || star(a) - star(b) || order(a) - order(b) || (b.createdAt || 0) - (a.createdAt || 0);
        })
        .slice(0, 8);
      if (!list.length) { this._hideSuggest(); return; }
      this._suggestList = list;
      this._suggestIdx = 0;
      const catName = (c) => {
        const id = (catIdsOf(c)[0]) || "";
        return CAT_NAME(this.cardCats.find((x) => x.id === id));
      };
      this.suggestEl.style.display = "";
      this.suggestEl.innerHTML = list.map((c, i) =>
        `<div class="tk-cards-suggest-item ${i === 0 ? "sel" : ""}" data-i="${i}">
          <span class="s-en">${esc(c.prompt)}</span>
          ${c.notes ? `<span class="s-zh">${esc(c.notes)}</span>` : ""}
          <span class="s-cat">${esc(catName(c))}</span></div>`).join("");
      this.suggestEl.querySelectorAll(".tk-cards-suggest-item").forEach((it) => {
        it.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this._applySuggest(list[parseInt(it.getAttribute("data-i"), 10)]);
        });
      });
    }

    _hideSuggest() {
      if (this.suggestEl) { this.suggestEl.style.display = "none"; this.suggestEl.innerHTML = ""; }
      this._suggestList = [];
      this._suggestIdx = -1;
    }

    // 用选中卡片替换光标所在词
    _applySuggest(card) {
      if (!card) return;
      const el = this.curTextEl;
      const t = el.value;
      const caret = el.selectionStart ?? t.length;
      const [ws, we] = this._wordBounds(t, caret);
      const repl = cardToText(card);
      const next = t.slice(0, ws) + repl + t.slice(we);
      this._setW(this.w.positive, next);
      el.value = next;
      const pos = ws + repl.length;
      el.setSelectionRange(pos, pos);
      this._hideSuggest();
      this._renderChips();
      el.focus();
    }

    _suggestKeyDown(e) {
      if (!this._suggestList.length || this.suggestEl.style.display === "none") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this._suggestIdx = (this._suggestIdx + 1) % this._suggestList.length;
        this._markSuggestSel();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this._suggestIdx = (this._suggestIdx - 1 + this._suggestList.length) % this._suggestList.length;
        this._markSuggestSel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this._applySuggest(this._suggestList[this._suggestIdx] || this._suggestList[0]);
      } else if (e.key === "Escape") {
        this._hideSuggest();
      }
    }

    _markSuggestSel() {
      if (!this.suggestEl) return;
      this.suggestEl.querySelectorAll(".tk-cards-suggest-item").forEach((it, i) => {
        it.classList.toggle("sel", i === this._suggestIdx);
      });
    }

    _renderChips() {
      if (!this.chipsEl) return;
      const parts = splitTags(this.curText());
      this.chipsEl.innerHTML = "";
      if (!parts.length) {
        this.chipsEl.innerHTML = `<div class="tk-cards-empty">输入提示词后自动按逗号分组（点击片段=存为卡片；hover ✕=移除）</div>`;
        return;
      }
      for (const p of parts) {
        const chip = document.createElement("span");
        chip.className = "tk-cards-chip";
        chip.title = "点击存为卡片；hover ✕ 移除该片段";
        const zh = this.piecesZh.get(p.text);
        if (zh) {
          const enS = document.createElement("span");
          enS.className = "tk-cards-chip-en";
          enS.textContent = p.weight ? `(${p.text}:${p.weight})` : p.text;
          const zhS = document.createElement("span");
          zhS.className = "tk-cards-chip-zh";
          zhS.textContent = zh;
          chip.appendChild(enS);
          chip.appendChild(zhS);
        } else {
          chip.textContent = p.weight ? `(${p.text}:${p.weight})` : p.text;
        }
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.addCard(this.curCat, { en: p.text, zh: zh || "", weight: p.weight });
        });
        const x = document.createElement("button");
        x.type = "button";
        x.className = "tk-cards-chip-x";
        x.textContent = "✕";
        x.title = "从当前提示词移除该片段";
        x.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const next = removePiece(this.curText(), p);
          this.piecesZh.delete(p.text);
          this._setW(this.w.positive, next);
          if (this.curTextEl) this.curTextEl.value = next;
          this._renderChips();
        });
        chip.appendChild(x);
        this.chipsEl.appendChild(chip);
      }
    }

    // ②区「翻译」：只翻译当前所有片段并显示中文小字（不入库，不污染分类）
    async translatePiecesOnly() {
      const parts = splitTags(this.curText());
      if (!parts.length) { this._flash("当前提示词为空"); return; }
      this._flash(`翻译中：${parts.length} 段…（仅显示，不入库）`);
      let okN = 0, cursor = 0;
      const workers = Array.from({ length: 3 }, async () => {
        while (cursor < parts.length) {
          const p = parts[cursor++];
          try {
            const t = await translateAuto(p.text);
            if (t && t !== p.text) { this.piecesZh.set(p.text, t); okN++; }
          } catch (e) { /* 单段失败跳过 */ }
        }
      });
      await Promise.all(workers);
      this._renderChips();
      this._flash(`翻译完成：${okN}/${parts.length} 段（中文注释仅显示，不会入库）`);
    }

    // ②区「AI 入卡」：当前所有片段 → LLM 自动判定分类 → 确认清单（可改判）→ 确认后入库
    async cardsAddAll() {
      const parts = splitTags(this.curText());
      if (!parts.length) { this._flash("当前提示词为空"); return; }
      if (!this.cardCats.length) { this._flash("没有可用分类"); return; }
      const catNames = this.cardCats.map((c) => c.name);
      const name2id = {};
      for (const c of this.cardCats) name2id[c.name] = c.id;
      const fallbackId = name2id["通用"] || (this.cardCats[0] && this.cardCats[0].id) || "";

      // 1) LLM 判定分类（长超时：LLM 推理可能 10-60s；小批 30 提质量）
      let suggestions = {};
      try {
        const res = await postJson("/anima/cards/classify", {
          cards: parts.map((p, i) => ({ id: String(i), text: p.text })),
          cats: catNames,
          cats_info: catsInfoOf(this.cardCats),
        }, 90000);
        if (res.ok) {
          for (const r of res.result || []) {
            suggestions[r.id] = r.categoryName;
          }
        } else {
          throw new Error(res.error || "classify 失败");
        }
      } catch (e) {
        // LLM 不可用：询问是否按当前分类直接入卡
        const ok = confirm("LLM 分类不可用（" + (e.message || e) + "）。\n是否仍按当前分类直接入卡？（可先点「LLM」配置 Ollama/API 反代）");
        if (!ok) return;
        let n = 0, skipN = 0;
        for (const p of parts) {
          const r = await this.addCard(this.curCat, { en: p.text, zh: this.piecesZh.get(p.text) || "", weight: p.weight });
          if (r && r.skipped) skipN++; else n++;
        }
        this._flash(`已按当前分类入卡：${n} 段${skipN ? `，${skipN} 段已存在已跳过` : ""}`);
        return;
      }

      // 2) 确认清单 overlay（可改判分类、可移除词）
      this._flash("LLM 已判定，等待你确认分类…");
      const removedSet = new Set();
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      const rowsHtml = parts.map((p, i) => {
        const zh = this.piecesZh.get(p.text) || "";
        const sug = suggestions[String(i)] || "";
        const catId = name2id[sug] || fallbackId;
        const opts = this.cardCats.map((c) =>
          `<option value="${escAttr(c.id)}" ${c.id === catId ? "selected" : ""}>${esc(CAT_NAME(c))}</option>`).join("");
        return `<div class="tk-cards-ai-row" data-i="${i}">
          <div class="tk-cards-ai-text">${esc(p.weight ? `(${p.text}:${p.weight})` : p.text)}${zh ? `<span class="tk-cards-ai-zh">${esc(zh)}</span>` : ""}</div>
          <select class="tk-cards-ai-cat">${opts}</select>
          <button type="button" class="tk-cards-ai-rm" data-rm="${i}" title="移除该词（不入库）">✕</button></div>`;
      }).join("");
      overlay.innerHTML = `<div class="tk-cards-overlay-box">
        <div class="tk-cards-overlay-head"><b>AI 分类确认 · ${parts.length} 段（可改判分类 / ✕ 移除词）</b><button type="button" class="tk-cards-btn" data-a="close">✕</button></div>
        <div class="tk-cards-ai-list">${rowsHtml}</div>
        <div class="tk-cards-ai-actions">
          <button type="button" class="tk-cards-btn" data-a="cancel">取消</button>
          <button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="confirm">✓ 确认入卡 ${parts.length} 张</button>
        </div></div>`;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      const updateConfirm = () => {
        const btn = overlay.querySelector('[data-a="confirm"]');
        if (btn) btn.textContent = `✓ 确认入卡 ${parts.length - removedSet.size} 张`;
      };
      overlay.querySelectorAll(".tk-cards-ai-rm").forEach((rmBtn) => {
        rmBtn.addEventListener("click", () => {
          const i = parseInt(rmBtn.getAttribute("data-rm"), 10);
          const row = overlay.querySelector(`.tk-cards-ai-row[data-i="${i}"]`);
          if (removedSet.has(i)) {
            removedSet.delete(i);
            row.classList.remove("removed");
          } else {
            removedSet.add(i);
            row.classList.add("removed");
          }
          updateConfirm();
        });
      });
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);
      overlay.querySelector('[data-a="cancel"]').addEventListener("click", close);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      overlay.querySelector('[data-a="confirm"]').addEventListener("click", async () => {
        const rows = overlay.querySelectorAll(".tk-cards-ai-row");
        let n = 0, skipN = 0, rmN = removedSet.size;
        for (const row of rows) {
          const i = parseInt(row.getAttribute("data-i"), 10);
          if (removedSet.has(i)) continue; // 用户移除的词不入库
          const p = parts[i];
          if (!p) continue;
          const catId = row.querySelector(".tk-cards-ai-cat").value;
          const r = await this.addCard(catId, { en: p.text, zh: this.piecesZh.get(p.text) || "", weight: p.weight });
          if (r && r.skipped) skipN++; else n++;
        }
        close();
        this._flash(`已确认入卡：${n} 段${skipN ? `（${skipN} 段库中已存在已跳过）` : ""}${rmN ? `；已移除 ${rmN} 段` : ""}`);
      });
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
    _categoryCount(catId) {
      return this.cards.filter((card) => cardInCat(card, catId)).length;
    }

    showCategoryManager() {
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-category-manager">
        <div class="tk-cards-overlay-head"><b>管理卡片分类</b><button type="button" class="tk-cards-btn" data-a="close">关闭</button></div>
        <div class="tk-cards-category-note">分类说明会作为人工提示和智能分类上下文；保存名称不会改变卡片内容。</div>
        <div class="tk-cards-category-list"></div>
        <div class="tk-cards-category-new">
          <b>新建分类</b><input data-f="new-name" placeholder="分类名称"><input data-f="new-hint" placeholder="分类说明（可选）"><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="new">新增</button>
        </div>
      </div>`;
      document.body.appendChild(overlay);
      const list = overlay.querySelector(".tk-cards-category-list");
      const close = () => overlay.remove();
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      const render = () => {
        list.innerHTML = this.cardCats.map((cat) => {
          const count = this._categoryCount(cat.id);
          return `<div class="tk-cards-category-row" data-id="${escAttr(cat.id)}">
            <div class="tk-cards-category-row-main"><input data-f="name" value="${escAttr(CAT_NAME(cat))}"><span>${count} 张卡</span></div>
            <input data-f="hint" value="${escAttr(cat.hint || CAT_HINTS[cat.name] || "")}" placeholder="分类说明（可选）">
            <div class="tk-cards-category-row-actions"><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="save">保存</button><button type="button" class="tk-cards-btn tk-cards-btn-danger" data-a="delete">删除</button></div>
          </div>`;
        }).join("") || `<div class="tk-cards-empty">暂无分类</div>`;
        list.querySelectorAll(".tk-cards-category-row").forEach((row) => {
          const id = row.getAttribute("data-id");
          row.querySelector('[data-a="save"]').addEventListener("click", async () => {
            const cat = this.cardCats.find((x) => x.id === id);
            if (!cat) return;
            const name = row.querySelector('[data-f="name"]').value.trim();
            const hint = row.querySelector('[data-f="hint"]').value.trim();
            if (!name) { this._flash("分类名称不能为空"); return; }
            const duplicate = this.cardCats.find((x) => x.id !== id && CAT_NAME(x).toLowerCase() === name.toLowerCase());
            if (duplicate) { this._flash(`分类「${name}」已存在`); return; }
            if (!_cardLibCache) await loadCardLib();
            cat.name = name;
            cat.hint = hint;
            const raw = _cardLibCache.categories.find((x) => x.id === id);
            if (raw) { raw.name = name; raw.hint = hint; }
            await saveCardLib();
            this._renderCatTabs();
            this._renderCards();
            render();
            this._flash(`已保存分类「${name}」`);
          });
          row.querySelector('[data-a="delete"]').addEventListener("click", () => this.delCardCat(id));
        });
      };
      this._categoryManagerRender = render;
      overlay.querySelector('[data-a="new"]').addEventListener("click", async () => {
        const nameEl = overlay.querySelector('[data-f="new-name"]');
        const hintEl = overlay.querySelector('[data-f="new-hint"]');
        const name = nameEl.value.trim();
        if (!name) { nameEl.focus(); this._flash("分类名称不能为空"); return; }
        if (this.cardCats.some((x) => CAT_NAME(x).toLowerCase() === name.toLowerCase())) { this._flash(`分类「${name}」已存在`); return; }
        const cat = { id: "cat_" + Date.now(), name, hint: hintEl.value.trim(), icon: "", sortOrder: this.cardCats.length };
        if (!_cardLibCache) await loadCardLib();
        _cardLibCache.categories.push(cat);
        await saveCardLib();
        this.cardCats.push(cat);
        this.curCat = cat.id;
        this._renderCatTabs();
        this._renderCards();
        nameEl.value = "";
        hintEl.value = "";
        render();
        this._flash(`已新建分类「${name}」`);
      });
      render();
    }

    showCategoryDeleteDialog(catId) {
      const cat = this.cardCats.find((x) => x.id === catId);
      if (!cat) return;
      const candidates = this.cardCats.filter((x) => x.id !== catId);
      const count = this._categoryCount(catId);
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-category-delete">
        <div class="tk-cards-overlay-head"><b>删除分类「${esc(CAT_NAME(cat))}」</b><button type="button" class="tk-cards-btn" data-a="close">关闭</button></div>
        <p>该分类包含 ${count} 张卡片。选择删除后这些卡片的归并目标。</p>
        <label class="tk-cards-field"><span>归并到</span><select data-f="fallback">${candidates.map((x) => `<option value="${escAttr(x.id)}" ${x.id === "card_all" ? "selected" : ""}>${esc(CAT_NAME(x))}</option>`).join("")}<option value="">不归并（变为未分类）</option></select></label>
        <div class="tk-cards-ai-actions"><button type="button" class="tk-cards-btn" data-a="cancel">取消</button><button type="button" class="tk-cards-btn tk-cards-btn-danger" data-a="delete">确认删除</button></div>
      </div>`;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);
      overlay.querySelector('[data-a="cancel"]').addEventListener("click", close);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      overlay.querySelector('[data-a="delete"]').addEventListener("click", async () => {
        const fallback = overlay.querySelector('[data-f="fallback"]')?.value || "";
        close();
        await this.delCardCat(catId, fallback);
      });
    }

    // 删除卡片分类；归并目标由正式弹层选择。
    async delCardCat(catId, fallbackId = null) {
      if (fallbackId === null) {
        this.showCategoryDeleteDialog(catId);
        return;
      }
      const cat = this.cardCats.find((c) => c.id === catId);
      if (!cat) return;
      if (!_cardLibCache) await loadCardLib();
      _cardLibCache.categories = _cardLibCache.categories.filter((c) => c.id !== catId);
      const fallback = _cardLibCache.categories.find((c) => c.id === fallbackId) || null;
      let moved = 0;
      for (const c of _cardLibCache.cards) {
        if (!(c.categories || []).includes(catId)) continue;
        let cats = (c.categories || []).filter((x) => x !== catId);
        if (!cats.length && fallback) cats = [fallback.id];
        c.categories = cats;
        moved++;
      }
      this.cardCats = this.cardCats.filter((c) => c.id !== catId);
      for (const cc of this.cards) {
        if (!cardInCat(cc, catId)) continue;
        let cats = catIdsOf(cc).filter((x) => x !== catId);
        if (!cats.length && fallback) cats = [fallback.id];
        cc.categories = cats;
        cc.categoryId = cats[0] || "";
        cc.updatedAt = Date.now();
      }
      await saveCardLib();
      if (this.curCat === catId) this.curCat = "";
      this._renderCatTabs();
      this._renderCards();
      if (typeof this._categoryManagerRender === "function") this._categoryManagerRender();
      this._flash(`已删除分类「${cat.name}」${fallback ? `，${moved} 张卡片移入「${fallback.name}」` : ""}`);
    }

    _renderCatTabs() {
      if (!this.catTabsEl) return;
      this.catTabsEl.innerHTML = "";
      this.catTabsEl.setAttribute("data-root", "1");
      const mk = (label, id, draggable) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "tk-cards-cat" + (this.curCat === id ? " on" : "");
        tab.textContent = label + (draggable ? " ≡" : "");
        tab.title = draggable ? "点击切换 · 拖拽调整分类顺序 · hover ✕ 删除分类" : "";
        if (draggable) {
          const del = document.createElement("span");
          del.className = "tk-cards-cat-del";
           del.textContent = "删除";
          del.title = "删除分类（卡片移入「通用」）";
          del.addEventListener("click", (ev) => {
            ev.stopPropagation();
            this.delCardCat(id);
          });
          tab.appendChild(del);
          tab.draggable = true;
          tab.addEventListener("dragstart", (ev) => {
            this._dragCatId = id;
            try { ev.dataTransfer.setData("text/plain", "cat:" + id); ev.dataTransfer.effectAllowed = "move"; } catch (e) {}
          });
          tab.addEventListener("dragend", () => { this._dragCatId = null; });
          tab.addEventListener("dragover", (ev) => {
            if (!this._dragCatId && !this._dragCardId) return;
            if (this._dragCatId && this._dragCatId === id) return;
            ev.preventDefault();
            tab.classList.add("drag-over");
          });
          tab.addEventListener("dragleave", () => tab.classList.remove("drag-over"));
          tab.addEventListener("drop", async (ev) => {
            ev.preventDefault();
            tab.classList.remove("drag-over");
            // 卡片拖到分类页签 → 追加该分类（多分类；已含则提示不变）
            if (this._dragCardId) {
              const cardId = this._dragCardId;
              this._dragCardId = null;
              this._dragCardCat = null;
              const card = this.cards.find((x) => x.id === cardId);
              if (!card) return;
              if (cardInCat(card, id)) {
                this._flash(`「${(card.prompt || "").slice(0, 20)}」已属于「${CAT_NAME(this.cardCats.find((c) => c.id === id))}」`);
                return;
              }
              card.categories = catIdsOf(card).concat([id]);
              card.updatedAt = Date.now();
              await this.putCard(card);
              this._renderCatTabs();
              this._renderCards();
              this._flash(`「${(card.prompt || "").slice(0, 20)}」已加入「${CAT_NAME(this.cardCats.find((c) => c.id === id))}」（当前视图不变）`);
              return;
            }
            // 分类拖拽 → 排序
            const fromId = this._dragCatId;
            this._dragCatId = null;
            if (!fromId || fromId === id) return;
            const from = this.cardCats.findIndex((c) => c.id === fromId);
            const to = this.cardCats.findIndex((c) => c.id === id);
            if (from < 0 || to < 0) return;
            const arr = this.cardCats.slice();
            const [moved] = arr.splice(from, 1);
            arr.splice(to, 0, moved);
            arr.forEach((c, i) => { c.sortOrder = i; });
            if (!_cardLibCache) await loadCardLib();
            _cardLibCache.categories = arr;
            await saveCardLib();
            this.cardCats = arr;
            this._renderCatTabs();
            this._renderCards();
            this._flash("分类顺序已调整");
          });
        }
        tab.addEventListener("click", () => { this.curCat = id; this._renderCatTabs(); this._renderCards(); });
        this.catTabsEl.appendChild(tab);
      };
      mk("全部", "", false);
      for (const c of this.cardCats) {
        const n = this.cards.filter((p) => cardInCat(p, c.id)).length;
        mk(`${CAT_NAME(c)} (${n})`, c.id, true);
      }
      const addTab = document.createElement("button");
      addTab.type = "button";
      addTab.className = "tk-cards-cat tk-cards-cat-add";
       addTab.textContent = "管理分类";
       addTab.title = "新建、重命名、删除和维护分类说明";
       addTab.addEventListener("click", () => this.showCategoryManager());
       this.catTabsEl.appendChild(addTab);
    }

    // 分类内卡片当前顺序（order 优先，其次收藏/时间）
    _catOrderIds(catId) {
      const list = this.cards.filter((c) => cardInCat(c, catId));
      list.sort((a, b) => {
        const ao = a.order != null ? a.order : Number.MAX_SAFE_INTEGER;
        const bo = b.order != null ? b.order : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0);
      });
      return list.map((c) => c.id);
    }

    // 按新顺序重排分类内卡片（order 0..n-1）
    async _applyCardOrder(catId, ids) {
      const orderMap = {};
      ids.forEach((id, i) => { orderMap[id] = i; });
      for (const c of this.cards) {
        if (!cardInCat(c, catId)) continue;
        if (c.order !== orderMap[c.id]) {
          c.order = orderMap[c.id];
          c.updatedAt = Date.now();
          await this.putCard(c);
        }
      }
    }

    _sortCardList(list) {
      list.sort((a, b) => {
        const ao = a.order != null ? a.order : Number.MAX_SAFE_INTEGER;
        const bo = b.order != null ? b.order : Number.MAX_SAFE_INTEGER;
        if (ao !== bo) return ao - bo;
        return (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0);
      });
      return list;
    }

    _renderCards() {
      if (!this.cardGridEl) return;
      let list = this.cards.slice();
      if (this.curCat) list = list.filter((p) => cardInCat(p, this.curCat));
      this._sortCardList(list);
      this.cardGridEl.innerHTML = "";
      if (!list.length) {
        this.cardGridEl.innerHTML = `<div class="tk-cards-empty">暂无卡片 — ②区点片段「存卡」或「一键入卡」，或「浏览 LoRA」批量收藏</div>`;
        return;
      }
      for (const c of list) {
        const el = document.createElement("div");
         el.className = "tk-cards-card" + (c.isFavorite ? " star" : "") + (this.selectedCardIds.has(c.id) ? " is-selected" : "");
        el.setAttribute("data-id", c.id);
        el.tabIndex = 0;
        el.addEventListener("focus", () => { this.focusedCardId = c.id; });
        el.title = "单击追加 · 双击编辑 · 拖 ≡ 排序 · ↑ 置顶 · ✕ 删除";
        const en = document.createElement("div");
        en.className = "tk-cards-card-en";
        en.textContent = String(c.prompt || "").length > 60 ? String(c.prompt).slice(0, 58) + "…" : (c.prompt || "");
        en.title = (c.prompt || "") + (c.lora ? `\nLoRA: ${c.lora}` : "");
        const zh = document.createElement("div");
        zh.className = "tk-cards-card-zh";
        zh.textContent = c.notes || "（待翻译）";
        const meta = document.createElement("div");
        meta.className = "tk-cards-card-meta";
        meta.innerHTML = `<span class="tk-cards-star" title="星标">${c.isFavorite ? "★" : "☆"}</span>` +
          (c.weight ? `<span class="tk-cards-w">${esc(c.weight)}</span>` : "") +
          (c.lora ? `<span class="tk-cards-lora">L:${esc(String(c.lora).split("/").pop().replace(/\.safetensors$/, ""))}</span>` : "") +
          (c.multi ? `<span class="tk-cards-multi">组合</span>` : "");
        // 拖拽把手（排序）
        const grip = document.createElement("span");
        grip.className = "tk-cards-grip";
         grip.textContent = "↕";
        grip.title = "拖拽调整卡片顺序";
        grip.draggable = true;
        grip.addEventListener("dragstart", (ev) => {
          this._dragCardId = c.id;
          this._dragCardCat = (catIdsOf(c)[0]) || "";
          try { ev.dataTransfer.setData("text/plain", "card:" + c.id); ev.dataTransfer.effectAllowed = "move"; } catch (e) {}
        });
        grip.addEventListener("dragend", () => { this._dragCardId = null; this._dragCardCat = null; });
        // 置顶（移到分类最前）
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "tk-cards-pin";
         pin.textContent = "置顶";
        pin.title = "置顶（移到当前分类最前）";
        pin.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const ids = this._catOrderIds(c.categoryId).filter((x) => x !== c.id);
          ids.unshift(c.id);
          await this._applyCardOrder(c.categoryId, ids);
          this._renderCards();
          this._flash("已置顶");
        });
        // 快速分类
        const catBtn = document.createElement("button");
        catBtn.type = "button";
        catBtn.className = "tk-cards-cat-btn";
         catBtn.textContent = "分类";
        catBtn.title = "快速分类（大弹窗选择；也可把卡片 ≡ 拖到分类页签上转移）";
        catBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.quickCategorize(c.id);
        });
        // 删除（二次确认）
        const del = document.createElement("button");
        del.type = "button";
        del.className = "tk-cards-del";
         del.textContent = "删除";
        del.title = "删除卡片（需二次点击确认；删除后可撤销）";
        el.appendChild(en);
        el.appendChild(zh);
        el.appendChild(meta);
        el.appendChild(grip);
        el.appendChild(pin);
        el.appendChild(catBtn);
        el.appendChild(del);
        let delArmed = false;
        const disarmDel = () => {
          delArmed = false;
          del.classList.remove("arm");
           del.textContent = "删除";
        };
        del.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (!delArmed) {
            delArmed = true;
            del.classList.add("arm");
            del.textContent = "✓删?";
            clearTimeout(del._armT);
            del._armT = setTimeout(disarmDel, 2500);
            return;
          }
          clearTimeout(del._armT);
          this.removeEntry(c.id);
        });
        // 放置目标（插入到目标卡片之前）
        el.addEventListener("dragover", (ev) => {
          if (!this._dragCardId || this._dragCardId === c.id) return;
          ev.preventDefault();
          el.classList.add("drag-over");
        });
        el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
        el.addEventListener("drop", async (ev) => {
          ev.preventDefault();
          el.classList.remove("drag-over");
          const fromId = this._dragCardId;
          this._dragCardId = null;
          this._dragCardCat = null;
          if (!fromId || fromId === c.id) return;
          const targetCat = (catIdsOf(c)[0]) || "";
          // 拖到另一张卡片上：目标卡的主分类；跨分类时把 from 卡加入该分类（多分类语义）
          const fromEntry = this.cards.find((x) => x.id === fromId);
          if (fromEntry && targetCat && !cardInCat(fromEntry, targetCat)) {
            fromEntry.categories = catIdsOf(fromEntry).concat([targetCat]);
            fromEntry.order = undefined;
            fromEntry.updatedAt = Date.now();
            await this.putCard(fromEntry);
            this.curCat = targetCat;
          }
          const ids = this._catOrderIds(targetCat).filter((x) => x !== fromId);
          const toIdx = ids.indexOf(c.id);
          ids.splice(toIdx < 0 ? ids.length : toIdx, 0, fromId);
          await this._applyCardOrder(targetCat, ids);
          this._renderCatTabs();
          this._renderCards();
          this._flash("卡片顺序已调整");
        });
        el.addEventListener("click", (ev) => {
          if (delArmed) { disarmDel(); return; }
          if (ev.target.closest(".tk-cards-star") || ev.target.closest(".tk-cards-del") ||
              ev.target.closest(".tk-cards-cat-btn") || ev.target.closest(".tk-cards-pin") ||
              ev.target.closest(".tk-cards-grip")) return;
          if (ev.ctrlKey || ev.metaKey) {
            if (this.selectedCardIds.has(c.id)) this.selectedCardIds.delete(c.id); else this.selectedCardIds.add(c.id);
            this._renderCards();
            this._flash(`${this.selectedCardIds.size} 张卡片已选中（Ctrl/Cmd 点击切换）`);
            return;
          }
          const cur = this.curText();
          const next = appendCardToPrompt(cur, c);
          this._setW(this.w.positive, next);
          if (this.curTextEl) this.curTextEl.value = next;
          this._renderChips();
          if (next === cur) this._flash("该卡片已在提示词中（已去重）");
        });
        el.addEventListener("dblclick", (ev) => {
          if (ev.target.closest(".tk-cards-star") || ev.target.closest(".tk-cards-del") ||
              ev.target.closest(".tk-cards-cat-btn") || ev.target.closest(".tk-cards-pin") ||
              ev.target.closest(".tk-cards-grip")) return;
          this.beginEdit(c.id, el, c);
        });
        el.querySelector(".tk-cards-star").addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.toggleFavorite(c.id);
        });
        this.cardGridEl.appendChild(el);
      }
    }

    // 卡片快速分类：▣ 多选弹窗（勾选分类=包含；同一词可属多个分类）
    quickCategorize(id) {
      const c = this.cards.find((x) => x.id === id);
      if (!c) return;
      const curCats = catIdsOf(c);
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-catpick-box">
        <div class="tk-cards-overlay-head"><b>设置卡片分类（可多选）· ${esc(String(c.prompt || "").slice(0, 40))}</b><button type="button" class="tk-cards-btn" data-a="close">✕</button></div>
        <input class="tk-cards-search" placeholder="搜索分类…" data-a="search">
        <div class="tk-cards-catpick-list"></div>
        <div class="tk-cards-ai-actions">
          <button type="button" class="tk-cards-btn" data-a="cancel">取消</button>
          <button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="ok">✓ 保存分类</button>
        </div></div>`;
      document.body.appendChild(overlay);
      const listEl = overlay.querySelector(".tk-cards-catpick-list");
      const searchEl = overlay.querySelector('[data-a="search"]');
      const close = () => overlay.remove();
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);
      overlay.querySelector('[data-a="cancel"]').addEventListener("click", close);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      const render = () => {
        const q = (searchEl.value || "").toLowerCase();
        listEl.innerHTML = "";
        for (const cat of this.cardCats) {
          if (q && !CAT_NAME(cat).toLowerCase().includes(q)) continue;
          const lab = document.createElement("label");
          lab.className = "tk-cards-catpick-item" + (curCats.includes(cat.id) ? " on" : "");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = curCats.includes(cat.id);
          cb.addEventListener("change", () => {
            const i = curCats.indexOf(cat.id);
            if (cb.checked) { if (i < 0) curCats.push(cat.id); }
            else { if (i >= 0) curCats.splice(i, 1); }
            lab.classList.toggle("on", cb.checked);
          });
          const span = document.createElement("span");
          span.textContent = CAT_NAME(cat);
          lab.appendChild(cb);
          lab.appendChild(span);
          listEl.appendChild(lab);
        }
        if (!listEl.children.length) {
          listEl.innerHTML = `<div class="tk-cards-empty">无匹配分类</div>`;
        }
      };
      overlay.querySelector('[data-a="ok"]').addEventListener("click", async () => {
        const finalCats = curCats.length ? curCats.slice() : catIdsOf(c).slice(); // 至少保留原分类
        if (JSON.stringify(catIdsOf(c).slice().sort()) !== JSON.stringify(finalCats.slice().sort())) {
          c.categories = finalCats;
          c.updatedAt = Date.now();
          await this.putCard(c);
        }
        close();
        this._renderCatTabs();
        this._renderCards();
        this._flash(`已更新分类（${finalCats.length} 个）`);
      });
      searchEl.addEventListener("input", render);
      render();
      searchEl.focus();
    }

    // 就地编辑（双击卡片）
    beginEdit(id, cardEl, c) {
      const orig = cardEl.innerHTML;
      cardEl.innerHTML = `<div class="tk-cards-edit">
        <label class="tk-cards-field"><span>英文 tag</span><input value="${escAttr(c.prompt || "")}" data-f="en" placeholder="英文 tag"></label>
        <label class="tk-cards-field"><span>中文注释</span><input value="${escAttr(c.notes || "")}" data-f="zh" placeholder="可自定义"></label>
        <label class="tk-cards-field"><span>权重</span><input value="${escAttr(c.weight || "")}" data-f="weight" placeholder="例如 1.2"></label>
        <label class="tk-cards-field"><span>LoRA 文件</span><input value="${escAttr(c.lora || "")}" data-f="lora" placeholder="可选"></label>
        <div class="tk-cards-edit-btns">
          <button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="save">保存</button>
          <button type="button" class="tk-cards-btn" data-a="cancel">取消</button></div></div>`;
      const readValues = () => ({
        prompt: cardEl.querySelector('[data-f="en"]')?.value.trim() || "",
        notes: cardEl.querySelector('[data-f="zh"]')?.value.trim() || "",
        weight: cardEl.querySelector('[data-f="weight"]')?.value.trim() || "",
        lora: cardEl.querySelector('[data-f="lora"]')?.value.trim() || "",
      });
      const commit = async (values) => {
        const next = { ...c, ...values, prompt: values.prompt || c.prompt, updatedAt: Date.now() };
        await this.putCard(next);
        Object.assign(c, next);
        this._renderCards();
        this._flash("已保存");
      };
      const session = this._bindInlineEdit(cardEl, orig, readValues, commit, cardEl.querySelector('[data-f="en"]'), () => this._renderCards());
      cardEl.querySelector('[data-a="save"]').addEventListener("click", session.save);
      cardEl.querySelector('[data-a="cancel"]').addEventListener("click", session.cancel);
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

    async importPngFile(file) {
      if (!file) return;
      if (!/\.png$/i.test(file.name || "") && file.type !== "image/png") {
        this._flash("只支持 PNG 图片");
        return;
      }
      this._flash(`正在解析：${file.name || "PNG"}…`, 30000);
      const form = new FormData();
      form.append("file", file, file.name || "prompt.png");
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
      try {
        const response = await apiFetch("/anima/cards/image", ctrl ? { method: "POST", body: form, signal: ctrl.signal } : { method: "POST", body: form });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
        if (!result.positive) { this._flash("该 PNG 没有可用的提示词元数据"); return; }
        this._setW(this.w.positive, result.positive);
        if (this.curTextEl) this.curTextEl.value = result.positive;
        this._renderChips();
        this._flash(`已解析 ${result.filename || file.name || "PNG"}（${result.positive.length} 字符）`);
      } catch (e) {
        this._flash("图片解析失败：" + (e.name === "AbortError" ? "请求超时" : (e.message || e)), 5000);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    showPngDialog() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,.png";
      input.addEventListener("change", () => this.importPngFile(input.files?.[0]));
      input.click();
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
                const cat = this.cardCats.find((c) => /lora/i.test(c.name))?.id || "card_lora";
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

    // ── AI 自动分类（LLM）──
    _chooseClassifyScope() {
      return new Promise((resolve) => {
        const currentName = this.curCat ? CAT_NAME(this.cardCats.find((c) => c.id === this.curCat)) : "当前分类";
        const currentCount = this.curCat ? this._categoryCount(this.curCat) : 0;
        const selectedCount = this.selectedCardIds.size;
        const overlay = document.createElement("div");
        overlay.className = "tk-cards-overlay";
        overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-classify-scope">
          <div class="tk-cards-overlay-head"><b>智能分类范围</b><button type="button" class="tk-cards-btn" data-a="close">关闭</button></div>
          <div class="tk-cards-category-note">默认只生成建议，不会立即写入卡片库；下一步可逐卡改判后再应用。</div>
          <label class="tk-cards-field"><span>处理范围</span><select data-f="scope">
            ${this.curCat ? `<option value="current">当前分类：${esc(currentName)}（${currentCount} 张）</option>` : ""}
            ${selectedCount ? `<option value="selected">已选卡片（${selectedCount} 张）</option>` : ""}
            <option value="uncategorized">仅未分类</option><option value="all">全部卡片（${this.cards.length} 张）</option>
          </select></label>
          <div class="tk-cards-ai-actions"><button type="button" class="tk-cards-btn" data-a="cancel">取消</button><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="start">生成分类建议</button></div>
        </div>`;
        document.body.appendChild(overlay);
        const close = (value = null) => { overlay.remove(); resolve(value); };
        overlay.querySelector('[data-a="close"]').addEventListener("click", () => close());
        overlay.querySelector('[data-a="cancel"]').addEventListener("click", () => close());
        overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
        overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
        overlay.querySelector('[data-a="start"]').addEventListener("click", () => close(overlay.querySelector('[data-f="scope"]').value));
      });
    }

    async _showClassifyPreview(suggestions, scope) {
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      const options = (selected) => this.cardCats.map((cat) => `<option value="${escAttr(cat.id)}" ${cat.id === selected ? "selected" : ""}>${esc(CAT_NAME(cat))}</option>`).join("");
      const fallbackId = this.cardCats.find((c) => c.name === "通用")?.id || this.cardCats[0]?.id || "";
      const rows = suggestions.map((s, i) => {
        const current = catIdsOf(s.card);
        const suggestedId = s.categoryId || current[0] || fallbackId;
        const currentName = current.map((id) => CAT_NAME(this.cardCats.find((c) => c.id === id))).join("、") || "未分类";
        const confidence = Number.isFinite(s.confidence) ? `${Math.round(s.confidence * 100)}%` : "未提供";
        const reason = s.reason || "模型未提供理由";
        return `<div class="tk-cards-ai-row" data-i="${i}"><div class="tk-cards-ai-text"><b>${esc(s.card.prompt || "")}</b><span class="tk-cards-ai-zh">原分类：${esc(currentName)} · 建议：${esc(s.categoryName || "未匹配")} · 置信度：${confidence}</span><span class="tk-cards-ai-reason">${esc(reason)}</span></div><select class="tk-cards-ai-cat" data-f="cat">${options(suggestedId)}</select><button type="button" class="tk-cards-ai-rm" data-a="remove" title="移除，不应用">移除</button></div>`;
      }).join("");
      overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-classify-preview">
        <div class="tk-cards-overlay-head"><b>分类建议 · ${suggestions.length} 张</b><button type="button" class="tk-cards-btn" data-a="close">关闭</button></div>
        <div class="tk-cards-classify-toolbar"><span data-a="count">待应用 ${suggestions.length} 张</span><label><input type="checkbox" data-a="high-only"> 仅应用置信度 ≥ 70%</label></div>
        <div class="tk-cards-ai-list">${rows || `<div class="tk-cards-empty">没有可预览的分类建议</div>`}</div>
        <div class="tk-cards-ai-actions"><button type="button" class="tk-cards-btn" data-a="cancel">取消，不写入</button><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="apply">确认应用</button></div>
      </div>`;
      document.body.appendChild(overlay);
      const removed = new Set();
      const close = () => {
        overlay.remove();
        if (this.statusEl?.textContent?.startsWith("生成分类建议中")) this._flash("分类建议未应用");
      };
      const updateCount = () => {
        const highOnly = overlay.querySelector('[data-a="high-only"]').checked;
        const n = suggestions.reduce((sum, s, i) => sum + (!removed.has(i) && (!highOnly || (Number.isFinite(s.confidence) && s.confidence >= 0.7)) ? 1 : 0), 0);
        overlay.querySelector('[data-a="count"]').textContent = `待应用 ${n} 张`;
      };
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);
      overlay.querySelector('[data-a="cancel"]').addEventListener("click", close);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
      overlay.querySelectorAll('[data-a="remove"]').forEach((button) => button.addEventListener("click", () => {
        const i = Number(button.closest(".tk-cards-ai-row").getAttribute("data-i"));
        if (removed.has(i)) { removed.delete(i); button.textContent = "移除"; button.closest(".tk-cards-ai-row").classList.remove("removed"); }
        else { removed.add(i); button.textContent = "恢复"; button.closest(".tk-cards-ai-row").classList.add("removed"); }
        updateCount();
      }));
      overlay.querySelector('[data-a="high-only"]').addEventListener("change", updateCount);
      overlay.querySelector('[data-a="apply"]').addEventListener("click", async () => {
        const highOnly = overlay.querySelector('[data-a="high-only"]').checked;
        const applyButton = overlay.querySelector('[data-a="apply"]');
        applyButton.disabled = true;
        let applied = 0, skipped = 0, invalid = 0;
        for (let i = 0; i < suggestions.length; i++) {
          const s = suggestions[i];
          if (removed.has(i) || (highOnly && !(Number.isFinite(s.confidence) && s.confidence >= 0.7))) { skipped++; continue; }
          const row = overlay.querySelector(`.tk-cards-ai-row[data-i="${i}"]`);
          const catId = row?.querySelector('[data-f="cat"]')?.value || "";
          const card = this.cards.find((c) => c.id === s.card.id);
          if (!card || !catId) { invalid++; continue; }
          const cats = catIdsOf(card);
          if (cats.includes(catId)) { skipped++; continue; }
          card.categories = cats.concat([catId]);
          card.categoryId = card.categories[0] || "";
          card.updatedAt = Date.now();
          await this.putCard(card);
          applied++;
        }
        close();
        this.selectedCardIds.clear();
        this._renderCatTabs();
        this._renderCards();
        this._flash(`智能分类已应用：${applied} 张，跳过 ${skipped} 张${invalid ? `，无效 ${invalid} 张` : ""}`);
      });
      updateCount();
    }

    async aiClassify() {
      const available = this.cards.filter((c) => String(c.prompt || "").trim());
      if (!available.length) { this._flash("卡片库为空"); return; }
      if (!this.cardCats.length) { this._flash("没有可用分类"); return; }
      const scope = await this._chooseClassifyScope();
      if (!scope) return;
      let todo = available;
      if (scope === "current") todo = available.filter((c) => cardInCat(c, this.curCat));
      if (scope === "selected") todo = available.filter((c) => this.selectedCardIds.has(c.id));
      if (scope === "uncategorized") todo = available.filter((c) => !catIdsOf(c).length);
      if (!todo.length) { this._flash("该范围没有可分类的卡片"); return; }
      const catNames = this.cardCats.map((c) => c.name);
      const name2id = {};
      for (const c of this.cardCats) name2id[c.name] = c.id;
      this._flash(`生成分类建议中：${todo.length} 张（每批 30）…`, 90000);
      const suggestions = [];
      for (let i = 0; i < todo.length; i += 30) {
        const batch = todo.slice(i, i + 30);
        let res;
        try {
          res = await postJson("/anima/cards/classify", { cards: batch.map((c) => ({ id: c.id, text: c.prompt })), cats: catNames, cats_info: catsInfoOf(this.cardCats) }, 90000);
        } catch (e) {
          this._flash("智能分类失败：" + (e.message || e) + "；未写入任何卡片", 6000);
          return;
        }
        if (!res.ok) { this._flash("智能分类失败：" + (res.error || "") + "；未写入任何卡片", 6000); return; }
        const byId = new Map((res.result || []).map((r) => [String(r.id), r]));
        for (const card of batch) {
          const r = byId.get(String(card.id)) || {};
          suggestions.push({ card, categoryName: r.categoryName || "未匹配", categoryId: name2id[r.categoryName] || "", reason: r.reason || "", confidence: Number.isFinite(r.confidence) ? r.confidence : null });
        }
      }
      await this._showClassifyPreview(suggestions, scope);
    }

    // LLM 配置（Ollama 本地 或 OpenAI 兼容反代）
    async llmSettings() {
      let conf = {};
      try { conf = await fetchJson("/anima/llm/config"); } catch (e) { conf = { mode: "auto", error: e.message || String(e) }; }
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-settings-box">
        <div class="tk-cards-overlay-head"><b>LLM 设置</b><button type="button" class="tk-cards-btn" data-a="close">关闭</button></div>
        <div class="tk-cards-settings-status" data-a="status"></div>
        <div class="tk-cards-settings-form">
          <label class="tk-cards-field"><span>连接模式</span><select data-f="mode"><option value="auto">自动：Ollama 优先</option><option value="ollama">Ollama</option><option value="api">OpenAI 兼容 API</option></select></label>
          <div class="tk-cards-settings-api" data-a="api-fields">
            <label class="tk-cards-field"><span>Base URL</span><input data-f="base" placeholder="例如 http://127.0.0.1:8080/v1"></label>
            <label class="tk-cards-field"><span>模型名</span><input data-f="model" placeholder="例如 qwen-turbo"></label>
            <label class="tk-cards-field"><span>API Key</span><input data-f="key" type="password" placeholder="${conf.hasApiKey ? "已保存，留空保持不变" : "可留空"}"></label>
          </div>
        </div>
        <div class="tk-cards-settings-note">API Key 只显示是否已保存，不会回显完整内容。点击“测试连接”不会写入配置文件。</div>
        <div class="tk-cards-ai-actions"><button type="button" class="tk-cards-btn" data-a="clear-key">清除 Key</button><button type="button" class="tk-cards-btn" data-a="test">测试连接</button><button type="button" class="tk-cards-btn" data-a="cancel">取消</button><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="save">保存设置</button></div>
      </div>`;
      document.body.appendChild(overlay);
      const modeEl = overlay.querySelector('[data-f="mode"]');
      const baseEl = overlay.querySelector('[data-f="base"]');
      const modelEl = overlay.querySelector('[data-f="model"]');
      const keyEl = overlay.querySelector('[data-f="key"]');
      const statusEl = overlay.querySelector('[data-a="status"]');
      const apiFields = overlay.querySelector('[data-a="api-fields"]');
      modeEl.value = ["auto", "ollama", "api"].includes(conf.mode) ? conf.mode : "auto";
      baseEl.value = conf.base_url || "";
      modelEl.value = conf.model || "";
      const close = () => overlay.remove();
      const setStatus = (text, kind = "") => { statusEl.textContent = text; statusEl.className = "tk-cards-settings-status" + (kind ? ` ${kind}` : ""); };
      const updateMode = () => { apiFields.hidden = modeEl.value === "ollama"; };
      const read = () => ({ mode: modeEl.value, base_url: baseEl.value.trim(), model: modelEl.value.trim(), api_key: keyEl.value.trim() });
      const initialStatus = conf.error
        ? `配置读取失败：${conf.error}`
        : `当前模式：${conf.mode || "auto"} · Ollama：${conf.ollama?.available ? `可用（${conf.ollama.model || "已连接"}）` : "未检测到"} · API Key：${conf.hasApiKey ? "已保存" : "未设置"}`;
      setStatus(initialStatus, conf.error ? "is-error" : "");
      updateMode();
      modeEl.addEventListener("change", updateMode);
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);
      overlay.querySelector('[data-a="cancel"]').addEventListener("click", close);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
      overlay.querySelector('[data-a="clear-key"]').addEventListener("click", async () => {
        try {
          await postJson("/anima/llm/config", { api_key: "", api_key_clear: true });
          conf.hasApiKey = false;
          keyEl.value = "";
          keyEl.placeholder = "可留空";
          setStatus("API Key 已清除", "is-success");
        } catch (e) { setStatus("清除失败：" + (e.message || e), "is-error"); }
      });
      overlay.querySelector('[data-a="test"]').addEventListener("click", async () => {
        const payload = read();
        if (payload.mode === "api" && (!payload.base_url || !payload.model) && !conf.hasApiKey) {
          setStatus("API 模式需要 Base URL 和模型名", "is-error");
          return;
        }
        setStatus("连接测试中…");
        try {
          const r = await postJson("/anima/llm/test", payload, 25000);
          if (!r.ok) throw new Error(r.error || "测试失败");
          setStatus(`连接成功 · ${r.mode || payload.mode} · ${r.model || "自动模型"} · ${r.latencyMs || 0}ms`, "is-success");
        } catch (e) { setStatus(e.message || String(e), "is-error"); }
      });
      overlay.querySelector('[data-a="save"]').addEventListener("click", async () => {
        const payload = read();
        if (payload.mode === "api" && (!payload.base_url || !payload.model)) {
          setStatus("API 模式需要 Base URL 和模型名", "is-error");
          return;
        }
        if (!payload.api_key) delete payload.api_key;
        setStatus("保存中…");
        try {
          await postJson("/anima/llm/config", payload);
          this._flash("LLM 设置已保存");
          close();
        } catch (e) { setStatus("保存失败：" + (e.message || e), "is-error"); }
      });
    }

    async batchTranslate() {
      const todo = this.cards.filter((p) => !String(p.notes || "").trim() && String(p.prompt || "").trim());
      if (!todo.length) { this._flash("没有待翻译的卡片"); return; }
      this._flash(`批量翻译中：${todo.length} 张（DeepLX → DashScope 回退）`);
      let okN = 0;
      const workers = Array.from({ length: 3 }, async () => {
        while (todo.length) {
          const p = todo.pop();
          try {
            const zh = await translateAuto(p.prompt);
            if (zh) { p.notes = zh; p.updatedAt = Date.now(); okN++; await this.putCard(p); }
          } catch (e) { /* 单卡失败跳过 */ }
        }
      });
      await Promise.all(workers);
      this._renderCards();
      this._flash(`批量翻译完成：成功 ${okN} / ${todo.length + okN}`);
    }

    async exportCards() {
      const name = prompt("导出文件名（写入 input/prompts/）：", "prompt_cards_" + new Date().toISOString().slice(0, 10));
      const n = (name || "").trim();
      if (!n) return;
      const groups = [];
      for (const c of this.cardCats) {
        const cards = this.cards.filter((p) => cardInCat(p, c.id) && String(p.prompt || "").trim());
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

    // 导出卡片库（v2 信封 JSON 备份：换机/换浏览器/清站点数据恢复用）
    async exportCardLib() {
      if (!_cardLibCache) await loadCardLib();
      const data = JSON.stringify(_cardLibCache, null, 1);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tk-cards-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this._flash(`已导出 ${_cardLibCache.cards.length} 张卡片（JSON 备份）`);
    }

    // 导入卡片库（JSON 备份恢复 = 替换当前库；兼容旧 {分类名: [卡]} 结构）
    async importCardLib() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const data = JSON.parse(text);
          let cards = Array.isArray(data.cards) ? data.cards : null;
          if (!cards && data.cards && typeof data.cards === "object") {
            cards = Object.values(data.cards).flat();
          }
          if (!Array.isArray(cards)) { this._flash("备份文件格式不对（缺少 cards 数组）"); return; }
          const catCount = Array.isArray(data.categories) ? data.categories.length : 0;
          if (!confirm(`导入将替换当前卡片库（${cards.length} 张卡片${catCount ? `，${catCount} 个分类` : ""}）。确认？`)) return;
          const body = {
            version: 2, updated: Date.now(),
            categories: Array.isArray(data.categories) && data.categories.length
              ? data.categories : CARD_DEFAULT_CATS.map((c) => ({ ...c })),
            cards: cards
              .map((c) => cardToEnvelope({ ...(c || {}), prompt: String(c.en || c.prompt || "") }))
              .filter((c) => c.en),
          };
          const r = await postJson("/anima/cards", body);
          if (!r || !r.ok) throw new Error((r && r.error) || "导入失败");
          await this.reloadCards();
          this._flash(`已导入 ${r.count || body.cards.length} 张卡片（替换式恢复）`);
        } catch (e) {
          this._flash("导入失败：" + (e.message || e));
        }
      };
      input.click();
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
      container.tabIndex = 0;
      this.rootEl = container;
      container.addEventListener("keydown", (ev) => {
        if (ev.key !== "F2") return;
        const active = document.activeElement;
        const libEl = active?.closest?.(".tk-cards-lib-item");
        const cardEl = active?.closest?.(".tk-cards-card");
        if (libEl) {
          const item = this.prompts.find((p) => p.id === libEl.getAttribute("data-id"));
          if (item) { ev.preventDefault(); this.beginLibEdit(item, libEl); }
        } else if (cardEl) {
          const item = this.cards.find((c) => c.id === cardEl.getAttribute("data-id"));
          if (item) { ev.preventDefault(); this.beginEdit(item.id, cardEl, item); }
        }
      });

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
      const libBody = this._attachSectionBody(libSec, libHead, "lib", "工具箱 prompt 库");
      const libBtns = document.createElement("div");
      libBtns.className = "tk-cards-sec-btns";
      const libTab = document.createElement("button");
      libTab.type = "button";
      libTab.className = "tk-cards-btn";
      libTab.textContent = "批文件";
      libTab.addEventListener("click", () => this._switchLibPane("batch"));
      const libTabAll = document.createElement("button");
      libTabAll.type = "button";
      libTabAll.className = "tk-cards-btn tk-cards-btn-main";
      libTabAll.textContent = "库浏览";
      libTabAll.addEventListener("click", () => this._switchLibPane("lib"));
      // 刷新（面板新入库/改动后即时同步，无需刷页面）
      const libRefresh = document.createElement("button");
      libRefresh.type = "button";
      libRefresh.className = "tk-cards-btn";
      libRefresh.textContent = "重新读取";
      libRefresh.title = "重新读取 prompt 库与卡片库（面板新增/改动后点此同步）";
      libRefresh.addEventListener("click", () => {
        this.reloadAll();
        this._flash("已刷新（prompt 库 + 卡片库）");
      });
      // 清理误入卡（历史版本把卡片写进了 prompt 库；只在存在 kind=card 条目时显示）
      this.cleanBtn = document.createElement("button");
      this.cleanBtn.type = "button";
      this.cleanBtn.className = "tk-cards-btn tk-cards-btn-danger";
      this.cleanBtn.textContent = "清理【卡】";
      this.cleanBtn.title = "删除误入 prompt 库的卡片条目（kind=card，带【卡】标记）；完整词条不受影响";
      this.cleanBtn.style.display = "none";
      this.cleanBtn.addEventListener("click", () => this.cleanMisfiledCards());
      libBtns.appendChild(libTabAll);
      libBtns.appendChild(libTab);
      libBtns.appendChild(libRefresh);
      libBtns.appendChild(this.cleanBtn);
      libHead.appendChild(libBtns);
      // ①区分类过滤下拉（prompt 库分类，与面板同步）
      this.libCatSel = document.createElement("select");
      this.libCatSel.className = "tk-cards-select";
      this.libCatSel.addEventListener("change", () => {
        this.curLibCat = this.libCatSel.value;
        this._renderLibList();
      });
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
      libBody.appendChild(this.libCatSel);
      libBody.appendChild(this.libSearchEl);
      libBody.appendChild(this.libListEl);
      libBody.appendChild(this.fileSel);
      libBody.appendChild(this.groupListEl);
      container.appendChild(libSec);

      // ═══ ② 当前提示词区 ═══
      const curSec = document.createElement("div");
      curSec.className = "tk-cards-sec";
      const curHead = document.createElement("div");
      curHead.className = "tk-cards-sec-head";
      curHead.innerHTML = `<b>② 当前提示词</b>`;
      const curBody = this._attachSectionBody(curSec, curHead, "current", "当前提示词");
      const curBtns = document.createElement("div");
      curBtns.className = "tk-cards-sec-btns";
      const clipboardBtn = document.createElement("button");
      clipboardBtn.type = "button"; clipboardBtn.className = "tk-cards-btn"; clipboardBtn.textContent = "导入";
      clipboardBtn.title = "从剪切板导入并拆分";
      clipboardBtn.addEventListener("click", () => this.importClipboard());
      const pngBtn = document.createElement("button");
      pngBtn.type = "button"; pngBtn.className = "tk-cards-btn"; pngBtn.textContent = "选择 PNG";
      pngBtn.title = "选择 PNG 文件并解析元数据为提示词";
      pngBtn.addEventListener("click", () => this.showPngDialog());
      const draftBtn = document.createElement("button");
      draftBtn.type = "button"; draftBtn.className = "tk-cards-btn"; draftBtn.textContent = "恢复草稿";
      draftBtn.title = "恢复草稿（切组/切库前自动暂存）";
      draftBtn.addEventListener("click", () => this.restoreDraft());
      const clearBtn = document.createElement("button");
      clearBtn.type = "button"; clearBtn.className = "tk-cards-btn"; clearBtn.textContent = "清空";
      clearBtn.title = "清空当前提示词";
      clearBtn.addEventListener("click", () => { this._setW(this.w.positive, ""); if (this.curTextEl) this.curTextEl.value = ""; this._renderChips(); });
      const translateBtn = document.createElement("button");
      translateBtn.type = "button"; translateBtn.className = "tk-cards-btn"; translateBtn.textContent = "翻译";
      translateBtn.title = "只翻译当前所有片段并显示中文小字（不入库，不污染分类）";
      translateBtn.addEventListener("click", () => this.translatePiecesOnly());
      const cardsAddBtn = document.createElement("button");
      cardsAddBtn.type = "button"; cardsAddBtn.className = "tk-cards-btn tk-cards-btn-main"; cardsAddBtn.textContent = "智能入卡";
      cardsAddBtn.title = "当前所有片段交 LLM 自动判定分类 → 确认清单（可改判）→ 分类入库";
      cardsAddBtn.addEventListener("click", () => this.cardsAddAll());
      curBtns.appendChild(clipboardBtn); curBtns.appendChild(pngBtn); curBtns.appendChild(draftBtn); curBtns.appendChild(clearBtn); curBtns.appendChild(translateBtn); curBtns.appendChild(cardsAddBtn);
      curHead.appendChild(curBtns);
      this.curTextEl = document.createElement("textarea");
      this.curTextEl.className = "tk-cards-textarea";
      this.curTextEl.placeholder = "当前提示词（点库条目/卡片/粘贴/拖入 PNG 填充；输入时卡片库联想补全）";
      this.curTextEl.value = this.w.positive?.value || "";
      this.curTextEl.addEventListener("input", () => this.onCurInput());
      this.curTextEl.addEventListener("keydown", (e) => this._suggestKeyDown(e));
      this.pngDropEl = document.createElement("div");
      this.pngDropEl.className = "tk-cards-png-drop";
      this.pngDropEl.innerHTML = `<span>拖入 PNG 解析提示词</span><button type="button" class="tk-cards-btn" data-a="choose-png">选择文件</button>`;
      this.pngDropEl.querySelector('[data-a="choose-png"]').addEventListener("click", () => this.showPngDialog());
      this.pngDropEl.addEventListener("dragover", (ev) => { ev.preventDefault(); this.pngDropEl.classList.add("is-dragging"); });
      this.pngDropEl.addEventListener("dragleave", () => this.pngDropEl.classList.remove("is-dragging"));
      this.pngDropEl.addEventListener("drop", (ev) => {
        ev.preventDefault();
        this.pngDropEl.classList.remove("is-dragging");
        this.importPngFile(ev.dataTransfer?.files?.[0]);
      });
      this.suggestEl = document.createElement("div");
      this.suggestEl.className = "tk-cards-suggest";
      this.suggestEl.style.display = "none";
      document.addEventListener("click", (e) => {
        if (this.suggestEl && this.suggestEl.style.display !== "none" &&
            !this.suggestEl.contains(e.target) && e.target !== this.curTextEl) {
          this._hideSuggest();
        }
      });
      this.chipsEl = document.createElement("div");
      this.chipsEl.className = "tk-cards-chips";
      const curTools = document.createElement("div");
      curTools.className = "tk-cards-cur-tools";
      const saveAllBtn = document.createElement("button");
      saveAllBtn.type = "button"; saveAllBtn.className = "tk-cards-btn tk-cards-btn-main";
      saveAllBtn.textContent = "＋ 整段存组合卡";
      saveAllBtn.title = "把当前提示词整段存入当前分类（点它=整段追加，可拆 tag 编辑）";
      saveAllBtn.addEventListener("click", () => this.saveCurrentAsCard());
      const undoBtn = document.createElement("button");
      undoBtn.type = "button"; undoBtn.className = "tk-cards-btn";
       undoBtn.textContent = "撤销删除";
      undoBtn.addEventListener("click", () => this.undoDelete());
      curTools.appendChild(saveAllBtn); curTools.appendChild(undoBtn);
      curBody.appendChild(this.pngDropEl);
      curBody.appendChild(this.curTextEl);
      curBody.appendChild(this.suggestEl);
      curBody.appendChild(this.chipsEl);
      curBody.appendChild(curTools);
      container.appendChild(curSec);

      // ═══ ③ 卡片视图区 ═══
      const cardSec = document.createElement("div");
      cardSec.className = "tk-cards-sec";
      const cardHead = document.createElement("div");
      cardHead.className = "tk-cards-sec-head";
      cardHead.innerHTML = `<b>③ 卡片视图</b>`;
      const cardBody = this._attachSectionBody(cardSec, cardHead, "cards", "卡片库");
      const cardBtns = document.createElement("div");
      cardBtns.className = "tk-cards-sec-btns";
      const loraBtn = document.createElement("button");
      loraBtn.type = "button"; loraBtn.className = "tk-cards-btn tk-cards-btn-main"; loraBtn.textContent = "LoRA 触发词";
      loraBtn.title = "浏览 LoRA → 一键收藏触发词卡片 / 追加触发词";
      loraBtn.addEventListener("click", () => this.showLoraDialog());
      const tlBtn = document.createElement("button");
      tlBtn.type = "button"; tlBtn.className = "tk-cards-btn"; tlBtn.textContent = "补翻";
      tlBtn.title = "批量翻译缺中文注释的卡片";
      tlBtn.addEventListener("click", () => this.batchTranslate());
      const aiBtn = document.createElement("button");
      aiBtn.type = "button"; aiBtn.className = "tk-cards-btn tk-cards-btn-main"; aiBtn.textContent = "智能分类";
      aiBtn.title = "用 LLM 自动为卡片分类（Ollama 本地 或 API 反代；分类名不匹配的归「通用」）";
      aiBtn.addEventListener("click", () => this.aiClassify());
      const llmBtn = document.createElement("button");
      llmBtn.type = "button"; llmBtn.className = "tk-cards-btn"; llmBtn.textContent = "LLM";
      llmBtn.title = "配置自动分类的 LLM（Ollama / OpenAI 兼容反代）";
      llmBtn.addEventListener("click", () => this.llmSettings());
      const exBtn = document.createElement("button");
      exBtn.type = "button"; exBtn.className = "tk-cards-btn"; exBtn.textContent = "导出";
      exBtn.title = "导出卡片为批文件（input/prompts/）";
      exBtn.addEventListener("click", () => this.exportCards());
      const bkuBtn = document.createElement("button");
      bkuBtn.type = "button"; bkuBtn.className = "tk-cards-btn"; bkuBtn.textContent = "导出库";
      bkuBtn.title = "导出卡片库 JSON 备份（后端 cards.json 当前内容；换机/换浏览器恢复用）";
      bkuBtn.addEventListener("click", () => this.exportCardLib());
      const bkiBtn = document.createElement("button");
      bkiBtn.type = "button"; bkiBtn.className = "tk-cards-btn"; bkiBtn.textContent = "导入库";
      bkiBtn.title = "从 JSON 备份恢复卡片库（替换式导入）";
      bkiBtn.addEventListener("click", () => this.importCardLib());
      cardBtns.appendChild(loraBtn); cardBtns.appendChild(tlBtn); cardBtns.appendChild(aiBtn); cardBtns.appendChild(llmBtn); cardBtns.appendChild(exBtn);
      cardBtns.appendChild(bkuBtn); cardBtns.appendChild(bkiBtn);
      cardHead.appendChild(cardBtns);
      this.catTabsEl = document.createElement("div");
      this.catTabsEl.className = "tk-cards-cats";
      this.cardGridEl = document.createElement("div");
      this.cardGridEl.className = "tk-cards-grid";
      cardBody.appendChild(this.catTabsEl);
      cardBody.appendChild(this.cardGridEl);
      container.appendChild(cardSec);

      // 初始
      this._renderChips();
      this._renderCatTabs();
      this._renderCards();
      this._renderLibList();
      this.reloadAll();
      this._loadBatchFiles();
      this._switchLibPane(this.uiState.pane || "lib");
      if (this.w.positive?.value) this._renderChips();
    }

    _switchLibPane(which) {
      const lib = which === "lib";
      this.uiState.pane = lib ? "lib" : "batch";
      saveUiState(this.uiState);
      this.libCatSel.style.display = lib ? "" : "none";
      this.libSearchEl.style.display = lib ? "" : "none";
      this.libListEl.style.display = lib ? "" : "none";
      this.fileSel.style.display = lib ? "none" : "";
      this.groupListEl.style.display = lib ? "none" : "";
      this.libPaneMode = lib ? "lib" : "batch";
      if (!lib) this._loadBatchFiles();
    }
  }

  // ── 样式 ──
  function injectStyle() {
    if (document.getElementById("anima-cards-style")) return;
    const s = document.createElement("style");
    s.id = "anima-cards-style";
    s.textContent = `
 .tk-cards-ui { --tk-bg:#111315; --tk-surface:#17191b; --tk-surface-2:#1d2023; --tk-border:#34383c; --tk-border-soft:#272b2e; --tk-text:#e7e4de; --tk-muted:#9b9a95; --tk-accent:#d0c9bb; --tk-accent-strong:#f0ece4; --tk-warn:#c6a76a; --tk-info:#9bb2b6; --tk-danger:#cb8585; display:flex; flex-direction:column; gap:8px; width:100%; min-width:260px; font:12px/1.4 var(--font-family,system-ui,sans-serif); color:var(--tk-text); }
 .tk-cards-status { min-height:18px; padding:2px 3px; color:var(--tk-muted); font-size:10px; }
 .tk-cards-section { position:relative; display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--tk-border); border-radius:6px; background:var(--tk-surface); box-shadow:0 2px 8px rgba(0,0,0,.16); }
 .tk-cards-sec-head-main { display:flex; align-items:center; justify-content:flex-start; flex-wrap:wrap; gap:6px; min-height:34px; padding:5px 7px; border-bottom:1px solid var(--tk-border-soft); background:rgba(255,255,255,.025); color:var(--tk-text); }
 .tk-cards-section.is-collapsed .tk-cards-sec-head-main { border-bottom:0; }
 .tk-cards-sec-title { flex:0 0 auto; white-space:nowrap; font-size:11px; font-weight:650; letter-spacing:.01em; color:var(--tk-accent-strong); }
 .tk-cards-section-toggle { flex:0 0 24px; width:24px; height:24px; padding:0; border:1px solid transparent; border-radius:4px; background:transparent; color:var(--tk-muted); cursor:pointer; font-size:14px; line-height:20px; }
 .tk-cards-section-toggle:hover, .tk-cards-section-toggle:focus-visible { border-color:var(--tk-border); background:var(--tk-surface-2); color:var(--tk-accent-strong); outline:none; }
 .tk-cards-sec-body { display:flex; flex-direction:column; gap:7px; padding:8px; }
 .tk-cards-sec-btns { display:flex; flex:1 1 150px; min-width:0; align-items:center; justify-content:flex-start; gap:4px; flex-wrap:wrap; }
 .tk-cards-btn { min-height:28px; padding:4px 9px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-text); cursor:pointer; font-size:11px; line-height:18px; transition:border-color .15s ease,background .15s ease,color .15s ease,opacity .15s ease; }
 .tk-cards-btn:hover { border-color:var(--tk-accent); background:#2a2d30; color:var(--tk-accent-strong); }
 .tk-cards-btn:focus-visible { outline:2px solid var(--tk-accent); outline-offset:1px; }
 .tk-cards-btn:disabled { opacity:.45; cursor:default; }
 .tk-cards-btn-main { border-color:var(--tk-accent); background:var(--tk-accent); color:#17191b; font-weight:650; }
 .tk-cards-btn-main:hover { border-color:var(--tk-accent-strong); background:var(--tk-accent-strong); color:#111315; }
 .tk-cards-btn-danger { border-color:rgba(203,133,133,.7); background:rgba(203,133,133,.10); color:#e1a5a5; }
 .tk-cards-btn-danger:hover { border-color:var(--tk-danger); background:rgba(203,133,133,.18); color:#f0c0c0; }
 .tk-cards-select { width:100%; min-height:30px; box-sizing:border-box; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-text); font-size:11px; padding:5px 7px; }
 .tk-cards-search { width:100%; min-height:30px; box-sizing:border-box; border:1px solid var(--tk-border); border-radius:4px; background:#141618; color:var(--tk-text); font-size:11px; padding:5px 8px; }
 .tk-cards-search:focus, .tk-cards-textarea:focus { outline:none; border-color:var(--tk-accent); box-shadow:0 0 0 2px rgba(208,201,187,.12); }
 .tk-cards-lib-list { display:grid; grid-template-columns:repeat(2,minmax(120px,1fr)); gap:6px; max-height:210px; overflow:auto; }
 .tk-cards-lib-item { position:relative; min-width:0; display:flex; flex-direction:column; gap:4px; padding:6px 7px; border:1px solid var(--tk-border-soft); border-radius:5px; background:#151719; cursor:pointer; }
 .tk-cards-lib-item:has(.tk-cards-del) { padding-right:42px; }
 .tk-cards-lib-item:hover, .tk-cards-lib-item:focus-within { border-color:var(--tk-accent); background:#1d2022; }
 .tk-cards-lib-item.is-card { border-left:3px solid var(--tk-warn); }
 .tk-cards-lib-thumb { width:100%; height:58px; border-radius:3px; overflow:hidden; background:#0d0f10; }
 .tk-cards-lib-thumb img { width:100%; height:100%; object-fit:cover; }
 .tk-cards-lib-head { display:flex; justify-content:space-between; align-items:center; gap:5px; }
 .tk-cards-lib-title { min-width:0; color:var(--tk-text); font-size:11px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-lib-fav { color:var(--tk-warn); font-size:12px; flex-shrink:0; }
 .tk-cards-lib-sub { color:var(--tk-muted); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-lib-tip { position:fixed; z-index:99999; max-width:260px; max-height:280px; overflow:auto; padding:7px; border:1px solid var(--tk-border); border-radius:5px; background:#1b1e20; box-shadow:0 8px 22px rgba(0,0,0,.45); color:var(--tk-text); font-size:11px; white-space:pre-wrap; pointer-events:none; }
.tk-cards-lib-tip img { display:block; max-width:230px; max-height:230px; border-radius:3px; }
.tk-cards-groups { max-height:150px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
.tk-cards-group { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:4px; }
 .tk-cards-group:hover { background:rgba(255,255,255,.05); }
.tk-cards-group-info { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:help; }
 .tk-cards-textarea { width:100%; min-height:82px; box-sizing:border-box; background:#141618; color:var(--tk-text); border:1px solid var(--tk-border); border-radius:4px; font-size:12px; padding:7px 8px; resize:vertical; }
 .tk-cards-png-drop { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:34px; padding:5px 8px; border:1px dashed #555a5e; border-radius:4px; background:#141618; color:var(--tk-muted); font-size:10px; }
 .tk-cards-png-drop.is-dragging { border-color:var(--tk-accent); background:#292d30; color:var(--tk-accent-strong); }
/* ②区卡片库联想下拉 */
 .tk-cards-suggest { position:absolute; left:8px; right:8px; z-index:80; margin-top:2px; display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--tk-border); border-radius:5px; background:#1b1e20; box-shadow:0 8px 18px rgba(0,0,0,.45); }
 .tk-cards-suggest-item { display:flex; align-items:center; gap:7px; padding:7px 9px; font-size:11px; cursor:pointer; color:var(--tk-text); }
 .tk-cards-suggest-item .s-en { font-weight:650; color:var(--tk-accent-strong); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
 .tk-cards-suggest-item .s-zh { color:var(--tk-muted); flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-suggest-item .s-cat { color:var(--tk-info); flex-shrink:0; }
 .tk-cards-suggest-item:hover, .tk-cards-suggest-item.sel { background:rgba(255,255,255,.08); }
.tk-cards-chips { display:flex; flex-wrap:wrap; gap:4px; max-height:90px; overflow:auto; }
 .tk-cards-chip { position:relative; max-width:220px; padding:4px 22px 4px 8px; border:1px solid #555a5e; border-radius:4px; background:#24282b; color:var(--tk-text); cursor:pointer; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-chip:hover { border-color:var(--tk-accent); background:#303437; }
.tk-cards-chip-en { }
 .tk-cards-chip-zh { display:block; font-size:9px; color:var(--tk-muted); }
.tk-cards-chip-x { position:absolute; top:0; right:0; bottom:0; display:none; background:transparent; border:none; color:#ff8a8a; font-size:9px; cursor:pointer; padding:0 3px; }
.tk-cards-chip:hover .tk-cards-chip-x { display:block; }
.tk-cards-chip-x:hover { color:#ff5555; }
.tk-cards-cur-tools { display:flex; gap:4px; }
 .tk-cards-cats { display:flex; flex-wrap:wrap; gap:4px; padding-bottom:2px; }
 .tk-cards-cat { min-height:28px; padding:4px 9px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-muted); cursor:pointer; font-size:11px; }
 .tk-cards-cat:hover { border-color:var(--tk-accent); color:var(--tk-text); }
 .tk-cards-cat.on { border-color:var(--tk-accent); background:#34383b; color:var(--tk-accent-strong); font-weight:650; }
 .tk-cards-cat-add { border-style:dashed; color:var(--tk-muted); }
 .tk-cards-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); grid-auto-rows:minmax(112px,auto); gap:7px; max-height:300px; overflow:auto; }
 .tk-cards-card { position:relative; min-height:112px; padding:32px 8px 8px; border:1px solid var(--tk-border-soft); border-radius:5px; cursor:pointer; background:#151719; display:flex; flex-direction:column; gap:4px; transition:border-color .15s ease,background .15s ease; }
 .tk-cards-card:hover, .tk-cards-card:focus-within { border-color:var(--tk-accent); background:#1d2022; }
 .tk-cards-del, .tk-cards-cat-btn, .tk-cards-pin { position:absolute; top:4px; display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:1px solid transparent; border-radius:4px; background:transparent; cursor:pointer; font-size:11px; line-height:1; }
 .tk-cards-del { right:4px; color:var(--tk-danger); }
 .tk-cards-cat-btn { right:36px; color:var(--tk-info); }
 .tk-cards-pin { right:68px; color:var(--tk-warn); }
 .tk-cards-del:hover, .tk-cards-cat-btn:hover, .tk-cards-pin:hover, .tk-cards-del:focus-visible, .tk-cards-cat-btn:focus-visible, .tk-cards-pin:focus-visible { border-color:var(--tk-border); background:#2b2f32; outline:none; }
 .tk-cards-del.arm { display:inline-flex; color:#f1b3b3; background:rgba(203,133,133,.18); border-color:var(--tk-danger); font-weight:700; }
 .tk-cards-quickcat { position:absolute; top:36px; right:4px; z-index:70; min-width:150px; padding:5px; display:flex; flex-direction:column; gap:3px; border:1px solid var(--tk-border); border-radius:5px; background:#1b1e20; box-shadow:0 6px 16px rgba(0,0,0,.45); }
 .tk-cards-quickcat-item { min-height:28px; padding:5px 8px; border:0; border-radius:3px; background:transparent; color:var(--tk-text); cursor:pointer; font-size:11px; text-align:left; }
 .tk-cards-quickcat-item:hover { background:rgba(255,255,255,.08); color:var(--tk-accent-strong); }
 .tk-cards-quickcat-item.on { color:var(--tk-accent-strong); font-weight:650; }
/* 快速分类大弹窗 */
 .tk-cards-catpick-box { width:min(480px,92vw); max-height:72vh; }
 .tk-cards-settings-box { width:min(520px,92vw); }
 .tk-cards-settings-form { display:flex; flex-direction:column; gap:8px; }
 .tk-cards-settings-api { display:flex; flex-direction:column; gap:8px; padding:8px; border:1px solid var(--tk-border-soft); border-radius:4px; background:#141618; }
 .tk-cards-settings-status { min-height:20px; padding:6px 8px; border:1px solid var(--tk-border-soft); border-radius:4px; background:#141618; color:var(--tk-muted); font-size:11px; }
 .tk-cards-settings-status.is-success { border-color:rgba(155,178,182,.7); color:#c2d7d9; }
 .tk-cards-settings-status.is-error { border-color:rgba(203,133,133,.7); color:#e2aaaa; }
 .tk-cards-settings-note, .tk-cards-category-note { color:var(--tk-muted); font-size:10px; line-height:1.5; }
 .tk-cards-category-manager { width:min(680px,94vw); }
 .tk-cards-category-list { max-height:52vh; overflow:auto; display:flex; flex-direction:column; gap:6px; }
 .tk-cards-category-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto; align-items:center; gap:6px; padding:7px; border:1px solid var(--tk-border-soft); border-radius:4px; background:#151719; }
 .tk-cards-category-row-main { display:flex; align-items:center; gap:7px; min-width:0; }
 .tk-cards-category-row-main input, .tk-cards-category-row > input, .tk-cards-category-new input { min-height:30px; min-width:0; width:100%; box-sizing:border-box; padding:5px 7px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-text); font-size:11px; }
 .tk-cards-category-row-main span { flex:0 0 auto; color:var(--tk-muted); font-size:10px; white-space:nowrap; }
 .tk-cards-category-row-actions { display:flex; gap:4px; }
 .tk-cards-category-new { display:grid; grid-template-columns:auto minmax(0,1fr) minmax(0,1fr) auto; align-items:center; gap:6px; padding-top:8px; border-top:1px solid var(--tk-border-soft); }
 .tk-cards-category-new b { color:var(--tk-accent-strong); font-size:11px; white-space:nowrap; }
 .tk-cards-category-delete p { margin:0; color:var(--tk-text); font-size:11px; }
 .tk-cards-catpick-list { display:grid; grid-template-columns:1fr 1fr; gap:5px; overflow:auto; max-height:50vh; }
 .tk-cards-catpick-item { min-height:32px; padding:7px 10px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-text); cursor:pointer; font-size:11px; text-align:left; }
 .tk-cards-catpick-item:hover { border-color:var(--tk-accent); background:#2b2f32; }
 .tk-cards-catpick-item.on { border-color:var(--tk-accent); background:#34383b; color:var(--tk-accent-strong); font-weight:650; }
/* 拖拽排序（卡片/分类） */
 .tk-cards-grip { position:absolute; top:4px; left:4px; display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; color:var(--tk-muted); font-size:12px; cursor:grab; user-select:none; }
 .tk-cards-grip:hover { color:var(--tk-accent-strong); }
 .tk-cards-card.drag-over { border:1px dashed var(--tk-accent); background:#2b2f32; }
 .tk-cards-cat[draggable="true"] { cursor:grab; }
 .tk-cards-cat.drag-over { border-color:var(--tk-accent); background:#34383b; }
 .tk-cards-cat-del { position:relative; margin-left:4px; display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; color:var(--tk-danger); cursor:pointer; }
 .tk-cards-cat-del:hover { color:#f0b5b5; }
 .tk-cards-card.star { border-color:var(--tk-warn); background:rgba(198,167,106,.06); }
 .tk-cards-card.is-selected { border-color:var(--tk-info); background:rgba(155,178,182,.12); box-shadow:inset 0 0 0 1px rgba(155,178,182,.32); }
 .tk-cards-card-en { flex:0 0 auto; min-height:15px; color:var(--tk-text); font-size:11px; line-height:1.35; word-break:break-word; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
 .tk-cards-card-zh { flex:0 0 auto; color:var(--tk-muted); font-size:10px; }
 .tk-cards-card-meta { flex:0 0 auto; display:flex; align-items:center; gap:5px; min-height:22px; color:var(--tk-muted); font-size:10px; }
 .tk-cards-star { min-width:28px; min-height:22px; display:inline-flex; align-items:center; cursor:pointer; color:var(--tk-warn); font-size:14px; }
 .tk-cards-w { color:var(--tk-accent); }
 .tk-cards-lora { color:var(--tk-info); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100px; }
.tk-cards-multi { color:#ffb86c; border:1px solid rgba(255,184,108,.4); border-radius:3px; padding:0 3px; }
 .tk-cards-edit { display:flex; flex-direction:column; gap:7px; }
 .tk-cards-field { display:flex; flex-direction:column; gap:3px; color:var(--tk-muted); font-size:10px; }
 .tk-cards-edit input, .tk-cards-edit textarea, .tk-cards-edit select { min-height:30px; width:100%; box-sizing:border-box; border:1px solid var(--tk-border); border-radius:4px; background:#141618; color:var(--tk-text); font-size:11px; padding:5px 7px; }
 .tk-cards-edit input:focus, .tk-cards-edit textarea:focus, .tk-cards-edit select:focus { outline:none; border-color:var(--tk-accent); }
 .tk-cards-edit-btns { display:flex; gap:5px; justify-content:flex-end; }
 .tk-cards-edit-warning { display:flex; align-items:center; gap:5px; flex-wrap:wrap; padding:7px; border:1px solid rgba(198,167,106,.55); border-radius:4px; background:rgba(198,167,106,.08); color:var(--tk-warn); font-size:10px; }
 .tk-cards-empty { padding:8px 3px; color:var(--tk-muted); font-size:11px; }
 .tk-cards-overlay { position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.66); }
 .tk-cards-overlay-box { width:min(600px,92vw); max-height:82vh; padding:14px; display:flex; flex-direction:column; gap:10px; border:1px solid var(--tk-border); border-radius:6px; background:#181a1c; box-shadow:0 16px 42px rgba(0,0,0,.54); }
 .tk-cards-overlay-head { display:flex; justify-content:space-between; align-items:center; gap:10px; color:var(--tk-accent-strong); font-size:12px; }
.tk-cards-lora-list { overflow:auto; display:flex; flex-direction:column; gap:3px; max-height:55vh; }
.tk-cards-lora-row { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:4px; }
 .tk-cards-lora-row:hover { background:rgba(255,255,255,.06); }
 .tk-cards-lora-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--tk-text); }
/* AI 分类确认清单 */
.tk-cards-ai-list { overflow:auto; max-height:50vh; display:flex; flex-direction:column; gap:4px; }
 .tk-cards-ai-row { display:flex; align-items:center; gap:8px; padding:7px 8px; border:1px solid var(--tk-border-soft); border-radius:4px; background:#151719; }
 .tk-cards-ai-row:hover { border-color:var(--tk-accent); }
 .tk-cards-ai-text { flex:1; min-width:0; font-size:11px; color:var(--tk-text); word-break:break-word; display:flex; flex-direction:column; gap:2px; }
 .tk-cards-ai-zh { font-size:10px; color:var(--tk-muted); }
 .tk-cards-ai-cat { flex:0 0 150px; min-height:30px; background:#202326; color:var(--tk-text); border:1px solid var(--tk-border); border-radius:4px; font-size:11px; padding:4px 6px; }
 .tk-cards-ai-rm { flex:0 0 28px; width:28px; height:28px; border:1px solid transparent; border-radius:4px; background:transparent; color:var(--tk-danger); font-size:13px; cursor:pointer; }
 .tk-cards-ai-rm:hover { border-color:var(--tk-border); background:#2b2f32; color:#f0b5b5; }
 .tk-cards-ai-row.removed { opacity:.3; pointer-events:none; }
 .tk-cards-ai-row.removed { opacity:.38; pointer-events:auto; }
 .tk-cards-ai-row.removed > * { pointer-events:auto; }
 .tk-cards-ai-actions { display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap; }
 .tk-cards-ai-reason { color:var(--tk-info); font-size:10px; }
 .tk-cards-classify-scope { width:min(460px,92vw); }
 .tk-cards-classify-preview { width:min(760px,94vw); }
 .tk-cards-classify-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--tk-muted); font-size:10px; }
 .tk-cards-classify-toolbar label { display:flex; align-items:center; gap:4px; color:var(--tk-text); }
 @media (max-width:520px) { .tk-cards-sec-head-main { align-items:flex-start; } .tk-cards-sec-btns { justify-content:flex-start; } .tk-cards-lib-list { grid-template-columns:1fr; } .tk-cards-grid { grid-template-columns:1fr; } .tk-cards-catpick-list { grid-template-columns:1fr; } .tk-cards-category-row, .tk-cards-category-new { grid-template-columns:1fr; } .tk-cards-category-row-actions { justify-content:flex-end; } .tk-cards-ai-row { align-items:stretch; flex-wrap:wrap; } .tk-cards-ai-cat { flex:1 1 150px; } }
 @media (prefers-reduced-motion:reduce) { .tk-cards-btn, .tk-cards-card { transition:none; } }
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
