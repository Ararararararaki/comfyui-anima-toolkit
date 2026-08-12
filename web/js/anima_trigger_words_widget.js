// Anima Trigger Words 节点前端 Widget
// 独立节点：卡片列表展示每个 LoRA 的触发词，可手动编辑、X 删除。
// 联动：从 bridge（面板「发送到 ComfyUI」）与 lora_syntax 输入解析 LoRA，
//       点击「提取」逐个查询 /anima/lora/info 获取 trainedWords 填卡。
(function () {
  const NODE_NAME = "Anima Trigger Words";

  // ── 内联 SVG 图标（lucide 风格，与 LoRA 节点统一）──
  const _ICON = {
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>',
  };
  function svgIcon(name, size) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;pointer-events:none;">${_ICON[name] || ""}</svg>`;
  }

  function showToast(msg) {
    const old = document.querySelector(".anima-tw-toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.className = "anima-tw-toast";
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", bottom: "60px", left: "50%", transform: "translateX(-50%)",
      background: "#333", color: "#fff", padding: "6px 16px", borderRadius: "6px",
      fontSize: "12px", zIndex: "999999", fontFamily: "sans-serif",
      boxShadow: "0 2px 10px rgba(0,0,0,0.4)", transition: "opacity 0.3s",
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 1500);
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function parseLoraSyntax(text) {
    const re = /<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>/gi;
    const items = [];
    let m;
    while ((m = re.exec(text || ""))) {
      items.push({ name: m[1], weight: parseFloat(m[2]) || 1.0 });
    }
    return items;
  }

  class TriggerWordsUI {
    constructor(node, syntaxWidget) {
      this.node = node;
      this.syntaxWidget = syntaxWidget;
      this.loras = parseLoraSyntax(syntaxWidget.value || "");
      // name -> [trigger words]（卡片编辑用），{source:'fetched'|'manual'}
      this.twMap = {};
      this.listEl = null;
      this._lastBridgeTs = 0;
      this._bridgeTimer = null;
    }

    _btn(text, cls, title, iconName) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      if (iconName) b.innerHTML = svgIcon(iconName, 12) + '<span>' + text + '</span>';
      else b.textContent = text;
      if (title) b.title = title;
      return b;
    }

    _commit() {
      // 把卡片编辑后的触发词写回 trigger_words 输入框（逗号连接），驱动节点输出
      const twWidget = this.node.widgets?.find((w) => w.name === "trigger_words");
      if (!twWidget) return;
      const parts = [];
      for (const l of this.loras) {
        // key 大小写归一：twMap 键可能保留 bridge/提取时的原始大小写，查找时统一 lowercase 兜底
        const tw = this.twMap[l.name] ?? this.twMap[l.name.toLowerCase()];
        if (Array.isArray(tw) && tw.length) parts.push(tw.join(", "));
      }
      const val = parts.join(", ");
      if (twWidget.value !== val) {
        twWidget.value = val;
        if (this.node.graph) this.node.graph.change();
      }
    }

    // ── 渲染卡片列表 ──
    _render() {
      if (!this.listEl) return;
      const el = this.listEl;
      el.innerHTML = "";
      if (!this.loras.length) {
        el.innerHTML = '<div class="atw-empty">暂无 LoRA，输入 <lora:name:weight> 或从面板「发送到 ComfyUI」同步</div>';
        return;
      }
      this.loras.forEach((l) => {
        const card = document.createElement("div");
        card.className = "atw-card";

        const head = document.createElement("div");
        head.className = "atw-card-head";
        const nameEl = document.createElement("span");
        nameEl.className = "atw-card-name";
        nameEl.textContent = l.name;
        nameEl.title = l.name;
        const delBtn = document.createElement("button");
        delBtn.className = "atw-card-del";
        delBtn.type = "button";
        delBtn.innerHTML = svgIcon("x", 12);
        delBtn.title = "删除该 LoRA 的触发词卡片";
        delBtn.onclick = () => {
          this.loras = this.loras.filter((x) => x.name !== l.name);
          this._render();
          this._commit();
        };
        head.append(nameEl, delBtn);

        const input = document.createElement("input");
        input.className = "atw-card-input";
        input.type = "text";
        input.placeholder = "触发词（逗号分隔），可手动编辑";
        input.value = Array.isArray(this.twMap[l.name]) ? this.twMap[l.name].join(", ") : (Array.isArray(this.twMap[l.name.toLowerCase()]) ? this.twMap[l.name.toLowerCase()].join(", ") : "");
        input.onchange = () => {
          const tw = input.value.split(",").map((s) => s.trim()).filter(Boolean);
          this.twMap[l.name] = tw;
          this._commit();
        };

        card.append(head, input);
        el.appendChild(card);
      });
    }

    // ── 从 lora_syntax 输入同步（连线变化时调用）──
    // 以 lora_syntax 为准全量对齐：语法中没有的 LoRA 从列表移除（含 twMap），
    // 避免上一次的 LoRA 残留卡片（用户反馈：语法已删 denia_v1 但卡片仍在）。
    _syncFromSyntax() {
      const v = this.syntaxWidget.value || "";
      const parsed = parseLoraSyntax(v);
      const parsedNames = new Set(parsed.map((p) => p.name.toLowerCase()));
      // 移除语法中已不存在的 LoRA（含 twMap 清理）；
      // 注意：del 按钮删除的 LoRA 若仍在语法中，下次语法变化会按"以语法为准"加回——del 是临时排除
      this.loras = this.loras.filter((l) => parsedNames.has(l.name.toLowerCase()));
      // 清理已移除 LoRA 的 twMap 残留
      for (const k of Object.keys(this.twMap)) {
        if (!parsedNames.has(k.toLowerCase())) delete this.twMap[k];
      }
      // 新增解析到的 LoRA
      const names = new Set(this.loras.map((l) => l.name.toLowerCase()));
      for (const p of parsed) {
        if (!names.has(p.name.toLowerCase())) {
          this.loras.push({ name: p.name, weight: p.weight });
          names.add(p.name);
        }
      }
      this._render();
      this._commit(); // 语法变化必须重算 trigger_words 输出，否则旧触发词残留（与卡片残留同源）
    }

    // ── 从 bridge 同步（面板发送的 lora_list 带 trigger_words）──
    // bridge 返回的是面板全量 lora_list（权威），做全量对齐：移除"不在 bridge 也不在 lora_syntax"的 LoRA，
    // 避免面板删除后本地卡片永久残留（与 _syncFromSyntax 同理）。
    async _syncFromBridge(silent) {
      try {
        const resp = await fetch("/anima/bridge/status");
        if (!resp.ok) return 0;
        const data = await resp.json();
        if (!data || !data.bridge_found || !Array.isArray(data.loras) || !data.loras.length) return 0;
        const ts = data.updated_at || 0;
        if (this._lastBridgeTs && ts <= this._lastBridgeTs) return 0;
        let added = 0;
        // bridge 权威集合（小写名）
        const bridgeNames = new Set(data.loras.map((l) => (l && l.name ? l.name.toLowerCase() : null)).filter(Boolean));
        // 语法集合（小写名）——语法手动输入的 LoRA 即使不在 bridge 也保留
        const syntaxNames = new Set(parseLoraSyntax(this.syntaxWidget.value || "").map((p) => p.name.toLowerCase()));
        // 减法：移除既不在 bridge 也不在语法的残留 LoRA
        const before = this.loras.length;
        this.loras = this.loras.filter((e) => bridgeNames.has(e.name.toLowerCase()) || syntaxNames.has(e.name.toLowerCase()));
        if (this.loras.length !== before) {
          for (const k of Object.keys(this.twMap)) {
            if (!bridgeNames.has(k.toLowerCase()) && !syntaxNames.has(k.toLowerCase())) delete this.twMap[k];
          }
        }
        data.loras.forEach((l) => {
          if (!l || !l.name) return;
          if (!this.loras.some((e) => e.name.toLowerCase() === l.name.toLowerCase())) {
            this.loras.push({ name: l.name, weight: typeof l.model_strength === "number" ? l.model_strength : 1.0 });
            added++;
          }
          if (l.trigger_words && l.trigger_words.length && !this.twMap[l.name]) {
            this.twMap[l.name] = l.trigger_words;
          }
        });
        this._lastBridgeTs = ts;
        this._render();
        if (added || this.loras.length !== before) this._commit();
        if (!silent && added) showToast("已从面板同步 " + added + " 个 LoRA");
        return added;
      } catch {
        return 0;
      }
    }

    // ── 提取：逐个查询 /anima/lora/info 获取 trainedWords ──
    async _extractAll() {
      const pending = this.loras.filter((l) => !Array.isArray(this.twMap[l.name]) || this.twMap[l.name].length === 0);
      if (!pending.length) { showToast("所有 LoRA 的触发词已获取"); return; }
      showToast("正在提取 " + pending.length + " 个 LoRA 的触发词…");
      let found = 0, failed = 0;
      for (const l of pending) {
        try {
          const resp = await fetch("/anima/lora/info?name=" + encodeURIComponent(l.name));
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const data = await resp.json();
          const src = data.source || "";
          if (data.error || src.startsWith("error") || src.startsWith("http")) throw new Error(data.error || src);
          const tw = data.trainedWords || [];
          this.twMap[l.name] = tw;
          if (tw.length) found++;
        } catch (e) {
          failed++;
          console.error("[Anima TW] 提取失败:", l.name, e);
        }
      }
      this._render();
      this._commit();
      showToast(failed ? `提取完成：${found} 个有触发词，${failed} 个失败` : `提取完成：${found} 个有触发词`);
    }

    build() {
      const container = document.createElement("div");
      container.className = "anima-tw-widget";

      // 注入样式
      const styleId = "anima-tw-style";
      if (!document.getElementById(styleId)) {
        const st = document.createElement("style");
        st.id = styleId;
        st.textContent = `
          .anima-tw-widget { display:flex; flex-direction:column; gap:6px; padding:6px; background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01)); border-radius:8px; font-family:"Inter","Geist Sans",system-ui,sans-serif; border:1px solid rgba(255,255,255,0.05); }
          .anima-tw-widget .atw-toolbar { display:flex; gap:5px; flex-wrap:wrap; }
          .anima-tw-widget .atw-toolbar button { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border:none; border-radius:6px; cursor:pointer; font-size:9px; font-weight:600; color:#EDEDEF; white-space:nowrap; transition:all 0.2s ease-out; background:linear-gradient(135deg,#5E6AD2,#6872D9); box-shadow:0 0 0 1px rgba(94,106,210,0.3),inset 0 1px 0 0 rgba(255,255,255,0.15); }
          .anima-tw-widget .atw-toolbar button:hover { background:linear-gradient(135deg,#6872D9,#7B83E0); transform:translateY(-1px); }
          .anima-tw-widget .atw-toolbar button:active { transform:scale(0.97); }
          .anima-tw-widget .atw-list { display:flex; flex-direction:column; gap:4px; max-height:300px; overflow-y:auto; }
          .anima-tw-widget .atw-empty { font-size:10px; color:#8A8F98; padding:14px 8px; text-align:center; line-height:1.6; }
          .anima-tw-widget .atw-card { background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 8px; }
          .anima-tw-widget .atw-card-head { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
          .anima-tw-widget .atw-card-name { flex:1; font-size:10px; color:#C8C9CB; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
          .anima-tw-widget .atw-card-del { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; padding:0; border:none; border-radius:4px; background:none; color:rgba(255,80,80,0.4); cursor:pointer; flex-shrink:0; transition:all 0.15s ease-out; }
          .anima-tw-widget .atw-card-del:hover { color:#ff6b6b; background:rgba(255,80,80,0.1); }
          .anima-tw-widget .atw-card-input { width:100%; padding:4px 7px; background:#0a0a0c; color:#EDEDEF; border:1px solid rgba(255,255,255,0.08); border-radius:5px; font-size:10px; outline:none; box-sizing:border-box; transition:border-color 0.15s ease-out; }
          .anima-tw-widget .atw-card-input:focus { border-color:#5E6AD2; box-shadow:0 0 0 3px rgba(94,106,210,0.12); }
          .anima-tw-widget .atw-card-input::placeholder { color:rgba(255,255,255,0.25); }
        `;
        document.head.appendChild(st);
      }

      const toolbar = document.createElement("div");
      toolbar.className = "atw-toolbar";
      const extractBtn = this._btn("提取触发词", "atw-extract", "从 Civitai 批量查询各 LoRA 的触发词", "download");
      const copyBtn = this._btn("复制全部", "atw-copy", "复制所有触发词（逗号连接）", "clipboard");
      extractBtn.onclick = () => this._extractAll();
      copyBtn.onclick = () => {
        const parts = this.loras.map((l) => Array.isArray(this.twMap[l.name]) ? this.twMap[l.name].join(", ") : "").filter(Boolean);
        if (!parts.length) { showToast("暂无触发词可复制"); return; }
        const text = parts.join(", ") + ",";
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
        showToast("已复制全部触发词");
      };
      toolbar.append(extractBtn, copyBtn);

      const listEl = document.createElement("div");
      listEl.className = "atw-list";

      container.append(toolbar, listEl);
      this.listEl = listEl;
      this._render();

      // 同步：lora_syntax 输入变化 + bridge 定时轮询
      this.syntaxWidget.callback = ((orig) => {
        return function () {
          if (typeof orig === "function") orig.apply(this, arguments);
          ui._syncFromSyntax();
        };
      })(this.syntaxWidget.callback);

      const ui = this;
      this._syncFromBridge(true);
      this._bridgeTimer = setInterval(() => this._syncFromBridge(true), 5000);
      const origRemoved = this.node.onRemoved;
      this.node.onRemoved = function () {
        if (ui._bridgeTimer) { clearInterval(ui._bridgeTimer); ui._bridgeTimer = null; }
        if (typeof origRemoved === "function") return origRemoved.apply(this, arguments);
      };

      return container;
    }
  }

  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);
    api.registerExtension({
      name: "Anima.TriggerWords.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
          const r = orig?.apply(this, arguments);
          const syntaxWidget = this.widgets?.find((w) => w.name === "lora_syntax");
          if (!syntaxWidget) return r;
          const ui = new TriggerWordsUI(this, syntaxWidget);
          this._animaTwUI = ui;
          const el = ui.build();
          // 挂到节点 DOM（放在 widgets 区域后）
          const size = this.size || [260, 120];
          if (typeof this.addDOMWidget === "function") {
            this.addDOMWidget("anima_tw", "custom", el, { serialize: false });
          } else if (this.domWidgets) {
            this.domWidgets.push({ name: "anima_tw", element: el, type: "custom" });
          }
          this.setSize && this.setSize(size);
          return r;
        };
      },
    });
  }

  init();
})();
