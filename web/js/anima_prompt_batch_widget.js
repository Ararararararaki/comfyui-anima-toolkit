// Anima Prompt Batch 节点前端 Widget + 队列展开
//
// 功能：
//   1. 节点内 UI：提示词文件选择（多文件）、分组勾选（条数/预览）、
//      正向/负向目标文本节点选择、相机控制节点选择
//   2. 队列展开：包装 app.queuePrompt —— 把一次队列按「组×提示词」顺序展开为 N 个任务，
//      逐个把提示词注入目标文本节点（复用 ComfyUI 原生 seed/批量/进度/历史逻辑）
//
// 适配所有工作流：注入目标用下拉框任意选择（CLIPTextEncode / Flux / 任意 STRING widget）。
(function () {
  const NODE_NAME = "TK Prompt Batch";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const escAttr = (s) => esc(s);

  // ── 最近使用文件（localStorage 持久化，跨节点共享）──
  const RECENT_KEY = "anima_tk_recent_files";
  function loadRecentFiles() {
    try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  function saveRecentFiles(list) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))) } catch { /* 存储不可用忽略 */ }
  }
  function rememberFile(path, mtime) {
    const list = loadRecentFiles().filter((r) => r.path !== path);
    list.unshift({ path, mtime: mtime || 0, ts: Date.now() });
    saveRecentFiles(list);
  }
  function fmtMtime(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ── 注入目标选择持久化（localStorage，防工作流重载/图重建后选择丢失）──
  // 2026-08-17 修复：用户反馈「正向提示词注入节点被清空」→ 批生成在无注入状态下
  // 提交了 N 份重复提示词。这里按 workflow id + 节点 id 保存目标选择，重载后自动恢复。
  const TARGETS_KEY = "anima_tk_targets_v1";
  function currentWorkflowId(app) {
    try {
      return app?.workflow?.id || app?.activeWorkflow?.id ||
        (app?.workflow?.name) || "default";
    } catch { return "default"; }
  }
  function loadSavedTargets(wfId, nodeId) {
    try {
      const all = JSON.parse(localStorage.getItem(TARGETS_KEY) || "{}");
      const rec = (all[wfId] || {})[String(nodeId)] || {};
      return {
        positive_target: rec.positive_target || "",
        negative_target: rec.negative_target || "",
        camera_target: rec.camera_target || "",
      };
    } catch { return { positive_target: "", negative_target: "", camera_target: "" }; }
  }
  function saveTargets(wfId, nodeId, rec) {
    try {
      const all = JSON.parse(localStorage.getItem(TARGETS_KEY) || "{}");
      all[wfId] = all[wfId] || {};
      all[wfId][String(nodeId)] = rec;
      localStorage.setItem(TARGETS_KEY, JSON.stringify(all));
    } catch { /* 存储不可用忽略 */ }
  }

  // 组机位预设（与相机节点 PRESETS 常用项保持一致；组内优先级：手动 UI > 文件相机行 > 全局相机节点）
  const CAM_PRESETS = {
    "正面": { pos_x: 0, pos_y: 0, pos_z: 0, roll: 0 },
    "背面": { pos_x: 1, pos_y: 0, pos_z: 0, roll: 0 },
    "左侧": { pos_x: 0.5, pos_y: 0, pos_z: 0, roll: 0 },
    "右侧": { pos_x: -0.5, pos_y: 0, pos_z: 0, roll: 0 },
    "正上方俯视": { pos_x: 0, pos_y: 1, pos_z: 0, roll: 0 },
    "俯视": { pos_x: 0, pos_y: 0.5, pos_z: 0, roll: 0 },
    "仰视": { pos_x: 0, pos_y: -0.5, pos_z: 0, roll: 0 },
    "正下方仰视": { pos_x: 0, pos_y: -1, pos_z: 0, roll: 0 },
    "特写": { pos_x: 0, pos_y: 0, pos_z: 1, roll: 0 },
    "近景": { pos_x: 0, pos_y: 0, pos_z: 0.5, roll: 0 },
    "中景": { pos_x: 0, pos_y: 0, pos_z: 0, roll: 0 },
    "全身": { pos_x: 0, pos_y: 0, pos_z: -0.5, roll: 0 },
    "远景": { pos_x: 0, pos_y: 0, pos_z: -1, roll: 0 },
    "荷兰角": { pos_x: 0, pos_y: 0, pos_z: 0, roll: 0.6 },
    "足控仰视": { pos_x: 0, pos_y: -0.5, pos_z: 0.5, roll: 0 },
  };
  const fmtPos = (px, py, pz, rl) => [px, py, pz, rl].map((v) => String(Math.round((parseFloat(v) || 0) * 100) / 100)).join(",");
  const fmtNum = (v) => String(Math.round((parseFloat(v) || 0) * 100) / 100);
  // 机位描述 → /anima/camera/preview 查询串（preset:名 / px,py,pz,roll / 自然语言）
  function cameraToQuery(desc) {
    const s = String(desc || "").trim();
    if (s.startsWith("preset:")) return "preset=" + encodeURIComponent(s.slice(7));
    if (/^[-\d.,，\s]+$/.test(s)) {
      const nums = s.split(/[,，\s]+/).filter(Boolean).map(Number);
      if (nums.length >= 4 && nums.slice(0, 4).every(Number.isFinite)) {
        return `x=${nums[0]}&y=${nums[1]}&z=${nums[2]}&roll=${nums[3]}`;
      }
    }
    return "nl=" + encodeURIComponent(s);
  }

  function apiFetch(path) {
    const api = window.comfyAPI?.api?.api || window.api;
    if (api?.fetchApi) return api.fetchApi(path);
    return fetch(path);
  }
  async function fetchJson(path) {
    const r = await apiFetch(path);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function getGraph(app) {
    // 优先读原始字段 rootGraphInternal，避免触发 graph getter 的 "accessed before initialization" 噪音日志
    if (app.rootGraphInternal) return app.rootGraphInternal;
    return app.rootGraph || app.graph || app.canvas?.graph || null;
  }
  function getNodes(app) {
    const g = getGraph(app);
    if (!g) return [];
    const raw = g.nodes ?? g._nodes ?? [];
    if (Array.isArray(raw)) return raw;
    if (raw instanceof Map) return Array.from(raw.values());
    if (typeof raw === "object") return Object.values(raw);
    return [];
  }
  function findNode(app, id) {
    return getNodes(app).find((n) => String(n.id) === String(id)) || null;
  }

  // 枚举可作为注入目标的文本节点（含 STRING widget 的节点）
  function listTextTargets(app) {
    const out = [];
    for (const n of getNodes(app)) {
      if (!n.widgets || !Array.isArray(n.widgets)) continue;
      for (const w of n.widgets) {
        const isText = (w.type || "").toLowerCase().includes("string") ||
          /text|prompt|positive|negative|string/i.test(w.name || "");
        if (!isText) continue;
        out.push({ nodeId: String(n.id), widget: w.name, title: n.title || n.type || n.comfyClass || String(n.id) });
      }
    }
    return out;
  }
  // 枚举相机控制节点（供「每组独立机位」选择）
  function listCameraTargets(app) {
    const out = [];
    for (const n of getNodes(app)) {
      const cls = n.type || n.comfyClass || "";
      if (/camera/i.test(cls)) {
        out.push({ nodeId: String(n.id), title: n.title || cls });
      }
    }
    return out;
  }

  class BatchUI {
    constructor(node, w) {
      this.node = node;
      this.w = w; // {prompt_files, positive_target, negative_target, camera_target, output_subfolder, groups_selection, region_values, extra_dirs}
      this.cachedGroups = []; // [{file, name, count, prompts, region, camera}]
      this.checked = new Set(); // 选中的 "file::name"
      this.regionValues = new Map(); // "file::name" → "x,y,w,h,s"（UI 编辑值）
      this.cameraValues = new Map(); // "file::name" → 机位描述（NL 文本 / preset:名 / px,py,pz,roll）
      this.openCamKey = null; // 当前展开机位编辑器的组键
      this.rootEl = null;
      this.resultEl = null; // 批次结果反馈区
      this._reportOpen = false;
      this.recentEl = null; // 最近文件行容器
      this.batchActive = false; // 批次展开进行中（吞掉前端 auto_queue 自动重排）
      this.targetStatusEl = null; // 注入目标状态行
    }

    _setW(widget, value) {
      if (!widget) return;
      widget.value = value;
      if (typeof widget.callback === "function") { try { widget.callback(value) } catch {} }
    }

    _fileLines() {
      return (this.w.prompt_files?.value || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }

    // 附加搜索目录（extra_dirs widget：每行一个绝对路径）
    extraDirs() {
      return (this.w.extra_dirs?.value || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }

    // 取最新提示词文件：递归搜索整个 input 树 + 附加目录（AI 写到任意子目录都能找到）
    async fetchLatestPath() {
      try {
        const extra = this.extraDirs();
        const q = extra.length ? "?extra=" + encodeURIComponent(JSON.stringify(extra)) : "";
        const j = await fetchJson("/anima/prompt/latest" + q);
        if (j && j.ok && j.path) return j.path;
      } catch (e) { /* 端点不可用时回退旧逻辑 */ }
      // 回退：旧目录枚举逻辑（prompts/ → input/ 根）
      for (const dir of ["prompts", ""]) {
        try {
          const j = await fetchJson("/anima/prompt/list?dir=" + encodeURIComponent(dir));
          const f = (j.files && j.files[0] && j.files[0].name) || "";
          if (f) return dir ? dir + "/" + f : f;
        } catch (e) { /* 继续尝试下一目录 */ }
      }
      return null;
    }

    // 统一选文件入口：写 widget + 更新显示 + 记入最近 + 解析
    async _selectFile(path, mtime) {
      this._setW(this.w.prompt_files, path);
      if (this.fileCur) this.fileCur.textContent = path;
      rememberFile(path, mtime || 0);
      this._renderRecents();
      this.checked.clear();
      await this._parseFiles();
    }

    // 最近使用文件快捷列表（点击即用）
    _renderRecents() {
      if (!this.recentEl) return;
      const list = loadRecentFiles().filter((r) => r.path);
      const cur = (this.w.prompt_files?.value || "").trim();
      if (!list.length) { this.recentEl.style.display = "none"; return; }
      this.recentEl.style.display = "";
      const chips = list.map((r) => {
        const on = r.path === cur ? " on" : "";
        return `<span class="anima-batch-recent-chip${on}" data-path="${escAttr(r.path)}" title="${escAttr(r.path)}（修改于 ${fmtMtime(r.mtime)}）">${esc(r.path)}</span>`;
      }).join("");
      this.recentEl.innerHTML = `<span class="anima-batch-recent-label">最近</span>${chips}<button class="anima-batch-recent-clear" title="清空最近列表">×</button>`;
      this.recentEl.querySelectorAll(".anima-batch-recent-chip").forEach((el) => {
        el.addEventListener("click", () => {
          const p = el.getAttribute("data-path") || "";
          if (!p) return;
          const rec = loadRecentFiles().find((r) => r.path === p);
          this._selectFile(p, rec ? rec.mtime : 0);
        });
      });
      const clearBtn = this.recentEl.querySelector(".anima-batch-recent-clear");
      if (clearBtn) clearBtn.addEventListener("click", (ev) => { ev.stopPropagation(); saveRecentFiles([]); this._renderRecents(); });
    }

    async _parseFiles() {
      const lines = this._fileLines();
      this.cachedGroups = [];
      for (const p of lines) {
        try {
          const j = await fetchJson("/anima/prompt/parse?path=" + encodeURIComponent(p));
          for (const g of j.groups || []) {
            const rec = { file: p, name: g.name, count: g.count, prompts: g.prompts,
                          region: g.region || null, background: g.background || null, person: g.person || null,
                          camera: g.camera || null, neg: g.neg || null };
            this.cachedGroups.push(rec);
            // 文件里解析出的区域参数作为该组默认值（UI 已改过则保留 UI 值）
            const key = p + "::" + g.name;
            if (!this.regionValues.has(key) && rec.region) {
              this.regionValues.set(key, fmtRegion(rec.region));
            }
            // 组相机：UI 手动设置（cameraValues）优先于文件「相机:」行
            if (!this.cameraValues.has(key) && rec.camera) {
              this.cameraValues.set(key, rec.camera);
            }
          }
        } catch (e) { /* 忽略单文件解析失败 */ }
      }
      // 恢复已勾选（默认全选）
      if (this.checked.size === 0) {
        for (const g of this.cachedGroups) this.checked.add(g.file + "::" + g.name);
      }
      this._renderGroups();
      this._persistSelection();
    }

    _persistSelection() {
      const names = this.cachedGroups.filter((g) => this.checked.has(g.file + "::" + g.name)).map((g) => g.name);
      this._setW(this.w.groups_selection, JSON.stringify(names));
      const regionObj = {};
      for (const [k, v] of this.regionValues) if (v) regionObj[k] = v;
      this._setW(this.w.region_values, JSON.stringify(regionObj));
      const camObj = {};
      for (const [k, v] of this.cameraValues) if (v) camObj[k] = v;
      this._setW(this.w.camera_values, JSON.stringify(camObj));
    }

    _renderGroups() {
      if (!this.listEl) return;
      this.listEl.innerHTML = "";
      if (!this.cachedGroups.length) {
        this.listEl.innerHTML = '<div class="anima-batch-empty">未解析到分组。请填提示词文件后点「解析」。</div>';
        return;
      }
      let total = 0;
      for (const g of this.cachedGroups) {
        const key = g.file + "::" + g.name;
        const wrap = document.createElement("div");
        wrap.className = "anima-batch-group";
        const row = document.createElement("label");
        row.className = "anima-batch-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = this.checked.has(key);
        cb.addEventListener("change", () => { cb.checked ? this.checked.add(key) : this.checked.delete(key); this._persistSelection(); });
        const info = document.createElement("span");
        info.className = "anima-batch-row-info";
        const cnt = g.count ?? (g.prompts || []).length ?? 0;
        info.textContent = `${g.name}（${cnt} 条）`;
        info.title = (g.prompts || []).slice(0, 2).join("\n———\n");
        row.appendChild(cb);
        row.appendChild(info);
        wrap.appendChild(row);

        // 本组机位按钮（有值时高亮）
        const camVal = this.cameraValues.get(key) || "";
        const camBtn = document.createElement("button");
        camBtn.type = "button";
        camBtn.className = "anima-batch-cam-btn" + (camVal ? " has" : "");
        camBtn.textContent = "机位";
        camBtn.title = camVal ? "本组独立机位：" + camVal + "（点开修改）" : "设置本组独立机位；不设置则用全局相机节点";
        camBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.openCamKey = this.openCamKey === key ? null : key;
          this._renderGroups();
        });
        wrap.appendChild(camBtn);

        // 展开的机位编辑器
        if (this.openCamKey === key) {
          wrap.appendChild(this._buildCamEditor(g, key));
        }

        this.listEl.appendChild(wrap);
        if (this.checked.has(key)) total += g.count ?? (g.prompts || []).length ?? 0;
      }
      if (this.countEl) this.countEl.textContent = `共 ${this.cachedGroups.length} 组 · 选中 ${total} 条提示词`;
    }

    // 组机位编辑器：预设下拉 + 自然语言输入 + 手动数值滑块 + 清除
    _buildCamEditor(g, key) {
      const ed = document.createElement("div");
      ed.className = "anima-batch-cam-editor";
      const cur = this.cameraValues.get(key) || "";
      let mode = "nl", text = "", px = 0, py = 0, pz = 0, rl = 0;
      if (cur.startsWith("preset:")) { mode = "preset"; text = cur.slice(7); }
      else if (/^[-\d.,，\s]+$/.test(cur)) {
        const nums = cur.split(/[,，\s]+/).filter(Boolean).map(Number);
        if (nums.length >= 4 && nums.slice(0, 4).every(Number.isFinite)) {
          mode = "pos"; px = nums[0]; py = nums[1]; pz = nums[2]; rl = nums[3];
        } else { text = cur; }
      } else { text = cur; }

      const apply = () => { this._persistSelection(); this._renderGroups(); };

      // ── 模式/预设下拉 ──
      const selRow = document.createElement("div");
      selRow.className = "anima-batch-cam-row";
      const sel = document.createElement("select");
      sel.className = "anima-batch-cam-sel";
      sel.appendChild(new Option("自然语言 / 数值", "nl"));
      for (const n of Object.keys(CAM_PRESETS)) sel.appendChild(new Option("预设 · " + n, "preset:" + n));
      sel.appendChild(new Option("手动数值（4 滑块）", "pos"));
      sel.value = mode;
      sel.addEventListener("change", () => {
        const v = sel.value;
        if (v === "nl") {
          const old = this.cameraValues.get(key) || "";
          if (!old.startsWith("preset:") && !/^[-\d.,，\s]+$/.test(old)) return; // 已是 NL
          this.cameraValues.delete(key);
        } else if (v.startsWith("preset:")) {
          this.cameraValues.set(key, v);
        } else if (v === "pos") {
          this.cameraValues.set(key, fmtPos(px, py, pz, rl));
        }
        apply();
      });
      selRow.appendChild(sel);
      ed.appendChild(selRow);

      // ── 自然语言输入 ──
      if (mode === "nl") {
        const nlRow = document.createElement("div");
        nlRow.className = "anima-batch-cam-row";
        const nlInput = document.createElement("input");
        nlInput.type = "text";
        nlInput.className = "anima-batch-cam-nl";
        nlInput.placeholder = "如：俯视 近景 / 从背后 全身 / 荷兰角";
        nlInput.value = text;
        nlInput.addEventListener("change", () => {
          const v = nlInput.value.trim();
          if (v) this.cameraValues.set(key, v); else this.cameraValues.delete(key);
          apply();
        });
        nlRow.appendChild(nlInput);
        ed.appendChild(nlRow);
      }

      // ── 手动数值：4 滑块 ──
      if (mode === "pos") {
        const grid = document.createElement("div");
        grid.className = "anima-batch-cam-grid";
        const mkSlider = (label, get, set) => {
          const row = document.createElement("div");
          row.className = "anima-batch-cam-slider-row";
          const lb = document.createElement("span");
          lb.className = "anima-batch-cam-slider-label";
          lb.textContent = label;
          const range = document.createElement("input");
          range.type = "range";
          range.min = -1; range.max = 1; range.step = 0.05;
          range.value = get();
          const val = document.createElement("span");
          val.className = "anima-batch-cam-slider-val";
          val.textContent = fmtNum(get());
          range.addEventListener("input", () => {
            val.textContent = fmtNum(parseFloat(range.value));
            set(parseFloat(range.value));
            this._persistSelection();
          });
          range.addEventListener("change", () => apply());
          row.append(lb, range, val);
          grid.appendChild(row);
        };
        mkSlider("方位", () => px, (v) => { px = v; this.cameraValues.set(key, fmtPos(px, py, pz, rl)); });
        mkSlider("俯仰", () => py, (v) => { py = v; this.cameraValues.set(key, fmtPos(px, py, pz, rl)); });
        mkSlider("距离", () => pz, (v) => { pz = v; this.cameraValues.set(key, fmtPos(px, py, pz, rl)); });
        mkSlider("角度", () => rl, (v) => { rl = v; this.cameraValues.set(key, fmtPos(px, py, pz, rl)); });
        ed.appendChild(grid);
      }

      // ── 清除（跟随全局相机节点）──
      const clearRow = document.createElement("div");
      clearRow.className = "anima-batch-cam-row";
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "anima-batch-cam-clear";
      clearBtn.textContent = "✕ 清除本组机位（跟随全局相机）";
      clearBtn.addEventListener("click", () => {
        this.cameraValues.delete(key);
        this.openCamKey = null;
        apply();
      });
      clearRow.appendChild(clearBtn);
      ed.appendChild(clearRow);
      return ed;
    }

    _fillTargets() {
      const app = window.comfyAPI?.app?.app;
      if (!app) return;
      const targets = listTextTargets(app);
      const cams = listCameraTargets(app);
      const mkOpt = (sel, placeholder, items, isCamera) => {
        if (!sel) return;
        const cur = sel.value || "";
        // 关键修复：cur 非空但列表里匹配不到时，保留原值显示（图重建/节点未就绪时
        // 下拉不再被静默清空，避免用户无感知地丢目标）
        const matched = items.some((t) => cur === (t.nodeId + (isCamera ? "" : "." + t.widget)));
        sel.innerHTML = `<option value="">${placeholder}</option>` +
          items.map((t) => `<option value="${esc(t.nodeId + (isCamera ? "" : "." + t.widget))}" ${cur === (t.nodeId + (isCamera ? "" : "." + t.widget)) ? "selected" : ""}>${esc(t.title + (isCamera ? "" : " · " + t.widget))}</option>`).join("") +
          (!matched && cur ? `<option value="${esc(cur)}" selected>（已保存）${esc(cur)}</option>` : "");
      };
      mkOpt(this.posSel, "选择正向提示词目标节点…", targets, false);
      mkOpt(this.negSel, "负向提示词目标（可选）…", targets, false);
      mkOpt(this.camSel, "相机控制节点（可选）…", cams, true);
      this._renderTargetStatus();
    }

    // 注入目标状态行：绿色=就绪，红色=缺失/未选（批生成会被阻止）
    _renderTargetStatus() {
      if (!this.targetStatusEl) return;
      const app = window.comfyAPI?.app?.app;
      const posT = (this.w.positive_target?.value || "").trim();
      let cls, html;
      if (!posT) {
        cls = "warn";
        html = "⚠ 未选择正向目标 — 批生成将被阻止，请在上方选择提示词注入节点";
      } else {
        const [id, key] = posT.split(".");
        const n = app ? findNode(app, id) : null;
        const w = n?.widgets?.find((x) => x.name === key);
        if (n && w) {
          cls = "ok";
          html = `✓ 正向目标：${esc(n.title || n.type || id)} · ${esc(key)}`;
        } else {
          cls = "warn";
          html = `⚠ 正向目标「${esc(posT)}」未匹配到节点/widget（工作流已改动？请重新选择）`;
        }
      }
      this.targetStatusEl.className = "anima-batch-target-status " + cls;
      this.targetStatusEl.innerHTML = html;
    }

    // 批次被阻止时的可见报错（结果区 + 状态行 + 控制台）
    _showBatchError(msg) {
      console.error("[TK Prompt Batch] 批次已阻止:", msg);
      if (this.resultEl) {
        this.resultEl.innerHTML = `<div class="anima-batch-report anima-batch-report-error">⛔ ${esc(msg)}</div>`;
      }
      if (this.targetStatusEl) {
        this.targetStatusEl.className = "anima-batch-target-status warn";
        this.targetStatusEl.innerHTML = "⛔ " + esc(msg);
      }
    }

    build() {
      const container = document.createElement("div");
      container.className = "anima-batch-ui";
      this.rootEl = container;

      // 挂载：ComfyUI 官方 addDOMWidget（兼容 0.30.x）。insertBefore 兜底同样做。
      // parentNode 判空，防止节点创建早期 widget 未挂 DOM 时抛错导致拖不进去。
      // 挂载失败时【不隐藏标准 widget】→ 节点仍可用（手动填 prompt_files），避免渲染成空白框。
      let mounted = false;
      try {
        if (typeof this.node.addDOMWidget === "function") {
          this.node.addDOMWidget("anima_batch_panel", "custom", container, { serialize: false, hideOnZoom: false });
          mounted = true;
        } else {
          const firstEl = this.node.widgets?.map((w) => w.element).find(Boolean);
          if (firstEl && firstEl.parentNode) { firstEl.parentNode.insertBefore(container, firstEl); mounted = true; }
          else if (this.node.element) { this.node.element.prepend(container); mounted = true; }
        }
      } catch (e) {
        console.error("[TK Prompt Batch] 挂载 UI 失败:", e);
      }
      if (!mounted) {
        // 节点 DOM 可能尚未就绪，延迟再试一次；仍失败则给出可见提示
        setTimeout(() => {
          try {
            if (!container.isConnected && this.node.element) { this.node.element.prepend(container); mounted = container.isConnected; }
          } catch { /* 忽略 */ }
          if (!container.isConnected) {
            console.error("[TK Prompt Batch] UI 面板挂载失败：已保留标准 widget（可手动填写 prompt_files）");
            this._mountFailed = true;
          }
        }, 0);
      }

      // 挂载成功才隐藏标准 widget（参数全部由下方自定义 UI 控制；region_values/camera_values
      // 等内部 JSON 不再裸显示在节点上，随工作流持久化照常）
      if (mounted) {
        for (const w of this.node.widgets || []) {
          if (!w || w.name === "anima_batch_panel") continue;
          w.hidden = true;
          w.options = w.options || {};
          w.options.hidden = true;
          if (w.element) w.element.style.display = "none";
          if (typeof w.computeSize === "function") {
            const orig = w.computeSize;
            w.computeSize = function () { try { return [0, -4]; } catch (e) { return orig.apply(this, arguments); } };
          }
          if (typeof w.draw === "function") { w.draw = () => {}; }
        }
      }

      // 文件区：当前文件显示 + 「选择文件」按钮（可导航目录浏览器）
      const fileRow = document.createElement("div");
      fileRow.className = "anima-batch-row";
      const fileLbl = document.createElement("span");
      fileLbl.className = "anima-batch-label";
      fileLbl.textContent = "提示词文件";
      this.fileCur = document.createElement("span");
      this.fileCur.className = "anima-batch-file-cur";
      this.fileCur.textContent = this.w.prompt_files?.value || "（未选择）";
      this.fileCur.title = "当前提示词文件（相对 input/ 或绝对路径）";
      const browseBtn = document.createElement("button");
      browseBtn.type = "button";
      browseBtn.className = "anima-batch-btn";
      browseBtn.textContent = "选择文件…";
      const latestBtn = document.createElement("button");
      latestBtn.type = "button";
      latestBtn.className = "anima-batch-btn";
      latestBtn.textContent = "🔄 最新";
      latestBtn.title = "一键选中整个 input 目录树（含附加目录）里最新修改的提示词文件";
      fileRow.appendChild(fileLbl);
      fileRow.appendChild(this.fileCur);
      fileRow.appendChild(latestBtn);
      fileRow.appendChild(browseBtn);
      container.appendChild(fileRow);

      // 最近使用文件（点击即用）
      this.recentEl = document.createElement("div");
      this.recentEl.className = "anima-batch-recents";
      container.appendChild(this.recentEl);
      this._renderRecents();

      // 自动最新开关：队列时自动使用 prompts/ 下最新文件（无需手动选）
      const autoRow = document.createElement("div");
      autoRow.className = "anima-batch-row";
      const autoBox = document.createElement("input");
      autoBox.type = "checkbox";
      autoBox.id = "anima-auto-latest-" + this.node.id;
      autoBox.checked = !!this.autoLatest;
      autoBox.addEventListener("change", () => { this.autoLatest = autoBox.checked; });
      const autoLbl = document.createElement("label");
      autoLbl.htmlFor = autoBox.id;
      autoLbl.textContent = "自动用最新文件（点生成时自动选中 prompts/ 最新 txt）";
      autoLbl.className = "anima-batch-hint";
      autoRow.append(autoBox, autoLbl);
      container.appendChild(autoRow);

      // 保存到日期文件夹开关（控制 output_subfolder；按日期目录+时间戳+组名组织输出）
      const saveRow = document.createElement("div");
      saveRow.className = "anima-batch-row";
      const saveBox = document.createElement("input");
      saveBox.type = "checkbox";
      saveBox.id = "anima-save-date-" + this.node.id;
      saveBox.checked = this.w.output_subfolder?.value !== false;
      saveBox.title = "关闭后使用画布上 SaveImage 节点的原保存路径";
      saveBox.addEventListener("change", () => { this._setW(this.w.output_subfolder, saveBox.checked); });
      const saveLbl = document.createElement("label");
      saveLbl.htmlFor = saveBox.id;
      saveLbl.textContent = "保存到日期文件夹（2026-08-15/20260815_1030_组名_anima）";
      saveLbl.className = "anima-batch-hint";
      saveRow.append(saveBox, saveLbl);
      container.appendChild(saveRow);

      latestBtn.addEventListener("click", async () => {
        try {
          const path = await this.fetchLatestPath();
          if (!path) { alert("input/ 与附加目录下都没有提示词文件"); return; }
          fileList.style.display = "none";
          await this._selectFile(path, 0);
        } catch (e) { alert("获取最新文件失败：" + String((e && e.message) || e)); }
      });

      // 文件浏览器（可导航：上级/子目录/路径直输；相对 input/ 与绝对路径都支持）
      const fileList = document.createElement("div");
      fileList.className = "anima-batch-filelist";
      fileList.style.display = "none";
      container.appendChild(fileList);
      let browseDir = ""; // 当前浏览目录（相对 input/ 或绝对路径）

      // 全树搜索：输入文件名关键词 → 匹配 input 全树 + 附加目录（AI 写到哪都能搜到）
      const searchRow = document.createElement("div");
      searchRow.className = "anima-batch-nav-pathrow";
      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.className = "anima-batch-nav-input";
      searchInput.placeholder = "🔎 全树搜索文件名（input 子目录 + 附加目录）…";
      searchRow.appendChild(searchInput);
      fileList.appendChild(searchRow);
      let searchTimer = null;
      const runSearch = async () => {
        const q = searchInput.value.trim().toLowerCase();
        const old = fileList.querySelector(".anima-batch-search-results");
        if (old) old.remove();
        if (!q) return;
        try {
          const extra = this.extraDirs();
          const eq = extra.length ? "&extra=" + encodeURIComponent(JSON.stringify(extra)) : "";
          const j = await fetchJson("/anima/prompt/list?recursive=1" + eq);
          const matches = (j.files || []).filter((f) => f.path.toLowerCase().includes(q)).slice(0, 30);
          const box = document.createElement("div");
          box.className = "anima-batch-search-results";
          if (!matches.length) {
            box.innerHTML = '<div class="anima-batch-empty">没有匹配的文件</div>';
          } else {
            for (const f of matches) {
              const row2 = document.createElement("div");
              row2.className = "anima-batch-file anima-batch-file-row";
              const ns = document.createElement("span");
              ns.className = "anima-batch-file-name";
              ns.textContent = "📄 " + f.path;
              const mt = document.createElement("span");
              mt.className = "anima-batch-file-meta";
              const fresh = (Date.now() - f.mtime) < 24 * 3600 * 1000;
              mt.textContent = (fresh ? "新 " : "") + fmtMtime(f.mtime);
              if (fresh) mt.classList.add("fresh");
              row2.appendChild(ns);
              row2.appendChild(mt);
              row2.title = "选择：" + f.path + "（修改于 " + fmtMtime(f.mtime) + "）";
              row2.addEventListener("click", () => {
                this._selectFile(f.path, f.mtime);
                fileList.style.display = "none";
              });
              box.appendChild(row2);
            }
          }
          fileList.appendChild(box);
        } catch (e) { /* 搜索失败忽略 */ }
      };
      searchInput.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 250);
      };

      // 附加搜索目录（AI 落盘到 input 之外时配置；每行一个绝对路径）
      const extraRow = document.createElement("div");
      extraRow.className = "anima-batch-nav-pathrow";
      const extraToggle = document.createElement("button");
      extraToggle.type = "button";
      extraToggle.className = "anima-batch-btn";
      extraToggle.textContent = "＋ 附加目录";
      extraToggle.title = "配置额外提示词目录（绝对路径，每行一个）；「最新」/全树搜索/自动最新都会覆盖";
      const extraBox = document.createElement("textarea");
      extraBox.className = "anima-batch-nav-input";
      extraBox.rows = 2;
      extraBox.placeholder = "每行一个绝对路径，如 D:\\prompts\n留空关闭";
      extraBox.style.display = "none";
      extraBox.value = (this.w.extra_dirs?.value || "");
      extraBox.oninput = () => {
        if (this.w.extra_dirs) this._setW(this.w.extra_dirs, extraBox.value);
      };
      extraToggle.addEventListener("click", () => {
        const show = extraBox.style.display === "none";
        extraBox.style.display = show ? "" : "none";
        extraToggle.textContent = show ? "－ 附加目录" : "＋ 附加目录";
        if (show) {
          extraBox.value = (this.w.extra_dirs?.value || "");
          extraBox.focus();
        }
      });
      extraRow.appendChild(extraToggle);
      extraRow.appendChild(extraBox);
      fileList.appendChild(extraRow);

      const renderBrowser = async () => {
        fileList.innerHTML = "";
        let j;
        try {
          j = await fetchJson("/anima/prompt/list?dir=" + encodeURIComponent(browseDir));
        } catch (e) {
          fileList.innerHTML = '<div class="anima-batch-empty">目录加载失败：' + esc(String((e && e.message) || e)) + '</div>';
          return;
        }
        // 导航行：上级 + 当前路径
        const nav = document.createElement("div");
        nav.className = "anima-batch-nav";
        const upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.className = "anima-batch-btn anima-batch-nav-up";
        upBtn.textContent = "⬆ 上级";
        upBtn.disabled = !j.parent && (j.dir === "." || j.dir === "");
        upBtn.title = "返回上级目录";
        upBtn.addEventListener("click", () => { browseDir = j.parent || ""; renderBrowser(); });
        const pathSpan = document.createElement("span");
        pathSpan.className = "anima-batch-nav-path";
        pathSpan.textContent = j.abs_dir || ".";
        pathSpan.title = "当前目录绝对路径";
        nav.append(upBtn, pathSpan);
        fileList.appendChild(nav);
        // 路径直输行
        const pathRow = document.createElement("div");
        pathRow.className = "anima-batch-nav-pathrow";
        const pathInput = document.createElement("input");
        pathInput.type = "text";
        pathInput.className = "anima-batch-nav-input";
        pathInput.placeholder = "输入目录路径（相对 input/ 或绝对路径）后回车跳转";
        pathInput.value = (j.dir && j.dir !== ".") ? j.dir : "";
        pathInput.onkeydown = (e) => { if (e.key === "Enter") { browseDir = pathInput.value.trim(); renderBrowser(); } };
        pathRow.appendChild(pathInput);
        fileList.appendChild(pathRow);
        // 子目录
        for (const d of j.dirs || []) {
          const row = document.createElement("div");
          row.className = "anima-batch-file";
          row.textContent = "📁 " + d;
          row.title = "进入目录 " + d;
          row.addEventListener("click", () => { browseDir = browseDir ? browseDir + "/" + d : d; renderBrowser(); });
          fileList.appendChild(row);
        }
        // 提示词文件（点击选择；显示修改时间 + 「新」徽章）
        for (const f of j.files || []) {
          const row = document.createElement("div");
          row.className = "anima-batch-file anima-batch-file-row";
          const nameSpan = document.createElement("span");
          nameSpan.className = "anima-batch-file-name";
          nameSpan.textContent = "📄 " + (f.name || f);
          const meta = document.createElement("span");
          meta.className = "anima-batch-file-meta";
          const fresh = f.mtime && (Date.now() - f.mtime) < 24 * 3600 * 1000;
          meta.textContent = (fresh ? "新 " : "") + fmtMtime(f.mtime);
          if (fresh) meta.classList.add("fresh");
          row.appendChild(nameSpan);
          row.appendChild(meta);
          const path = browseDir ? browseDir + "/" + (f.name || f) : (f.name || f);
          row.title = "选择：" + path + "（修改于 " + fmtMtime(f.mtime) + "）";
          row.addEventListener("click", () => {
            this._selectFile(path, f.mtime);
            fileList.style.display = "none";
          });
          fileList.appendChild(row);
        }
        if (!(j.dirs || []).length && !(j.files || []).length) {
          const empty = document.createElement("div");
          empty.className = "anima-batch-empty";
          empty.textContent = "该目录没有 .txt 提示词文件";
          fileList.appendChild(empty);
        }
      };
      browseBtn.addEventListener("click", async () => {
        if (fileList.style.display !== "none") { fileList.style.display = "none"; return; }
        fileList.style.display = "block";
        fileList.innerHTML = '<div class="anima-batch-empty">加载中…</div>';
        await renderBrowser();
      });

      // 目标选择区
      const selWrap = document.createElement("div");
      selWrap.className = "anima-batch-sels";
      this.posSel = this._mkSelect("正向目标");
      this.negSel = this._mkSelect("负向目标");
      this.camSel = this._mkSelect("相机节点");
      selWrap.appendChild(this.posSel);
      selWrap.appendChild(this.negSel);
      selWrap.appendChild(this.camSel);
      container.appendChild(selWrap);

      // 目标状态行（未选择/失效时红字提示，批生成会被阻止）
      this.targetStatusEl = document.createElement("div");
      this.targetStatusEl.className = "anima-batch-target-status";
      container.appendChild(this.targetStatusEl);

      // 恢复上次保存的目标选择（工作流重载/图重建后 widget 值可能为空）
      try {
        const app = window.comfyAPI?.app?.app;
        const saved = loadSavedTargets(currentWorkflowId(app), this.node.id);
        if (saved.positive_target && !(this.w.positive_target?.value || "").trim()) this._setW(this.w.positive_target, saved.positive_target);
        if (saved.negative_target && !(this.w.negative_target?.value || "").trim()) this._setW(this.w.negative_target, saved.negative_target);
        if (saved.camera_target && !(this.w.camera_target?.value || "").trim()) this._setW(this.w.camera_target, saved.camera_target);
      } catch { /* 恢复失败不影响使用 */ }

      // 按钮区
      const btnRow = document.createElement("div");
      btnRow.className = "anima-batch-btns";
      const parseBtn = document.createElement("button");
      parseBtn.type = "button";
      parseBtn.className = "anima-batch-btn anima-batch-parse-btn";
      parseBtn.textContent = "解析分组";
      parseBtn.addEventListener("click", async () => {
        // 先同步 targets 下拉（保证注入目标最新）
        this._fillTargets();
        await this._parseFiles();
      });
      const refreshBtn = document.createElement("button");
      refreshBtn.type = "button";
      refreshBtn.textContent = "刷新目标节点";
      refreshBtn.addEventListener("click", () => this._fillTargets());
      btnRow.appendChild(parseBtn);
      btnRow.appendChild(refreshBtn);
      container.appendChild(btnRow);

      // 计数
      this.countEl = document.createElement("div");
      this.countEl.className = "anima-batch-count";
      container.appendChild(this.countEl);

      // 分组列表
      this.listEl = document.createElement("div");
      this.listEl.className = "anima-batch-list";
      container.appendChild(this.listEl);

      // 批次结果反馈区
      this.resultEl = document.createElement("div");
      this.resultEl.className = "anima-batch-report-wrap";
      container.appendChild(this.resultEl);

      // 初始恢复勾选 + 渲染（配置恢复后）
      try {
        const sel = JSON.parse(this.w.groups_selection?.value || "[]");
        if (Array.isArray(sel) && sel.length) { /* 等 parse 时按名称匹配恢复 */ }
        this._restoredNames = new Set(sel);
      } catch { this._restoredNames = new Set(); }
      // 恢复区域参数（file::name → 字符串）
      try {
        const rv = JSON.parse(this.w.region_values?.value || "{}");
        if (rv && typeof rv === "object") {
          for (const k of Object.keys(rv)) {
            if (typeof rv[k] === "string") this.regionValues.set(k, rv[k]);
          }
        }
      } catch {}
      // 恢复组相机参数（file::name → 机位描述）
      try {
        const cv = JSON.parse(this.w.camera_values?.value || "{}");
        if (cv && typeof cv === "object") {
          for (const k of Object.keys(cv)) {
            if (typeof cv[k] === "string" && cv[k].trim()) this.cameraValues.set(k, cv[k].trim());
          }
        }
      } catch {}

      // 目标选择变更 → 写回 widget + 持久化 + 刷新状态行
      const persistTargets = () => {
        const app = window.comfyAPI?.app?.app;
        saveTargets(currentWorkflowId(app), this.node.id, {
          positive_target: this.w.positive_target?.value || "",
          negative_target: this.w.negative_target?.value || "",
          camera_target: this.w.camera_target?.value || "",
        });
        this._renderTargetStatus();
      };
      this.posSel.addEventListener("change", () => { this._setW(this.w.positive_target, this.posSel.value); persistTargets(); });
      this.negSel.addEventListener("change", () => { this._setW(this.w.negative_target, this.negSel.value); persistTargets(); });
      this.camSel.addEventListener("change", () => { this._setW(this.w.camera_target, this.camSel.value); persistTargets(); });

      // 初始化下拉（配置恢复后）。工作流加载时图可能仍在异步重建，目标节点枚举
      // 可能为空 → 下拉未匹配到保存的目标值时按间隔重试几次（幂等重建 options）。
      const tryFill = (delay, remaining) => {
        setTimeout(() => {
          this.posSel.value = this.w.positive_target?.value || "";
          this.negSel.value = this.w.negative_target?.value || "";
          this.camSel.value = this.w.camera_target?.value || "";
          this._fillTargets();
          this._renderTargetStatus();
          const cur = this.w.positive_target?.value || "";
          const matched = !cur || this.posSel.value === cur;
          if (matched) {
            this._parseFiles().then(() => {
              if (this._restoredNames && this._restoredNames.size) {
                this.checked.clear();
                for (const g of this.cachedGroups) {
                  if (this._restoredNames.has(g.name)) this.checked.add(g.file + "::" + g.name);
                }
                this._renderGroups();
              }
            });
          } else if (remaining > 0) {
            tryFill(800, remaining - 1);
          } else {
            // 最终兜底：即使目标节点枚举不到也照常解析组列表
            this._parseFiles();
          }
        }, delay);
      };
      tryFill(50, 6);
    }

    _mkSelect(label) {
      const wrap = document.createElement("div");
      wrap.className = "anima-batch-sel";
      const lb = document.createElement("div");
      lb.className = "anima-batch-label";
      lb.textContent = label;
      const sel = document.createElement("select");
      sel.className = "anima-batch-select";
      wrap.appendChild(lb);
      wrap.appendChild(sel);
      return sel;
    }

    // 构建队列任务列表（组×提示词顺序）
    buildJobs(app) {
      const posT = (this.w.positive_target?.value || "").trim();
      const negT = (this.w.negative_target?.value || "").trim();
      if (!posT) return [];
      const [posId, posKey] = posT.split(".");
      if (!posId || !posKey) return [];
      const neg = negT ? negT.split(".") : null;
      const camId = (this.w.camera_target?.value || "").trim();

      const jobs = [];
      for (const g of this.cachedGroups) {
        if (!this.checked.has(g.file + "::" + g.name)) continue;
        const gkey = g.file + "::" + g.name;
        for (const p of g.prompts || []) {
          jobs.push({
            posId, posKey,
            negId: neg ? neg[0] : null, negKey: neg ? neg[1] : null,
            text: p, groupName: g.name,
            camId: camId || null,
            camera: (this.cameraValues.get(gkey) || "").trim() || null,
            region: (this.regionValues.get(gkey) || "").trim() || null,
            person: g.person || null,
            bg: g.background || null,
            neg: g.neg || null,
            subfolder: this.w.output_subfolder?.value !== false,
          });
        }
      }
      return jobs;
    }

    // 批次跑完后汇总各组结果：等待队列清空 → 拉 /history → 按组名匹配 → 渲染
    async collectBatchReport(jobs) {
      if (!this.resultEl) return;
      this._setReportLoading();
      try {
        // 等待 ComfyUI 队列清空（最多 5 分钟，每 1.5s 查一次）
        const deadline = Date.now() + 5 * 60 * 1000;
        for (;;) {
          const q = await fetchJson("/queue");
          const running = (q.queue_running || []).length;
          const pending = (q.queue_pending || []).length;
          if (running === 0 && pending === 0) break;
          if (Date.now() > deadline) {
            this._renderReport({ ok: false, error: "等待超时：队列 5 分钟内未清空", groups: [] });
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        const hist = await fetchJson("/history?max_items=200");
        const report = formatBatchReport(hist, jobs);
        this._renderReport(report);
      } catch (e) {
        this._renderReport({ ok: false, error: String((e && e.message) || e), groups: [] });
      }
    }

    _setReportLoading() {
      if (!this.resultEl) return;
      this.resultEl.innerHTML = '<div class="anima-batch-report anima-batch-report-loading">⏳ 等待批次完成并汇总结果…</div>';
    }

    _renderReport(report) {
      if (!this.resultEl) return;
      if (!report || !report.ok) {
        this.resultEl.innerHTML = `<div class="anima-batch-report anima-batch-report-error">⚠️ ${esc(report?.error || "汇总失败")}</div>`;
        return;
      }
      const groups = report.groups || [];
      const okCount = groups.filter((g) => g.success).length;
      const failCount = groups.length - okCount;
      const rows = groups.map((g) => {
        const cls = g.success ? "anima-batch-report-ok" : "anima-batch-report-fail";
        const reason = g.success ? "成功" : (g.error || "失败");
        return `<div class="anima-batch-report-row ${cls}"><b>${esc(g.groupName)}</b>（${g.count} 条）— ${esc(reason)}</div>`;
      }).join("");
      this.resultEl.innerHTML = `<div class="anima-batch-report anima-batch-report-summary">✅ 成功 ${okCount} 组 · ❌ 失败 ${failCount} 组<button class="anima-batch-report-toggle" title="收起/展开">${this._reportOpen ? "收起" : "展开"}</button></div><div class="anima-batch-report-detail" style="${this._reportOpen ? "" : "display:none"}">${rows || '<div class="anima-batch-report-empty">未匹配到本次批次输出</div>'}</div>`;
      const toggle = this.resultEl.querySelector(".anima-batch-report-toggle");
      if (toggle) {
        toggle.addEventListener("click", () => {
          this._reportOpen = !this._reportOpen;
          const detail = this.resultEl.querySelector(".anima-batch-report-detail");
          if (detail) detail.style.display = this._reportOpen ? "" : "none";
          toggle.textContent = this._reportOpen ? "收起" : "展开";
        });
      }
    }
  }

  // 区域参数数组 → "x,y,w,h,s" 字符串（保留 3 位小数）
  function fmtRegion(r) {
    if (!Array.isArray(r) || r.length < 4) return "";
    const v = r.slice(0, 5).map((n) => String(Math.round(parseFloat(n) * 1000) / 1000));
    if (v.length === 4) v.push("1");
    return v.join(",");
  }

  // 读相机节点当前参数（含预设/自然语言，交给后端预览接口按优先级计算）
  function readCameraPrompt(app, camId) {
    const node = findNode(app, camId);
    if (!node) return null;
    const w = (n) => node.widgets?.find((x) => x.name === n);
    return {
      px: parseFloat(w("pos_x")?.value ?? 0), py: parseFloat(w("pos_y")?.value ?? 0),
      pz: parseFloat(w("pos_z")?.value ?? 0), rl: parseFloat(w("roll")?.value ?? 0),
      cfg: w("config")?.value || "",
      extra: (w("extra_tags")?.value || "").trim(),
      nl: (w("nl_prompt")?.value || "").trim(),
      preset: (w("preset")?.value || "").trim(),
    };
  }

  // ── 方案 A：区域参数注入（ConditioningSetAreaPercentage） ──
  // 在 graphToPrompt 产出的最终 prompt JSON 上做手术，不改动画布图（不污染工作流）。
  //
  // 注入结构（ComfyUI 区域标准用法：区域 cond + 全图 base cond 混合）：
  //   正片cond ──► ConditioningSetAreaPercentage(区域) ──┐
  //                                                     ├─► ConditioningCombine ──► 原下游
  //   空文本CLIPTextEncode ─► ConditioningSetAreaPercentage(全图 base) ──┘
  let regionSeq = 0;
  function injectRegionIntoPrompt(prompt, condId, slot, regionStr, clipInput) {
    const nums = String(regionStr || "").split(/[,，\s]+/).filter((s) => s.length > 0).map((s) => parseFloat(s));
    if (nums.length < 4 || nums.slice(0, 4).some((n) => !Number.isFinite(n))) return false;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const x = clamp01(nums[0]), y = clamp01(nums[1]);
    const w = clamp01(nums[2]), h = clamp01(nums[3]);
    if (w <= 0 || h <= 0) return false;
    // 区域=全图时无需分区（等于不注入，避免无意义分支）
    if (w >= 0.999 && h >= 0.999 && x <= 0.001 && y <= 0.001) return false;
    const s = nums.length > 4 && Number.isFinite(nums[4]) ? nums[4] : 1.0;
    const key = String(condId);
    const n = ++regionSeq;
    const regionId = "tk_region_" + n;
    const baseEncId = "tk_base_enc_" + n;
    const baseAreaId = "tk_base_area_" + n;
    const combineId = "tk_combine_" + n;

    // 找消费 [condId, slot] 的输入（正片 conditioning 的下游），改接 combine
    let consumers = 0;
    for (const nid of Object.keys(prompt || {})) {
      const inputs = (prompt[nid] || {}).inputs || {};
      for (const k of Object.keys(inputs)) {
        const v = inputs[k];
        if (Array.isArray(v) && v.length >= 2 && String(v[0]) === key && v[1] === slot) {
          inputs[k] = [combineId, 0];
          consumers++;
        }
      }
    }
    if (!consumers) return false;
    // base 文本编码需要 CLIP：复制原 cond 节点的 clip 输入；没有则跳过（无法补底衬）
    if (!Array.isArray(clipInput)) return false;

    prompt[regionId] = {
      class_type: "ConditioningSetAreaPercentage",
      inputs: { conditioning: [key, slot], width: w, height: h, x: x, y: y, strength: s },
    };
    // 区域外底衬：用「简单背景」引导，避免空文本导致模型在区域外自由发挥（画多余人物）
    prompt[baseEncId] = {
      class_type: "CLIPTextEncode",
      inputs: { clip: clipInput, text: "simple background, empty space, plain, minimal," },
    };
    prompt[baseAreaId] = {
      class_type: "ConditioningSetAreaPercentage",
      inputs: { conditioning: [baseEncId, 0], width: 1, height: 1, x: 0, y: 0, strength: 1 },
    };
    prompt[combineId] = {
      class_type: "ConditioningCombine",
      inputs: { conditioning_1: [regionId, 0], conditioning_2: [baseAreaId, 0] },
    };
    return true;
  }

  // ── Anima 底模区域注入（ComfyUI-Anima-Regional-Conditioning） ──
  // Anima/Cosmos 的 latent 是 5D（含时间维），ComfyUI 原生 ConditioningSetArea 不兼容；
  // 改用 Anima 生态节点：矩形 mask → AnimaConditioningRegion(区域cond) →
  // ApplyAnimaRegionalConditioningPatch(model) → KSampler。
  // 节点全部在 graphToPrompt 产物上临时注入，不动画布图。
  function injectAnimaRegionIntoPrompt(prompt, act) {
    const nums = String(act.region || "").split(/[,，\s]+/).filter((s) => s.length > 0).map((s) => parseFloat(s));
    if (nums.length < 4 || nums.slice(0, 4).some((n) => !Number.isFinite(n))) return false;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const x = clamp01(nums[0]), y = clamp01(nums[1]);
    const w = clamp01(nums[2]), h = clamp01(nums[3]);
    if (w <= 0 || h <= 0) return false;
    if (w >= 0.999 && h >= 0.999 && x <= 0.001 && y <= 0.001) return false;
    const s = nums.length > 4 && Number.isFinite(nums[4]) ? nums[4] : 1.0;

    const condId = String(act.cond.id);
    const clipInput = prompt[condId]?.inputs?.clip;
    if (!Array.isArray(clipInput)) return false;

    // 找 KSampler（model 输入是连线）
    let samplerId = null, samplerModel = null;
    for (const nid of Object.keys(prompt)) {
      const node = prompt[nid];
      if (!node || typeof node.class_type !== "string") continue;
      if (!/^KSampler/.test(node.class_type)) continue;
      if (Array.isArray(node.inputs?.model)) { samplerId = nid; samplerModel = node.inputs.model; break; }
    }
    if (!samplerId || !samplerModel) return false;

    const W = Math.max(1, Math.round(act.dims?.w || 1024));
    const H = Math.max(1, Math.round(act.dims?.h || 1024));
    const rx = Math.round(x * W), ry = Math.round(y * H);
    const rw = Math.max(1, Math.round(w * W)), rh = Math.max(1, Math.round(h * H));

    const n = ++regionSeq;
    const encId = "tk_anima_enc_" + n;
    const bgEncId = "tk_anima_bgenc_" + n;
    const blackId = "tk_anima_black_" + n;
    const whiteId = "tk_anima_white_" + n;
    const fullWhiteId = "tk_anima_fullwhite_" + n;
    const maskId = "tk_anima_mask_" + n;
    const bgMaskId = "tk_anima_bgmask_" + n;
    const regionId = "tk_anima_region_" + n;
    const bgRegionId = "tk_anima_bgregion_" + n;
    const applyId = "tk_anima_apply_" + n;

    const regionText = (act.person || act.text || "").trim();
    if (!regionText) return false;
    const bgText = (act.bg || "").trim();
    // 人物区 cond = 人物词（9a1aac71 定稿配置：不加背景词、不加否定词）
    const regionCondText = regionText;

    // 人物区域（用户指定区域）
    prompt[encId] = { class_type: "CLIPTextEncode", inputs: { clip: clipInput, text: regionCondText } };
    prompt[blackId] = { class_type: "SolidMask", inputs: { value: 0, width: W, height: H } };
    prompt[whiteId] = { class_type: "SolidMask", inputs: { value: 1, width: rw, height: rh } };
    prompt[maskId] = {
      class_type: "MaskComposite",
      inputs: { destination: [blackId, 0], source: [whiteId, 0], x: rx, y: ry, operation: "add" },
    };
    prompt[regionId] = {
      class_type: "AnimaConditioningRegion",
      inputs: { mask: [maskId, 0], conditioning: [encId, 0], weight: s },
    };

    // 背景区域（人物区域之外 = 全白 - 人物白块），背景词填充；
    // 无「背景:」行时背景 cond 复用正片链路（KSampler positive）。
    let tailRegionId = regionId;
    if (bgText) {
      prompt[bgEncId] = { class_type: "CLIPTextEncode", inputs: { clip: clipInput, text: bgText } };
      prompt[fullWhiteId] = { class_type: "SolidMask", inputs: { value: 1, width: W, height: H } };
      prompt[bgMaskId] = {
        class_type: "MaskComposite",
        inputs: { destination: [fullWhiteId, 0], source: [whiteId, 0], x: rx, y: ry, operation: "subtract" },
      };
      prompt[bgRegionId] = {
        class_type: "AnimaConditioningRegion",
        inputs: { mask: [bgMaskId, 0], conditioning: [bgEncId, 0], weight: 1, regions: [regionId, 0] },
      };
      tailRegionId = bgRegionId;
    }

    prompt[applyId] = {
      class_type: "ApplyAnimaRegionalConditioningPatch",
      inputs: {
        model: samplerModel,
        regions: [tailRegionId, 0],
        base_mode: "uncovered_only",
        base_strength: 1.0,
        end_percent: 0.35,
        cross_mask_strength: 1.0,
        self_mask_strength: 0.2,
        base_ratio: 0.1,
        cross_inject_every_n_blocks: 1,
        self_inject_every_n_blocks: 1,
      },
    };
    prompt[samplerId].inputs.model = [applyId, 0];
    return true;
  }

  // 找图尺寸（EmptyLatentImage 类节点的 width/height widget）
  function findLatentDims(app) {
    for (const n of getNodes(app)) {
      const cls = n.type || n.comfyClass || "";
      if (!/EmptyLatent|EmptySD3|EmptyAuraFlow|EmptyFlux/i.test(cls)) continue;
      const ww = n.widgets?.find((x) => x.name === "width");
      const hw = n.widgets?.find((x) => x.name === "height");
      if (ww && hw && Number(ww.value) > 0 && Number(hw.value) > 0) {
        return { w: Number(ww.value), h: Number(hw.value) };
      }
    }
    return null;
  }

  // 从文本目标节点出发，顺着 STRING 输出链路找「输出 CONDITIONING 且被消费」的节点。
  // 例：WeiLinPromptUI(STRING) → Text Concatenate → CLIPTextEncode(CONDITIONING) → KSampler
  // 区域注入必须挂在 CONDITIONING 上，否则类型不匹配（String 接 CONDITIONING 会报错）。
  function findCondNode(app, posId) {
    const graph = getGraph(app);
    const links = graph && graph.links instanceof Map ? graph.links
      : new Map((graph?.links || []).map((l) => [l[0] ?? l.id, l]));
    const linkTarget = (l) => (Array.isArray(l) ? l[2] : l?.target_id); // 兼容 0.30 对象 link
    const seen = new Set();
    const queue = [findNode(app, posId)];
    while (queue.length) {
      const n = queue.shift();
      if (!n || seen.has(String(n.id))) continue;
      seen.add(String(n.id));
      const outs = n.outputs || [];
      const condIdx = outs.findIndex((o) => o.type === "CONDITIONING");
      if (condIdx >= 0 && (outs[condIdx].links || []).length > 0) {
        return { id: String(n.id), slot: condIdx };
      }
      const strIdx = outs.findIndex((o) => o.type === "STRING");
      if (strIdx < 0) continue;
      for (const linkId of outs[strIdx].links || []) {
        const l = links.get(linkId);
        const tid = linkTarget(l);
        if (tid != null) queue.push(findNode(app, tid));
      }
    }
    return null;
  }

  // Anima 底模检测：Cosmos 架构 latent 是 5D（含时间维），ComfyUI 原生
  // ConditioningSetArea 区域机制只支持 2D → 直接注入会 IndexError。
  // 检测到 Anima 底模时跳过原生区域注入（区域控制需 Anima 生态节点）。
  function isAnimaModel(app) {
    for (const n of getNodes(app)) {
      const cls = n.type || n.comfyClass || "";
      if (!/UNETLoader|CheckpointLoader/i.test(cls)) continue;
      const w = n.widgets?.find((x) => /unet_name|ckpt_name/i.test(x.name || ""));
      if (w && /anima/i.test(String(w.value || ""))) return true;
    }
    return false;
  }

    // 区域注入已停用（2026-08-15 用户决定：Anima 底模区域控制效果不佳，专注相机控制）。
    // 注入函数 injectRegionIntoPrompt / injectAnimaRegionIntoPrompt / findCondNode
    // 等仍保留在文件内（SD 等其他底模未来可恢复），此处不再调用。

    // 全局：包装 app.queuePrompt
    function installQueueExpansion() {
      const app = window.comfyAPI?.app?.app;
      if (!app || app.__animaBatchInstalled) return;
      app.__animaBatchInstalled = true;
      const orig = app.queuePrompt.bind(app);

    app.queuePrompt = async function (number, batchCount, options) {
      // 找到批处理节点
      // 只认「启用中」的批量节点（mode 0 = always；mute/禁用/隐藏后 mode 非 0 → 走正常队列）
      const batchNode = getNodes(app).find((n) => n._animaBatchUI && n.mode === 0);
      if (!batchNode) return orig(number, batchCount, options);
      const ui = batchNode._animaBatchUI;

      // auto_queue（前端 instant/change 模式的自动重排）永不展开批量：
      // 队列清空后自动重排会把同一批反复提交（历史里出现过连续重复任务），
      // TK 批量本身就是自动化，无需自动重排。禁用/隐藏 TK 节点后走正常逻辑。
      const trigger = (options && options.intent && options.intent.trigger_source) || "";
      if (trigger === "auto_queue") return false;

      // ── 注入目标校验（2026-08-17 修复）：目标缺失/失效时【阻止批次】并给出可见报错，
      //    绝不再静默提交「无注入的重复提示词」（曾导致 N 份相同提示词入队 + 任务异常中断）
      const posT = (ui.w.positive_target?.value || "").trim();
      const negT = (ui.w.negative_target?.value || "").trim();
      const problems = [];
      const checkTarget = (label, t, required) => {
        if (!t) {
          if (required) problems.push(`未选择「${label}」`);
          return;
        }
        const [id, key] = t.split(".");
        const n = findNode(app, id);
        if (!n) {
          problems.push(`「${label}」目标节点 ${id} 不存在（工作流已改动？请重新选择）`);
        } else if (!n.widgets?.find((x) => x.name === key)) {
          const avail = (n.widgets || []).map((x) => x.name).join(", ") || "无";
          problems.push(`「${label}」目标 ${id}.${key} 不存在（该节点可用 widget：${avail}）`);
        }
      };
      checkTarget("正向提示词注入节点", posT, true);
      checkTarget("负向提示词注入节点", negT, false);
      if (problems.length) {
        ui._showBatchError("批生成被阻止：" + problems.join("；"));
        return false;
      }

      // 自动最新模式：队列前刷新为最新提示词文件（失败不阻塞，走原逻辑）
      if (ui.autoLatest) {
        try {
          const path = await ui.fetchLatestPath();
          if (path && (ui.w.prompt_files?.value || "") !== path) {
            ui.checked.clear();
            ui._setW(ui.w.prompt_files, path);
            if (ui.fileCur) ui.fileCur.textContent = path;
            rememberFile(path, 0);
            if (typeof ui._renderRecents === "function") ui._renderRecents();
            await ui._parseFiles();
          }
        } catch (e) { /* 自动刷新失败不阻塞队列 */ }
      }

      // 异步解析相机词（若指定相机节点）
      let cameraMap = null;
      const camId = (ui.w.camera_target?.value || "").trim();
      if (camId) {
        const cam = readCameraPrompt(app, camId);
        if (cam) {
          cameraMap = await (async () => {
            try {
              const q = `x=${cam.px}&y=${cam.py}&z=${cam.pz}&roll=${cam.rl}&config=${encodeURIComponent(cam.cfg)}&extra=${encodeURIComponent(cam.extra)}&preset=${encodeURIComponent(cam.preset)}&nl=${encodeURIComponent(cam.nl)}`;
              const r = await fetchJson(`/anima/camera/preview?${q}`);
              return r.prompt || "";
            } catch { return ""; }
          })();
        }
      }

      const jobs = ui.buildJobs(app);
      if (!jobs.length) return orig(number, batchCount, options);

      // 批量前快照所有 SaveImage 的 filename_prefix，跑完恢复——
      // 否则批量把画布上的前缀改成 batch/组名 后不还原，用户下次手动跑单图会存进 batch/ 子目录
      const prefixSnapshot = new Map();
      if (jobs.some((j) => j.subfolder)) {
        for (const n of getNodes(app)) {
          const cls = n.type || n.comfyClass || "";
          if (!/SaveImage|PreviewImage|imageSave/i.test(cls)) continue;
          const w = n.widgets?.find((x) => x.name === "filename_prefix");
          if (w) prefixSnapshot.set(n, w.value);
        }
      }
      const restorePrefix = () => {
        for (const [n, v] of prefixSnapshot) {
          const w = n.widgets?.find((x) => x.name === "filename_prefix");
          if (w) setTextWidget(n, "filename_prefix", v);
        }
      };

      // 批量前快照负向目标节点原值（仅对本次会用到的目标节点），每组注入后立即恢复，
      // 避免上一组负向泄漏到下一组、也避免批量后节点残留。
      const negSnapshot = new Map();
      for (const job of jobs) {
        if (!job.negId || !job.negKey || !job.neg) continue;
        const nk = job.negId + "." + job.negKey;
        if (negSnapshot.has(nk)) continue;
        const n = findNode(app, job.negId);
        if (n) negSnapshot.set(nk, { node: n, key: job.negKey, value: getWidgetValue(n, job.negKey) });
      }
      const restoreNeg = (job) => {
        if (!job.negId || !job.negKey || !job.neg) return;
        const snap = negSnapshot.get(job.negId + "." + job.negKey);
        if (snap) setTextWidget(snap.node, snap.key, snap.value);
      };

      try {
        ui.batchActive = true;
        // 逐条注入并顺序入队（复用原生 seed/进度/历史）
        for (const job of jobs) {
          const posNode = findNode(app, job.posId);
          if (!posNode) {
            ui._showBatchError(`批生成中止：正向目标节点 ${job.posId} 不存在（工作流已改动？请重新选择）`);
            return false;
          }
          // 注入整段提示词（后端已把「背景/人物」行合并进组提示词）；
          // 注入失败（widget 不存在/名字不符）立即中止，绝不静默提交未注入的提示词
          if (!setTextWidget(posNode, job.posKey, job.text)) {
            const avail = (posNode.widgets || []).map((x) => x.name).join(", ") || "无";
            ui._showBatchError(`批生成中止：目标节点 ${job.posId} 没有 widget「${job.posKey}」（可用：${avail}）。请重新选择注入节点`);
            return false;
          }

          // 负向提示词：仅当本组文件写了「负向:」且用户选择了负向目标节点时才注入；
          // 无负向行时完全不碰负向节点，保持现有值不变。
          if (job.negId && job.negKey && job.neg) {
            const negNode = findNode(app, job.negId);
            if (negNode && !setTextWidget(negNode, job.negKey, job.neg)) {
              const avail = (negNode.widgets || []).map((x) => x.name).join(", ") || "无";
              ui._showBatchError(`批生成中止：负向目标节点 ${job.negId} 没有 widget「${job.negKey}」（可用：${avail}）。请重新选择负向注入节点`);
              return false;
            }
          }

          // 相机词注入：把相机词拼到正向文本末尾（幂等：每次完整替换正向文本）
          // 优先级：本组独立机位（job.camera） > 全局相机节点（cameraMap）
          if (job.camera) {
            try {
              const q = cameraToQuery(job.camera);
              const r = await fetchJson("/anima/camera/preview?" + q);
              if (r && r.prompt) {
                const cur = getWidgetValue(posNode, job.posKey);
                setTextWidget(posNode, job.posKey, mergeCamera(cur, r.prompt));
              }
            } catch { /* 组相机解析失败时静默跳过，用已有文本 */ }
          } else if (cameraMap) {
            const cur = getWidgetValue(posNode, job.posKey);
            setTextWidget(posNode, job.posKey, mergeCamera(cur, cameraMap));
          }

          // 每组输出子目录：覆盖 SaveImage filename_prefix
          if (job.subfolder) {
            applySubfolderPrefix(app, job.groupName);
          }

          // （区域注入已停用，见 installQueueExpansion 注释）
          await orig(1, batchCount);

          // 跑完立即恢复负向节点原值，防止泄漏到下一组
          restoreNeg(job);
        }

        // 批次结果反馈：等队列清空后拉 /history，汇总到节点 UI
        try {
          if (ui.collectBatchReport) await ui.collectBatchReport(jobs);
        } catch (e) {
          console.error("[TK Prompt Batch] 批次结果汇总失败:", e);
        }
      } finally {
        // 无论成功/失败/用户取消，都还原 filename_prefix 与负向节点
        ui.batchActive = false;
        restorePrefix();
        for (const snap of negSnapshot.values()) {
          setTextWidget(snap.node, snap.key, snap.value);
        }
      }
      return true;
    };
  }

  function getWidgetValue(node, key) {
    const w = node?.widgets?.find((x) => x.name === key);
    return w?.value ?? "";
  }
  function setTextWidget(node, key, text) {
    const w = node?.widgets?.find((x) => x.name === key);
    if (!w) return false;
    w.value = text;
    if (typeof w.callback === "function") { try { w.callback(text) } catch {} }
    return true;
  }
  function mergeCamera(cur, camera) {
    // 简单拼接：目标文本每次被完整替换，无需剥离（幂等由"每次替换"保证）。
    // camera 词由后端计算、末尾带逗号，直接追加到正向提示词末尾。
    const base = String(cur || "").trim();
    if (!camera) return base;
    if (!base) return camera;
    return base.replace(/,\s*$/, "") + ", " + camera;
  }
    function formatBatchReport(history, jobs) {
    // 把 /history 返回（对象或数组）归一化为数组
    const entries = Array.isArray(history) ? history : Object.values(history || {});
    const byGroup = new Map();
    for (const job of jobs || []) {
      const name = job.groupName || "未命名组";
      if (!byGroup.has(name)) {
        byGroup.set(name, { groupName: name, total: 0, ok: 0, fail: 0, errors: [] });
      }
      byGroup.get(name).total++;
    }

    const matchKey = (entry, groupName) => {
      if (!groupName) return false;
      const parts = [];
      const outputs = entry.outputs || {};
      for (const nodeId of Object.keys(outputs)) {
        const out = outputs[nodeId] || {};
        for (const img of (out.images || [])) {
          parts.push((img.subfolder ? img.subfolder + "/" : "") + (img.filename || ""));
        }
        for (const v of Object.values(out)) {
          if (typeof v === "string") parts.push(v);
          else if (v && typeof v === "object") { try { parts.push(JSON.stringify(v)); } catch {} }
        }
      }
      try { if (entry.prompt) parts.push(JSON.stringify(entry.prompt)); } catch {}
      return parts.join("\n").includes(groupName);
    };

    const matchedGroups = new Set();
    for (const entry of entries) {
      const status = entry.status || {};
      const completed = status.completed === true || status.status_str === "success";
      let error = "";
      const msgs = status.messages || [];
      for (const m of msgs) {
        const kind = Array.isArray(m) ? m[0] : (m && m.type) || "";
        const data = Array.isArray(m) ? m[1] : m;
        if (/EXECUTION_ERROR|EXECUTION_INTERRUPTED|execution_error|execution_interrupted/i.test(String(kind))) {
          error = typeof data === "string" ? data : JSON.stringify(data || "");
          break;
        }
      }
      for (const group of byGroup.values()) {
        if (matchedGroups.has(group.groupName)) continue;
        if (matchKey(entry, group.groupName)) {
          matchedGroups.add(group.groupName);
          if (completed) group.ok++;
          else { group.fail++; if (error) group.errors.push(error); }
          break;
        }
      }
    }

    const groups = [];
    for (const g of byGroup.values()) {
      const unmatched = g.total - g.ok - g.fail;
      const success = g.fail === 0 && unmatched === 0;
      let err = g.errors[0] || "";
      if (unmatched > 0) err = (err ? err + "；" : "") + `${unmatched} 条未匹配到本次输出`;
      groups.push({
        groupName: g.groupName, count: g.total, success,
        error: err || null, ok: g.ok, fail: g.fail, unmatched,
      });
    }
    return { ok: true, groups };
  }

  // 批量保存前缀：按日期目录组织（用户习惯 %date:yyyy-MM-dd%/%date:yyyyMMdd_hhmm%_anima），
  // 文件名带组名便于批量区分；同一前缀重复时 ComfyUI 自动追加 _00001_ 序号防重名。
  // 例：2026-08-15/20260815_1030_组1_anima.png
  function applySubfolderPrefix(app, groupName) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateDir = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    const stamp = "" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "_" + pad(now.getHours()) + pad(now.getMinutes());
    const safe = String(groupName || "").replace(/[\/:*?"<>|]/g, "_").slice(0, 40);
    const prefix = dateDir + "/" + stamp + (safe ? "_" + safe : "") + "_anima";
    for (const n of getNodes(app)) {
      const cls = n.type || n.comfyClass || "";
      // easy imageSave 类名是 "imageSave"（不是 "SaveImage"），两类都要匹配
      if (!/SaveImage|PreviewImage|imageSave/i.test(cls)) continue;
      const w = n.widgets?.find((x) => x.name === "filename_prefix");
      if (w) { w.value = prefix; if (typeof w.callback === "function") { try { w.callback(w.value) } catch {} } }
    }
  }

function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);
    api.registerExtension({
      name: "TK.PromptBatch.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
          const r = orig?.apply(this, arguments);
          const w = (n) => this.widgets?.find((x) => x.name === n);
          const ui = new BatchUI(this, {
            prompt_files: w("prompt_files"), positive_target: w("positive_target"),
            negative_target: w("negative_target"), camera_target: w("camera_target"),
            output_subfolder: w("output_subfolder"), groups_selection: w("groups_selection"),
            region_values: w("region_values"), camera_values: w("camera_values"),
            extra_dirs: w("extra_dirs"),
          });
          this._animaBatchUI = ui;
          ui.build();
          return r;
        };
      },
      async setup() {
        installQueueExpansion();
        // 调试钩子（CDP/控制台验证区域注入用）
        window.__tkDebug = window.__tkDebug || {};
        window.__tkDebug.injectRegionIntoPrompt = injectRegionIntoPrompt;
      },
    });
  }

  function injectStyle() {
    if (document.getElementById("anima-batch-style")) return;
    const s = document.createElement("style");
    s.id = "anima-batch-style";
    s.textContent = `
.anima-batch-ui { padding: 6px 8px; display:flex; flex-direction:column; gap:6px; border-bottom:1px solid var(--border-color,#333); }
.anima-batch-label { font-size:11px; color:var(--fg-color,#999); display:block; margin-bottom:2px; }
.anima-batch-sels { display:flex; flex-direction:column; gap:4px; }
.anima-batch-sel { }
.anima-batch-select { width:100%; background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#444); border-radius:4px; font-size:11px; padding:3px 4px; }
.anima-batch-btns { display:flex; gap:6px; }
.anima-batch-btns button, .anima-batch-btn { background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#444); border-radius:4px; font-size:11px; padding:3px 8px; cursor:pointer; }
.anima-batch-btns button:hover, .anima-batch-btn:hover { background:var(--comfy-menu-bg,#333); }
.anima-batch-filelist { max-height:150px; overflow:auto; border:1px solid var(--border-color,#444); border-radius:4px; background:var(--comfy-input-bg,#222); }
.anima-batch-file { padding:3px 6px; font-size:11px; cursor:pointer; color:var(--fg-color,#ccc); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.anima-batch-file:hover { background:var(--comfy-menu-bg,#333); color:#c586ff; }
.anima-batch-count { font-size:11px; color:#c586ff; }
.anima-batch-hint { font-size:10px; color:var(--fg-color,#999); line-height:1.4; }
.anima-batch-list { max-height:200px; overflow:auto; display:flex; flex-direction:column; gap:2px; }
.anima-batch-group { display:flex; flex-direction:column; gap:2px; padding:3px 0; border-bottom:1px dashed rgba(255,255,255,0.07); }
.anima-batch-row { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--fg-color,#ccc); }
.anima-batch-row input { margin:0; flex-shrink:0; }
.anima-batch-row-info { flex:1; min-width:0; cursor:help; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.anima-batch-region-row { display:flex; align-items:center; padding-left:20px; }
.anima-batch-region { flex:1; min-width:0; background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#444); border-radius:3px; font-size:10px; padding:2px 4px; }
.anima-batch-region:focus { border-color:#8b5cf6; outline:none; }
.anima-batch-empty { font-size:11px; color:var(--fg-color,#999); }
.anima-batch-group { border-bottom:1px dashed var(--border-color,#2a2a2a); padding:3px 0; }
.anima-batch-cam-btn { flex:0 0 auto; font-size:10px; padding:2px 8px; margin-left:auto; background:var(--comfy-input-bg,#222); color:var(--fg-color,#bbb); border:1px solid var(--border-color,#4a4a52); border-radius:4px; cursor:pointer; transition:border-color .15s, color .15s, background .15s; }
.anima-batch-cam-btn:hover { border-color:#8b5cf6; color:#c9b8ff; }
.anima-batch-cam-btn.has { background:rgba(139,92,246,0.18); color:#c9b8ff; border-color:#8b5cf6; }
/* 主操作按钮强调 */
.anima-batch-parse-btn { background:rgba(139,92,246,0.22) !important; border-color:#8b5cf6 !important; color:#d6c8ff !important; font-weight:600; }
.anima-batch-parse-btn:hover { background:rgba(139,92,246,0.35) !important; }
/* 最近使用文件 */
.anima-batch-recents { display:none; flex-wrap:wrap; gap:4px; align-items:center; }
.anima-batch-recent-label { font-size:10px; color:var(--fg-color,#888); flex-shrink:0; }
.anima-batch-recent-chip { font-size:10px; padding:2px 7px; background:var(--comfy-input-bg,#222); border:1px solid var(--border-color,#444); border-radius:10px; cursor:pointer; color:#bbb; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:border-color .15s, color .15s; }
.anima-batch-recent-chip:hover { border-color:#8b5cf6; color:#d6c8ff; }
.anima-batch-recent-chip.on { border-color:#8b5cf6; color:#c9b8ff; background:rgba(139,92,246,0.15); }
.anima-batch-recent-clear { font-size:11px; color:#888; background:none; border:none; cursor:pointer; padding:0 2px; line-height:1; }
.anima-batch-recent-clear:hover { color:#ff6b6b; }
/* 文件行：名称 + 时间 */
.anima-batch-file-row { display:flex; align-items:center; gap:6px; }
.anima-batch-file-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.anima-batch-file-meta { flex:0 0 auto; font-size:10px; color:var(--fg-color,#666); }
.anima-batch-file-meta.fresh { color:#4aba8b; font-weight:600; }
.anima-batch-search-results { border-top:1px solid var(--border-color,#2a2a2a); max-height:150px; overflow:auto; }
.anima-batch-cam-editor { padding:6px; margin:4px 0 2px 20px; background:var(--comfy-input-bg,#1a1a1f); border:1px solid var(--border-color,#333); border-radius:6px; display:flex; flex-direction:column; gap:5px; }
.anima-batch-cam-row { display:flex; align-items:center; gap:6px; }
.anima-batch-cam-sel { flex:1; min-width:0; background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#444); border-radius:4px; font-size:11px; padding:3px 4px; }
.anima-batch-cam-nl { flex:1; min-width:0; background:var(--comfy-input-bg,#222); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#444); border-radius:4px; font-size:11px; padding:3px 6px; }
.anima-batch-cam-nl:focus { border-color:#8b5cf6; outline:none; }
.anima-batch-cam-grid { display:grid; grid-template-columns:1fr; gap:3px; }
.anima-batch-cam-slider-row { display:flex; align-items:center; gap:6px; }
.anima-batch-cam-slider-label { flex:0 0 30px; font-size:10px; color:var(--fg-color,#999); }
.anima-batch-cam-slider-row input[type=range] { flex:1; min-width:0; height:14px; accent-color:#8b5cf6; cursor:pointer; }
.anima-batch-cam-slider-val { flex:0 0 34px; font-size:10px; color:#c9b8ff; text-align:right; font-variant-numeric:tabular-nums; }
.anima-batch-cam-clear { font-size:10px; padding:2px 6px; background:transparent; color:var(--fg-color,#888); border:1px dashed var(--border-color,#444); border-radius:4px; cursor:pointer; }
.anima-batch-cam-clear:hover { color:#ff6b6b; border-color:#ff6b6b; }
.anima-batch-file-cur { flex:1; min-width:0; font-size:10px; color:var(--fg-color,#aaa); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.anima-batch-nav { display:flex; align-items:center; gap:6px; padding:4px 2px; border-bottom:1px solid var(--border-color,#2a2a2a); }
.anima-batch-nav-up { font-size:10px; padding:2px 8px; flex-shrink:0; }
.anima-batch-nav-up:disabled { opacity:0.4; cursor:default; }
.anima-batch-nav-path { flex:1; min-width:0; font-size:10px; color:var(--fg-color,#888); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; }
.anima-batch-nav-pathrow { padding:4px 2px; }
.anima-batch-nav-input { width:100%; box-sizing:border-box; background:var(--comfy-input-bg,#1b1e26); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#383d4a); border-radius:4px; font-size:10px; padding:3px 6px; }
.anima-batch-nav-input:focus { outline:none; border-color:#8b5cf6; }
/* 注入目标状态行（2026-08-17：目标缺失时醒目提示） */
.anima-batch-target-status { font-size:10px; line-height:1.4; padding:3px 6px; border-radius:4px; margin:2px 0; }
.anima-batch-target-status.ok { color:#4aba8b; background:rgba(74,186,139,0.08); }
.anima-batch-target-status.warn { color:#ff9d5c; background:rgba(255,157,92,0.10); border:1px solid rgba(255,157,92,0.35); font-weight:600; }
`;
    document.head.appendChild(s);
  }

  injectStyle();
  init();
})();
