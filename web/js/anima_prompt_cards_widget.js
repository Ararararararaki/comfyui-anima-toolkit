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
//   ① 工具箱 prompt 库：分类 + 条目列表 + 搜索；点击条目 = 追加到当前提示词末尾（不自动入队）；
//      「批文件导入」页签：input/prompts 批文件浏览 → 整组导入为库条目
//   ② 当前提示词：textarea + 逗号拆分卡片流（逐卡删除/存卡/单条快捷翻译）+ 草稿自动暂存/恢复 +
//      剪切板导入 + PNG 解析 + 整段存入 prompt 库
//   ③ 卡片视图：kind=card 条目网格（分类页签/全部）；点击追加（智能去重）、双击弹窗编辑、
//      右键删除、星标置顶、批量补翻、浏览 LoRA 存触发词卡（同步 lora_syntax）、
//      导出批文件 / 导出库 JSON 备份 / 导入库恢复
//
// 后端复用：/api/translate（可选翻译源/自动回退）、/anima/danbooru/resolve（规范标签校准）、/danbooru_anima/vec_search（自然语言语义标签）、/anima/cards（卡片库全量读写）、
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
        if (!r.ok) {
          let payload = null;
          try { payload = await r.json(); } catch (e) { /* 非 JSON 错误保持 HTTP 状态 */ }
          const error = new Error(payload?.error || `HTTP ${r.status}`);
          error.status = r.status;
          error.payload = payload;
          throw error;
        }
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
        const m = p.match(/^\((.+):([+-]?(?:\d+(?:\.\d*)?|\.\d+))\)$/);
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

  function containsCJK(text) {
    return Array.from(String(text || "")).some((ch) => CJK_RE.test(ch));
  }

  function promptTranslationKey(text) {
    return String(text || "")
      .replace(/\\([()])/g, "$1")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeCardSearchText(text) {
    return String(text || "").normalize("NFKC").toLowerCase().replace(/[\s_]+/g, "").replace(/[^\p{L}\p{N}]/gu, "");
  }

  function fuzzyCardMatch(card, query, dictionaryKeys = null) {
    const needle = normalizeCardSearchText(query);
    if (!needle) return true;
    if (dictionaryKeys?.has(normalizeCardSearchText(card.prompt))) return true;
    const haystack = normalizeCardSearchText([card.prompt, card.notes, card.lora].filter(Boolean).join(" "));
    if (!haystack) return false;
    if (haystack.includes(needle)) return true;
    let cursor = 0;
    for (const char of haystack) {
      if (char === needle[cursor]) cursor++;
      if (cursor === needle.length) return true;
    }
    return false;
  }

  function suggestionMatchScore(value, query) {
    const candidate = normalizeCardSearchText(value);
    const needle = normalizeCardSearchText(query);
    if (!candidate || !needle) return Number.POSITIVE_INFINITY;
    if (candidate === needle) return 0;
    if (candidate.startsWith(needle)) return 1;
    if (candidate.includes(needle)) return 2;
    let cursor = 0;
    for (const char of candidate) {
      if (char === needle[cursor]) cursor++;
      if (cursor === needle.length) return 3;
    }
    return Number.POSITIVE_INFINITY;
  }

  function isNaturalChinese(text) {
    const value = String(text || "").trim();
    if (langOf(value) !== "zh") return false;
    // 短 tag 交给本地词典；带动作/关系或较长的句子走语义标签解析。
    return Array.from(value).length >= 6 || /[的地在被着是一个和与从让把]/.test(value);
  }

  // 翻译（双向自动检测）
  const TRANSLATE_SOURCES = [
    ["auto", "自动回退"],
    ["local", "本地词典（标签反查）"],
    ["local_llm", "本地LLM（Qwen/Gemma）"],
    ["deeplx", "DeepLX"],
    ["baidu", "百度翻译"],
    ["mymemory", "MyMemory"],
    ["google", "Google"],
    ["dashscope", "DashScope"],
  ];

  async function translateAuto(text, source = "auto") {
    const result = await translateDetailed(text, source);
    return result.translatedText || "";
  }

  async function translateDetailed(text, source = "auto") {
    const q = String(text || "").trim().slice(0, 2000);
    if (!q) return { ok: false, translatedText: "" };
    const lp = langOf(q) === "zh" ? "auto|en" : "en|zh-CN";
    const selected = TRANSLATE_SOURCES.some(([id]) => id === source) ? source : "auto";
    const sourceParam = selected === "auto" ? "" : "&source=" + encodeURIComponent(selected);
    const r = await fetchJson("/api/translate?q=" + encodeURIComponent(q) + "&langpair=" + encodeURIComponent(lp) + sourceParam);
    if (r.ok && r.translatedText) return r;
    if (r.error) throw new Error(r.error);
    return r;
  }

  async function translateChineseToEnglish(text, source = "auto") {
    const result = await translateDetailed(text, source);
    const translated = result.translatedText || "";
    if (!translated || containsCJK(translated)) throw new Error("翻译服务未返回英文");
    return { ...result, translatedText: translated };
  }

  async function semanticSearchTags(text) {
    try {
      const result = await postJson("/danbooru_anima/vec_search", { query: String(text || "").trim(), top_k: 12 }, 45000);
      if (result.need_init) return { needInit: true, progress: result.progress || "" };
      return { tags: Array.isArray(result.tags) ? result.tags : [] };
    } catch (error) {
      return { tags: [], error: error.message || String(error) };
    }
  }

  const SEMANTIC_CATEGORY_NAMES = { 0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta" };
  function semanticCandidatesOf(result) {
    if (!result || !Array.isArray(result.tags)) return [];
    return result.tags.map((item) => {
      const tag = String(item.name || item.tag || "").trim().toLowerCase();
      const postCount = Number(item.post_count ?? item.postCount ?? 0) || 0;
      if (!tag || postCount <= 0) return null;
      const score = Number(item.score);
      return {
        tag,
        prompt: danbooruTagToPrompt(tag),
        category: SEMANTIC_CATEGORY_NAMES[item.category] || String(item.category_name || ""),
        postCount,
        verified: true,
        matchType: "semantic",
        confidence: Number.isFinite(score) ? Math.max(0.5, Math.min(0.99, score)) : 0.75,
      };
    }).filter(Boolean);
  }

  function glossaryCandidateOf(tag) {
    const value = String(tag || "").trim();
    if (!value) return [];
    return [{
      tag: value.toLowerCase(),
      prompt: danbooruTagToPrompt(value),
      category: "",
      postCount: 0,
      verified: false,
      matchType: "user_glossary",
      confidence: 1,
    }];
  }

  function mergeResolvedCandidates(base, semantic) {
    const out = [];
    const seen = new Set();
    for (const candidate of [...(Array.isArray(base) ? base : []), ...semanticCandidatesOf(semantic)]) {
      const tag = String(candidate.tag || "").toLowerCase();
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(candidate);
    }
    return out;
  }

  const PROVIDER_LABELS = Object.fromEntries(TRANSLATE_SOURCES.map(([id, label]) => [id, label]));
  const CALIBRATION_LABELS = { dictionary: "本地词典", translated_exact: "英文精确校准", semantic: "BGE-M3 语义检索", user_glossary: "用户词典" };
  const PROVIDER_ERROR_LABELS = {
    cooldown: "冷却中",
    upstream_rate_limit: "上游限流",
    quota_exhausted: "额度耗尽",
    account_arrears: "账户欠费",
    authentication_error: "鉴权失败",
    model_permission_error: "模型无权限",
    service_unavailable: "服务未启动",
    network_error: "网络错误",
    not_configured: "未配置",
    not_found: "未命中",
  };

  function providerLabel(provider) {
    return PROVIDER_LABELS[provider] || (provider === "user_glossary" ? "用户词典" : provider || "未使用");
  }

  function candidateSourceLabel(candidate) {
    if (candidate?.matchType === "user_glossary") return "用户词典";
    if (candidate?.verified) return `D站 ${Number(candidate.postCount || 0).toLocaleString()} 帖`;
    return "本地词典";
  }

  function qualityLabel(quality) {
    if (!quality) return "未检查";
    if (quality.status === "ok") return "正常";
    if (quality.status === "warning") return `警告${quality.warnings?.length ? `：${quality.warnings.join(", ")}` : ""}`;
    return `异常${quality.issues?.length ? `：${quality.issues.join(", ")}` : ""}`;
  }

  function providerStateLabel(state, provider) {
    if (!state) return "未知";
    if (state.cooldown_seconds > 0) {
      const reason = PROVIDER_ERROR_LABELS[state.error_code] || "冷却中";
      const seconds = Number(state.cooldown_seconds) || 0;
      const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟后重试` : `${seconds}s 后重试`;
      return `${reason}，${wait}`;
    }
    if (provider === "local_llm" && !state.configured) return "未加载（点启用）";
    if (state.health === "healthy") return "正常";
    if (!state.configured) return "未配置";
    if (state.health === "unknown") return "待使用";
    return PROVIDER_ERROR_LABELS[state.error_code] || "待使用";
  }

  function formatWeightedPromptText(text, weight) {
    const value = String(text || "").trim();
    if (!value) return "";
    const rawWeight = String(weight ?? "").trim();
    if (!rawWeight) return value;
    const numericWeight = Number(rawWeight);
    // 1.0 是默认权重，不写成冗余的 (tag:1.0)。
    if (Number.isFinite(numericWeight) && Math.abs(numericWeight - 1) < 1e-9) return value;
    return `(${value}:${rawWeight})`;
  }

  function serializePromptPieces(parts) {
    return (parts || []).map((p) => formatWeightedPromptText(p.text, p.weight)).filter(Boolean).join(", ");
  }

  // 隐藏片段不能只存在 CardsUI 内存：ComfyUI 刷新/重建节点时会重新读取
  // positive，而 positive 只保存可见文本。把完整片段（含 hidden/weight）
  // 放进节点的可序列化 hidden widget，才能让工作流恢复后继续显示这些卡片。
  const PROMPT_PIECES_STATE_VERSION = 1;

  function normalizePromptPiece(piece) {
    if (!piece || typeof piece !== "object") return null;
    const text = String(piece.text || "").trim();
    if (!text) return null;
    return {
      text,
      weight: String(piece.weight ?? "").trim(),
      hidden: Boolean(piece.hidden),
    };
  }

  function parsePromptPiecesState(raw) {
    if (!raw) return null;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const source = Array.isArray(parsed) ? parsed : parsed?.pieces;
      if (!Array.isArray(source)) return null;
      const pieces = source.map(normalizePromptPiece).filter(Boolean);
      if (!pieces.length && source.length) return null;
      const visibleText = typeof parsed?.visibleText === "string"
        ? parsed.visibleText
        : serializePromptPieces(pieces.filter((piece) => !piece.hidden));
      return {
        version: Number(parsed?.version) || PROMPT_PIECES_STATE_VERSION,
        pieces,
        visibleText: String(visibleText || "").trim(),
      };
    } catch (error) {
      return null;
    }
  }

  function normalizePromptCardWeight(value) {
    const parsed = Number.parseFloat(String(value ?? "").trim());
    const safe = Number.isFinite(parsed) ? parsed : 1;
    const clamped = Math.max(-2, Math.min(2, safe));
    return Math.round(clamped * 10) / 10;
  }

  function promptCardWeightText(value) {
    return normalizePromptCardWeight(value).toFixed(1);
  }

  function cardToText(c) {
    const en = String(c.prompt || c.en || "").trim();
    if (!en) return "";
    return formatWeightedPromptText(en, c.weight);
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

  // 追加工具箱的整段提示词：保留已有内容，并用空两行分隔，便于在②区阅读和继续编辑。
  // 仅阻止完全相同或已作为末尾段落存在的重复追加；中间已有相同文本不阻塞用户再次加入。
  function appendPromptBlock(cur, block) {
    const current = String(cur || "").replace(/\s+$/, "");
    const addition = String(block || "").trim();
    if (!addition) return current;
    if (!current) return addition;
    if (current === addition || current.endsWith(`\n\n${addition}`)) return current;
    return `${current}\n\n${addition}`;
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
    return serializePromptPieces(keep);
  }

  // Danbooru 内部标签用下划线；Anima 提示词使用空格和英文逗号。
  function danbooruTagToPrompt(tag) {
    return String(tag || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  }

  // 草稿
  const DRAFT_KEY = "anima_tk_cards_draft_v1";
  const TRANSLATE_SOURCE_KEY = "anima_tk_cards_translate_source_v1";
  const UI_STATE_KEY = "anima_tk_cards_ui_v1";
  const LIB_HEIGHT_MIN = 150;
  const LIB_HEIGHT_MAX = 680;
  const LIB_HEIGHT_DEFAULT = 240;
  const CUR_TEXT_HEIGHT_MIN = 82;
  const CUR_TEXT_HEIGHT_MAX = 560;
  const CUR_TEXT_HEIGHT_DEFAULT = 120;
  const CHIPS_HEIGHT_MIN = 90;
  const CHIPS_HEIGHT_MAX = 680;
  const CHIPS_HEIGHT_DEFAULT = 180;
  const CARD_GRID_HEIGHT_MIN = 150;
  const CARD_GRID_HEIGHT_MAX = 680;
  const CARD_GRID_HEIGHT_DEFAULT = 300;
  function saveDraft(text) { try { localStorage.setItem(DRAFT_KEY, String(text || "")); } catch (e) {} }
  function loadDraft() { try { return localStorage.getItem(DRAFT_KEY) || ""; } catch (e) { return ""; } }
  function loadTranslateSource() {
    try {
      const value = localStorage.getItem(TRANSLATE_SOURCE_KEY) || "auto";
      return TRANSLATE_SOURCES.some(([id]) => id === value) ? value : "auto";
    } catch (e) { return "auto"; }
  }
  function saveTranslateSource(value) { try { localStorage.setItem(TRANSLATE_SOURCE_KEY, String(value || "auto")); } catch (e) {} }
  function loadUiState() {
    try {
      const raw = JSON.parse(localStorage.getItem(UI_STATE_KEY) || "{}");
      const height = Number(raw.libHeight);
      const curTextHeight = Number(raw.curTextHeight);
      const chipsHeight = Number(raw.chipsHeight);
      const cardGridHeight = Number(raw.cardGridHeight);
      return {
        collapsed: { ...(raw.collapsed || {}) },
        pane: raw.pane === "batch" ? "batch" : "lib",
        libHeight: Number.isFinite(height) ? Math.max(LIB_HEIGHT_MIN, Math.min(LIB_HEIGHT_MAX, Math.round(height))) : LIB_HEIGHT_DEFAULT,
        curTextHeight: Number.isFinite(curTextHeight) ? Math.max(CUR_TEXT_HEIGHT_MIN, Math.min(CUR_TEXT_HEIGHT_MAX, Math.round(curTextHeight))) : CUR_TEXT_HEIGHT_DEFAULT,
        chipsHeight: Number.isFinite(chipsHeight) ? Math.max(CHIPS_HEIGHT_MIN, Math.min(CHIPS_HEIGHT_MAX, Math.round(chipsHeight))) : CHIPS_HEIGHT_DEFAULT,
        cardGridHeight: Number.isFinite(cardGridHeight) ? Math.max(CARD_GRID_HEIGHT_MIN, Math.min(CARD_GRID_HEIGHT_MAX, Math.round(cardGridHeight))) : CARD_GRID_HEIGHT_DEFAULT,
      };
    } catch (e) {
      return { collapsed: {}, pane: "lib", libHeight: LIB_HEIGHT_DEFAULT, curTextHeight: CUR_TEXT_HEIGHT_DEFAULT, chipsHeight: CHIPS_HEIGHT_DEFAULT, cardGridHeight: CARD_GRID_HEIGHT_DEFAULT };
    }
  }
  function saveUiState(state) {
    try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  // ── UI ──

  class CardsUI {
    constructor(node, w) {
      this.node = node;
      this.w = w; // {positive, opt_text, lora_syntax, prompt_pieces}
      this.prompts = [];   // ① prompt 库缓存（anima-lora，浏览/切换/导入/删除）
      this.cats = [];      // ① prompt 库分类
      this.curLibCat = ""; // ① 当前分类过滤（"" = 全部）
      this.cards = [];     // ③ 卡片库缓存（anima-tk-cards，tag 级短语）
      this.cardCats = [];  // ③ 卡片分类
      this.curCat = "";    // ③ 当前卡片分类 id（"" = 全部）
      this.cardSearch = "";
      this.search = "";
      this.promptPieces = null; // ② 当前提示词完整片段；hidden 片段保留在卡片区但不输出
      this.selectedCardIds = new Set(); // Ctrl/Cmd 点击选择，供批量分类使用
      this.rootEl = null;
      this.libListEl = null;    // ①区条目列表
      this.libSearchEl = null;
      this.libCatSel = null;    // ①区分类过滤下拉
      this.cleanBtn = null;     // ①区「清理【卡】」
      this.fileSel = null;
      this.groupListEl = null;
      this.curTextEl = null;
      this.translateInputEl = null; // ②区独立中文翻译输入
      this.translateSuggestEl = null; // ②区中文输入联想下拉
      this.translateSourceEl = null; // ②区翻译源选择
      this.chipsEl = null;
      this.catTabsEl = null;
      this.cardGridEl = null;
      this.cardSearchEl = null;
      this.cardGridResizeEl = null;
      this.statusEl = null;
      this.batchGroups = new Map(); // 批文件路径 -> groups
      this.piecesZh = new Map(); // 片段文本 -> 中文译文（②区 chips 翻译显示，不入库）
      this.cardZhByPrompt = new Map(); // 已持久化卡片的英文 → 中文索引（导入正面后直接显示）
      this.piecesTranslation = new Map(); // 片段文本 -> 快捷翻译结果（只读显示，不入库）
      this.suggestEl = null;    // ②区联想下拉
      this.resolveEl = null;   // ②区中文翻译 + Danbooru 校准结果
      this.resolveItems = [];
      this.translateStatusEl = null; // provider 实时状态
      this.lastTranslationMode = "calibrate";
      this.actualTranslationProvider = "";
      this._suggestIdx = -1;
      this._suggestList = [];
      this._suggestRequestId = 0;
      this._suggestAbortController = null;
      this._dictionarySuggestCache = new Map();
      this._translateSuggestRequestId = 0;
      this._translateSuggestAbortController = null;
      this._translateSuggestList = [];
      this._translateSuggestIdx = -1;
      this._cardSearchRequestId = 0;
      this._cardSearchAbortController = null;
      this._cardSearchDictionaryKeys = new Set();
      this.uiState = loadUiState();
      this.sectionBodies = {};
      this.libResizeEl = null;
      this.curTextResizeEl = null;
      this.chipsResizeEl = null;
      this._localLlmActionBusy = false;
      this._localLlmSessionPromise = null;
      this._promptPiecesRestored = false;
      this._promptPiecesRestorePending = false;
      this._localLlmSessionRefs = 0;
      this._localLlmSessionAutoRelease = false;
      this.editOverlay = null;
      this._onExternalCardsUpdated = () => {
        this.reloadAll().catch(() => {});
      };
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
        this._scheduleNodeResize();
      };
      toggle.addEventListener("pointerdown", (ev) => ev.stopPropagation());
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

    _scheduleNodeResize() {
      requestAnimationFrame(() => {
        if (!this.rootEl?.isConnected || typeof this.node?.setSize !== "function") return;
        const width = Math.max(260, Number(this.node.size?.[0]) || 420);
        const heightNow = Math.ceil(this.rootEl.scrollHeight + 8);
        if (heightNow > 0 && Math.abs((Number(this.node.size?.[1]) || 0) - heightNow) > 4) this.node.setSize([width, heightNow]);
      });
    }

    _setW(widget, value) {
      if (!widget) return;
      widget.value = value;
      if (typeof widget.callback === "function") { try { widget.callback(value) } catch {} }
      if (widget === this.w?.positive) this._stashDraft();
    }

    _ensurePromptPiecesWidget() {
      const existing = this.node.widgets?.find((widget) => widget.name === "prompt_pieces");
      if (existing) return existing;
      if (typeof this.node.addWidget !== "function") return null;
      try {
        return this.node.addWidget("text", "prompt_pieces", "", () => {}, { serialize: true });
      } catch (error) {
        console.warn("[TK Prompt Cards] 无法创建隐藏状态 widget:", error);
        return null;
      }
    }

    _hideNativeWidget(widget) {
      if (!widget) return;
      widget.hidden = true;
      widget.options = widget.options || {};
      widget.options.hidden = true;
      widget.computeSize = () => [0, -4];
      widget.draw = () => {};
      if (widget.element) widget.element.style.display = "none";
      widget.type = "hidden";
    }

    _persistPromptPieces() {
      const widget = this.w?.prompt_pieces;
      const pieces = Array.isArray(this.promptPieces)
        ? this.promptPieces.map(normalizePromptPiece).filter(Boolean)
        : [];
      if (!widget) return;
      const payload = {
        version: PROMPT_PIECES_STATE_VERSION,
        visibleText: String(this.curText() || "").trim(),
        pieces,
      };
      widget.value = JSON.stringify(payload);
      // 动态 hidden widget 的 callback 不一定由 ComfyUI 自动触发，显式标脏
      // 才能让「保存工作流」知道节点状态已经变化。
      this.node.graph?.change?.();
    }

    _restorePromptPiecesFromWidget() {
      if (this._promptPiecesRestored) return Array.isArray(this.promptPieces);
      const state = parsePromptPiecesState(this.w?.prompt_pieces?.value);
      if (!state) {
        this._promptPiecesRestored = true;
        return false;
      }
      const currentVisible = String(this.curText() || "").trim();
      // positive 是执行端的权威值。若用户在工作流外改过 positive，旧的
      // hidden 状态不能把已删除的片段偷偷带回来，直接从新文本重新建片段。
      if (state.visibleText !== currentVisible) {
        this.promptPieces = this._piecesFromText(this.curText());
        this._promptPiecesRestored = true;
        this._persistPromptPieces();
        return false;
      }
      this.promptPieces = state.pieces;
      this._promptPiecesRestored = true;
      return true;
    }

    restorePromptPieces() {
      this._promptPiecesRestorePending = false;
      if (!this.w?.positive || !this.w?.prompt_pieces) {
        this._promptPiecesRestorePending = true;
        return;
      }
      this._promptPiecesRestored = false;
      const restored = this._restorePromptPiecesFromWidget();
      if (!restored || !this.curTextEl) return;
      this.curTextEl.value = this.curText();
      this._renderChips();
    }

    _applyLibHeight(height, persist = true) {
      const value = Math.max(LIB_HEIGHT_MIN, Math.min(LIB_HEIGHT_MAX, Math.round(Number(height) || LIB_HEIGHT_DEFAULT)));
      this.uiState.libHeight = value;
      if (this.libListEl) {
        this.libListEl.style.height = `${value}px`;
        this.libListEl.style.maxHeight = `${value}px`;
      }
      if (this.libResizeEl) this.libResizeEl.setAttribute("aria-valuenow", String(value));
      if (persist) saveUiState(this.uiState);
      this._scheduleNodeResize();
    }

    _applyCurrentTextHeight(height, persist = true) {
      const value = Math.max(CUR_TEXT_HEIGHT_MIN, Math.min(CUR_TEXT_HEIGHT_MAX, Math.round(Number(height) || CUR_TEXT_HEIGHT_DEFAULT)));
      this.uiState.curTextHeight = value;
      if (this.curTextEl) {
        this.curTextEl.style.height = `${value}px`;
        this.curTextEl.style.minHeight = `${value}px`;
      }
      if (this.curTextResizeEl) this.curTextResizeEl.setAttribute("aria-valuenow", String(value));
      if (persist) saveUiState(this.uiState);
      this._scheduleNodeResize();
    }

    _bindResizeHandle(handle, getHeight, applyHeight) {
      let active = false;
      let startY = 0;
      let startHeight = 0;
      const end = (event) => {
        if (!active) return;
        active = false;
        try { handle.releasePointerCapture(event.pointerId); } catch {}
        handle.classList.remove("is-dragging");
        applyHeight(getHeight(), true);
      };
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        active = true;
        startY = event.clientY;
        startHeight = Number(getHeight()) || 0;
        handle.classList.add("is-dragging");
        try { handle.setPointerCapture(event.pointerId); } catch {}
      });
      handle.addEventListener("pointermove", (event) => {
        if (!active) return;
        event.preventDefault();
        event.stopPropagation();
        applyHeight(startHeight + event.clientY - startY, false);
      });
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === "ArrowUp" ? -20 : 20;
        applyHeight((Number(getHeight()) || 0) + delta, true);
      });
      handle.addEventListener("lostpointercapture", () => {
        if (active) {
          active = false;
          handle.classList.remove("is-dragging");
          applyHeight(getHeight(), true);
        }
      });
    }

    _bindLibResize(handle) {
      this._bindResizeHandle(handle, () => this.uiState.libHeight || LIB_HEIGHT_DEFAULT, (height, persist) => this._applyLibHeight(height, persist));
    }

    _bindCurrentTextResize(handle) {
      this._bindResizeHandle(handle, () => this.uiState.curTextHeight || CUR_TEXT_HEIGHT_DEFAULT, (height, persist) => this._applyCurrentTextHeight(height, persist));
    }

    _applyChipsHeight(height, persist = true) {
      const value = Math.max(CHIPS_HEIGHT_MIN, Math.min(CHIPS_HEIGHT_MAX, Math.round(Number(height) || CHIPS_HEIGHT_DEFAULT)));
      this.uiState.chipsHeight = value;
      if (this.chipsEl) {
        this.chipsEl.style.height = `${value}px`;
        this.chipsEl.style.maxHeight = `${value}px`;
      }
      if (this.chipsResizeEl) this.chipsResizeEl.setAttribute("aria-valuenow", String(value));
      if (persist) saveUiState(this.uiState);
      this._scheduleNodeResize();
    }

    _bindChipsResize(handle) {
      this._bindResizeHandle(handle, () => this.uiState.chipsHeight || CHIPS_HEIGHT_DEFAULT, (height, persist) => this._applyChipsHeight(height, persist));
    }

    _applyCardGridHeight(height, persist = true) {
      const value = Math.max(CARD_GRID_HEIGHT_MIN, Math.min(CARD_GRID_HEIGHT_MAX, Math.round(Number(height) || CARD_GRID_HEIGHT_DEFAULT)));
      this.uiState.cardGridHeight = value;
      if (this.cardGridEl) {
        this.cardGridEl.style.height = `${value}px`;
        this.cardGridEl.style.maxHeight = `${value}px`;
      }
      if (this.cardGridResizeEl) this.cardGridResizeEl.setAttribute("aria-valuenow", String(value));
      if (persist) saveUiState(this.uiState);
      this._scheduleNodeResize();
    }

    _bindCardGridResize(handle) {
      this._bindResizeHandle(handle, () => this.uiState.cardGridHeight || CARD_GRID_HEIGHT_DEFAULT, (height, persist) => this._applyCardGridHeight(height, persist));
    }

    _closeEditModal() {
      this.editOverlay?.remove();
      this.editOverlay = null;
    }

    _openEditModal(entry, mode = "lib") {
      this._closeEditModal();
      const isLib = mode === "lib";
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay tk-cards-edit-overlay";
      const categoryOptions = this.cats.map((cat) => `<option value="${escAttr(cat.id)}" ${cat.id === entry.categoryId ? "selected" : ""}>${esc(CAT_NAME(cat))}</option>`).join("");
      const currentImage = isLib ? String(entry.primaryImage || (Array.isArray(entry.images) && entry.images[0]) || "").trim() : "";
      overlay.innerHTML = isLib
        ? `<div class="tk-cards-overlay-box tk-cards-edit-modal" role="dialog" aria-modal="true" aria-label="编辑 Prompt 库条目">
          <div class="tk-cards-overlay-head"><b>编辑 Prompt 库条目</b><button type="button" class="tk-cards-btn" data-a="close" aria-label="关闭">✕</button></div>
          <div class="tk-cards-edit-form">
            <label class="tk-cards-field"><span>标题</span><input value="${escAttr(entry.displayText || "")}" data-f="title" placeholder="可选"></label>
            <div class="tk-cards-edit-image-field">
              <span class="tk-cards-edit-image-label">预览图</span>
              <div class="tk-cards-edit-image-drop" data-a="image-drop" tabindex="0" role="button" aria-label="点击选择或拖拽替换预览图">
                <img data-a="image-preview" alt="当前预览图" hidden>
                <span class="tk-cards-edit-image-placeholder" data-a="image-placeholder">暂无预览图<small>点击选择或拖拽图片到此处替换</small></span>
              </div>
              <div class="tk-cards-edit-image-meta"><span data-a="image-name">未设置预览图</span><button type="button" class="tk-cards-btn" data-a="image-clear" disabled>移除预览图</button></div>
              <input type="file" accept="image/*" data-a="image-input" hidden>
            </div>
            <label class="tk-cards-field tk-cards-field-wide"><span>提示词</span><textarea data-f="prompt" rows="12" placeholder="提示词内容">${esc(entry.prompt || "")}</textarea></label>
            <label class="tk-cards-field tk-cards-field-wide"><span>注释</span><textarea data-f="notes" rows="4" placeholder="可选">${esc(entry.notes || "")}</textarea></label>
            <label class="tk-cards-field"><span>分类</span><select data-f="cat">${categoryOptions}</select></label>
          </div>
          <div class="tk-cards-edit-btns"><button type="button" class="tk-cards-btn" data-a="cancel">取消</button><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="save">保存</button></div>
        </div>`
        : `<div class="tk-cards-overlay-box tk-cards-edit-modal" role="dialog" aria-modal="true" aria-label="编辑卡片">
          <div class="tk-cards-overlay-head"><b>编辑卡片</b><button type="button" class="tk-cards-btn" data-a="close" aria-label="关闭">✕</button></div>
          <div class="tk-cards-edit-form">
            <label class="tk-cards-field tk-cards-field-wide"><span>英文 tag / 提示词</span><textarea data-f="prompt" rows="6" placeholder="英文 tag">${esc(entry.prompt || "")}</textarea></label>
            <label class="tk-cards-field tk-cards-field-wide"><span>中文注释</span><textarea data-f="notes" rows="3" placeholder="可选">${esc(entry.notes || "")}</textarea></label>
            <div class="tk-cards-edit-two-col">
              <label class="tk-cards-field"><span>权重</span><input value="${escAttr(entry.weight || "")}" data-f="weight" placeholder="例如 1.2"></label>
              <label class="tk-cards-field"><span>LoRA 文件</span><input value="${escAttr(entry.lora || "")}" data-f="lora" placeholder="可选"></label>
            </div>
          </div>
          <div class="tk-cards-edit-btns"><button type="button" class="tk-cards-btn" data-a="cancel">取消</button><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="save">保存</button></div>
        </div>`;
      document.body.appendChild(overlay);
      this.editOverlay = overlay;
      const read = (field) => overlay.querySelector(`[data-f="${field}"]`)?.value.trim() || "";
      const close = () => this._closeEditModal();
      let editedImage = currentImage;
      let imageChanged = false;
      const imageDrop = isLib ? overlay.querySelector('[data-a="image-drop"]') : null;
      const imagePreview = isLib ? overlay.querySelector('[data-a="image-preview"]') : null;
      const imageInput = isLib ? overlay.querySelector('[data-a="image-input"]') : null;
      const imageName = isLib ? overlay.querySelector('[data-a="image-name"]') : null;
      const imageClear = isLib ? overlay.querySelector('[data-a="image-clear"]') : null;
      const setImage = (dataUrl, name, changed = true) => {
        if (!isLib || !imagePreview || !imageDrop) return;
        editedImage = String(dataUrl || "");
        imageChanged = imageChanged || changed;
        imagePreview.hidden = !editedImage;
        imagePreview.src = editedImage;
        imageDrop.classList.toggle("has-image", Boolean(editedImage));
        if (imageName) imageName.textContent = editedImage ? (name || "当前预览图") : "未设置预览图";
        if (imageClear) imageClear.disabled = !editedImage;
      };
      setImage(currentImage, currentImage ? "当前预览图" : "未设置预览图", false);
      const readImageFile = (file) => {
        if (!file) return;
        if (!String(file.type || "").startsWith("image/")) {
          this._flash("预览图必须是图片文件");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") setImage(reader.result, file.name, true);
          else this._flash("预览图读取结果无效");
        };
        reader.onerror = () => this._flash("读取预览图失败");
        reader.readAsDataURL(file);
      };
      imageInput?.addEventListener("change", () => {
        readImageFile(imageInput.files?.[0]);
        imageInput.value = "";
      });
      imageDrop?.addEventListener("click", () => imageInput?.click());
      imageDrop?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); imageInput?.click(); }
      });
      imageDrop?.addEventListener("dragenter", (event) => { event.preventDefault(); event.stopPropagation(); imageDrop.classList.add("is-dragging"); });
      imageDrop?.addEventListener("dragover", (event) => { event.preventDefault(); event.stopPropagation(); imageDrop.classList.add("is-dragging"); });
      imageDrop?.addEventListener("dragleave", (event) => { event.preventDefault(); event.stopPropagation(); imageDrop.classList.remove("is-dragging"); });
      imageDrop?.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        imageDrop.classList.remove("is-dragging");
        readImageFile(event.dataTransfer?.files?.[0]);
      });
      imageClear?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setImage("", "未设置预览图", true);
      });
      const saveButton = overlay.querySelector('[data-a="save"]');
      const save = async () => {
        if (saveButton.disabled) return;
        const values = isLib
          ? { displayText: read("title"), prompt: read("prompt"), notes: read("notes"), categoryId: read("cat") }
          : { prompt: read("prompt"), notes: read("notes"), weight: read("weight"), lora: read("lora") };
        if (!values.prompt) {
          this._flash("提示词不能为空");
          overlay.querySelector('[data-f="prompt"]')?.focus();
          return;
        }
        saveButton.disabled = true;
        try {
          if (isLib) {
            const imagePatch = imageChanged ? { images: editedImage ? [editedImage] : [], primaryImage: editedImage } : {};
            const next = { ...entry, ...values, ...imagePatch, displayText: values.displayText || entry.displayText, prompt: values.prompt, updatedAt: Date.now() };
            const db = await openDB();
            await storePut(db, PROMPT_STORE, next);
            Object.assign(entry, next);
            this._renderLibList();
            this._flash("已保存到 prompt 库");
          } else {
            const next = { ...entry, ...values, prompt: values.prompt, updatedAt: Date.now() };
            await this.putCard(next);
            Object.assign(entry, next);
            this._renderCards();
            this._flash("卡片已保存");
          }
          close();
        } catch (error) {
          saveButton.disabled = false;
          this._flash("保存失败：" + (error.message || error), 5000);
        }
      };
      overlay.querySelectorAll('[data-a="close"], [data-a="cancel"]').forEach((button) => button.addEventListener("click", close));
      saveButton.addEventListener("click", save);
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); save(); }
      });
      setTimeout(() => overlay.querySelector('[data-f="prompt"]')?.focus(), 50);
    }

    curText() { return this.w.positive?.value || ""; }

    _piecesFromText(text) {
      return splitTags(text).map((piece) => ({ ...piece, hidden: false }));
    }

    _syncPromptPiecesFromVisibleText(text) {
      const nextVisible = this._piecesFromText(text);
      if (!Array.isArray(this.promptPieces)) {
        this.promptPieces = nextVisible;
        return this.promptPieces;
      }
      // 手动编辑上方 textarea 时保留仍未出现在新文本中的隐藏片段；
      // 如果用户手动重新输入了隐藏 tag，则视为重新激活，移除旧隐藏副本。
      const usedVisible = new Set();
      const hidden = this.promptPieces.filter((piece) => piece.hidden);
      const remainingHidden = hidden.filter((piece) => {
        const key = promptTranslationKey(piece.text);
        const index = nextVisible.findIndex((candidate, i) =>
          !usedVisible.has(i) && promptTranslationKey(candidate.text) === key);
        if (index >= 0) {
          usedVisible.add(index);
          return false;
        }
        return true;
      });
      this.promptPieces = nextVisible.concat(remainingHidden);
      return this.promptPieces;
    }

    _promptPieces() {
      if (!Array.isArray(this.promptPieces)) {
        this.promptPieces = this._piecesFromText(this.curText());
      }
      return this.promptPieces;
    }

    _ensurePromptPiecesInSync() {
      const pieces = this._promptPieces();
      const visible = serializePromptPieces(pieces.filter((piece) => !piece.hidden));
      if (visible !== this.curText()) this._syncPromptPiecesFromVisibleText(this.curText());
      return this.promptPieces;
    }

    _commitPromptPieces(render = true) {
      const pieces = this._promptPieces();
      const next = serializePromptPieces(pieces.filter((piece) => !piece.hidden));
      this._setW(this.w.positive, next);
      this._persistPromptPieces();
      if (this.curTextEl) this.curTextEl.value = next;
      if (render) this._renderChips();
      return next;
    }

    _setPromptText(text, { preserveHidden = false, render = true } = {}) {
      if (preserveHidden) this._syncPromptPiecesFromVisibleText(text);
      else this.promptPieces = this._piecesFromText(text);
      return this._commitPromptPieces(render);
    }

    _appendPromptBlock(text) {
      const current = this.curText();
      const next = appendPromptBlock(current, text);
      if (next === current) return next;
      this._syncPromptPiecesFromVisibleText(next);
      this._setW(this.w.positive, next);
      this._persistPromptPieces();
      if (this.curTextEl) this.curTextEl.value = next;
      this._renderChips();
      this._updateSuggest();
      this._hideResolve();
      return next;
    }

    _togglePieceVisibility(index) {
      const piece = this._promptPieces()[index];
      if (!piece) return;
      piece.hidden = !piece.hidden;
      this._commitPromptPieces();
      this._flash(piece.hidden ? `已隐藏：${piece.text}` : `已恢复：${piece.text}`);
    }

    _removePromptPiece(index) {
      const pieces = this._promptPieces();
      const piece = pieces[index];
      if (!piece) return;
      pieces.splice(index, 1);
      this.piecesZh.delete(piece.text);
      this.piecesTranslation.delete(piece.text);
      this._commitPromptPieces();
    }

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
        this._rebuildCardTranslationIndex();
        let ccats = (lib.categories || []).slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        if (!ccats.length) ccats = CARD_DEFAULT_CATS.map((c) => ({ ...c }));
        this.cardCats = ccats;
      } catch (e) {
        console.error("[TK Prompt Cards] 卡片库加载失败:", e);
        this._flash("卡片库加载失败：" + (e.message || e));
      }
      this._renderCatTabs();
      this._renderCards();
      this._renderChips();
      this._updateTranslateSuggest();
    }

    _rebuildCardTranslationIndex() {
      this.cardZhByPrompt.clear();
      for (const card of this.cards) {
        const key = promptTranslationKey(card.prompt);
        const zh = String(card.notes || "").trim();
        if (key && zh) this.cardZhByPrompt.set(key, zh);
      }
    }

    _rememberPromptTranslations(translations) {
      if (!translations || typeof translations !== "object") return;
      for (const [en, zh] of Object.entries(translations)) {
        const value = String(zh || "").trim();
        if (!value) continue;
        this.piecesZh.set(en, value);
        this.piecesZh.set(String(en).replace(/_/g, " "), value);
      }
    }

    _translationForPiece(text) {
      return this.piecesZh.get(text) || this.cardZhByPrompt.get(promptTranslationKey(text)) || "";
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
          Object.values(p.tagTranslations || {}).some((value) => String(value || "").toLowerCase().includes(q)) ||
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
        el.title = "单击追加到当前提示词末尾（两次换行，不自动入队）；双击打开编辑窗口；hover 删除该词条";
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
        const tagTranslations = p.tagTranslations && typeof p.tagTranslations === "object" ? p.tagTranslations : null;
        if (tagTranslations && Object.keys(tagTranslations).length) {
          const bilingual = document.createElement("div");
          bilingual.className = "tk-cards-lib-bilingual";
          const translationMap = new Map(Object.entries(tagTranslations).map(([key, value]) => [promptTranslationKey(key), String(value || "").trim()]));
          for (const part of splitTags(p.prompt)) {
            const item = document.createElement("span");
            item.className = "tk-cards-lib-bilingual-card";
            const en = document.createElement("b");
            en.textContent = formatWeightedPromptText(part.text, part.weight);
            const zh = document.createElement("small");
            zh.textContent = translationMap.get(promptTranslationKey(part.text)) || "待翻译";
            item.append(en, zh);
            bilingual.appendChild(item);
          }
          el.appendChild(bilingual);
        }
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
        let clickTimer = null;
        el.addEventListener("click", (ev) => {
          if (ev.target.closest(".tk-cards-del")) return;
          clearTimeout(clickTimer);
          clickTimer = setTimeout(() => {
            this._rememberPromptTranslations(p.tagTranslations);
            const current = this.curText();
            const next = this._appendPromptBlock(p.prompt || "");
            this._flash(next === current ? "该提示词已在末尾（已去重）" : `已追加：${(p.displayText || p.prompt || "").slice(0, 30)}`);
          }, 240);
        });
        // 双击打开编辑窗口：不触发第一次 click 的“载入提示词”动作。
        el.addEventListener("dblclick", (ev) => {
          if (ev.target.closest(".tk-cards-del")) return;
          clearTimeout(clickTimer);
          ev.preventDefault();
          this._openEditModal(p, "lib");
        });
        this.libListEl.appendChild(el);
      }
    }

    // ①条目编辑（弹窗编辑 displayText 标题 / prompt / notes / 分类）
    beginLibEdit(p, el) {
      this._openEditModal(p, "lib");
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
      this._rebuildCardTranslationIndex();
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
      this._renderCatTabs();
      this._renderCards();
      this._flash("卡片已删除", 3000);
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
      this._syncPromptPiecesFromVisibleText(v);
      this._setW(this.w.positive, v);
      this._persistPromptPieces();
      this._renderChips();
      this._updateSuggest();
      this._hideResolve();
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

    _cancelSuggestRequest() {
      this._suggestRequestId += 1;
      this._suggestAbortController?.abort();
      this._suggestAbortController = null;
    }

    async _fetchDictionarySuggestions(query, limit = 16, controller = null) {
      const key = `${normalizeCardSearchText(query)}:${limit}`;
      const cached = this._dictionarySuggestCache.get(key);
      if (cached) return cached;
      const url = `/anima/cards/autocomplete?q=${encodeURIComponent(query)}&limit=${limit}`;
      const response = await apiFetch(url, controller ? { signal: controller.signal } : undefined);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const results = Array.isArray(payload?.results) ? payload.results : [];
      this._dictionarySuggestCache.set(key, results);
      while (this._dictionarySuggestCache.size > 128) {
        this._dictionarySuggestCache.delete(this._dictionarySuggestCache.keys().next().value);
      }
      return results;
    }

    _renderSuggestList(list) {
      if (!this.suggestEl) return;
      if (!list.length) {
        this._hideSuggest(false);
        return;
      }
      this._suggestList = list;
      this._suggestIdx = 0;
      this.suggestEl.style.maxHeight = "min(320px, 42vh)";
      this.suggestEl.style.overflowX = "hidden";
      this.suggestEl.style.overflowY = "auto";
      this.suggestEl.style.overscrollBehavior = "contain";
      if (!this.suggestEl.__tkWheelBound) {
        // ComfyUI 画布也监听滚轮；在弹层自身拦截冒泡，滚轮只滚动候选列表。
        this.suggestEl.addEventListener("wheel", (event) => event.stopPropagation(), { capture: true, passive: true });
        this.suggestEl.__tkWheelBound = true;
      }
      const catName = (c) => {
        const id = (catIdsOf(c)[0]) || "";
        return String(c.category || (id ? CAT_NAME(this.cardCats.find((x) => x.id === id)) : "通用"));
      };
      const countText = (c) => {
        const count = Number(c.count) || 0;
        return count > 0 ? ` · ${count.toLocaleString()}` : "";
      };
      const detailText = (c) => {
        const notes = String(c.notes || c.zh || "").trim();
        const description = String(c.description || "").trim();
        if (!notes) return description;
        if (!description || description.includes(notes)) return notes;
        return c.source === "card" ? `${notes} · ${description}` : description;
      };
      this.suggestEl.style.display = "";
      this.suggestEl.innerHTML = list.map((c, i) =>
        `<div class="tk-cards-suggest-item ${i === 0 ? "sel" : ""}" data-i="${i}">
          <div class="tk-cards-suggest-top"><span class="s-en">${esc(c.prompt || c.tag || "")}</span><span class="s-cat">${esc(catName(c) + countText(c))}</span></div>
          ${detailText(c) ? `<div class="s-desc">${esc(detailText(c))}</div>` : ""}</div>`).join("");
      this.suggestEl.querySelectorAll(".tk-cards-suggest-item").forEach((it) => {
        it.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this._applySuggest(list[parseInt(it.getAttribute("data-i"), 10)]);
        });
      });
    }

    async _updateSuggest() {
      if (!this.curTextEl || !this.suggestEl) return;
      const t = this.curTextEl.value;
      const caret = this.curTextEl.selectionStart ?? t.length;
      const [ws] = this._wordBounds(t, caret);
      const prefix = t.slice(ws, caret).trim();
      const requestId = ++this._suggestRequestId;
      this._suggestAbortController?.abort();
      this._suggestAbortController = null;
      if (!prefix) { this._hideSuggest(false); return; }

      const local = this.cards.map((card) => {
        const score = Math.min(
          suggestionMatchScore(card.prompt, prefix),
          suggestionMatchScore(card.notes, prefix),
          suggestionMatchScore(card.lora, prefix),
        );
        return Number.isFinite(score) ? { ...card, _suggestScore: score, source: "card" } : null;
      }).filter(Boolean).sort((a, b) =>
        a._suggestScore - b._suggestScore
        || (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0)
        || (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
        || (b.createdAt || 0) - (a.createdAt || 0)
      );
      this._renderSuggestList(local.slice(0, 8));

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      this._suggestAbortController = controller;
      let dictionary = [];
      try {
        dictionary = await this._fetchDictionarySuggestions(prefix, 16, controller);
      } catch (error) {
        if (error?.name !== "AbortError") console.debug("[TK Prompt Cards] 词典联想不可用：", error);
      }
      if (requestId !== this._suggestRequestId) return;
      if (this._suggestAbortController === controller) this._suggestAbortController = null;

      const merged = new Map();
      const add = (item) => {
        const prompt = String(item.prompt || item.tag || "").trim();
        const key = normalizeCardSearchText(prompt);
        if (!key) return;
        const current = merged.get(key);
        if (!current) {
          merged.set(key, { ...item, prompt, notes: String(item.notes || item.zh || ""), _suggestScore: item._suggestScore ?? 6 });
          return;
        }
        const itemNotes = String(item.notes || item.zh || "");
        const currentNotes = String(current.notes || current.zh || "");
        merged.set(key, {
          ...current,
          ...item,
          prompt: current.prompt || prompt,
          notes: item.source === "card" && itemNotes ? itemNotes : (currentNotes || itemNotes),
          count: Math.max(Number(current.count) || 0, Number(item.count) || 0),
          isFavorite: !!current.isFavorite || !!item.isFavorite,
          _suggestScore: Math.min(current._suggestScore ?? 6, item._suggestScore ?? 6),
          source: current.source === "card" || item.source === "card" ? "card" : item.source,
        });
      };
      dictionary.forEach((item) => add({ ...item, _suggestScore: item._suggestScore ?? 6 }));
      local.forEach(add);
      const list = [...merged.values()].sort((a, b) =>
        (a._suggestScore ?? 6) - (b._suggestScore ?? 6)
        || (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0)
        || (Number(b.count) || 0) - (Number(a.count) || 0)
        || (b.createdAt || 0) - (a.createdAt || 0)
      ).slice(0, 16);
      this._renderSuggestList(list);
    }

    _translateWordBounds(t, caret) {
      const isSep = (ch) => ch && /[，,、;；\n]/.test(ch);
      let ws = caret;
      while (ws > 0 && !isSep(t[ws - 1])) ws--;
      let we = caret;
      while (we < t.length && !isSep(t[we])) we++;
      return [ws, we];
    }

    _renderTranslateSuggestList(list) {
      if (!this.translateSuggestEl) return;
      if (!list.length) {
        this._hideTranslateSuggest(false);
        return;
      }
      this._translateSuggestList = list;
      this._translateSuggestIdx = 0;
      this.translateSuggestEl.style.maxHeight = "min(320px, 42vh)";
      this.translateSuggestEl.style.overflowX = "hidden";
      this.translateSuggestEl.style.overflowY = "auto";
      this.translateSuggestEl.style.overscrollBehavior = "contain";
      if (!this.translateSuggestEl.__tkWheelBound) {
        this.translateSuggestEl.addEventListener("wheel", (event) => event.stopPropagation(), { capture: true, passive: true });
        this.translateSuggestEl.__tkWheelBound = true;
      }
      const detailText = (card) => {
        const notes = String(card.notes || card.zh || "").trim();
        const description = String(card.description || "").trim();
        if (!notes) return description;
        if (!description || description.includes(notes)) return notes;
        return card.source === "card" ? `${notes} · ${description}` : description;
      };
      this.translateSuggestEl.style.display = "";
      this.translateSuggestEl.innerHTML = list.map((card, i) =>
        `<div class="tk-cards-suggest-item ${i === 0 ? "sel" : ""}" data-i="${i}">
          <div class="tk-cards-suggest-top"><span class="s-zh">${esc(card.notes || card.zh || "")}</span><span class="s-en">${esc(card.prompt || card.tag || "")}</span>${Number(card.count) > 0 ? `<span class="s-cat">${esc(Number(card.count).toLocaleString())}</span>` : ""}</div>
          ${detailText(card) ? `<div class="s-desc">${esc(detailText(card))}</div>` : ""}</div>`).join("");
      this.translateSuggestEl.querySelectorAll(".tk-cards-suggest-item").forEach((item) => {
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          this._applyTranslateSuggest(list[parseInt(item.getAttribute("data-i"), 10)]);
        });
      });
    }

    async _updateTranslateSuggest() {
      if (!this.translateInputEl || !this.translateSuggestEl) return;
      const text = this.translateInputEl.value;
      const caret = this.translateInputEl.selectionStart ?? text.length;
      const [ws] = this._translateWordBounds(text, caret);
      const prefix = text.slice(ws, caret).trim();
      const requestId = ++this._translateSuggestRequestId;
      this._translateSuggestAbortController?.abort();
      this._translateSuggestAbortController = null;
      if (!prefix || !containsCJK(prefix)) {
        this._hideTranslateSuggest(false);
        return;
      }
      const local = this.cards.map((card) => {
        const score = suggestionMatchScore(card.notes, prefix);
        return Number.isFinite(score) ? { ...card, _suggestScore: score, source: "card" } : null;
      }).filter(Boolean).sort((a, b) =>
        a._suggestScore - b._suggestScore
        || (b.isFavorite ? 1 : 0) - (a.isFavorite ? 1 : 0)
        || (b.createdAt || 0) - (a.createdAt || 0)
      );
      this._renderTranslateSuggestList(local.slice(0, 8));

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      this._translateSuggestAbortController = controller;
      let dictionary = [];
      try {
        dictionary = await this._fetchDictionarySuggestions(prefix, 16, controller);
      } catch (error) {
        if (error?.name !== "AbortError") console.debug("[TK Prompt Cards] 中文词典联想不可用：", error);
      }
      if (requestId !== this._translateSuggestRequestId) return;
      if (this._translateSuggestAbortController === controller) this._translateSuggestAbortController = null;
      const merged = new Map();
      [...dictionary.map((item) => ({ ...item, _suggestScore: item._suggestScore ?? 3 })), ...local].forEach((item) => {
        const key = normalizeCardSearchText(item.prompt || item.tag);
        if (!key) return;
        const previous = merged.get(key);
        if (!previous) {
          merged.set(key, { ...item, notes: String(item.notes || item.zh || "") });
          return;
        }
        merged.set(key, {
          ...previous,
          ...item,
          prompt: previous.prompt || item.prompt || item.tag,
          notes: item.source === "card" && item.notes ? String(item.notes) : (previous.notes || String(item.notes || item.zh || "")),
          count: Math.max(Number(previous.count) || 0, Number(item.count) || 0),
          _suggestScore: Math.min(previous._suggestScore ?? 3, item._suggestScore ?? 3),
        });
      });
      const list = [...merged.values()].sort((a, b) =>
        (a._suggestScore ?? 3) - (b._suggestScore ?? 3)
        || (Number(b.count) || 0) - (Number(a.count) || 0)
      ).slice(0, 16);
      this._renderTranslateSuggestList(list);
    }

    _hideTranslateSuggest(invalidate = true) {
      if (invalidate) {
        this._translateSuggestRequestId += 1;
        this._translateSuggestAbortController?.abort();
        this._translateSuggestAbortController = null;
      }
      if (this.translateSuggestEl) {
        this.translateSuggestEl.style.display = "none";
        this.translateSuggestEl.innerHTML = "";
      }
      this._translateSuggestList = [];
      this._translateSuggestIdx = -1;
    }

    _applyTranslateSuggest(card) {
      if (!card) return;
      const en = String(card.prompt || "").trim();
      const zh = String(card.notes || "").trim();
      if (!en) return;
      if (zh) this.piecesZh.set(en, zh);
      this._appendResolvedText(en);
      this._hideTranslateSuggest();
      this.translateInputEl?.focus();
    }

    _translateSuggestKeyDown(event) {
      if (!this._translateSuggestList.length || this.translateSuggestEl?.style.display === "none") return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this._translateSuggestIdx = (this._translateSuggestIdx + 1) % this._translateSuggestList.length;
        this._markTranslateSuggestSel();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this._translateSuggestIdx = (this._translateSuggestIdx - 1 + this._translateSuggestList.length) % this._translateSuggestList.length;
        this._markTranslateSuggestSel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this._applyTranslateSuggest(this._translateSuggestList[this._translateSuggestIdx] || this._translateSuggestList[0]);
      } else if (event.key === "Escape") {
        this._hideTranslateSuggest();
      }
    }

    _markTranslateSuggestSel() {
      this.translateSuggestEl?.querySelectorAll(".tk-cards-suggest-item").forEach((item, index) => {
        item.classList.toggle("sel", index === this._translateSuggestIdx);
      });
    }

    _hideSuggest(invalidate = true) {
      if (invalidate) this._cancelSuggestRequest();
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
      this._setPromptText(next, { preserveHidden: true, render: false });
      el.value = this.curText();
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

    _setPieceWeight(index, value, commit = true) {
      const parts = this._promptPieces();
      const piece = parts[index];
      if (!piece) return null;
      const weight = normalizePromptCardWeight(value);
      piece.weight = weight.toFixed(1);
      const next = serializePromptPieces(parts.filter((item) => !item.hidden));
      // 拖动过程中只更新可见值，不触发 ComfyUI 图重建；松手或单击时再提交一次。
      if (commit) {
        this._setW(this.w.positive, next);
        this._persistPromptPieces();
      }
      else if (this.w.positive) this.w.positive.value = next;
      if (this.curTextEl) this.curTextEl.value = next;

      const chip = this.chipsEl?.querySelector(`[data-piece-index="${index}"]`);
      if (chip) {
        const en = chip.querySelector(".tk-cards-chip-en, .tk-cards-chip-plain");
        if (en) en.textContent = formatWeightedPromptText(piece.text, piece.weight);
        const valueEl = chip.querySelector(".tk-cards-chip-weight-val");
        if (valueEl) valueEl.value = piece.weight;
      }
      if (commit) this._renderChips();
      return { next, piece, weight };
    }

    _bindPieceWeightScrub(button, index) {
      let startX = 0;
      let lastX = 0;
      let lastDelta = 0;
      let startWeight = 1;
      let dragging = false;
      let moved = false;

      const onMove = (event) => {
        if (!dragging) return;
        lastX = event.clientX;
        const delta = Math.round((lastX - startX) / 4) * 0.1;
        lastDelta = delta;
        if (Math.abs(event.clientX - startX) >= 2) moved = true;
        this._setPieceWeight(index, startWeight + delta, false);
      };
      const onUp = (event) => {
        if (!dragging) return;
        dragging = false;
        button.__scrubbed = moved;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        if (moved) {
          if (Number.isFinite(event?.clientX)) lastDelta = Math.round((event.clientX - startX) / 4) * 0.1;
          else lastDelta = Math.round((lastX - startX) / 4) * 0.1;
          this._setPieceWeight(index, startWeight + lastDelta, true);
        }
        if (moved) setTimeout(() => { if (button.__scrubbed) button.__scrubbed = false; }, 2000);
      };
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        dragging = true;
        moved = false;
        startX = event.clientX;
        lastX = startX;
        lastDelta = 0;
        startWeight = normalizePromptCardWeight(this._promptPieces()[index]?.weight);
        document.body.style.cursor = "ew-resize";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    }

    _renderChips() {
      if (!this.chipsEl) return;
      const parts = this._ensurePromptPiecesInSync();
      this.chipsEl.innerHTML = "";
      if (!parts.length) {
        this.chipsEl.innerHTML = `<div class="tk-cards-empty">输入提示词后自动按逗号分组（点击片段=存为卡片；hover ✕=移除）</div>`;
        return;
      }
      for (let index = 0; index < parts.length; index++) {
        const p = parts[index];
        const chip = document.createElement("span");
        chip.className = "tk-cards-chip" + (p.hidden ? " is-hidden" : "");
        chip.dataset.pieceIndex = String(index);
        chip.title = p.hidden ? "此片段已隐藏，不会输出；点击右侧显示按钮恢复" : "点击存为卡片；点击右侧隐藏按钮可停用；hover ✕ 移除该片段";
        const zh = this._translationForPiece(p.text);
        const chipBody = document.createElement("span");
        chipBody.className = "tk-cards-chip-body";
        const chipTop = document.createElement("span");
        chipTop.className = "tk-cards-chip-top";
        const enS = document.createElement("span");
        enS.className = "tk-cards-chip-en";
        enS.textContent = formatWeightedPromptText(p.text, p.weight);

        const weightGroup = document.createElement("span");
        weightGroup.className = "tk-cards-chip-weight";
        weightGroup.title = "降低或提高此片段权重；按住按钮横向拖动可连续调整，每格 0.1";
        const dec = document.createElement("button");
        dec.type = "button";
        dec.className = "tk-cards-chip-weight-step";
        dec.textContent = "<";
        dec.title = "降低权重（按住左右拖动可连续调）";
        dec.setAttribute("aria-label", "降低片段权重");
        const weightVal = document.createElement("input");
        weightVal.type = "text";
        weightVal.inputMode = "decimal";
        weightVal.className = "tk-cards-chip-weight-val";
        weightVal.value = promptCardWeightText(p.weight);
        weightVal.title = "手动输入权重（范围 -2.0 到 2.0）";
        const inc = document.createElement("button");
        inc.type = "button";
        inc.className = "tk-cards-chip-weight-step";
        inc.textContent = ">";
        inc.title = "提高权重（按住左右拖动可连续调）";
        inc.setAttribute("aria-label", "提高片段权重");
        weightGroup.append(dec, weightVal, inc);
        chipTop.append(enS, weightGroup);
        chipBody.appendChild(chipTop);
        if (zh) {
          const zhS = document.createElement("span");
          zhS.className = "tk-cards-chip-zh";
          zhS.textContent = zh;
          chipBody.appendChild(zhS);
        }
        const quickTranslation = this.piecesTranslation.get(p.text);
        if (quickTranslation?.error) {
          const errS = document.createElement("span");
          errS.className = "tk-cards-chip-translation is-error";
          errS.textContent = `译：${quickTranslation.error}`;
          chipBody.appendChild(errS);
        } else if (quickTranslation?.text) {
          const quickS = document.createElement("span");
          quickS.className = "tk-cards-chip-translation";
          quickS.textContent = `译：${quickTranslation.text}`;
          quickS.title = `${providerLabel(quickTranslation.provider)} · ${quickTranslation.quality ? qualityLabel(quickTranslation.quality) : "已翻译"}`;
          chipBody.appendChild(quickS);
        }
        chip.appendChild(chipBody);
        const step = (button, delta) => {
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            if (button.__scrubbed) { button.__scrubbed = false; return; }
            const current = normalizePromptCardWeight(this._promptPieces()[index]?.weight);
            this._setPieceWeight(index, current + delta, true);
          });
        };
        step(dec, -0.1);
        step(inc, 0.1);
        weightVal.addEventListener("click", (event) => event.stopPropagation());
        weightVal.addEventListener("mousedown", (event) => event.stopPropagation());
        weightVal.addEventListener("change", () => {
          const current = normalizePromptCardWeight(this._promptPieces()[index]?.weight);
          const parsed = Number.parseFloat(weightVal.value);
          this._setPieceWeight(index, Number.isFinite(parsed) ? parsed : current, true);
        });
        weightVal.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); weightVal.blur(); }
        });
        this._bindPieceWeightScrub(dec, index);
        this._bindPieceWeightScrub(inc, index);
        const visibility = document.createElement("button");
        visibility.type = "button";
        visibility.className = "tk-cards-chip-toggle";
        visibility.dataset.pieceAction = "visibility";
        visibility.textContent = p.hidden ? "显示" : "隐藏";
        visibility.title = p.hidden ? "恢复此片段并输出" : "隐藏此片段（保留卡片但不输出）";
        visibility.setAttribute("aria-label", visibility.title);
        visibility.setAttribute("aria-pressed", String(!p.hidden));
        visibility.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._togglePieceVisibility(index);
        });
        chip.appendChild(visibility);
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.addCard(this.curCat, { en: p.text, zh: zh || "", weight: p.weight });
        });
        const translate = document.createElement("button");
        translate.type = "button";
        translate.className = "tk-cards-chip-translate";
        translate.textContent = "译";
        translate.title = "快捷翻译此片段（不进入 Danbooru/BGE-M3 校准）";
        translate.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.translatePieceQuick(index, translate, chip);
        });
        chip.appendChild(translate);
        const x = document.createElement("button");
        x.type = "button";
        x.className = "tk-cards-chip-x";
        x.textContent = "✕";
        x.title = "从当前提示词移除该片段";
        x.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._removePromptPiece(index);
        });
        chip.appendChild(x);
        this.chipsEl.appendChild(chip);
      }
    }

    _hideResolve() {
      this.resolveItems = [];
      if (this.resolveEl) {
        this.resolveEl.style.display = "none";
        this.resolveEl.innerHTML = "";
      }
    }

    async _refreshTranslationStatus() {
      if (!this.translateStatusEl) return;
      try {
        const result = await fetchJson("/anima/translate/status");
        const providers = result.providers || {};
        const order = Array.isArray(result.auto_order) ? result.auto_order : Object.keys(providers);
        const seen = new Set(order);
        const names = [...order, ...Object.keys(providers).filter((name) => !seen.has(name))];
        const items = names.map((name) => {
          const state = providers[name] || {};
          const detail = state.last_error ? ` · ${state.last_error}` : "";
          const cls = state.health === "healthy" ? "is-ok" : "";
          return `<span class="${cls}" title="${escAttr(`${providerLabel(name)}${detail}`)}"><b>${esc(providerLabel(name))}</b>：${esc(providerStateLabel(state, name))}</span>`;
        }).join("");
        const actual = this.actualTranslationProvider
          ? `实际：${providerLabel(this.actualTranslationProvider)}`
          : "尚未执行翻译";
        if (this.translateStatusSummary) this.translateStatusSummary.textContent = `${actual} · 翻译状态（点击展开）`;
        const deeplx = result.deeplx || {};
        const deeplxAction = deeplx.installed
          ? `<button type="button" class="tk-cards-resolve-save" data-a="restart-deeplx">重启 DeepLX</button>`
          : "";
        const llm = result.local_llm || {};
        const llmBusy = llm.status === "downloading" || llm.status === "loading";
        const llmReady = llm.status === "ready" && llm.model;
        const llmActionLabel = llmReady ? "释放 Gemma" : (llmBusy ? "Gemma 加载中…" : "启用 Gemma");
        const llmActionTitle = llmReady
          ? "释放本地 LLM 显存；之后选择本地LLM翻译时仍会按需加载"
          : "主动加载盘上的 Gemma；仅选择本地LLM翻译时才会自动按需加载";
        const localLlmAction = `<button type="button" class="tk-cards-btn ${llmReady ? "" : "tk-cards-btn-main"}" data-a="toggle-local-llm" title="${escAttr(llmActionTitle)}" ${llmBusy ? "disabled" : ""}>${llmActionLabel}</button><button type="button" class="tk-cards-resolve-save" data-a="manage-local-llm">管理模型</button>`;
        const baidu = result.baidu || {};
        const baiduAction = `<button type="button" class="tk-cards-resolve-save" data-a="manage-baidu" title="配置百度翻译 APPID、API Key 和模型选项">百度设置${baidu.configured ? "" : "（未配置）"}</button>`;
        this.translateStatusEl.innerHTML = `<span class="tk-cards-translate-actual">${esc(actual)}</span><span class="tk-cards-translate-provider-list">${items}</span><span class="tk-cards-translate-status-actions">${deeplxAction}${baiduAction}${localLlmAction}</span>`;
        this.translateStatusEl.querySelector('[data-a="toggle-local-llm"]')?.addEventListener("click", () => this._toggleLocalLlm());
        this.translateStatusEl.querySelector('[data-a="manage-local-llm"]')?.addEventListener("click", () => this._manageLocalLlm());
        this.translateStatusEl.querySelector('[data-a="manage-baidu"]')?.addEventListener("click", () => this._manageBaidu());
        this.translateStatusEl.querySelector('[data-a="restart-deeplx"]')?.addEventListener("click", async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const restart = await postJson("/anima/translate/deeplx/restart", {}, 12000);
            this._flash(restart.started ? "DeepLX 已启动" : "DeepLX 重启失败", 5000);
          } catch (error) {
            this._flash("DeepLX 重启失败：" + (error.message || error), 5000);
          } finally {
            await this._refreshTranslationStatus();
          }
        });
      } catch (error) {
        this.translateStatusEl.textContent = "翻译源状态暂不可用";
        if (this.translateStatusSummary) this.translateStatusSummary.textContent = "翻译状态 · 暂不可用（点击展开）";
      }
    }

    async _assertGenerationIdle() {
      const queue = await fetchJson("/queue", { timeout: 5000 });
      const running = Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0;
      const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;
      if (running || pending) {
        throw new Error(`当前有 ${running} 个运行中、${pending} 个排队任务；为避免显存冲突，请等待生图队列清空后再启用本地 LLM`);
      }
    }

    async _waitLocalLlmReady(timeoutMs = 120000) {
      const deadline = Date.now() + timeoutMs;
      let state = null;
      while (Date.now() < deadline) {
        state = await fetchJson("/anima/translate/local_llm/status", { timeout: 8000 });
        if (state.status === "ready" && state.model) return state;
        if (state.status === "error") throw new Error(state.error || "本地 LLM 加载失败");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`本地 LLM 加载超时（当前状态：${state?.status || "未知"}）`);
    }

    async _withLocalLlmSession(source, work) {
      if (source !== "local_llm") return work();
      if (!this._localLlmSessionPromise) {
        this._localLlmSessionPromise = (async () => {
          await this._assertGenerationIdle();
          const before = await fetchJson("/anima/translate/local_llm/status", { timeout: 8000 });
          const wasReady = before.status === "ready" && Boolean(before.model);
          this._localLlmSessionAutoRelease = !wasReady;
          if (!wasReady) {
            if (before.status !== "loading" && before.status !== "downloading") {
              const loaded = await postJson("/anima/translate/local_llm/load", { model: "gemma-4b", download: false }, 12000);
              if (loaded?.ok === false) throw new Error(loaded.error || "本地 Gemma 未能启动");
            }
            await this._waitLocalLlmReady();
          }
          return true;
        })();
      }
      this._localLlmSessionRefs += 1;
      try {
        await this._localLlmSessionPromise;
        return await work();
      } finally {
        this._localLlmSessionRefs -= 1;
        if (this._localLlmSessionRefs === 0) {
          const session = this._localLlmSessionPromise;
          const autoRelease = this._localLlmSessionAutoRelease;
          this._localLlmSessionPromise = null;
          this._localLlmSessionAutoRelease = false;
          try {
            await session;
            if (autoRelease) {
              try {
                await postJson("/anima/translate/local_llm/unload", {}, 12000);
              } catch (error) {
                this._flash("本地 LLM 自动释放失败：" + (error.message || error), 5000);
              }
              this._refreshTranslationStatus();
            }
          } catch (error) {
            // 让原始加载错误继续返回给调用方；这里不再重复卸载未 ready 的模型。
          }
        }
      }
    }

    async _toggleLocalLlm() {
      if (this._localLlmActionBusy) return;
      this._localLlmActionBusy = true;
      try {
        const state = await fetchJson("/anima/translate/local_llm/status", { timeout: 8000 });
        if (state.status === "ready") {
          await postJson("/anima/translate/local_llm/unload", {}, 12000);
          this._flash("Gemma 已释放，显存已归还给生图", 5000);
        } else {
          await this._assertGenerationIdle();
          const loaded = await postJson("/anima/translate/local_llm/load", { model: "gemma-4b" }, 12000);
          if (loaded?.ok === false) throw new Error(loaded.error || "Gemma 启动失败");
          this._flash("Gemma 加载中…", 3000);
          await this._waitLocalLlmReady();
          this._flash("Gemma 已启用；会占用显存，生图前可点击“释放 Gemma”", 6000);
        }
      } catch (error) {
        this._flash("Gemma 操作失败：" + (error.message || error), 6000);
      } finally {
        this._localLlmActionBusy = false;
        await this._refreshTranslationStatus();
      }
    }

    async _manageBaidu() {
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-baidu-box" role="dialog" aria-modal="true">
        <div class="tk-cards-overlay-head"><b>百度翻译设置</b><button type="button" class="tk-cards-btn" data-a="close">关闭</button></div>
        <div class="tk-cards-category-note">使用百度官方大模型文本翻译 API。需要填写开发者信息中的 APPID；API Key 只保存在本机后端配置，不会回传或写入前端代码。</div>
        <label class="tk-cards-field"><span>百度 APPID</span><input data-a="appid" autocomplete="off" placeholder="${"需要填写 APPID"}"></label>
        <label class="tk-cards-field"><span>API Key</span><input data-a="api-key" type="password" autocomplete="new-password" placeholder="${"已保存时留空保持不变"}"></label>
        <label class="tk-cards-field"><span>翻译模型</span><select data-a="model"><option value="llm">大模型翻译（llm）</option><option value="nmt">机器翻译（nmt）</option></select></label>
        <label class="tk-cards-check"><input data-a="intervene" type="checkbox"><span>启用百度术语库干预（需要账号已开通）</span></label>
        <div class="tk-cards-baidu-status" data-a="status">正在读取百度配置…</div>
        <div class="tk-cards-edit-btns"><button type="button" class="tk-cards-btn" data-a="test">测试连接</button><button type="button" class="tk-cards-btn" data-a="clear">清除配置</button><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="save">保存配置</button></div>
      </div>`;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector('[data-a="close"]')?.addEventListener("click", close);
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
      overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } });
      const appid = overlay.querySelector('[data-a="appid"]');
      const apiKey = overlay.querySelector('[data-a="api-key"]');
      const model = overlay.querySelector('[data-a="model"]');
      const intervene = overlay.querySelector('[data-a="intervene"]');
      const status = overlay.querySelector('[data-a="status"]');
      const test = overlay.querySelector('[data-a="test"]');
      const clear = overlay.querySelector('[data-a="clear"]');
      const save = overlay.querySelector('[data-a="save"]');
      const show = (text, tone = "") => { if (status) { status.textContent = text; status.dataset.tone = tone; } };
      try {
        const config = await fetchJson("/anima/translate/baidu/config", { timeout: 8000 });
        if (config.has_appid) appid.placeholder = "已保存，留空保持不变";
        if (config.has_api_key) apiKey.placeholder = "已保存，留空保持不变";
        model.value = config.model_type || "llm";
        intervene.checked = config.need_intervene === true;
        show(config.configured ? `已配置 · ${config.model_type === "nmt" ? "机器翻译" : "大模型翻译"}` : "未配置：请填写 APPID 和 API Key");
      } catch (error) {
        show(`读取配置失败：${error.message || error}`, "error");
      }
      test.addEventListener("click", async () => {
        test.disabled = true;
        show("测试中…");
        try {
          const result = await postJson("/anima/translate/baidu/test", {
            appid: appid.value.trim(), api_key: apiKey.value.trim(), model_type: model.value,
            need_intervene: intervene.checked, q: "你好，世界",
          }, 40000);
          if (!result.ok) throw new Error(result.error || "百度翻译测试失败");
          show(`连接成功：${result.translatedText || "已返回译文"}`, "success");
        } catch (error) {
          show(`连接失败：${error.message || error}`, "error");
        } finally {
          test.disabled = false;
        }
      });
      clear.addEventListener("click", async () => {
        clear.disabled = true;
        try {
          await postJson("/anima/translate/baidu/config", { clear_appid: true, clear_api_key: true }, 12000);
          appid.value = "";
          apiKey.value = "";
          appid.placeholder = "需要填写 APPID";
          apiKey.placeholder = "已保存时留空保持不变";
          show("百度配置已清除", "success");
          await this._refreshTranslationStatus();
        } catch (error) {
          show(`清除失败：${error.message || error}`, "error");
        } finally {
          clear.disabled = false;
        }
      });
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          const config = await postJson("/anima/translate/baidu/config", {
            appid: appid.value.trim(), api_key: apiKey.value.trim(), model_type: model.value,
            need_intervene: intervene.checked,
          }, 12000);
          if (!config.ok) throw new Error(config.error || "保存失败");
          apiKey.value = "";
          appid.value = "";
          appid.placeholder = config.has_appid ? "已保存，留空保持不变" : "需要填写 APPID";
          apiKey.placeholder = config.has_api_key ? "已保存，留空保持不变" : "需要填写 API Key";
          show(config.configured ? "百度配置已保存并启用" : "已保存，但还缺少 APPID 或 API Key", config.configured ? "success" : "");
          await this._refreshTranslationStatus();
        } catch (error) {
          show(`保存失败：${error.message || error}`, "error");
        } finally {
          save.disabled = false;
        }
      });
      overlay.tabIndex = -1;
      overlay.focus?.();
    }

    // 本地 LLM 翻译模型管理（手动启用/下载/卸载；普通启动不加载）
    async _manageLocalLlm() {
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-llm-box">
        <div class="tk-cards-overlay-head"><b>本地翻译模型（手动启用）</b><button type="button" class="tk-cards-btn" data-a="close">关闭</button></div>
        <div class="tk-cards-category-note">本地模型负责自然语言翻译（不生成 Danbooru 标签）。普通启动不加载；选择本地LLM翻译时会按需加载，翻译完成后自动释放。</div>
        <div class="tk-cards-llm-rows" data-a="rows"></div>
        <div class="tk-cards-llm-error" data-a="error" style="color:var(--tk-warn);font-size:10px;min-height:14px;"></div>
      </div>`;
      document.body.appendChild(overlay);
      const box = overlay;
      let pollTimer = null;
      const close = () => { if (pollTimer) clearInterval(pollTimer); overlay.remove(); };
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);

      const render = async () => {
        let st;
        try {
          st = await fetchJson("/anima/translate/local_llm/status");
        } catch (e) {
          box.querySelector('[data-a="rows"]').innerHTML = `<div class="tk-cards-empty">后端尚未加载本地 LLM 路由（需要重启 ComfyUI 后才可用）</div>`;
          return;
        }
        const models = st.models || {};
        const cur = st.status || "idle";
        const prog = cur === "downloading" || cur === "loading" ? ` ${Math.round((st.progress || 0) * 100)}%` : "";
        const rows = Object.entries(models).map(([id, m]) => {
          const me = cur === "ready" && st.model === id;
          const busy = (cur === "downloading" || cur === "loading") && st.model === id;
          const suffix = me ? ` <b style="color:var(--tk-info)">已加载</b>` : (busy ? ` <span style="color:var(--tk-info)">${cur}${prog}…</span>` : "");
          const available = m.available !== false;
          const btn = me
            ? `<button type="button" class="tk-cards-btn" data-a="unload" data-m="${escAttr(id)}">卸载</button>`
            : (busy ? "" : `<button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="load" data-m="${escAttr(id)}">${available ? "启用（本地文件）" : "下载并启用"}</button>`);
          return `<div class="tk-cards-llm-row">
            <b>${esc(m.label)}</b>
            <span class="tk-cards-muted">${esc(m.size)} · ${esc(id)}</span>
            <span class="tk-cards-muted" title="许可说明">${esc(m.license)}</span>
            <span>${suffix}</span>${btn}
          </div>`;
        }).join("");
        box.querySelector('[data-a="rows"]').innerHTML = rows || `<div class="tk-cards-empty">无可用模型</div>`;
        box.querySelector('[data-a="error"]').textContent = st.error ? `错误：${st.error}` : "";
        box.querySelectorAll('[data-a="load"]').forEach((b) => b.addEventListener("click", async () => {
          try {
            await this._assertGenerationIdle();
            const loaded = await postJson("/anima/translate/local_llm/load", { model: b.getAttribute("data-m"), download: true });
            if (loaded?.ok === false) throw new Error(loaded.error || "本地 LLM 启动失败");
            pollTimer = setInterval(render, 2000);
            await render();
          } catch (e) {
            box.querySelector('[data-a="error"]').textContent = "启用失败：" + (e.message || e);
          }
        }));
        box.querySelectorAll('[data-a="unload"]').forEach((b) => b.addEventListener("click", async () => {
          try {
            await postJson("/anima/translate/local_llm/unload", {});
            this._refreshTranslationStatus();
            await render();
          } catch (e) {
            box.querySelector('[data-a="error"]').textContent = "卸载失败：" + (e.message || e);
          }
        }));
        if (cur === "ready") this._refreshTranslationStatus();
      };
      await render();
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); close(); } });
      overlay.focus?.();
    }

    _renderResolvePanel() {
      if (!this.resolveEl) return;
      if (!this.resolveItems.length) {
        this.resolveEl.style.display = "none";
        this.resolveEl.innerHTML = "";
        return;
      }
      this.resolveEl.style.display = "";
      this.resolveEl.innerHTML = `
        <div class="tk-cards-resolve-head"><b>${this.resolveItems.some((item) => item.mode === "translate") ? "中文翻译结果" : "中文翻译与 Danbooru 校准"}</b><span>${this.resolveItems.some((item) => item.mode === "translate") ? "可修改译文后加入或保存词典" : "点击候选后加入当前提示词"}</span></div>
        <div class="tk-cards-resolve-list">${this.resolveItems.map((item, i) => {
          const candidates = Array.isArray(item.candidates) ? item.candidates : [];
          const labels = candidates.map((c) => danbooruTagToPrompt(c.prompt || c.tag)).filter(Boolean);
          const candidateText = labels.length ? labels.join(", ") : "未找到已验证的规范标签";
          const translationText = item.translationStatus || "未获取英文译文";
          const translationEditor = item.translation
            ? `<span>英文译文：</span><input class="tk-cards-resolve-translation" data-a="edit-translation" data-i="${i}" value="${escAttr(item.translation)}" title="可手动修正译文；保存到词典后下次优先使用">`
            : `<span>译文：${esc(translationText)}</span>`;
          const providerText = item.provider ? `翻译源：${providerLabel(item.provider)}` : "翻译源：未成功";
          const qaText = `QA：${qualityLabel(item.quality)}`;
          const calibrationLabels = [...new Set(candidates.map((c) => CALIBRATION_LABELS[c.matchType] || c.matchType || "D站验证").filter(Boolean))];
          const calibrationText = item.mode === "calibrate" ? `校准来源：${calibrationLabels.length ? calibrationLabels.join("、") : "未校准"}` : "";
          const buttons = candidates.map((candidate, ci) => {
            const label = danbooruTagToPrompt(candidate.prompt || candidate.tag);
            const verified = candidateSourceLabel(candidate);
            return `<span class="tk-cards-resolve-candidate-wrap"><button type="button" class="tk-cards-resolve-candidate ${candidate.verified ? "is-verified" : ""}" data-a="use-candidate" data-i="${i}" data-ci="${ci}" title="${escAttr(`${verified} · ${candidate.tag || ""}`)}">${esc(label)}<small>${esc(verified)}</small></button><button type="button" class="tk-cards-resolve-save" data-a="save-glossary" data-i="${i}" data-ci="${ci}" title="把当前中文短语和这个英文标签保存到用户词典">存词典</button></span>`;
          }).join("");
          const fallback = item.translation
            ? `<button type="button" class="tk-cards-btn tk-cards-resolve-fallback" data-a="use-translation" data-i="${i}">${item.mode === "translate" ? "加入译文" : "加入译文（未校准）"}</button><button type="button" class="tk-cards-btn tk-cards-resolve-save" data-a="save-translation" data-i="${i}">保存译文</button>`
            : "";
          const semantic = item.semantic || {};
          const semanticHint = semantic.needInit
            ? `<div class="tk-cards-resolve-semantic-hint">自然语言需要本地语义引擎（BGE-M3）；首次启用可能需要初始化/下载模型。<button type="button" class="tk-cards-btn" data-a="init-semantic">启用语义引擎</button></div>`
            : (semantic.error ? `<div class="tk-cards-resolve-semantic-hint">语义解析不可用：${esc(semantic.error)}</div>` : "");
          const canUseAuto = item.errorPayload?.canUseAuto === true;
          const autoButton = canUseAuto
            ? `<button type="button" class="tk-cards-btn tk-cards-resolve-fallback" data-a="use-auto" data-i="${i}">改用自动</button>`
            : "";
          return `<div class="tk-cards-resolve-row" data-i="${i}">
            <div class="tk-cards-resolve-source"><b>${esc(item.text || "")}</b><span class="tk-cards-resolve-translation-line">${translationEditor}</span><span class="tk-cards-resolve-provider">${esc(providerText)} · ${esc(qaText)}${calibrationText ? ` · ${esc(calibrationText)}` : ""}</span></div>
            ${item.mode === "calibrate" ? `<div class="tk-cards-resolve-tags"><span>规范候选：</span><strong>${esc(candidateText)}</strong></div>` : ""}
            <div class="tk-cards-resolve-actions">${buttons || `<span class="tk-cards-resolve-empty">暂无规范候选</span>`}${fallback}${autoButton}</div>
            ${semanticHint}
          </div>`;
        }).join("")}</div>`;
      this.resolveEl.querySelectorAll('[data-a="use-candidate"]').forEach((button) => {
        button.addEventListener("click", () => {
          const rowIndex = parseInt(button.getAttribute("data-i"), 10);
          const item = this.resolveItems[rowIndex];
          const sourceIndex = Number.isInteger(item?.sourceIndex) ? item.sourceIndex : null;
          const candidate = item?.candidates?.[parseInt(button.getAttribute("data-ci"), 10)];
          this._useResolvedCandidate(sourceIndex, candidate);
        });
      });
      this.resolveEl.querySelectorAll('[data-a="use-translation"]').forEach((button) => {
        button.addEventListener("click", () => {
          const rowIndex = parseInt(button.getAttribute("data-i"), 10);
          const item = this.resolveItems[rowIndex];
          const sourceIndex = Number.isInteger(item?.sourceIndex) ? item.sourceIndex : null;
          const edited = this.resolveEl.querySelector(`[data-a="edit-translation"][data-i="${rowIndex}"]`)?.value || item?.translation || "";
          this._useResolvedTranslation(sourceIndex, edited);
        });
      });
      this.resolveEl.querySelectorAll('[data-a="edit-translation"]').forEach((input) => {
        input.addEventListener("input", () => {
          const item = this.resolveItems[parseInt(input.getAttribute("data-i"), 10)];
          if (item) item.translation = input.value;
        });
      });
      this.resolveEl.querySelectorAll('[data-a="save-glossary"]').forEach((button) => {
        button.addEventListener("click", () => {
          const rowIndex = parseInt(button.getAttribute("data-i"), 10);
          const item = this.resolveItems[rowIndex];
          const candidate = item?.candidates?.[parseInt(button.getAttribute("data-ci"), 10)];
          const edited = this.resolveEl.querySelector(`[data-a="edit-translation"][data-i="${rowIndex}"]`)?.value || candidate?.prompt || candidate?.tag || "";
          const original = candidate?.prompt || candidate?.tag || "";
          this._saveGlossary(item, { ...(candidate || {}), prompt: edited, tag: edited === original ? candidate?.tag || "" : "" });
        });
      });
      this.resolveEl.querySelectorAll('[data-a="save-translation"]').forEach((button) => {
        button.addEventListener("click", () => {
          const rowIndex = parseInt(button.getAttribute("data-i"), 10);
          const item = this.resolveItems[rowIndex];
          const edited = this.resolveEl.querySelector(`[data-a="edit-translation"][data-i="${rowIndex}"]`)?.value || item?.translation || "";
          this._saveGlossary(item, { prompt: edited, tag: "" });
        });
      });
          this.resolveEl.querySelectorAll('[data-a="use-auto"]').forEach((button) => {
        button.addEventListener("click", () => this._useAutoTranslation(parseInt(button.getAttribute("data-i"), 10)));
      });
      this.resolveEl.querySelectorAll('[data-a="init-semantic"]').forEach((button) => {
        button.addEventListener("click", () => this._startSemanticEngine(button));
      });
    }

    _replaceResolvedPiece(index, replacement) {
      const parts = this._promptPieces();
      const source = parts[index];
      const text = String(replacement || "").trim();
      if (!source || !text) return false;
      // 重建时统一使用 Anima 的英文逗号；Danbooru 下划线已在进入这里前转换为空格。
      parts[index] = { ...source, text, weight: source.weight && !text.includes(",") ? source.weight : "" };
      this._commitPromptPieces();
      this._hideResolve();
      return true;
    }

    _useResolvedCandidate(index, candidate) {
      const text = danbooruTagToPrompt(candidate?.prompt || candidate?.tag);
      const used = Number.isInteger(index) ? this._replaceResolvedPiece(index, text) : this._appendResolvedText(text);
      if (used) {
        this._flash(candidate?.verified ? `已加入 Danbooru 规范词：${text}` : `已加入本地规范候选：${text}`);
      }
    }

    _useResolvedTranslation(index, translation) {
      const text = String(translation || "").trim();
      const used = Number.isInteger(index) ? this._replaceResolvedPiece(index, text) : this._appendResolvedText(text);
      if (used) this._flash("已加入译文（未经过 Danbooru 校准）");
    }

    async _saveGlossary(item, candidate) {
      const sourceText = String(item?.text || "").trim();
      const translatedText = String(candidate?.prompt || candidate?.tag || "").trim();
      if (!sourceText || !translatedText) { this._flash("没有可保存的词典内容"); return; }
      try {
        await postJson("/anima/translate/glossary", {
          source_text: sourceText,
          translated_text: translatedText,
          tag_text: candidate?.tag || "",
          source_language: "zh",
          target_language: "en",
        });
        this._flash(`已保存到用户词典：${sourceText} → ${translatedText}`);
      } catch (error) {
        this._flash("保存用户词典失败：" + (error.message || error), 5000);
      }
    }

    _useAutoTranslation(rowIndex) {
      const item = this.resolveItems[rowIndex];
      if (!item || !this.translateSourceEl) return;
      this.translateSourceEl.value = "auto";
      saveTranslateSource("auto");
      if (Number.isInteger(item.sourceIndex)) this.translatePieceOnly(item.sourceIndex);
      else if (this.lastTranslationMode === "translate") this.translateOnly();
      else this.translatePiecesOnly();
    }

    _appendResolvedText(text) {
      const additions = splitTags(text);
      if (!additions.length) return false;
      const current = this._promptPieces();
      const seen = new Set(current.map((p) => p.text.toLowerCase().trim()));
      for (const addition of additions) {
        const key = addition.text.toLowerCase().trim();
        if (key && !seen.has(key)) {
          current.push({ ...addition, hidden: false });
          seen.add(key);
        }
      }
      this._commitPromptPieces();
      this._hideResolve();
      return true;
    }

    async _startSemanticEngine(button) {
      if (button?.disabled) return;
      if (button) button.disabled = true;
      try {
        const result = await postJson("/danbooru_anima/vec_init", {}, 12000);
        this._flash(result.started ? "已开始初始化本地语义引擎，完成后再次点击翻译并校准" : "语义引擎正在初始化，请稍候", 6000);
      } catch (e) {
        this._flash("语义引擎启动失败：" + (e.message || e), 5000);
      } finally {
        if (button) button.disabled = false;
      }
    }

    async _translateAndSemantic(text, withSemantic = false) {
      const value = String(text || "").trim();
      const source = this.translateSourceEl?.value || "auto";
      const sourceName = TRANSLATE_SOURCES.find(([id]) => id === source)?.[1] || "翻译源";
      let translation = value;
      let translationStatus = "";
      let provider = langOf(value) === "zh" ? "" : "input";
      let quality = null;
      let attempts = {};
      let errorPayload = null;
      let glossaryTag = "";
      if (langOf(value) === "zh") {
        if (source === "local") {
          translation = "";
          translationStatus = "本地词典仅用于标签反查";
        } else {
          try {
            const result = await translateChineseToEnglish(value, source);
            translation = result.translatedText || "";
            provider = result.provider || result.source || source;
            quality = result.quality || null;
            attempts = result.attempts || {};
            glossaryTag = result.tagText || "";
          } catch (error) {
            translation = "";
            translationStatus = error.payload?.error || `${sourceName}未返回英文`;
            errorPayload = error.payload || null;
          }
        }
      }
      const semantic = withSemantic && isNaturalChinese(value) ? await semanticSearchTags(value) : null;
      return { translation, translationStatus, provider, quality, attempts, errorPayload, glossaryTag, semantic };
    }

    // ②区单个片段翻译：只请求当前卡片，不改变其他片段的中文注释/校准结果。
    async translatePieceOnly(index) {
      const parts = this._promptPieces();
      const piece = parts[index];
      if (!piece) return;
      this._flash(`正在翻译第 ${index + 1} 条…`);
      try {
        const source = this.translateSourceEl?.value || "auto";
        const translated = await this._withLocalLlmSession(source, () => this._translateAndSemantic(piece.text, true));
        const result = await postJson("/anima/danbooru/resolve", {
          items: [{ id: String(index), text: piece.text, translation: translated.translation }],
        }, 45000);
        this.resolveItems = (Array.isArray(result.items) ? result.items : []).map((item) => ({
          ...item,
          mode: "calibrate",
          sourceIndex: index,
          translation: translated.translation,
          translationStatus: translated.translationStatus,
          provider: translated.provider,
          quality: translated.quality,
          attempts: translated.attempts,
          errorPayload: translated.errorPayload,
          glossaryTag: translated.glossaryTag,
          semantic: translated.semantic,
          candidates: mergeResolvedCandidates([...glossaryCandidateOf(translated.glossaryTag), ...(item.candidates || [])], translated.semantic),
        }));
        this.actualTranslationProvider = translated.provider;
        this._renderResolvePanel();
        this._refreshTranslationStatus();
        this._flash("单条翻译完成，请选择规范候选", 5000);
      } catch (e) {
        this._flash("单条翻译失败：" + (e.message || e), 5000);
      }
    }

    // ②区当前提示词的单卡快捷翻译：只调用翻译源并把结果显示在卡片上。
    // 不打开校准面板、不调用 /resolve，也不触发 BGE-M3。
    async translatePieceQuick(index, button, chip) {
      const parts = this._promptPieces();
      const piece = parts[index];
      if (!piece || button?.disabled) return;
      const originalLabel = button?.textContent || "译";
      if (button) {
        button.disabled = true;
        button.textContent = "…";
      }
      try {
        const source = this.translateSourceEl?.value || "auto";
        const result = await this._withLocalLlmSession(source, () => translateDetailed(piece.text, source));
        const translated = String(result.translatedText || "").trim();
        if (!translated) throw new Error(result.error || "翻译源未返回译文");
        this.piecesTranslation.set(piece.text, {
          text: translated,
          provider: result.provider || result.source || source,
          quality: result.quality || null,
        });
        this.actualTranslationProvider = result.provider || result.source || source;
        if (chip?.isConnected) this._renderChips();
        this._refreshTranslationStatus();
        this._flash(`${piece.text} → ${translated}`, 5000);
      } catch (error) {
        this._flash(`快捷翻译失败：${error.message || error}`, 5000);
      } finally {
        if (button?.isConnected) {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
    }

    // 一键翻译当前提示词未翻译片段：已有卡片中文注释或快捷译文的片段均跳过。
    async translateAllPieces() {
      const parts = this._promptPieces();
      if (!parts.length) { this._flash("当前提示词为空", 3000); return; }
      const source = this.translateSourceEl?.value || "auto";
      const todo = parts.filter((p) => {
        const quick = this.piecesTranslation.get(p.text);
        return !quick?.text && !this._translationForPiece(p.text);
      });
      if (!todo.length) { this._flash("所有片段均已翻译", 3000); return; }
      this._flash(`正在翻译未翻译片段（${todo.length} 条）…`);
      let okCount = 0;
      let failCount = 0;
      let lastProvider = "";
      try {
        await this._withLocalLlmSession(source, async () => {
          const workers = Array.from({ length: 3 }, async () => {
            while (todo.length) {
              const p = todo.shift();
              try {
                const result = await translateDetailed(p.text, source);
                const translated = String(result.translatedText || "").trim();
                if (!translated) throw new Error(result.error || "翻译源未返回译文");
                this.piecesTranslation.set(p.text, {
                  text: translated,
                  provider: result.provider || result.source || source,
                  quality: result.quality || null,
                });
                if (result.provider || result.source) lastProvider = result.provider || result.source;
                okCount += 1;
              } catch (error) {
                this.piecesTranslation.set(p.text, { text: "", provider: source, quality: null, error: error.message || "翻译失败" });
                failCount += 1;
              }
            }
          });
          await Promise.all(workers);
        });
      } catch (error) {
        this._flash("本地 LLM 翻译失败：" + (error.message || error), 6000);
        return;
      }
      if (lastProvider) this.actualTranslationProvider = lastProvider;
      this._renderChips();
      this._refreshTranslationStatus();
      this._flash(failCount ? `翻译完成：成功 ${okCount}，失败 ${failCount}` : `全部翻译完成（${okCount} 条）`, 4000);
    }

    async _collectTranslations(parts, withSemantic) {
      const source = this.translateSourceEl?.value || "auto";
      try {
        return await this._withLocalLlmSession(source, async () => {
          const translated = new Array(parts.length);
          let cursor = 0;
          const workers = Array.from({ length: 3 }, async () => {
            while (cursor < parts.length) {
              const index = cursor++;
              const p = parts[index];
              try {
                translated[index] = await this._translateAndSemantic(p.text, withSemantic);
              } catch (e) {
                translated[index] = { translation: "", translationStatus: "翻译处理失败", provider: "", quality: null, attempts: {}, errorPayload: null, glossaryTag: "", semantic: null };
              }
            }
          });
          await Promise.all(workers);
          return translated;
        });
      } catch (error) {
        this._flash("本地 LLM 翻译失败：" + (error.message || error), 6000);
        return parts.map(() => ({ translation: "", translationStatus: error.message || "本地 LLM 翻译失败", provider: "", quality: null, attempts: {}, errorPayload: null, glossaryTag: "", semantic: null }));
      }
    }

    // ②区「仅翻译」：只展示英文译文和 QA，不调用 Danbooru/BGE-M3 校准。
    async translateOnly() {
      const parts = splitTags(this.translateInputEl?.value || "");
      if (!parts.length) { this._flash("中文翻译输入为空"); return; }
      this.lastTranslationMode = "translate";
      this._flash(`翻译中：${parts.length} 段…`);
      const translated = await this._collectTranslations(parts, false);
      this.resolveItems = parts.map((p, i) => ({
        id: String(i), text: p.text, sourceIndex: null, mode: "translate",
        translation: translated[i]?.translation || "",
        translationStatus: translated[i]?.translationStatus || "",
        provider: translated[i]?.provider || "",
        quality: translated[i]?.quality || null,
          attempts: translated[i]?.attempts || {},
          errorPayload: translated[i]?.errorPayload || null,
          glossaryTag: translated[i]?.glossaryTag || "",
          candidates: [], semantic: null,
      }));
      this.actualTranslationProvider = this.resolveItems.find((item) => item.provider)?.provider || "";
      this._renderResolvePanel();
      this._refreshTranslationStatus();
      const ok = this.resolveItems.filter((item) => item.translation).length;
      this._flash(`仅翻译完成：${ok}/${parts.length} 段`, 5000);
    }

    // ②区「翻译并校准」：中文片段 → 英文 → 可选语义检索 → Danbooru 规范候选。
    async translatePiecesOnly() {
      const parts = splitTags(this.translateInputEl?.value || "");
      if (!parts.length) { this._flash("中文翻译输入为空"); return; }
      this.lastTranslationMode = "calibrate";
      this._flash(`翻译并校准中：${parts.length} 段…`);
      const translated = await this._collectTranslations(parts, true);
      try {
        const result = await postJson("/anima/danbooru/resolve", {
          items: parts.map((p, i) => ({ id: String(i), text: p.text, translation: translated[i]?.translation || "" })),
        }, 45000);
        this.resolveItems = (Array.isArray(result.items) ? result.items : []).map((item, i) => ({
          ...item,
          sourceIndex: null,
          mode: "calibrate",
          translation: translated[i]?.translation || "",
          translationStatus: translated[i]?.translationStatus || "",
          provider: translated[i]?.provider || "",
          quality: translated[i]?.quality || null,
          attempts: translated[i]?.attempts || {},
          errorPayload: translated[i]?.errorPayload || null,
          glossaryTag: translated[i]?.glossaryTag || "",
          semantic: translated[i]?.semantic || null,
          candidates: mergeResolvedCandidates([...glossaryCandidateOf(translated[i]?.glossaryTag), ...(item.candidates || [])], translated[i]?.semantic),
        }));
        this.actualTranslationProvider = this.resolveItems.find((item) => item.provider)?.provider || "";
        this._renderResolvePanel();
        this._refreshTranslationStatus();
        const verified = this.resolveItems.reduce((n, item) => n + (item.candidates || []).filter((c) => c.verified).length, 0);
        this._flash(`校准完成：${verified} 个候选已由 D站 验证，请选择加入当前提示词`, 5000);
      } catch (e) {
        this._flash("校准失败：" + (e.message || e), 5000);
      }
    }

    // ②区「AI 入卡」：当前所有片段 → LLM 自动判定分类 → 确认清单（可改判）→ 确认后入库
    async cardsAddAll() {
      const parts = this._promptPieces();
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
          const r = await this.addCard(this.curCat, { en: p.text, zh: this._translationForPiece(p.text), weight: p.weight });
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
        const zh = this._translationForPiece(p.text);
        const sug = suggestions[String(i)] || "";
        const catId = name2id[sug] || fallbackId;
        const opts = this.cardCats.map((c) =>
          `<option value="${escAttr(c.id)}" ${c.id === catId ? "selected" : ""}>${esc(CAT_NAME(c))}</option>`).join("");
        return `<div class="tk-cards-ai-row" data-i="${i}">
          <div class="tk-cards-ai-text">${esc(formatWeightedPromptText(p.text, p.weight))}${zh ? `<span class="tk-cards-ai-zh">${esc(zh)}</span>` : ""}</div>
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
          const r = await this.addCard(catId, { en: p.text, zh: this._translationForPiece(p.text), weight: p.weight });
          if (r && r.skipped) skipN++; else n++;
        }
        close();
        this._flash(`已确认入卡：${n} 段${skipN ? `（${skipN} 段库中已存在已跳过）` : ""}${rmN ? `；已移除 ${rmN} 段` : ""}`);
      });
    }

    // 整段存入工具箱 prompt 库，不拆成③区 tag 卡片。
    async saveCurrentAsPrompt() {
      const text = this.curText().trim();
      if (!text) { this._flash("当前提示词为空"); return; }
      try {
        const now = Date.now();
        const db = await openDB();
        await storePut(db, PROMPT_STORE, {
          id: genId("p_"),
          prompt: text,
          displayText: text.slice(0, 40),
          notes: "",
          tags: splitTags(text).map((part) => part.text),
          images: [],
          primaryImage: "",
          categoryId: "uncategorized",
          isFavorite: false,
          kind: "prompt",
          createdAt: now,
          updatedAt: now,
        });
        await this.reloadLib();
        this._switchLibPane("lib");
        this._flash("整段提示词已存入工具箱 prompt 库");
      } catch (error) {
        this._flash("保存到 prompt 库失败：" + (error.message || error), 5000);
      }
    }

    _stashDraft() {
      saveDraft(this.curText());
    }

    restoreDraft() {
      const d = loadDraft();
      if (d) {
        this._setPromptText(d);
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

    async _updateCardSearch() {
      const query = this.cardSearch;
      const requestId = ++this._cardSearchRequestId;
      this._cardSearchAbortController?.abort();
      this._cardSearchAbortController = null;
      this._cardSearchDictionaryKeys = new Set();
      this._renderCards();
      if (!query) return;
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      this._cardSearchAbortController = controller;
      try {
        const results = await this._fetchDictionarySuggestions(query, 40, controller);
        if (requestId !== this._cardSearchRequestId) return;
        this._cardSearchDictionaryKeys = new Set(results.map((item) => normalizeCardSearchText(item.prompt || item.tag)));
      } catch (error) {
        if (error?.name !== "AbortError") console.debug("[TK Prompt Cards] 卡片词典搜索不可用：", error);
      }
      if (requestId !== this._cardSearchRequestId) return;
      if (this._cardSearchAbortController === controller) this._cardSearchAbortController = null;
      this._renderCards();
    }

    _renderCards() {
      if (!this.cardGridEl) return;
      let list = this.cards.slice();
      if (this.curCat) list = list.filter((p) => cardInCat(p, this.curCat));
      if (this.cardSearch) list = list.filter((card) => fuzzyCardMatch(card, this.cardSearch, this._cardSearchDictionaryKeys));
      this._sortCardList(list);
      this.cardGridEl.innerHTML = "";
      if (!list.length) {
        this.cardGridEl.innerHTML = this.cardSearch
          ? `<div class="tk-cards-empty">没有匹配的双语卡片 — 可搜索英文或中文译文</div>`
          : `<div class="tk-cards-empty">暂无卡片 — ②区点片段「存卡」或「一键入卡」，或「浏览 LoRA」批量收藏</div>`;
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
        del.title = "删除卡片（需二次点击确认）";
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
        let clickTimer = null;
        el.addEventListener("click", (ev) => {
          if (delArmed) { disarmDel(); return; }
          if (ev.target.closest(".tk-cards-star") || ev.target.closest(".tk-cards-del") ||
              ev.target.closest(".tk-cards-cat-btn") || ev.target.closest(".tk-cards-pin") ||
              ev.target.closest(".tk-cards-retranslate") ||
              ev.target.closest(".tk-cards-grip")) return;
          if (ev.ctrlKey || ev.metaKey) {
            clearTimeout(clickTimer);
            if (this.selectedCardIds.has(c.id)) this.selectedCardIds.delete(c.id); else this.selectedCardIds.add(c.id);
            this._renderCards();
            this._flash(`${this.selectedCardIds.size} 张卡片已选中（Ctrl/Cmd 点击切换）`);
            return;
          }
          clearTimeout(clickTimer);
          clickTimer = setTimeout(() => {
            const cur = this.curText();
            const next = appendCardToPrompt(cur, c);
            this._setPromptText(next, { preserveHidden: true });
            if (next === cur) this._flash("该卡片已在提示词中（已去重）");
          }, 240);
        });
        el.addEventListener("dblclick", (ev) => {
          if (ev.target.closest(".tk-cards-star") || ev.target.closest(".tk-cards-del") ||
              ev.target.closest(".tk-cards-cat-btn") || ev.target.closest(".tk-cards-pin") ||
              ev.target.closest(".tk-cards-retranslate") ||
              ev.target.closest(".tk-cards-grip")) return;
          clearTimeout(clickTimer);
          ev.preventDefault();
          this._openEditModal(c, "card");
        });
        el.querySelector(".tk-cards-star").addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.toggleFavorite(c.id);
        });
        const retranslate = document.createElement("button");
        retranslate.type = "button";
        retranslate.className = "tk-cards-retranslate";
        retranslate.textContent = "重译";
        retranslate.title = "重新翻译这张卡片的中文注释（覆盖原注释）";
        retranslate.addEventListener("click", (ev) => { ev.stopPropagation(); this.retranslateCard(c.id); });
        meta.appendChild(retranslate);
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

    // 卡片编辑（双击卡片打开弹窗）
    beginEdit(id, cardEl, c) {
      this._openEditModal(c, "card");
    }

    // ── 工具：剪切板 / PNG / LoRA / 批量补翻 / 导出 ──

    async importClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) { this._flash("剪切板为空"); return; }
        this._setPromptText(text.trim());
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
        this._setPromptText(result.positive);
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
              this._setPromptText(text, { preserveHidden: true });
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

    async retranslateCard(id) {
      const card = this.cards.find((p) => p.id === id);
      if (!card || !String(card.prompt || "").trim()) { this._flash("这张卡片没有可翻译的英文 tag"); return; }
      this._flash(`正在重译：${String(card.prompt).slice(0, 28)}…`, 30000);
      try {
        const zh = await translateAuto(card.prompt);
        if (!zh || zh === card.prompt) { this._flash("翻译服务没有返回新的中文注释"); return; }
        card.notes = zh;
        card.updatedAt = Date.now();
        await this.putCard(card);
        this._renderCards();
        this._flash("单卡重译完成");
      } catch (e) {
        this._flash("单卡重译失败：" + (e.message || e), 5000);
      }
    }

    showBatchTranslateDialog() {
      const all = this.cards.filter((p) => String(p.prompt || "").trim());
      const missing = all.filter((p) => !String(p.notes || "").trim());
      if (!all.length) { this._flash("没有可翻译的卡片"); return; }
      const overlay = document.createElement("div");
      overlay.className = "tk-cards-overlay";
      overlay.innerHTML = `<div class="tk-cards-overlay-box tk-cards-batch-translate-box">
        <div class="tk-cards-overlay-head"><b>批量重译卡片</b><button type="button" class="tk-cards-btn" data-a="close">关闭</button></div>
        <div class="tk-cards-settings-note">重译会覆盖现有中文注释。可只处理还没有注释的卡片。</div>
        <label class="tk-cards-field"><span>处理范围</span><select data-f="scope"><option value="all">全部卡片（${all.length} 张，覆盖已有注释）</option><option value="missing">仅未翻译（${missing.length} 张）</option></select></label>
        <div class="tk-cards-ai-actions"><button type="button" class="tk-cards-btn" data-a="cancel">取消</button><button type="button" class="tk-cards-btn tk-cards-btn-main" data-a="start">开始重译</button></div>
      </div>`;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.querySelector('[data-a="close"]').addEventListener("click", close);
      overlay.querySelector('[data-a="cancel"]').addEventListener("click", close);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
      overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
      overlay.querySelector('[data-a="start"]').addEventListener("click", async () => {
        const scope = overlay.querySelector('[data-f="scope"]').value;
        close();
        await this.batchTranslate(scope);
      });
    }

    async batchTranslate(scope = "all") {
      const all = this.cards.filter((p) => String(p.prompt || "").trim());
      const todo = scope === "missing" ? all.filter((p) => !String(p.notes || "").trim()) : all;
      if (!todo.length) { this._flash("该范围没有可翻译的卡片"); return; }
      const total = todo.length;
      let cursor = 0, okN = 0, failN = 0;
      this._flash(`批量重译中：0 / ${total}（DeepLX → DashScope 回退）`, 120000);
      const workers = Array.from({ length: 3 }, async () => {
        while (true) {
          const index = cursor++;
          if (index >= todo.length) return;
          const card = todo[index];
          try {
            const zh = await translateAuto(card.prompt);
            if (!zh || zh === card.prompt) { failN++; continue; }
            card.notes = zh;
            card.updatedAt = Date.now();
            await this.putCard(card);
            okN++;
            this._flash(`批量重译中：${okN + failN} / ${total}`, 120000);
          } catch (e) { failN++; }
        }
      });
      await Promise.all(workers);
      this._renderCards();
      this._flash(`批量重译完成：成功 ${okN} / ${total}${failN ? `，失败或无新译文 ${failN}` : ""}`);
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
        this.w.prompt_pieces = w("prompt_pieces") || this._ensurePromptPiecesWidget();
        this._hideNativeWidget(this.w.prompt_pieces);
        this._initUI();
        if (this._promptPiecesRestorePending) this.restorePromptPieces();
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
      this.libResizeEl = document.createElement("div");
      this.libResizeEl.className = "tk-cards-resize-handle";
      this.libResizeEl.setAttribute("role", "separator");
      this.libResizeEl.setAttribute("aria-orientation", "horizontal");
      this.libResizeEl.setAttribute("aria-valuemin", String(LIB_HEIGHT_MIN));
      this.libResizeEl.setAttribute("aria-valuemax", String(LIB_HEIGHT_MAX));
      this.libResizeEl.tabIndex = 0;
      this.libResizeEl.title = "拖动调整工具箱 prompt 库高度；高度会自动保存";
      this.libResizeEl.innerHTML = "<span>⋮⋮</span><small>拖动调整高度</small>";
      this._bindLibResize(this.libResizeEl);
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
      libBody.appendChild(this.libResizeEl);
      libBody.appendChild(this.fileSel);
      libBody.appendChild(this.groupListEl);
      this._applyLibHeight(this.uiState.libHeight, false);
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
      const draftBtn = document.createElement("button");
      draftBtn.type = "button"; draftBtn.className = "tk-cards-btn"; draftBtn.textContent = "恢复草稿";
      draftBtn.title = "恢复草稿（切组/切库前自动暂存）";
      draftBtn.addEventListener("click", () => this.restoreDraft());
      const clearBtn = document.createElement("button");
      clearBtn.type = "button"; clearBtn.className = "tk-cards-btn"; clearBtn.textContent = "清空";
      clearBtn.title = "清空当前提示词";
      clearBtn.addEventListener("click", () => { this._setPromptText(""); this._hideResolve(); });
      const savePromptBtn = document.createElement("button");
      savePromptBtn.type = "button"; savePromptBtn.className = "tk-cards-btn"; savePromptBtn.textContent = "存入 prompt 库";
      savePromptBtn.title = "把当前整段提示词存入工具箱 prompt 库，不拆成③区小卡片";
      savePromptBtn.addEventListener("click", () => this.saveCurrentAsPrompt());
      const cardsAddBtn = document.createElement("button");
      cardsAddBtn.type = "button"; cardsAddBtn.className = "tk-cards-btn tk-cards-btn-main"; cardsAddBtn.textContent = "智能入卡";
      cardsAddBtn.title = "当前所有片段交 LLM 自动判定分类 → 确认清单（可改判）→ 分类入库";
      cardsAddBtn.addEventListener("click", () => this.cardsAddAll());
      curBtns.appendChild(clipboardBtn); curBtns.appendChild(draftBtn); curBtns.appendChild(clearBtn); curBtns.appendChild(savePromptBtn); curBtns.appendChild(cardsAddBtn);
      curHead.appendChild(curBtns);
      this.curTextEl = document.createElement("textarea");
      this.curTextEl.className = "tk-cards-textarea";
      this.curTextEl.placeholder = "当前提示词（点库条目/卡片/粘贴/拖入 PNG 填充；输入时卡片库联想补全）";
      this._restorePromptPiecesFromWidget();
      const widgetText = String(this.w.positive?.value || "");
      const draftText = loadDraft();
      const restoredText = Array.isArray(this.promptPieces)
        ? serializePromptPieces(this.promptPieces.filter((piece) => !piece.hidden))
        : "";
      const initialText = widgetText.trim() ? widgetText : (restoredText || draftText);
      if (initialText !== widgetText) {
        if (restoredText && initialText === restoredText) this._setW(this.w.positive, initialText);
        else this._setPromptText(initialText, { render: false });
      }
      this.curTextEl.value = initialText;
      this.curTextEl.addEventListener("input", () => this.onCurInput());
      this.curTextEl.addEventListener("keydown", (e) => this._suggestKeyDown(e));
      const curEditor = document.createElement("div");
      curEditor.className = "tk-cards-current-editor";
      this.pngDropEl = document.createElement("div");
      this.pngDropEl.className = "tk-cards-png-drop";
      this.pngDropEl.innerHTML = `<span>PNG</span><button type="button" class="tk-cards-btn" data-a="choose-png">选择 PNG</button>`;
      this.pngDropEl.querySelector('[data-a="choose-png"]').addEventListener("click", () => this.showPngDialog());
      this.pngDropEl.addEventListener("dragover", (ev) => { ev.preventDefault(); this.pngDropEl.classList.add("is-dragging"); });
      this.pngDropEl.addEventListener("dragleave", () => this.pngDropEl.classList.remove("is-dragging"));
      this.pngDropEl.addEventListener("drop", (ev) => {
        ev.preventDefault();
        this.pngDropEl.classList.remove("is-dragging");
        this.importPngFile(ev.dataTransfer?.files?.[0]);
      });
      curBtns.appendChild(this.pngDropEl);
      this.suggestEl = document.createElement("div");
      this.suggestEl.className = "tk-cards-suggest";
      this.suggestEl.style.display = "none";
      document.addEventListener("click", (e) => {
        if (this.suggestEl && this.suggestEl.style.display !== "none" &&
            !this.suggestEl.contains(e.target) && e.target !== this.curTextEl) {
          this._hideSuggest();
        }
        if (this.translateSuggestEl && this.translateSuggestEl.style.display !== "none" &&
            !this.translateSuggestEl.contains(e.target) && e.target !== this.translateInputEl) {
          this._hideTranslateSuggest();
        }
      });
      curEditor.appendChild(this.curTextEl);
      curEditor.appendChild(this.suggestEl);
      this.curTextResizeEl = document.createElement("div");
      this.curTextResizeEl.className = "tk-cards-resize-handle tk-cards-current-resize-handle";
      this.curTextResizeEl.setAttribute("role", "separator");
      this.curTextResizeEl.setAttribute("aria-orientation", "horizontal");
      this.curTextResizeEl.setAttribute("aria-valuemin", String(CUR_TEXT_HEIGHT_MIN));
      this.curTextResizeEl.setAttribute("aria-valuemax", String(CUR_TEXT_HEIGHT_MAX));
      this.curTextResizeEl.tabIndex = 0;
      this.curTextResizeEl.title = "拖动调整当前提示词框高度；高度会自动保存";
      this.curTextResizeEl.innerHTML = "<span>⋮⋮</span><small>拖动调整当前提示词框高度</small>";
      this._bindCurrentTextResize(this.curTextResizeEl);
      this._applyCurrentTextHeight(this.uiState.curTextHeight, false);
      const translateBox = document.createElement("details");
      translateBox.className = "tk-cards-translate-box";
      translateBox.open = this.uiState.collapsed.translate !== true;
      const translateHead = document.createElement("summary");
      translateHead.className = "tk-cards-translate-head";
      translateHead.innerHTML = `<b>中文翻译输入</b><span>选择候选后加入下方当前提示词，不会覆盖已有内容</span>`;
      translateBox.appendChild(translateHead);
      translateBox.addEventListener("toggle", () => {
        this.uiState.collapsed.translate = !translateBox.open;
        saveUiState(this.uiState);
        this._scheduleNodeResize();
      });
      this.translateInputEl = document.createElement("textarea");
      this.translateInputEl.className = "tk-cards-translate-input";
      this.translateInputEl.rows = 2;
      this.translateInputEl.placeholder = "输入中文短语，例如：白发，长发，蓝眼睛";
      this.translateInputEl.addEventListener("input", () => { this._hideResolve(); this._updateTranslateSuggest(); });
      this.translateInputEl.addEventListener("keydown", (event) => this._translateSuggestKeyDown(event));
      const translateSourceRow = document.createElement("div");
      translateSourceRow.className = "tk-cards-translate-source";
      const translateSourceLabel = document.createElement("span");
      translateSourceLabel.textContent = "翻译源";
      this.translateSourceEl = document.createElement("select");
      this.translateSourceEl.className = "tk-cards-select";
      this.translateSourceEl.innerHTML = TRANSLATE_SOURCES.map(([id, label]) => `<option value="${escAttr(id)}">${esc(label)}</option>`).join("");
      this.translateSourceEl.value = loadTranslateSource();
      this.translateSourceEl.title = "手动选择中文翻译源；自动回退会按可用服务依次尝试";
      this.translateSourceEl.addEventListener("change", () => { saveTranslateSource(this.translateSourceEl.value); this._refreshTranslationStatus(); });
      translateSourceRow.appendChild(translateSourceLabel);
      translateSourceRow.appendChild(this.translateSourceEl);
      this.translateStatusEl = document.createElement("div");
      this.translateStatusEl.className = "tk-cards-translate-status";
      const translateStatusDetails = document.createElement("details");
      translateStatusDetails.className = "tk-cards-translate-status-details";
      const translateStatusSummary = document.createElement("summary");
      translateStatusSummary.textContent = "翻译状态（点击展开）";
      translateStatusDetails.appendChild(translateStatusSummary);
      translateStatusDetails.appendChild(this.translateStatusEl);
      this.translateStatusDetails = translateStatusDetails;
      this.translateStatusSummary = translateStatusSummary;
      const translateBtn = document.createElement("button");
      translateBtn.type = "button";
      translateBtn.className = "tk-cards-btn tk-cards-btn-main";
      translateBtn.textContent = "翻译并校准";
      translateBtn.title = "把独立中文输入翻译成英文，并查找 Danbooru 规范标签候选";
      translateBtn.addEventListener("click", () => this.translatePiecesOnly());
      const translateOnlyBtn = document.createElement("button");
      translateOnlyBtn.type = "button";
      translateOnlyBtn.className = "tk-cards-btn";
      translateOnlyBtn.textContent = "仅翻译";
      translateOnlyBtn.title = "只翻译为英文并进行基础 QA，不调用 BGE-M3 或 Danbooru 校准";
      translateOnlyBtn.addEventListener("click", () => this.translateOnly());
      const translateActions = document.createElement("div");
      translateActions.className = "tk-cards-translate-actions";
      translateActions.appendChild(translateOnlyBtn);
      translateActions.appendChild(translateBtn);
      const translateInputRow = document.createElement("div");
      translateInputRow.className = "tk-cards-translate-input-row";
      const translateInputWrap = document.createElement("div");
      translateInputWrap.className = "tk-cards-translate-input-wrap";
      translateInputWrap.appendChild(this.translateInputEl);
      this.translateSuggestEl = document.createElement("div");
      this.translateSuggestEl.className = "tk-cards-suggest tk-cards-translate-suggest";
      this.translateSuggestEl.style.display = "none";
      translateInputWrap.appendChild(this.translateSuggestEl);
      translateInputRow.appendChild(translateInputWrap);
      translateInputRow.appendChild(translateActions);
      translateBox.appendChild(translateSourceRow);
      translateBox.appendChild(translateStatusDetails);
      translateBox.appendChild(translateInputRow);
      this.resolveEl = document.createElement("div");
      this.resolveEl.className = "tk-cards-resolve";
      this.resolveEl.style.display = "none";
      const chipsTools = document.createElement("div");
      chipsTools.className = "tk-cards-cur-chips-tools";
      const translateAllBtn = document.createElement("button");
      translateAllBtn.type = "button";
      translateAllBtn.className = "tk-cards-btn";
      translateAllBtn.textContent = "翻译未翻译片段";
      translateAllBtn.title = "只翻译当前提示词中没有中文注释或快捷译文的片段，避免污染已翻译卡片";
      translateAllBtn.addEventListener("click", () => this.translateAllPieces());
      chipsTools.appendChild(translateAllBtn);
      this.chipsEl = document.createElement("div");
      this.chipsEl.className = "tk-cards-chips";
      this.chipsResizeEl = document.createElement("div");
      this.chipsResizeEl.className = "tk-cards-resize-handle tk-cards-chips-resize-handle";
      this.chipsResizeEl.setAttribute("role", "separator");
      this.chipsResizeEl.setAttribute("aria-orientation", "horizontal");
      this.chipsResizeEl.setAttribute("aria-valuemin", String(CHIPS_HEIGHT_MIN));
      this.chipsResizeEl.setAttribute("aria-valuemax", String(CHIPS_HEIGHT_MAX));
      this.chipsResizeEl.setAttribute("aria-valuenow", String(this.uiState.chipsHeight));
      this.chipsResizeEl.tabIndex = 0;
      this.chipsResizeEl.title = "拖动调整 2 区双语卡片显示高度；高度会自动保存";
      this.chipsResizeEl.innerHTML = "<span>⋮⋮</span><small>拖动调整双语卡片显示高度</small>";
      this._bindChipsResize(this.chipsResizeEl);
      this._applyChipsHeight(this.uiState.chipsHeight, false);
      curBody.appendChild(curEditor);
      curBody.appendChild(this.curTextResizeEl);
      curBody.appendChild(translateBox);
      curBody.appendChild(this.resolveEl);
      curBody.appendChild(chipsTools);
      curBody.appendChild(this.chipsEl);
      curBody.appendChild(this.chipsResizeEl);
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
      tlBtn.type = "button"; tlBtn.className = "tk-cards-btn"; tlBtn.textContent = "批量重译";
      tlBtn.title = "选择范围并批量重新翻译卡片中文注释";
      tlBtn.addEventListener("click", () => this.showBatchTranslateDialog());
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
      this._applyCardGridHeight(this.uiState.cardGridHeight, false);
      this.cardGridResizeEl = document.createElement("div");
      this.cardGridResizeEl.className = "tk-cards-resize-handle tk-cards-card-grid-resize-handle";
      this.cardGridResizeEl.setAttribute("role", "separator");
      this.cardGridResizeEl.setAttribute("aria-orientation", "horizontal");
      this.cardGridResizeEl.setAttribute("aria-valuemin", String(CARD_GRID_HEIGHT_MIN));
      this.cardGridResizeEl.setAttribute("aria-valuemax", String(CARD_GRID_HEIGHT_MAX));
      this.cardGridResizeEl.setAttribute("aria-valuenow", String(this.uiState.cardGridHeight));
      this.cardGridResizeEl.tabIndex = 0;
      this.cardGridResizeEl.title = "拖动调整双语卡片显示区域高度；高度会自动保存";
      this.cardGridResizeEl.innerHTML = "<span>⋮⋮</span><small>拖动调整卡片区域高度</small>";
      this._bindCardGridResize(this.cardGridResizeEl);
      this.cardSearchEl = document.createElement("input");
      this.cardSearchEl.type = "search";
      this.cardSearchEl.className = "tk-cards-card-search";
      this.cardSearchEl.placeholder = "搜索卡片英文或中文译文，支持模糊匹配…";
      this.cardSearchEl.setAttribute("aria-label", "搜索双语卡片");
      this.cardSearchEl.addEventListener("input", () => {
        this.cardSearch = this.cardSearchEl.value.trim();
        this._updateCardSearch();
      });
      cardBody.appendChild(this.cardSearchEl);
      cardBody.appendChild(this.catTabsEl);
      cardBody.appendChild(this.cardGridEl);
      cardBody.appendChild(this.cardGridResizeEl);
      container.appendChild(cardSec);

      // 初始
      this._renderChips();
      this._renderCatTabs();
      this._renderCards();
      this._renderLibList();
      window.addEventListener("anima-prompt-cards-updated", this._onExternalCardsUpdated);
      this.reloadAll();
      this._loadBatchFiles();
      this._switchLibPane(this.uiState.pane || "lib");
      if (this.w.positive?.value) this._renderChips();
      this._refreshTranslationStatus();
    }

    _switchLibPane(which) {
      const lib = which === "lib";
      this.uiState.pane = lib ? "lib" : "batch";
      saveUiState(this.uiState);
      this.libCatSel.style.display = lib ? "" : "none";
      this.libSearchEl.style.display = lib ? "" : "none";
      this.libListEl.style.display = lib ? "" : "none";
      if (this.libResizeEl) this.libResizeEl.style.display = lib ? "" : "none";
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
 .tk-cards-sec-body { display:flex; min-height:0; flex-direction:column; gap:7px; padding:8px; }
 .tk-cards-sec-body[hidden] { display:none; }
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
 .tk-cards-lib-list { display:grid; grid-template-columns:repeat(2,minmax(120px,1fr)); gap:6px; height:240px; max-height:240px; overflow:auto; scrollbar-color:#626a70 #141618; scrollbar-width:auto; }
 .tk-cards-lib-list::-webkit-scrollbar, .tk-cards-grid::-webkit-scrollbar, .tk-cards-edit-form::-webkit-scrollbar { width:13px; height:13px; }
 .tk-cards-lib-list::-webkit-scrollbar-track, .tk-cards-grid::-webkit-scrollbar-track, .tk-cards-edit-form::-webkit-scrollbar-track { border-radius:7px; background:#141618; }
 .tk-cards-lib-list::-webkit-scrollbar-thumb, .tk-cards-grid::-webkit-scrollbar-thumb, .tk-cards-edit-form::-webkit-scrollbar-thumb { min-height:40px; border:3px solid #141618; border-radius:7px; background:#626a70; }
 .tk-cards-lib-list::-webkit-scrollbar-thumb:hover, .tk-cards-grid::-webkit-scrollbar-thumb:hover, .tk-cards-edit-form::-webkit-scrollbar-thumb:hover { background:#9b9a95; }
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
 .tk-cards-lib-bilingual { display:flex; flex-wrap:wrap; gap:3px; max-height:56px; overflow:auto; padding-top:3px; }
 .tk-cards-lib-bilingual-card { display:inline-flex; min-width:0; max-width:180px; flex-direction:column; gap:1px; padding:3px 5px; border:1px solid var(--tk-border-soft); border-radius:3px; background:#151719; }
 .tk-cards-lib-bilingual-card b { overflow:hidden; color:var(--tk-text); font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-lib-bilingual-card small { overflow:hidden; color:var(--tk-muted); font-size:8px; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-lib-tip { position:fixed; z-index:99999; max-width:260px; max-height:280px; overflow:auto; padding:7px; border:1px solid var(--tk-border); border-radius:5px; background:#1b1e20; box-shadow:0 8px 22px rgba(0,0,0,.45); color:var(--tk-text); font-size:11px; white-space:pre-wrap; pointer-events:none; }
.tk-cards-lib-tip img { display:block; max-width:230px; max-height:230px; border-radius:3px; }
.tk-cards-groups { max-height:150px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
.tk-cards-group { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:4px; }
 .tk-cards-group:hover { background:rgba(255,255,255,.05); }
.tk-cards-group-info { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:help; }
 .tk-cards-current-editor { position:relative; min-width:0; }
 .tk-cards-textarea { width:100%; min-height:82px; box-sizing:border-box; background:#141618; color:var(--tk-text); border:1px solid var(--tk-border); border-radius:4px; font-size:12px; padding:7px 8px; resize:none; }
 .tk-cards-translate-box { display:block; padding:0; border:1px solid var(--tk-border-soft); border-radius:5px; background:#17191b; }
 .tk-cards-translate-box > summary { display:flex; align-items:baseline; justify-content:space-between; gap:8px; padding:7px; cursor:pointer; list-style:none; }
 .tk-cards-translate-box > summary::-webkit-details-marker { display:none; }
 .tk-cards-translate-box > summary::before { content:"▸"; flex:0 0 auto; margin-right:2px; color:var(--tk-muted); }
 .tk-cards-translate-box[open] > summary::before { content:"▾"; color:var(--tk-accent-strong); }
 .tk-cards-translate-box > summary:focus-visible { outline:2px solid var(--tk-accent); outline-offset:-2px; }
 .tk-cards-translate-box[open] > :not(summary) { margin-left:7px; margin-right:7px; }
 .tk-cards-translate-box[open] > .tk-cards-translate-input-row { margin-bottom:7px; }
 .tk-cards-translate-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
 .tk-cards-translate-head b { color:var(--tk-accent-strong); font-size:11px; }
 .tk-cards-translate-head span { color:var(--tk-muted); font-size:10px; }
 .tk-cards-translate-source { display:flex; align-items:center; gap:6px; }
 .tk-cards-translate-source > span { flex:0 0 auto; color:var(--tk-muted); font-size:10px; }
 .tk-cards-translate-source .tk-cards-select { width:auto; min-width:150px; min-height:27px; }
 .tk-cards-translate-status-details { border:1px solid var(--tk-border-soft); border-radius:4px; background:#141618; color:var(--tk-muted); font-size:9px; }
 .tk-cards-translate-status-details > summary { min-height:24px; box-sizing:border-box; padding:5px 7px; cursor:pointer; color:var(--tk-muted); user-select:none; }
 .tk-cards-translate-status-details[open] > summary { color:var(--tk-accent-strong); border-bottom:1px solid var(--tk-border-soft); }
 .tk-cards-translate-status-details > summary:focus-visible { outline:2px solid var(--tk-accent); outline-offset:-2px; }
 .tk-cards-translate-status { display:flex; flex-direction:column; gap:3px; padding:5px 6px; }
 .tk-cards-translate-actual { color:var(--tk-info); font-weight:600; }
 .tk-cards-translate-provider-list { display:flex; flex-wrap:wrap; gap:3px 9px; }
 .tk-cards-translate-provider-list span { white-space:nowrap; }
 .tk-cards-translate-status-actions { display:flex; }
 .tk-cards-translate-status { display:flex; align-items:center; flex-wrap:wrap; gap:3px 10px; padding:4px 6px; border:1px solid var(--tk-border-soft); border-radius:4px; background:#141618; color:var(--tk-muted); font-size:9px; }
 .tk-cards-translate-status .tk-cards-translate-status-actions { margin-left:auto; }
 .tk-cards-translate-provider-list span.is-ok b { color:var(--tk-info); }
 .tk-cards-cur-chips-tools { display:flex; gap:4px; }
 .tk-cards-chip-translation.is-error { color:var(--tk-warn); }
 .tk-cards-translate-input { width:100%; min-height:48px; box-sizing:border-box; resize:vertical; border:1px solid var(--tk-border); border-radius:4px; background:#141618; color:var(--tk-text); font-size:11px; line-height:1.45; padding:6px 8px; }
 .tk-cards-translate-input:focus { outline:none; border-color:var(--tk-accent); box-shadow:0 0 0 2px rgba(208,201,187,.12); }
 .tk-cards-translate-input-row { display:flex; align-items:stretch; gap:5px; min-width:0; }
 .tk-cards-translate-input-wrap { position:relative; flex:1 1 auto; min-width:0; }
 .tk-cards-translate-input-row .tk-cards-translate-input { display:block; width:100%; min-width:0; }
 .tk-cards-translate-actions { display:flex; flex:0 0 auto; flex-direction:column; justify-content:center; gap:4px; }
 .tk-cards-png-drop { display:inline-flex; align-items:center; gap:4px; min-height:26px; box-sizing:border-box; padding:2px 4px; border:1px dashed #555a5e; border-radius:4px; background:#141618; color:var(--tk-muted); font-size:9px; }
 .tk-cards-png-drop span { color:var(--tk-muted); font-size:9px; }
 .tk-cards-png-drop .tk-cards-btn { min-height:22px; padding:2px 6px; font-size:9px; }
 .tk-cards-png-drop.is-dragging { border-color:var(--tk-accent); background:#292d30; color:var(--tk-accent-strong); }
 .tk-cards-translate-suggest { top:calc(100% + 2px); max-height:180px; }
/* ②区卡片库联想下拉 */
 .tk-cards-suggest { position:absolute; top:calc(100% + 2px); left:0; right:0; z-index:80; max-height:min(320px,42vh); display:flex; flex-direction:column; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; scrollbar-color:#626a70 #141618; border:1px solid var(--tk-border); border-radius:5px; background:#1b1e20; box-shadow:0 8px 18px rgba(0,0,0,.45); }
 .tk-cards-suggest-item { display:block; padding:7px 9px; border-bottom:1px solid rgba(255,255,255,.07); font-size:11px; cursor:pointer; color:var(--tk-text); }
 .tk-cards-suggest-item:last-child { border-bottom:0; }
 .tk-cards-suggest-top { display:flex; align-items:baseline; gap:7px; min-width:0; }
 .tk-cards-suggest-item .s-en { min-width:0; flex:1 1 auto; overflow:hidden; color:var(--tk-accent-strong); font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-suggest-item .s-zh { min-width:0; max-width:48%; overflow:hidden; color:var(--tk-muted); text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-suggest-item .s-cat { flex:0 0 auto; overflow:hidden; max-width:38%; color:var(--tk-info); text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-suggest-item .s-desc { display:-webkit-box; max-height:44px; margin-top:3px; overflow:hidden; color:var(--tk-muted); font-size:10px; line-height:1.38; -webkit-box-orient:vertical; -webkit-line-clamp:3; white-space:normal; word-break:break-word; }
 .tk-cards-suggest-item:hover, .tk-cards-suggest-item.sel { background:rgba(94,106,210,.28); }
/* ②区中文翻译 + Danbooru 规范校准 */
 .tk-cards-resolve { display:flex; flex-direction:column; gap:6px; padding:7px; border:1px solid rgba(155,178,182,.55); border-radius:5px; background:#171b1d; }
 .tk-cards-resolve-head { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--tk-info); font-size:11px; }
 .tk-cards-resolve-head span { color:var(--tk-muted); font-size:10px; }
 .tk-cards-resolve-list { display:flex; flex-direction:column; gap:5px; max-height:300px; overflow:auto; padding-right:2px; }
 .tk-cards-resolve-row { display:flex; flex-direction:column; gap:4px; padding:6px; border:1px solid var(--tk-border-soft); border-radius:4px; background:#141618; }
 .tk-cards-resolve-source { display:flex; align-items:baseline; gap:8px; min-width:0; }
 .tk-cards-resolve-source b { color:var(--tk-text); font-size:11px; word-break:break-word; }
 .tk-cards-resolve-source span { min-width:0; color:var(--tk-muted); font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-resolve-translation-line { display:flex; align-items:center; gap:5px; min-width:0; }
 .tk-cards-resolve-translation { min-width:180px; flex:1 1 220px; min-height:25px; padding:4px 6px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-text); font-size:10px; }
 .tk-cards-resolve-translation:focus { outline:none; border-color:var(--tk-accent); }
 .tk-cards-resolve-provider { flex:0 0 auto; color:var(--tk-info) !important; font-size:9px !important; }
 .tk-cards-resolve-tags { display:flex; gap:4px; min-width:0; color:var(--tk-muted); font-size:10px; line-height:1.4; }
 .tk-cards-resolve-tags strong { min-width:0; color:var(--tk-accent-strong); font-weight:600; word-break:break-word; }
 .tk-cards-resolve-actions { display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
 .tk-cards-resolve-candidate-wrap { display:inline-flex; align-items:center; gap:2px; }
 .tk-cards-resolve-candidate { display:inline-flex; align-items:center; gap:5px; min-height:27px; padding:4px 7px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-text); cursor:pointer; font-size:10px; }
 .tk-cards-resolve-candidate:hover, .tk-cards-resolve-candidate:focus-visible { border-color:var(--tk-accent); background:#2b2f32; color:var(--tk-accent-strong); outline:none; }
 .tk-cards-resolve-candidate.is-verified { border-color:rgba(155,178,182,.7); }
 .tk-cards-resolve-candidate small { color:var(--tk-info); font-size:9px; }
 .tk-cards-resolve-fallback { min-height:27px; font-size:10px; }
 .tk-cards-resolve-save { min-height:25px; padding:3px 6px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-muted); cursor:pointer; font-size:9px; }
 .tk-cards-resolve-save:hover, .tk-cards-resolve-save:focus-visible { border-color:var(--tk-accent); color:var(--tk-accent-strong); outline:none; }
 .tk-cards-resolve-empty { color:var(--tk-muted); font-size:10px; }
 .tk-cards-resolve-semantic-hint { display:flex; align-items:center; gap:6px; flex-wrap:wrap; color:var(--tk-warn); font-size:10px; line-height:1.4; }
 .tk-cards-resolve-semantic-hint .tk-cards-btn { min-height:25px; padding:3px 7px; font-size:10px; }
.tk-cards-chips { display:flex; flex-wrap:wrap; align-content:flex-start; gap:4px; height:180px; min-height:0; max-height:180px; overflow:auto; }
.tk-cards-chip { position:relative; display:block; max-width:260px; min-width:150px; padding:4px 68px 4px 8px; border:1px solid #555a5e; border-radius:4px; background:#24282b; color:var(--tk-text); cursor:pointer; font-size:11px; overflow:hidden; }
 .tk-cards-chip:hover { border-color:var(--tk-accent); background:#303437; }
.tk-cards-chip.is-hidden { border-color:rgba(203,133,133,.7); background:rgba(203,133,133,.08); opacity:.72; }
.tk-cards-chip.is-hidden:hover { opacity:1; background:rgba(203,133,133,.14); }
.tk-cards-chip.is-hidden .tk-cards-chip-en { color:var(--tk-muted); text-decoration:line-through; text-decoration-color:rgba(203,133,133,.8); }
.tk-cards-chip-body { display:block; min-width:0; overflow:hidden; }
.tk-cards-chip-top { display:flex; align-items:center; gap:4px; min-width:0; }
.tk-cards-chip-en { min-width:0; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tk-cards-chip-zh { display:block; font-size:9px; color:var(--tk-muted); }
.tk-cards-chip-translation { display:block; color:var(--tk-info); font-size:9px; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tk-cards-chip-weight { display:inline-flex; align-items:center; gap:2px; flex:0 0 auto; padding:1px 2px; border:1px solid rgba(255,255,255,.08); border-radius:4px; background:rgba(0,0,0,.12); }
.tk-cards-chip-weight-step { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; padding:0; border:0; border-radius:3px; background:rgba(255,255,255,.06); color:var(--tk-muted); cursor:pointer; font-family:"Geist Mono","JetBrains Mono",monospace; font-size:11px; line-height:1; font-weight:600; user-select:none; -webkit-user-select:none; }
.tk-cards-chip-weight-step:hover { background:rgba(94,106,210,.24); color:var(--tk-text); }
.tk-cards-chip-weight-step:active { transform:scale(.92); background:rgba(94,106,210,.34); }
.tk-cards-chip-weight-val { box-sizing:border-box; width:30px; height:16px; padding:0; border:0; outline:0; background:transparent; color:var(--tk-text); text-align:center; font:9px "Geist Mono","JetBrains Mono",monospace; }
.tk-cards-chip-weight-val:focus { border-radius:2px; box-shadow:0 0 0 1px var(--tk-accent); }
.tk-cards-chip-translate { position:absolute; top:0; right:19px; bottom:0; display:none; padding:0 3px; border:0; background:transparent; color:var(--tk-info); font-size:10px; cursor:pointer; }
.tk-cards-chip:hover .tk-cards-chip-translate { display:block; }
.tk-cards-chip-translate:hover { color:var(--tk-accent-strong); }
.tk-cards-chip-toggle { position:absolute; top:0; right:36px; bottom:0; display:none; width:29px; padding:0 2px; border:0; background:transparent; color:var(--tk-danger); font-size:9px; cursor:pointer; }
.tk-cards-chip:hover .tk-cards-chip-toggle { display:inline-flex; align-items:center; justify-content:center; }
.tk-cards-chip-toggle:hover, .tk-cards-chip-toggle:focus-visible { color:#f1b3b3; background:rgba(203,133,133,.14); outline:none; }
.tk-cards-chip-x { position:absolute; top:0; right:0; bottom:0; display:none; background:transparent; border:none; color:#ff8a8a; font-size:9px; cursor:pointer; padding:0 3px; }
.tk-cards-chip:hover .tk-cards-chip-x { display:block; }
 .tk-cards-chip-x:hover { color:#ff5555; }
.tk-cards-chips-resize-handle { margin-top:2px; }
.tk-cards-cur-tools { display:flex; gap:4px; }
 .tk-cards-cats { display:flex; flex-wrap:wrap; gap:4px; padding-bottom:2px; }
 .tk-cards-cat { min-height:28px; padding:4px 9px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-muted); cursor:pointer; font-size:11px; }
 .tk-cards-cat:hover { border-color:var(--tk-accent); color:var(--tk-text); }
 .tk-cards-cat.on { border-color:var(--tk-accent); background:#34383b; color:var(--tk-accent-strong); font-weight:650; }
 .tk-cards-cat-add { border-style:dashed; color:var(--tk-muted); }
 .tk-cards-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); grid-auto-rows:minmax(112px,auto); gap:7px; height:300px; max-height:680px; overflow:auto; }
 .tk-cards-card { position:relative; min-height:112px; box-sizing:border-box; padding:32px 8px 8px; border:1px solid var(--tk-border-soft); border-radius:5px; cursor:pointer; background:#151719; display:flex; flex-direction:column; gap:4px; overflow:hidden; transition:border-color .15s ease,background .15s ease; }
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
 .tk-cards-card-grid-resize-handle { margin-top:2px; }
 .tk-cards-card-search { width:100%; min-height:28px; box-sizing:border-box; margin:0 0 5px; padding:5px 8px; border:1px solid var(--tk-border); border-radius:4px; background:#141618; color:var(--tk-text); font-size:11px; }
 .tk-cards-card-search:focus { outline:none; border-color:var(--tk-accent); box-shadow:0 0 0 2px rgba(208,201,187,.12); }
 .tk-cards-settings-form { display:flex; flex-direction:column; gap:8px; }
 .tk-cards-settings-api { display:flex; flex-direction:column; gap:8px; padding:8px; border:1px solid var(--tk-border-soft); border-radius:4px; background:#141618; }
 .tk-cards-settings-status { min-height:20px; padding:6px 8px; border:1px solid var(--tk-border-soft); border-radius:4px; background:#141618; color:var(--tk-muted); font-size:11px; }
 .tk-cards-settings-status.is-success { border-color:rgba(155,178,182,.7); color:#c2d7d9; }
 .tk-cards-settings-status.is-error { border-color:rgba(203,133,133,.7); color:#e2aaaa; }
 .tk-cards-settings-note, .tk-cards-category-note { color:var(--tk-muted); font-size:10px; line-height:1.5; }
 .tk-cards-batch-translate-box { width:min(480px,92vw); }
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
 .tk-cards-retranslate { min-height:22px; padding:2px 7px; border:1px solid var(--tk-border); border-radius:4px; background:#202326; color:var(--tk-info); cursor:pointer; font-size:10px; }
 .tk-cards-retranslate:hover, .tk-cards-retranslate:focus-visible { border-color:var(--tk-accent); background:#2b2f32; color:var(--tk-accent-strong); outline:none; }
 .tk-cards-w { color:var(--tk-accent); }
 .tk-cards-lora { color:var(--tk-info); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100px; }
.tk-cards-multi { color:#ffb86c; border:1px solid rgba(255,184,108,.4); border-radius:3px; padding:0 3px; }
 .tk-cards-edit-form { display:flex; min-height:0; flex:1 1 auto; flex-direction:column; gap:9px; overflow:auto; padding:1px 4px 2px 1px; }
 .tk-cards-field { display:flex; flex-direction:column; gap:3px; color:var(--tk-muted); font-size:10px; }
 .tk-cards-edit-form input, .tk-cards-edit-form textarea, .tk-cards-edit-form select { min-height:30px; width:100%; box-sizing:border-box; border:1px solid var(--tk-border); border-radius:5px; background:#141618; color:var(--tk-text); font-size:11px; padding:6px 8px; }
 .tk-cards-edit-form textarea { min-height:72px; resize:vertical; line-height:1.45; }
 .tk-cards-edit-form input:focus, .tk-cards-edit-form textarea:focus, .tk-cards-edit-form select:focus { outline:none; border-color:var(--tk-accent); box-shadow:0 0 0 2px rgba(208,201,187,.12); }
 .tk-cards-edit-two-col { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
 .tk-cards-edit-image-field { display:flex; flex:0 0 auto; min-width:0; flex-direction:column; gap:4px; color:var(--tk-muted); font-size:10px; }
 .tk-cards-edit-image-label { color:var(--tk-muted); }
 .tk-cards-edit-image-drop { position:relative; display:flex; min-height:150px; max-height:220px; align-items:center; justify-content:center; overflow:hidden; border:1px dashed var(--tk-border); border-radius:6px; background:#141618; color:var(--tk-muted); cursor:pointer; transition:border-color .15s ease,background .15s ease; }
 .tk-cards-edit-image-drop:hover, .tk-cards-edit-image-drop:focus-visible, .tk-cards-edit-image-drop.is-dragging { outline:none; border-color:var(--tk-accent); background:#1d2022; }
 .tk-cards-edit-image-drop img { display:block; width:100%; height:180px; object-fit:contain; }
 .tk-cards-edit-image-drop img[hidden] { display:none; }
 .tk-cards-edit-image-drop.has-image .tk-cards-edit-image-placeholder { display:none; }
 .tk-cards-edit-image-placeholder { display:flex; flex-direction:column; align-items:center; gap:5px; color:var(--tk-muted); }
 .tk-cards-edit-image-placeholder small { color:#777d80; font-size:10px; }
 .tk-cards-edit-image-meta { display:flex; min-width:0; align-items:center; justify-content:space-between; gap:8px; }
 .tk-cards-edit-image-meta > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
 .tk-cards-edit-image-meta .tk-cards-btn { flex:0 0 auto; }
 .tk-cards-edit-btns { display:flex; flex:0 0 auto; gap:6px; justify-content:flex-end; padding-top:9px; border-top:1px solid var(--tk-border-soft); background:#181a1c; }
 .tk-cards-empty { padding:8px 3px; color:var(--tk-muted); font-size:11px; }
 .tk-cards-overlay { --tk-bg:#111315; --tk-surface:#17191b; --tk-surface-2:#1d2023; --tk-border:#34383c; --tk-border-soft:#272b2e; --tk-text:#e7e4de; --tk-muted:#9b9a95; --tk-accent:#d0c9bb; --tk-accent-strong:#f0ece4; --tk-warn:#c6a76a; --tk-info:#9bb2b6; --tk-danger:#cb8585; position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(0,0,0,.66); backdrop-filter:blur(3px); }
 .tk-cards-overlay-box { width:min(600px,92vw); max-height:82vh; min-height:0; box-sizing:border-box; padding:14px; display:flex; flex-direction:column; gap:10px; border:1px solid var(--tk-border); border-radius:8px; background:linear-gradient(180deg,#1d2023,#181a1c); box-shadow:0 0 0 1px rgba(255,255,255,.035),0 16px 42px rgba(0,0,0,.54),0 0 32px rgba(208,201,187,.05); }
 .tk-cards-edit-modal { width:min(680px,92vw); max-height:86vh; overflow:hidden; }
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
 .tk-cards-resize-handle { display:flex; height:17px; align-items:center; justify-content:center; gap:6px; border-top:1px solid var(--tk-border-soft); color:var(--tk-muted); cursor:ns-resize; user-select:none; touch-action:none; }
 .tk-cards-resize-handle span { font-size:12px; letter-spacing:2px; line-height:1; transform:rotate(90deg); }
 .tk-cards-resize-handle small { opacity:0; font-size:9px; transition:opacity .15s ease; }
 .tk-cards-resize-handle:hover, .tk-cards-resize-handle.is-dragging { color:var(--tk-accent-strong); border-color:var(--tk-accent); }
 .tk-cards-resize-handle:hover small, .tk-cards-resize-handle.is-dragging small { opacity:1; }
 .tk-cards-resize-handle:focus-visible { outline:2px solid var(--tk-accent); outline-offset:-2px; }
 @media (max-width:520px) { .tk-cards-sec-head-main { align-items:flex-start; } .tk-cards-sec-btns { justify-content:flex-start; } .tk-cards-lib-list { grid-template-columns:1fr; } .tk-cards-grid { grid-template-columns:1fr; } .tk-cards-catpick-list { grid-template-columns:1fr; } .tk-cards-category-row, .tk-cards-category-new { grid-template-columns:1fr; } .tk-cards-category-row-actions { justify-content:flex-end; } .tk-cards-ai-row { align-items:stretch; flex-wrap:wrap; } .tk-cards-ai-cat { flex:1 1 150px; } .tk-cards-edit-two-col { grid-template-columns:1fr; } .tk-cards-resolve-source { align-items:flex-start; flex-direction:column; gap:2px; } .tk-cards-resolve-head, .tk-cards-translate-head { align-items:flex-start; flex-direction:column; gap:2px; } .tk-cards-translate-source { align-items:flex-start; flex-direction:column; } .tk-cards-translate-source .tk-cards-select { width:100%; } .tk-cards-translate-input-row { flex-direction:column; } .tk-cards-translate-actions { flex-direction:row; justify-content:flex-end; } .tk-cards-resolve-translation-line { width:100%; } .tk-cards-resolve-translation { min-width:0; width:100%; } }
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
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
          const r = typeof origConfigure === "function" ? origConfigure.apply(this, arguments) : undefined;
          if (this._cardsUI) this._cardsUI.restorePromptPieces();
          return r;
        };
        nodeType.prototype.onNodeCreated = function () {
          const r = orig?.apply(this, arguments);
          if (this._cardsUI) return r;
          const w = (n) => this.widgets?.find((x) => x.name === n);
          const ui = new CardsUI(this, {
            positive: w("positive"),
            opt_text: w("opt_text"),
            lora_syntax: w("lora_syntax"),
            prompt_pieces: w("prompt_pieces"),
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
            prompt_pieces: w("prompt_pieces"),
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
        window.__tkCardsDebug.appendPromptBlock = appendPromptBlock;
      },
    });
  }

  injectStyle();
  init();
})();
