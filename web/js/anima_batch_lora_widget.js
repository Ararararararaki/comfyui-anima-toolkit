// Anima Batch LoRA Widget — 中文界面 + 桥接自动加载 + 触发词复制
(function () {
  const NODE_NAME = "Anima Batch LoRA Loader";
  // 面板 URL / 图标：动态解析当前插件目录名（兼容任意 clone 目录名）
  let PANEL_BASE = "/extensions/ComfyUI-Anima-Batch-LoRA/app/";
  let ICON_URL = "/extensions/ComfyUI-Anima-Batch-LoRA/img/anima-btn.jpg";
  try {
    const _src = document.currentScript && document.currentScript.src;
    const _m = _src && _src.match(/\/extensions\/([^/]+)\/js\//);
    if (_m) {
      PANEL_BASE = "/extensions/" + _m[1] + "/app/";
      ICON_URL = "/extensions/" + _m[1] + "/img/anima-btn.jpg";
    }
  } catch (e) {}

  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);

    api.registerExtension({
      name: "Anima.BatchLoRA.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const orig = nodeType.prototype.onNodeCreated;
        const origAdded = nodeType.prototype.onAdded;
        const origConfigureFn = nodeType.prototype.configure;
        nodeType.prototype.onNodeCreated = function () {
          const r = orig?.apply(this, arguments);
          const loraWidget = this.widgets?.find((w) => w.name === "lora_syntax");
          if (!loraWidget) return r;
          const ui = new WidgetUI(this, loraWidget);
          this._animaUI = ui;
          ui.build();
          return r;
        };
        // 加载工作流时 widget 值在 configure 阶段才恢复：onAdded 触发时
        // lora_syntax 仍是默认空值，解析不到任何标签，卡片不显示。
        // 因此在 configure（值已恢复）里解析渲染，并用 onAdded 延迟兜底。
        const restoreFromWidget = function (ui) {
          if (!ui || !ui.listEl) return;
          const v = (ui.loraWidget && ui.loraWidget.value) || "";
          const parsed = ui._parse(v);
          if (!parsed.length) return;
          const same = ui.loras.length === parsed.length && ui.loras.every((x, i) => x.name === parsed[i].name && x.weight === parsed[i].weight);
          if (same) return;
          ui.loras = parsed;
          ui._render(ui.listEl);
          if (ui._autoFetchTriggerWords) ui._autoFetchTriggerWords();
        };
        nodeType.prototype.onAdded = function () {
          const r = origAdded?.apply(this, arguments);
          setTimeout(() => restoreFromWidget(this._animaUI), 0);
          return r;
        };
        if (typeof origConfigureFn === "function") {
          nodeType.prototype.configure = function (info) {
            const r = origConfigureFn.call(this, info);
            restoreFromWidget(this._animaUI);
            return r;
          };
        }
      },
      async setup(app) {
        // 用 ComfyUI 标准菜单 API 把「工具箱」按钮放进顶栏（设置齿轮左侧），替代固定定位
        // 参考 Lora-Manager 的做法：ComfyButton + ComfyButtonGroup + settingsGroup.element.before()
        const attach = (attempt = 0) => {
          const settingsGroup = app?.menu?.settingsGroup;
          if (!settingsGroup?.element?.parentElement) {
            if (attempt > 120) return; // 最多重试约 2s
            requestAnimationFrame(() => attach(attempt + 1));
            return;
          }
          const img = document.createElement("img");
          img.src = ICON_URL;
          img.alt = "工具箱";
          img.style.cssText = "display:block;width:100%;height:100%;object-fit:cover;";
          // 让菲比图片撑满整个按钮（固定按钮尺寸 + 去 padding）
          if (!document.getElementById("anima-menu-style")) {
            const bstyle = document.createElement("style");
            bstyle.id = "anima-menu-style";
            bstyle.textContent = ".anima-menu-group.comfyui-button-group .comfyui-button { width:30px; height:30px; padding:0; } .anima-menu-group.comfyui-button-group img { border-radius:6px; }";
            document.head.appendChild(bstyle);
          }
          (async () => {
            try {
              const { ComfyButton } = await import("/scripts/ui/components/button.js");
              const { ComfyButtonGroup } = await import("/scripts/ui/components/buttonGroup.js");
              const btn = new ComfyButton({
                content: img,
                tooltip: "打开 Anima 本地工具箱（面板）",
                action: () => window.open(PANEL_BASE, "_blank"),
                classList: "comfyui-button comfyui-menu-mobile-collapse primary",
              });
              const group = new ComfyButtonGroup(btn);
              group.element.classList.add("anima-menu-group");
              settingsGroup.element.before(group.element);
            } catch {
              // 回退：追加到旧式侧边菜单（.comfy-menu）
              const menu = document.querySelector(".comfy-menu");
              if (!menu) return;
              const fb = document.createElement("button");
              fb.innerHTML = `<img src="${ICON_URL}" alt="工具箱" style="width:18px;height:18px;border-radius:4px;vertical-align:middle;">`;
              fb.title = "打开 Anima 本地工具箱（面板）";
              fb.style.cssText = "background:none;border:none;cursor:pointer;padding:4px;";
              fb.onclick = () => window.open(PANEL_BASE, "_blank");
              menu.prepend(fb);
            }
          })();
        };
        attach();
      },
    });
  }

  // ── 工具函数 ──
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  // ── 解析 C 站 URL → {versionId} 或 {modelId} ──
  function parseCivitaiUrl(url) {
    const vm = url.match(/modelVersionId=(\d+)/);
    if (vm) return { versionId: vm[1] };
    const mm = url.match(/civitai\.com\/models\/(\d+)/);
    if (mm) return { modelId: mm[1] };
    return null;
  }

  // ── 批量下载弹窗（每行一个 C 站链接） ──
  function showBatchDownloadDialog(onDone) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(2,2,3,0.72);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);";
    const modal = document.createElement("div");
    modal.style.cssText = "background:#14141c;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px;width:94vw;max-width:520px;max-height:80vh;display:flex;flex-direction:column;color:#EDEDEF;box-shadow:0 0 0 1px rgba(255,255,255,0.05),0 20px 60px rgba(0,0,0,0.6);";
    modal.innerHTML = `<h3 style="margin:0 0 8px;font-size:13px;">🔗 从 C 站链接批量下载 LoRA</h3>
      <div style="font-size:10px;color:#8A8F98;margin-bottom:8px;">每行一个链接（civitai.com/models/...），可带可不带 modelVersionId</div>
      <textarea class="bd-urls" rows="6" placeholder="https://civitai.com/models/2658471/denia-wuthering-wavesanima&#10;https://civitai.com/models/2529695/xxx?modelVersionId=3094753" style="flex:1;padding:8px;background:#0a0a0c;color:#EDEDEF;border:1px solid rgba(255,255,255,0.08);border-radius:6px;font-size:11px;font-family:monospace;resize:vertical;outline:none;"></textarea>
      <div class="bd-list" style="margin-top:8px;max-height:160px;overflow-y:auto;"></div>
      <div class="bd-log" style="margin-top:8px;max-height:60px;overflow-y:auto;font-size:10px;color:#8A8F98;white-space:pre-wrap;"></div>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
        <button class="bd-cancel" style="padding:5px 12px;background:rgba(255,255,255,0.08);color:#8A8F98;border:1px solid rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;font-size:11px;">取消</button>
        <button class="bd-start" style="padding:5px 14px;background:linear-gradient(135deg,#5E6AD2,#6872D9);color:#EDEDEF;border:none;border-radius:6px;cursor:pointer;font-size:11px;">⬇️ 开始下载</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    modal.querySelector(".bd-cancel").onclick = close;
    modal.querySelector(".bd-start").onclick = async () => {
      const urls = modal.querySelector(".bd-urls").value.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!urls.length) { showToast("请输入链接"); return; }
      const logEl = modal.querySelector(".bd-log");
      const listEl = modal.querySelector(".bd-list");
      const startBtn = modal.querySelector(".bd-start");
      startBtn.disabled = true;
      let ok = 0, fail = 0;
      for (const url of urls) {
        const p = parseCivitaiUrl(url);
        if (!p) { fail++; logEl.textContent += `✗ 无法解析: ${url.slice(0,50)}\n`; continue; }
        const qs = p.versionId ? `versionId=${p.versionId}` : `modelId=${p.modelId}`;
        const progressId = "dl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

        // 进度条行
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:10px;color:#EDEDEF;";
        const nameEl = document.createElement("span");
        nameEl.style.cssText = "width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;";
        nameEl.textContent = url.slice(0, 36);
        const barWrap = document.createElement("div");
        barWrap.style.cssText = "flex:1;height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;";
        const bar = document.createElement("div");
        bar.style.cssText = "height:100%;width:0%;background:linear-gradient(135deg,#5E6AD2,#6872D9);transition:width 0.2s;";
        barWrap.appendChild(bar);
        const pctEl = document.createElement("span");
        pctEl.style.cssText = "width:36px;text-align:right;color:#8A8F98;flex-shrink:0;";
        pctEl.textContent = "0%";
        row.append(nameEl, barWrap, pctEl);
        listEl.appendChild(row);
        listEl.scrollTop = listEl.scrollHeight;

        // 串行下载：发起请求（后台）+ 轮询进度，完成后再下一条
        await new Promise((resolve) => {
          let cleared = false;
          const stop = () => { if (!cleared) { cleared = true; clearInterval(timer); } };
          const timer = setInterval(async () => {
            try {
              const sr = await fetch(`/anima/lora/download/status?progressId=${progressId}`);
              const s = await sr.json();
              if (s.total) {
                const pc = Math.round(s.done / s.total * 100);
                bar.style.width = pc + "%";
                pctEl.textContent = pc + "%";
              }
              if (s.status === "done") { stop(); bar.style.width = "100%"; pctEl.textContent = "✓"; }
              else if (s.status === "error") { stop(); pctEl.textContent = "✗"; }
            } catch {}
          }, 400);

          fetch(`/anima/lora/download?${qs}&progressId=${progressId}`)
            .then((r) => r.json())
            .then((j) => {
              stop();
              if (j.ok) { ok++; logEl.textContent += `✓ ${j.filename}\n`; bar.style.width = "100%"; pctEl.textContent = "✓"; }
              else { fail++; logEl.textContent += `✗ ${j.error || "失败"}\n`; pctEl.textContent = "✗"; }
              resolve();
            })
            .catch((e) => { stop(); fail++; logEl.textContent += `✗ ${e.message}\n`; pctEl.textContent = "✗"; resolve(); });
        });
        logEl.scrollTop = logEl.scrollHeight;
      }
      startBtn.disabled = false;
      logEl.textContent += `\n✅ 完成: ${ok} 成功 / ${fail} 失败\n`;
      if (typeof onDone === "function") onDone();
    };
  }

  let _toastEl = null;
  function showToast(msg) {
    // 全局只保留一个 toast，新提示直接替换旧提示，避免多个 toast 重叠盖住
    if (_toastEl) _toastEl.remove();
    const t = document.createElement("div");
    t.textContent = msg;
    Object.assign(t.style, {
      position: "fixed", bottom: "60px", left: "50%", transform: "translateX(-50%)",
      background: "#333", color: "#fff", padding: "6px 16px", borderRadius: "6px",
      fontSize: "12px", zIndex: "999999", fontFamily: "sans-serif",
      boxShadow: "0 2px 10px rgba(0,0,0,0.4)", transition: "opacity 0.3s",
    });
    document.body.appendChild(t);
    _toastEl = t;
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => { t.remove(); if (_toastEl === t) _toastEl = null; }, 300); }, 1500);
  }

  // ── UI 状态 ──
  class WidgetUI {
    constructor(node, loraWidget) {
      this.node = node;
      this.loraWidget = loraWidget;
      this.loras = this._parse(loraWidget.value || "");
      this.triggerWordMap = {};
      this._lastBridgeTs = 0;   // 上次已应用的 bridge updated_at（避免重复同步）
      this._bridgeTimer = null;
    }

    // ── 解析 <lora:name:weight>（并合并 node.properties 里保留的禁用项） ──
    _parse(text) {
      const re = /<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>/gi;
      const items = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        items.push({
          name: m[1],
          weight: parseFloat(m[2]),
          disabled: false,
        });
      }
      // 被禁用的 LoRA 不在 lora_syntax 里，但保留在节点上：优先从 node.properties（随工作流）恢复，localStorage 兜底
      let disabledMap = (this.node && this.node.properties && this.node.properties.animaLoraDisabled);
      if (!disabledMap) {
        try { disabledMap = JSON.parse(localStorage.getItem("anima_lora_disabled") || "{}"); } catch { disabledMap = {}; }
      }
      for (const [name, weight] of Object.entries(disabledMap)) {
        const existing = items.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (existing) {
          existing.disabled = true; // 同名项在 lora_syntax 里 → 标记禁用
        } else {
          items.push({ name, weight: Number(weight) || 1.0, disabled: true });
        }
      }
      return items;
    }

    _serialize() {
      return this.loras
        .filter((l) => !l.disabled) // 禁用的不写入 lora_syntax，后端不应用
        .map((l) => `<lora:${l.name}:${l.weight.toFixed(2)}>`)
        .join(" ");
    }

    _persistDisabled() {
      const disabledMap = {};
      for (const l of this.loras) {
        if (l.disabled) disabledMap[l.name] = l.weight;
      }
      if (!this.node.properties) this.node.properties = {};
      this.node.properties.animaLoraDisabled = disabledMap;
      try { localStorage.setItem("anima_lora_disabled", JSON.stringify(disabledMap)); } catch { /* 忽略 */ }
    }

    _commit() {
      // 必须先持久化禁用状态再写 lora_syntax：lora_syntax 值变化会触发 widget 的
      // callback（this.loras = this._parse(v)），若 node.properties 尚未设置，禁用项会被覆盖丢失
      this._persistDisabled();
      this.loraWidget.value = this._serialize();
      if (this.node.graph) this.node.graph.change();
    }

    // ── 构建 DOM ──
    build() {
      const container = document.createElement("div");
      container.className = "anima-lora-widget";

      // ── 注入样式（每次都写入完整样式，防止旧样式缺失导致弹窗/卡片不可见） ──
      const styleId = "anima-widget-style";
      let styleEl = document.getElementById(styleId);
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = `
          .anima-lora-widget { display:flex; flex-direction:column; padding:6px; max-height:420px; background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01)); border-radius:8px; font-family:"Inter","Geist Sans",system-ui,sans-serif; border:1px solid rgba(255,255,255,0.05); box-shadow:inset 0 1px 0 0 rgba(255,255,255,0.04); }
          .anima-lora-widget .list { flex:1; overflow-y:auto; min-height:0; }
          .anima-lora-widget .toolbar { display:flex; gap:5px; margin-bottom:6px; flex-wrap:wrap; }
          .anima-lora-widget .toolbar button { padding:4px 10px; border:none; border-radius:6px; cursor:pointer; font-size:9px; font-weight:600; color:#EDEDEF; white-space:nowrap; letter-spacing:0.02em; transition:all 0.2s ease-out; box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 2px 8px rgba(0,0,0,0.3); }
          .anima-lora-widget .toolbar .btn-verify { background:linear-gradient(135deg,#5E6AD2,#6872D9); box-shadow:0 0 0 1px rgba(94,106,210,0.3),0 2px 12px rgba(94,106,210,0.2),inset 0 1px 0 0 rgba(255,255,255,0.15); }
          .anima-lora-widget .toolbar .btn-verify:hover { background:linear-gradient(135deg,#6872D9,#7B83E0); box-shadow:0 0 0 1px rgba(94,106,210,0.4),0 4px 20px rgba(94,106,210,0.3),inset 0 1px 0 0 rgba(255,255,255,0.2); transform:translateY(-1px); }
          .anima-lora-widget .toolbar .btn-verify:active { transform:scale(0.97); }
          .anima-lora-widget .toolbar .btn-browse { background:linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.04)); }
          .anima-lora-widget .toolbar .btn-browse:hover { background:linear-gradient(135deg,rgba(255,255,255,0.12),rgba(255,255,255,0.06)); box-shadow:0 0 0 1px rgba(255,255,255,0.10),0 4px 16px rgba(0,0,0,0.4); transform:translateY(-1px); }
          .anima-lora-widget .toolbar .btn-clear { background:linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02)); color:#8A8F98; }
          .anima-lora-widget .toolbar .btn-clear:hover { background:linear-gradient(135deg,rgba(255,80,80,0.12),rgba(255,80,80,0.06)); color:#ff6b6b; box-shadow:0 0 0 1px rgba(255,80,80,0.2); transform:translateY(-1px); }
          .anima-lora-widget .status { font-size:10px; padding:3px 6px; margin-bottom:4px; min-height:18px; color:#8A8F98; border-radius:4px; background:rgba(255,255,255,0.02); }
          .anima-lora-widget .trigger-box { font-size:10px; padding:6px 8px; margin-top:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); border-radius:6px; display:none; line-height:1.6; color:#8A8F98; }
          .anima-lora-widget .empty-msg { font-size:10px; color:#8A8F98; padding:16px 8px; text-align:center; line-height:1.6; }
          .anima-lora-widget .lora-row { display:flex; align-items:center; gap:6px; padding:5px 6px; border-radius:6px; transition:all 0.2s ease-out; background:rgba(255,255,255,0.02); margin-bottom:2px; border:1px solid transparent; }
          .anima-lora-widget .lora-row:hover { background:linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02)); border-color:rgba(255,255,255,0.06); box-shadow:0 2px 12px rgba(0,0,0,0.2); }
          .anima-lora-widget .lora-row.drag-over { padding-top:8px; border-top:2px solid #5E6AD2; background:rgba(94,106,210,0.06); }
          .anima-lora-widget .lora-row.dragging { opacity:0.3; }
          .anima-lora-widget .drag-area { display:inline-flex; align-items:center; cursor:grab; padding:2px 4px; border-radius:4px; flex-shrink:0; user-select:none; -webkit-user-select:none; }
          .anima-lora-widget .drag-area:hover { background:rgba(255,255,255,0.06); }
          .anima-lora-widget .drag-area .drag-hint { color:rgba(255,255,255,0.15); font-size:11px; line-height:1; }
          .anima-lora-widget .lora-name { font-size:10px; min-width:50px; max-width:90px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#C8C9CB; flex-shrink:0; cursor:pointer; padding:2px 4px; border-radius:4px; transition:all 0.15s ease-out; }
          .anima-lora-widget .lora-name:hover { background:rgba(94,106,210,0.12); color:#EDEDEF; }
          .anima-lora-widget .lora-tw-hint { font-size:8px; color:rgba(255,255,255,0.25); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:58px; flex-shrink:0; min-width:0; }
          .anima-lora-widget .weight-group { display:flex; align-items:center; gap:3px; flex:1; }
          .anima-lora-widget .weight-group input[type=range] { -webkit-appearance:none; appearance:none; flex:1; height:3px; cursor:pointer; min-width:40px; background:rgba(255,255,255,0.08); border-radius:2px; outline:none; }
          .anima-lora-widget .weight-group input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; border-radius:50%; background:linear-gradient(135deg,#5E6AD2,#7B83E0); cursor:pointer; border:2px solid #0a0a0c; box-shadow:0 0 0 1px rgba(94,106,210,0.3),0 2px 6px rgba(0,0,0,0.4); transition:all 0.15s ease-out; }
          .anima-lora-widget .weight-group input[type=range]::-webkit-slider-thumb:hover { transform:scale(1.2); box-shadow:0 0 0 2px rgba(94,106,210,0.3),0 2px 8px rgba(94,106,210,0.3); }
          .anima-lora-widget .weight-group input[type=range]::-moz-range-thumb { width:12px; height:12px; border-radius:50%; background:linear-gradient(135deg,#5E6AD2,#7B83E0); border:2px solid #0a0a0c; cursor:pointer; }
          .anima-lora-widget .weight-val { width:32px; font-size:9px; text-align:center; background:transparent; color:#EDEDEF; border:none; padding:1px 0; font-family:"Geist Mono","JetBrains Mono",monospace; outline:none; }
          .anima-lora-widget .del-btn { background:none; border:none; color:rgba(255,80,80,0.4); cursor:pointer; font-size:13px; padding:0 4px; flex-shrink:0; transition:all 0.15s ease-out; border-radius:3px; line-height:1; }
          .anima-lora-widget .del-btn:hover { color:#ff6b6b; background:rgba(255,80,80,0.1); }
          .anima-lora-widget .lora-toggle { width:26px; height:14px; border-radius:7px; background:rgba(255,255,255,0.10); position:relative; cursor:pointer; flex-shrink:0; transition:all 0.2s var(--ease); box-shadow:inset 0 1px 2px rgba(0,0,0,0.4); }
          .anima-lora-widget .lora-toggle::after { content:""; position:absolute; top:2px; left:2px; width:10px; height:10px; border-radius:50%; background:#6b7280; transition:left 0.2s var(--ease), background 0.2s var(--ease); }
          .anima-lora-widget .lora-toggle.on { background:linear-gradient(135deg,#5E6AD2,#6872D9); box-shadow:inset 0 1px 2px rgba(0,0,0,0.2),0 0 8px rgba(94,106,210,0.35); }
          .anima-lora-widget .lora-toggle.on::after { left:14px; background:#fff; }
          .anima-lora-widget .lora-toggle:hover { opacity:0.9; }
          .anima-lora-widget .lora-row.disabled { opacity:0.45; filter:grayscale(0.6); }
          .anima-lora-widget .lora-row.disabled .lora-name { color:rgba(255,255,255,0.55); }
          .anima-lora-widget .modal-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(2,2,3,0.7); z-index:9999; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px); }
          .anima-lora-widget .modal { background:linear-gradient(180deg,#0f0f12,#0a0a0c); border-radius:12px; padding:16px; max-width:480px; width:90%; max-height:70vh; display:flex; flex-direction:column; border:1px solid rgba(255,255,255,0.08); box-shadow:0 0 0 1px rgba(255,255,255,0.04),0 20px 60px rgba(0,0,0,0.6),0 0 80px rgba(94,106,210,0.06); }
          .anima-lora-widget .modal h3 { margin:0 0 10px; font-size:12px; color:#EDEDEF; font-weight:600; letter-spacing:0.01em; }
          .anima-lora-widget .modal input[type=text] { width:100%; padding:7px 10px; margin-bottom:8px; background:#0a0a0c; color:#EDEDEF; border:1px solid rgba(255,255,255,0.08); border-radius:6px; font-size:11px; box-sizing:border-box; transition:all 0.15s ease-out; }
          .anima-lora-widget .modal input[type=text]:focus { border-color:#5E6AD2; box-shadow:0 0 0 3px rgba(94,106,210,0.12); outline:none; }
          .anima-lora-widget .modal input[type=text]::placeholder { color:rgba(255,255,255,0.3); }
          .anima-lora-widget .modal .modal-loading { text-align:center; padding:24px; color:#8A8F98; font-size:10px; }
          .anima-lora-widget .modal .lora-list { flex:1; overflow-y:auto; max-height:40vh; }
          .anima-lora-widget .modal .lora-item { display:flex; align-items:center; gap:6px; padding:5px 8px; cursor:pointer; border-radius:6px; font-size:10px; color:#8A8F98; transition:all 0.15s ease-out; }
          .anima-lora-widget .modal .lora-item:hover { background:rgba(94,106,210,0.1); color:#EDEDEF; }
          .anima-lora-widget .modal .lora-item .lora-ext { color:rgba(255,255,255,0.2); font-size:9px; }
          .anima-lora-widget .modal .close-btn { margin-top:10px; padding:5px 14px; align-self:flex-end; background:rgba(255,255,255,0.06); color:#8A8F98; border:1px solid rgba(255,255,255,0.06); border-radius:6px; cursor:pointer; font-size:10px; transition:all 0.15s ease-out; }
          .anima-lora-widget .modal .close-btn:hover { background:rgba(255,255,255,0.10); color:#EDEDEF; }
          .anima-lora-widget .anima-tw-popover { position:fixed; z-index:99999; background:linear-gradient(180deg,#141418,#0f0f12); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 12px; max-width:300px; box-shadow:0 0 0 1px rgba(255,255,255,0.04),0 12px 40px rgba(0,0,0,0.6),0 0 60px rgba(94,106,210,0.05); }
          .anima-lora-widget .anima-tw-popover .tw-title { font-weight:600; font-size:10px; color:#8A8F98; margin-bottom:5px; letter-spacing:0.02em; }
          .anima-lora-widget .anima-tw-popover .tw-word { background:rgba(94,106,210,0.12); color:#C8C9CB; padding:3px 8px; border-radius:4px; font-size:10px; margin:2px; display:inline-block; cursor:pointer; transition:all 0.15s ease-out; border:1px solid rgba(94,106,210,0.1); }
          .anima-lora-widget .anima-tw-popover .tw-word:hover { background:rgba(94,106,210,0.25); color:#EDEDEF; }
          .anima-lora-widget .anima-tw-popover .tw-copy-all { display:block; margin-top:6px; padding:4px 10px; background:linear-gradient(135deg,#5E6AD2,#6872D9); color:#EDEDEF; border:none; border-radius:5px; cursor:pointer; font-size:9px; font-weight:500; transition:all 0.15s ease-out; box-shadow:0 0 0 1px rgba(94,106,210,0.2),inset 0 1px 0 0 rgba(255,255,255,0.1); }
          .anima-lora-widget .anima-tw-popover .tw-copy-all:hover { background:linear-gradient(135deg,#6872D9,#7B83E0); }
          .anima-lora-widget .anima-tw-popover .tw-empty { color:rgba(255,255,255,0.3); font-size:10px; }
          .anima-lora-widget::-webkit-scrollbar { width:4px; }
          .anima-lora-widget::-webkit-scrollbar-track { background:transparent; }
          .anima-lora-widget::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.08); border-radius:2px; }

          /* ── ModernDark 设计系统 ── */
          :root {
            --bg-deep:#020203; --bg-base:#050506; --bg-elev:#0a0a0c;
            --surface:rgba(255,255,255,0.05); --surface-hover:rgba(255,255,255,0.08);
            --fg:#EDEDEF; --fg-muted:#8A8F98; --fg-subtle:rgba(255,255,255,0.60);
            --accent:#5E6AD2; --accent-bright:#6872D9; --accent-glow:rgba(94,106,210,0.3);
            --border:rgba(255,255,255,0.06); --border-hover:rgba(255,255,255,0.10);
            --ease:cubic-bezier(0.16,1,0.3,1);
          }
          @keyframes bm-fade-up { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:none} }
          @keyframes bm-scale-in { from{opacity:0;transform:scale(0.96)} to{opacity:1;transform:none} }
          .bm-overlay-enter { animation:bm-fade-up 0.22s ease-out; }
          .bm-modal-enter { animation:bm-scale-in 0.28s var(--ease); }
          .bm-card { transition:box-shadow 0.2s var(--ease), border-color 0.2s var(--ease); }
          .bm-card:hover { border-color:var(--border-hover); box-shadow:0 0 0 1px rgba(255,255,255,0.10), 0 6px 24px rgba(0,0,0,0.40), 0 0 30px rgba(94,106,210,0.06); }
          .bm-li { transition:background 0.15s var(--ease), border-color 0.15s var(--ease); }
          .bm-li:hover { background:rgba(255,255,255,0.05); border-color:var(--border-hover); }
          .bm-sidebar button { transition:background 0.15s var(--ease), color 0.15s var(--ease); }
          .bm-sidebar button:hover { background:rgba(255,255,255,0.05); color:var(--fg); }
          .bm-cats button { transition:all 0.15s var(--ease); }
          .bm-cats button:hover { transform:translateY(-1px); }
          .bm-modal input[type=text], .bm-modal select { transition:border-color 0.15s var(--ease), box-shadow 0.15s var(--ease); }
          .bm-modal input[type=text]:focus, .bm-modal select:focus { border-color:var(--accent) !important; box-shadow:0 0 0 3px rgba(94,106,210,0.15) !important; outline:none; }
          .bm-modal .bm-list::-webkit-scrollbar { width:6px; }
          .bm-modal .bm-list::-webkit-scrollbar-track { background:transparent; }
          .bm-modal .bm-list::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.10); border-radius:3px; }
          .bm-modal .bm-list::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.18); }
        `;

      // ── 工具栏 ──
      const toolbar = document.createElement("div");
      toolbar.className = "toolbar";
      const verifyBtn = this._btn("🔍 验证标签", "btn-verify", "检查输入框中的 <lora:...> 标签能否在本地找到对应文件");
      const extractBtn = this._btn("📥 提取触发词", "btn-verify", "批量查询当前列表所有 LoRA 的触发词（自动刷新列表）");
      const copyAllTwBtn = this._btn("📋 全部触发词", "btn-verify", "一键复制已启用 LoRA 的所有触发词（英文逗号连接）");
      const browseBtn = this._btn("📂 本地 LoRA", "btn-browse", "打开本地 LoRA 浏览窗：预览 C 站图、点击添加 / 分类 / 置顶");
      const clearBtn = this._btn("✕ 清空列表", "btn-clear", "清空当前 LoRA 列表");
      const panelBtn = this._btn("🌐 面板", "btn-verify", "打开本地管理面板（Anima Toolkit）");
      const groupsBtn = this._btn("📁 组", "btn-browse", "LoRA 组：保存当前列表 / 切换 / 删除");
      const updateBtn = this._btn("🔄 更新", "btn-browse", "检查插件版本更新");
      toolbar.append(verifyBtn, extractBtn, copyAllTwBtn, browseBtn, groupsBtn, clearBtn, panelBtn, updateBtn);

      // 检查更新：点击手动检查；build 后自动查一次，有新版时按钮高亮成「有新版本」
      updateBtn.onclick = () => {
        fetch("/anima/version").then((r) => r.json()).then((v) => {
          if (v && v.behind) showToast(`🔄 有新版本 ${v.latest}（当前 ${v.version}），可点按钮前往 GitHub 更新`);
          else if (v && v.latest) showToast(`当前已是最新版本 ${v.version}`);
          else showToast("⚠️ 无法检查更新（网络或 GitHub 不可达）");
        }).catch(() => showToast("⚠️ 无法检查更新"));
      };
      setTimeout(() => {
        fetch("/anima/version").then((r) => r.json()).then((v) => {
          if (v && v.behind) {
            updateBtn.textContent = "🔄 有新版本";
            updateBtn.title = `当前 ${v.version}，最新 ${v.latest}，点击前往 GitHub 更新`;
            updateBtn.onclick = () => window.open(v.url, "_blank");
          }
        }).catch(() => {});
      }, 2000);

      const statusEl = document.createElement("div");
      statusEl.className = "status";

      const listEl = document.createElement("div");
      listEl.className = "list";

      const triggerEl = document.createElement("div");
      triggerEl.className = "trigger-box";

      container.append(toolbar, statusEl, listEl, triggerEl);

      verifyBtn.onclick = () => this._verify(statusEl, listEl, triggerEl);
      extractBtn.onclick = () => this._extractAllTriggerWords(listEl);
      copyAllTwBtn.onclick = () => this._copyAllTriggerWords();
      browseBtn.onclick = () => { showToast("正在加载 LoRA 列表..."); this._browseModal(statusEl); };
      clearBtn.onclick = () => { this.loras = []; this._commit(); this._render(listEl); };
      panelBtn.onclick = () => window.open(PANEL_BASE, "_blank");
      groupsBtn.onclick = () => this._groupsModal(listEl);

      this._render(listEl);
      this.listEl = listEl;

      this.loraWidget.callback = ((orig) => {
        return (v) => {
          orig?.call(this, v);
          this.loras = this._parse(v || "");
          this._render(listEl);
        };
      })(this.loraWidget.callback);

      const dw = this.node.addDOMWidget("anima_batch_ui", "custom", container, { serialize: false });
      dw.computeSize = (width) => [width || 280, Math.min(420, 72 + Math.max(1, this.loras.length) * 30)];

      // 让 lora_syntax 输入框多行/自适应高度
      this._enhanceLoraInput();

      // 自动同步面板「发送到 ComfyUI」的 LoRA：发送后 ≤5s 内节点即可看到，无需手动操作
      this._syncFromBridge(listEl, true);
      if (this._bridgeTimer) clearInterval(this._bridgeTimer);
      this._bridgeTimer = setInterval(() => this._syncFromBridge(listEl, true), 5000);
      const ui = this;
      const origRemoved = this.node.onRemoved;
      this.node.onRemoved = function () {
        if (ui._bridgeTimer) { clearInterval(ui._bridgeTimer); ui._bridgeTimer = null; }
        if (typeof origRemoved === "function") return origRemoved.apply(this, arguments);
      };
    }

    _btn(text, cls, title) {
      const b = document.createElement("button");
      b.textContent = text;
      b.className = cls;
      if (title) b.title = title; // 悬停显示按钮用途
      return b;
    }

    // ── 一键提取所有 LoRA 的触发词 ──
    async _extractAllTriggerWords(listEl) {
      if (!this.loras.length) {
        showToast("⚠️ 当前没有 LoRA，请先输入标签或点击「📂 本地 LoRA」添加");
        return;
      }
      // 只提取尚未查询过的（triggerWordMap 无记录 或 标记为查询失败）
      const pending = this.loras.filter((l) => this.triggerWordMap[l.name] === undefined || this.triggerWordMap[l.name] === null);
      if (!pending.length) {
        showToast("所有 LoRA 的触发词已获取");
        return;
      }
      showToast(`⏳ 正在提取 ${pending.length} 个 LoRA 的触发词...`);
      let done = 0, found = 0, failed = 0;
      for (const l of pending) {
        try {
          const resp = await fetch("/anima/lora/info?name=" + encodeURIComponent(l.name));
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          const src = data.source || "";
          if (data.error || src.startsWith("error") || src.startsWith("http")) throw new Error(data.error || src);
          const tw = data.trainedWords || [];
          this.triggerWordMap[l.name] = tw;
          if (tw.length) found++;
        } catch (e) {
          // 查询失败不标记为"已检查"——用 null 表示失败，允许重试
          this.triggerWordMap[l.name] = null;
          failed++;
          console.error("[Anima] 提取触发词失败:", l.name, e);
        }
        done++;
        if (done % 3 === 0 || done === pending.length) {
          const failMsg = failed ? `，${failed} 个失败` : "";
          showToast(`⏳ 提取中 ${done}/${pending.length}（已找到 ${found} 个有触发词${failMsg}）`);
        }
      }
      this._render(listEl);
      if (found > 0 && failed === 0) {
        showToast(`✅ 提取完成，${found}/${pending.length} 个 LoRA 有触发词`);
      } else if (found > 0 && failed > 0) {
        showToast(`✅ ${found} 个有触发词，${failed} 个查询失败（可重新提取）`);
      } else if (failed > 0) {
        showToast(`❌ ${failed} 个查询失败，请确认 ComfyUI 已重启且能访问 Civitai`);
      } else {
        showToast("ℹ️ 这些 LoRA 均无触发词（C 站未提供）");
      }
    }
    // ── 获取单个 LoRA 的触发词（共享工具，含失败标记） ──
    _fetchTw(name, onDone) {
      fetch("/anima/lora/info?name=" + encodeURIComponent(name))
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((data) => {
          const src = data.source || "";
          if (data.error || src.startsWith("error") || src.startsWith("http")) {
            throw new Error(data.error || src);
          }
          const tw = data.trainedWords || [];
          this.triggerWordMap[name] = tw;
          onDone && onDone(tw);
        })
        .catch((e) => {
          // 失败标记为 null，允许重试；不误判为"无触发词"
          this.triggerWordMap[name] = null;
          console.error("[Anima] 获取触发词失败:", name, e);
          showToast("❌ 获取失败，请确认 ComfyUI 已重启: " + e.message);
        });
    }

    // ── 一键复制已启用 LoRA 的所有触发词（英文逗号连接，句末带逗号匹配后续提示词） ──
    async _copyAllTriggerWords() {
      const enabled = this.loras.filter((l) => !l.disabled);
      if (!enabled.length) { showToast("当前没有启用的 LoRA"); return; }
      const parts = [];
      for (const l of enabled) {
        let tw = this.triggerWordMap[l.name];
        if (!Array.isArray(tw)) {
          // 未查询过 → 现查（复用 /anima/lora/info）
          try {
            const resp = await fetch("/anima/lora/info?name=" + encodeURIComponent(l.name));
            const data = await resp.json();
            const src = data.source || "";
            if (data.error || src.startsWith("error") || src.startsWith("http")) throw new Error(src);
            tw = data.trainedWords || [];
            this.triggerWordMap[l.name] = tw;
          } catch {
            this.triggerWordMap[l.name] = null;
            tw = null;
          }
        }
        if (tw && tw.length) parts.push(tw.join(", "));
      }
      if (!parts.length) { showToast("这些 LoRA 都没有触发词"); return; }
      copyText(parts.join(", ") + ",");
      showToast(`已复制 ${parts.length} 个 LoRA 的触发词（逗号连接）`);
    }

    // 加载工作流/同步后自动提取所有 LoRA 的触发词，逐个更新行内提示，不重渲染整个列表
    _autoFetchTriggerWords() {
      this.loras.forEach((l) => {
        if (this.triggerWordMap[l.name] !== undefined) return;
        this._fetchTw(l.name, (tw) => {
          if (!this.listEl) return;
          const rows = this.listEl.querySelectorAll(".lora-row");
          rows.forEach((row) => {
            if (row.dataset.loraName !== l.name) return;
            const hint = row.querySelector(".lora-tw-hint");
            if (hint) {
              hint.textContent = tw.length
                ? "📝 " + tw.slice(0, 2).join(", ") + (tw.length > 2 ? "..." : "")
                : "无触发词";
            }
          });
        });
      });
    }

    // ── 渲染 LoRA 卡片 ──
    _render(listEl) {
      listEl.innerHTML = "";
      if (!this.loras.length) {
        listEl.innerHTML = '<div class="empty-msg">暂无 LoRA，点击「📂 本地 LoRA」添加</div>';
        return;
      }
      this.loras.forEach((l, i) => {
        const row = document.createElement("div");
        row.className = "lora-row";
        row.classList.toggle("disabled", !!l.disabled);
        row.dataset.loraName = l.name;

        // ── 拖拽区域（仅在 drag-area 上可拖拽） ──
        const dragArea = document.createElement("span");
        dragArea.className = "drag-area";
        dragArea.draggable = true;
        dragArea.innerHTML = `<span class="drag-hint">⠿</span>`;

        // ── 启用/禁用开关（关闭则失效但保留在列表） ──
        const toggle = document.createElement("div");
        toggle.className = "lora-toggle" + (l.disabled ? "" : " on");
        toggle.title = l.disabled ? "已禁用（不参与生成），点击启用" : "点击禁用（暂时不参与生成）";
        toggle.onclick = (e) => {
          e.stopPropagation();
          l.disabled = !l.disabled;
          this._commit();
          this._render(listEl);
        };

        dragArea.ondragstart = (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(i));
          row.classList.add("dragging");
        };
        dragArea.ondragend = () => row.classList.remove("dragging");

        // ── 行作为拖放目标 ──
        row.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; document.querySelectorAll(".anima-lora-widget .lora-row.drag-over").forEach((el) => el.classList.remove("drag-over")); row.classList.add("drag-over"); };
        row.ondragleave = () => row.classList.remove("drag-over");
        row.ondrop = (e) => {
          e.preventDefault();
          row.classList.remove("drag-over");
          const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
          if (isNaN(fromIdx) || fromIdx === i) return;
          const [item] = this.loras.splice(fromIdx, 1);
          this.loras.splice(i, 0, item);
          this._commit();
          this._render(listEl);
        };

        // ── LoRA 名称（悬停预览触发词，点击复制） ──
        const name = document.createElement("span");
        name.className = "lora-name";
        name.textContent = l.name.length > 16 ? l.name.slice(0, 13) + "..." : l.name;
        name.title = l.name; // 原生悬浮提示完整名（兜底，不依赖弹窗逻辑）
        let tooltipTimer = null;
        name.onmouseenter = () => {
          clearTimeout(tooltipTimer);
          const doShow = () => {
            const ww = this.triggerWordMap[l.name];
            if (ww !== undefined && ww !== null) {
              this._showTwTooltip(name, l.name, "hover");
            } else {
              // 懒加载（undefined=未查过，null=上次失败，都重新查）
              this._fetchTw(l.name, (tw) => {
                this._showTwTooltip(name, l.name, "hover");
                const twHint = row.querySelector(".lora-tw-hint");
                if (twHint) twHint.textContent = tw.length ? tw.slice(0, 2).join(", ") + (tw.length > 2 ? "..." : "") : "无触发词";
              });
            }
          };
          tooltipTimer = setTimeout(doShow, 400);
        };
        name.onmouseleave = () => {
          clearTimeout(tooltipTimer);
          document.querySelectorAll(".anima-tw-popover").forEach((el) => el.remove());
        };
        name.onclick = (e) => {
          e.stopPropagation();
          const ww = this.triggerWordMap[l.name];
          if (ww && ww.length) {
            // 有触发词 → 复制
            copyText(ww.join(", ") + ",");
            showToast(`已复制触发词: ${ww[0]}${ww.length > 1 ? " 等" + ww.length + "个" : ""}`);
          } else if (ww === null) {
            // 上次查询失败 → 重试
            showToast("⏳ 重新获取触发词...");
            this._fetchTw(l.name, (tw) => {
              if (tw.length) {
                copyText(tw.join(", ") + ",");
                showToast(`已复制触发词: ${tw[0]}${tw.length > 1 ? " 等" + tw.length + "个" : ""}`);
              } else {
                showToast("该 LoRA 无触发词");
              }
            });
          } else if (Array.isArray(ww)) {
            // 已确认无触发词
            showToast("该 LoRA 无触发词");
          } else {
            // 还没加载过，先加载看有没有触发词
            showToast("⏳ 获取触发词...");
            this._fetchTw(l.name, (tw) => {
              if (tw.length) {
                copyText(tw.join(", ") + ",");
                showToast(`已复制触发词: ${tw[0]}${tw.length > 1 ? " 等" + tw.length + "个" : ""}`);
              } else {
                showToast("该 LoRA 无触发词");
              }
            });
          }
        };

        // ── 触发词预览（小字灰显） ──
        const twHint = document.createElement("span");
        twHint.className = "lora-tw-hint";
        const existingTw = this.triggerWordMap[l.name];
        if (existingTw !== undefined) {
          twHint.textContent = existingTw.length ? "📝 " + existingTw.slice(0, 2).join(", ") + (existingTw.length > 2 ? "..." : "") : "";
        } else {
          twHint.textContent = ""; // 悬停后自动加载
        }

        // ── 权重滑块 ──
        const slider = document.createElement("input");
        slider.type = "range"; slider.min = "0"; slider.max = "2"; slider.step = "0.05";
        slider.value = String(l.weight);
        slider.className = "weight-group";

        // ── 权重数值（纯文本，无箭头） ──
        const valSpan = document.createElement("input");
        valSpan.className = "weight-val";
        valSpan.type = "text"; valSpan.inputMode = "decimal";
        valSpan.value = l.weight.toFixed(2);

        const update = () => {
          l.weight = clamp(parseFloat(slider.value), 0, 2);
          valSpan.value = l.weight.toFixed(2);
        };
        function clamp(v, min, max) { return isNaN(v) ? 0 : Math.max(min, Math.min(max, v)); }

        // oninput 只更新数值；onchange（松开滑块）才 commit。
        // 否则每次 input 触发 graph.change() 重建 DOM widget，滑块被替换导致拖动中断。
        slider.oninput = update;
        slider.onchange = () => { update(); this._commit(); };
        valSpan.onchange = () => {
          const v = parseFloat(valSpan.value);
          if (!isNaN(v) && v >= 0 && v <= 2) { slider.value = String(v); update(); this._commit(); }
          else { valSpan.value = l.weight.toFixed(2); }
        };
        valSpan.onkeydown = (e) => { if (e.key === "Enter") valSpan.blur(); };

        // ── 删除 ──
        const del = document.createElement("button");
        del.className = "del-btn";
        del.textContent = "×";
        del.onclick = () => { this.loras.splice(i, 1); this._commit(); this._render(listEl); };

        // ── 分类 / 常用次数小标签 ──
        const metaBadge = document.createElement("span");
        metaBadge.className = "lora-meta-badge";
        const _m = (this.meta && this.meta.loraMeta && this.meta.loraMeta[l.name]) || {};
        const _cats = (_m.categories || []).slice(0, 1).join("");
        const _cnt = _m.count || 0;
        metaBadge.textContent = (_cats ? "🏷" + _cats : "") + (_cnt ? " " + _cnt + "次" : "");
        metaBadge.style.cssText = "font-size:9px;color:#8A8F98;opacity:0.85;white-space:nowrap;flex-shrink:0;";

        row.append(dragArea, toggle, name, metaBadge, twHint, slider, valSpan, del);
        listEl.appendChild(row);
      });
    }

    // ── 验证桥接 ──
    async _verify(statusEl, listEl, triggerEl) {
      statusEl.textContent = "⏳ 验证中...";
      statusEl.style.color = "#aaa";
      try {
        const text = this.loraWidget.value || "";
        const resp = await fetch("/anima/bridge/status?text=" + encodeURIComponent(text));
        const data = await resp.json();
        if (!data.bridge_found) {
          statusEl.innerHTML = "⚠️ 输入中没有有效的 &lt;lora:...&gt; 标签";
          statusEl.style.color = "#f44"; return;
        }
        const total = data.loras.length;
        const found = data.loras.filter((l) => l.status === "found").length;
        const missing = data.loras.filter((l) => l.status === "not_found");
        const src = data.source === "memory" ? "HTTP" : data.source === "inline" ? "内联" : data.source === "file" ? "文件" : "?";
        statusEl.innerHTML = `🔍 ${total} 个 LoRA，${found} 个已找到 / ${missing.length} 个缺失 (${src})`;
        if (missing.length) {
          statusEl.innerHTML += ` <button class="verify-missing-btn" style="padding:2px 8px;background:linear-gradient(135deg,#5E6AD2,#6872D9);color:#EDEDEF;border:none;border-radius:5px;cursor:pointer;font-size:9px;margin-left:4px;box-shadow:0 0 0 1px rgba(94,106,210,0.3);">🔎 查找缺失 LoRA</button>`;
          statusEl.querySelector(".verify-missing-btn").onclick = () => this._showMissingSearch(missing);
        }
        statusEl.style.color = found === total ? "#4caf50" : found > 0 ? "#ff9800" : "#f44";

        // 验证端点不返回触发词，不能覆盖已提取到的数据（否则已查到的触发词会变"无触发词"）
        data.loras.forEach((l) => {
          if (l.trigger_words && l.trigger_words.length && !this.triggerWordMap[l.name]) {
            this.triggerWordMap[l.name] = l.trigger_words;
          }
        });
      } catch (e) {
        statusEl.textContent = "❌ 验证失败: " + e.message;
        statusEl.style.color = "#f44";
      }
    }

    // ── 缺失 LoRA 的 C 站查找弹窗：预览图 + 进 C 站 + 下载 ──
    // ── 缺失 LoRA 弹窗：复制名称 + 前往 C 站搜索（把搜索交给用户，绕开 API 匹配不准） ──
    _showMissingSearch(missingList) {
      const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      // 弹窗追加到 document.body，widget 内联样式不作用，必须用内联样式保证可见
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(2,2,3,0.72);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);";
      const modal = document.createElement("div");
      modal.className = "modal";
      modal.style.cssText = "background:linear-gradient(180deg,#0f0f12,#0a0a0c);border-radius:14px;padding:16px;width:94vw;max-width:460px;max-height:80vh;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,0.10);box-shadow:0 0 0 1px rgba(255,255,255,0.04),0 20px 60px rgba(0,0,0,0.6);";
      modal.innerHTML = `<h3 style="margin:0 0 6px;font-size:12px;color:#EDEDEF;font-weight:600;">🔎 缺失 LoRA — 前往 C 站查找</h3>
        <div style="font-size:10px;color:#8A8F98;margin-bottom:8px;">先复制 lora 名称，再前往 C 站搜索下载</div>
        <div style="flex:1;overflow-y:auto;">${missingList.map((m) => `
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;padding:7px 8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;">
            <span style="flex:1;font-size:11px;color:#EDEDEF;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(m.name)}">${esc(m.name)}</span>
            <button class="ms-copy" data-name="${esc(m.name)}" style="padding:3px 8px;background:rgba(255,255,255,0.08);color:#EDEDEF;border:1px solid rgba(255,255,255,0.1);border-radius:5px;cursor:pointer;font-size:10px;flex-shrink:0;">📋 复制</button>
            <button class="ms-cs" data-name="${esc(m.name)}" style="padding:3px 8px;background:linear-gradient(135deg,#5E6AD2,#6872D9);color:#EDEDEF;border:none;border-radius:5px;cursor:pointer;font-size:10px;flex-shrink:0;">🔗 前往 C 站搜索</button>
          </div>`).join("")}</div>
        <button class="close-btn" style="margin-top:10px;padding:5px 14px;align-self:flex-end;background:rgba(255,255,255,0.06);color:#8A8F98;border:1px solid rgba(255,255,255,0.06);border-radius:6px;cursor:pointer;font-size:10px;">关闭</button>`;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.onclick = (e) => { if (e.target === overlay) close(); };
      modal.querySelector(".close-btn").onclick = close;
      document.addEventListener("keydown", function h(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", h); } });
      modal.addEventListener("click", (e) => {
        const copyBtn = e.target.closest(".ms-copy");
        if (copyBtn) { copyText(copyBtn.dataset.name); showToast("已复制: " + copyBtn.dataset.name); return; }
        const cs = e.target.closest(".ms-cs");
        if (cs) window.open("https://civitai.com/search/models?query=" + encodeURIComponent(cs.dataset.name) + "&type=LORA", "_blank");
      });
    }

    // ── 从面板同步 LoRA（消费 /anima/bridge 数据，面板「发送到 ComfyUI」后节点即可看到） ──
    async _syncFromBridge(listEl, silent) {
      try {
        const resp = await fetch("/anima/bridge/status");
        if (!resp.ok) return 0;
        const data = await resp.json();
        if (!data || !data.bridge_found || !Array.isArray(data.loras) || !data.loras.length) return 0;
        const ts = data.updated_at || 0;
        if (this._lastBridgeTs && ts <= this._lastBridgeTs) return 0;
        let added = 0;
        data.loras.forEach((l) => {
          if (!l || !l.name) return;
          if (!this.loras.some((e) => e.name.toLowerCase() === l.name.toLowerCase())) {
            this.loras.push({ name: l.name, weight: typeof l.model_strength === "number" ? l.model_strength : 1.0 });
            added++;
          }
          if (l.trigger_words && l.trigger_words.length && !this.triggerWordMap[l.name]) {
            this.triggerWordMap[l.name] = l.trigger_words;
          }
        });
        this._lastBridgeTs = ts;
        if (added > 0) {
          this._commit();
          if (listEl) this._render(listEl);
          if (!silent) showToast(`📥 已从面板同步 ${added} 个 LoRA`);
        }
        return added;
      } catch (e) {
        return 0;
      }
    }

    // ── 让 lora_syntax 多行输入框高度随内容自适应（容纳更多 LoRA 标签） ──
    _enhanceLoraInput() {
      let done = false;
      const attempt = () => {
        if (done) return;
        const w = this.loraWidget;
        if (!w) return;
        const el = (w.inputEl) || (w.element && w.element.querySelector("textarea")) || (w.element && w.element.querySelector("input"));
        if (!el) return;
        done = true;
        el.style.minHeight = "64px";
        el.style.lineHeight = "1.45";
        el.style.fontFamily = "monospace";
        el.style.fontSize = "11px";
        el.style.resize = "vertical";
        el.style.overflowY = "auto";
        el.style.whiteSpace = "pre-wrap";
        const autosize = () => {
          el.style.height = "auto";
          el.style.height = Math.min(Math.max(el.scrollHeight + 4, 64), 220) + "px";
        };
        el.addEventListener("input", autosize);
        autosize();
        if (this.node.graph) this.node.graph.setDirtyCanvas(true, true);
      };
      attempt();
      setTimeout(attempt, 100);
      setTimeout(attempt, 500);
    }

    // ── LoRA 组管理（一键切换 / 删除） ──
    _groupsModal(listEl) {
      fetch("/anima/meta").then((r) => r.json()).catch(() => ({ loraGroups: [] }))
        .then((metaData) => {
          const groups = metaData.loraGroups || [];
          const overlay = document.createElement("div");
          overlay.className = "modal-overlay";
          overlay.style.cssText = "position:fixed;inset:0;background:rgba(10,10,15,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);";
          const modal = document.createElement("div");
          modal.style.cssText = "background:#14141c;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px;width:340px;max-height:75vh;overflow-y:auto;color:#EDEDEF;";
          const title = document.createElement("h3");
          title.style.cssText = "margin:0 0 8px;font-size:13px;";
          title.textContent = `📁 LoRA 组（${groups.length}）`;
          modal.appendChild(title);

          // ── 保存当前列表为新组（合并「保存组」按钮功能） ──
          const active = this.loras.filter((l) => !l.disabled);
          if (active.length) {
            const saveWrap = document.createElement("div");
            saveWrap.style.cssText = "display:flex;gap:6px;margin-bottom:8px;";
            const nameInput = document.createElement("input");
            nameInput.type = "text";
            nameInput.placeholder = `保存当前 ${active.length} 个 LoRA 为新组...`;
            nameInput.style.cssText = "flex:1;padding:6px 8px;background:#0a0a0c;color:#EDEDEF;border:1px solid rgba(255,255,255,0.08);border-radius:6px;font-size:11px;outline:none;";
            const saveBtn = document.createElement("button");
            saveBtn.textContent = "💾 保存";
            saveBtn.style.cssText = "padding:5px 12px;background:linear-gradient(135deg,#5E6AD2,#6872D9);color:#EDEDEF;border:none;border-radius:6px;cursor:pointer;font-size:11px;box-shadow:0 0 0 1px rgba(94,106,210,0.3);";
            const doSave = async () => {
              const name = nameInput.value.trim();
              if (!name) { showToast("请输入组名"); return; }
              const meta = await fetch("/anima/meta").then((r) => r.json()).catch(() => ({ loraGroups: [] }));
              const gs = meta.loraGroups || [];
              gs.push({ name, loras: active.map((l) => ({ name: l.name, weight: l.weight })) });
              meta.loraGroups = gs;
              await fetch("/anima/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) }).catch(() => {});
              showToast(`✅ 已保存组「${name}」（${active.length} 个 LoRA）`);
              overlay.remove();
              this._groupsModal(listEl);
            };
            saveBtn.onclick = doSave;
            nameInput.onkeydown = (e) => { if (e.key === "Enter") doSave(); };
            saveWrap.append(nameInput, saveBtn);
            modal.appendChild(saveWrap);
          }

          if (!groups.length) {
            const empty = document.createElement("p");
            empty.style.cssText = "color:#8A8F98;font-size:11px;margin:8px 0;";
            empty.textContent = "暂无组，在上方输入组名保存当前列表";
            modal.appendChild(empty);
          }
          groups.forEach((g) => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);";
            const label = document.createElement("span");
            label.style.cssText = "flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            label.textContent = `📁 ${g.name}（${(g.loras || []).length}）`;
            const loadBtn = document.createElement("button");
            loadBtn.textContent = "切换";
            loadBtn.style.cssText = "padding:3px 8px;border:1px solid rgba(94,106,210,0.4);border-radius:5px;cursor:pointer;font-size:11px;background:rgba(94,106,210,0.15);color:#9aa5ff;";
            loadBtn.onclick = () => {
              this.loras = (g.loras || []).map((l) => ({ name: l.name, weight: l.weight }));
              this._commit();
              if (listEl) this._render(listEl);
              overlay.remove();
              showToast(`✅ 已切换组「${g.name}」（${this.loras.length} 个 LoRA）`);
            };
            const delBtn = document.createElement("button");
            delBtn.textContent = "删除";
            delBtn.style.cssText = "padding:3px 8px;border:1px solid rgba(255,80,80,0.3);border-radius:5px;cursor:pointer;font-size:11px;background:transparent;color:#f66;";
            delBtn.onclick = async () => {
              if (!window.confirm(`删除组「${g.name}」？`)) return;
              metaData.loraGroups = metaData.loraGroups.filter((x) => x.name !== g.name);
              await fetch("/anima/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metaData) }).catch(() => {});
              overlay.remove();
              this._groupsModal(listEl);
            };
            row.append(label, loadBtn, delBtn);
            modal.appendChild(row);
          });
          overlay.appendChild(modal);
          overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
          document.body.appendChild(overlay);
        });
    }

    // ── 浏览 LoRA ──
    // ── 浏览 LoRA（大图网格：收藏/置顶/分类） ──
    // ── 浏览 LoRA（列表/网格 + 收藏/置顶/分类 + 虚拟滚动） ──
    _browseModal(statusEl) {
      try {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay bm-overlay-enter";
      overlay.style.cssText = "position:fixed;inset:0;background:radial-gradient(ellipse at top,rgba(10,10,15,0.85) 0%,rgba(2,2,3,0.92) 60%,rgba(2,2,3,0.96) 100%);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);";
      const modal = document.createElement("div");
      modal.className = "modal bm-modal-enter bm-modal";
      modal.style.cssText = "background:linear-gradient(180deg,rgba(20,20,28,0.9),rgba(10,10,14,0.95)),radial-gradient(ellipse at top,rgba(94,106,210,0.06),transparent 60%);border-radius:14px;padding:16px;width:94vw;max-width:980px;max-height:88vh;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,0.10);box-shadow:0 0 0 1px rgba(255,255,255,0.05),0 24px 70px rgba(0,0,0,0.7),0 0 100px rgba(94,106,210,0.08),inset 0 1px 0 0 rgba(255,255,255,0.06);";
      modal.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
          <h3 style="margin:0;font-size:13px;color:#EDEDEF;font-weight:600;">📂 本地 LoRA</h3>
          <span style="font-size:10px;color:rgba(255,255,255,0.35);" class="bm-total"></span>
          <span style="flex:1"></span>
          <button class="bm-mode" style="padding:3px 8px;background:rgba(94,106,210,0.2);color:#9aa5ff;border:1px solid rgba(94,106,210,0.3);border-radius:5px;cursor:pointer;font-size:9px;">☰ 列表</button>
          <button class="bm-url" title="从 C 站链接下载 LoRA 到本地" style="padding:3px 8px;background:rgba(94,106,210,0.2);color:#9aa5ff;border:1px solid rgba(94,106,210,0.3);border-radius:5px;cursor:pointer;font-size:9px;">🔗 URL 下载</button>
          <button class="bm-newcat" style="padding:3px 8px;background:rgba(255,255,255,0.06);color:#8A8F98;border:1px solid rgba(255,255,255,0.08);border-radius:5px;cursor:pointer;font-size:9px;">➕ 分类</button>
          <button class="bm-batch-toggle" style="padding:3px 8px;background:rgba(255,255,255,0.06);color:#8A8F98;border:1px solid rgba(255,255,255,0.08);border-radius:5px;cursor:pointer;font-size:9px;">☑ 批量</button>
          <button class="bm-close" style="padding:3px 10px;background:rgba(255,80,80,0.12);color:#ff6b6b;border:1px solid rgba(255,80,80,0.2);border-radius:5px;cursor:pointer;font-size:9px;">✕ 关闭</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input class="bm-search" type="text" placeholder="搜索 LoRA..." style="flex:1;padding:5px 9px;background:#0a0a0c;color:#EDEDEF;border:1px solid rgba(255,255,255,0.08);border-radius:6px;font-size:11px;outline:none;">
          <select class="bm-sort" style="padding:5px 8px;background:#0a0a0c;color:#8A8F98;border:1px solid rgba(255,255,255,0.08);border-radius:6px;font-size:10px;outline:none;">
            <option value="name">按名称</option>
            <option value="size">按大小</option>
            <option value="date">按日期</option>
          </select>
        </div>
        <div class="bm-body" style="flex:1;display:flex;gap:10px;min-height:0;">
          <div class="bm-sidebar" style="width:130px;flex-shrink:0;overflow-y:auto;border-right:1px solid rgba(255,255,255,0.06);padding-right:6px;"></div>
          <div class="bm-list" style="flex:1;overflow-y:auto;position:relative;padding:2px;"></div>
        </div>
        <div class="bm-batchbar" style="display:none;margin-top:8px;"></div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const listEl = modal.querySelector(".bm-list");
      const sidebarEl = modal.querySelector(".bm-sidebar");
      const totalEl = modal.querySelector(".bm-total");
      const searchInput = modal.querySelector(".bm-search");
      const sortEl = modal.querySelector(".bm-sort");
      const modeBtn = modal.querySelector(".bm-mode");
      const batchToggle = modal.querySelector(".bm-batch-toggle");
      const batchBar = modal.querySelector(".bm-batchbar");
      const closeBtn = modal.querySelector(".bm-close");
      const newCatBtn = modal.querySelector(".bm-newcat");

      // ── 从 C 站链接批量下载 LoRA ──
      const urlBtn = modal.querySelector(".bm-url");
      urlBtn?.addEventListener("click", () => {
        showBatchDownloadDialog(() => {
          fetch("/anima/loras").then((r) => r.json()).then((d) => {
            allLoras = (d.loras || []).map((l) => ({ ...l }));
            totalEl.textContent = `共 ${allLoras.length} 个`;
            renderSidebar();
            renderCurrent();
          }).catch(() => {});
        });
      });

      let meta = { categories: [], loraMeta: {}, loraGroups: [] };
      this.meta = meta;
      let allLoras = [];
      let mode = "grid";
      let batchMode = false;
      let curFilter = "all";
      const selected = new Set();
      if (!this._imgCache) this._imgCache = {};

      const ITEM_W = 150, GAP = 10, IMG_H = 150, INFO_H = 62, ROW_H = IMG_H + INFO_H + GAP;

      const saveMeta = () => {
        fetch("/anima/meta", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) }).catch(() => {});
      };
      const loraMeta = (name) => meta.loraMeta[name] || { categories: [], favorite: false, pinned: false, count: 0 };
      const ensureMeta = (name) => meta.loraMeta[name] || (meta.loraMeta[name] = { categories: [], favorite: false, pinned: false, count: 0 });
      const bumpCount = (name) => { const em = ensureMeta(name); em.count = (em.count || 0) + 1; saveMeta(); };
      const getInfo = (name) => fetch("/anima/lora/info?name=" + encodeURIComponent(name)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      // C 站图片走后端代理（浏览器无代理无法直连 image.civitai.com）；卡片用 400px 小图省流量
      const imgProxy = (url) => {
        if (!url || !url.startsWith("https://image.civitai.com/")) return url;
        let u = url;
        if (u.includes("original=true")) u = u.replace("original=true", "width=400");
        if (u.includes("width=")) u = u.replace(/width=\d+/g, "width=400");
        return "/anima/image?url=" + encodeURIComponent(u);
      };

      const getMatched = () => {
        const q = (searchInput.value || "").toLowerCase();
        return allLoras
          .filter((l) => {
            const m = loraMeta(l.name);
            if (curFilter === "fav" && !m.favorite) return false;
            if (curFilter === "pin" && !m.pinned) return false;
            if (meta.categories.includes(curFilter) && !m.categories.includes(curFilter)) return false;
            if (q && !l.name.toLowerCase().includes(q)) return false;
            return true;
          })
          .sort((a, b) => {
            // 已添加到节点的 LoRA 置顶（优先于置顶/收藏/名称排序）
            const addedA = this.loras.some((e) => e.name.toLowerCase() === a.name.toLowerCase()) ? 1 : 0;
            const addedB = this.loras.some((e) => e.name.toLowerCase() === b.name.toLowerCase()) ? 1 : 0;
            if (addedA !== addedB) return addedB - addedA;
            const pa = loraMeta(a.name).pinned ? 1 : 0;
            const pb = loraMeta(b.name).pinned ? 1 : 0;
            if (pa !== pb) return pb - pa;
            const fa = loraMeta(a.name).favorite ? 1 : 0;
            const fb = loraMeta(b.name).favorite ? 1 : 0;
            if (fa !== fb) return fb - fa;
            // 常用次数优先
            const ca = loraMeta(a.name).count || 0;
            const cb = loraMeta(b.name).count || 0;
            if (ca !== cb) return cb - ca;
            const k = sortEl.value;
            if (k === "size") return (b.size || 0) - (a.size || 0);
            if (k === "date") return (b.lastModified || 0) - (a.lastModified || 0);
            return a.name.localeCompare(b.name, "zh");
          });
      };

      // ── 侧边栏分类 ──
      const renderSidebar = () => {
        sidebarEl.innerHTML = "";
        const mk = (key, label, count, icon) => {
          const item = document.createElement("button");
          item.style.cssText = `display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px;margin-bottom:2px;border-radius:6px;cursor:pointer;font-size:10px;text-align:left;border:none;background:${curFilter === key ? "rgba(94,106,210,0.25)" : "transparent"};color:${curFilter === key ? "#EDEDEF" : "#8A8F98"};`;
          item.innerHTML = `<span>${icon || ""}${label}</span><span style="margin-left:auto;color:rgba(255,255,255,0.3);font-size:9px;">${count}</span>`;
          item.onclick = () => { curFilter = key; renderSidebar(); renderCurrent(); };
          sidebarEl.appendChild(item);
        };
        mk("all", "全部", allLoras.length, "");
        mk("fav", "收藏", allLoras.filter((l) => loraMeta(l.name).favorite).length, "⭐");
        mk("pin", "置顶", allLoras.filter((l) => loraMeta(l.name).pinned).length, "📌");
        meta.categories.forEach((cat) => {
          mk(cat, cat, allLoras.filter((l) => loraMeta(l.name).categories.includes(cat)).length, "🏷️");
        });
      };

      // ── 预览图懒加载 ──
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const img = en.target;
          io.unobserve(img);
          const name = img.dataset.loraName;
          getInfo(name).then((info) => {
            if (!info) return;
            this._imgCache[name] = info;
            if (img.isConnected === false) return;
            if (info.previewUrl) {
              img.innerHTML = `<img src="${imgProxy(info.previewUrl)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<span style=font-size:22px>🖼</span>'">`;
            } else {
              img.innerHTML = `<span style="font-size:22px;">${info.source === "not_on_civitai" ? "❌" : "🖼"}</span>`;
            }
            const host = img.closest(".bm-card") || img.closest(".bm-li");
            applyInfo(host, info);
            if (host && info.trainedWords && info.trainedWords.length) this.triggerWordMap[name] = info.trainedWords;
          });
        });
      }, { root: listEl, rootMargin: "250px" });

      // 用 C 站信息更新卡片/行的名称、版本、触发词显示
      const applyInfo = (host, info) => {
        if (!host || !info) return;
        const mnameEl = host.querySelector(".bm-mname");
        const lnameEl = host.querySelector(".bm-lname");
        const metaEl = host.querySelector(".bm-meta");
        const twEl = host.querySelector(".bm-tw");
        const tw = info.trainedWords || [];
        if (twEl) twEl.textContent = tw.length ? "📝 " + tw.slice(0, 2).join(", ") + (tw.length > 2 ? "..." : "") : "";
        if (mnameEl && info.modelName && info.modelName !== host.dataset.name) {
          mnameEl.textContent = info.modelName;
          mnameEl.title = info.modelName;
          if (lnameEl) { lnameEl.textContent = "本地: " + host.dataset.name; lnameEl.style.display = "block"; }
        }
        if (metaEl) {
          const parts = [];
          if (info.versionName) parts.push("v" + info.versionName);
          if (info.creator) parts.push(info.creator);
          if (parts.length) { metaEl.textContent = parts.join(" · "); metaEl.style.display = "block"; }
        }
        // C 站链接按钮：有 modelId 才显示
        if (info.modelId) {
          host.dataset.modelId = info.modelId;
          const cs = host.querySelector(".bm-csite");
          if (cs) cs.style.display = "flex";
        }
      };

      const paintThumb = (imgEl, name) => {
        const cached = this._imgCache[name];
        if (cached && cached.previewUrl) {
          imgEl.innerHTML = `<img src="${imgProxy(cached.previewUrl)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;">`;
        } else {
          io.observe(imgEl);
        }
      };

      // ── 网格卡片 ──
      const buildCard = (l, idx, cols) => {
        const m = loraMeta(l.name);
        const added = this.loras.some((e) => e.name.toLowerCase() === l.name.toLowerCase());
        const card = document.createElement("div");
        card.className = "bm-card";
        card.dataset.name = l.name;
        const left = (idx % cols) * (ITEM_W + GAP);
        const top = Math.floor(idx / cols) * ROW_H;
        card.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${ITEM_W}px;height:${ROW_H - GAP}px;border-radius:8px;overflow:hidden;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);cursor:pointer;`;
        card.innerHTML = `
          <div class="bm-img" data-lora-name="${l.name}" style="position:relative;height:${IMG_H}px;background:rgba(255,255,255,0.04);overflow:hidden;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.15);font-size:22px;">🖼</div>
          <div class="bm-badge" style="position:absolute;top:4px;left:4px;display:${added ? "flex" : "none"};align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:rgba(94,106,210,0.9);color:#fff;font-size:10px;font-weight:700;">✓</div>
          <div style="position:absolute;top:3px;right:3px;display:flex;gap:3px;">
            <button class="bm-fav" title="收藏" style="width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;font-size:11px;background:${m.favorite ? "rgba(255,180,0,0.25)" : "rgba(0,0,0,0.4)"};color:${m.favorite ? "#ffb400" : "rgba(255,255,255,0.4)"};">${m.favorite ? "★" : "☆"}</button>
            <button class="bm-pin" title="置顶" style="width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;font-size:11px;background:${m.pinned ? "rgba(94,106,210,0.3)" : "rgba(0,0,0,0.4)"};color:${m.pinned ? "#8c9bff" : "rgba(255,255,255,0.4)"};">📌</button>
            <button class="bm-catbtn" title="分配分类" style="width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;font-size:11px;background:rgba(0,0,0,0.4);color:rgba(255,255,255,0.4);">🏷️</button>
            <button class="bm-csite" title="打开 C 站页面" style="width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;font-size:11px;background:rgba(0,0,0,0.4);color:rgba(255,255,255,0.4);display:none;">🔗</button>
          </div>
          <div style="position:absolute;bottom:0;left:0;right:0;padding:5px 6px;background:linear-gradient(180deg,transparent,rgba(0,0,0,0.85));">
            <div class="bm-mname" style="font-size:10px;color:#EDEDEF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${l.name}</div>
            <div class="bm-lname" style="font-size:8px;color:rgba(255,255,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;"></div>
            <div class="bm-meta" style="font-size:8px;color:rgba(255,255,255,0.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;"></div>
            <div class="bm-tw" style="font-size:8px;color:rgba(255,255,255,0.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
            <div class="bm-cattags" style="display:flex;gap:2px;flex-wrap:wrap;margin-top:2px;min-height:12px;"></div>
          </div>
        `;
        const catTagsEl = card.querySelector(".bm-cattags");
        m.categories.forEach((cat) => {
          const t = document.createElement("span");
          t.textContent = cat;
          t.title = "点击移除分类";
          t.style.cssText = "padding:0 4px;border-radius:3px;background:rgba(94,106,210,0.2);color:#9aa5ff;font-size:8px;cursor:pointer;";
          t.onclick = (ev) => {
            ev.stopPropagation();
            ensureMeta(l.name).categories = ensureMeta(l.name).categories.filter((c) => c !== cat);
            saveMeta(); renderSidebar(); renderCurrent();
          };
          catTagsEl.appendChild(t);
        });
        card.querySelector(".bm-fav").onclick = (ev) => {
          ev.stopPropagation();
          const mm = ensureMeta(l.name);
          mm.favorite = !mm.favorite;
          saveMeta(); renderSidebar(); renderCurrent();
          showToast(mm.favorite ? "⭐ 已收藏: " + l.name : "已取消收藏: " + l.name);
        };
        card.querySelector(".bm-pin").onclick = (ev) => {
          ev.stopPropagation();
          const mm = ensureMeta(l.name);
          mm.pinned = !mm.pinned;
          saveMeta(); renderSidebar(); renderCurrent();
          showToast(mm.pinned ? "📌 已置顶: " + l.name : "已取消置顶: " + l.name);
        };
        card.querySelector(".bm-catbtn").onclick = (ev) => {
          ev.stopPropagation();
          this._showCatPicker(card, l.name, meta, saveMeta, () => { renderSidebar(); renderCurrent(); });
        };
        card.querySelector(".bm-csite").onclick = (ev) => {
          ev.stopPropagation();
          const mid = card.dataset.modelId;
          if (mid) window.open("https://civitai.com/models/" + mid, "_blank");
          else showToast("该 LoRA 未匹配到 C 站模型");
        };
        card.oncontextmenu = (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          this._showCatContextMenu(card, l.name, meta, saveMeta, () => { renderSidebar(); renderCurrent(); });
        };
        card.onclick = (ev) => {
          if (ev.target.closest(".bm-fav") || ev.target.closest(".bm-pin") || ev.target.closest(".bm-catbtn") || ev.target.closest(".bm-csite") || ev.target.closest(".bm-cattags")) return;
          if (batchMode) {
            if (selected.has(l.name)) { selected.delete(l.name); card.style.outline = ""; }
            else { selected.add(l.name); card.style.outline = "2px solid #5E6AD2"; }
            updateBatchBar();
            return;
          }
          // 非批量模式：点击卡片始终切换 lora 添加/移除；若存在拖拽框选残留则一并清除，
          // 否则残留的 selected 会拦截点击，导致无法取消/添加
          if (selected.size > 0) {
            selected.clear();
            listEl.querySelectorAll(".bm-card").forEach((c) => { c.style.outline = ""; });
            updateBatchBar();
          }
          const existing = this.loras.find((e2) => e2.name.toLowerCase() === l.name.toLowerCase());
          const badge = card.querySelector(".bm-badge");
          if (existing) {
            this.loras = this.loras.filter((e2) => e2.name.toLowerCase() !== l.name.toLowerCase());
            this._commit(); this._render(this.listEl);
            if (badge) badge.style.display = "none";
            showToast("已移除: " + l.name);
          } else {
            this.loras.push({ name: l.name, weight: 1.0 });
            bumpCount(l.name);
            this._commit(); this._render(this.listEl);
            if (badge) badge.style.display = "flex";
            showToast("已添加: " + l.name);
          }
        };
        const cachedInfo = this._imgCache[l.name];
        if (cachedInfo) applyInfo(card, cachedInfo);
        paintThumb(card.querySelector(".bm-img"), l.name);
        return card;
      };

      // ── 列表行 ──
      const buildListRow = (l) => {
        const m = loraMeta(l.name);
        const added = this.loras.some((e) => e.name.toLowerCase() === l.name.toLowerCase());
        const row = document.createElement("div");
        row.className = "bm-li";
        row.dataset.name = l.name;
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;border:1px solid rgba(255,255,255,0.05);margin-bottom:4px;background:rgba(255,255,255,0.02);";
        row.innerHTML = `
          <div class="bm-li-thumb" data-lora-name="${l.name}" style="position:relative;width:36px;height:36px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,0.05);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">🖼</div>
          <div style="flex:1;min-width:0;">
            <div class="bm-mname" style="font-size:10px;color:#EDEDEF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${l.name}</div>
            <div class="bm-lname" style="font-size:8px;color:rgba(255,255,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;"></div>
            <div class="bm-meta" style="font-size:8px;color:rgba(255,255,255,0.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;"></div>
            <div class="bm-tw" style="font-size:8px;color:rgba(255,255,255,0.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
          </div>
          <button class="bm-fav" title="收藏" style="width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;font-size:11px;background:transparent;color:${m.favorite ? "#ffb400" : "rgba(255,255,255,0.35)"};">${m.favorite ? "★" : "☆"}</button>
          <button class="bm-pin" title="置顶" style="width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;font-size:11px;background:transparent;color:${m.pinned ? "#8c9bff" : "rgba(255,255,255,0.35)"};">📌</button>
          <button class="bm-catbtn" title="分配分类" style="width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;font-size:11px;background:transparent;color:rgba(255,255,255,0.35);">🏷️</button>
          <button class="bm-csite" title="打开 C 站页面" style="width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;font-size:11px;background:transparent;color:rgba(255,255,255,0.35);display:none;">🔗</button>
          <span class="bm-li-badge" style="color:${added ? "#4caf50" : "rgba(255,255,255,0.2)"};font-size:11px;font-weight:700;">${added ? "✓" : ""}</span>
        `;
        row.querySelector(".bm-fav").onclick = (ev) => {
          ev.stopPropagation();
          const mm = ensureMeta(l.name);
          mm.favorite = !mm.favorite;
          saveMeta(); renderSidebar(); renderCurrent();
          showToast(mm.favorite ? "⭐ 已收藏: " + l.name : "已取消收藏: " + l.name);
        };
        row.querySelector(".bm-pin").onclick = (ev) => {
          ev.stopPropagation();
          const mm = ensureMeta(l.name);
          mm.pinned = !mm.pinned;
          saveMeta(); renderSidebar(); renderCurrent();
          showToast(mm.pinned ? "📌 已置顶: " + l.name : "已取消置顶: " + l.name);
        };
        row.querySelector(".bm-catbtn").onclick = (ev) => {
          ev.stopPropagation();
          this._showCatPicker(row, l.name, meta, saveMeta, () => { renderSidebar(); renderCurrent(); });
        };
        row.querySelector(".bm-csite").onclick = (ev) => {
          ev.stopPropagation();
          const mid = row.dataset.modelId;
          if (mid) window.open("https://civitai.com/models/" + mid, "_blank");
          else showToast("该 LoRA 未匹配到 C 站模型");
        };
        row.oncontextmenu = (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          this._showCatContextMenu(row, l.name, meta, saveMeta, () => { renderSidebar(); renderCurrent(); });
        };
        row.onclick = (ev) => {
          if (ev.target.closest(".bm-fav") || ev.target.closest(".bm-pin") || ev.target.closest(".bm-catbtn") || ev.target.closest(".bm-csite")) return;
          if (batchMode) {
            if (selected.has(l.name)) { selected.delete(l.name); row.style.background = ""; }
            else { selected.add(l.name); row.style.background = "rgba(94,106,210,0.15)"; }
            updateBatchBar();
            return;
          }
          // 非批量模式：点击行始终切换 lora 添加/移除；清掉拖拽框选残留避免拦截点击
          if (selected.size > 0) {
            selected.clear();
            listEl.querySelectorAll(".bm-li").forEach((r) => { r.style.background = ""; });
            updateBatchBar();
          }
          const existing = this.loras.find((e2) => e2.name.toLowerCase() === l.name.toLowerCase());
          const badge = row.querySelector(".bm-li-badge");
          if (existing) {
            this.loras = this.loras.filter((e2) => e2.name.toLowerCase() !== l.name.toLowerCase());
            this._commit(); this._render(this.listEl);
            if (badge) { badge.textContent = ""; badge.style.color = "rgba(255,255,255,0.2)"; }
            showToast("已移除: " + l.name);
          } else {
            this.loras.push({ name: l.name, weight: 1.0 });
            bumpCount(l.name);
            this._commit(); this._render(this.listEl);
            if (badge) { badge.textContent = "✓"; badge.style.color = "#4caf50"; }
            showToast("已添加: " + l.name);
          }
        };
        const cachedInfo = this._imgCache[l.name];
        if (cachedInfo) applyInfo(row, cachedInfo);
        paintThumb(row.querySelector(".bm-li-thumb"), l.name);
        return row;
      };

      // ── 网格虚拟滚动 ──
      let contentEl = null;
      let cols = 1;
      const paintGrid = () => {
        const matched = getMatched();
        cols = Math.max(1, Math.floor((listEl.clientWidth + GAP) / (ITEM_W + GAP)));
        const rows = Math.max(1, Math.ceil(matched.length / cols));
        contentEl.style.height = rows * ROW_H + "px";
        contentEl.innerHTML = "";
        const st = listEl.scrollTop;
        const vh = listEl.clientHeight;
        const rStart = Math.max(0, Math.floor(st / ROW_H) - 2);
        const rEnd = Math.min(rows - 1, Math.ceil((st + vh) / ROW_H) + 2);
        for (let r = rStart; r <= rEnd; r++) {
          for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            if (idx >= matched.length) break;
            contentEl.appendChild(buildCard(matched[idx], idx, cols));
          }
        }
      };
      const renderGrid = () => {
        listEl.style.display = "block";
        listEl.innerHTML = "";
        contentEl = document.createElement("div");
        contentEl.style.cssText = "position:relative;width:100%;";
        listEl.appendChild(contentEl);
        paintGrid();
      };

      // ── 列表模式 ──
      const renderListMode = () => {
        listEl.style.display = "block";
        listEl.innerHTML = "";
        const matched = getMatched();
        if (!matched.length) {
          listEl.innerHTML = '<div style="padding:30px;text-align:center;color:#666;font-size:11px;">没有匹配的 LoRA</div>';
          return;
        }
        matched.forEach((l) => listEl.appendChild(buildListRow(l)));
      };

      const renderCurrent = () => {
        listEl.scrollTop = 0;
        if (mode === "grid") renderGrid();
        else renderListMode();
      };

      const updateBatchBar = () => {
        if (batchMode) {
          batchBar.style.display = "block";
          batchBar.innerHTML = `<button class="bm-batch-add" style="width:100%;padding:7px 0;background:linear-gradient(135deg,#5E6AD2,#6872D9);color:#EDEDEF;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;">✅ 添加选中 (${selected.size})</button>`;
          batchBar.querySelector(".bm-batch-add").onclick = () => {
            const toAdd = Array.from(selected).filter((n) => !this.loras.some((e) => e.name.toLowerCase() === n.toLowerCase()));
            if (!toAdd.length) { showToast("没有新的 LoRA 可添加"); return; }
            toAdd.forEach((n) => { this.loras.push({ name: n, weight: 1.0 }); bumpCount(n); });
            this._commit(); this._render(this.listEl);
            showToast(`✅ 已添加 ${toAdd.length} 个 LoRA`);
            selected.clear(); updateBatchBar(); renderCurrent();
          };
        } else {
          batchBar.style.display = "none";
          batchBar.innerHTML = "";
        }
      };

      // ── 拖拽框选（选中后右键可批量添加分类） ──
      this._bmSelected = selected;
      let dragBox = { active: false, startX: 0, startY: 0, rect: null, boxed: false };
      const onBMDown = (e) => {
        const target = e.target;
        if (!listEl.contains(target)) return;
        if (target.closest("button, input, select, .bm-fav, .bm-pin, .bm-catbtn, .bm-cattags")) return;
        if (e.button !== 0) return;
        dragBox.active = true; dragBox.boxed = false;
        dragBox.startX = e.pageX; dragBox.startY = e.pageY;
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        e.preventDefault(); e.stopPropagation();
        dragBox.rect = document.createElement("div");
        dragBox.rect.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;z-index:999999;background:rgba(99,102,241,0.12);border:2px dashed rgba(99,102,241,0.6);pointer-events:none;border-radius:4px`;
        document.body.appendChild(dragBox.rect);
      };
      const onBMMove = (e) => {
        if (!dragBox.active || !dragBox.rect) return;
        const l = Math.min(dragBox.startX, e.pageX), t = Math.min(dragBox.startY, e.pageY);
        const r = Math.max(dragBox.startX, e.pageX), b = Math.max(dragBox.startY, e.pageY);
        const sx = window.scrollX, sy = window.scrollY;
        dragBox.rect.style.cssText = `position:fixed;left:${l - sx}px;top:${t - sy}px;width:${r - l}px;height:${b - t}px;z-index:999999;background:rgba(99,102,241,0.12);border:2px dashed rgba(99,102,241,0.6);pointer-events:none;border-radius:4px`;
        if (r - l > 6 || b - t > 6) {
          dragBox.boxed = true;
          const inRect = new Set();
          listEl.querySelectorAll(".bm-card, .bm-li").forEach((el) => {
            const cr = el.getBoundingClientRect();
            const cl = cr.left + sx, ct = cr.top + sy, crr = cr.right + sx, cb = cr.bottom + sy;
            if (l < crr && r > cl && t < cb && b > ct) {
              const nm = el.dataset.name;
              if (nm) inRect.add(nm);
            }
          });
          selected.clear();
          inRect.forEach((n) => selected.add(n));
          listEl.querySelectorAll(".bm-card").forEach((el) => {
            el.style.outline = selected.has(el.dataset.name) ? "2px solid #5E6AD2" : "";
          });
          listEl.querySelectorAll(".bm-li").forEach((el) => {
            el.style.background = selected.has(el.dataset.name) ? "rgba(94,106,210,0.15)" : "";
          });
          updateBatchBar();
        }
      };
      const onBMUp = () => {
        if (!dragBox.active) return;
        dragBox.active = false;
        document.body.style.userSelect = "";
        document.body.style.webkitUserSelect = "";
        if (dragBox.rect) { dragBox.rect.remove(); dragBox.rect = null; }
        if (dragBox.boxed && selected.size > 0) {
          showToast(`已选中 ${selected.size} 个，右键可批量添加分类`);
        }
      };
      const onBMClick = (e) => {
        if (dragBox.boxed) { e.preventDefault(); e.stopPropagation(); dragBox.boxed = false; }
      };
      // 拖拽中途失焦（切屏/alt-tab/切标签页）或鼠标离开页面 → mouseup 不派发，
      // 需手动清理残留选框，否则虚线框会永久滞留页面。
      const cancelBMDrag = () => {
        if (!dragBox.active) return;
        dragBox.active = false;
        document.body.style.userSelect = "";
        document.body.style.webkitUserSelect = "";
        if (dragBox.rect) { dragBox.rect.remove(); dragBox.rect = null; }
      };
      const onBMVisibility = () => { if (document.hidden) cancelBMDrag(); };
      document.addEventListener("mousedown", onBMDown, true);
      document.addEventListener("mousemove", onBMMove, true);
      document.addEventListener("mouseup", onBMUp, true);
      document.addEventListener("click", onBMClick, true);
      window.addEventListener("blur", cancelBMDrag);
      document.addEventListener("visibilitychange", onBMVisibility);
      document.addEventListener("mouseleave", cancelBMDrag);

      // ── 事件 ──
      const closeModal = () => {
        window.removeEventListener("resize", onResize);
        document.removeEventListener("mousedown", onBMDown, true);
        document.removeEventListener("mousemove", onBMMove, true);
        document.removeEventListener("mouseup", onBMUp, true);
        document.removeEventListener("click", onBMClick, true);
        window.removeEventListener("blur", cancelBMDrag);
        document.removeEventListener("visibilitychange", onBMVisibility);
        document.removeEventListener("mouseleave", cancelBMDrag);
        overlay.remove();
      };
      closeBtn.onclick = closeModal;
      overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
      searchInput.onkeydown = (e) => { if (e.key === "Escape") closeModal(); };
      modeBtn.onclick = () => {
        mode = mode === "grid" ? "list" : "grid";
        modeBtn.textContent = mode === "grid" ? "☰ 列表" : "▦ 网格";
        renderCurrent();
      };
      batchToggle.onclick = () => {
        batchMode = !batchMode;
        selected.clear();
        batchToggle.textContent = batchMode ? "✕ 退出批量" : "☑ 批量";
        batchToggle.style.background = batchMode ? "rgba(94,106,210,0.25)" : "rgba(255,255,255,0.06)";
        batchToggle.style.color = batchMode ? "#EDEDEF" : "#8A8F98";
        updateBatchBar(); renderCurrent();
      };
      newCatBtn.onclick = () => {
        const name = window.prompt("新建分类名称：");
        if (!name || !name.trim()) return;
        const n = name.trim();
        if (meta.categories.includes(n)) { showToast("分类已存在"); return; }
        meta.categories.push(n);
        saveMeta(); renderSidebar();
        showToast(`分类已创建: ${n}`);
      };
      searchInput.oninput = () => renderCurrent();
      sortEl.onchange = () => renderCurrent();
      listEl.addEventListener("scroll", () => { if (mode === "grid") paintGrid(); });
      const onResize = () => { if (mode === "grid") paintGrid(); };
      window.addEventListener("resize", onResize);

      // ── 加载数据 ──
      Promise.all([
        fetch("/anima/loras").then((r) => r.json()).catch(() => ({ loras: [] })),
        fetch("/anima/meta").then((r) => r.json()).catch(() => ({ categories: [], loraMeta: {}, loraGroups: [] })),
      ]).then(([lData, mData]) => {
        allLoras = (lData.loras || []).map((l) => ({ ...l }));
        meta = this.meta = { categories: mData.categories || [], loraMeta: mData.loraMeta || {}, loraGroups: mData.loraGroups || [] };
        totalEl.textContent = `共 ${allLoras.length} 个`;
        renderSidebar();
        renderCurrent();
      }).catch((err) => {
        if (statusEl) { statusEl.innerHTML = "❌ 加载失败: " + err.message; statusEl.style.color = "#f44"; }
      });
      } catch (e) {
        console.error("[Anima] 浏览模态框打开失败:", e);
        showToast("❌ 浏览窗口打开失败: " + e.message);
        if (statusEl) { statusEl.innerHTML = "❌ 打开失败: " + e.message; statusEl.style.color = "#f44"; }
      }
    }

    // ── 分类分配下拉 ──
    _showCatPicker(card, name, meta, saveMeta, renderList) {
      document.querySelectorAll(".bm-catpicker").forEach((el) => el.remove());
      const picker = document.createElement("div");
      picker.className = "bm-catpicker";
      picker.style.cssText = "position:fixed;z-index:100000;background:linear-gradient(180deg,#16161b,#101014);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px;max-width:220px;box-shadow:0 12px 40px rgba(0,0,0,0.6);";
      const rect = card.getBoundingClientRect();
      let m = meta.loraMeta[name];
      if (!m) m = meta.loraMeta[name] = { categories: [], favorite: false, pinned: false };
      let html = '<div style="font-size:9px;color:rgba(255,255,255,0.4);margin-bottom:5px;">分配分类</div>';
      if (!meta.categories.length) html += '<div style="font-size:9px;color:#666;padding:4px 0;">暂无分类，点「➕ 分类」创建</div>';
      meta.categories.forEach((cat) => {
        const on = m.categories.includes(cat);
        html += `<button data-cat="${cat}" style="display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;margin-bottom:2px;background:${on ? "rgba(94,106,210,0.25)" : "transparent"};color:#C8C9CB;border:none;border-radius:4px;cursor:pointer;font-size:10px;text-align:left;">${on ? "☑" : "☐"} ${cat}</button>`;
      });
      picker.innerHTML = html;
      picker.querySelectorAll("[data-cat]").forEach((btn) => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const cat = btn.dataset.cat;
          if (m.categories.includes(cat)) m.categories = m.categories.filter((c) => c !== cat);
          else m.categories.push(cat);
          saveMeta(); renderList();
          picker.remove();
        };
      });
      document.body.appendChild(picker);
      let left = rect.right + 6;
      if (left + 220 > window.innerWidth) left = rect.left - 220 - 6;
      picker.style.left = left + "px";
      picker.style.top = Math.max(4, rect.top) + "px";
      const rm = (e) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener("mousedown", rm, true); } };
      setTimeout(() => document.addEventListener("mousedown", rm, true), 10);
    }

    // ── 右键分类菜单（支持拖拽多选批量添加分类） ──
    _showCatContextMenu(host, name, meta, saveMeta, onDone) {
      document.querySelectorAll(".bm-catpicker").forEach((el) => el.remove());
      // 拖拽/批量勾选多个时 → 批量分类
      const sel = this._bmSelected && this._bmSelected.size > 1 && this._bmSelected.has(name)
        ? [...this._bmSelected]
        : null;
      const targets = sel || [name];
      const picker = document.createElement("div");
      picker.className = "bm-catpicker";
      picker.style.cssText = "position:fixed;z-index:100000;background:linear-gradient(180deg,#16161b,#101014);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px;min-width:200px;box-shadow:0 12px 40px rgba(0,0,0,0.6);";
      const rect = host.getBoundingClientRect();
      const apply = (cat) => {
        targets.forEach((n) => {
          const mm = meta.loraMeta[n] || (meta.loraMeta[n] = { categories: [], favorite: false, pinned: false });
          if (!mm.categories.includes(cat)) mm.categories.push(cat);
        });
        saveMeta();
        if (sel && this._bmSelected) this._bmSelected.clear();
        onDone && onDone();
      };
      let html = `<div style="font-size:9px;color:rgba(255,255,255,0.4);margin-bottom:5px;">${sel ? `批量添加分类 (${targets.length} 个)` : "分配分类"}</div>`;
      if (!meta.categories.length) html += '<div style="font-size:9px;color:#666;padding:4px 0;">暂无分类，先点顶部「➕ 分类」创建</div>';
      meta.categories.forEach((cat) => {
        const allOn = targets.every((n) => (meta.loraMeta[n] || {}).categories?.includes(cat));
        html += `<button data-cat="${cat}" style="display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;margin-bottom:2px;background:${allOn ? "rgba(94,106,210,0.25)" : "transparent"};color:#C8C9CB;border:none;border-radius:4px;cursor:pointer;font-size:10px;text-align:left;">${allOn ? "☑" : "☐"} ${cat}</button>`;
      });
      picker.innerHTML = html;
      picker.querySelectorAll("[data-cat]").forEach((btn) => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          apply(btn.dataset.cat);
          picker.remove();
        };
      });
      document.body.appendChild(picker);
      let left = rect.right + 6;
      if (left + 200 > window.innerWidth) left = rect.left - 200 - 6;
      picker.style.left = left + "px";
      picker.style.top = Math.max(4, rect.top) + "px";
      const rm = (e) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener("mousedown", rm, true); } };
      setTimeout(() => document.addEventListener("mousedown", rm, true), 10);
    }

    // ── 触发词 tooltip 弹窗 ──
    _showTwTooltip(anchorEl, loraName, mode) {
      document.querySelectorAll(".anima-tw-popover").forEach((el) => el.remove());

      const words = this.triggerWordMap[loraName];
      const popover = document.createElement("div");
      popover.className = "anima-tw-popover";

      let wordHtml;
      if (words === undefined) {
        wordHtml = '<span class="tw-empty">暂未获取到触发词，请先运行「📥 提取」</span>';
      } else if (words === null) {
        wordHtml = '<span class="tw-empty">❌ 查询失败，可重新提取或悬停重试</span>';
      } else if (words.length) {
        wordHtml = words.map((w) => `<span class="tw-word" data-copy="${w.replace(/"/g, "&quot;")}">${w}</span>`).join("");
        wordHtml += `<button class="tw-copy-all">📋 复制全部</button>`;
      } else {
        wordHtml = '<span class="tw-empty">该 LoRA 无触发词</span>';
      }

      const safeName = String(loraName).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      popover.innerHTML = `<div class="tw-title" style="font-size:11px;color:#EDEDEF;">📄 ${safeName}</div><div class="tw-title">📝 触发词</div><div style="display:flex;flex-wrap:wrap;gap:2px;">${wordHtml}</div>`;
      document.body.appendChild(popover);

      // 定位
      const rect = anchorEl.getBoundingClientRect();
      const pRect = popover.getBoundingClientRect();
      let left = Math.max(4, Math.min(rect.left, window.innerWidth - pRect.width - 4));
      let top = rect.bottom + 4;
      if (top + pRect.height > window.innerHeight) { top = rect.top - pRect.height - 4; }
      popover.style.left = left + "px";
      popover.style.top = top + "px";

      // 事件委托（避免逐个绑定的时序问题）
      popover.addEventListener("click", (e) => {
        const wordEl = e.target.closest(".tw-word");
        if (wordEl) {
          e.stopPropagation();
          const text = wordEl.dataset.copy || wordEl.textContent;
          copyText(text);
          showToast(`已复制: ${text}`);
          return;
        }
        const copyAllBtn = e.target.closest(".tw-copy-all");
        if (copyAllBtn) {
          e.stopPropagation();
          const allText = words ? words.join(", ") + "," : "";
          copyText(allText);
          showToast("已复制全部触发词");
        }
      });

      // 点击外部关闭（hover 模式下由 mouseleave 处理）
      if (mode !== "hover") {
        const closeHandler = (e) => {
          if (!popover.contains(e.target) && e.target !== anchorEl) {
            popover.remove();
            document.removeEventListener("click", closeHandler, true);
          }
        };
        document.addEventListener("click", closeHandler, true);
      }
    }
  }

  init();
})();
