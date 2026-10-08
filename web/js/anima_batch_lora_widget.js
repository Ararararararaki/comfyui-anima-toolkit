// Anima Batch LoRA Widget — 中文界面 + 桥接自动加载 + 触发词复制
import { triggerOverrides, openTriggerWordEditor } from "./anima_lora_trigger_overrides.js";
import { installDOMWidgetSizeSync } from "./anima_dom_widget_size_sync.js";
import { LoRASyntax } from "./shared/lora_syntax.js";
import { LoraInfoClient, LoraLookupSession, filenameLookup } from "./shared/lora_info_client.js";

const loraInfoClient = new LoraInfoClient(filenameLookup());

  const NODE_NAME = "TK Batch LoRA Loader";
  // 权重范围 ±10：滑块类（slider）LoRA 常需要远超 ±2 的强度（例如 -5 / +8）。
  // 后端 anima_batch_lora.py 的 _parse_lora_syntax 用 float() 解析、本身无范围限制，这里只约束 UI 输入。
  const LORA_WEIGHT_MIN = -10;
  const LORA_WEIGHT_MAX = 10;
  // 后端依次查询 Civitai（10s）和档案站（15s），另留文件哈希的准备时间。
  const LORA_INFO_TIMEOUT_MS = 35000;
  const normalizeLoraName = (value) => String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const LOCAL_LORA_CACHE_KEY = "anima_local_loras_v2";
  const LOCAL_LORA_CACHE_TTL = 365 * 24 * 60 * 60 * 1000;
  const BASE_MODEL_UNKNOWN = "__tk_unknown_base_model__";
  const readLocalBaseModelIndex = (loras, serverMeta = {}) => {
    let cache;
    try {
      const raw = localStorage.getItem(LOCAL_LORA_CACHE_KEY);
      if (raw) cache = JSON.parse(raw);
    } catch {
      cache = null;
    }
    const now = Date.now();
    const cacheValid = !!cache && cache.version === 1 && Number.isFinite(cache.timestamp) && cache.timestamp > 0 &&
      cache.timestamp <= now + 60000 && now - cache.timestamp <= LOCAL_LORA_CACHE_TTL && Array.isArray(cache.data);
    const cachedByPath = new Map();
    const ambiguous = new Set();
    const matchedCachePaths = new Set();
    for (const row of cacheValid ? cache.data : []) {
      if (row?.matched !== true || typeof row.name !== "string" || typeof row.matchData?.baseModel !== "string") continue;
      const path = normalizeLoraName(row.name);
      if (!path) continue;
      matchedCachePaths.add(path);
      const baseModel = row.matchData.baseModel.trim();
      if (cachedByPath.has(path) && cachedByPath.get(path) !== baseModel) {
        cachedByPath.delete(path);
        ambiguous.add(path);
      } else if (!ambiguous.has(path)) {
        cachedByPath.set(path, baseModel);
      }
    }
    const byPath = new Map();
    let matchedRows = 0;
    const serverByPath = new Map();
    for (const [name, row] of Object.entries(serverMeta || {})) {
      const path = normalizeLoraName(name);
      const baseModel = typeof row?.baseModel === "string" ? row.baseModel.trim() : "";
      if (!path || !baseModel) continue;
      if (serverByPath.has(path) && serverByPath.get(path) !== baseModel) serverByPath.set(path, "");
      else if (!serverByPath.has(path)) serverByPath.set(path, baseModel);
    }
    for (const lora of loras) {
      const path = normalizeLoraName(lora.relativePath || lora.filename);
      if (!path) continue;
      const serverBaseModel = serverByPath.get(path);
      if (serverBaseModel) {
        matchedRows++;
        byPath.set(path, serverBaseModel);
        continue;
      }
      if (!matchedCachePaths.has(path)) continue;
      matchedRows++;
      if (ambiguous.has(path) || !cachedByPath.has(path)) continue;
      const baseModel = cachedByPath.get(path);
      if (baseModel) byPath.set(path, baseModel);
    }
    const models = [...new Set(byPath.values())].sort((a, b) => a.localeCompare(b, "zh"));
    return { ready: matchedRows > 0, byPath, models };
  };
  // 浏览器内搜索：统一全角字符、大小写、路径/文件名分隔符，允许中文、英文和混合关键词进行包含匹配。
  const normalizeLoraSearchText = (value) => String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\\/_\-.|,，、;；]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const loraSearchTokens = (value) => normalizeLoraSearchText(value).split(" ").filter(Boolean);
  const loraSearchIndex = (lora, meta, info) => {
    const categories = Array.isArray(meta?.categories) ? meta.categories : [];
    const name = [lora?.name, lora?.filename, lora?.relativePath].filter(Boolean).join(" ");
    const model = [info?.modelName, info?.versionName].filter(Boolean).join(" ");
    const creator = info?.creator || "";
    const triggers = Array.isArray(info?.trainedWords) ? info.trainedWords.join(" ") : "";
    const tags = Array.isArray(info?.tags) ? info.tags.join(" ") : "";
    const fields = {
      name: normalizeLoraSearchText(name),
      model: normalizeLoraSearchText(model),
      creator: normalizeLoraSearchText(creator),
      trigger: normalizeLoraSearchText(triggers),
      tag: normalizeLoraSearchText(tags),
      category: normalizeLoraSearchText(categories.join(" ")),
    };
    const all = Object.values(fields).join(" ");
    return { ...fields, all, compact: all.replace(/\s/g, "") };
  };
  const matchesLoraSearch = (index, query) => {
    const normalized = normalizeLoraSearchText(query);
    if (!normalized) return true;
    const phrase = normalized.replace(/\s/g, "");
    // 空格分隔的词采用 AND 语义；无空格中文短语仍按连续片段匹配。
    return loraSearchTokens(normalized).every((token) => index.all.includes(token)) || index.compact.includes(phrase);
  };
  const loraSearchScore = (index, query) => {
    const normalized = normalizeLoraSearchText(query);
    if (!normalized) return 0;
    const phrase = normalized.replace(/\s/g, "");
    let score = index.name.replace(/\s/g, "") === phrase ? 1000 : 0;
    if (index.name.replace(/\s/g, "").startsWith(phrase)) score += 150;
    if (index.model.replace(/\s/g, "").startsWith(phrase)) score += 120;
    if (index.name.includes(normalized)) score += 80;
    if (index.model.includes(normalized)) score += 70;
    if (index.creator.includes(normalized)) score += 40;
    if (index.trigger.includes(normalized)) score += 30;
    if (index.tag.includes(normalized) || index.category.includes(normalized)) score += 20;
    return score;
  };
  // bridge 一次性投递：已应用版本记录（localStorage），重启/刷新不重放历史残留
  const BRIDGE_APPLIED_KEY = "anima_bridge_applied_ts";
  const LORA_INPUT_HEIGHT_KEY = "anima_batch_lora_input_height_v1";
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
  function configuredIconUrl() {
    try {
      const raw = localStorage.getItem("anima_settings");
      if (!raw) return "";
      const value = JSON.parse(raw)?.toolboxIcon;
      if (typeof value === "string" && value.startsWith("data:image/")) return value;
      if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
    } catch (e) {}
    return "";
  }

  // 图标 URL 适配：ComfyUI 0.30+ 的 /extensions/{name}/ 已映射到插件 web/ 目录（无需 web/ 前缀），
  // 旧版映射到插件根（需 web/ 前缀）。自定义图标失败时仍回退到仓库内的菲比图标。
  function setAnimaIcon(img) {
    const custom = configuredIconUrl();
    const sources = [...new Set([
      custom,
      ICON_URL,
      ICON_URL.replace("/img/anima-btn.jpg", "/web/img/anima-btn.jpg"),
    ].filter(Boolean))];
    let sourceIndex = 0;
    img.onerror = () => {
      if (sourceIndex + 1 < sources.length) img.src = sources[++sourceIndex];
    };
    img.src = sources[0] || ICON_URL;
  }

  function refreshAnimaIcons() {
    document.querySelectorAll(".anima-menu-icon").forEach((img) => setAnimaIcon(img));
  }

  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);

    api.registerExtension({
      name: "TK.BatchLoRA.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const orig = nodeType.prototype.onNodeCreated;
        const origAdded = nodeType.prototype.onAdded;
        const origConfigureFn = nodeType.prototype.configure;
        nodeType.prototype.onNodeCreated = function () {
          const r = orig?.apply(this, arguments);
          const loraWidget = this.widgets?.find((w) => w.name === "lora_syntax");
          if (!loraWidget) return r;
          const ui = new BatchLoraWidgetUI(this, loraWidget);
          this._animaUI = ui;
          ui.mount();
          return r;
        };
        // 加载工作流时 widget 值在 configure 阶段才恢复：onAdded 触发时
        // lora_syntax 仍是默认空值，解析不到任何标签，卡片不显示。
        // 因此在 configure（值已恢复）里解析渲染，并用 onAdded 延迟兜底。
        const restoreFromWidget = function (ui) {
          if (!ui || !ui.listEl || ui._disposed) return;
          const v = (ui.loraWidget && ui.loraWidget.value) || "";
          const parsed = ui._parse(v);
          const same = ui.loras.length === parsed.length && ui.loras.every((x, i) => x.name === parsed[i].name && x.weight === parsed[i].weight && x.clipWeight === parsed[i].clipWeight && x.disabled === parsed[i].disabled);
          if (same) return;
          ui.loras = parsed;
          ui._render(ui.listEl);
          if (ui._updateTwStatus) ui._updateTwStatus();
          if (ui._pushTriggerWords) ui._pushTriggerWords();
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
          img.className = "anima-menu-icon";
          setAnimaIcon(img);
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
                tooltip: "打开 TK 工具箱（面板）",
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
              const fbImg = document.createElement("img");
              fbImg.className = "anima-menu-icon";
              fbImg.alt = "工具箱";
              fbImg.style.cssText = "width:18px;height:18px;border-radius:4px;vertical-align:middle;";
              setAnimaIcon(fbImg);
              fb.appendChild(fbImg);
              fb.title = "打开 TK 工具箱（面板）";
              fb.style.cssText = "background:none;border:none;cursor:pointer;padding:4px;";
              fb.onclick = () => window.open(PANEL_BASE, "_blank");
              menu.prepend(fb);
            }
          })();
        };
        attach();
      },
    });

    // 工具箱在新标签页设置图标后，ComfyUI 顶栏即时同步，无需重启页面。
    window.addEventListener("storage", (event) => {
      if (event.key === "anima_settings") refreshAnimaIcons();
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

  // ── 批量下载弹窗（每行一个 C 站链接；提交后由 ComfyUI 后台执行） ──
  function showBatchDownloadDialog(onDone) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(2,2,3,0.72);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);";
    const modal = document.createElement("div");
    modal.style.cssText = "background:#14141c;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px;width:94vw;max-width:520px;max-height:80vh;display:flex;flex-direction:column;color:#EDEDEF;box-shadow:0 0 0 1px rgba(255,255,255,0.05),0 20px 60px rgba(0,0,0,0.6);";
    modal.innerHTML = `<h3 style="margin:0 0 8px;font-size:13px;">🔗 从 C 站链接批量下载模型</h3>
      <div style="font-size:10px;color:#8A8F98;margin-bottom:8px;">支持 LoRA、Checkpoint、VAE 等模型；提交后由 ComfyUI 后台下载，关闭窗口或页面不影响任务</div>
      <textarea class="bd-urls" rows="6" placeholder="https://civitai.com/models/2658471/denia-wuthering-wavesanima&#10;https://civitai.com/models/2529695/xxx?modelVersionId=3094753" style="flex:1;padding:8px;background:#0a0a0c;color:#EDEDEF;border:1px solid rgba(255,255,255,0.08);border-radius:6px;font-size:11px;font-family:monospace;resize:vertical;outline:none;"></textarea>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <input class="bd-token" type="password" value="${(function(){ try { return localStorage.getItem('anima_civitai_token') || ''; } catch(e){ return ''; } })()}" placeholder="C 站 API Key（只读权限即可，下载需登录的模型用）" style="flex:1;padding:7px 9px;background:#0a0a0c;color:#EDEDEF;border:1px solid rgba(255,255,255,0.08);border-radius:6px;font-size:10px;outline:none;min-width:0;">
        <button class="bd-tokenlink" title="打开 C 站账号设置（账号 → API Keys 生成，选只读权限）" style="padding:7px 10px;background:rgba(94,106,210,0.2);color:#9aa5ff;border:1px solid rgba(94,106,210,0.3);border-radius:6px;cursor:pointer;font-size:10px;flex-shrink:0;white-space:nowrap;">🔑 生成 API Key</button>
      </div>
      <div style="font-size:9px;color:#8A8F98;margin-top:4px;">只读权限的 API Key 即可下载需登录的模型</div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:8px;">
        <label style="font-size:10px;color:#BFC2CE;flex:0 0 auto;">保存到</label>
        <select class="bd-target" title="选择 ComfyUI 已注册的模型目录" style="flex:1;min-width:0;padding:7px 8px;background:#0a0a0c;color:#EDEDEF;border:1px solid rgba(255,255,255,0.08);border-radius:6px;font-size:10px;outline:none;">
          <option value="auto">自动（按 C 站模型类型）</option>
        </select>
      </div>
      <div class="bd-target-tip" style="font-size:9px;color:#8A8F98;margin-top:4px;">自动模式：Checkpoint → models/checkpoints，LoRA → models/loras；也可选择其他已注册目录。</div>
      <div class="bd-list" style="margin-top:8px;max-height:130px;overflow-y:auto;"></div>
      <div class="bd-log" style="margin-top:8px;max-height:60px;overflow-y:auto;font-size:10px;color:#8A8F98;white-space:pre-wrap;"></div>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
        <button class="bd-cancel" style="padding:5px 12px;background:rgba(255,255,255,0.08);color:#8A8F98;border:1px solid rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;font-size:11px;">关闭窗口</button>
        <button class="bd-start" style="padding:5px 14px;background:linear-gradient(135deg,#5E6AD2,#6872D9);color:#EDEDEF;border:none;border-radius:6px;cursor:pointer;font-size:11px;">⬇️ 加入后台下载</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    let pollTimer = null;
    let pollBusy = false;
    let completionNotified = false;
    const rows = new Map();
    const close = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      overlay.remove();
    };
    // 修复：拖拽选中文本时鼠标在弹窗外松开也会误关——只有按下和松开都在遮罩上才关闭
    let _downOnOverlay = false;
    overlay.addEventListener("mousedown", (e) => { _downOnOverlay = (e.target === overlay); });
    overlay.addEventListener("click", (e) => { if (e.target === overlay && _downOnOverlay) close(); });
    modal.querySelector(".bd-cancel").onclick = close;
    modal.querySelector(".bd-tokenlink").onclick = () => window.open("https://civitai.com/user/account", "_blank");
    const targetSelect = modal.querySelector(".bd-target");
    const targetTip = modal.querySelector(".bd-target-tip");
    const savedTarget = (() => { try { return localStorage.getItem("anima_civitai_download_target") || "auto"; } catch { return "auto"; } })();
    fetch("/anima/lora/download/targets")
      .then((r) => r.json())
      .then((data) => {
        const targets = Array.isArray(data?.targets) ? data.targets : [];
        if (!targets.length) return;
        targetSelect.replaceChildren(...targets.map((target) => new Option(target.label, target.key)));
        targetSelect.value = targets.some((target) => target.key === savedTarget) ? savedTarget : "auto";
      })
      .catch(() => { if (targetTip) targetTip.textContent = "目录列表加载失败，将使用自动目录；请确认 ComfyUI 后端在线。"; });

    const renderJob = (job) => {
      const progressId = String(job.progressId || "");
      if (!progressId || rows.has(progressId)) return;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:10px;color:#EDEDEF;";
      const nameEl = document.createElement("span");
      nameEl.style.cssText = "width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;";
      nameEl.textContent = String(job.label || job.url || progressId).slice(0, 34);
      nameEl.title = String(job.label || job.url || progressId);
      const barWrap = document.createElement("div");
      barWrap.style.cssText = "flex:1;height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;";
      const bar = document.createElement("div");
      bar.style.cssText = "height:100%;width:0%;background:linear-gradient(135deg,#5E6AD2,#6872D9);transition:width 0.2s;";
      barWrap.appendChild(bar);
      const pctEl = document.createElement("span");
      pctEl.className = "bd-pct";
      pctEl.style.cssText = "width:48px;text-align:right;color:#8A8F98;flex-shrink:0;";
      pctEl.textContent = "排队中";
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "✕";
      cancelBtn.title = "取消后台任务";
      cancelBtn.style.cssText = "padding:2px 6px;background:rgba(255,80,80,0.15);color:#ff6b6b;border:1px solid rgba(255,80,80,0.3);border-radius:4px;cursor:pointer;font-size:10px;flex-shrink:0;line-height:1;";
      cancelBtn.onclick = async () => {
        cancelBtn.disabled = true;
        try { await fetch(`/anima/lora/download/cancel?progressId=${encodeURIComponent(progressId)}`); } catch {}
        pctEl.textContent = "已取消";
      };
      row.append(nameEl, barWrap, pctEl, cancelBtn);
      modal.querySelector(".bd-list").appendChild(row);
      rows.set(progressId, { job, bar, pctEl, cancelBtn, reported: false });
    };

    const updateJob = (progressId, status) => {
      const row = rows.get(progressId);
      if (!row) return;
      const s = status || {};
      const total = Number(s.total || 0);
      const done = Number(s.done || 0);
      if (total > 0) {
        const pc = Math.max(0, Math.min(100, Math.round(done / total * 100)));
        row.bar.style.width = pc + "%";
        row.pctEl.textContent = s.status === "done" ? "✓" : `${pc}%`;
      } else if (s.status === "queued") row.pctEl.textContent = "排队中";
      else if (s.status === "downloading") row.pctEl.textContent = "下载中";
      if (s.status === "retrying") row.pctEl.textContent = total > 0 ? `${Math.round(done / total * 100)}% 续传` : "重试中";
      if (s.status === "done") {
        row.bar.style.width = "100%";
        row.pctEl.textContent = "✓";
        row.cancelBtn.disabled = true;
        if (!row.reported) {
          row.reported = true;
          modal.querySelector(".bd-log").textContent += `✓ ${s.filename || row.job.label || progressId}\n`;
          if (!completionNotified && typeof onDone === "function") { completionNotified = true; onDone(); }
        }
      } else if (s.status === "error") {
        row.pctEl.textContent = s.resumable ? "✗ 可续传" : "✗";
        row.cancelBtn.disabled = true;
        if (!row.reported) { row.reported = true; modal.querySelector(".bd-log").textContent += `✗ ${s.error || "下载失败"}\n`; }
      } else if (s.status === "cancelled") {
        row.pctEl.textContent = "已取消";
        row.cancelBtn.disabled = true;
        if (!row.reported) { row.reported = true; modal.querySelector(".bd-log").textContent += `✗ ${row.job.label || progressId} 已取消\n`; }
      }
    };

    const poll = async () => {
      if (pollBusy || !rows.size) return;
      pollBusy = true;
      try {
        await Promise.all([...rows.keys()].map(async (progressId) => {
          try {
            const sr = await fetch(`/anima/lora/download/status?progressId=${encodeURIComponent(progressId)}`);
            updateJob(progressId, await sr.json());
          } catch {}
        }));
      } finally {
        pollBusy = false;
      }
    };
    const startPolling = () => {
      if (!pollTimer) pollTimer = setInterval(poll, 500);
      poll();
    };
    fetch("/anima/lora/download/list")
      .then((r) => r.json())
      .then((data) => {
        for (const job of (Array.isArray(data?.jobs) ? data.jobs : [])) renderJob(job);
        startPolling();
      })
      .catch(() => {});

    modal.querySelector(".bd-start").onclick = async () => {
      const urls = modal.querySelector(".bd-urls").value.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!urls.length) { showToast("请输入链接"); return; }
      const targetKey = targetSelect?.value || "auto";
      try { localStorage.setItem("anima_civitai_download_target", targetKey); } catch {}
      const logEl = modal.querySelector(".bd-log");
      const startBtn = modal.querySelector(".bd-start");
      const tokenVal = (modal.querySelector(".bd-token")?.value || "").trim();
      if (tokenVal) { try { localStorage.setItem("anima_civitai_token", tokenVal); } catch {} }
      const items = [];
      for (const url of urls) {
        const parsed = parseCivitaiUrl(url);
        if (!parsed) {
          logEl.textContent += `✗ 无法解析: ${url.slice(0, 50)}\n`;
          continue;
        }
        items.push({ ...parsed, target: targetKey, token: tokenVal, url, label: url.slice(0, 240) });
      }
      if (!items.length) { showToast("没有可提交的有效 C 站链接"); return; }
      startBtn.disabled = true;
      try {
        const response = await fetch("/anima/lora/download/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
        for (const job of result.jobs || []) renderJob(job);
        logEl.textContent += `已加入后台下载：${(result.jobs || []).length} 个任务；关闭窗口不影响下载\n`;
        startPolling();
      } catch (error) {
        logEl.textContent += `✗ 提交后台任务失败：${error.message || error}\n`;
      } finally {
        startBtn.disabled = false;
      }
    };
  }

  // ── 更新弹窗：提交检查 + 一键安全更新 ──
  function showUpdateDialog(v, onApplied) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(2,2,3,0.72);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);";
    const modal = document.createElement("div");
    modal.className = "ug-modal";
    modal.style.cssText = "background:#14141c;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px;width:94vw;max-width:520px;max-height:80vh;overflow-y:auto;color:#EDEDEF;box-shadow:0 0 0 1px rgba(255,255,255,0.05),0 20px 60px rgba(0,0,0,0.6);";
    const commitText = v.localCommit && v.remoteCommit ? `<div style="font-size:10px;color:#8A8F98;margin-bottom:8px;font-family:monospace;">${v.localCommit.slice(0, 8)} → ${v.remoteCommit.slice(0, 8)}</div>` : "";
    const autoAvailable = v.canAutoUpdate !== false && Boolean(v.remoteCommit);
    modal.innerHTML = `<h3 style="margin:0 0 6px;font-size:13px;">🔄 发现更新 ${v.latest || "?"}（当前 ${v.version || "?"}）</h3>
      <div style="font-size:10px;color:#8A8F98;margin-bottom:8px;">${autoAvailable ? "可安全下载并覆盖发布文件；不会删除 data、模型或用户配置。" : "自动更新不可用，可打开 GitHub 手动更新。"}</div>
      ${commitText}
      <div class="ug-status" style="display:none;margin-bottom:10px;padding:7px 8px;border:1px solid rgba(155,178,182,.35);border-radius:6px;color:#c2d7d9;background:rgba(155,178,182,.08);font-size:10px;line-height:1.5;"></div>
      <div style="color:#C8C9CB;background:#0a0a0c;border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:8px;font-size:10px;margin-bottom:10px;line-height:1.6;">
        更新完成后必须通过绘世 GUI 重启 ComfyUI，前端页面再按 <b>Ctrl + Shift + R</b> 强制刷新。
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="ug-close" style="padding:5px 12px;background:rgba(255,255,255,0.08);color:#8A8F98;border:1px solid rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;font-size:11px;">关闭</button>
        <button class="ug-goto" style="padding:5px 14px;background:rgba(255,255,255,0.08);color:#EDEDEF;border:1px solid rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;font-size:11px;">手动更新</button>
        ${autoAvailable ? '<button class="ug-apply" style="padding:5px 14px;background:linear-gradient(135deg,#d0c9bb,#f0ece4);color:#17191b;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:650;">一键更新</button>' : ""}
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    modal.querySelector(".ug-close").onclick = close;
    modal.querySelector(".ug-goto").onclick = () => window.open(v.url || "https://github.com/Ararararararaki/comfyui-anima-toolkit", "_blank");
    const status = modal.querySelector(".ug-status");
    const apply = modal.querySelector(".ug-apply");
    apply?.addEventListener("click", async () => {
      apply.disabled = true;
      apply.textContent = "更新中…";
      if (status) { status.style.display = "block"; status.textContent = "正在下载并校验更新包，请不要关闭 ComfyUI…"; }
      try {
        const response = await fetch("/anima/update/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedCommit: v.remoteCommit || "" }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
        if (result.alreadyLatest) {
          if (status) status.textContent = "当前已经是最新版本。";
          apply.textContent = "已是最新";
          return;
        }
        if (status) status.textContent = `更新完成：覆盖 ${result.updatedFiles || 0} 个发布文件。${result.restartHint || "请重启 ComfyUI"}`;
        apply.textContent = "更新完成";
        showToast("✅ 插件已更新，请通过绘世 GUI 重启 ComfyUI");
        onApplied?.(result);
      } catch (error) {
        if (status) status.textContent = `更新失败：${error.message || error}`;
        apply.disabled = false;
        apply.textContent = "重试更新";
      }
    });
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

  // ── 内联 SVG 图标（lucide 风格 stroke，与面板统一画风，替代 emoji/字符）──
  const _ICON_PATHS = {
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    checkSquare: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
    image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  };
  function svgIcon(name, size = 12) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;pointer-events:none;">${_ICON_PATHS[name] || ""}</svg>`;
  }

  // HTML 转义（供 _render 的 metaBadge 等动态内容使用；此前 _render 内直接调用 esc 但未定义，
  // 仅在分类标签非空时抛 ReferenceError → 单行渲染失败被 catch 跳过 → 卡片列表莫名只剩前几行）
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // 属性值转义（双引号上下文；esc 已覆盖引号，此处为语义别名）
  const escAttr = (s) => esc(s);

  // ── /anima/meta 持久化契约（后端：键级合并 merged = {**current, **incoming}）──
  // 空值（[]/{}）不覆盖非空，除非 body 带 __replace（字符串数组）显式声明该键允许被清空；
  // 回包 { ok, skipped, saved }，__replace 只用于判定、不落库。
  // 这里集中收口读写工具，避免以后再有散落的"空对象直接 POST"把后端元数据整体清空。
  const META_MIRROR_KEY = "tk_lora_meta_mirror";
  const META_KEYS = ["categories", "loraMeta", "loraGroups"];

  // 空壳判定：三个键都为空/缺失。拿空壳去 POST 会把后端 LoRA 组 / 分类 / 偏好一起清掉
  const metaIsEmptyShell = (meta) => {
    if (!meta || typeof meta !== "object") return true;
    const cats = Array.isArray(meta.categories) ? meta.categories.length : Object.keys(meta.categories || {}).length;
    const loraMetaCount = meta.loraMeta && typeof meta.loraMeta === "object" ? Object.keys(meta.loraMeta).length : 0;
    const groups = Array.isArray(meta.loraGroups) ? meta.loraGroups.length : 0;
    return !cats && !loraMetaCount && !groups;
  };

  // 本地镜像：写入成功后存一份，后端读取失败时兜底恢复（永久化保存的最后一道防线）
  const saveMetaMirror = (meta) => {
    try { localStorage.setItem(META_MIRROR_KEY, JSON.stringify(meta)); } catch { /* 忽略配额/隐私模式异常 */ }
  };
  const loadMetaMirror = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(META_MIRROR_KEY) || "null");
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch { return null; }
  };

  // ── UI 状态 ──
  export class BatchLoraWidgetUI {
    constructor(node, loraWidget) {
      this._infoSession = new LoraLookupSession(loraInfoClient);
      this._disposed = false;
      this._lifetime = new AbortController();
      this._views = new Map();
      this.node = node;
      this.loraWidget = loraWidget;
      // The constructor parses immediately, so metadata ownership must exist before that parse starts its preload.
      // 只有后端完整快照才能安全提交 loraMeta 单键；残缺基线会覆盖后端其他偏好。
      this._metaLoaded = false;
      this._metaPromise = null;
      this._metaReadAttempted = false;
      this._disabledChoices = new Map();
      this.loras = this._parse(loraWidget.value || "");
      this.triggerWordMap = {};
      this._unsubscribeTriggers = triggerOverrides.subscribe(changed => {
        if (this.loras.some(l => changed.includes(normalizeLoraName(l.name)))) {
          this._updateTwStatus();
          this.listEl?.querySelectorAll(".trigger-edit").forEach(button => {
            const custom = triggerOverrides.entry(button.dataset.loraName)?.hasOverride;
            button.classList.toggle("is-custom", !!custom);
            button.title = custom ? "编辑自定义触发词" : "编辑触发词";
          });
        }
        this._manualRefresh?.();
      });
      this.loraInfoMap = {}; // name -> {previewUrl, modelName, creator}（悬停预览用）
      this._lastBridgeTs = 0;   // 上次已应用的 bridge updated_at（避免重复同步）
      this._bridgeTimer = null;
      this.domSizeSync = null;
      // trigger_words 总开关（后端 output_trigger_words）：节点 widgets 里可能还没有
      // （旧版后端），此时按「开启」处理并只做前端展示。
      this.twWidget = node?.widgets?.find((w) => w.name === "output_trigger_words") || null;
      this._twPushTimer = null;
      this._twStatusEl = null;
      this._twCheckEl = null;
    }

    // ── 解析 <lora:name:weight>（并合并 node.properties 里保留的禁用项） ──
    _parse(text) {
      let disabledMap = this.node?.properties?.animaLoraDisabled;
      if (!disabledMap) {
        try { disabledMap = JSON.parse(localStorage.getItem("anima_lora_disabled") || "{}"); }
        catch { disabledMap = {}; }
      }
      this._ensureMeta();
      const items = LoRASyntax.parse(text, { disabledMap });
      return items.map(item => {
        const choice = this._disabledChoices.get(normalizeLoraName(item.name));
        return { ...item, disabled: choice ? choice.disabled : item.disabled || this._prefDisabled(item.name) };
      });
    }

    _serialize() { return LoRASyntax.serialize(this.loras); }

    _persistDisabled() {
      const disabledMap = LoRASyntax.disabledMap(this.loras);
      if (!this.node.properties) this.node.properties = {};
      this.node.properties.animaLoraDisabled = disabledMap;
      try { localStorage.setItem("anima_lora_disabled", JSON.stringify(disabledMap)); } catch { /* optional mirror */ }
    }

    // 从后端持久化的 loraMeta 读取"该 LoRA 通常被隐藏"的偏好（跨工作流/粘贴也能恢复）
    _prefDisabled(name) {
      try {
        const meta = this.meta && this.meta.loraMeta;
        if (!meta) return false;
        const key = normalizeLoraName(name);
        const entry = Object.entries(meta).find(([storedName]) => normalizeLoraName(storedName) === key)?.[1];
        return !!(entry && entry.disabled);
      } catch { return false; }
    }

    // 预加载后端 loraMeta 到 this.meta（供 _parse / 添加路径恢复隐藏偏好）
    _ensureMeta({ retry = false } = {}) {
      if (this._disposed) return Promise.resolve(null);
      if (this._metaLoaded) return Promise.resolve(this.meta);
      if (this._metaPromise) return this._metaPromise;
      if (this._metaReadAttempted && !retry) return Promise.resolve(null);
      this._metaReadAttempted = true;
      if (!this.meta) this.meta = { categories: [], loraMeta: {}, loraGroups: [] };
      const loading = this._fetchMeta().then((data) => {
        if (this._disposed) return null;
        // A successful empty snapshot is complete too; repeated parses must not issue another GET.
        if (data) {
          this.meta = {
            categories: Array.isArray(data.categories) ? data.categories : [],
            loraMeta: data.loraMeta && typeof data.loraMeta === "object" ? data.loraMeta : {},
            loraGroups: Array.isArray(data.loraGroups) ? data.loraGroups : [],
          };
          this._metaLoaded = true;
        }
        // 读取失败（data === null）→ 用本地镜像兜底恢复，绝不拿空壳当起点
        else this._restoreMetaFromMirror();
        const before = new Map(this.loras.map(item => [normalizeLoraName(item.name), item.disabled]));
        const next = this._parse(this.loraWidget.value || "");
        const newlyDisabled = next.some(item => item.disabled && !before.get(normalizeLoraName(item.name)));
        this.loras = next;
        // Persist original model/clip weights before publishing the masked syntax to the host callback.
        if (newlyDisabled) this._commit();
        if (this.listEl) this._render(this.listEl);
        return data ? this.meta : null;
      }).catch(() => null).finally(() => {
        if (this._metaPromise === loading) this._metaPromise = null;
      });
      this._metaPromise = loading;
      return loading;
    }

    // 后端读取失败时用 localStorage 镜像恢复 this.meta（只恢复展示，不自动写回后端）
    _restoreMetaFromMirror() {
      const mirror = loadMetaMirror();
      if (!mirror || metaIsEmptyShell(mirror)) return false;
      this.meta = {
        categories: Array.isArray(mirror.categories) ? mirror.categories : [],
        loraMeta: mirror.loraMeta && typeof mirror.loraMeta === "object" ? mirror.loraMeta : {},
        loraGroups: Array.isArray(mirror.loraGroups) ? mirror.loraGroups : [],
      };
      showToast("已用本地备份恢复（后端读取失败）");
      return true;
    }

    // 读后端 meta：网络异常 / 非 2xx / 非法 JSON 一律返回 null，调用方必须据此中止本次操作。
    // 绝不返回 {} 或 { loraGroups: [] } —— 空对象一旦被继续 POST，后端元数据会被整体覆盖清空。
    async _fetchMeta() {
      try {
        const response = await fetch("/anima/meta", { signal: this._lifetime?.signal });
        if (!response.ok) return null;
        const data = await response.json();
        if (this._disposed) return null;
        if (!data || typeof data !== "object") return null;
        // 读到后端数据时刷新本地镜像；后端返回空壳时不覆盖镜像（别把还能用的备份抹成空）
        if (!metaIsEmptyShell(data)) saveMetaMirror(data);
        return data;
      } catch { return null; }
    }

    // 统一写入入口：所有 POST /anima/meta 都走这里
    //   - 空壳保护：待发对象三键全空且没显式授权清空 → 拒发（预加载失败时手里正是空对象）
    //   - replace：字符串数组，声明"这些键允许被清空"（后端 __replace 语义，仅用于判定）
    //     删除/重命名组等可能让数组变短的合法操作必须传它，否则后端护栏会拦掉"删到空"
    //   返回 { ok, skipped, saved, error }
    async _postMeta(meta, { replace = [] } = {}) {
      if (!meta || typeof meta !== "object") return { ok: false, error: "meta 无效" };
      const replaceKeys = Array.isArray(replace) ? replace : [];
      // 只提交契约内的三个键，其余键（含后端未来的新键）交由后端合并保留
      const body = {};
      for (const key of META_KEYS) {
        if (Object.prototype.hasOwnProperty.call(meta, key)) body[key] = meta[key];
      }
      if (!Object.keys(body).length) return { ok: false, error: "empty-payload" };
      if (metaIsEmptyShell(body) && !replaceKeys.length) {
        showToast("本地数据为空，已阻止本次写入（避免清空后端 LoRA 组）");
        return { ok: false, error: "empty-shell" };
      }
      if (replaceKeys.length) body.__replace = replaceKeys;
      try {
        const response = await fetch("/anima/meta", {
          signal: this._lifetime?.signal,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          showToast(`保存失败（HTTP ${response.status}），本次未写入后端，请重试`);
          return { ok: false, error: `HTTP ${response.status}` };
        }
        const data = await response.json().catch(() => null);
        // 写入成功 → 按"键级合并"语义叠加进镜像，部分键提交不会把镜像变成残缺对象
        const mirror = loadMetaMirror() || {};
        const nextMirror = { ...mirror };
        for (const key of META_KEYS) {
          if (Object.prototype.hasOwnProperty.call(body, key)) nextMirror[key] = body[key];
        }
        saveMetaMirror(nextMirror);
        return { ok: true, skipped: (data && data.skipped) || [], saved: (data && data.saved) || [] };
      } catch (error) {
        showToast("保存失败，本次未写入后端，请重试");
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    }

    // 保存单个 LoRA 的「通常隐藏」偏好到后端 loraMeta。
    // 只提交 loraMeta 这一个键（依赖后端键级合并），不再整体 POST this.meta —— 原实现
    // 在预加载失败时会把空壳整体写回，直接把后端分类/组/偏好清空。
    async _saveLoraPref(name, disabled) {
      if (this._disposed) return false;
      const key = normalizeLoraName(name), choice = { disabled: !!disabled };
      // Capture the user's switch synchronously, before a pending preload can apply an older preference.
      this._disabledChoices.set(key, choice);
      // 手里不是后端完整快照时先补读一次；读不到就中止本次写入并提示用户，绝不拿残缺基线覆盖后端
      if (!this._metaLoaded) {
        const remote = await this._ensureMeta({ retry: true });
        if (this._disposed || this._disabledChoices.get(key) !== choice) return false;
        if (!remote) {
          showToast("读取后端数据失败，本次未保存，请重试");
          return false;
        }
      }
      if (!this.meta) this.meta = { categories: [], loraMeta: {}, loraGroups: [] };
      const mm = this.meta.loraMeta || (this.meta.loraMeta = {});
      const storedName = Object.keys(mm).find(stored => normalizeLoraName(stored) === key) || name;
      if (!mm[storedName]) mm[storedName] = { categories: [], favorite: false, pinned: false, count: 0 };
      mm[storedName].disabled = choice.disabled;
      const res = await this._postMeta({ loraMeta: mm });
      return res.ok;
    }

    _commit() {
      if (this._disposed) return;
      // 必须先持久化禁用状态再写 lora_syntax：lora_syntax 值变化会触发 widget 的
      // callback（this.loras = this._parse(v)），若 node.properties 尚未设置，禁用项会被覆盖丢失
      this._persistDisabled();
      this.loraWidget.value = this._serialize();
      if (this.node.graph) this.node.graph.change();
    }

    // ── 构建 DOM ──
    mount() {
      if (this._mounted || this._disposed) return;
      this._mounted = true;
      this._ensureMeta();
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
          .anima-lora-widget { display:flex; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0; box-sizing:border-box; padding:6px; overflow:hidden; background:linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01)); border-radius:8px; font-family:"Inter","Geist Sans",system-ui,sans-serif; border:1px solid rgba(255,255,255,0.05); box-shadow:inset 0 1px 0 0 rgba(255,255,255,0.04); }
          .anima-lora-widget .list { flex:1 1 auto; min-width:0; overflow-x:hidden; overflow-y:auto; min-height:0; }
          .anima-lora-widget .list-resize-handle { display:flex; flex:0 0 17px; height:17px; align-items:center; justify-content:center; gap:6px; border-top:1px solid rgba(255,255,255,0.08); color:#8A8F98; cursor:ns-resize; user-select:none; -webkit-user-select:none; touch-action:none; }
          .anima-lora-widget .list-resize-handle span { font-size:12px; letter-spacing:2px; line-height:1; transform:rotate(90deg); }
          .anima-lora-widget .list-resize-handle small { opacity:0; font-size:9px; transition:opacity .15s ease; }
          .anima-lora-widget .list-resize-handle:hover, .anima-lora-widget .list-resize-handle.is-dragging { color:#EDEDEF; border-color:#5E6AD2; }
          .anima-lora-widget .list-resize-handle:hover small, .anima-lora-widget .list-resize-handle.is-dragging small { opacity:1; }
          .anima-lora-widget .list-resize-handle:focus-visible { outline:2px solid #5E6AD2; outline-offset:-2px; }
          .anima-lora-widget .toolbar { display:flex; gap:5px; margin-bottom:6px; flex-wrap:wrap; }
          .anima-lora-widget .toolbar button { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border:none; border-radius:6px; cursor:pointer; font-size:9px; font-weight:600; color:#EDEDEF; white-space:nowrap; letter-spacing:0.02em; transition:all 0.2s ease-out; box-shadow:0 0 0 1px rgba(255,255,255,0.06),0 2px 8px rgba(0,0,0,0.3); }
          .anima-lora-widget .toolbar .btn-verify { background:linear-gradient(135deg,#5E6AD2,#6872D9); box-shadow:0 0 0 1px rgba(94,106,210,0.3),0 2px 12px rgba(94,106,210,0.2),inset 0 1px 0 0 rgba(255,255,255,0.15); }
          .anima-lora-widget .toolbar .btn-verify:hover { background:linear-gradient(135deg,#6872D9,#7B83E0); box-shadow:0 0 0 1px rgba(94,106,210,0.4),0 4px 20px rgba(94,106,210,0.3),inset 0 1px 0 0 rgba(255,255,255,0.2); transform:translateY(-1px); }
          .anima-lora-widget .toolbar .btn-verify:active { transform:scale(0.97); }
          .anima-lora-widget .toolbar .btn-browse { background:linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.04)); }
          .anima-lora-widget .toolbar .btn-browse:hover { background:linear-gradient(135deg,rgba(255,255,255,0.12),rgba(255,255,255,0.06)); box-shadow:0 0 0 1px rgba(255,255,255,0.10),0 4px 16px rgba(0,0,0,0.4); transform:translateY(-1px); }
          .anima-lora-widget .toolbar .btn-clear { background:linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02)); color:#8A8F98; }
          .anima-lora-widget .toolbar .btn-clear:hover { background:linear-gradient(135deg,rgba(255,80,80,0.12),rgba(255,80,80,0.06)); color:#ff6b6b; box-shadow:0 0 0 1px rgba(255,80,80,0.2); transform:translateY(-1px); }
          .anima-lora-widget .status { font-size:10px; padding:3px 6px; margin-bottom:4px; min-height:18px; color:#8A8F98; border-radius:4px; background:rgba(255,255,255,0.02); }
          .anima-lora-widget .trigger-box { font-size:10px; padding:6px 8px; margin-top:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); border-radius:6px; display:none; line-height:1.6; color:#8A8F98; }
          .anima-lora-widget .tw-toggle { display:inline-flex; align-items:center; gap:5px; padding:3px 7px; border:1px solid rgba(255,255,255,0.08); border-radius:6px; background:rgba(255,255,255,0.03); color:#8A8F98; font-size:10px; white-space:nowrap; cursor:pointer; user-select:none; }
          .anima-lora-widget .tw-toggle:hover { border-color:rgba(230,223,211,0.28); color:#E6DFD3; }
          .anima-lora-widget .tw-toggle-check { width:12px; height:12px; margin:0; accent-color:#bcbcbc; cursor:pointer; }
          .anima-lora-widget .tw-toggle-state.is-partial { color:#c6a76a; }
          .anima-lora-widget .tw-toggle-state.is-off { color:#cb8585; }
          .anima-lora-widget .empty-msg { font-size:10px; color:#8A8F98; padding:16px 8px; text-align:center; line-height:1.6; }
          .anima-lora-widget .lora-row { display:flex; align-items:center; gap:6px; padding:5px 6px; border-radius:6px; transition:all 0.2s ease-out; background:rgba(255,255,255,0.02); margin-bottom:2px; border:1px solid transparent; }
          .anima-lora-widget .lora-row:hover { background:linear-gradient(135deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02)); border-color:rgba(255,255,255,0.06); box-shadow:0 2px 12px rgba(0,0,0,0.2); }
          .anima-lora-widget .lora-row.drag-over { padding-top:8px; border-top:2px solid #5E6AD2; background:rgba(94,106,210,0.06); }
          .anima-lora-widget .lora-row.dragging { opacity:0.3; }
          .anima-lora-widget .drag-area { display:inline-flex; align-items:center; cursor:grab; padding:2px 4px; border-radius:4px; flex-shrink:0; user-select:none; -webkit-user-select:none; }
          .anima-lora-widget .drag-area:hover { background:rgba(255,255,255,0.06); }
          .anima-lora-widget .drag-area .drag-hint { color:rgba(255,255,255,0.15); font-size:11px; line-height:1; }
          .anima-lora-widget .lora-name { font-size:10px; min-width:50px; max-width:none; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#C8C9CB; flex-shrink:1; cursor:pointer; padding:2px 4px; border-radius:4px; transition:all 0.15s ease-out; }
          .anima-lora-widget .lora-name:hover { background:rgba(94,106,210,0.12); color:#EDEDEF; }
          .anima-lora-widget .weight-group { display:flex; align-items:center; gap:2px; flex-shrink:0; }
          .anima-lora-widget .weight-step { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; padding:0; border:none; border-radius:4px; background:rgba(255,255,255,0.06); color:#8A8F98; cursor:pointer; flex-shrink:0; transition:all 0.15s ease-out; font-family:"Geist Mono","JetBrains Mono",monospace; font-size:13px; line-height:1; font-weight:600; user-select:none; -webkit-user-select:none; }
          .anima-lora-widget .weight-step:hover { background:rgba(94,106,210,0.18); color:#EDEDEF; box-shadow:0 0 0 1px rgba(94,106,210,0.25); }
          .anima-lora-widget .weight-step:active { transform:scale(0.92); background:rgba(94,106,210,0.28); }
          .anima-lora-widget .weight-val { width:40px; font-size:9px; text-align:center; background:transparent; color:#EDEDEF; border:none; padding:1px 0; font-family:"Geist Mono","JetBrains Mono",monospace; outline:none; }
          .anima-lora-widget .del-btn { display:inline-flex; align-items:center; justify-content:center; background:none; border:none; color:rgba(255,80,80,0.4); cursor:pointer; padding:0 3px; flex-shrink:0; transition:all 0.15s ease-out; border-radius:3px; line-height:1; width:18px; height:18px; }
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
          .anima-tw-popover { position:fixed; z-index:99999; background:linear-gradient(180deg,#141418,#0f0f12); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 12px; max-width:300px; box-shadow:0 0 0 1px rgba(255,255,255,0.04),0 12px 40px rgba(0,0,0,0.6),0 0 60px rgba(94,106,210,0.05); }
          .anima-tw-popover .tw-preview { width:100%; height:120px; border-radius:6px; overflow:hidden; margin-bottom:8px; background:rgba(255,255,255,0.04); display:flex; align-items:center; justify-content:center; }
          .anima-tw-popover .tw-preview img { width:100%; height:100%; object-fit:cover; display:block; }
          .anima-tw-popover .tw-preview-fallback { color:rgba(255,255,255,0.25); font-size:10px; padding:0 10px; text-align:center; }
          .anima-tw-popover .tw-meta { font-size:9px; color:rgba(255,255,255,0.4); margin-bottom:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          .anima-tw-popover .tw-title { font-weight:600; font-size:10px; color:#8A8F98; margin-bottom:5px; letter-spacing:0.02em; }
          .anima-tw-popover .tw-word { background:rgba(94,106,210,0.12); color:#C8C9CB; padding:3px 8px; border-radius:4px; font-size:10px; margin:2px; display:inline-block; cursor:pointer; transition:all 0.15s ease-out; border:1px solid rgba(94,106,210,0.1); }
          .anima-tw-popover .tw-word:hover { background:rgba(94,106,210,0.25); color:#EDEDEF; }
          .anima-tw-popover .tw-empty { color:rgba(255,255,255,0.3); font-size:10px; }
          .anima-group-modal { transform:scale(var(--bm-scale,1)); transform-origin:center center; width:min(900px,94vw); max-height:82vh; overflow-y:auto; box-sizing:border-box; padding:16px; border:1px solid #34383c; border-radius:10px; color:#e7e4de; background:linear-gradient(180deg,#1d2023,#111315); box-shadow:0 0 0 1px rgba(255,255,255,.035),0 20px 60px rgba(0,0,0,.65),inset 0 1px rgba(255,255,255,.05); }
          .anima-group-modal h3 { color:#f0ece4; }
          .anima-group-save { display:flex; gap:8px; margin-bottom:12px; }
          .anima-group-name-input { min-width:0; flex:1; padding:7px 9px; border:1px solid #34383c; border-radius:6px; outline:none; color:#e7e4de; background:#111315; font-size:11px; }
          .anima-group-name-input:focus { border-color:#d0c9bb; box-shadow:0 0 0 2px rgba(208,201,187,.12); }
          .anima-group-save-btn, .anima-group-load-btn { display:inline-flex; align-items:center; justify-content:center; gap:4px; border:1px solid #d0c9bb; border-radius:6px; color:#17191b; background:#d0c9bb; cursor:pointer; font-size:11px; font-weight:650; }
          .anima-group-save-btn { padding:6px 12px; }
          .anima-group-grid { display:grid; grid-template-columns:repeat(3,minmax(230px,1fr)); gap:8px; }
          .anima-group-card { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto auto; min-width:0; align-items:center; gap:6px; padding:9px 8px; border:1px solid #272b2e; border-radius:7px; background:#17191b; transition:border-color .15s ease,background .15s ease,transform .15s ease; }
          .anima-group-card:hover { border-color:#626a70; background:#1d2023; transform:translateY(-1px); }
          .anima-group-card .group-icon { display:inline-flex; flex-shrink:0; color:#9bb2b6; }
          .anima-group-card .group-label { display:flex; min-width:0; align-items:center; gap:3px; cursor:default; }
          .anima-group-card .group-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#e7e4de; font-size:11px; }
          .anima-group-card .group-count { flex-shrink:0; color:#9b9a95; font-size:10px; }
          .anima-group-card .group-edit-btn { display:inline-flex; width:24px; height:24px; align-items:center; justify-content:center; padding:0; border:1px solid transparent; border-radius:5px; color:#9b9a95; background:transparent; cursor:pointer; }
          .anima-group-card .group-edit-btn:hover { border-color:#34383c; color:#f0ece4; background:#2a2d30; }
          .anima-group-load-btn { padding:4px 8px; }
          .anima-group-delete-btn { padding:4px 8px; border:1px solid rgba(203,133,133,.7); border-radius:6px; color:#e1a5a5; background:rgba(203,133,133,.10); cursor:pointer; font-size:11px; }
          .anima-group-delete-btn:hover { border-color:#cb8585; color:#f0c0c0; background:rgba(203,133,133,.18); }
          .anima-group-empty { color:#9b9a95; font-size:11px; margin:8px 0 12px; }
          @media (max-width:740px) { .anima-group-grid { grid-template-columns:repeat(2,minmax(190px,1fr)); } }
          @media (max-width:500px) { .anima-group-grid { grid-template-columns:1fr; } }
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
          @keyframes bm-scale-in { from{opacity:0;transform:scale(calc(var(--bm-scale,1)*0.96))} to{opacity:1;transform:scale(var(--bm-scale,1))} }
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

          /* ── TK Toolkit 同款表面层：中性灰阶、透明底色、精确微动效 ── */
          .bm-overlay { position:fixed !important; inset:0 !important; z-index:9999 !important; display:flex !important; align-items:center; justify-content:center; background:radial-gradient(ellipse at 50% 0%,rgba(30,29,27,.78),rgba(5,5,5,.90) 62%,rgba(2,2,2,.96)) !important; backdrop-filter:none; }
          .bm-modal { --bm-fg:#eeeae3; --bm-fg-muted:#a9a39a; --bm-fg-subtle:rgba(238,234,227,.56); --bm-accent:#e6dfd3; --bm-accent-ink:#1d1a16; --bm-line:rgba(238,234,227,.13); --bm-line-hover:rgba(238,234,227,.27); --bm-surface:rgba(238,234,227,.055); --bm-surface-hover:rgba(238,234,227,.105); --bm-danger:#d18b82; position:relative !important; display:flex !important; flex-direction:column !important; box-sizing:border-box !important; width:min(1180px,calc(100vw - 32px)) !important; max-width:1180px !important; height:min(88vh,820px) !important; max-height:88vh !important; padding:0 !important; overflow:hidden !important; color:var(--bm-fg) !important; background:linear-gradient(180deg,rgba(22,21,19,.93),rgba(10,10,9,.97)) !important; border:1px solid var(--bm-line) !important; border-radius:18px !important; box-shadow:0 0 0 1px rgba(255,255,255,.035),0 24px 70px rgba(0,0,0,.68),0 0 80px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,.08) !important; font-family:"Inter","Geist Sans",system-ui,sans-serif !important; transform:scale(var(--bm-scale,1)) !important; transform-origin:center center !important; }
          .bm-modal::before { content:""; position:absolute; inset:0; pointer-events:none; background:radial-gradient(600px 180px at 28% 0%,rgba(255,255,255,.065),transparent 72%); opacity:.8; }
          .bm-header { position:relative; z-index:1; display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:64px; padding:12px 16px 11px; border-bottom:1px solid rgba(238,234,227,.10); background:rgba(255,255,255,.018); }
          .bm-heading { display:flex; align-items:flex-end; gap:9px; min-width:0; }
          .bm-heading h3 { display:flex; align-items:center; gap:8px; min-width:0; margin:0 !important; color:var(--bm-fg) !important; font-size:14px !important; font-weight:650 !important; letter-spacing:-.01em; }
          .bm-heading h3 svg { color:var(--bm-accent); flex:0 0 auto; }
          .bm-kicker { align-self:center; color:var(--bm-fg-subtle); font-size:8px; letter-spacing:.16em; line-height:1; }
          .bm-total { align-self:center; color:var(--bm-fg-subtle) !important; font-size:10px !important; white-space:nowrap; }
          .bm-header-actions { display:flex; align-items:center; justify-content:flex-end; gap:6px; flex-wrap:wrap; }
          .bm-header-actions button, .bm-batchbar button { display:inline-flex !important; align-items:center; justify-content:center; gap:6px; min-height:30px; padding:5px 10px !important; border:1px solid var(--bm-line) !important; border-radius:9px !important; background:rgba(238,234,227,.045) !important; color:var(--bm-fg-muted) !important; box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 3px 10px rgba(0,0,0,.16) !important; cursor:pointer; font-size:10px !important; font-weight:600; letter-spacing:.01em; white-space:nowrap; transition:transform .2s cubic-bezier(.16,1,.3,1),background .2s ease,border-color .2s ease,color .2s ease,box-shadow .2s ease !important; }
          .bm-header-actions button:hover, .bm-batchbar button:hover { transform:translateY(-1px); border-color:var(--bm-line-hover) !important; background:rgba(238,234,227,.105) !important; color:var(--bm-fg) !important; box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 8px 20px rgba(0,0,0,.24) !important; }
          .bm-header-actions button:active, .bm-batchbar button:active { transform:translateY(0) scale(.98); }
          .bm-header-actions button:focus-visible, .bm-batchbar button:focus-visible, .bm-sidebar button:focus-visible, .bm-modal input:focus-visible, .bm-modal select:focus-visible { outline:2px solid var(--bm-accent) !important; outline-offset:2px; }
          .bm-header-actions .bm-mode, .bm-header-actions .bm-url { color:var(--bm-accent) !important; border-color:rgba(230,223,211,.28) !important; background:rgba(230,223,211,.10) !important; }
          .bm-header-actions .bm-mode:hover, .bm-header-actions .bm-url:hover { background:rgba(230,223,211,.17) !important; }
          .bm-header-actions .bm-batch-toggle.is-active { color:var(--bm-accent-ink) !important; border-color:var(--bm-accent) !important; background:var(--bm-accent) !important; }
          .bm-header-actions .bm-close { color:var(--bm-danger) !important; border-color:rgba(209,139,130,.28) !important; background:rgba(209,139,130,.075) !important; }
          .bm-header-actions .bm-close:hover { color:#f2c3ba !important; border-color:rgba(209,139,130,.52) !important; background:rgba(209,139,130,.14) !important; }
          .bm-header-actions button svg, .bm-batchbar button svg { flex:0 0 auto; }
          .bm-search-row { position:relative; z-index:1; display:flex; align-items:center; gap:8px; padding:10px 16px; border-bottom:1px solid rgba(238,234,227,.07); background:rgba(0,0,0,.13); }
          .bm-search-box { display:flex; align-items:center; gap:8px; min-width:0; flex:1; padding:0 10px; border:1px solid var(--bm-line) !important; border-radius:10px; background:rgba(0,0,0,.22) !important; color:var(--bm-fg-subtle); transition:border-color .2s ease,box-shadow .2s ease,background .2s ease; }
          .bm-search-box:focus-within { border-color:var(--bm-line-hover) !important; background:rgba(0,0,0,.32) !important; box-shadow:0 0 0 3px rgba(238,234,227,.08); }
          .bm-search { width:100% !important; min-width:0; margin:0 !important; padding:8px 0 !important; border:0 !important; outline:none !important; background:transparent !important; color:var(--bm-fg) !important; font-size:11px !important; }
          .bm-search::placeholder { color:var(--bm-fg-subtle) !important; }
          .bm-base-model, .bm-sort { min-width:104px; max-width:190px; min-height:34px; padding:6px 10px !important; border:1px solid var(--border-color,var(--bm-line)) !important; border-radius:10px !important; background:var(--comfy-input-bg,var(--bm-surface)) !important; color:var(--fg-color,var(--bm-fg)) !important; font-size:12px !important; }
          .bm-base-model option, .bm-sort option { background:var(--comfy-input-bg,var(--bg-elev)); color:var(--fg-color,var(--bm-fg)); }
          .bm-base-model:disabled { opacity:.58; cursor:not-allowed; }
          @media (max-width:740px) { .bm-search-row { flex-wrap:wrap; } .bm-search-box { flex-basis:100%; } .bm-base-model, .bm-sort { min-width:0; max-width:none; flex:1 1 0; } }
          .bm-body { position:relative; z-index:1; display:flex; flex:1; gap:16px; min-height:0; padding:12px 16px 16px; }
          .bm-sidebar { width:158px !important; flex:0 0 158px; padding:2px 10px 2px 0 !important; overflow-y:auto; border-right:1px solid rgba(238,234,227,.09) !important; }
          .bm-sidebar > button { display:flex !important; align-items:center; justify-content:space-between; gap:8px; width:100% !important; min-height:32px; margin:0 0 4px !important; padding:7px 9px !important; border:1px solid transparent !important; border-radius:9px !important; background:transparent !important; color:var(--bm-fg-muted) !important; font-size:10px !important; text-align:left; transition:transform .2s cubic-bezier(.16,1,.3,1),background .2s ease,border-color .2s ease,color .2s ease !important; }
          .bm-sidebar > button:hover { transform:translateX(2px); background:var(--bm-surface-hover) !important; border-color:var(--bm-line) !important; color:var(--bm-fg) !important; }
          .bm-sidebar > button.is-active { background:rgba(230,223,211,.13) !important; border-color:rgba(230,223,211,.30) !important; color:var(--bm-fg) !important; box-shadow:inset 2px 0 0 var(--bm-accent),inset 0 1px 0 rgba(255,255,255,.06) !important; }
          .bm-filter-label { display:flex; align-items:center; gap:7px; min-width:0; }
          .bm-filter-label svg { flex:0 0 auto; color:var(--bm-fg-subtle); }
          .bm-sidebar > button.is-active .bm-filter-label svg { color:var(--bm-accent); }
          .bm-filter-count { flex:0 0 auto; color:var(--bm-fg-subtle) !important; font-size:9px !important; font-variant-numeric:tabular-nums; }
          .bm-list { flex:1 !important; min-width:0; padding:2px !important; overflow:auto; position:relative; scrollbar-gutter:stable; }
          .bm-card { overflow:hidden !important; border:1px solid rgba(238,234,227,.13) !important; border-radius:14px !important; background:linear-gradient(180deg,rgba(238,234,227,.08),rgba(238,234,227,.025)) !important; box-shadow:0 0 0 1px rgba(0,0,0,.16),0 5px 16px rgba(0,0,0,.28),0 0 25px rgba(0,0,0,.10) !important; transition:transform .22s cubic-bezier(.16,1,.3,1),border-color .22s ease,box-shadow .22s ease,filter .22s ease !important; }
          .bm-card:hover { transform:translateY(-3px) !important; border-color:var(--bm-line-hover) !important; box-shadow:0 0 0 1px rgba(238,234,227,.12),0 12px 28px rgba(0,0,0,.42),0 0 36px rgba(238,234,227,.045) !important; }
          .bm-card.is-added { border-color:rgba(230,223,211,.38) !important; }
          .bm-card.is-selected { border-color:var(--bm-accent) !important; box-shadow:0 0 0 2px rgba(230,223,211,.30),0 12px 30px rgba(0,0,0,.38) !important; filter:brightness(1.07); }
          .bm-img { position:relative; height:100% !important; overflow:hidden; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.22) !important; color:var(--bm-fg-subtle) !important; }
          .bm-img::after { content:""; position:absolute; inset:0; pointer-events:none; background:linear-gradient(180deg,rgba(0,0,0,0) 54%,rgba(0,0,0,.16)); opacity:.7; }
          .bm-thumb-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; transition:transform .45s cubic-bezier(.16,1,.3,1),filter .3s ease; }
          .bm-card:hover .bm-thumb-img { transform:scale(1.035); filter:saturate(.92) contrast(1.03); }
          .bm-img-fallback { position:relative; z-index:1; display:inline-flex; align-items:center; justify-content:center; color:var(--bm-fg-subtle); }
          .bm-img-fallback.is-missing { color:var(--bm-danger); }
          .bm-badge { position:absolute !important; top:9px !important; left:9px !important; z-index:3; align-items:center; justify-content:center; width:22px !important; height:22px !important; border:1px solid rgba(29,26,22,.25); border-radius:50% !important; background:var(--bm-accent) !important; color:var(--bm-accent-ink) !important; box-shadow:0 4px 12px rgba(0,0,0,.28) !important; }
          .bm-card-actions { position:absolute; top:8px; right:8px; z-index:3; display:flex; gap:4px; }
          .bm-card-actions button, .bm-li-actions button { display:inline-flex !important; align-items:center; justify-content:center; width:25px !important; height:25px !important; padding:0 !important; border:1px solid rgba(238,234,227,.20) !important; border-radius:8px !important; background:rgba(17,16,14,.70) !important; color:var(--bm-fg-muted) !important; box-shadow:0 4px 12px rgba(0,0,0,.26),inset 0 1px 0 rgba(255,255,255,.08) !important; backdrop-filter:none; cursor:pointer; transition:transform .18s cubic-bezier(.16,1,.3,1),background .18s ease,border-color .18s ease,color .18s ease !important; }
          .bm-card-actions button:hover, .bm-li-actions button:hover { transform:translateY(-1px); border-color:var(--bm-line-hover) !important; background:rgba(238,234,227,.16) !important; color:var(--bm-fg) !important; }
          .bm-card-actions button:active, .bm-li-actions button:active { transform:scale(.94); }
          .bm-card-actions .bm-catbtn.is-active { border-color:rgba(230,223,211,.55) !important; color:var(--bm-accent) !important; background:rgba(230,223,211,.17) !important; }
          .bm-card-info { position:absolute; right:0; bottom:0; left:0; padding:30px 9px 7px; background:linear-gradient(180deg,rgba(8,8,7,0),rgba(8,8,7,.55) 40%,rgba(8,8,7,.86) 100%); }
          .bm-mname { overflow:hidden; color:var(--bm-fg) !important; font-size:11px !important; font-weight:620; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; text-shadow:0 1px 3px rgba(0,0,0,.85); }
          .bm-lname, .bm-meta { display:none; overflow:hidden; color:var(--bm-fg-muted) !important; font-size:9px !important; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; text-shadow:0 1px 2px rgba(0,0,0,.8); }
          .bm-cattags { display:flex; gap:3px; flex-wrap:wrap; min-height:0; margin-top:3px; }
          .bm-cattags:empty { display:none; margin-top:0; }
          .bm-cat-tag { display:inline-flex; align-items:center; max-width:100%; padding:2px 5px; overflow:hidden; border:1px solid rgba(230,223,211,.20); border-radius:999px; background:rgba(230,223,211,.11); color:var(--bm-accent) !important; font-size:8px; cursor:pointer; text-overflow:ellipsis; white-space:nowrap; }
          .bm-cat-tag:hover { background:rgba(230,223,211,.19); }
          .bm-li { display:flex !important; align-items:center; gap:10px; min-height:56px; margin:0 0 6px !important; padding:7px 9px !important; border:1px solid rgba(238,234,227,.10) !important; border-radius:11px !important; background:rgba(238,234,227,.035) !important; box-shadow:0 3px 12px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.04) !important; transition:transform .2s cubic-bezier(.16,1,.3,1),background .2s ease,border-color .2s ease,box-shadow .2s ease !important; }
          .bm-li:hover { transform:translateX(2px); background:var(--bm-surface-hover) !important; border-color:var(--bm-line-hover) !important; box-shadow:0 8px 20px rgba(0,0,0,.26),inset 0 1px 0 rgba(255,255,255,.07) !important; }
          .bm-li.is-added { border-color:rgba(230,223,211,.32) !important; }
          .bm-li.is-selected { border-color:var(--bm-accent) !important; background:rgba(230,223,211,.13) !important; box-shadow:0 0 0 2px rgba(230,223,211,.18),0 8px 20px rgba(0,0,0,.24) !important; }
          .bm-li-thumb { position:relative; display:flex; align-items:center; justify-content:center; width:42px !important; height:42px !important; flex:0 0 42px; overflow:hidden; border:1px solid rgba(238,234,227,.11); border-radius:9px; background:rgba(0,0,0,.24) !important; color:var(--bm-fg-subtle); }
          .bm-li-copy { min-width:0; flex:1; }
          .bm-li-actions { display:flex; align-items:center; gap:4px; flex:0 0 auto; }
          .bm-li-badge { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; color:var(--bm-accent) !important; }
          .bm-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; min-height:180px; color:var(--bm-fg-subtle); font-size:10px; text-align:center; }
          .bm-empty svg { color:var(--bm-fg-muted); }
          .bm-empty strong { color:var(--bm-fg); font-size:12px; font-weight:600; }
          .bm-empty span { color:var(--bm-fg-subtle); }
          .bm-empty button { min-height:30px; padding:5px 11px; border:1px solid var(--bm-line); border-radius:8px; background:var(--bm-surface); color:var(--bm-fg); cursor:pointer; font:inherit; }
          .bm-empty button:disabled { opacity:.6; cursor:wait; }
          .bm-batchbar { position:relative; z-index:1; display:none; margin:0 16px 14px !important; }
          .bm-batchbar .bm-batch-add { width:100%; min-height:34px; color:var(--bm-accent-ink) !important; border-color:var(--bm-accent) !important; background:var(--bm-accent) !important; box-shadow:0 6px 18px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,.38) !important; }
          .bm-batchbar .bm-batch-add:hover { color:var(--bm-accent-ink) !important; background:#f3eee6 !important; }
          .bm-catpicker { min-width:210px; padding:9px !important; border:1px solid var(--bm-line-hover) !important; border-radius:12px !important; background:rgba(20,19,17,.96) !important; box-shadow:0 18px 44px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.07) !important; backdrop-filter:blur(14px); }
          .bm-cat-title { margin-bottom:6px; color:var(--bm-fg-subtle); font-size:9px; letter-spacing:.04em; }
          .bm-cat-empty { padding:4px 0; color:var(--bm-fg-subtle); font-size:9px; }
          .bm-catpicker .bm-cat-done { margin-top:4px !important; justify-content:center; border:1px dashed rgba(230,223,211,.28) !important; color:var(--bm-fg) !important; }
          .bm-catpicker .bm-cat-done:hover { border-color:var(--bm-accent) !important; color:var(--bm-accent) !important; }
          .bm-catpicker button { display:flex !important; align-items:center; gap:7px; width:100% !important; min-height:30px; margin:0 0 3px !important; padding:6px 8px !important; border:1px solid transparent !important; border-radius:8px !important; background:transparent !important; color:var(--bm-fg-muted) !important; font-size:10px !important; text-align:left; transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease !important; }
          .bm-catpicker button.is-active { border-color:rgba(230,223,211,.22) !important; background:rgba(230,223,211,.13) !important; color:var(--bm-accent) !important; }
          .bm-catpicker button:hover { transform:translateX(2px); background:var(--bm-surface-hover) !important; border-color:var(--bm-line) !important; color:var(--bm-fg) !important; }
          /* Scrolling thumbnails must not create dozens of blur/shadow/filter layers. */
          .bm-overlay-enter, .bm-modal-enter { animation:none !important; }
          .bm-list { contain:layout paint; overscroll-behavior:contain; }
          .bm-card, .bm-card:hover, .bm-card.is-selected, .bm-li, .bm-li:hover, .bm-li.is-selected { box-shadow:none !important; filter:none !important; transition:border-color .15s ease,background .15s ease !important; }
          .bm-card:hover, .bm-li:hover { transform:none !important; }
          .bm-card *, .bm-li * { text-shadow:none !important; }
          .bm-card:hover .bm-thumb-img { transform:none !important; filter:none !important; }
          .bm-card-actions button, .bm-li-actions button { box-shadow:none !important; background:var(--comfy-menu-bg,var(--comfy-input-bg)) !important; }
          .anima-lora-widget .trigger-edit {flex:0 0 22px; width:22px; height:22px; padding:3px; border:1px solid transparent; border-radius:5px; background:transparent; color:var(--descrip-text); opacity:.55; cursor:pointer; display:inline-flex; align-items:center; justify-content:center;}
          .anima-lora-widget .lora-row:hover .trigger-edit, .anima-lora-widget .trigger-edit:focus-visible {opacity:1; border-color:var(--border-color);}
          .anima-lora-widget .trigger-edit.is-custom {opacity:1; color:var(--p-primary-color);}
          .anima-lora-widget .trigger-edit:focus-visible {outline:2px solid var(--p-primary-color); outline-offset:2px;}
          @media (max-width:760px) { .bm-header { align-items:flex-start; flex-direction:column; } .bm-header-actions { width:100%; justify-content:flex-start; } .bm-body { gap:10px; padding-inline:10px; } .bm-sidebar { width:116px !important; flex-basis:116px; } }
          @media (prefers-reduced-motion:reduce) { .bm-overlay-enter,.bm-modal-enter,.bm-card,.bm-li,.bm-header-actions button,.bm-batchbar button,.bm-thumb-img { animation:none !important; transition-duration:.01ms !important; } }
        `;

      // ── 工具栏 ──
      const toolbar = document.createElement("div");
      toolbar.className = "toolbar";
      const verifyBtn = this._btn("验证标签", "btn-verify", "检查输入框中的 <lora:...> 标签能否在本地找到对应文件", "search");
      const extractBtn = this._btn("提取触发词", "btn-verify", "批量查询当前列表所有 LoRA 的触发词（自动刷新列表）", "download");
      const copyAllTwBtn = this._btn("全部触发词", "btn-verify", "一键复制已启用 LoRA 的所有触发词（英文逗号连接）", "clipboard");
      const browseBtn = this._btn("本地 LoRA", "btn-browse", "打开本地 LoRA 浏览窗：预览 C 站图、点击添加 / 分类", "folder");
      const clearBtn = this._btn("", "btn-clear", "清空当前 LoRA 列表", "x");
      clearBtn.style.padding = "4px 8px"; // 纯图标按钮，缩写宽度
      const panelBtn = this._btn("面板", "btn-verify", "打开本地管理面板（TK Toolkit）", "globe");
      const groupsBtn = this._btn("组", "btn-browse", "LoRA 组：保存当前列表 / 切换 / 重命名 / 删除（悬浮组名预览组内 LoRA）", "folder");
      const updateBtn = this._btn("更新", "btn-browse", "检查插件版本更新", "refresh");
      // ── trigger_words 总开关（一键关闭本节点全部触发词输出）──
      const twToggle = document.createElement("label");
      twToggle.className = "tw-toggle";
      twToggle.title = "总开关：关闭后本节点 trigger_words 输出为空字符串（LoRA 加载、列表、提取功能都不受影响）";
      const twCheck = document.createElement("input");
      twCheck.type = "checkbox";
      twCheck.className = "tw-toggle-check";
      twCheck.checked = this._outputTriggerWords();
      twCheck.addEventListener("change", () => this._setOutputTriggerWords(twCheck.checked));
      const twState = document.createElement("span");
      twState.className = "tw-toggle-state";
      twToggle.append(twCheck, twState);
      this._twCheckEl = twCheck;
      this._twStatusEl = twState;
      toolbar.append(verifyBtn, extractBtn, copyAllTwBtn, browseBtn, groupsBtn, clearBtn, panelBtn, updateBtn, twToggle);

      // 更新检查：版本号 + 提交/文件指纹；手动检查强制刷新，页面存续期间每 5 分钟复查。
      let updateInfo = null;
      let updateCheckBusy = false;
      const updateAvailable = (info) => Boolean(info && (info.updateAvailable ?? info.behind));
      const markUpdateApplied = (result) => {
        updateInfo = { ...(updateInfo || {}), updateAvailable: false, behind: false, version: result.version || updateInfo?.latest };
        updateBtn.disabled = true;
        updateBtn.innerHTML = svgIcon("check", 12) + '<span>需重启</span>';
        updateBtn.title = "插件文件已更新，请通过绘世启动器重启 ComfyUI";
      };
      const setUpdateButton = (info) => {
        updateInfo = info || null;
        updateBtn.disabled = false;
        if (updateAvailable(info)) {
          updateBtn.innerHTML = svgIcon("refresh", 12) + '<span>一键更新</span>';
          updateBtn.title = `当前 ${info.version || "?"}，最新 ${info.latest || "?"}，点击执行安全更新`;
          updateBtn.onclick = () => showUpdateDialog(updateInfo, markUpdateApplied);
        } else {
          updateBtn.innerHTML = svgIcon("refresh", 12) + '<span>更新</span>';
          updateBtn.title = "立即检查插件更新";
          updateBtn.onclick = () => checkUpdate(true, true);
        }
      };
      const checkUpdate = (notify = false, force = false) => {
        if (updateCheckBusy) return;
        updateCheckBusy = true;
        if (notify) updateBtn.disabled = true;
        const query = force ? "?force=1" : "";
        fetch("/anima/version" + query)
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
          .then((info) => {
            setUpdateButton(info);
            if (notify) {
              if (updateAvailable(info)) showUpdateDialog(info, markUpdateApplied);
              else if (info?.latest) showToast(`当前已是最新版本 ${info.latest}`);
              else showToast("⚠️ 无法检查更新（GitHub 网络不可达）");
            }
          })
          .catch((error) => { if (notify) showToast(`⚠️ 无法检查更新：${error.message || error}`); })
          .finally(() => { updateCheckBusy = false; if (!updateInfo || !updateAvailable(updateInfo)) updateBtn.disabled = false; });
      };
      setUpdateButton(null);
      setTimeout(() => checkUpdate(false, false), 2000);
      this._updateTimer = setInterval(() => checkUpdate(false, false), 5 * 60 * 1000);

      const statusEl = document.createElement("div");
      statusEl.className = "status";

      const listEl = document.createElement("div");
      listEl.className = "list";

      // 独立的卡片区高度调整柄：Chrome 右下角原生三角形属于 lora_syntax
      // 文本框，不能调整下面的 LoRA 列表；这里用 Pointer Events 调整整个节点高度。
      const listResizeEl = document.createElement("div");
      listResizeEl.className = "list-resize-handle";
      listResizeEl.setAttribute("role", "separator");
      listResizeEl.setAttribute("aria-orientation", "horizontal");
      listResizeEl.setAttribute("aria-valuemin", "180");
      listResizeEl.setAttribute("aria-valuemax", "1600");
      listResizeEl.tabIndex = 0;
      listResizeEl.title = "拖动调整 LoRA 卡片区域高度；也可用键盘上下调整";
      listResizeEl.innerHTML = "<span>⋮⋮</span><small>拖动调整 LoRA 卡片区域高度</small>";
      let resizingList = false;
      let resizeStartY = 0;
      let resizeStartHeight = 0;
      const applyListResize = (height) => {
        const value = Math.max(180, Math.min(1600, Math.round(Number(height) || 180)));
        const width = Math.max(280, Number(this.node.size?.[0]) || 420);
        this.node.setSize?.([width, value]);
        listResizeEl.setAttribute("aria-valuenow", String(value));
      };
      const endListResize = (event) => {
        if (!resizingList) return;
        resizingList = false;
        try { listResizeEl.releasePointerCapture(event.pointerId); } catch {}
        listResizeEl.classList.remove("is-dragging");
        this.node.graph?.setDirtyCanvas?.(true, true);
      };
      listResizeEl.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        resizingList = true;
        resizeStartY = event.clientY;
        resizeStartHeight = Math.max(180, Number(this.node.size?.[1]) || 420);
        listResizeEl.classList.add("is-dragging");
        try { listResizeEl.setPointerCapture(event.pointerId); } catch {}
      });
      listResizeEl.addEventListener("pointermove", (event) => {
        if (!resizingList) return;
        event.preventDefault();
        event.stopPropagation();
        applyListResize(resizeStartHeight + event.clientY - resizeStartY);
      });
      listResizeEl.addEventListener("pointerup", endListResize);
      listResizeEl.addEventListener("pointercancel", endListResize);
      listResizeEl.addEventListener("lostpointercapture", () => {
        if (!resizingList) return;
        resizingList = false;
        listResizeEl.classList.remove("is-dragging");
      });
      listResizeEl.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === "ArrowUp" ? -30 : 30;
        applyListResize((Number(this.node.size?.[1]) || 420) + delta);
      });
      listResizeEl.setAttribute("aria-valuenow", String(Math.max(180, Number(this.node.size?.[1]) || 420)));

      const triggerEl = document.createElement("div");
      triggerEl.className = "trigger-box";

      container.append(toolbar, statusEl, listEl, listResizeEl, triggerEl);

      verifyBtn.onclick = () => this._verify(statusEl, listEl, triggerEl);
      extractBtn.onclick = () => this._extractAllTriggerWords(listEl);
      copyAllTwBtn.onclick = () => this._copyAllTriggerWords();
      browseBtn.onclick = () => { showToast("正在加载 LoRA 列表..."); this._browseModal(statusEl); };
      clearBtn.onclick = () => {
        // 二次确认防误触（纯图标按钮更易误点）
        if (!window.confirm("确定清空当前 LoRA 列表？")) return;
        this.loras = []; this._commit(); this._render(listEl);
      };
      panelBtn.onclick = () => window.open(PANEL_BASE, "_blank");
      groupsBtn.onclick = () => this._groupsModal(listEl);

      this._render(listEl);
      this.listEl = listEl;

      this.loraWidget.callback = ((orig) => {
        return (v) => {
          orig?.call(this.loraWidget, v);
          this.update();
        };
      })(this.loraWidget.callback);

      const dw = this.node.addDOMWidget("anima_batch_ui", "custom", container, { serialize: false });
      // 「输出触发词」原生 BOOLEAN 行由工具栏开关承载：就地隐藏，避免节点上多一行空控件
      this._hideNativeWidget(this.twWidget);
      this._updateTwStatus();
      this.domSizeSync = installDOMWidgetSizeSync({
        node: this.node,
        domWidget: dw,
        element: container,
        minHeight: 180,
        maxHeight: 1600,
        initialContentHeight: Math.min(420, 72 + Math.max(1, this.loras.length) * 30),
      });

      // ComfyUI 新节点布局默认把两个 widget 网格行都设为 auto，节点被手动
      // 拉高后，多余空间会被分配到第一行，导致 LoRA 面板被推到节点底部。
      // 让 lora_syntax 占自然高度，第二行占剩余高度，内部列表才能随节点边框伸缩。
      const applyWidgetLayout = (attempt = 0) => {
        if (this._disposed) return;
        const widgetGrid = container.closest(".lg-node-widgets");
        if (!widgetGrid) {
          if (attempt < 12) requestAnimationFrame(() => applyWidgetLayout(attempt + 1));
          return;
        }
        widgetGrid.style.gridTemplateRows = "auto minmax(0, 1fr)";
        widgetGrid.style.alignContent = "stretch";
      };
      applyWidgetLayout();

      // 让 lora_syntax 输入框多行/自适应高度
      this._enhanceLoraInput();

      // 自动同步面板「发送到 ComfyUI」的 LoRA：发送后 ≤5s 内节点即可看到，无需手动操作
      this._syncFromBridge(listEl, true);
      if (this._bridgeTimer) clearInterval(this._bridgeTimer);
      this._bridgeTimer = setInterval(() => this._syncFromBridge(listEl, true), 5000);
      const ui = this;
      const origRemoved = this.node.onRemoved;
      this.node.onRemoved = function () {
        ui.dispose();
        if (typeof origRemoved === "function") return origRemoved.apply(this, arguments);
      };
    }

    update(syntax = this.loraWidget.value || "") {
      if (this._disposed) return;
      this.loras = this._parse(syntax);
      this._render(this.listEl);
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      this._lifetime.abort();
      this._infoSession.dispose();
      this._closeBrowser?.();
      for (const close of [...this._views.values()]) close();
      clearInterval(this._bridgeTimer); clearInterval(this._updateTimer); clearTimeout(this._twPushTimer);
      this._bridgeTimer = this._updateTimer = this._twPushTimer = null;
      this._triggerCopySequence = (this._triggerCopySequence || 0) + 1;
      this._unsubscribeTriggers?.(); this._unsubscribeTriggers = null;
      this._triggerEditor?.close(true);
      this._loraInputResizeObserver?.disconnect(); this._loraInputResizeObserver = null;
      this.domSizeSync?.dispose(); this.domSizeSync = null;
    }

    _ownView(kind, cleanup) {
      this._views.get(kind)?.();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (this._views.get(kind) === close) this._views.delete(kind);
        cleanup();
      };
      this._views.set(kind, close);
      return close;
    }

    _effectiveWords(name, fallback = this.triggerWordMap[name]) {
      return triggerOverrides.words(name, fallback);
    }

    _loadTriggerOverrides(names, refresh = false) { return triggerOverrides.load(names, refresh); }
    _beginTriggerCopy() {
      this._triggerCopySequence = (this._triggerCopySequence || 0) + 1;
      return this._triggerCopySequence;
    }
    _isLatestTriggerCopy(sequence) { return this._triggerCopySequence === sequence; }

    async _copyLoraWords(name) {
      const sequence = this._beginTriggerCopy();
      try {
        await this._loadTriggerOverrides([name], true);
        if (!this._isLatestTriggerCopy(sequence)) return;
        let words = this._effectiveWords(name);
        if (!Array.isArray(words)) {
          await new Promise(resolve => this._fetchTw(name, resolve));
          if (!this._isLatestTriggerCopy(sequence)) return;
          words = this._effectiveWords(name);
        }
        if (!this._isLatestTriggerCopy(sequence)) return;
        if (words?.length) { copyText(words.join(", ") + ","); showToast("已复制触发词"); }
        else showToast(triggerOverrides.entry(name)?.hasOverride ? "已自定义为空触发词" : "该 LoRA 无触发词");
      } catch (error) { if (this._isLatestTriggerCopy(sequence)) showToast("读取触发词失败：" + error.message); }
    }

    _editTriggerWords(anchor, name) {
      this._triggerEditor?.close();
      this._views.get("popover")?.();
      this._triggerEditor = openTriggerWordEditor(anchor, name,
        () => Array.isArray(this.triggerWordMap[name]) ? Promise.resolve(this.triggerWordMap[name]) : new Promise(resolve => this._fetchTw(name, resolve)),
        {onClose: () => { this._triggerEditor = null; }});
    }

    // ── trigger_words 总开关 ──
    _outputTriggerWords() {
      return this.twWidget ? this.twWidget.value !== false : true;
    }

    _setOutputTriggerWords(on) {
      const value = !!on;
      if (this.twWidget) {
        this.twWidget.value = value;
        try { this.twWidget.callback?.(value); } catch (e) { /* 回调异常不影响开关本身 */ }
      } else {
        // 后端还是旧版（没有 output_trigger_words 输入）：开关只能改前端显示
        showToast("⚠️ 后端未提供「输出触发词」开关，请重启 ComfyUI 后再试");
      }
      this.node?.graph?.change();
      this._updateTwStatus();
      if (this._twCheckEl) this._twCheckEl.checked = value;
      showToast(value
        ? "✅ 已开启触发词输出（trigger_words 将输出已激活 LoRA 的触发词）"
        : "🚫 已关闭触发词输出（trigger_words 输出空字符串）");
      if (value) this._autoFetchTriggerWords();
    }

    // 原生 BOOLEAN 行交给面板里的开关承载：就地隐藏（保持 options 引用，勿整体替换）
    _hideNativeWidget(widget) {
      if (!widget) return;
      widget.hidden = true;
      widget.options = widget.options || {};
      widget.options.hidden = true;
      widget.computeSize = () => [0, -4];
      widget.draw = () => {};
      if (widget.element) widget.element.style.display = "none";
    }

    // 已启用（激活）的 LoRA 中，已知触发词的数量；用于开关旁的状态提示
    _twCoverage() {
      const on = this._outputTriggerWords();
      if (!on) return { active: 0, known: 0, enabled: false };
      let active = 0;
      let known = 0;
      for (const l of this.loras || []) {
        if (l.disabled || (l.weight === 0 && (l.clipWeight ?? l.weight) === 0)) continue;
        active++;
        const words = this._effectiveWords(l.name);
        if (Array.isArray(words) && words.length) known++;
      }
      return { active, known, enabled: true };
    }

    _updateTwStatus() {
      const el = this._twStatusEl;
      if (!el) return;
      const { active, known, enabled } = this._twCoverage();
      el.textContent = enabled ? `输出触发词 ${known}/${active}` : "输出触发词（已关闭）";
      if (this._twCheckEl) this._twCheckEl.checked = enabled;
      el.classList.toggle("is-off", !enabled);
      el.classList.toggle("is-partial", enabled && known < active);
    }

    // ── 触发词持久化：推送 {LoRA 名 → 触发词} 给后端落盘，
    //    这样执行时（哪怕面板没推送过 bridge / C 站离线）也能解析出触发词 ──
    _pushTriggerWords() {
      if (this._twPushTimer) clearTimeout(this._twPushTimer);
      this._twPushTimer = setTimeout(() => { this._twPushTimer = null; this._pushTriggerWordsNow(); }, 900);
    }

    async _pushTriggerWordsNow() {
      const loras = {};
      for (const [name, words] of Object.entries(this.triggerWordMap || {})) {
        if (!Array.isArray(words) || !words.length) continue; // null = 查询失败，不回传
        const clean = words.map((w) => String(w).trim()).filter(Boolean);
        if (clean.length) loras[name] = clean;
      }
      if (!Object.keys(loras).length) return;
      try {
        const resp = await fetch("/anima/lora_trigger_words", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ loras }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      } catch (e) {
        // 静默失败：推送只是让执行端离线可解析，失败不影响节点本身
        console.debug("[Anima] 触发词推送失败:", e);
      }
    }

    _btn(text, cls, title, iconName) {
      const b = document.createElement("button");
      b.className = cls;
      if (iconName) b.innerHTML = svgIcon(iconName, 12) + '<span>' + text + '</span>';
      else b.textContent = text;
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
        if (this._disposed) return;
        try {
          const data = await this._infoSession.get({ name: l.name });
          if (this._disposed) return;
          const src = data.source || "";
          if (data.error || src.startsWith("error") || src.startsWith("http")) throw new Error(data.error || src);
          const tw = data.trainedWords || [];
          this.triggerWordMap[l.name] = tw;
          this.loraInfoMap[l.name] = {
            previewUrl: data.previewUrl || null,
            modelName: data.modelName || "",
            creator: data.creator || "",
            versionName: data.versionName || "",
            trainedWords: Array.isArray(data.trainedWords) ? data.trainedWords : [],
            tags: Array.isArray(data.tags) ? data.tags : [],
          };
          if (tw.length) found++;
        } catch (e) {
          if (this._disposed) return;
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
      this._pushTriggerWords();
      this._updateTwStatus();
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
    // ── C 站图片代理（白名单域；_browseModal 卡片与 _showTwTooltip 预览图共用）──
    _imgProxy(url) {
      // 仅代理 C 站图片域；非白名单 URL 返回空字符串（调用方 onerror 兜底占位），
      // 避免 javascript:/data: 等协议被带入 <img src>（返回值未转义进 innerHTML）
      if (!url || !url.startsWith("https://image.civitai.com/")) return "";
      let u = url;
      if (u.includes("original=true")) u = u.replace("original=true", "width=400");
      if (u.includes("width=")) u = u.replace(/width=\d+/g, "width=400");
      return "/anima/image?url=" + encodeURIComponent(u);
    }

    _fetchTw(name, onDone) {
      return this._infoSession.get({ name })
        .then((data) => {
          if (this._disposed) { onDone?.(null); return; }
          const src = data.source || "";
          if (data.error || src.startsWith("error") || src.startsWith("http")) {
            throw new Error(data.error || src);
          }
          const tw = data.trainedWords || [];
          this.triggerWordMap[name] = tw;
          // 缓存预览图/模型名/作者，供悬停 popover 展示
          this.loraInfoMap[name] = {
            previewUrl: data.previewUrl || null,
            modelName: data.modelName || "",
            creator: data.creator || "",
            versionName: data.versionName || "",
            trainedWords: Array.isArray(data.trainedWords) ? data.trainedWords : [],
            tags: Array.isArray(data.tags) ? data.tags : [],
          };
          onDone && onDone(tw);
          this._pushTriggerWords();
          this._updateTwStatus();
        })
        .catch((e) => {
          if (this._disposed) { onDone?.(null); return; }
          // 失败标记为 null，允许重试；不误判为"无触发词"
          this.triggerWordMap[name] = null;
          console.error("[Anima] 获取触发词失败:", name, e);
          showToast("❌ 获取失败，请确认 ComfyUI 已重启: " + e.message);
          onDone && onDone(null); // Release callers waiting to copy/edit after a failed lookup.
        });
    }

    // ── 一键复制已启用 LoRA 的所有触发词（英文逗号连接，句末带逗号匹配后续提示词） ──
    async _copyAllTriggerWords() {
      const sequence = this._beginTriggerCopy();
      const enabled = this.loras.filter(l => !l.disabled && (l.weight !== 0 || (l.clipWeight ?? l.weight) !== 0));
      if (!enabled.length) { showToast("当前没有启用的 LoRA"); return; }
      try {
        await this._loadTriggerOverrides(enabled.map(l => l.name), true);
        if (!this._isLatestTriggerCopy(sequence)) return;
        const parts = [];
        for (const l of enabled) {
          if (!this._isLatestTriggerCopy(sequence)) return;
          let words = this._effectiveWords(l.name);
          if (!Array.isArray(words)) {
            await new Promise(resolve => this._fetchTw(l.name, resolve));
            if (!this._isLatestTriggerCopy(sequence)) return;
            words = this._effectiveWords(l.name);
          }
          if (words?.length) parts.push(...words);
        }
        if (!this._isLatestTriggerCopy(sequence)) return;
        const seen = new Set();
        const unique = parts.filter(word => { const key = word.trim().toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; });
        if (!unique.length) { showToast("这些 LoRA 都没有触发词"); return; }
        copyText(unique.join(", ") + ","); showToast("已复制全部触发词");
      } catch (error) { if (this._isLatestTriggerCopy(sequence)) showToast("读取触发词失败：" + error.message); }
    }

    // 加载工作流/同步后自动提取所有 LoRA 的触发词，逐个更新行内提示，不重渲染整个列表
    _autoFetchTriggerWords() {
      this.loras.forEach((l) => {
        if (this.triggerWordMap[l.name] !== undefined) return;
        this._fetchTw(l.name, (tw) => {
          if (!this.listEl) return;
          // 触发词卡片小字已移除（用户要求），仅保留 hover 预览图弹窗数据
        });
      });
    }

    // ── 渲染 LoRA 卡片 ──
    _render(listEl) {
      this._loadTriggerOverrides(this.loras.map(l => l.name)).catch(error => console.warn("[TK] 自定义触发词读取失败", error));
      this._updateTwStatus();
      listEl.innerHTML = "";
      if (!this.loras.length) {
        listEl.innerHTML = '<div class="empty-msg">暂无 LoRA，点击「本地 LoRA」添加</div>';
        return;
      }
      this.loras.forEach((l, i) => {
        try {
        const row = document.createElement("div");
        row.className = "lora-row";
        row.classList.toggle("disabled", !!l.disabled);
        row.dataset.loraName = l.name;

        // ── 拖拽区域（仅在 drag-area 上可拖拽） ──
        const dragArea = document.createElement("span");
        dragArea.className = "drag-area";
        dragArea.draggable = true;
        dragArea.innerHTML = `<span class="drag-hint">${svgIcon("grip", 11)}</span>`;

        // ── 启用/禁用开关（关闭则失效但保留在列表） ──
        const toggle = document.createElement("div");
        toggle.className = "lora-toggle" + (l.disabled ? "" : " on");
        toggle.title = l.disabled ? "已禁用（不参与生成），点击启用" : "点击禁用（暂时不参与生成）";
        toggle.onclick = (e) => {
          e.stopPropagation();
          l.disabled = !l.disabled;
          // 同步"通常隐藏"偏好到后端 loraMeta：跨工作流 / 移除后再加 / 粘贴时都能恢复关闭状态。
          // 只提交 loraMeta 单键；读取不到后端快照时 _saveLoraPref 会中止写入并提示，绝不清空后端 meta
          this._saveLoraPref(l.name, l.disabled);
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

        // ── LoRA 名称（悬停预览触发词/预览图，点击复制） ──
        const name = document.createElement("span");
        name.className = "lora-name";
        name.textContent = l.name; // 完整名，CSS ellipsis 兜底截断
        name.title = l.name; // 原生悬浮提示完整名（兜底，不依赖弹窗逻辑）
        let tooltipTimer = null;
        let hovering = false;
        name.onmouseenter = () => {
          hovering = true;
          clearTimeout(tooltipTimer);
          tooltipTimer = setTimeout(async () => {
            try {
              await this._loadTriggerOverrides([l.name]);
              if (!Array.isArray(this._effectiveWords(l.name))) await new Promise(resolve => this._fetchTw(l.name, resolve));
              if (hovering && name.isConnected && !this._triggerEditor) this._showTwTooltip(name, l.name, "hover");
            } catch (error) { console.warn("[TK] 触发词预览失败", error); }
          }, 400);
        };
        name.onmouseleave = () => {
          hovering = false; clearTimeout(tooltipTimer);
          this._views.get("popover")?.();
        };
        name.onclick = e => { e.stopPropagation(); this._copyLoraWords(l.name); };
        const edit = document.createElement("button");
        edit.type = "button"; edit.className = "trigger-edit";
        edit.dataset.loraName = l.name; edit.innerHTML = svgIcon("edit", 11);
        edit.setAttribute("aria-label", "编辑 " + l.name + " 的触发词");
        edit.title = triggerOverrides.entry(l.name)?.hasOverride ? "编辑自定义触发词" : "编辑触发词";
        edit.classList.toggle("is-custom", !!triggerOverrides.entry(l.name)?.hasOverride);
        edit.onclick = e => { e.stopPropagation(); this._editTriggerWords(edit, l.name); };

        // ── 触发词预览（小字灰显）已按用户要求移除：卡片不显示触发词（悬停预览图仍保留） ──

        // ── 权重调节（尖括号 scrubbing，替代滑块）──
        // 范围 ±10（LORA_WEIGHT_MIN ~ LORA_WEIGHT_MAX）：滑块类 LoRA 需要大强度；
        // 单击步进 0.05，也可直接点数字框输入（回车生效）。
        // 结构：< 数字 >；按住 < / > 后水平拖动鼠标可连续调整权重（每级 0.05），
        // 松开（mouseup/mouseleave）才 commit，避免拖动过程反复重建 DOM widget。
        const weightGroup = document.createElement("div");
        weightGroup.className = "weight-group";

        const decBtn = document.createElement("button");
        decBtn.className = "weight-step";
        decBtn.type = "button";
        decBtn.title = "降低权重（按住左右拖动可连续调）";
        decBtn.setAttribute("aria-label", "降低权重");
        decBtn.textContent = "<";

        const valSpan = document.createElement("input");
        valSpan.className = "weight-val";
        valSpan.type = "text"; valSpan.inputMode = "decimal";
        valSpan.value = l.weight.toFixed(2);
        valSpan.title = `权重 ${LORA_WEIGHT_MIN} ~ ${LORA_WEIGHT_MAX}（可直接输入，回车生效）`;

        const incBtn = document.createElement("button");
        incBtn.className = "weight-step";
        incBtn.type = "button";
        incBtn.title = "提高权重（按住左右拖动可连续调）";
        incBtn.setAttribute("aria-label", "提高权重");
        incBtn.textContent = ">";

        weightGroup.append(decBtn, valSpan, incBtn);

        function clamp(v, min, max) { return isNaN(v) ? 0 : Math.max(min, Math.min(max, v)); }
        const applyWeight = (v) => {
          const linkedWeights = l.clipWeight === undefined || l.clipWeight === l.weight;
          l.weight = clamp(v, LORA_WEIGHT_MIN, LORA_WEIGHT_MAX);
          if (linkedWeights) l.clipWeight = l.weight;
          valSpan.value = l.weight.toFixed(2);
        };
        // 单击步进 0.05（仅纯单击；若刚发生 scrubbing 拖动则跳过，避免双重 commit 重建 DOM 丢卡片）
        const step = (btn, d) => {
          btn.onclick = (e) => {
            e.stopPropagation();
            if (btn.__scrubbed) { btn.__scrubbed = false; return; }
            applyWeight(l.weight + d);
            this._commit();
          };
        };
        step(decBtn, -0.05);
        step(incBtn, +0.05);

        // scrubbing：按住 < / > 后，水平位移映射为权重增量（4px = 0.05）。
        // 用 mousedown/mousemove/mouseup（与 ComfyUI 节点拖动兼容）。
        // 核心修复：拖动结束仅 commit 一次，并标记 __scrubbed 抑制紧随的 click 事件，
        // 否则 click 的 onclick 会再次 commit → 双重 graph.change() 重建 DOM，闭包引用失效导致卡片消失。
        const attachScrub = (btn) => {
          let startX = 0, startW = 0, dragging = false, moved = false;
          const onMove = (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            if (Math.abs(dx) >= 2) moved = true;
            const delta = Math.round(dx / 4) * 0.05; // 4px=0.05，向右增向左减
            applyWeight(startW + delta);
          };
          const onUp = () => {
            if (!dragging) return;
            dragging = false;
            btn.__scrubbed = moved;
            // 若 mouseup 发生在按钮外，click 不会触发消费该标志；超时自动重置，避免吞掉下一次合法单击步进
            if (moved) setTimeout(() => { if (btn.__scrubbed) btn.__scrubbed = false; }, 2000);
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            if (moved) this._commit(); // 拖动过才 commit（纯单击由 step 的 onclick 处理）
          };
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            moved = false;
            startX = e.clientX;
            startW = l.weight;
            document.body.style.cursor = "ew-resize";
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          });
        };
        attachScrub(decBtn);
        attachScrub(incBtn);

        valSpan.onchange = () => {
          const v = parseFloat(valSpan.value);
          if (!isNaN(v) && v >= LORA_WEIGHT_MIN && v <= LORA_WEIGHT_MAX) { applyWeight(v); this._commit(); }
          else { valSpan.value = l.weight.toFixed(2); }
        };
        valSpan.onkeydown = (e) => { if (e.key === "Enter") valSpan.blur(); };

        // ── 删除 ──
        const del = document.createElement("button");
        del.className = "del-btn";
        del.innerHTML = svgIcon("x", 12);
        del.title = "删除该 LoRA";
        del.onclick = () => { this.loras.splice(i, 1); this._commit(); this._render(listEl); };

        // ── 分类 / 常用次数小标签 ──
        const metaBadge = document.createElement("span");
        metaBadge.className = "lora-meta-badge";
        const _m = (this.meta && this.meta.loraMeta && this.meta.loraMeta[l.name]) || {};
        const _cats = (_m.categories || []).slice(0, 1).join("");
        metaBadge.innerHTML = _cats ? svgIcon("tag", 9) + esc(_cats) : ""; // 使用次数已按用户要求移除，仅保留分类标签
        metaBadge.style.cssText = "font-size:9px;color:#8A8F98;opacity:0.85;white-space:nowrap;flex-shrink:0;display:inline-flex;align-items:center;gap:2px;";

        row.append(dragArea, toggle, name, edit, metaBadge, weightGroup, del);
        listEl.appendChild(row);
        } catch (err) {
          // 单行渲染失败只跳过该行,避免"列表已清空但渲染中断"导致整体空白
          console.error("[Anima] 渲染 LoRA 行失败:", l.name, err);
        }
      });
    }

    // ── 验证桥接 ──
    async _verify(statusEl, listEl, triggerEl) {
      if (this._disposed) return;
      statusEl.textContent = "⏳ 验证中...";
      statusEl.style.color = "#aaa";
      try {
        const text = this.loraWidget.value || "";
        const resp = await fetch("/anima/bridge/status?text=" + encodeURIComponent(text), { signal: this._lifetime.signal });
        const data = await resp.json();
        if (this._disposed) return;
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
        if (this._disposed) return;
        statusEl.textContent = "❌ 验证失败: " + e.message;
        statusEl.style.color = "#f44";
      }
    }

    // ── 缺失 LoRA 的 C 站查找弹窗：预览图 + 进 C 站 + 下载 ──
    // ── 缺失 LoRA 弹窗：复制名称 + 前往 C 站搜索（把搜索交给用户，绕开 API 匹配不准） ──
    _showMissingSearch(missingList) {
      if (this._disposed) return;
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
      const onKey = e => { if (e.key === "Escape") close(); };
      const close = this._ownView("missing", () => {
        overlay.remove(); document.removeEventListener("keydown", onKey);
      });
      overlay.onclick = (e) => { if (e.target === overlay) close(); };
      modal.querySelector(".close-btn").onclick = close;
      document.addEventListener("keydown", onKey);
      modal.addEventListener("click", (e) => {
        const copyBtn = e.target.closest(".ms-copy");
        if (copyBtn) { copyText(copyBtn.dataset.name); showToast("已复制: " + copyBtn.dataset.name); return; }
        const cs = e.target.closest(".ms-cs");
        if (cs) window.open("https://civitai.com/search/models?query=" + encodeURIComponent(cs.dataset.name) + "&type=LORA", "_blank");
      });
    }

    // ── 从面板同步 LoRA（消费 /anima/bridge 数据，面板「发送到 ComfyUI」后节点即可看到） ──
    // 投递语义：每个 bridge 版本只投递一次。localStorage 记录「已应用版本」，
    // 重启/刷新不再重放历史残留（anima_bridge.json 兜底文件），用户手动删除的条目不复活。
    async _syncFromBridge(listEl, silent) {
      if (this._disposed) return 0;
      try {
        const resp = await fetch("/anima/bridge/status", { signal: this._lifetime.signal });
        if (!resp.ok) return 0;
        const data = await resp.json();
        if (this._disposed) return 0;
        if (!data || !data.bridge_found || !Array.isArray(data.loras) || !data.loras.length) return 0;
        const ts = data.updated_at || 0;
        if (this._lastBridgeTs && ts <= this._lastBridgeTs) return 0;
        if (ts) {
          let applied = 0;
          try { applied = parseInt(localStorage.getItem(BRIDGE_APPLIED_KEY) || "0", 10) || 0; } catch (e) { applied = 0; }
          if (ts <= applied) return 0;
        }
        let added = 0;
        data.loras.forEach((l) => {
          if (!l || !l.name) return;
          if (!this.loras.some((e) => normalizeLoraName(e.name) === normalizeLoraName(l.name))) {
            this.loras.push({ name: l.name, weight: typeof l.model_strength === "number" ? l.model_strength : 1.0, clipWeight: l.clip_strength ?? l.model_strength ?? 1.0, disabled: this._prefDisabled(l.name) });
            added++;
          }
          if (l.trigger_words && l.trigger_words.length && !this.triggerWordMap[l.name]) {
            this.triggerWordMap[l.name] = l.trigger_words;
          }
        });
        this._pushTriggerWords();
        this._updateTwStatus();
        this._lastBridgeTs = ts;
        if (ts) {
          try { localStorage.setItem(BRIDGE_APPLIED_KEY, String(ts)); } catch (e) {}
        }
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

    // ── 让 lora_syntax 输入框默认紧凑，并保留可拖动高度 ──
    _enhanceLoraInput() {
      let done = false;
      const minHeight = 64;
      const defaultHeight = 96;
      const maxHeight = 220;
      const storageKey = () => `${LORA_INPUT_HEIGHT_KEY}:${this.node?.id ?? "unassigned"}`;
      const readStoredHeight = () => {
        try {
          const value = Number(localStorage.getItem(storageKey()));
          return Number.isFinite(value) ? Math.max(minHeight, Math.min(maxHeight, Math.round(value))) : 0;
        } catch {
          return 0;
        }
      };
      const saveHeight = (height) => {
        try { localStorage.setItem(storageKey(), String(height)); } catch {}
      };
      const findVisibleInput = (widget) => {
        const nodeId = String(this.node?.id ?? "");
        const visibleInNode = [...document.querySelectorAll("textarea, input")].find((candidate) => {
          const owner = candidate.closest?.("[node-id]");
          return owner?.getAttribute("node-id") === nodeId && candidate.getClientRects().length > 0;
        });
        const candidates = [
          visibleInNode,
          widget?.inputEl,
          widget?.element,
          ...(widget?.element?.querySelectorAll?.("textarea, input") || []),
        ].filter(Boolean);
        return candidates.find((candidate) => /^(TEXTAREA|INPUT)$/.test(candidate.tagName) && candidate.isConnected && candidate.getClientRects().length > 0) || null;
      };
      const attempt = () => {
        if (done) return;
        const w = this.loraWidget;
        if (!w) return;
        const el = findVisibleInput(w);
        if (!el) return;
        done = true;
        el.style.minHeight = `${minHeight}px`;
        el.style.maxHeight = `${maxHeight}px`;
        el.style.lineHeight = "1.45";
        el.style.fontFamily = "monospace";
        el.style.fontSize = "11px";
        el.style.resize = "vertical";
        el.style.overflowY = "auto";
        el.style.whiteSpace = "pre-wrap";
        el.title = "可拖动右下角调整输入框高度";
        let applyingHeight = false;
        const applyHeight = (height, persist = true) => {
          const value = Math.max(minHeight, Math.min(maxHeight, Math.round(Number(height) || defaultHeight)));
          applyingHeight = true;
          el.style.height = `${value}px`;
          if (persist) saveHeight(value);
          requestAnimationFrame(() => { applyingHeight = false; });
        };
        applyHeight(readStoredHeight() || defaultHeight, false);
        const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
          if (applyingHeight) return;
          const value = Math.round(el.getBoundingClientRect().height);
          if (value >= minHeight && value <= maxHeight) saveHeight(value);
        }) : null;
        resizeObserver?.observe(el);
        this._loraInputResizeObserver = resizeObserver;
        this._loraInputElement = el;
        if (this.node.graph) this.node.graph.setDirtyCanvas(true, true);
      };
      attempt();
      setTimeout(attempt, 100);
      setTimeout(attempt, 500);
    }

    // ── LoRA 组管理（保存 / 一键切换 / 重命名 / 删除 / 悬浮预览） ──
    _groupsModal(listEl) {
      if (this._disposed) return;
      this._views.get("groups")?.();
      const generation = this._groupsGeneration = (this._groupsGeneration || 0) + 1;
      this._fetchMeta()
        .then((metaData) => {
          if (this._disposed || generation !== this._groupsGeneration) return;
          // 读取失败（null）→ 直接中止本次操作并提示；绝不拿 { loraGroups: [] } 当起点去 POST，
          // 否则一次保存/删除就会把后端已有的组、分类、偏好整体覆盖清空
          if (!metaData) { showToast("读取后端数据失败，本次未保存，请重试"); return; }
          const groups = Array.isArray(metaData.loraGroups) ? metaData.loraGroups : [];
          this._metaLoaded = true; // 此刻拿到的是后端完整快照
          const overlay = document.createElement("div");
          const hoverTimers = new Set();
          const close = this._ownView("groups", () => {
            if (generation === this._groupsGeneration) this._groupsGeneration++;
            for (const timer of hoverTimers) clearTimeout(timer);
            this._views.get("popover")?.();
            overlay.remove();
          });
          overlay.className = "modal-overlay anima-group-overlay";
          overlay.style.cssText = "position:fixed;inset:0;background:rgba(10,10,15,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);";
          const modal = document.createElement("div");
          modal.className = "anima-group-modal";
          const title = document.createElement("h3");
          title.style.cssText = "margin:0 0 12px;font-size:13px;display:flex;align-items:center;gap:6px;";
          title.innerHTML = svgIcon("folder", 13) + ` LoRA 组（${groups.length}）`;
          modal.appendChild(title);

          // ── 保存当前列表为新组（合并「保存组」按钮功能） ──
          const active = this.loras.filter((l) => !l.disabled);
          if (active.length) {
            const saveWrap = document.createElement("div");
            saveWrap.className = "anima-group-save";
            const nameInput = document.createElement("input");
            nameInput.type = "text";
            nameInput.placeholder = `保存当前 ${active.length} 个 LoRA 为新组...`;
            nameInput.className = "anima-group-name-input";
            const saveBtn = document.createElement("button");
            saveBtn.className = "anima-group-save-btn";
            saveBtn.title = "保存当前列表为新组";
            saveBtn.innerHTML = svgIcon("save", 11) + "保存";
            const doSave = async () => {
              const name = nameInput.value.trim();
              if (!name) { showToast("请输入组名"); return; }
              const meta = await this._fetchMeta();
              if (generation !== this._groupsGeneration) return;
              // 读取失败 → 中止并提示，绝不用空对象当基线（那会把后端 LoRA 组整体清掉）
              if (!meta) { showToast("读取后端数据失败，本次未保存，请重试"); return; }
              const gs = Array.isArray(meta.loraGroups) ? meta.loraGroups : [];
              if (gs.some((g) => g.name === name)) { showToast(`已存在同名组「${name}」`); return; }
              gs.push({ name, loras: active.map((l) => ({ name: l.name, weight: l.weight, clipWeight: l.clipWeight })) });
              // 只提交 loraGroups 单键（依赖后端键级合并），不再整体覆盖后端 meta
              const res = await this._postMeta({ loraGroups: gs });
              if (generation !== this._groupsGeneration) return;
              if (!res.ok) return; // 失败提示已在 _postMeta 内给出，保留弹窗让用户重试
              showToast(`已保存组「${name}」（${active.length} 个 LoRA）`);
              close();
              this._groupsModal(listEl);
            };
            saveBtn.onclick = doSave;
            nameInput.onkeydown = (e) => { if (e.key === "Enter") doSave(); };
            saveWrap.append(nameInput, saveBtn);
            modal.appendChild(saveWrap);
          }

          if (!groups.length) {
            const empty = document.createElement("p");
            empty.className = "anima-group-empty";
            empty.textContent = "暂无组，在上方输入组名保存当前列表";
            modal.appendChild(empty);
          }
          const groupGrid = document.createElement("div");
          groupGrid.className = "anima-group-grid";
          const dotClosePopover = () => this._views.get("popover")?.();
          modal.addEventListener("scroll", dotClosePopover);
          groups.forEach((g) => {
            const row = document.createElement("div");
            row.className = "anima-group-card";

            // ── 组图标（内联 SVG，替代 emoji） ──
            const iconSpan = document.createElement("span");
            iconSpan.className = "group-icon";
            iconSpan.innerHTML = svgIcon("folder", 12);
            row.appendChild(iconSpan);

            // ── 组名（含数量）；悬浮预览组内 LoRA ──
            const label = document.createElement("span");
            label.className = "group-label";
            const nameSpan = document.createElement("span");
            nameSpan.className = "group-name";
            nameSpan.textContent = g.name;
            const countSpan = document.createElement("span");
            countSpan.className = "group-count";
            countSpan.textContent = `（${(g.loras || []).length}）`;
            label.append(nameSpan, countSpan);
            label.title = `悬浮查看组内 LoRA：${g.name}`;
            let hoverTimer = null;
            label.onmouseenter = () => {
              clearTimeout(hoverTimer);
              hoverTimer = setTimeout(() => {
                hoverTimers.delete(hoverTimer);
                if (generation === this._groupsGeneration) this._showGroupPopover(row, g);
              }, 300);
              hoverTimers.add(hoverTimer);
            };
            label.onmouseleave = () => { clearTimeout(hoverTimer); dotClosePopover(); };
            row.appendChild(label);

            // ── 重命名（行内编辑） ──
            const editBtn = document.createElement("button");
            editBtn.className = "group-edit-btn";
            editBtn.title = "重命名组";
            editBtn.innerHTML = svgIcon("edit", 11);
            editBtn.onclick = () => {
              dotClosePopover();
              const prev = g.name;
              const input = document.createElement("input");
              input.type = "text";
              input.value = prev;
              input.className = "anima-group-name-input";
              label.replaceWith(input);
              input.focus();
              input.select();
              let done = false;
              const reopen = () => { if (done) return; done = true; close(); this._groupsModal(listEl); };
              const reload = () => { close(); this._groupsModal(listEl); };
              const commit = async () => {
                if (done) return; done = true;
                const next = input.value.trim();
                if (!next || next === prev) { reload(); return; }
                const meta = await this._fetchMeta();
                if (generation !== this._groupsGeneration) return;
                if (!meta) { showToast("读取后端数据失败，本次未保存，请重试"); reload(); return; }
                const gs = Array.isArray(meta.loraGroups) ? meta.loraGroups : [];
                if (gs.some((x) => x.name === next)) { showToast(`已存在同名组「${next}」`); reload(); return; }
                const target = gs.find((x) => x.name === prev);
                if (!target) { showToast(`组「${prev}」已不存在，请重新打开`); reload(); return; }
                target.name = next;
                // 改名属于"数组可能变短"的一类操作：显式声明 loraGroups 允许被覆盖，
                // 否则后端"空值不覆盖非空"的护栏会把合法改动当成清空拦掉
                const res = await this._postMeta({ loraGroups: gs }, { replace: ["loraGroups"] });
                if (generation !== this._groupsGeneration) return;
                if (!res.ok) { reload(); return; } // 失败提示已在 _postMeta 内给出
                showToast(`组已重命名：${prev} → ${next}`);
                reload();
              };
              input.onkeydown = (e) => {
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") reopen();
              };
              input.onblur = () => { commit(); };
            };
            row.appendChild(editBtn);

            const loadBtn = document.createElement("button");
            loadBtn.className = "anima-group-load-btn";
            loadBtn.textContent = "切换";
            loadBtn.onclick = () => {
              dotClosePopover();
              this.loras = (g.loras || []).map((l) => ({ name: l.name, weight: l.weight, clipWeight: l.clipWeight ?? l.weight, disabled: this._prefDisabled(l.name) }));
              this._commit();
              if (listEl) this._render(listEl);
              close();
              showToast(`已切换组「${g.name}」（${this.loras.length} 个 LoRA）`);
            };
            row.appendChild(loadBtn);

            const delBtn = document.createElement("button");
            delBtn.className = "anima-group-delete-btn";
            delBtn.textContent = "删除";
            delBtn.onclick = async () => {
              dotClosePopover();
              if (!window.confirm(`删除组「${g.name}」？`)) return;
              const next = (Array.isArray(metaData.loraGroups) ? metaData.loraGroups : []).filter((x) => x.name !== g.name);
              metaData.loraGroups = next;
              // 删除会让数组变短（甚至删到空）：必须带 __replace 显式授权清空该键，
              // 否则后端护栏会把"删掉最后一组"这个合法操作整个拦掉（用户表现为删不掉）
              const res = await this._postMeta({ loraGroups: next }, { replace: ["loraGroups"] });
              if (generation !== this._groupsGeneration) return;
              if (!res.ok) return; // 失败提示已在 _postMeta 内给出，保留弹窗让用户重试
              close();
              this._groupsModal(listEl);
            };
            row.appendChild(delBtn);
            groupGrid.appendChild(row);
          });
          modal.appendChild(groupGrid);
          overlay.appendChild(modal);
          overlay.onclick = (e) => { if (e.target === overlay) close(); };
          document.body.appendChild(overlay);
        });
    }

    // ── 浏览 LoRA ──
    // ── 浏览 LoRA（大图网格：收藏/置顶/分类） ──
    // ── 浏览 LoRA（列表/网格 + 收藏/置顶/分类 + 虚拟滚动） ──
    _browseModal(statusEl) {
      this._closeBrowser?.();
      try {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay bm-overlay bm-overlay-enter";
      const modal = document.createElement("div");
      modal.className = "modal bm-modal-enter bm-modal";
      modal.innerHTML = `
        <div class="bm-header">
          <div class="bm-heading"><span class="bm-kicker">LOCAL LIBRARY</span><h3>${svgIcon("folder", 15)} <span>本地 LoRA</span></h3><span class="bm-total"></span></div>
          <div class="bm-header-actions">
            <button class="bm-mode" type="button"><span class="bm-mode-icon">${svgIcon("list", 12)}</span><span>列表</span></button>
            <button class="bm-url" type="button" title="从 C 站链接下载 LoRA 到本地">${svgIcon("download", 12)}<span>URL 下载</span></button>
            <button class="bm-newcat" type="button">${svgIcon("plus", 12)}<span>分类</span></button>
            <button class="bm-batch-toggle" type="button">${svgIcon("checkSquare", 12)}<span>批量</span></button>
            <button class="bm-close" type="button">${svgIcon("x", 12)}<span>关闭</span></button>
          </div>
        </div>
        <div class="bm-search-row">
          <label class="bm-search-box">${svgIcon("search", 13)}<input class="bm-search" type="text" placeholder="搜索名称、路径、中文名、作者、标签、触发词..." aria-label="搜索 LoRA 名称、路径、中文名、作者、标签或触发词"></label>
          <select class="bm-base-model" aria-label="按底模筛选" title="使用本地 LoRA 管理器的匹配元数据筛选"></select>
          <select class="bm-sort" aria-label="排序方式">
            <option value="name">按名称</option>
            <option value="size">按大小</option>
            <option value="date" selected>按日期（最新在前）</option>
            <option value="usage">按使用次数</option>
          </select>
        </div>
        <div class="bm-body">
          <div class="bm-sidebar"></div>
          <div class="bm-list"></div>
        </div>
        <div class="bm-batchbar"></div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const listEl = modal.querySelector(".bm-list");
      const sidebarEl = modal.querySelector(".bm-sidebar");
      const totalEl = modal.querySelector(".bm-total");
      const searchInput = modal.querySelector(".bm-search");
      const baseModelFilterEl = modal.querySelector(".bm-base-model");
      const sortEl = modal.querySelector(".bm-sort");
      const modeBtn = modal.querySelector(".bm-mode");
      const batchToggle = modal.querySelector(".bm-batch-toggle");
      const batchBar = modal.querySelector(".bm-batchbar");
      const closeBtn = modal.querySelector(".bm-close");
      const newCatBtn = modal.querySelector(".bm-newcat");

      // ── 从 C 站链接批量下载 LoRA ──
      const urlBtn = modal.querySelector(".bm-url");
      urlBtn?.addEventListener("click", () => {
        showBatchDownloadDialog(refreshInventory);
      });

      // 以已有 meta 为起点：打开弹窗瞬间不无条件清空 this.meta，
      // 否则 /anima/meta 拉取失败时 this.meta 永久为空，后续 toggle 会把后端分类/组/偏好整体覆盖清空
      let meta = this.meta && (this.meta.categories?.length || Object.keys(this.meta.loraMeta || {}).length || (this.meta.loraGroups || []).length)
        ? { categories: this.meta.categories || [], loraMeta: this.meta.loraMeta || {}, loraGroups: this.meta.loraGroups || [] }
        : { categories: [], loraMeta: {}, loraGroups: [] };
      this.meta = meta;
      let allLoras = [];
      let baseModelFilter = "";
      let baseModelIndex = { ready: false, byPath: new Map(), models: [] };
      let loraLoadError = "";
      let inventoryReloading = false;
      let mode = "grid";
      let batchMode = false;
      let curFilter = "all";
      let closed = false;
      let matchedLoras = [];
      const selected = new Set();
      if (!this._imgCache) this._imgCache = {};
      // HTML 转义：本地文件名插入 innerHTML 前必须转义，防属性注入与标签注入
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

      const ITEM_W = 150, GAP = 10, CARD_H = 190, ROW_H = CARD_H + GAP; // 卡片全出血图 + 底部半透明浮层，无独立文字区

      let metaSaveQueue = Promise.resolve();
      const saveMeta = () => {
        // 分类点击可能连续发生；按顺序写入，避免旧请求后返回覆盖最新分类快照。
        // 统一走 _postMeta：空壳不落库、失败有提示，不再有"整体覆盖后端 meta"的写法
        metaSaveQueue = metaSaveQueue.catch(() => {}).then(async () => {
          const res = await this._postMeta(meta);
          if (res.ok) return;
          if (res.error === "empty-shell" || res.error === "empty-payload") {
            console.warn("[Anima] 本地 meta 为空壳，已跳过写入（保护后端数据）");
            return;
          }
          throw new Error(`分类同步失败（${res.error}）`);
        }).catch((error) => console.warn("[Anima] 分类同步失败:", error));
        return metaSaveQueue;
      };
      const loraMeta = (name) => {
        const stored = meta.loraMeta[name];
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { categories: [], favorite: false, pinned: false, count: 0 };
        return Array.isArray(stored.categories) ? stored : { ...stored, categories: [] };
      };
      const ensureMeta = (name) => {
        let stored = meta.loraMeta[name];
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) stored = meta.loraMeta[name] = { categories: [], favorite: false, pinned: false, count: 0 };
        if (!Array.isArray(stored.categories)) stored.categories = [];
        return stored;
      };
      const bumpCount = (name, persist = true) => { const em = ensureMeta(name); em.count = (typeof em.count === "number" && Number.isFinite(em.count) && em.count >= 0 ? em.count : 0) + 1; if (persist) saveMeta(); };
      const renderBaseModelOptions = () => {
        baseModelIndex = readLocalBaseModelIndex(allLoras, meta.loraMeta);
        baseModelFilterEl.innerHTML = "";
        const appendOption = (value, label) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          baseModelFilterEl.appendChild(option);
        };
        if (!baseModelIndex.ready) {
          baseModelFilter = "";
          appendOption("", "底模数据未加载");
          baseModelFilterEl.disabled = true;
          baseModelFilterEl.title = "本地管理页尚未缓存 LoRA 匹配元数据";
          return;
        }
        appendOption("", "底模：全部");
        appendOption(BASE_MODEL_UNKNOWN, "未知");
        baseModelIndex.models.forEach(model => appendOption(model, model));
        if (baseModelFilter && baseModelFilter !== BASE_MODEL_UNKNOWN && !baseModelIndex.models.includes(baseModelFilter)) {
          baseModelFilter = "";
        }
        baseModelFilterEl.disabled = false;
        baseModelFilterEl.title = "使用本地 LoRA 管理器的匹配元数据筛选";
        baseModelFilterEl.value = baseModelFilter;
      };
      const fetchLocalLoras = async () => {
        const response = await fetch("/anima/loras");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data?.loras)) throw new Error("本地 LoRA 响应格式无效");
        return data.loras.map(lora => ({ ...lora }));
      };
      const refreshInventory = () => {
        if (closed || inventoryReloading) return;
        inventoryReloading = true;
        fetchLocalLoras().then(loras => {
          if (closed) return;
          allLoras = loras;
          loraLoadError = "";
          renderBaseModelOptions();
          totalEl.textContent = `共 ${allLoras.length} 个`;
          renderSidebar();
          renderCurrent();
        }).catch(error => {
          loraLoadError = error?.message || String(error);
          if (allLoras.length) showToast("本地 LoRA 刷新失败，仍显示现有列表：" + loraLoadError);
        }).finally(() => {
          inventoryReloading = false;
          if (!closed && !allLoras.length && loraLoadError) renderCurrent();
        });
      };
      const onLocalLoraCacheStorage = (event) => {
        if (event.key !== LOCAL_LORA_CACHE_KEY && event.key !== null) return;
        renderBaseModelOptions();
        renderCurrent();
      };
      window.addEventListener("storage", onLocalLoraCacheStorage);
      const infoSession = new LoraLookupSession(loraInfoClient);
      const getInfoQueued = name => infoSession.get({ name }).then(info => {
        if (closed) return null;
        // Presentation snapshot for filtering and already mounted cards.
        if (info) this._imgCache[name] = info;
        return info;
      }).catch(() => null);
      // ── 打开 C 站：有 modelId 直接进模型页；没有（懒加载未完成或未匹配到）则占位窗口 + 现查，
      //    确无匹配才回退名称搜索——避免"点 🔗 永远进搜索页"（9532e96 重构遗留）
      const openCivitai = (name, getMid) => {
        const mid = getMid();
        if (mid) { window.open("https://civitai.com/models/" + mid, "_blank"); return; }
        showToast("⏳ 正在获取 C 站链接…");
        const w = window.open("", "_blank");
        getInfoQueued(name).then((info) => {
          if (closed) { if (w && !w.closed) w.close(); return; }
          const m = info && info.modelId;
          if (m) {
            if (w && !w.closed) w.location.href = "https://civitai.com/models/" + m;
            else window.open("https://civitai.com/models/" + m, "_blank");
          } else {
            if (w && !w.closed) w.close();
            // 区分"查询失败(可能未开代理)"与"确实无匹配"：失败时提示用户开代理后重试
            const src = (info && info.source) || "";
            if (src.startsWith("error") || src.startsWith("http_")) {
              showToast("⚠️ 获取 C 站链接失败(可能未开代理)，已改为搜索，开代理后可重试");
            } else {
              showToast("此模型在 C 站未匹配到，已跳转搜索");
            }
            window.open("https://civitai.com/search/models?query=" + encodeURIComponent(name) + "&type=LORA", "_blank");
          }
        });
      };
      // C 站图片走后端代理（浏览器无代理无法直连 image.civitai.com）；卡片用 400px 小图省流量
      // （白名单代理逻辑为类级方法 this._imgProxy，_browseModal 与 _showTwTooltip 共用）

      const manualRefresh = () => { if (!closed && searchInput.value) renderCurrent(); };
      this._manualRefresh = manualRefresh;
      const getMatched = () => {
        const q = searchInput.value || "";
        const addedNames = new Set(this.loras.map((l) => l.name.toLowerCase()));
        const k = sortEl.value;
        const numericValue = (value) => {
          if (typeof value !== "number" && typeof value !== "string") return 0;
          if (typeof value === "string" && !value.trim()) return 0;
          const number = Number(value);
          return Number.isFinite(number) && number >= 0 ? number : 0;
        };
        const compareStableIdentity = (left, right) => {
          const nameOrder = String(left.name || "").localeCompare(String(right.name || ""), "zh");
          if (nameOrder) return nameOrder;
          const leftPath = left.relativePath || left.filename || "";
          const rightPath = right.relativePath || right.filename || "";
          return String(leftPath).localeCompare(String(rightPath), "zh");
        };
        return allLoras
          .map((l) => {
            const m = loraMeta(l.name);
            const baseModel = baseModelIndex.byPath.get(normalizeLoraName(l.relativePath || l.filename));
            if (baseModelFilter === BASE_MODEL_UNKNOWN && baseModel) return null;
            if (baseModelFilter && baseModelFilter !== BASE_MODEL_UNKNOWN && baseModel !== baseModelFilter) return null;
            if (curFilter === "__uncategorized__") { if ((m.categories || []).length) return null; }
            else if (curFilter !== "all" && meta.categories.includes(curFilter) && !(Array.isArray(m.categories) ? m.categories : []).includes(curFilter)) return null;
            const info = this._imgCache[l.name] || this.loraInfoMap[l.name] || null;
            const effective = this._effectiveWords?.(l.name, info?.trainedWords);
            const searchIndex = q ? loraSearchIndex(l, m, {...info, trainedWords: effective}) : null;
            if (q && !matchesLoraSearch(searchIndex, q)) return null;
            return { l, m, searchScore: q ? loraSearchScore(searchIndex, q) : 0 };
          })
          .filter(Boolean)
          .sort((a, b) => {
            const left = a.l;
            const right = b.l;
            // 显式排序键决定使用次数/大小/日期顺序；非法计数降为 0，稳定并列按名称和完整路径。
            if (k === "usage") {
              const countOrder = numericValue(b.m?.count) - numericValue(a.m?.count);
              return countOrder || compareStableIdentity(left, right);
            }
            if (k === "size") {
              const sizeOrder = numericValue(right.size) - numericValue(left.size);
              return sizeOrder || compareStableIdentity(left, right);
            }
            if (k === "date") {
              const dateOrder = numericValue(right.lastModified) - numericValue(left.lastModified);
              return dateOrder || compareStableIdentity(left, right);
            }
            // 名称排序保留搜索相关性，再以已添加状态作为同搜索结果中的次序提示。
            if (a.searchScore !== b.searchScore) return b.searchScore - a.searchScore;
            // 已添加到节点的 LoRA 置顶
            const addedA = addedNames.has(left.name.toLowerCase()) ? 1 : 0;
            const addedB = addedNames.has(right.name.toLowerCase()) ? 1 : 0;
            if (addedA !== addedB) return addedB - addedA;
            return compareStableIdentity(left, right);
          })
          .map((entry) => entry.l);
      };

      // ── 侧边栏分类 ──
      const renderSidebar = () => {
        sidebarEl.innerHTML = "";
        const mk = (key, label, count, icon) => {
          const item = document.createElement("button");
          item.className = `bm-filter-btn${curFilter === key ? " is-active" : ""}`;
          item.innerHTML = `<span class="bm-filter-label">${svgIcon(icon || "grid", 12)}<span>${esc(label)}</span></span><span class="bm-filter-count">${esc(String(count))}</span>`;
          item.onclick = () => { curFilter = (curFilter === key) ? "all" : key; renderSidebar(); renderCurrent(); };
          sidebarEl.appendChild(item);
        };
        mk("all", "全部", allLoras.length, "");
        meta.categories.forEach((cat) => {
          mk(cat, cat, allLoras.filter((l) => loraMeta(l.name).categories.includes(cat)).length, "tag");
        });
        // 未分类 = 未归属任何分类（key __uncategorized__ 与面板「LoRA 管理」侧栏约定一致）
        mk("__uncategorized__", "未分类", allLoras.filter((l) => !(loraMeta(l.name).categories || []).length).length, "tag");
      };

      // ── 预览图懒加载 ──
      const io = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const img = en.target;
          io.unobserve(img);
          const name = img.dataset.loraName;
          getInfoQueued(name).then((info) => {
            if (!info) return;
            if (closed || img.isConnected === false) return;
            if (info.previewUrl) {
              img.innerHTML = `<img class="bm-thumb-img" decoding="async" src="${this._imgProxy(info.previewUrl)}" onerror="this.style.display='none'">`;
            } else {
              img.innerHTML = `<span class="bm-img-fallback ${info.source === "not_on_civitai" ? "is-missing" : ""}">${info.source === "not_on_civitai" ? svgIcon("x", 24) : svgIcon("image", 24)}</span>`;
            }
            const host = img.closest(".bm-card") || img.closest(".bm-li");
            applyInfo(host, info);
            if (host && info.trainedWords && info.trainedWords.length) { this.triggerWordMap[name] = info.trainedWords; this._pushTriggerWords(); this._updateTwStatus(); }
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
        if (twEl) twEl.textContent = tw.length ? "触发词 · " + tw.slice(0, 2).join(", ") + (tw.length > 2 ? "..." : "") : "";
        if (mnameEl && info.modelName && info.modelName !== host.dataset.name) {
          mnameEl.textContent = info.modelName;
          mnameEl.title = info.modelName;
          if (lnameEl) { lnameEl.textContent = "本地: " + host.dataset.name; lnameEl.style.display = "block"; }
        }
        if (metaEl) {
          const parts = [];
          if (info.versionName) parts.push(info.versionName);
          if (info.creator) parts.push(info.creator);
          if (parts.length) { metaEl.textContent = parts.join(" · "); metaEl.style.display = "block"; }
        }
        // C 站 modelId：有则点按钮直接进模型页，无则点按钮跳名称搜索
        if (info.modelId) host.dataset.modelId = info.modelId;
      };

      const paintThumb = (imgEl, name) => {
        const cached = this._imgCache[name];
        if (cached) {
          imgEl.innerHTML = cached.previewUrl
            ? `<img class="bm-thumb-img" decoding="async" src="${this._imgProxy(cached.previewUrl)}" onerror="this.style.display='none'">`
            : `<span class="bm-img-fallback ${cached.source === "not_on_civitai" ? "is-missing" : ""}">${svgIcon(cached.source === "not_on_civitai" ? "x" : "image", 24)}</span>`;
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
        if (added) card.classList.add("is-added");
        if (selected.has(l.name)) card.classList.add("is-selected");
        card.dataset.name = l.name;
        card.title = l.name; // 本地文件名悬停可见（卡片不再显示"本地:"行）
        const left = (idx % cols) * (ITEM_W + GAP);
        const top = Math.floor(idx / cols) * ROW_H;
        card.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${ITEM_W}px;height:${ROW_H - GAP}px;border-radius:8px;overflow:hidden;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);cursor:pointer;`;
        card.innerHTML = `
          <div class="bm-img" data-lora-name="${esc(l.name)}"><span class="bm-img-fallback">${svgIcon("image", 24)}</span></div>
          <div class="bm-badge" style="display:${added ? "flex" : "none"};">${svgIcon("check", 11)}</div>
          <div class="bm-card-actions">
            <button class="bm-catbtn ${m.categories.length ? "is-active" : ""}" title="分配分类" aria-label="分配分类">${svgIcon("tag", 12)}</button>
            <button class="bm-csite" title="打开 C 站页面" aria-label="打开 C 站页面">${svgIcon("link", 12)}</button>
          </div>
          <div class="bm-card-info">
            <div class="bm-mname">${esc(l.name)}</div>
            <div class="bm-meta"></div>
            <div class="bm-cattags"></div>
          </div>
        `;
        const catTagsEl = card.querySelector(".bm-cattags");
        m.categories.forEach((cat) => {
          const t = document.createElement("span");
          t.textContent = cat;
          t.title = "点击移除分类";
          t.className = "bm-cat-tag";
          t.onclick = (ev) => {
            ev.stopPropagation();
            ensureMeta(l.name).categories = ensureMeta(l.name).categories.filter((c) => c !== cat);
            saveMeta(); renderSidebar(); renderCurrent();
          };
          catTagsEl.appendChild(t);
        });
        card.querySelector(".bm-catbtn").onclick = (ev) => {
          ev.stopPropagation();
          this._showCatPicker(card, l.name, meta, saveMeta, () => { renderSidebar(); renderCurrent(); });
        };
        card.querySelector(".bm-csite").onclick = (ev) => {
          ev.stopPropagation();
          openCivitai(l.name, () => card.dataset.modelId);
        };
        card.oncontextmenu = (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          this._showCatContextMenu(card, l.name, meta, saveMeta, () => { renderSidebar(); renderCurrent(); });
        };
        card.onclick = (ev) => {
          if (ev.target.closest(".bm-catbtn") || ev.target.closest(".bm-csite") || ev.target.closest(".bm-cattags")) return;
          if (batchMode) {
            if (selected.has(l.name)) selected.delete(l.name);
            else selected.add(l.name);
            card.classList.toggle("is-selected", selected.has(l.name));
            updateBatchBar();
            return;
          }
          // 非批量模式：点击卡片始终切换 lora 添加/移除；若存在拖拽框选残留则一并清除，
          // 否则残留的 selected 会拦截点击，导致无法取消/添加
          if (selected.size > 0) {
            selected.clear();
            listEl.querySelectorAll(".bm-card, .bm-li").forEach((c) => c.classList.remove("is-selected"));
            updateBatchBar();
          }
          const existing = this.loras.find((e2) => e2.name.toLowerCase() === l.name.toLowerCase());
          const badge = card.querySelector(".bm-badge");
          if (existing) {
            this.loras = this.loras.filter((e2) => e2.name.toLowerCase() !== l.name.toLowerCase());
            this._commit(); this._render(this.listEl);
            card.classList.remove("is-added");
            if (badge) badge.style.display = "none";
            showToast("已移除: " + l.name);
          } else {
            this.loras.push({ name: l.name, weight: 1.0, disabled: this._prefDisabled(l.name) });
            bumpCount(l.name);
            this._commit(); this._render(this.listEl);
            card.classList.add("is-added");
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
        if (added) row.classList.add("is-added");
        if (selected.has(l.name)) row.classList.add("is-selected");
        row.dataset.name = l.name;
        row.style.cssText = "cursor:pointer;";
        row.innerHTML = `
          <div class="bm-li-thumb" data-lora-name="${esc(l.name)}"><span class="bm-img-fallback">${svgIcon("image", 18)}</span></div>
          <div class="bm-li-copy">
            <div class="bm-mname">${esc(l.name)}</div>
            <div class="bm-lname"></div>
            <div class="bm-meta"></div>
          </div>
          <div class="bm-li-actions">
            <button class="bm-catbtn ${m.categories.length ? "is-active" : ""}" title="分配分类" aria-label="分配分类">${svgIcon("tag", 12)}</button>
            <button class="bm-csite" title="打开 C 站页面" aria-label="打开 C 站页面">${svgIcon("link", 12)}</button>
            <span class="bm-li-badge">${added ? svgIcon("check", 12) : ""}</span>
          </div>
        `;
        row.querySelector(".bm-catbtn").onclick = (ev) => {
          ev.stopPropagation();
          this._showCatPicker(row, l.name, meta, saveMeta, () => { renderSidebar(); renderCurrent(); });
        };
        row.querySelector(".bm-csite").onclick = (ev) => {
          ev.stopPropagation();
          openCivitai(l.name, () => row.dataset.modelId);
        };
        row.oncontextmenu = (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          this._showCatContextMenu(row, l.name, meta, saveMeta, () => { renderSidebar(); renderCurrent(); });
        };
        row.onclick = (ev) => {
          if (ev.target.closest(".bm-catbtn") || ev.target.closest(".bm-csite")) return;
          if (batchMode) {
            if (selected.has(l.name)) selected.delete(l.name);
            else selected.add(l.name);
            row.classList.toggle("is-selected", selected.has(l.name));
            updateBatchBar();
            return;
          }
          // 非批量模式：点击行始终切换 lora 添加/移除；清掉拖拽框选残留避免拦截点击
          if (selected.size > 0) {
            selected.clear();
            listEl.querySelectorAll(".bm-card, .bm-li").forEach((r) => r.classList.remove("is-selected"));
            updateBatchBar();
          }
          const existing = this.loras.find((e2) => e2.name.toLowerCase() === l.name.toLowerCase());
          const badge = row.querySelector(".bm-li-badge");
          if (existing) {
            this.loras = this.loras.filter((e2) => e2.name.toLowerCase() !== l.name.toLowerCase());
            this._commit(); this._render(this.listEl);
            row.classList.remove("is-added");
            if (badge) badge.innerHTML = "";
            showToast("已移除: " + l.name);
          } else {
            this.loras.push({ name: l.name, weight: 1.0, disabled: this._prefDisabled(l.name) });
            bumpCount(l.name);
            this._commit(); this._render(this.listEl);
            row.classList.add("is-added");
            if (badge) badge.innerHTML = svgIcon("check", 12);
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
      const visibleCards = new Map();
      // Keep a bounded set of recent rows for reverse scrolling, including decoded images.
      // Indices belong to matchedLoras; filtering/sorting must clear this pool.
      const recentCards = new Map();
      const MAX_RECENT_CARDS = 128;
      let gridFrame = null;
      let listFrame = null;
      let renderGeneration = 0;
      let gridWindow = "";
      const renderEmptyState = (target) => {
        if (loraLoadError && !allLoras.length) {
          target.innerHTML = `<div class="bm-empty"><strong>本地 LoRA 加载失败</strong><span>${esc(loraLoadError)}</span><button type="button" data-bm-retry="1" ${inventoryReloading ? "disabled" : ""}>${inventoryReloading ? "正在重试…" : "重试加载"}</button></div>`;
          target.querySelector("[data-bm-retry]")?.addEventListener("click", refreshInventory);
          return;
        }
        if (!allLoras.length) {
          target.innerHTML = `<div class="bm-empty">${svgIcon("folder", 22)}<strong>未发现本地 LoRA</strong><span>当前 LoRA 目录没有可浏览的文件</span></div>`;
          return;
        }
        target.innerHTML = `<div class="bm-empty">${svgIcon("search", 22)}<strong>没有匹配的 LoRA</strong><span>可清除搜索、底模或分类筛选后重试</span><button type="button" data-bm-clear-filter="1">清除筛选</button></div>`;
        target.querySelector("[data-bm-clear-filter]")?.addEventListener("click", () => {
          searchInput.value = "";
          baseModelFilter = "";
          baseModelFilterEl.value = "";
          curFilter = "all";
          renderSidebar();
          renderCurrent();
        });
      };
      const cancelPendingFrames = () => {
        if (gridFrame !== null) cancelAnimationFrame(gridFrame);
        if (listFrame !== null) cancelAnimationFrame(listFrame);
        gridFrame = listFrame = null;
      };
      const paintGrid = (generation = renderGeneration) => {
        if (generation !== renderGeneration) return;
        if (closed || mode !== "grid" || !contentEl) return;
        const matched = matchedLoras;
        if (!matched.length) {
          renderEmptyState(contentEl);
          contentEl.style.height = "100%";
          return;
        }
        // Read geometry before writing styles to avoid forced layout on every scroll frame.
        const width = listEl.clientWidth, st = listEl.scrollTop, vh = listEl.clientHeight;
        const oldCols = cols;
        cols = Math.max(1, Math.floor((width + GAP) / (ITEM_W + GAP)));
        const rows = Math.max(1, Math.ceil(matched.length / cols));
        const height = rows * ROW_H + "px";
        if (contentEl.style.height !== height) contentEl.style.height = height;
        // One buffered row is enough for the next frame; extra rows cost image paint/layout.
        const rStart = Math.max(0, Math.floor(st / ROW_H) - 1);
        const rEnd = Math.min(rows - 1, Math.ceil((st + vh) / ROW_H) + 1);
        const nextWindow = `${cols}:${rStart}:${rEnd}`;
        if (gridWindow === nextWindow) return;
        gridWindow = nextWindow;
        const first = rStart * cols, last = Math.min(matched.length - 1, (rEnd + 1) * cols - 1);
        for (const [idx, card] of visibleCards) {
          if (idx < first || idx > last) {
            io.unobserve(card.querySelector(".bm-img"));
            card.remove(); visibleCards.delete(idx);
            recentCards.set(idx, card);
            if (recentCards.size > MAX_RECENT_CARDS) recentCards.delete(recentCards.keys().next().value);
          } else if (cols !== oldCols) {
            card.style.left = (idx % cols) * (ITEM_W + GAP) + "px";
            card.style.top = Math.floor(idx / cols) * ROW_H + "px";
          }
        }
        let nextCard = contentEl.firstElementChild;
        for (let idx = first; idx <= last; idx++) {
          let card = visibleCards.get(idx);
          if (!card) {
            card = recentCards.get(idx);
            if (card) {
              recentCards.delete(idx);
              card.style.left = (idx % cols) * (ITEM_W + GAP) + "px";
              card.style.top = Math.floor(idx / cols) * ROW_H + "px";
              card.classList.toggle("is-selected", selected.has(matched[idx].name));
              card.classList.toggle("is-added", this.loras.some(l => l.name.toLowerCase() === matched[idx].name.toLowerCase()));
            } else card = buildCard(matched[idx], idx, cols);
            visibleCards.set(idx, card); contentEl.insertBefore(card, nextCard);
            // An in-flight lookup may have completed while the card was detached.
            const img = card.querySelector(".bm-img"), info = this._imgCache[matched[idx].name];
            if (!info) io.observe(img);
            else if (!img.querySelector("img")) { applyInfo(card, info); paintThumb(img, matched[idx].name); }
          }
          nextCard = card.nextElementSibling;
        }
      };
      const renderGrid = () => {
        listEl.style.display = "block";
        listEl.innerHTML = "";
        contentEl = document.createElement("div");
        contentEl.style.cssText = "position:relative;width:100%;";
        listEl.appendChild(contentEl);
        paintGrid(renderGeneration);
      };

      // ── 列表模式 ──
      const renderListMode = () => {
        listEl.style.display = "block";
        listEl.innerHTML = "";
        const matched = matchedLoras;
        if (!matched.length) {
          renderEmptyState(listEl);
          return;
        }
        // 分片渲染：每帧最多 60 行，避免数百行一次性同步构建阻塞主线程
        const CHUNK = 60;
        const generation = renderGeneration;
        let i = 0;
        const step = () => {
          if (closed || generation !== renderGeneration || mode !== "list") return;
          const end = Math.min(i + CHUNK, matched.length);
          for (; i < end; i++) listEl.appendChild(buildListRow(matched[i]));
          if (i < matched.length) {
            let frameId;
            frameId = requestAnimationFrame(() => {
              if (listFrame === frameId) listFrame = null;
              if (generation === renderGeneration) step();
            });
            listFrame = frameId;
          }
        };
        step();
      };

      const renderCurrent = () => {
        if (closed) return;
        renderGeneration++;
        cancelPendingFrames();
        io.disconnect(); visibleCards.clear(); recentCards.clear(); contentEl = null; gridWindow = "";
        matchedLoras = getMatched();
        listEl.scrollTop = 0;
        if (mode === "grid") renderGrid();
        else renderListMode();
      };

      const updateBatchBar = () => {
        if (batchMode) {
          batchBar.style.display = "block";
          if (!batchBar.querySelector(".bm-batch-add")) batchBar.innerHTML = `<button class="bm-batch-add" type="button">${svgIcon("plus", 13)}<span></span></button>`;
          const addBtn = batchBar.querySelector(".bm-batch-add");
          addBtn.querySelector("span").textContent = `添加选中（${selected.size}）`;
          addBtn.onclick = () => {
            const toAdd = Array.from(selected).filter((n) => !this.loras.some((e) => e.name.toLowerCase() === n.toLowerCase()));
            if (!toAdd.length) { showToast("没有新的 LoRA 可添加"); return; }
            toAdd.forEach((n) => { this.loras.push({ name: n, weight: 1.0, disabled: this._prefDisabled(n) }); bumpCount(n, false); });
            saveMeta();
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
      let dragFrame = null;
      let dragPointer = null;
      const onBMDown = (e) => {
        const target = e.target;
        if (!listEl.contains(target)) return;
        if (target.closest("button, input, select, .bm-catbtn, .bm-cattags")) return;
        if (e.button !== 0) return;
        dragBox.active = true; dragBox.boxed = false;
        dragBox.startX = e.pageX; dragBox.startY = e.pageY;
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        e.preventDefault(); e.stopPropagation();
        dragBox.rect = document.createElement("div");
        dragBox.rect.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:0;height:0;z-index:999999;background:rgba(230,223,211,0.10);border:2px dashed rgba(230,223,211,0.62);pointer-events:none;border-radius:8px`;
        document.body.appendChild(dragBox.rect);
      };
      const paintBMDrag = (e) => {
        if (!dragBox.active || !dragBox.rect) return;
        const l = Math.min(dragBox.startX, e.pageX), t = Math.min(dragBox.startY, e.pageY);
        const r = Math.max(dragBox.startX, e.pageX), b = Math.max(dragBox.startY, e.pageY);
        const sx = window.scrollX, sy = window.scrollY;
        dragBox.rect.style.cssText = `position:fixed;left:${l - sx}px;top:${t - sy}px;width:${r - l}px;height:${b - t}px;z-index:999999;background:rgba(230,223,211,0.10);border:2px dashed rgba(230,223,211,0.62);pointer-events:none;border-radius:8px`;
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
            el.classList.toggle("is-selected", selected.has(el.dataset.name));
          });
          listEl.querySelectorAll(".bm-li").forEach((el) => {
            el.classList.toggle("is-selected", selected.has(el.dataset.name));
          });
          updateBatchBar();
        }
      };
      const onBMMove = (e) => {
        if (!dragBox.active) return;
        dragPointer = { pageX: e.pageX, pageY: e.pageY };
        if (dragFrame !== null) return;
        dragFrame = requestAnimationFrame(() => {
          dragFrame = null;
          if (dragPointer) paintBMDrag(dragPointer);
        });
      };
      const onBMUp = () => {
        if (!dragBox.active) return;
        if (dragFrame !== null) cancelAnimationFrame(dragFrame);
        dragFrame = null;
        if (dragPointer) paintBMDrag(dragPointer);
        dragPointer = null;
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
        if (dragFrame !== null) cancelAnimationFrame(dragFrame);
        dragFrame = null; dragPointer = null;
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
        if (closed) return;
        closed = true;
        if (this._manualRefresh === manualRefresh) this._manualRefresh = null;
        renderGeneration++;
        clearTimeout(_searchTimer);
        cancelPendingFrames();
        infoSession.dispose();
        if (this._closeBrowser === closeModal) this._closeBrowser = null;
        visibleCards.clear(); recentCards.clear(); contentEl = null;
        cancelBMDrag();
        // 释放资源：断开图片观察器、取消在途 C 站匹配请求（避免占满连接池导致二次打开列表加载不出）、恢复拖拽选中态、清理分类弹层
        io.disconnect();
        document.body.style.userSelect = "";
        document.body.style.webkitUserSelect = "";
        this._views.get("categories")?.();
        window.removeEventListener("resize", onResize);
        window.removeEventListener("storage", onLocalLoraCacheStorage);
        document.removeEventListener("mousedown", onBMDown, true);
        document.removeEventListener("mousemove", onBMMove, true);
        document.removeEventListener("mouseup", onBMUp, true);
        document.removeEventListener("click", onBMClick, true);
        window.removeEventListener("blur", cancelBMDrag);
        document.removeEventListener("visibilitychange", onBMVisibility);
        document.removeEventListener("mouseleave", cancelBMDrag);
        overlay.remove();
      };
      this._closeBrowser = closeModal;
      closeBtn.onclick = closeModal;
      overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
      searchInput.onkeydown = (e) => { if (e.key === "Escape") closeModal(); };
      modeBtn.onclick = () => {
        mode = mode === "grid" ? "list" : "grid";
        modeBtn.innerHTML = `${svgIcon(mode === "grid" ? "list" : "grid", 12)}<span>${mode === "grid" ? "列表" : "网格"}</span>`;
        renderCurrent();
      };
      batchToggle.onclick = () => {
        batchMode = !batchMode;
        selected.clear();
        batchToggle.innerHTML = `${svgIcon(batchMode ? "x" : "checkSquare", 12)}<span>${batchMode ? "退出批量" : "批量"}</span>`;
        batchToggle.classList.toggle("is-active", batchMode);
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
      // 搜索防抖：每次按键全量重建列表/网格代价高，150ms 合并连续输入
      let _searchTimer = null;
      searchInput.oninput = () => {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(renderCurrent, 150);
      };
      baseModelFilterEl.onchange = () => {
        baseModelFilter = baseModelFilterEl.value;
        renderCurrent();
      };
      sortEl.onchange = () => renderCurrent();
      listEl.addEventListener("scroll", () => {
        if (closed || mode !== "grid" || gridFrame !== null) return;
        const generation = renderGeneration;
        let frameId;
        frameId = requestAnimationFrame(() => {
          if (gridFrame === frameId) gridFrame = null;
          if (generation === renderGeneration) paintGrid(generation);
        });
        gridFrame = frameId;
      }, { passive: true });
      // 分辨率自适应：以 1080p 为基准等比放大弹窗（2K≈1.33x、4K 封顶 2x），低分屏保持 1:1。
      // transform 视觉缩放：布局盒/虚拟滚动/内部滚动条不动，字号与卡片观感随分辨率同步变大。
      const fitModalScale = () => {
        const s = Math.min(2, Math.max(1, Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
        // 设在根元素：浏览弹窗与分组管理弹窗共用同一缩放变量
        document.documentElement.style.setProperty("--bm-scale", s.toFixed(3));
      };
      fitModalScale();
      const onResize = () => { fitModalScale(); if (mode === "grid") paintGrid(renderGeneration); };
      window.addEventListener("resize", onResize);

      // ── 加载数据 ──
      Promise.all([
        fetchLocalLoras().then(loras => ({ loras, error: "" })).catch(error => ({ loras: [], error: error?.message || String(error) })),
        this._fetchMeta().catch(() => null),
      ]).then(([lData, mData]) => {
        if (closed) return;
        allLoras = lData.loras;
        loraLoadError = lData.error;
        this._loadTriggerOverrides?.(allLoras.map(l => l.name), true).catch(error => console.warn("[TK] 自定义触发词读取失败", error));
        // 只有后端确有数据时才整体替换；失败/空结果保留当前 this.meta（含之前加载的旧值），防止空 meta 覆盖后端
        const hasBackendMeta = mData && typeof mData === "object" && (
          (Array.isArray(mData.categories) && mData.categories.length) ||
          Object.keys(mData.loraMeta || {}).length ||
          (Array.isArray(mData.loraGroups) && mData.loraGroups.length)
        );
        if (hasBackendMeta) {
          meta = this.meta = { categories: mData.categories || [], loraMeta: mData.loraMeta || {}, loraGroups: mData.loraGroups || [] };
          this._metaLoaded = true;
        } else if (mData === null) {
          // 后端读取失败 → 本地镜像兜底恢复，避免后续 saveMeta 拿空壳把后端 meta 覆盖清空
          const mirror = loadMetaMirror();
          if (mirror && !metaIsEmptyShell(mirror) && metaIsEmptyShell(meta)) {
            meta = this.meta = {
              categories: Array.isArray(mirror.categories) ? mirror.categories : [],
              loraMeta: mirror.loraMeta && typeof mirror.loraMeta === "object" ? mirror.loraMeta : {},
              loraGroups: Array.isArray(mirror.loraGroups) ? mirror.loraGroups : [],
            };
            showToast("已用本地备份恢复（后端读取失败）");
          }
        }
        renderBaseModelOptions();
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

    // ── 分类分配下拉（连续勾选：点击分类后保持打开继续勾选，点「完成」或点击外部才关闭，与面板 LoRA 管理一致） ──
    _showCatPicker(card, name, meta, saveMeta, renderList) {
      if (this._disposed) return;
      const picker = document.createElement("div");
      picker.className = "bm-catpicker";
      picker.style.cssText = "position:fixed;z-index:100000;background:linear-gradient(180deg,#16161b,#101014);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px;max-width:220px;box-shadow:0 12px 40px rgba(0,0,0,0.6);";
      const rect = card.getBoundingClientRect();
      let m = meta.loraMeta[name];
      if (!m) m = meta.loraMeta[name] = { categories: [], favorite: false, pinned: false };
      const renderBody = () => {
        let html = '<div class="bm-cat-title">分配分类</div>';
        if (!meta.categories.length) html += '<div class="bm-cat-empty">暂无分类，点「分类」创建</div>';
        meta.categories.forEach((cat) => {
          const on = m.categories.includes(cat);
          html += `<button class="bm-cat-option${on ? " is-active" : ""}" data-cat="${escAttr(cat)}" aria-pressed="${on}">${svgIcon(on ? "checkSquare" : "square", 12)}<span>${esc(cat)}</span></button>`;
        });
        html += `<button class="bm-cat-done" data-cat-done>${svgIcon("check", 12)}<span>完成</span></button>`;
        picker.innerHTML = html;
        picker.querySelectorAll("[data-cat]").forEach((btn) => {
          btn.onclick = (ev) => {
            ev.stopPropagation();
            const cat = btn.dataset.cat;
            if (m.categories.includes(cat)) m.categories = m.categories.filter((c) => c !== cat);
            else m.categories.push(cat);
            saveMeta(); renderList();
            renderBody(); // 保持打开，仅刷新勾选态
          };
        });
        picker.querySelector("[data-cat-done]").onclick = (ev) => { ev.stopPropagation(); close(); };
      };
      let outsideTimer;
      const close = this._ownView("categories", () => {
        clearTimeout(outsideTimer); picker.remove(); document.removeEventListener("mousedown", rm, true);
      });
      const rm = (e) => { if (!picker.contains(e.target)) close(); };
      renderBody();
      document.body.appendChild(picker);
      let left = rect.right + 6;
      if (left + 220 > window.innerWidth) left = rect.left - 220 - 6;
      picker.style.left = left + "px";
      picker.style.top = Math.max(4, rect.top) + "px";
      outsideTimer = setTimeout(() => document.addEventListener("mousedown", rm, true), 10);
    }

    // ── 右键分类菜单（支持拖拽多选批量；连续勾选：保持打开直到「完成」/点击外部，与面板 LoRA 管理一致） ──
    _showCatContextMenu(host, name, meta, saveMeta, onDone) {
      if (this._disposed) return;
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
        // toggle：所有目标都已选该分类 → 取消；否则 → 添加（单个与批量都适用）
        const allOn = targets.every((n) => (meta.loraMeta[n] || {}).categories?.includes(cat));
        targets.forEach((n) => {
          const mm = meta.loraMeta[n] || (meta.loraMeta[n] = { categories: [], favorite: false, pinned: false });
          if (allOn) mm.categories = mm.categories.filter((c) => c !== cat);
          else if (!mm.categories.includes(cat)) mm.categories.push(cat);
        });
        saveMeta();
        if (sel && this._bmSelected) this._bmSelected.clear();
        onDone && onDone();
      };
      const renderBody = () => {
        let html = `<div class="bm-cat-title">${sel ? `批量添加分类 (${targets.length} 个)` : "分配分类"}</div>`;
        if (!meta.categories.length) html += '<div class="bm-cat-empty">暂无分类，先点顶部「分类」创建</div>';
        meta.categories.forEach((cat) => {
          const allOn = targets.every((n) => (meta.loraMeta[n] || {}).categories?.includes(cat));
          html += `<button class="bm-cat-option${allOn ? " is-active" : ""}" data-cat="${escAttr(cat)}" aria-pressed="${allOn}">${svgIcon(allOn ? "checkSquare" : "square", 12)}<span>${esc(cat)}</span></button>`;
        });
        html += `<button class="bm-cat-done" data-cat-done>${svgIcon("check", 12)}<span>完成</span></button>`;
        picker.innerHTML = html;
        picker.querySelectorAll("[data-cat]").forEach((btn) => {
          btn.onclick = (ev) => {
            ev.stopPropagation();
            apply(btn.dataset.cat);
            renderBody(); // 保持打开，刷新勾选态（targets 闭包快照继续生效，可连续勾选多个分类）
          };
        });
        picker.querySelector("[data-cat-done]").onclick = (ev) => { ev.stopPropagation(); close(); };
      };
      let outsideTimer;
      const close = this._ownView("categories", () => {
        clearTimeout(outsideTimer); picker.remove(); document.removeEventListener("mousedown", rm, true);
      });
      const rm = (e) => { if (!picker.contains(e.target)) close(); };
      renderBody();
      document.body.appendChild(picker);
      let left = rect.right + 6;
      if (left + 200 > window.innerWidth) left = rect.left - 200 - 6;
      picker.style.left = left + "px";
      picker.style.top = Math.max(4, rect.top) + "px";
      outsideTimer = setTimeout(() => document.addEventListener("mousedown", rm, true), 10);
    }

    // ── 组悬浮预览：列出组内每个 LoRA（名称+权重，触发词已知则附上） ──
    _showGroupPopover(anchorEl, group) {
      if (this._disposed) return;
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const popover = document.createElement("div");
      popover.className = "anima-group-popover anima-tw-popover";
      popover.style.maxWidth = "360px";
      popover.style.maxHeight = "70vh";
      popover.style.overflowY = "auto";
      const loras = group.loras || [];
      let items = "";
      if (!loras.length) {
        items = '<span class="tw-empty">空组</span>';
      } else {
        items = loras.map((l) => {
          const tw = this._effectiveWords(l.name, l.trigger_words?.length ? l.trigger_words : this.triggerWordMap[l.name]);
          const weight = (l.weight ?? 1);
          const wordHtml = (tw !== undefined && tw !== null && tw.length)
            ? `<div style="display:flex;flex-wrap:wrap;gap:2px;margin:3px 0 6px;">${tw.map((x) => `<span class="tw-word" data-copy="${esc(x)}">${esc(x)}</span>`).join("")}</div>`
            : `<div style="font-size:9px;color:rgba(255,255,255,0.3);margin:2px 0 6px;">触发词未获取</div>`;
          return `<div style="border-bottom:1px solid rgba(255,255,255,0.05);padding:3px 0;"><div class="tw-title" style="font-size:10px;color:#EDEDEF;font-weight:600;">${esc(l.name)} <span style="opacity:.5;font-weight:400;">×${weight}</span></div>${wordHtml}</div>`;
        }).join("");
      }
      popover.innerHTML = `<div class="tw-title" style="font-size:11px;color:#EDEDEF;font-weight:600;margin-bottom:5px;">${esc(group.name)}（${loras.length}）</div>${items}`;
      document.body.appendChild(popover);

      // 定位（与单 LoRA 弹窗一致）
      const rect = anchorEl.getBoundingClientRect();
      const pRect = popover.getBoundingClientRect();
      let left = Math.max(4, Math.min(rect.left, window.innerWidth - pRect.width - 4));
      let top = rect.bottom + 4;
      if (top + pRect.height > window.innerHeight) { top = rect.top - pRect.height - 4; }
      popover.style.left = left + "px";
      popover.style.top = top + "px";

      // 点击触发词复制
      popover.addEventListener("click", (e) => {
        const wordEl = e.target.closest(".tw-word");
        if (wordEl) {
          e.stopPropagation();
          copyText(wordEl.dataset.copy || wordEl.textContent);
          showToast(`已复制: ${wordEl.textContent}`);
        }
      });

      // 点击外部关闭（hover 由 mouseleave 处理）
      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !anchorEl.contains(e.target)) {
          close();
        }
      };
      const close = this._ownView("popover", () => {
        popover.remove(); document.removeEventListener("click", closeHandler, true);
      });
      document.addEventListener("click", closeHandler, true);
    }

    // ── 触发词 tooltip 弹窗 ──
    _showTwTooltip(anchorEl, loraName, mode) {
      if (this._disposed) return;
      // 触发词来自 C 站第三方数据，插入 innerHTML 前必须完整转义
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const escAttr = (s) => esc(s);

      if (this._triggerEditor) return;
      const words = this._effectiveWords(loraName);
      const info = this.loraInfoMap[loraName];
      const popover = document.createElement("div");
      popover.className = "anima-tw-popover";

      // ── 预览图（C 站图片走后端代理，400px 小图；非白名单 URL 由 this._imgProxy 降级空串，onerror 兜底占位）──
      let previewHtml = "";
      if (info && info.previewUrl) {
        previewHtml = `<div class="tw-preview"><img src="${escAttr(this._imgProxy(info.previewUrl))}" alt="" onerror="this.parentElement.innerHTML='<span class=tw-preview-fallback>无预览图</span>'"></div>`;
      } else if (info && info.modelName) {
        previewHtml = `<div class="tw-preview tw-preview-fallback">${esc(info.modelName)}</div>`;
      }

      // ── 模型名 / 作者 ──
      let metaHtml = "";
      if (info && (info.modelName || info.creator)) {
        metaHtml = `<div class="tw-meta">${info.creator ? esc(info.creator) + " · " : ""}${esc(info.modelName || "")}</div>`;
      }

      let wordHtml;
      if (words === undefined) {
        wordHtml = '<span class="tw-empty">暂未获取到触发词，请先运行「提取」</span>';
      } else if (words === null) {
        wordHtml = '<span class="tw-empty">查询失败，可重新提取或悬停重试</span>';
      } else if (words.length) {
        // 悬浮预览内不再放"复制全部"（节点工具栏「全部触发词」按钮已有此功能；悬浮层会随鼠标离开消失，点了也白点）
        wordHtml = words.map((w) => `<span class="tw-word" data-copy="${esc(w)}">${esc(w)}</span>`).join("");
      } else {
        wordHtml = '<span class="tw-empty">该 LoRA 无触发词</span>';
      }

      const safeName = esc(loraName);
      popover.innerHTML = `${previewHtml}<div class="tw-title" style="font-size:11px;color:#EDEDEF;font-weight:600;">${safeName}</div>${metaHtml}<div class="tw-title">${triggerOverrides.entry(loraName)?.hasOverride ? "自定义触发词" : "触发词"}</div><div style="display:flex;flex-wrap:wrap;gap:2px;">${wordHtml}</div>`;
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
        }
      });

      // 点击外部关闭（hover 模式下由 mouseleave 处理）
      const closeHandler = (e) => {
          if (!popover.contains(e.target) && e.target !== anchorEl) {
            close();
          }
      };
      const close = this._ownView("popover", () => {
        popover.remove(); document.removeEventListener("click", closeHandler, true);
      });
      if (mode !== "hover") {
        document.addEventListener("click", closeHandler, true);
      }
    }
  }

  init();
