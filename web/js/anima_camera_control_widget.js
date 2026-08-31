// Anima Camera Control 节点前端 Widget
// 便捷机位控制：一键预设 + 3D 球面轨道（方位/俯仰）+ 景别滑杆 + 实时预览
// 算法与后端 anima_camera_control.py（忠实复刻 BSK）保持一致。
(function () {
  const NODE_NAME = "TK Camera Control";

  // ── 与后端 DEFAULT_CONFIG 一致 ──
  const DEFAULT_CONFIG = {
    weight_min: 0.1, weight_max: 10.0, no_weight: false, no_weight_threshold: 0.5,
    azimuth: { enabled: true, weight: 10.0, deadzone_ratio: 0.2,
      directions: { front: { tag: "from front", enabled: true }, back: { tag: "from behind", enabled: true }, left: { tag: "from right", enabled: true }, right: { tag: "from left", enabled: true } } },
    elevation: { enabled: true, extra: 10.0,
      categories: { bird: { tag: "directly above, from above, aerial view,", enabled: true }, high: { tag: "high angle, from above", enabled: true }, eye: { tag: "eye-level", enabled: true }, low: { tag: "low angle, from below,", enabled: true }, worm: { tag: "directly below", enabled: true } } },
    distance: { enabled: true, extra: 0.0,
      categories: { ecu: { tag: "extreme close-up", enabled: true }, cu: { tag: "close-up", enabled: true }, medium: { tag: "medium shot", enabled: true }, full: { tag: "full body", enabled: true }, wide: { tag: "wide shot", enabled: true } } },
    tilt: { enabled: true, deadzone: 0.15, extra: 0.0, dutch_tag: "dutch angle" },
    extra_master: 1.0, wheel_step: 0.0003,
    extras: { lens: { enabled: false, value: "85mm lens" }, dof: { enabled: false, value: "shallow depth of field", weight: 1.3 }, movement: { enabled: false, value: "handheld camera" }, composition: { enabled: false, value: "rule of thirds" }, style: { enabled: false, value: "cinematic" } },
  };
  const DIST_RANGES = { ecu: [0.7, 1.0], cu: [0.2, 0.7], medium: [-0.2, 0.2], full: [-0.7, -0.2], wide: [-1.0, -0.7] };
  const DIST_FAR_STRONGER = { medium: 1, full: 1, wide: 1 };

  // 与后端 PRESETS 一致
  const PRESETS = {
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
    "角色特写": { pos_x: 0, pos_y: 0, pos_z: 1, roll: 0 },
    "角色中景": { pos_x: 0, pos_y: 0, pos_z: 0, roll: 0 },
  };

  // ── 用户自定义预设（后端 data/camera_presets.json，2026-08-24）──
  let CUSTOM_PRESETS = {};

  async function loadCustomPresets() {
    try {
      const r = await (await fetch("/anima/camera/presets")).json();
      if (r && r.ok && r.custom) CUSTOM_PRESETS = r.custom || {};
    } catch (e) {
      CUSTOM_PRESETS = {};
    }
    return CUSTOM_PRESETS;
  }
  async function camPost(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  // ── 忠实 JS 端口：compute（与后端一致，用于实时预览） ──
  const fmtWeight = (w) => (Math.round(parseFloat(w) * 100) / 100).toFixed(2);
  const splitTags = (t) => String(t || "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const elevationKey = (y) => (y > 0.7 ? "bird" : y > 0.2 ? "high" : y >= -0.2 ? "eye" : y >= -0.7 ? "low" : "worm");
  const distanceKey = (z) => (z > 0.7 ? "ecu" : z > 0.2 ? "cu" : z >= -0.2 ? "medium" : z >= -0.7 ? "full" : "wide");
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function mergeDefaults(cfg, base) {
    for (const k in base) {
      if (!(k in cfg)) cfg[k] = base[k];
      else if (base[k] && typeof base[k] === "object" && !Array.isArray(base[k]) && cfg[k] && typeof cfg[k] === "object") mergeDefaults(cfg[k], base[k]);
    }
    return cfg;
  }
  function loadConfig(raw) {
    let cfg;
    try { cfg = JSON.parse(raw); } catch (e) { cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }
    if (!cfg || typeof cfg !== "object") cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    mergeDefaults(cfg, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    return cfg;
  }
  function emitWeighted(tag, w) { return splitTags(tag).map((t) => `(${t}:${fmtWeight(w)})`); }
  function emitPlain(tag) { return splitTags(tag); }

  function distanceParts(cfg, z) {
    const key = distanceKey(parseFloat(z));
    const cat = (cfg.distance?.categories || {})[key];
    if (!cat || !cat.tag || cat.enabled === false) return [];
    const em = parseFloat(cfg.extra_master ?? 1.0);
    const extra = parseFloat(cfg.distance?.extra ?? 0.0);
    const wmin = parseFloat(cfg.weight_min ?? 0.1);
    const wmax = parseFloat(cfg.weight_max ?? 10.0);
    const [start, end] = DIST_RANGES[key];
    let frac = DIST_FAR_STRONGER[key] ? (end - parseFloat(z)) / (end - start) : (parseFloat(z) - start) / (end - start);
    frac = clamp(frac, 0, 1);
    let w = 1.0 + frac * em * extra;
    w = clamp(w, wmin, wmax);
    return emitWeighted(cat.tag, w);
  }

  function computeCamera(px, py, pz, rl, config, cfg) {
    cfg = cfg || loadConfig(config);
    if (cfg.no_weight) return computeNoWeight(px, py, pz, rl, cfg);
    const parts = [];
    const wmin = parseFloat(cfg.weight_min ?? 0.1);
    const wmax = parseFloat(cfg.weight_max ?? 5.0);
    const dz = parseFloat(cfg.azimuth?.deadzone_ratio ?? 0.2);

    if (cfg.azimuth?.enabled !== false) {
      const az = parseFloat(px) * Math.PI;
      let front = Math.max(0, Math.cos(az)), back = Math.max(0, -Math.cos(az));
      let right = Math.max(0, Math.sin(az)), left = Math.max(0, -Math.sin(az));
      const s = front + back + left + right;
      if (s > 0) { front /= s; back /= s; left /= s; right /= s; }
      const AZ_POLE = 0.9;
      const azGate = clamp((1 - Math.abs(parseFloat(py))) / (1 - AZ_POLE), 0, 1);
      // 先限制整个方位预算，再按方向比例分配，避免 azimuth.weight > weight_max
      // 时各方向分别被钳成最高值，造成 3D 机位移动而权重长时间不变。
      const azWeight = Math.max(0, parseFloat(cfg.azimuth.weight) || 0);
      const azBudget = Math.min(azWeight, wmax) * azGate;
      for (const [name, ratio] of [["front", front], ["back", back], ["left", left], ["right", right]]) {
        const dir = (cfg.azimuth.directions || {})[name] || {};
        if (dir.enabled === false) continue;
        let w = ratio * azBudget;
        if (ratio <= 0 || w < dz) continue;
        w = clamp(w, wmin, wmax);
        parts.push(...emitWeighted(dir.tag || "", w));
      }
    }

    if (cfg.elevation?.enabled !== false) {
      const ek = elevationKey(parseFloat(py));
      const cat = (cfg.elevation?.categories || {})[ek];
      if (cat && cat.tag && cat.enabled !== false) {
        const em = parseFloat(cfg.extra_master ?? 1.0);
        const ee = parseFloat(cfg.elevation?.extra ?? 0.0);
        let ew = Math.abs(parseFloat(py)) * (1.0 + em * ee);
        if (ew >= dz) { ew = clamp(ew, wmin, wmax); parts.push(...emitWeighted(cat.tag, ew)); }
      }
    }

    if (cfg.distance?.enabled !== false) parts.push(...distanceParts(cfg, pz));

    if (cfg.tilt?.enabled !== false && Math.abs(parseFloat(rl)) >= parseFloat(cfg.tilt?.deadzone ?? 0.15)) {
      const em = parseFloat(cfg.extra_master ?? 1.0);
      const te = parseFloat(cfg.tilt?.extra ?? 0.0);
      const wmax2 = parseFloat(cfg.weight_max ?? 10.0);
      let w = 1.0 + em * te; w = clamp(w, 0.1, wmax2);
      parts.push(...emitWeighted(cfg.tilt.dutch_tag || "", w));
    }

    for (const key of ["lens", "dof", "movement", "composition", "style"]) {
      const e = (cfg.extras || {})[key];
      if (!e || !e.enabled) continue;
      const val = (e.value || "").trim();
      if (!val) continue;
      parts.push(key === "dof" ? `(${val}:${fmtWeight(e.weight ?? 1.3)})` : val);
    }
    let result = parts.join(", ");
    if (result) result += ",";
    return result;
  }

  function computeNoWeight(px, py, pz, rl, cfg) {
    const parts = [];
    const thr = parseFloat(cfg.no_weight_threshold ?? 0.5);
    const azc = cfg.azimuth || {};
    if (azc.enabled !== false) {
      const a = parseFloat(px) * Math.PI;
      let front = Math.max(0, Math.cos(a)), back = Math.max(0, -Math.cos(a));
      let right = Math.max(0, Math.sin(a)), left = Math.max(0, -Math.sin(a));
      const s = front + back + left + right;
      if (s > 0) { front /= s; back /= s; left /= s; right /= s; }
      const AZ_POLE = 0.9;
      const azGate = clamp((1 - Math.abs(parseFloat(py))) / (1 - AZ_POLE), 0, 1);
      if (azGate > 0) {
        const dirs = [["front", front], ["back", back], ["left", left], ["right", right]];
        let dom = null, domR = -1;
        for (const [name, ratio] of dirs) { const d = azc.directions?.[name]; if (d?.enabled === false) continue; if (ratio > domR) { domR = ratio; dom = name; } }
        if (dom && domR > 0) parts.push(...emitPlain(azc.directions[dom].tag || ""));
        for (const [name, ratio] of dirs) { if (name === dom) continue; const d = azc.directions?.[name]; if (d?.enabled === false) continue; if (ratio >= thr) parts.push(...emitPlain(d.tag || "")); }
      }
    }
    if (cfg.elevation?.enabled !== false) { const ek = elevationKey(parseFloat(py)); if (ek !== "eye") { const c = cfg.elevation?.categories?.[ek]; if (c?.tag && c.enabled !== false) parts.push(...emitPlain(c.tag)); } }
    if (cfg.distance?.enabled !== false) { const dk = distanceKey(parseFloat(pz)); if (dk !== "medium") { const c = cfg.distance?.categories?.[dk]; if (c?.tag && c.enabled !== false) parts.push(...emitPlain(c.tag)); } }
    if (cfg.tilt?.enabled !== false && Math.abs(parseFloat(rl)) >= parseFloat(cfg.tilt?.deadzone ?? 0.15)) parts.push(...emitPlain(cfg.tilt.dutch_tag || ""));
    for (const key of ["lens", "dof", "movement", "composition", "style"]) { const e = cfg.extras?.[key]; if (e?.enabled && (e.value || "").trim()) parts.push((e.value || "").trim()); }
    const result = parts.join(", ");
    return result ? result + "," : "";
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 统一拖拽绑定：setPointerCapture 让指针移出元素/节点后仍持续收到事件（跟手），
  // pointerup / pointercancel / lostpointercapture 三路兜底释放，杜绝「松开后仍在拖」的残留。
  function bindDrag(el, handler) {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el._dragActive = true;
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.classList.add("dragging");
      handler(e);
    });
    // rAF 节流：拖动时每帧最多回调一次，避免高频 pointermove 全量重绘造成卡顿。
    // 用 _dragActive 状态机而非 hasPointerCapture（合成事件/部分环境 capture 不可用）
    let raf = null;
    el.addEventListener("pointermove", (e) => {
      if (!el._dragActive) return;
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; try { handler(e); } catch (err) {} });
    });
    const release = (e) => {
      el._dragActive = false;
      el.classList.remove("dragging");
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      try { el.releasePointerCapture(e.pointerId); } catch {}
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("lostpointercapture", release);
  }

  // ── 通用 < 值 > scrubbing 控件（复刻 TK LoRA 节点权重调节：单击步进 + 按住拖动连续调 + 直输）──
  // opts: { get, set, fmt, parse, step, min, max, zero?, onChange?, title? }
  function buildScrub(opts) {
    const g = document.createElement("div");
    g.className = "anima-scrub";
    const mkBtn = (dir) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "anima-scrub-btn";
      b.title = (opts.title || "") + (dir > 0 ? "（按住左右拖动可连续调）" : "（按住左右拖动可连续调）");
      b.innerHTML = dir > 0
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'
        : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
      return b;
    };
    const dec = mkBtn(-1), inc = mkBtn(1);
    const val = document.createElement("input");
    val.type = "text";
    val.inputMode = "decimal";
    val.className = "anima-scrub-val";
    g.append(dec, val, inc);

    const clampV = (v) => Math.max(opts.min, Math.min(opts.max, v));
    const refresh = () => { val.value = opts.fmt(clampV(opts.get())); };
    const commit = (v) => { opts.set(clampV(v)); refresh(); if (opts.onChange) opts.onChange(); };

    // 单击步进（拖动过则跳过 click，避免双重触发）
    const stepFn = (btn, d) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        if (btn.__scrubbed) { btn.__scrubbed = false; return; }
        commit(opts.get() + d);
      };
    };
    stepFn(dec, -opts.step);
    stepFn(inc, +opts.step);

    // scrubbing：按住后水平位移 → 增量（4px = 0.05）；rAF 节流保证顺滑
    const attachScrub = (btn) => {
      let startX = 0, startV = 0, dragging = false, moved = false, raf = null;
      const onMove = (e) => {
        if (!dragging || raf) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          const dx = e.clientX - startX;
          if (Math.abs(dx) >= 2) moved = true;
          commit(startV + Math.round(dx / 4) * 0.05);
        });
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        btn.__scrubbed = moved;
        if (moved) setTimeout(() => { if (btn.__scrubbed) btn.__scrubbed = false; }, 2000);
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      };
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true; moved = false;
        startX = e.clientX; startV = opts.get();
        document.body.style.cursor = "ew-resize";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    };
    attachScrub(dec);
    attachScrub(inc);

    // 双击归零（distance/angle 支持）
    if (opts.zero !== undefined) {
      g.addEventListener("dblclick", (e) => { if (e.target !== val) commit(opts.zero); });
    }
    // 滚轮微调（悬停时）
    g.addEventListener("wheel", (e) => {
      e.preventDefault();
      commit(opts.get() - Math.sign(e.deltaY) * opts.step);
    }, { passive: false });

    // 直输（数字或档位词）
    val.onchange = () => {
      const v = opts.parse(val.value);
      if (v !== null) commit(v); else refresh();
    };
    val.onkeydown = (e) => { if (e.key === "Enter") val.blur(); };

    refresh();
    g.refresh = refresh;
    g.commit = commit;
    return g;
  }

  // ── 3D 空间画布数学：目标在原点，被控相机在球坐标 (r, az, el) ──
  // 这里的 3D 只负责“看起来像空间”；输入仍然使用 BSK 的二维坐标模型。
  // 这样画面有空间方位，鼠标映射却不会受到遮挡、背面交点或浏览器缩放影响。
  const CAM_EYE = [3.4, 1.5, 4.8];   // 观察者（画布视角）位置
  const CAM_UP = [0, 1, 0];
  const CAM_FOV = 52 * Math.PI / 180;
  const CAMERA_POINT_HIT_RADIUS = 18;
  const CAMERA_VIEW_RADIUS = 2.4;
  const CAMERA_DRAG_MODES = {
    relative: { label: "相对", hint: "相对拖拽：沿用 BSK 的鼠标增量，连续旋转机位。" },
    absolute: { label: "绝对", hint: "绝对拖拽：画布位置直接对应方位和俯仰，左右边缘可到后方。" },
    hybrid: { label: "融合", hint: "融合拖拽：按下先定位，移动后按增量连续调整。" },
  };
  const CAMERA_DRAG_MODE_KEY = "anima-camera-drag-mode";
  function v3sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
  function v3cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function v3norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
  function v3dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
  function cam3DPos(r, az, el) {
    return [r*Math.cos(el)*Math.sin(az), r*Math.sin(el), r*Math.cos(el)*Math.cos(az)];
  }
  function cam3DFocal(H) { return (H / 2) / Math.tan(CAM_FOV / 2); }
  // 世界点 → 屏幕（透视投影）。
  // ⚠️ 屏幕 x 取反（水平镜像）：让「相机在被摄体左侧」(px>0, 输出 "from left") 的机位
  // 视觉上真的出现在被摄体左侧，画布所见与输出语义一致（BSK 约定，见 azWord 注释）。
  function cam3DProject(p, W, H) {
    const zc = v3norm(v3sub(CAM_EYE, [0, 0, 0]));
    const xc = v3norm(v3cross(CAM_UP, zc));
    const yc = v3cross(zc, xc);
    const pc = [v3dot(v3sub(p, CAM_EYE), xc), v3dot(v3sub(p, CAM_EYE), yc), v3dot(v3sub(p, CAM_EYE), zc)];
    if (pc[2] >= -0.1) return null;
    const f = cam3DFocal(H);
    return [W/2 - (pc[0] / -pc[2]) * f, H/2 - (pc[1] / -pc[2]) * f];
  }
  function wrapAzimuth(value) {
    return ((parseFloat(value) + 1) % 2 + 2) % 2 - 1;
  }

  // 机位中文词（画布标签/状态栏共用）。
  // ⚠️ 方位词与输出 tag 语义一致（忠实 BSK：px>0 输出 "from left" 即相机在被摄体左侧，
  // 见后端 parse_camera_nl 注释「BSK：right 方向输出 from left（相机在左）」），
  // 3D 画布场景按同一语义镜像渲染（cam3DProject 水平镜像），保证「画布所见 = 输出所出」。
  function azWord(px) {
    const d = parseFloat(px) / 1;
    if (Math.abs(d) < 0.12) return "正面";
    if (Math.abs(d) > 0.88) return "背面";
    return d > 0 ? "左方" : "右方";
  }
  function azDeg(px) { return Math.round(parseFloat(px ?? 0) * 180); }
  function elDeg(py) { return Math.round(parseFloat(py ?? 0) * 90); }
  function elWord(py) {
    const e = parseFloat(py);
    if (e > 0.65) return "正上方";
    if (e > 0.15) return "俯视";
    if (e < -0.65) return "正下方";
    if (e < -0.15) return "仰视";
    return "平视";
  }
  function distWord(pz) {
    const z = parseFloat(pz);
    if (z > 0.7) return "特写";
    if (z > 0.2) return "近景";
    if (z >= -0.2) return "中景";
    if (z >= -0.7) return "全身";
    return "远景";
  }
  // 翻滚角度文本：roll∈[-1,1] ↔ ±90°
  function fmtDeg(rl) {
    const d = Math.round(parseFloat(rl ?? 0) * 90);
    if (d === 0) return "0°";
    return (d > 0 ? "+" : "") + d + "°";
  }

  class CameraUI {
    constructor(node, w) {
      this.node = node;
      this.w = w; // {preset, nl, px, py, pz, roll, config, extra_tags}; nl 仅为旧工作流兼容
      this.rootEl = null;
      this.dragMode = this._readDragMode();
    }

    _readDragMode() {
      try {
        const mode = window.localStorage.getItem(CAMERA_DRAG_MODE_KEY);
        return Object.prototype.hasOwnProperty.call(CAMERA_DRAG_MODES, mode) ? mode : "hybrid";
      } catch (e) { return "hybrid"; }
    }

    _setDragMode(mode) {
      if (!Object.prototype.hasOwnProperty.call(CAMERA_DRAG_MODES, mode)) return;
      this.dragMode = mode;
      try { window.localStorage.setItem(CAMERA_DRAG_MODE_KEY, mode); } catch (e) {}
      for (const button of this.dragModeButtons || []) {
        const active = button.dataset.mode === mode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
      const meta = CAMERA_DRAG_MODES[mode];
      if (this.spaceHint) this.spaceHint.textContent = meta.hint + " 滚轮调距离；握把法线面仅作空间参照。";
      if (this.canvas) {
        this.canvas.title = meta.hint + " 滚轮调节远近。";
      }
    }

    _setW(widget, value) {
      if (!widget) return;
      widget.value = value;
      if (typeof widget.callback === "function") { try { widget.callback(value); } catch (e) {} }
    }

    // 手动操作时清除旧工作流可能带入的隐藏 nl_prompt，避免后端兼容逻辑覆盖当前机位。
    _clearNl() {
      if (this.w.nl) this._setW(this.w.nl, "");
    }

    _applyPreset(name) {
      const p = PRESETS[name] || CUSTOM_PRESETS[name];
      if (!p) return;
      this._setW(this.w.px, p.pos_x);
      this._setW(this.w.py, p.pos_y);
      this._setW(this.w.pz, p.pos_z);
      this._setW(this.w.roll, p.roll);
      this._setW(this.w.preset, name);
      this._clearNl();
      this._syncControls();
    }

    _syncControls() {
      const px = parseFloat(this.w.px?.value ?? 0), py = parseFloat(this.w.py?.value ?? 0);
      const pz = parseFloat(this.w.pz?.value ?? 0), rl = parseFloat(this.w.roll?.value ?? 0);
      if (this.canvas) this._draw3D(px, py, pz, rl);
      if (this.rollFill && this.rollTrack) {
        const w = this.rollTrack.getBoundingClientRect().width;
        const mid = w / 2;
        const hw = Math.max(1, Math.abs(rl) * (w / 2 - 3));
        this.rollFill.style.left = (rl >= 0 ? mid : mid - hw) + "px";
        this.rollFill.style.width = hw + "px";
      }
      if (this.rollVal) this.rollVal.textContent = fmtDeg(rl);
      // 景别滑块：fill 从中心向两侧展开，右侧显示景别词
      if (this.distFill && this.distTrack) {
        const w = this.distTrack.getBoundingClientRect().width;
        const mid = w / 2;
        const hw = Math.max(1, Math.abs(pz) * (w / 2 - 3));
        this.distFill.style.left = (pz >= 0 ? mid : mid - hw) + "px";
        this.distFill.style.width = hw + "px";
      }
      if (this.distVal) this.distVal.textContent = distWord(pz);
      if (this._distScrub) this._distScrub.refresh();
      if (this._rollScrub) this._rollScrub.refresh();
      if (this._wtMaxScrub) this._wtMaxScrub.refresh();
      if (this._wtMinScrub) this._wtMinScrub.refresh();
      if (this.presetSelect) this.presetSelect.value = this.w.preset?.value || "自定义";
      this._updatePreview(px, py, pz, rl);
    }

    // ── 权重配置读写（config widget 是 JSON，UI 滑块只改其中字段）──
    _readConfig() {
      try { return JSON.parse(this.w.config?.value || "{}") || {}; } catch { return {}; }
    }
    _writeConfig(patch) {
      const cfg = this._readConfig();
      for (const k of Object.keys(patch)) cfg[k] = patch[k];
      this._setW(this.w.config, JSON.stringify(cfg));
      this._syncControls(); // 刷新预览（computeCamera 走 loadConfig 合并默认值）
    }

    // 画布坐标转换与 BSK 保持同一原则：先把 CSS 坐标还原到画布逻辑坐标，
    // 再用画布中心和半宽/半高映射参数。绝对模式不依赖 3D 投影，前后端点都可达。
    _canvasPoint(e, rect) {
      const dpr = this._dpr || 1;
      const W = this.canvas.width / dpr;
      const H = this.canvas.height / dpr;
      return {
        x: (e.clientX - rect.left) * W / Math.max(1, rect.width),
        y: (e.clientY - rect.top) * H / Math.max(1, rect.height),
        W,
        H,
      };
    }

    _canvasAbsolute(point) {
      return {
        px: clamp((point.x - point.W / 2) / (point.W / 2), -1, 1),
        py: clamp((point.H / 2 - point.y) / (point.H / 2), -1, 1),
      };
    }

    _commitCanvasPosition(px, py, preview = true) {
      const pz = parseFloat(this.w.pz?.value ?? 0);
      const rl = parseFloat(this.w.roll?.value ?? 0);
      px = wrapAzimuth(px);
      py = clamp(py, -1, 1);
      this._curPx = px;
      this._curPy = py;
      this._setW(this.w.px, Math.round(px * 100) / 100);
      this._setW(this.w.py, Math.round(py * 100) / 100);
      this._draw3D(px, py, pz, rl, true);
      if (this.stateEl) this.stateEl.textContent = this._describe(px, py, pz, rl);
      if (preview) {
        const now = performance.now();
        if (now - (this._lastPreviewAt || 0) > 100) {
          this._lastPreviewAt = now;
          this._updatePreview(px, py, pz, rl);
        }
      }
    }

    // 交互模型直接复用 BSK：相对=增量，绝对=画布坐标，融合=绝对起点+相对连续拖动。
    // 三维投影只负责视觉反馈，不参与输入反解，避免“看到后方但点不到后方”。
    _canvasDrag(e) {
      if (!this.canvas) return;
      if (e.type === "pointerdown") {
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        const point = this._canvasPoint(e, rect);
        const mode = this.dragMode;
        this._dragMode = mode;
        this._dragRect = rect;
        this._dragStart = {
          x: point.x, y: point.y,
          W: point.W, H: point.H,
          px: parseFloat(this.w.px?.value ?? 0), py: parseFloat(this.w.py?.value ?? 0),
        };
        this._lastX = point.x;
        this._lastY = point.y;
        this._curPx = this._dragStart.px;
        this._curPy = this._dragStart.py;
        this._dragging = true;
        this._lastPreviewAt = 0;
        if (this.canvas) this.canvas.style.cursor = "grabbing";
        // 一次性清理（拖动中不再重复写）：手动操作必须清 NL，否则后端 NL 优先会覆盖手动机位
        this._setW(this.w.preset, "自定义");
        this._clearNl();
        if (mode === "absolute" || mode === "hybrid") {
          const next = this._canvasAbsolute(point);
          this._commitCanvasPosition(next.px, next.py, false);
        }
        return;
      }
      const st = this._dragStart;
      if (!st) return;
      const rect = this._dragRect;
      if (!rect || rect.width < 1) return;

      const point = this._canvasPoint(e, rect);
      let px;
      let py;
      if (this._dragMode === "absolute") {
        const next = this._canvasAbsolute(point);
        px = next.px;
        py = next.py;
      } else {
        const dx = (point.x - this._lastX) / (st.W / 2);
        const dy = (point.y - this._lastY) / (st.H / 2);
        this._lastX = point.x;
        this._lastY = point.y;
        px = wrapAzimuth(this._curPx + dx);
        py = clamp(this._curPy - dy, -1, 1);
      }
      this._commitCanvasPosition(px, py);
    }

    // 拖拽结束：清空拖拽状态并做一次全量刷新（预览/scrub/预设下拉等回到一致状态）
    _finishDrag() {
      if (!this._dragging && !this._dragStart) return;
      this._dragging = false;
      this._dragMode = null;
      this._dragStart = null;
      this._dragRect = null;
      this._lastX = undefined;
      this._lastY = undefined;
      this._curPx = undefined;
      this._curPy = undefined;
      if (this.canvas) this.canvas.style.cursor = "";
      this._syncControls();
    }

    // 节点移除时清理全局监听（document 级 wheel 捕获 + ResizeObserver）
    dispose() {
      if (this._wheelHandler) {
        document.removeEventListener("wheel", this._wheelHandler, true);
        this._wheelHandler = null;
      }
      if (this._ro) { try { this._ro.disconnect(); } catch {} this._ro = null; }
    }

    // 3D 场景渲染：半透明球面 + 稀疏轨道 + 目标 + 握把法线延伸面。
    // 3D 只负责视觉反馈，输入映射在 _canvasDrag 中单独完成。
    _draw3D(px, py, pz, rl, dragging) {
      const cv = this.canvas;
      const ctx = cv.getContext("2d");
      // dpr 感知：物理像素绘制，scale 回逻辑坐标 → 高 DPI/拉伸下文字线条不糊
      const dpr = this._dpr || 1;
      const W = cv.width / dpr, H = cv.height / dpr;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);
      const az = parseFloat(px) * Math.PI, el = parseFloat(py) * Math.PI / 2;
      // 显示半径固定：球面/轨道/相机点三者一致（所见=可控范围）。
      // 距离（pz）不改变交互坐标，避免滚轮改变画布可操作范围。
      const r = CAMERA_VIEW_RADIUS;
      const cam = cam3DPos(r, az, el);
      const cx0 = W / 2, cy0 = H / 2;

      // 球面只作为空间参照，不作为输入命中面。颜色和线条保持半透明，避免盖住节点内容。
      const sphereCx = cx0, sphereCy = cy0;
      const sphereRx = Math.min(W * 0.42, H * 0.48);
      const sphereRy = Math.min(H * 0.43, sphereRx * 0.82);
      ctx.fillStyle = "rgba(148,163,184,0.045)";
      ctx.beginPath(); ctx.ellipse(sphereCx, sphereCy, sphereRx, sphereRy, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(226,232,240,0.34)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(sphereCx, sphereCy, sphereRx, sphereRy, 0, 0, Math.PI * 2); ctx.stroke();

      const drawSphereCurve = (points, front, back, width = 1, backDash = true) => {
        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i], b = points[i + 1];
          if (!a || !b) continue;
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
          const near = v3dot(mid, CAM_EYE) >= 0;
          const p0 = cam3DProject(a, W, H), p1 = cam3DProject(b, W, H);
          if (!p0 || !p1) continue;
          ctx.strokeStyle = near ? front : back;
          ctx.lineWidth = near ? width : Math.max(0.7, width * 0.78);
          ctx.setLineDash(near || !backDash ? [] : [3, 3]);
          ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
        }
        ctx.setLineDash([]);
      };

      // 稀疏经纬线：保留前后层次，但不把画布变成密集网格。
      for (let latIndex = -2; latIndex <= 2; latIndex++) {
        const lat = latIndex * Math.PI / 8;
        const points = [];
        for (let i = 0; i <= 48; i++) points.push(cam3DPos(r, i / 48 * Math.PI * 2, lat));
        drawSphereCurve(points, "rgba(226,232,240,0.30)", "rgba(148,163,184,0.12)", latIndex === 0 ? 1.3 : 0.8);
      }
      for (let lonIndex = 0; lonIndex < 8; lonIndex++) {
        const lon = lonIndex / 8 * Math.PI * 2;
        const points = [];
        for (let i = 0; i <= 24; i++) points.push(cam3DPos(r, lon, (i / 24 - 0.5) * Math.PI));
        drawSphereCurve(points, "rgba(203,213,225,0.24)", "rgba(100,116,139,0.10)", 0.8);
      }

      // 相机轨道：保留赤道和当前方位的垂直法线，作为握把的空间参照。
      ctx.strokeStyle = "rgba(255,255,255,0.38)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 60; i++) {
        const a0 = (i / 60) * Math.PI * 2, a1 = ((i + 1) / 60) * Math.PI * 2;
        const p0 = cam3DProject([r * Math.cos(a0), 0, r * Math.sin(a0)], W, H);
        const p1 = cam3DProject([r * Math.cos(a1), 0, r * Math.sin(a1)], W, H);
        if (p0 && p1) { ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke(); }
      }
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      for (let i = -18; i <= 18; i++) {
        const e0 = (i / 18) * Math.PI / 2, e1 = ((i + 1) / 18) * Math.PI / 2;
        const p0 = cam3DProject(cam3DPos(r, az, e0), W, H);
        const p1 = cam3DProject(cam3DPos(r, az, e1), W, H);
        if (p0 && p1) { ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke(); }
      }

      // 目标：简笔人形（面向 +z，即「前」）+ 地面阴影 + 朝向箭头
      const head = cam3DProject([0, 1.15, 0], W, H);
      const bodyT = cam3DProject([0, 0.75, 0], W, H);
      const bodyB = cam3DProject([0, 0.15, 0], W, H);
      const face = cam3DProject([0, 1.15, 0.22], W, H);
      const feetP = cam3DProject([0, 0, 0], W, H);
      if (feetP) {
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.beginPath(); ctx.ellipse(feetP[0], feetP[1], 7, 2.8, 0, 0, Math.PI * 2); ctx.fill();
      }
      if (head && bodyT && bodyB) {
        ctx.strokeStyle = "rgba(255,255,255,0.78)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(head[0], head[1], 6, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bodyT[0], bodyT[1]); ctx.lineTo(bodyB[0], bodyB[1]); ctx.stroke();
        if (face) {
          ctx.strokeStyle = "rgba(255,255,255,0.55)";
          ctx.beginPath(); ctx.moveTo(head[0], head[1]); ctx.lineTo(face[0], face[1]); ctx.stroke();
        }
        // 脚底朝向箭头：指向「前」(+z)，配合「前」标签一眼看清被摄体朝向
        const tip = cam3DProject([0, 0.03, 0.55], W, H);
        const al = cam3DProject([0.11, 0.02, 0.28], W, H);
        const ar = cam3DProject([-0.11, 0.02, 0.28], W, H);
        if (tip && al && ar) {
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(al[0], al[1]); ctx.lineTo(ar[0], ar[1]); ctx.closePath(); ctx.fill();
        }
      }

      // 相机握把 + 法线延伸面：只保留一个半透明的空间参照面。
      // 这个面包含“握把 → 目标”的视线方向，宽度表示相机朝向的横向范围，
      // 高度表示垂直参照；它是显示层，不参与坐标计算。
      const cp = cam3DProject(cam, W, H);
      this._cameraPoint = cp;
      if (cp) {
        const target = cam3DProject([0, 0.75, 0], W, H);
        // 用握把到目标的屏幕法线构造一个稳定的薄面。厚度固定在屏幕像素中，
        // 因此节点缩放或观察角度变化时仍然看得见，不会退化成一条黑线。
        const lineX = target ? target[0] - cp[0] : 0;
        const lineY = target ? target[1] - cp[1] : 0;
        const lineLength = Math.hypot(lineX, lineY) || 1;
        const normalX = -lineY / lineLength, normalY = lineX / lineLength;
        const nearHalf = 14, farHalf = 5;
        const planePoints = target ? [
          [cp[0] + normalX * nearHalf, cp[1] + normalY * nearHalf],
          [cp[0] - normalX * nearHalf, cp[1] - normalY * nearHalf],
          [target[0] - normalX * farHalf, target[1] - normalY * farHalf],
          [target[0] + normalX * farHalf, target[1] + normalY * farHalf],
        ] : [];
        if (target) {
          ctx.fillStyle = "rgba(226,232,240,0.14)";
          ctx.strokeStyle = "rgba(226,232,240,0.34)";
          ctx.lineWidth = 0.9;
          ctx.beginPath(); ctx.moveTo(planePoints[0][0], planePoints[0][1]);
          for (let i = 1; i < planePoints.length; i++) ctx.lineTo(planePoints[i][0], planePoints[i][1]);
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        if (target) {
          ctx.strokeStyle = "rgba(255,190,90,0.38)";
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(cp[0], cp[1]); ctx.lineTo(target[0], target[1]); ctx.stroke();
          ctx.setLineDash([]);
        }
        const ground = cam3DProject([cam[0], 0, cam[2]], W, H);
        if (ground && Math.abs(cam[1]) > 0.08) {
          ctx.strokeStyle = "rgba(226,232,240,0.24)";
          ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(cp[0], cp[1]); ctx.lineTo(ground[0], ground[1]); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(226,232,240,0.48)";
          ctx.beginPath(); ctx.arc(ground[0], ground[1], 2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = "rgba(255,190,90,0.42)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cp[0], cp[1], CAMERA_POINT_HIT_RADIUS * 0.42, 0, Math.PI * 2); ctx.stroke();
        if (dragging) {
          ctx.fillStyle = "rgba(255,165,0,0.16)";
          ctx.beginPath(); ctx.arc(cp[0], cp[1], 10, 0, Math.PI * 2); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(cp[0], cp[1], 6, 0, Math.PI * 2);
        ctx.fillStyle = "#ffb35c"; ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.2; ctx.stroke();
      }

      // 罗盘标签只保留水平四向，避免画面信息过载。
      ctx.font = "10px system-ui";
      const labelR = r * 1.06;
      const compass = [
        { p: [0, 0, labelR], t: "前", c: "rgba(74,222,128,0.95)" },
        { p: [0, 0, -labelR], t: "后", c: "rgba(248,113,113,0.75)" },
        { p: [labelR, 0, 0], t: "左", c: "rgba(255,255,255,0.75)" },
        { p: [-labelR, 0, 0], t: "右", c: "rgba(255,255,255,0.75)" },
      ];
      for (const { p, t, c } of compass) {
        const sp = cam3DProject(p, W, H);
        if (sp) {
          ctx.fillStyle = c;
          ctx.fillText(t, sp[0] + 4, sp[1] + 4);
        }
      }
      ctx.restore();
    }

    _updatePreview(px, py, pz, rl) {
      const raw = this.w.config?.value || "";
      // 配置解析缓存：拖动热路径节流调用时避免每帧 JSON.parse
      if (this._cfgCacheRaw !== raw) {
        this._cfgCacheRaw = raw;
        this._cfgCache = loadConfig(raw);
      }
      const extra = (this.w.extra_tags?.value || "").trim();
      let prompt = computeCamera(px, py, pz, rl, raw, this._cfgCache);
      if (extra) { prompt = prompt.replace(/,\s*$/, ""); prompt = (prompt ? prompt + ", " : "") + extra + ","; }
      if (this.previewEl) this.previewEl.textContent = prompt || "（当前机位无相机词输出）";
      if (this.stateEl) this.stateEl.textContent = this._describe(px, py, pz, rl);
    }

    _describe(px, py, pz, rl) {
      const el = { bird: "正上方", high: "俯视", eye: "平视", low: "仰视", worm: "正下方" }[elevationKey(py)];
      const dl = { ecu: "特写", cu: "近景", medium: "中景", full: "全身", wide: "远景" }[distanceKey(pz)];
      let az = "正面";
      const a = Math.abs(px);
      if (a > 0.9) az = "背面";
      else if (a > 0.1) az = px > 0 ? "左方" : "右方"; // 与输出语义一致（BSK：px>0=相机在左）
      const deg = Math.round(Math.abs(rl) * 90);
      let tilt = "";
      if (Math.abs(rl) >= 0.15) tilt = ` · 倾斜 ${deg}°`;
      else if (Math.abs(rl) >= 0.01) tilt = ` · 微倾 ${deg}°`;
      return `${az} ${azDeg(px)}° · ${el} ${elDeg(py)}° · ${dl}${tilt}`;
    }

    build() {
      const node = this.node;
      const container = document.createElement("div");
      container.className = "anima-cam-ui";
      this.rootEl = container;

      // 隐藏全部标准 widget（参数全部由下方自定义 UI 控制），避免与自定义 DOM
      // 在 0.30.x 节点 grid 布局里重叠/错位（bsk_UI 同款做法）
      for (const w of node.widgets || []) {
        if (!w || w.name === "anima_cam_ui") continue;
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

      // ── 机位预设（一行下拉框，紧凑不占位）──
      const presetWrap = document.createElement("div");
      presetWrap.className = "anima-cam-presets";
      const presetLabel = document.createElement("label");
      presetLabel.className = "anima-cam-label";
      presetLabel.textContent = "机位预设";
      const presetSelect = document.createElement("select");
      presetSelect.className = "anima-cam-preset-select";
      presetSelect.appendChild(new Option("自定义", "自定义"));
      // 预设按类分组，避免一长串难找
      const PRESET_GROUPS = [
        { label: "方位", names: ["正面", "背面", "左侧", "右侧"] },
        { label: "俯仰", names: ["正上方俯视", "俯视", "仰视", "正下方仰视"] },
        { label: "距离", names: ["特写", "近景", "中景", "全身", "远景"] },
        { label: "倾斜", names: ["荷兰角"] },
        { label: "组合", names: ["足控仰视", "角色特写", "角色中景"] },
      ];
      for (const g of PRESET_GROUPS) {
        const og = document.createElement("optgroup");
        og.label = g.label;
        for (const name of g.names) {
          if (PRESETS[name]) og.appendChild(new Option(name, name));
        }
        presetSelect.appendChild(og);
      }
      // 我的预设（用户自定义，后端持久化；加载后追加）
      const customOG = document.createElement("optgroup");
      customOG.label = "我的预设";
      presetSelect.appendChild(customOG);
      const renderCustom = () => {
        customOG.innerHTML = "";
        for (const name of Object.keys(CUSTOM_PRESETS).sort()) {
          customOG.appendChild(new Option(name, name));
        }
        if (this.presetSelect) this.presetSelect.value = this.w.preset?.value || "自定义";
      };
      presetSelect.addEventListener("change", () => this._applyPreset(presetSelect.value));
      presetWrap.appendChild(presetLabel);
      presetWrap.appendChild(presetSelect);
      container.appendChild(presetWrap);
      this.presetSelect = presetSelect;

      // ── 我的预设管理（保存当前机位 / 删除 / 导入导出，2026-08-24）──
      const mgr = document.createElement("div");
      mgr.className = "anima-cam-presets-mgr";
      const pName = document.createElement("input");
      pName.type = "text";
      pName.className = "anima-cam-presets-name";
      pName.placeholder = "预设名（保存当前机位）";
      const saveP = document.createElement("button");
      saveP.type = "button"; saveP.textContent = "存";
      saveP.title = "把当前机位（含附加 tag）保存为用户预设，预设持久化在后端，重启/换浏览器不丢";
      const delP = document.createElement("button");
      delP.type = "button"; delP.textContent = "删";
      delP.title = "删除下拉里当前选中的自定义预设";
      const expP = document.createElement("button");
      expP.type = "button"; expP.textContent = "导出";
      expP.title = "导出全部自定义预设为 JSON 备份";
      const impP = document.createElement("button");
      impP.type = "button"; impP.textContent = "导入";
      impP.title = "从 JSON 备份导入自定义预设（合并，同名覆盖）";
      const mgrHint = document.createElement("span");
      mgrHint.className = "anima-cam-presets-hint";
      mgr.append(pName, saveP, delP, expP, impP, mgrHint);
      container.appendChild(mgr);
      const hint = (t) => {
        mgrHint.textContent = t;
        setTimeout(() => { if (mgrHint.textContent === t) mgrHint.textContent = ""; }, 3500);
      };

      saveP.addEventListener("click", async () => {
        const name = (pName.value || "").trim();
        if (!name) { hint("请输入预设名"); return; }
        const px = parseFloat(this.w.px?.value ?? 0), py = parseFloat(this.w.py?.value ?? 0);
        const pz = parseFloat(this.w.pz?.value ?? 0), rl = parseFloat(this.w.roll?.value ?? 0);
        try {
          const r = await camPost("/anima/camera/presets", {
            name, pos_x: px, pos_y: py, pos_z: pz, roll: rl,
            extra: (this.w.extra_tags?.value || "").trim(),
          });
          if (r && r.ok) {
            CUSTOM_PRESETS[name] = { pos_x: px, pos_y: py, pos_z: pz, roll: rl,
                                     extra: (this.w.extra_tags?.value || "").trim() };
            renderCustom();
            pName.value = "";
            hint(`已保存预设「${name}」`);
          } else {
            hint((r && r.error) || "保存失败");
          }
        } catch (e) { hint("保存失败：" + (e.message || e)); }
      });
      delP.addEventListener("click", async () => {
        const name = presetSelect.value;
        if (!name || !CUSTOM_PRESETS[name]) { hint("当前选中的不是自定义预设"); return; }
        if (!confirm(`删除自定义预设「${name}」？`)) return;
        try {
          const r = await camPost("/anima/camera/presets/delete", { name });
          if (r && r.ok) {
            delete CUSTOM_PRESETS[name];
            renderCustom();
            this._setW(this.w.preset, "自定义");
            this._syncControls();
            hint(`已删除「${name}」`);
          } else { hint((r && r.error) || "删除失败"); }
        } catch (e) { hint("删除失败：" + (e.message || e)); }
      });
      expP.addEventListener("click", async () => {
        try {
          const r = await (await fetch("/anima/camera/presets/export")).json();
          const blob = new Blob([JSON.stringify(r, null, 1)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "anima-camera-presets-" + new Date().toISOString().slice(0, 10) + ".json";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          hint("自定义预设已导出（JSON）");
        } catch (e) { hint("导出失败：" + (e.message || e)); }
      });
      impP.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = async () => {
          const f = input.files && input.files[0];
          if (!f) return;
          try {
            const data = JSON.parse(await f.text());
            const presets = (data && data.presets && typeof data.presets === "object") ? data.presets : data;
            if (!presets || typeof presets !== "object") { hint("备份文件格式不对"); return; }
            const r = await camPost("/anima/camera/presets/import", { presets });
            if (r && r.ok) {
              await loadCustomPresets();
              renderCustom();
              hint(`已导入 ${r.count} 条预设${r.skipped_builtin ? `（跳过 ${r.skipped_builtin} 条内置同名）` : ""}`);
            } else { hint((r && r.error) || "导入失败"); }
          } catch (e) { hint("导入失败：" + (e.message || e)); }
        };
        input.click();
      });

      loadCustomPresets().then(renderCustom);

      // ── 3D 球面空间画布（BSK 坐标交互；握把法线参照；滚轮=远近）──
      const canvas = document.createElement("canvas");
      canvas.className = "anima-cam-canvas";
      canvas.width = 300;
      canvas.height = 210;
      canvas.setAttribute("aria-label", "3D 球面相机轨道：拖动画布定位相机，橙色握把显示当前机位，滚轮调节距离");
      canvas.title = "拖动画布调整空间方位；橙色握把显示当前机位；滚轮调节远近";
      this.canvas = canvas;
      bindDrag(canvas, (e) => this._canvasDrag(e));
      // 松手/取消/捕获丢失：结束拖拽状态并全量刷新（预览/scrub/预设下拉回一致）
      const finishDrag = () => this._finishDrag();
      canvas.addEventListener("pointerup", finishDrag);
      canvas.addEventListener("pointercancel", finishDrag);
      canvas.addEventListener("lostpointercapture", finishDrag);
      // 悬停反馈：靠近相机点显示十字光标（微调模式提示），其余 grab
      canvas.addEventListener("pointermove", (e) => {
        if (this._dragging) return;
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const cp = this._cameraPoint;
        const near = cp && Math.hypot(sx - cp[0], sy - cp[1]) <= CAMERA_POINT_HIT_RADIUS;
        const want = near ? "crosshair" : "grab";
        if (canvas.style.cursor !== want) canvas.style.cursor = want;
      });
      const spaceHint = document.createElement("div");
      spaceHint.className = "anima-cam-space-hint";
      this.spaceHint = spaceHint;

      // ── 拖拽方式：相对/绝对/融合（浏览器本地记忆，不写入工作流）──
      const dragModeRow = document.createElement("div");
      dragModeRow.className = "anima-cam-drag-mode";
      const dragModeLabel = document.createElement("span");
      dragModeLabel.className = "anima-cam-drag-mode-label";
      dragModeLabel.textContent = "拖拽方式";
      const dragModeButtonsWrap = document.createElement("div");
      dragModeButtonsWrap.className = "anima-cam-drag-mode-buttons";
      dragModeButtonsWrap.setAttribute("role", "group");
      dragModeButtonsWrap.setAttribute("aria-label", "相机拖拽方式");
      this.dragModeButtons = [];
      for (const [mode, meta] of Object.entries(CAMERA_DRAG_MODES)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "anima-cam-mode-btn";
        button.dataset.mode = mode;
        button.textContent = meta.label;
        button.title = meta.hint;
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => this._setDragMode(mode));
        this.dragModeButtons.push(button);
        dragModeButtonsWrap.appendChild(button);
      }
      dragModeRow.append(dragModeLabel, dragModeButtonsWrap);
      container.appendChild(dragModeRow);
      // ── 滚轮缩放（远近）──
      // ⚠️ 新前端（npm ESM）在 graph-canvas-container 内的 ph-no-capture overlay 上
      // 注册了捕获阶段 wheel 监听，对所有 wheel 事件 preventDefault + stopPropagation，
      // 事件到不了 canvas（画布滚轮缩放曾因此静默失效）。改在 document 捕获阶段抢在它
      // 前面处理：只拦截「目标是本画布或其子元素」的 wheel，其余全部放行。
      this._wheelHandler = (e) => {
        const t = e.target;
        if (!(t instanceof Element) || !this.canvas) return;
        if (t !== this.canvas && !this.canvas.contains(t)) return;
        e.preventDefault();
        e.stopPropagation();
        const pz = clamp(parseFloat(this.w.pz?.value ?? 0) - Math.sign(e.deltaY) * 0.05, -1, 1);
        this._setW(this.w.pz, Math.round(pz * 100) / 100);
        this._setW(this.w.preset, "自定义");
        this._clearNl();
        this._syncControls();
      };
      document.addEventListener("wheel", this._wheelHandler, true);
      container.appendChild(canvas);
      container.appendChild(spaceHint);
      this._setDragMode(this.dragMode);

      // ── 距离（档位）：< 中景 >（单击=一档，按住左右拖动连续调，可直输档位词/数值）──
      const distRow = document.createElement("div");
      distRow.className = "anima-cam-row";
      const distLbl = document.createElement("span");
      distLbl.className = "anima-cam-roll-label";
      distLbl.textContent = "距离";
      const distScrub = buildScrub({
        get: () => parseFloat(this.w.pz?.value ?? 0),
        set: (v) => { this._setW(this.w.pz, Math.round(v * 100) / 100); this._setW(this.w.preset, "自定义"); this._clearNl(); },
        fmt: (v) => distWord(v),
        parse: (s) => {
          const t = String(s || "").trim();
          const m = { "特写": 1, "近景": 0.5, "中景": 0, "全身": -0.5, "远景": -1 };
          if (t in m) return m[t];
          const n = parseFloat(t);
          return isNaN(n) ? null : n;
        },
        step: 0.5, min: -1, max: 1, zero: 0,
        title: "距离（远近）：单击步进一档，按住左右拖动连续调，双击归零，滚轮微调",
        onChange: () => this._syncControls(),
      });
      distRow.appendChild(distLbl);
      distRow.appendChild(distScrub);
      container.appendChild(distRow);
      this._distScrub = distScrub;

      // ── 角度（倾斜）：< 0° >（单击=9°，按住左右拖动连续调，双击归零）──
      const rollRow = document.createElement("div");
      rollRow.className = "anima-cam-row";
      const rollLbl = document.createElement("span");
      rollLbl.className = "anima-cam-roll-label";
      rollLbl.textContent = "角度";
      const rollScrub = buildScrub({
        get: () => parseFloat(this.w.roll?.value ?? 0),
        set: (v) => { this._setW(this.w.roll, Math.round(v * 100) / 100); this._setW(this.w.preset, "自定义"); this._clearNl(); },
        fmt: (v) => fmtDeg(v),
        parse: (s) => {
          const t = String(s || "").trim().replace("°", "");
          const n = parseFloat(t);
          return isNaN(n) ? null : n / 90;
        },
        step: 0.1, min: -1, max: 1, zero: 0,
        title: "角度（画面倾斜/荷兰角）：±13.5° 内不出词，越出越明显；单击步进 9°，双击归零",
        onChange: () => this._syncControls(),
      });
      rollRow.appendChild(rollLbl);
      rollRow.appendChild(rollScrub);
      container.appendChild(rollRow);
      this._rollScrub = rollScrub;

      // ── 权重控制：最大/最小权重 + 纯词模式（改 config widget 对应字段，预览即时生效）──
      const wtCfg = this._readConfig();
      const mkWeightRow = (label, key, min, max, step, cur) => {
        const row = document.createElement("div");
        row.className = "anima-cam-row";
        const lb = document.createElement("span");
        lb.className = "anima-cam-roll-label";
        lb.textContent = label;
        const scrub = buildScrub({
          get: () => parseFloat(this._readConfig()[key] ?? cur),
          set: (v) => this._writeConfig({ [key]: v }),
          fmt: (v) => String(Math.round(v * 100) / 100),
          parse: (s) => { const n = parseFloat(s); return isNaN(n) ? null : n; },
          step, min, max,
          title: label + "（按住左右拖动连续调，滚轮微调）",
          onChange: () => this._syncControls(),
        });
        row.appendChild(lb);
        row.appendChild(scrub);
        container.appendChild(row);
        if (key === "weight_max") this._wtMaxScrub = scrub;
        else this._wtMinScrub = scrub;
      };
      mkWeightRow("最大权重", "weight_max", 0.5, 10, 0.5, 10);
      mkWeightRow("最小权重", "weight_min", 0.05, 2, 0.05, 0.1);
      // 纯词模式开关（no_weight=true → 输出纯 tag 不带 (tag:weight)）
      const plainRow = document.createElement("div");
      plainRow.className = "anima-cam-row";
      const plainLbl = document.createElement("span");
      plainLbl.className = "anima-cam-roll-label";
      plainLbl.textContent = "输出";
      const plainChk = document.createElement("input");
      plainChk.type = "checkbox";
      plainChk.className = "anima-cam-wt-chk";
      plainChk.checked = !!wtCfg.no_weight;
      plainChk.title = "勾选后输出纯词（from front, medium shot），不带权重（更稳，推荐与高强度底模配合）";
      const plainTxt = document.createElement("span");
      plainTxt.className = "anima-cam-wt-hint";
      plainTxt.textContent = "纯词模式（不带权重）";
      plainChk.addEventListener("change", () => this._writeConfig({ no_weight: plainChk.checked }));
      plainRow.appendChild(plainLbl);
      plainRow.appendChild(plainChk);
      plainRow.appendChild(plainTxt);
      container.appendChild(plainRow);

      // ── 状态 + 预览 ──
      const stateEl = document.createElement("div");
      stateEl.className = "anima-cam-state";
      this.stateEl = stateEl;
      container.appendChild(stateEl);
      const previewEl = document.createElement("div");
      previewEl.className = "anima-cam-preview";
      this.previewEl = previewEl;
      container.appendChild(previewEl);

      this._syncControls();

      // 挂载：ComfyUI 官方 addDOMWidget（兼容 0.30.x；bsk/现有 LoRA 节点同款）。
      // 旧版 insertBefore 在节点创建早期 widget 元素未挂进 DOM 树时 parentNode 为
      // null 会抛 TypeError → 节点拖不进画布，故以 addDOMWidget 为主、insertBefore 兜底。
      try {
        if (typeof node.addDOMWidget === "function") {
          node.addDOMWidget("anima_cam_ui", "custom", container, { serialize: false, hideOnZoom: false });
        } else {
          const firstEl = node.widgets?.map((w) => w.element).find(Boolean);
          if (firstEl && firstEl.parentNode) firstEl.parentNode.insertBefore(container, firstEl);
          else if (node.element) node.element.prepend(container);
        }
      } catch (e) {
        console.error("[TK Camera Control] 挂载 UI 失败:", e);
      }

      // ── 高清画布：跟随容器宽度 + devicePixelRatio（修复文字/线条被拉伸模糊）──
      this._fitCanvas = () => {
        if (!this.canvas || !this.canvas.parentElement) return;
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width < 10) return; // 节点折叠/未布局时跳过
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(200, Math.round(rect.width));
        const h = Math.max(166, Math.round(w * 210 / 300));
        const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
        if (this.canvas.width !== pw || this.canvas.height !== ph) {
          this.canvas.width = pw;
          this.canvas.height = ph;
          this._dpr = dpr;
          this._syncControls();
        }
      };
      this._fitCanvas();
      if (typeof ResizeObserver === "function" && this.canvas.parentElement) {
        this._ro = new ResizeObserver(() => this._fitCanvas());
        this._ro.observe(this.canvas.parentElement);
      }
    }
  }

  function init() {
    const api = window.comfyAPI?.app?.app;
    if (!api) return setTimeout(init, 500);
    api.registerExtension({
      name: "TK.CameraControl.Widget",
      async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
          const r = orig?.apply(this, arguments);
          const w = (n) => this.widgets?.find((x) => x.name === n);
          const ui = new CameraUI(this, {
            preset: w("preset"), nl: w("nl_prompt"), px: w("pos_x"), py: w("pos_y"),
            pz: w("pos_z"), roll: w("roll"), config: w("config"), extra_tags: w("extra_tags"),
          });
          this._animaCam = ui;
          ui.build();
          return r;
        };
        // 节点移除时清理全局监听（document 级 wheel 捕获）
        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
          this._animaCam?.dispose?.();
          return origRemoved?.apply(this, arguments);
        };
      },
    });
  }

  // ── 样式 ──
  function injectStyle() {
    if (document.getElementById("anima-cam-style")) return;
    const s = document.createElement("style");
    s.id = "anima-cam-style";
    s.textContent = `
.anima-cam-ui { padding: 8px 10px; display:flex; flex-direction:column; gap:7px; border-bottom:1px solid var(--border-color, #2a2a2a); }
.anima-cam-label { font-size:11px; color:var(--fg-color, #bbb); margin-bottom:2px; letter-spacing:.3px; }
.anima-cam-presets { display:flex; flex-direction:column; gap:3px; }
.anima-cam-preset-select { width:100%; background:var(--comfy-input-bg, #1b1e26); color:var(--fg-color, #ddd); border:1px solid var(--border-color, #383d4a); border-radius:6px; font-size:11px; padding:4px 6px; cursor:pointer; }
.anima-cam-preset-select:hover { border-color:#6d5bd0; }
/* 我的预设管理行（2026-08-24） */
.anima-cam-presets-mgr { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-top:4px; }
.anima-cam-presets-name { flex:1 1 90px; min-width:0; background:var(--comfy-input-bg,#1b1e26); color:var(--fg-color,#ddd); border:1px solid var(--border-color,#383d4a); border-radius:4px; font-size:10px; padding:3px 6px; }
.anima-cam-presets-name:focus { outline:none; border-color:#8b5cf6; }
.anima-cam-presets-mgr button { font-size:10px; padding:2px 7px; background:var(--comfy-input-bg,#222); color:var(--fg-color,#bbb); border:1px solid var(--border-color,#4a4a52); border-radius:4px; cursor:pointer; flex:0 0 auto; }
.anima-cam-presets-mgr button:hover { border-color:#8b5cf6; color:#c9b8ff; }
.anima-cam-presets-hint { font-size:10px; color:#4aba8b; flex:1 1 100%; min-height:1.2em; }
.anima-cam-preset-select:focus { outline:none; border-color:#8b5cf6; }
.anima-cam-canvas { width:100%; height:auto; background:linear-gradient(180deg,#1b1e23 0%,#121417 100%); border:1px solid rgba(226,232,240,.28); border-radius:6px; cursor:grab; touch-action:none; display:block; box-shadow:inset 0 1px 7px rgba(0,0,0,.42); transition:border-color .14s ease; }
.anima-cam-canvas:hover { border-color:rgba(226,232,240,.52); }
.anima-cam-canvas:active { cursor:grabbing; }
.anima-cam-drag-mode { display:flex; align-items:center; gap:7px; min-height:24px; }
.anima-cam-drag-mode-label { color:var(--fg-color,#aeb4c0); font-size:10px; flex:0 0 auto; }
.anima-cam-drag-mode-buttons { display:flex; gap:4px; min-width:0; }
.anima-cam-mode-btn { min-width:42px; padding:3px 8px; border:1px solid #4a515d; border-radius:4px; background:#20242a; color:#cbd1da; font:inherit; font-size:10px; line-height:1.3; cursor:pointer; }
.anima-cam-mode-btn:hover { border-color:#9aa4b2; color:#f1f3f5; }
.anima-cam-mode-btn.active { background:#d7dce4; border-color:#d7dce4; color:#17191c; }
.anima-cam-mode-btn:focus-visible { outline:2px solid #f0a04b; outline-offset:1px; }
.anima-cam-space-hint { color:rgba(208,214,224,.72); font-size:10px; line-height:1.35; letter-spacing:.1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; user-select:none; }
.anima-cam-row { display:flex; align-items:center; gap:6px; }
.anima-cam-roll-label { font-size:11px; color:var(--fg-color, #999); flex:0 0 auto; min-width:40px; }
.anima-cam-track { position:relative; background:#1b1e26; border:1px solid #383d4a; border-radius:8px; touch-action:none; box-shadow:inset 0 1px 3px rgba(0,0,0,.3); }
.anima-cam-track:hover { border-color:#6d5bd0; }
.anima-cam-track.h.roll { flex:1; height:18px; cursor:ew-resize; }
.anima-cam-track.h.roll.wt { height:12px; }
.anima-cam-fill.h.roll.wt { left:0; }
.anima-cam-wt-chk { accent-color:#8b5cf6; cursor:pointer; margin:0; }
.anima-cam-wt-hint { font-size:10px; color:var(--fg-color,#999); cursor:pointer; user-select:none; }
.anima-scrub { display:flex; align-items:center; gap:4px; flex:0 0 168px; min-width:0; }
.anima-scrub-btn { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:1px solid #383d4a; border-radius:5px; background:rgba(255,255,255,0.05); color:#8A8F98; cursor:pointer; flex-shrink:0; transition:all 0.12s ease-out; }
.anima-scrub-btn:hover { background:rgba(139,92,246,0.2); color:#EDEDEF; border-color:#6d5bd0; box-shadow:0 0 0 1px rgba(139,92,246,0.2); }
.anima-scrub-btn:active { transform:scale(0.9); }
.anima-scrub-val { flex:1; min-width:0; font-size:11px; font-weight:600; text-align:center; background:transparent; color:#EDEDEF; border:none; padding:3px 0; outline:none; font-variant-numeric:tabular-nums; font-family:inherit; }
.anima-scrub-val:hover { background:rgba(255,255,255,0.05); border-radius:3px; }
.anima-scrub-val:focus { background:rgba(139,92,246,0.14); border-radius:3px; }
.anima-cam-fill { position:absolute; background:linear-gradient(90deg,#7c5cf6,#a78bfa); border-radius:6px; box-shadow:0 0 6px rgba(139,92,246,.35); }
.anima-cam-fill.h.roll { top:2px; bottom:2px; transition:left 0.06s ease-out, width 0.06s ease-out; }
.anima-cam-track.dragging .anima-cam-fill { transition:none; }
.anima-cam-canvas.dragging { cursor:grabbing; }
.anima-cam-fill.h.roll::after { content:""; position:absolute; top:50%; right:-6px; transform:translateY(-50%); width:11px; height:11px; border-radius:50%; background:#fff; border:2px solid #8b5cf6; box-shadow:0 1px 4px rgba(0,0,0,.5); }
.anima-cam-tick { position:absolute; top:3px; bottom:3px; pointer-events:none; z-index:1; }
.anima-cam-tick.center { left:50%; width:1px; background:rgba(255,255,255,.55); }
.anima-cam-tick.dead { width:1.5px; background:rgba(255,170,80,.6); }
.anima-cam-roll-val { font-size:11px; font-weight:600; color:#b9a6ff; min-width:40px; text-align:right; font-variant-numeric:tabular-nums; flex:0 0 auto; }
.anima-cam-state { font-size:12px; color:#b9a6ff; font-weight:600; letter-spacing:.3px; }
.anima-cam-preview { font-size:11px; line-height:1.45; color:var(--fg-color, #b8bcc8); background:#14161d; border:1px solid #2a2f3a; border-radius:6px; padding:6px 8px; word-break:break-all; max-height:56px; overflow:auto; }
`;
    document.head.appendChild(s);
  }

  injectStyle();
  init();
})();
