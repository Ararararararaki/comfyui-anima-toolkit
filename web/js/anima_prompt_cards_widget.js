// TK Prompt Cards 节点前端 —— 卡片库提示词编辑器
//
// 三区布局（单面板）：
//   ① 本地 prompt 库区：批文件 → 组列表；点击组 = 仅替换当前提示词（不自动入队）+ 组内翻页
//   ② 当前提示词区：textarea（绑定 positive widget，随工作流持久化）+ 逗号拆分卡片流
//      （逐卡删除 / 存为卡片）+ 草稿（切换前自动暂存 + 恢复）+ 剪切板导入
//   ③ 卡片库区：分类页签 + 卡片 grid；点击追加（智能去重）；双击就地编辑；
//      星标置顶；软删除撤销；批量补翻；浏览 LoRA 存触发词卡；导出为批文件；PNG 元数据解析
//
// 后端：/anima/cards（CRUD） /anima/cards/export /anima/cards/image
//       /anima/cards/lora-triggers /anima/loras /anima/prompt/list|parse /api/translate
//
// 2026-08-17 新建。

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
    const r = await apiFetch(path, opts);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  function postJson(path, body) {
    return fetchJson(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ── 插件目录（用于拼接 /extensions/ 前缀，透明）──
  function pluginBase() {
    try {
      const scripts = document.querySelectorAll("script[src*='anima_prompt_cards_widget']");
      const m = scripts[scripts.length - 1]?.src?.match(/\/extensions\/([^/]+)\/js\//);
      if (m) return m[1];
    } catch (e) { /* 忽略 */ }
    return "ComfyUI-Anima-Batch-LoRA";
  }

  // ── 文本工具 ──

  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  // 拆分提示词 → 卡片片段列表（[{text, weight}]）
  // 优先级：换行 > 中文顿号/逗号/分号 > 英文逗号兜底；
  // 含英文逗号且长度 > 60 的片段视为整句不拆（避免误拆长句，如 CG 场景描写）。
  function splitTags(text) {
    const out = [];
    for (let rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      // 先按中文分隔符切（顿号/中文逗号/分号 —— 中文分隔符是明确的分组边界）
      const cnParts = line.split(/[、，;；]/).map((s) => s.trim()).filter(Boolean);
      for (let part of cnParts) {
        // 长句（含英文逗号且长度 > 60）→ 整段保留，不拆英文逗号
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

  // 双向语言检测：CJK 占比 > 30% → 视为中文为主
  function langOf(text) {
    const t = String(text || "");
    if (!t) return "en";
    let cjk = 0;
    for (const ch of t) if (CJK_RE.test(ch)) cjk++;
    return cjk / t.length > 0.3 ? "zh" : "en";
  }

  // 翻译（双向）：中文为主 → 译成英文；英文为主 → 补中文注释
  async function translateAuto(text, { langpair } = {}) {
    const q = String(text || "").trim().slice(0, 2000);
    if (!q) return "";
    const l = langpair || (langOf(q) === "zh" ? "auto|en" : "en|zh-CN");
    const r = await fetchJson("/api/translate?q=" + encodeURIComponent(q) + "&langpair=" + encodeURIComponent(l));
    if (r.ok && r.translatedText) return r.translatedText;
    if (r.error) throw new Error(r.error);
    return "";
  }

  // 卡片 → 提示词片段（带权重）
  function cardToText(c) {
    if (!c) return "";
    const en = String(c.en || "").trim();
    if (!en) return "";
    const w = String(c.weight || "").trim();
    return w ? `(${en}:${w})` : en;
  }

  // 追加去重：现有文本片段集合（忽略权重）
  function appendCardToPrompt(cur, c, sep = ", ") {
    const piece = cardToText(c);
    if (!piece) return cur;
    const analyst = splitTags(cur).map((p) => p.text.toLowerCase().trim());
    const base = (c.en || "").toLowerCase().trim();
    if (analyst.includes(base)) return cur; // 智能去重
    const curT = String(cur || "").replace(/[,\s]+$/, "");
    return curT ? curT + sep + piece : piece;
  }

  // 移除一个片段（按文本内容精确匹配首个）
  function removePiece(cur, piece) {
    const target = (piece.text || "").trim();
    const parts = splitTags(cur);
    const keep = [];
    let removed = false;
    for (const p of parts) {
      if (!removed && p.text.trim() === target) { removed = true; continue; }
      keep.push(p);
    }
    if (!removed) return cur; // 没拆出来（整句）→ 原样返回
    return keep.map((p) => p.weight ? `(${p.text}:${p.weight})` : p.text).join(", ");
  }

  // ── 卡片库 CRUD 辅助 ──
  // 库结构 {categories: [..], cards: {cat: [{en,zh,weight,star,lora,src,ts,multi}]}}

  function blankLib() {
    const cats = ["角色", "服饰", "姿势", "场景", "画风", "质量词", "LoRA 触发词"];
    const cards = {};
    for (const c of cats) cards[c] = [];
    return { categories: cats, cards };
  }

  // ── 草稿（切换前自动暂存）──
  const DRAFT_KEY = "anima_tk_cards_draft_v1";
  function saveDraft(text) {
    try { localStorage.setItem(DRAFT_KEY, String(text || "")); } catch (e) { /* 忽略 */ }
  }
  function loadDraft() {
    try { return localStorage.getItem(DRAFT_KEY) || ""; } catch (e) { return ""; }
  }

  // ── UI ──

  class CardsUI {
    constructor(node, w) {
      this.node = node;
      this.w = w; // {positive, opt_text, lora_syntax}
      this.lib = blankLib();
      this.files = [];        // [{path, mtime}]
      this.groupsByFile = new Map(); // path -> [{name, count, prompts}]
      this.curFile = "";
      this.curGroup = null;   // {file, name, prompts}
      this.curIdx = 0;
      this.deleted = new Map(); // cardKey -> {cat, idx, card, timer}
      this._saveTimer = null;
      this._draftSaved = true;
      this.rootEl = null;
      this.fileSel = null;
      this.groupListEl = null;
      this.curTextEl = null;   // textarea
      this.chipsEl = null;     // 拆分卡片流
      this.pagerEl = null;
      this.catTabsEl = null;
      this.cardGridEl = null;
      this.statusEl = null;
      this.draftBtn = null;
      this.activeCat = "";
    }

    _setW(widget, value) {
      if (!widget) return;
      widget.value = value;
      if (typeof widget.callback === "function") { try { widget.callback(value) } catch {} }
    }

    curText() { return this.w.positive?.value || ""; }

    // ── 卡片库持久化（防抖）──
    scheduleSave() {
      if (this._saveTimer) clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.persist(), 500);
    }
    async persist() {
      try {
        await postJson("/anima/cards", this.lib);
      } catch (e) {
        console.error("[TK Prompt Cards] 卡片库保存失败:", e);
      }
    }

    async _loadLib() {
      try {
        const d = await fetchJson("/anima/cards");
        if (d && Array.isArray(d.categories) && d.cards) {
          this.lib = { categories: d.categories, cards: d.cards };
          if (!this.activeCat || !this.lib.categories.includes(this.activeCat)) {
            this.activeCat = this.lib.categories[0] || "";
          }
        }
      } catch (e) {
        console.error("[TK Prompt Cards] 卡片库加载失败:", e);
        this.lib = blankLib();
      }
      this._renderCatTabs();
      this._renderCards();
    }

    // ── ① 本地 prompt 库浏览 ──
    async _loadFiles() {
      if (!this.fileSel) return;
      try {
        const j = await fetchJson("/anima/prompt/list?recursive=1" + (this._extraDirs() ? "&extra=" + encodeURIComponent(JSON.stringify(this._extraDirs())) : ""));
        this.files = (j.files || []).map((f) => ({ path: f.name || f.path || f, mtime: f.mtime || 0 }));
      } catch (e) {
        this.files = [];
      }
      this._renderFileSel();
      if (this.files.length === 1) this.selectFile(this.files[0].path);
    }

    _extraDirs() {
      try {
        return (this.w.extra_dirs?.value || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } catch (e) { return []; }
    }

    _renderFileSel() {
      if (!this.fileSel) return;
      const cur = this.curFile;
      this.fileSel.innerHTML = `<option value="">（选择提示词批文件…）</option>` +
        this.files.map((f) => `<option value="${escAttr(f.path)}" ${f.path === cur ? "selected" : ""}>${esc(f.path)}</option>`).join("");
    }

    // 选中文件 → 解析分组
    async selectFile(path) {
      this.curFile = path;
      this._renderFileSel();
      this.groupsByFile.clear();
      this.curGroup = null;
      if (!path) { this._renderGroups(); return; }
      try {
        const j = await fetchJson("/anima/prompt/parse?path=" + encodeURIComponent(path));
        const groups = (j.groups || []).map((g) => ({ name: g.name, count: g.count, prompts: g.prompts || [] }));
        this.groupsByFile.set(path, groups);
      } catch (e) {
        console.error("[TK Prompt Cards] 组解析失败:", e);
      }
      this._renderGroups();
    }

    _renderGroups() {
      if (!this.groupListEl) return;
      const groups = this.groupsByFile.get(this.curFile) || [];
      this.groupListEl.innerHTML = "";
      if (!groups.length) {
        this.groupListEl.innerHTML = `<div class="tk-cards-empty">${this.curFile ? "该文件没有分组" : "选择文件后显示分组"}</div>`;
        return;
      }
      for (const g of groups) {
        const row = document.createElement("div");
        row.className = "tk-cards-group" + (this.curGroup?.name === g.name && this.curGroup?.file === this.curFile ? " on" : "");
        const info = document.createElement("span");
        info.className = "tk-cards-group-info";
        info.textContent = `${g.name} · ${g.count}条`;
        info.title = (g.prompts[0] || "").slice(0, 200);
        const go = document.createElement("button");
        go.type = "button";
        go.className = "tk-cards-btn";
        go.textContent = "切换";
        go.title = "仅替换当前提示词（不自动入队）";
        go.addEventListener("click", () => this.applyGroup(this.curFile, g.name));
        // 悬浮预览
        let previewTimer = null;
        row.addEventListener("mouseenter", () => {
          if (!g.prompts.length) return;
          previewTimer = setTimeout(() => {
            const tip = document.createElement("div");
            tip.className = "tk-cards-preview";
            tip.textContent = g.prompts[0].slice(0, 300) + (g.prompts[0].length > 300 ? "…" : "");
            row.appendChild(tip);
            setTimeout(() => { try { tip.remove(); } catch (e) {} }, 2500);
          }, 400);
        });
        row.addEventListener("mouseleave", () => { if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; } });
        row.appendChild(info);
        row.appendChild(go);
        this.groupListEl.appendChild(row);
      }
    }

    // 一键切换：暂存草稿 → 填充组内第 curIdx 条 → 拆卡渲染
    applyGroup(file, name) {
      const groups = this.groupsByFile.get(file) || [];
      const g = groups.find((x) => x.name === name);
      if (!g || !g.prompts.length) return;
      this._stashDraft();
      this.curGroup = { file, name, prompts: g.prompts, count: g.count };
      this.curIdx = 0;
      this._fillCur(g.prompts[0]);
      this._renderGroups();
    }

    _fillCur(text) {
      this._setW(this.w.positive, text || "");
      if (this.curTextEl && this.curTextEl.value !== (text || "")) this.curTextEl.value = text || "";
      this._renderChips();
      this._renderPager();
    }

    _renderPager() {
      if (!this.pagerEl) return;
      const g = this.curGroup;
      if (!g || g.prompts.length <= 1) { this.pagerEl.style.display = "none"; return; }
      this.pagerEl.style.display = "";
      this.pagerEl.innerHTML = `组内 ${this.curIdx + 1}/${g.prompts.length} ` +
        `<button type="button" class="tk-cards-btn" ${this.curIdx <= 0 ? "disabled" : ""} data-p="prev">上一条</button>` +
        `<button type="button" class="tk-cards-btn" ${this.curIdx >= g.prompts.length - 1 ? "disabled" : ""} data-p="next">下一条</button>`;
      this.pagerEl.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          if (b.disabled) return;
          this.curIdx += b.getAttribute("data-p") === "prev" ? -1 : 1;
          this._fillCur(g.prompts[this.curIdx]);
        });
      });
    }

    // ── ② 当前提示词区 ──
    // 文本输入（textarea 手动编辑时同步 widget）
    onCurInput() {
      const v = this.curTextEl.value;
      this._setW(this.w.positive, v);
      this._renderChips();
      this._renderPager();
    }

    // 拆分渲染（chips）
    _renderChips() {
      if (!this.chipsEl) return;
      const text = this.curText();
      const parts = splitTags(text);
      this.chipsEl.innerHTML = "";
      if (!parts.length) {
        this.chipsEl.innerHTML = `<div class="tk-cards-empty">输入提示词后自动按逗号分组（点击片段可移除 / 存为卡片）</div>`;
        return;
      }
      for (const p of parts) {
        const chip = document.createElement("span");
        chip.className = "tk-cards-chip";
        chip.title = "点击存为卡片；右键删除该片段";
        chip.textContent = p.weight ? `(${p.text}:${p.weight})` : p.text;
        chip.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.savePieceAsCard(p);
        });
        chip.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          this._setW(this.w.positive, removePiece(this.curText(), p));
          if (this.curTextEl) this.curTextEl.value = this.curText();
          this._renderChips();
        });
        this.chipsEl.appendChild(chip);
      }
    }

    // 存为卡片（自动翻译）
    async savePieceAsCard(p, cat) {
      const target = cat || this.activeCat || "角色";
      const en = (p.text || "").trim();
      if (!en) return;
      let zh = "";
      try {
        zh = await translateAuto(en);
      } catch (e) {
        zh = "";
      }
      this.addCard(target, { en, zh, weight: p.weight || "", src: "piece" });
    }

    // 存整个当前提示词为组合卡
    async saveCurrentAsCard(cat) {
      const text = this.curText().trim();
      if (!text) { this._flash("当前提示词为空"); return; }
      const target = cat || this.activeCat || "角色";
      let zh = "";
      try { zh = await translateAuto(text); } catch (e) { zh = ""; }
      this.addCard(target, { en: text, zh, weight: "", src: "current", multi: true });
    }

    _stashDraft() {
      const t = this.curText();
      if (t.trim()) { saveDraft(t); this._draftSaved = false; }
    }

    restoreDraft() {
      const d = loadDraft();
      if (d) { this._fillCur(d); this._flash("已恢复草稿"); }
    }

    // ── ③ 卡片库区 ──

    addCard(cat, card) {
      if (!this.lib.cards[cat]) { this.lib.cards[cat] = []; if (!this.lib.categories.includes(cat)) this.lib.categories.push(cat); }
      const full = { zh: "", weight: "", star: false, lora: "", src: "manual", ts: Date.now(), ...card };
      this.lib.cards[cat].push(full);
      this.activeCat = cat;
      this._renderCatTabs();
      this._renderCards();
      this.scheduleSave();
      this._flash(`已保存到「${cat}」`);
    }

    removeCard(cat, idx) {
      const list = this.lib.cards[cat] || [];
      if (idx < 0 || idx >= list.length) return;
      const card = list.splice(idx, 1)[0];
      this._renderCards();
      this.scheduleSave();
      // 软删除撤销（3 秒）
      const key = cat + "::" + idx;
      this.deleted.set(key, { cat, idx: Math.max(0, idx), card });
      this._flash('卡片已删除，可点「撤销」恢复', 4000);
      setTimeout(() => { this.deleted.delete(key); }, 3000);
    }

    undoDelete() {
      const entries = Array.from(this.deleted.entries());
      if (!entries.length) { this._flash("没有可撤销的删除"); return; }
      for (const [, v] of entries) {
        const list = this.lib.cards[v.cat] || [];
        list.splice(Math.min(v.idx, list.length), 0, v.card);
      }
      this.deleted.clear();
      this._renderCards();
      this.scheduleSave();
      this._flash("已恢复删除的卡片");
    }

    toggleStar(cat, idx) {
      const c = (this.lib.cards[cat] || [])[idx];
      if (!c) return;
      c.star = !c.star;
      this._sortCards(cat);
      this._renderCards();
      this.scheduleSave();
    }

    _sortCards(cat) {
      const list = this.lib.cards[cat] || [];
      // 星标置顶，其余按 ts 倒序（新卡在上）
      list.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || (b.ts || 0) - (a.ts || 0));
    }

    // 就地编辑（双击卡片）
    beginEdit(cat, idx) {
      const c = (this.lib.cards[cat] || [])[idx];
      if (!c) return;
      const cardEl = this.cardGridEl?.querySelector(`[data-idx="${idx}"]`);
      if (!cardEl) return;
      const orig = cardEl.innerHTML;
      cardEl.innerHTML = `<div class="tk-cards-edit">
        <input value="${escAttr(c.en)}" data-f="en" placeholder="英文 tag">
        <input value="${escAttr(c.zh || "")}" data-f="zh" placeholder="中文注释（可自定义）">
        <input value="${escAttr(c.weight || "")}" data-f="weight" placeholder="权重(1.2)">
        <input value="${escAttr(c.lora || "")}" data-f="lora" placeholder="LoRA 文件名(可选)">
        <div class="tk-cards-edit-btns">
          <button type="button" class="tk-cards-btn" data-a="save">✓ 保存</button>
          <button type="button" class="tk-cards-btn" data-a="cancel">✕</button>
        </div></div>`;
      const inputs = cardEl.querySelectorAll("input");
      const commit = () => {
        c.en = inputs[0].value.trim() || c.en;
        c.zh = inputs[1].value.trim();
        c.weight = inputs[2].value.trim();
        c.lora = inputs[3].value.trim();
        c.ts = Date.now();
        cardEl.innerHTML = orig;
        this._renderCards();
        this.scheduleSave();
      };
      cardEl.querySelector('[data-a="save"]').addEventListener("click", commit);
      cardEl.querySelector('[data-a="cancel"]').addEventListener("click", () => { cardEl.innerHTML = orig; });
      inputs.forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cardEl.innerHTML = orig; }));
      inputs[0].focus();
    }

    _renderCatTabs() {
      if (!this.catTabsEl) return;
      this.catTabsEl.innerHTML = "";
      for (const c of this.lib.categories) {
        const count = (this.lib.cards[c] || []).length;
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "tk-cards-cat" + (c === this.activeCat ? " on" : "");
        tab.textContent = `${c} (${count})`;
        tab.addEventListener("click", () => { this.activeCat = c; this._renderCatTabs(); this._renderCards(); });
        this.catTabsEl.appendChild(tab);
      }
      const addTab = document.createElement("button");
      addTab.type = "button";
      addTab.className = "tk-cards-cat tk-cards-cat-add";
      addTab.textContent = "+ 新分类";
      addTab.addEventListener("click", () => {
        const name = prompt("新分类名称：");
        const n = (name || "").trim();
        if (!n) return;
        if (!this.lib.cards[n]) { this.lib.cards[n] = []; this.lib.categories.push(n); }
        this.activeCat = n;
        this._renderCatTabs(); this._renderCards(); this.scheduleSave();
      });
      this.catTabsEl.appendChild(addTab);
    }

    _renderCards() {
      if (!this.cardGridEl) return;
      const list = this.lib.cards[this.activeCat] || [];
      this._sortCards(this.activeCat);
      this.cardGridEl.innerHTML = "";
      if (!list.length) {
        this.cardGridEl.innerHTML = `<div class="tk-cards-empty">该分类暂无卡片 — 点击右侧提示词片段「存为卡片」、或下方「浏览 LoRA」批量收藏</div>`;
        return;
      }
      list.forEach((c, idx) => {
        const el = document.createElement("div");
        el.className = "tk-cards-card" + (c.star ? " star" : "");
        el.setAttribute("data-idx", String(idx));
        el.title = "单击追加到当前提示词 · 双击编辑 · 右键删除";
        const en = document.createElement("div");
        en.className = "tk-cards-card-en";
        en.textContent = c.en.length > 60 ? c.en.slice(0, 58) + "…" : c.en;
        en.title = c.en + (c.lora ? `\nLoRA: ${c.lora}` : "");
        const zh = document.createElement("div");
        zh.className = "tk-cards-card-zh";
        zh.textContent = c.zh || "（待翻译）";
        const meta = document.createElement("div");
        meta.className = "tk-cards-card-meta";
        meta.innerHTML = `<span class="tk-cards-star" title="星标置顶">${c.star ? "★" : "☆"}</span>` +
          (c.weight ? `<span class="tk-cards-w">${esc(c.weight)}</span>` : "") +
          (c.lora ? `<span class="tk-cards-lora">L:${esc(c.lora.split("/").pop().replace(/\.safetensors$/, ""))}</span>` : "") +
          (c.multi ? `<span class="tk-cards-multi">组合</span>` : "");
        el.appendChild(en);
        el.appendChild(zh);
        el.appendChild(meta);
        // 单击：追加到当前提示词（智能去重）
        el.addEventListener("click", (ev) => {
          if (ev.target.closest(".tk-cards-star") || ev.target.closest(".tk-cards-del")) return;
          const cur = this.curText();
          const next = appendCardToPrompt(cur, c);
          this._setW(this.w.positive, next);
          if (this.curTextEl) this.curTextEl.value = next;
          this._renderChips();
          this._renderPager();
          if (next === cur) this._flash("该卡片已在提示词中（已去重）");
        });
        // 双击：就地编辑
        el.addEventListener("dblclick", (ev) => {
          if (ev.target.closest(".tk-cards-star") || ev.target.closest(".tk-cards-del")) return;
          this.beginEdit(this.activeCat, idx);
        });
        // 星标
        el.querySelector(".tk-cards-star").addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.toggleStar(this.activeCat, idx);
        });
        // 右键删除
        el.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          this.removeCard(this.activeCat, idx);
        });
        this.cardGridEl.appendChild(el);
      });
    }

    // ── 工具：剪切板导入 / PNG 解析 / LoRA 浏览 / 批量补翻 / 导出 ──

    async importClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) { this._flash("剪切板为空"); return; }
        this._setW(this.w.positive, text.trim());
        if (this.curTextEl) this.curTextEl.value = text.trim();
        this._renderChips();
        this._flash("已从剪切板导入并拆分");
      } catch (e) {
        this._flash("无法读取剪切板（权限/浏览器限制）：" + (e.message || e));
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
                this.addCard("LoRA 触发词", { en: w, zh: "", weight: "", lora: name + ".safetensors", src: "lora" });
              }
              this._flash(`已收藏 ${words.length} 张触发词卡片 → LoRA 触发词`);
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
              // 追加触发词 + 同步 lora_syntax（直连 TK Batch LoRA Loader）
              let text = this.curText();
              for (const w of words) {
                const can = appendCardToPrompt(text, { en: w, zh: "", weight: "", lora: "" });
                if (can !== text) { text = can; }
              }
              this._setW(this.w.positive, text);
              if (this.curTextEl) this.curTextEl.value = text;
              this._renderChips();
              const lw = (this.w.lora_syntax?.value || "").trim();
              const lwNext = lw ? lw + " <lora:" + name + ":1.0>" : "<lora:" + name + ":1.0>";
              this._setW(this.w.lora_syntax, lwNext);
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
      const todo = [];
      for (const cat of this.lib.categories) {
        const list = this.lib.cards[cat] || [];
        list.forEach((c, i) => { if (!String(c.zh || "").trim() && String(c.en || "").trim()) todo.push([cat, i]); });
      }
      if (!todo.length) { this._flash("没有待翻译的卡片"); return; }
      this._flash(`批量翻译中：${todo.length} 张（DeepLX → DashScope 回退）`);
      // 并发 3
      let done = 0, failed = 0;
      const workers = Array.from({ length: 3 }, async () => {
        while (todo.length) {
          const [cat, i] = todo.pop();
          const c = (this.lib.cards[cat] || [])[i];
          if (!c) continue;
          try {
            const zh = await translateAuto(c.en);
            if (zh) { c.zh = zh; }
            else failed++;
          } catch (e) { failed++; }
          done++;
        }
      });
      await Promise.all(workers);
      this._renderCards();
      this.scheduleSave();
      this._flash(`批量翻译完成：成功 ${done - failed} / 失败 ${failed}`);
    }

    async exportCards() {
      const name = prompt("导出文件名（写入 input/prompts/）：", "prompt_cards_" + new Date().toISOString().slice(0, 10));
      const n = (name || "").trim();
      if (!n) return;
      // 导出当前分类（或全部有卡片的分类）
      const groups = [];
      for (const cat of this.lib.categories) {
        const cards = (this.lib.cards[cat] || []).slice();
        if (!cards.length) continue;
        groups.push({ name: cat, cards });
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

    // 状态提示
    _flash(msg, ms = 2500) {
      if (!this.statusEl) return;
      this.statusEl.textContent = msg;
      clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => { if (this.statusEl) this.statusEl.textContent = ""; }, ms);
    }

    // ── build ──
    build() {
      const container = document.createElement("div");
      container.className = "tk-cards-ui";
      this.rootEl = container;

      // 挂载（兼容 addDOMWidget / insertBefore 兜底）
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
          } catch (e) { /* 忽略 */ }
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

      // 状态行
      this.statusEl = document.createElement("div");
      this.statusEl.className = "tk-cards-status";
      container.appendChild(this.statusEl);

      // ═══ ① 本地 prompt 库区 ═══
      const libSec = document.createElement("div");
      libSec.className = "tk-cards-sec";
      const libHead = document.createElement("div");
      libHead.className = "tk-cards-sec-head";
      libHead.innerHTML = `<b>① 本地提示词库</b>`;
      this.fileSel = document.createElement("select");
      this.fileSel.className = "tk-cards-select";
      this.fileSel.addEventListener("change", () => this.selectFile(this.fileSel.value));
      this.groupListEl = document.createElement("div");
      this.groupListEl.className = "tk-cards-groups";
      libSec.appendChild(libHead);
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
      clipboardBtn.type = "button"; clipboardBtn.className = "tk-cards-btn"; clipboardBtn.textContent = "📋 从剪切板导入";
      clipboardBtn.addEventListener("click", () => this.importClipboard());
      const pngBtn = document.createElement("button");
      pngBtn.type = "button"; pngBtn.className = "tk-cards-btn"; pngBtn.textContent = "🖼 解析图片";
      pngBtn.addEventListener("click", () => this.showPngDialog());
      const draftBtn = document.createElement("button");
      draftBtn.type = "button"; draftBtn.className = "tk-cards-btn"; draftBtn.textContent = "↩ 恢复草稿";
      draftBtn.addEventListener("click", () => this.restoreDraft());
      const clearBtn = document.createElement("button");
      clearBtn.type = "button"; clearBtn.className = "tk-cards-btn"; clearBtn.textContent = "清空";
      clearBtn.addEventListener("click", () => { this._fillCur(""); this._flash("已清空（可恢复草稿）"); });
      curBtns.appendChild(clipboardBtn); curBtns.appendChild(pngBtn); curBtns.appendChild(draftBtn); curBtns.appendChild(clearBtn);
      curHead.appendChild(curBtns);
      this.curTextEl = document.createElement("textarea");
      this.curTextEl.className = "tk-cards-textarea";
      this.curTextEl.placeholder = "当前提示词（点组/点卡片/粘贴/解析图片填充；也可直接编辑）";
      this.curTextEl.value = this.w.positive?.value || "";
      this.curTextEl.addEventListener("input", () => this.onCurInput());
      this.chipsEl = document.createElement("div");
      this.chipsEl.className = "tk-cards-chips";
      this.pagerEl = document.createElement("div");
      this.pagerEl.className = "tk-cards-pager";
      const curTools = document.createElement("div");
      curTools.className = "tk-cards-cur-tools";
      const saveAllBtn = document.createElement("button");
      saveAllBtn.type = "button"; saveAllBtn.className = "tk-cards-btn tk-cards-btn-main";
      saveAllBtn.textContent = "＋ 整段存为组合卡";
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
      curSec.appendChild(this.pagerEl);
      curSec.appendChild(curTools);
      container.appendChild(curSec);

      // ═══ ③ 卡片库区 ═══
      const cardSec = document.createElement("div");
      cardSec.className = "tk-cards-sec";
      const cardHead = document.createElement("div");
      cardHead.className = "tk-cards-sec-head";
      cardHead.innerHTML = `<b>③ 卡片库</b>`;
      const cardBtns = document.createElement("div");
      cardBtns.className = "tk-cards-sec-btns";
      const loraBtn = document.createElement("button");
      loraBtn.type = "button"; loraBtn.className = "tk-cards-btn tk-cards-btn-main"; loraBtn.textContent = "📚 浏览 LoRA";
      loraBtn.addEventListener("click", () => this.showLoraDialog());
      const tlBtn = document.createElement("button");
      tlBtn.type = "button"; tlBtn.className = "tk-cards-btn"; tlBtn.textContent = "🌐 批量补翻";
      tlBtn.addEventListener("click", () => this.batchTranslate());
      const exBtn = document.createElement("button");
      exBtn.type = "button"; exBtn.className = "tk-cards-btn"; exBtn.textContent = "⇪ 导出批文件";
      exBtn.addEventListener("click", () => this.exportCards());
      const refBtn = document.createElement("button");
      refBtn.type = "button"; refBtn.className = "tk-cards-btn"; refBtn.textContent = "刷新";
      refBtn.addEventListener("click", () => { this._loadLib(); this._loadFiles(); this._flash("已刷新"); });
      cardBtns.appendChild(loraBtn); cardBtns.appendChild(tlBtn); cardBtns.appendChild(exBtn); cardBtns.appendChild(refBtn);
      cardHead.appendChild(cardBtns);
      this.catTabsEl = document.createElement("div");
      this.catTabsEl.className = "tk-cards-cats";
      this.cardGridEl = document.createElement("div");
      this.cardGridEl.className = "tk-cards-grid";
      cardSec.appendChild(cardHead);
      cardSec.appendChild(this.catTabsEl);
      cardSec.appendChild(this.cardGridEl);
      container.appendChild(cardSec);

      // 初始渲染
      this._renderChips();
      this._renderPager();
      this._renderCatTabs();
      this._renderCards();
      this._loadLib();
      this._loadFiles();
      // 从批文件/解析前的重建恢复：positive widget 已有值时拆分展示
      if (this.w.positive?.value) this._renderChips();
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
.tk-cards-groups { max-height:130px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
.tk-cards-group { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:4px; position:relative; }
.tk-cards-group:hover { background:rgba(139,92,246,.08); }
.tk-cards-group.on { background:rgba(139,92,246,.18); }
.tk-cards-group-info { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:help; }
.tk-cards-preview { position:absolute; left:0; right:0; bottom:100%; z-index:50; background:#1b1e26; border:1px solid #8b5cf6; border-radius:4px; padding:4px 6px; font-size:10px; color:#ddd; white-space:pre-wrap; max-height:120px; overflow:auto; }
.tk-cards-textarea { width:100%; min-height:64px; box-sizing:border-box; background:var(--comfy-input-bg,#1b1e26); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#383d4a); border-radius:4px; font-size:11px; padding:4px 6px; resize:vertical; }
.tk-cards-textarea:focus { outline:none; border-color:#8b5cf6; }
.tk-cards-chips { display:flex; flex-wrap:wrap; gap:4px; max-height:90px; overflow:auto; }
.tk-cards-chip { font-size:10px; padding:2px 7px; background:rgba(139,92,246,.12); border:1px solid rgba(139,92,246,.4); border-radius:10px; cursor:pointer; color:#d6c8ff; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tk-cards-chip:hover { border-color:#8b5cf6; background:rgba(139,92,246,.25); }
.tk-cards-pager { font-size:10px; color:#bbb; display:flex; align-items:center; gap:6px; min-height:16px; }
.tk-cards-cur-tools { display:flex; gap:4px; }
.tk-cards-cats { display:flex; flex-wrap:wrap; gap:4px; }
.tk-cards-cat { font-size:10px; padding:2px 8px; background:var(--comfy-input-bg,#222); color:var(--fg-color,#999); border:1px solid var(--border-color,#444); border-radius:10px; cursor:pointer; }
.tk-cards-cat:hover { border-color:#8b5cf6; color:#d6c8ff; }
.tk-cards-cat.on { background:rgba(139,92,246,.2); border-color:#8b5cf6; color:#e6dcff; font-weight:600; }
.tk-cards-cat-add { border-style:dashed; color:#888; }
.tk-cards-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:5px; max-height:220px; overflow:auto; }
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
.tk-cards-search { background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#444); border-radius:4px; font-size:11px; padding:4px 6px; }
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
        if (nodeData.name !== NODE_NAME) return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
          const r = orig?.apply(this, arguments);
          const w = (n) => this.widgets?.find((x) => x.name === n);
          const ui = new CardsUI(this, {
            positive: w("positive"),
            opt_text: w("opt_text"),
            lora_syntax: w("lora_syntax"),
            extra_dirs: null,
          });
          // extra_dirs：无此 widget 时跳过（与 batch 节点不同，卡片节点不需要附加目录输入）
          ui.w.extra_dirs = w("extra_dirs");
          this._cardsUI = ui;
          ui.build();
          return r;
        };
      },
      async setup() {
        window.__tkCardsDebug = window.__tkCardsDebug || {};
        window.__tkCardsDebug.splitTags = splitTags;
      },
    });
  }

  injectStyle();
  init();
})();