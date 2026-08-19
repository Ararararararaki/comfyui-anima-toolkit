// Anima Camera Control 节点前端 Widget
// 便捷机位控制：一键预设 + 2D 罗盘（方位）+ 俯仰/景别滑杆 + 自然语言 + 实时预览
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

  function computeCamera(px, py, pz, rl, config) {
    const cfg = loadConfig(config);
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
      const azBudget = parseFloat(cfg.azimuth.weight) * azGate;
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

  // 自然语言解析（JS 端口，与后端一致，仅用于实时预览）
  const _has = (t, keys) => keys.some((k) => t.includes(k));
  function parseNl(text, base) {
    let [px, py, pz, rl] = base || [0, 0, 0, 0];
    const t = (text || "").toLowerCase();
    if (_has(t, ["正上方", "鸟瞰", "航拍", "aerial", "directly above", "top-down", "top down", "bird's eye", "birds eye"])) py = 1.0;
    else if (_has(t, ["俯视", "俯拍", "高角度", "高角", "from above", "high angle", "looking down", "overhead"])) py = 0.5;
    else if (_has(t, ["仰视", "仰拍", "低角度", "低角", "from below", "low angle", "looking up"])) py = -0.5;
    else if (_has(t, ["正下方", "directly below", "worm's eye", "worm eye"])) py = -1.0;
    else if (_has(t, ["平视", "eye level", "eye-level", "straight-on", "straight on"])) py = 0.0;
    if (_has(t, ["大特写", "extreme close", "extreme closeup"])) pz = 1.0;
    else if (_has(t, ["特写", "close-up", "close up", "closeup"])) pz = 0.8;
    else if (_has(t, ["近景", "medium close"])) pz = 0.4;
    else if (_has(t, ["中景", "medium shot", "medium"])) pz = 0.0;
    else if (_has(t, ["全身", "full body", "full shot", "全身照"])) pz = -0.5;
    else if (_has(t, ["远景", "wide shot", "wide angle", "大远景"])) pz = -1.0;
    if (_has(t, ["背面", "背后", "身后", "背影", "from behind", "back view"])) px = 1.0;
    else if (_has(t, ["侧面", "侧拍", "侧视", "from the side", "side view", "profile"])) px = 0.5;
    else if (_has(t, ["左侧", "从左", "from the left"])) px = 0.5;
    else if (_has(t, ["右侧", "从右", "from the right"])) px = -0.5;
    else if (_has(t, ["正面", "正对", "from front", "front view"])) px = 0.0;
    if (_has(t, ["荷兰角", "倾斜", "dutch", "tilted"])) rl = 0.6;
    else if (_has(t, ["水平", "level", "straight"])) rl = 0.0;
    return [px, py, pz, rl];
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
  // 较低、更远的观察者 + 更宽视场：上、下半球都留在画布内，拖拽范围可见。
  const CAM_EYE = [3.4, 1.5, 4.8];   // 观察者（画布视角）位置
  const CAM_UP = [0, 1, 0];
  const CAM_FOV = 52 * Math.PI / 180;
  const CAMERA_POINT_HIT_RADIUS = 24;
  const FINE_DRAG_AZIMUTH_GAIN = 0.55;
  const FINE_DRAG_ELEVATION_GAIN = 0.45;
  function v3sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
  function v3cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function v3norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
  function v3dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
  function cam3DPos(r, az, el) {
    return [r*Math.cos(el)*Math.sin(az), r*Math.sin(el), r*Math.cos(el)*Math.cos(az)];
  }
  function cam3DFocal(H) { return (H / 2) / Math.tan(CAM_FOV / 2); }
  // 世界点 → 屏幕（透视投影）
  function cam3DProject(p, W, H) {
    const zc = v3norm(v3sub(CAM_EYE, [0, 0, 0]));
    const xc = v3norm(v3cross(CAM_UP, zc));
    const yc = v3cross(zc, xc);
    const pc = [v3dot(v3sub(p, CAM_EYE), xc), v3dot(v3sub(p, CAM_EYE), yc), v3dot(v3sub(p, CAM_EYE), zc)];
    if (pc[2] >= -0.1) return null;
    const f = cam3DFocal(H);
    return [W/2 + (pc[0] / -pc[2]) * f, H/2 - (pc[1] / -pc[2]) * f];
  }
  // 屏幕 → 世界射线与球面（半径 r）求交，返回交点或 null
  function cam3DRay(sx, sy, W, H, r) {
    const zc = v3norm(v3sub(CAM_EYE, [0, 0, 0]));
    const xc = v3norm(v3cross(CAM_UP, zc));
    const yc = v3cross(zc, xc);
    const f = cam3DFocal(H);
    const ndcX = (sx - W/2) / f, ndcY = (H/2 - sy) / f;
    const d = v3norm([xc[0]*ndcX + yc[0]*ndcY - zc[0], xc[1]*ndcX + yc[1]*ndcY - zc[1], xc[2]*ndcX + yc[2]*ndcY - zc[2]]);
    const b = v3dot(CAM_EYE, d);
    const c = v3dot(CAM_EYE, CAM_EYE) - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t <= 0) return null;
    return [CAM_EYE[0]+t*d[0], CAM_EYE[1]+t*d[1], CAM_EYE[2]+t*d[2]];
  }
  function cam3DDist(pz) { return 2.4 - parseFloat(pz) * 1.2; } // pz=1→1.2 特写近, pz=-1→3.6 远景

  // 机位中文词（画布标签/状态栏共用）
  function azWord(px) {
    const d = parseFloat(px) / 1;
    if (Math.abs(d) < 0.12) return "正面";
    if (Math.abs(d) > 0.88) return "背面";
    return d > 0 ? "右方" : "左方";
  }
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
      this.w = w; // {preset, nl, px, py, pz, roll, config, extra_tags}
      this.rootEl = null;
    }

    _setW(widget, value) {
      if (!widget) return;
      widget.value = value;
      if (typeof widget.callback === "function") { try { widget.callback(value); } catch (e) {} }
    }

    // 清除自然语言输入（widget 值 + 输入框文字）。手动操作（预设/画布/滑块）会显式改机位，
    // 必须同时清 NL，否则后端执行时 NL 优先级最高，用户手动调整会被 NL 覆盖（输入框还残留旧文字）
    _clearNl() {
      if (this.w.nl) this._setW(this.w.nl, "");
      if (this.nlInput) this.nlInput.value = "";
    }

    _applyPreset(name) {
      const p = PRESETS[name];
      if (!p) return;
      this._setW(this.w.px, p.pos_x);
      this._setW(this.w.py, p.pos_y);
      this._setW(this.w.pz, p.pos_z);
      this._setW(this.w.roll, p.roll);
      this._setW(this.w.preset, name);
      this._clearNl();
      this._syncControls();
    }

    _applyNl() {
      const text = (this.w.nl?.value || "").trim();
      if (!text) return;
      const [px, py, pz, rl] = parseNl(text, [0, 0, 0, 0]);
      this._setW(this.w.px, px); this._setW(this.w.py, py);
      this._setW(this.w.pz, pz); this._setW(this.w.roll, rl);
      this._setW(this.w.preset, "自定义");
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

    // 3D 画布统一相对拖拽：按下时记录机位起点，移动时在起点上叠加增量（非绝对跳转）。
    // 任一位置起拖都能连续绕到背面（方位周期化 ±1 同为背面），不再受「射线-球面只能命中可见正前方」的限制。
    // 按住相机点起拖 = 低灵敏度微调（fine）；其余位置 = 标准灵敏度（横向拖满画布宽≈180°，纵向拖满高≈90°）。
    _canvasDrag(e) {
      if (!this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      if (e.type === "pointerdown") {
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const cp = this._cameraPoint;
        const isFine = cp && Math.hypot(sx - cp[0], sy - cp[1]) <= CAMERA_POINT_HIT_RADIUS;
        this._dragMode = isFine ? "fine" : "normal";
        this._dragStart = {
          x: e.clientX, y: e.clientY,
          px: parseFloat(this.w.px?.value ?? 0), py: parseFloat(this.w.py?.value ?? 0),
        };
        this._setW(this.w.preset, "自定义");
        this._clearNl();
        return;
      }
      const st = this._dragStart;
      if (!st) return;
      const azGain = this._dragMode === "fine" ? FINE_DRAG_AZIMUTH_GAIN : 1.0; // 满宽≈180°
      const elGain = this._dragMode === "fine" ? FINE_DRAG_ELEVATION_GAIN : 1.0; // 满高≈90°
      const px = ((st.px + (e.clientX - st.x) / rect.width * azGain + 1) % 2 + 2) % 2 - 1;
      const py = clamp(st.py - (e.clientY - st.y) / rect.height * elGain, -1, 1);
      this._setW(this.w.px, Math.round(px * 100) / 100);
      this._setW(this.w.py, Math.round(py * 100) / 100);
      this._setW(this.w.preset, "自定义");
      this._clearNl();
      this._syncControls();
    }

    // 3D 场景渲染：地面网格 + 相机轨道 + 目标人形 + 相机点/视线/取景框 + 状态标签
    _draw3D(px, py, pz, rl) {
      const cv = this.canvas;
      const ctx = cv.getContext("2d");
      // dpr 感知：物理像素绘制，scale 回逻辑坐标 → 高 DPI/拉伸下文字线条不糊
      const dpr = this._dpr || 1;
      const W = cv.width / dpr, H = cv.height / dpr;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);
      const az = parseFloat(px) * Math.PI, el = parseFloat(py) * Math.PI / 2;
      // 显示半径固定：轨道环/相机点/拖拽球面三者一致（所见=可控范围）。
      // 距离（pz）只通过取景框大小表达远近，3D 场景不缩放，拖拽永远可控。
      const r = 2.4;
      const cam = cam3DPos(r, az, el);

      // 地面网格（y=0 平面，营造空间感）
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let gx = -3; gx <= 3; gx++) {
        const a = cam3DProject([gx, 0, -3], W, H), b = cam3DProject([gx, 0, 3], W, H);
        if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
      }
      for (let gz = -3; gz <= 3; gz++) {
        const a = cam3DProject([-3, 0, gz], W, H), b = cam3DProject([3, 0, gz], W, H);
        if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
      }

      // 相机轨道：赤道环 + 当前方位垂直半环
      ctx.strokeStyle = "rgba(139,92,246,0.25)";
      ctx.lineWidth = 1.2;
      for (let i = 0; i <= 60; i++) {
        const a0 = (i / 60) * Math.PI * 2, a1 = ((i + 1) / 60) * Math.PI * 2;
        const p0 = cam3DProject([r * Math.cos(a0), 0, r * Math.sin(a0)], W, H);
        const p1 = cam3DProject([r * Math.cos(a1), 0, r * Math.sin(a1)], W, H);
        if (p0 && p1) { ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke(); }
      }
      ctx.strokeStyle = "rgba(139,92,246,0.18)";
      for (let i = -30; i <= 30; i++) {
        const e0 = (i / 30) * Math.PI / 2, e1 = ((i + 1) / 30) * Math.PI / 2;
        const p0 = cam3DProject(cam3DPos(r, az, e0), W, H);
        const p1 = cam3DProject(cam3DPos(r, az, e1), W, H);
        if (p0 && p1) { ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke(); }
      }

      // 目标：简笔人形（面向 +z）
      const head = cam3DProject([0, 1.15, 0], W, H);
      const bodyT = cam3DProject([0, 0.75, 0], W, H);
      const bodyB = cam3DProject([0, 0.15, 0], W, H);
      const face = cam3DProject([0, 1.15, 0.22], W, H);
      if (head && bodyT && bodyB) {
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(head[0], head[1], 5.5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bodyT[0], bodyT[1]); ctx.lineTo(bodyB[0], bodyB[1]); ctx.stroke();
        if (face) {
          ctx.strokeStyle = "rgba(255,255,255,0.4)";
          ctx.beginPath(); ctx.moveTo(head[0], head[1]); ctx.lineTo(face[0], face[1]); ctx.stroke();
        }
      }

      // 相机点 + 视线虚线 + 朝向三角
      const cp = cam3DProject(cam, W, H);
      this._cameraPoint = cp;
      if (cp) {
        ctx.strokeStyle = "rgba(255,165,0,0.55)";
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(cp[0], cp[1]); ctx.lineTo(W / 2, H / 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(cp[0], cp[1], 6, 0, Math.PI * 2);
        ctx.fillStyle = "#ff9f43"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4; ctx.stroke();
        const ang = Math.atan2(H / 2 - cp[1], W / 2 - cp[0]);
        ctx.fillStyle = "#ff9f43";
        ctx.beginPath();
        ctx.moveTo(cp[0] + 9 * Math.cos(ang), cp[1] + 9 * Math.sin(ang));
        ctx.lineTo(cp[0] + 3 * Math.cos(ang + 2.4), cp[1] + 3 * Math.sin(ang + 2.4));
        ctx.lineTo(cp[0] + 3 * Math.cos(ang - 2.4), cp[1] + 3 * Math.sin(ang - 2.4));
        ctx.closePath(); ctx.fill();
      }

      // 取景框：相机"画面"矩形，roll 绕视线旋转 → 一拖滑块就能看到画面倾斜（荷兰角）
      {
        const rot = parseFloat(rl ?? 0) * Math.PI / 2;
        const look = v3norm(v3sub([0, 0, 0], cam));       // 视线方向（指向目标）
        let right = v3cross(look, CAM_UP);                 // 相机右方向
        if (Math.hypot(right[0], right[1], right[2]) < 1e-6) right = [1, 0, 0]; // 正上/正下时退化兜底
        right = v3norm(right);
        const up2 = v3cross(right, look);                  // 相机上方向（垂直视线）
        const cr = Math.cos(rot), sr = Math.sin(rot);      // 绕视线旋转 roll
        const r2 = [right[0] * cr + up2[0] * sr, right[1] * cr + up2[1] * sr, right[2] * cr + up2[2] * sr];
        const u2 = [right[0] * -sr + up2[0] * cr, right[1] * -sr + up2[1] * cr, right[2] * -sr + up2[2] * cr];
        // 取景框大小表达距离：特写(近)小、远景(大)，与距离滑块一一对应
        const distScale = 1.6 - clamp(parseFloat(pz) || 0, -1, 1) * 0.6;
        const hw = r * 0.16 * distScale, hh = r * 0.11 * distScale;
        const cs = [
          [cam[0] + r2[0] * hw + u2[0] * hh, cam[1] + r2[1] * hw + u2[1] * hh, cam[2] + r2[2] * hw + u2[2] * hh],
          [cam[0] - r2[0] * hw + u2[0] * hh, cam[1] - r2[1] * hw + u2[1] * hh, cam[2] - r2[2] * hw + u2[2] * hh],
          [cam[0] - r2[0] * hw - u2[0] * hh, cam[1] - r2[1] * hw - u2[1] * hh, cam[2] - r2[2] * hw - u2[2] * hh],
          [cam[0] + r2[0] * hw - u2[0] * hh, cam[1] + r2[1] * hw - u2[1] * hh, cam[2] + r2[2] * hw - u2[2] * hh],
        ].map((p) => cam3DProject(p, W, H));
        if (cs.every(Boolean)) {
          ctx.fillStyle = "rgba(255,165,0,0.14)";
          ctx.strokeStyle = "rgba(255,190,90,0.85)";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(cs[0][0], cs[0][1]);
          for (let i = 1; i < 4; i++) ctx.lineTo(cs[i][0], cs[i][1]);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
          // 底边加粗：画面"地面"边，倾斜方向一眼可辨
          ctx.strokeStyle = "rgba(255,165,0,0.95)";
          ctx.lineWidth = 2.4;
          ctx.beginPath(); ctx.moveTo(cs[2][0], cs[2][1]); ctx.lineTo(cs[3][0], cs[3][1]); ctx.stroke();
        }
      }

      // 状态标签（左上角）+ 前后轴标签
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.font = "10px system-ui";
      ctx.fillText("方位 " + azWord(px), 6, 13);
      ctx.fillText("俯仰 " + elWord(py), 6, 25);
      ctx.fillText("距离 " + distWord(pz), 6, 37);
      ctx.fillText("角度 " + fmtDeg(rl), 6, 49);
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      const fr = cam3DProject([0, 0, 2.4], W, H), bk = cam3DProject([0, 0, -2.4], W, H);
      if (fr) ctx.fillText("前", fr[0] + 4, fr[1]);
      if (bk) ctx.fillText("后", bk[0] - 12, bk[1]);
      ctx.restore();
    }

    _updatePreview(px, py, pz, rl) {
      const config = this.w.config?.value || "";
      const extra = (this.w.extra_tags?.value || "").trim();
      let prompt = computeCamera(px, py, pz, rl, config);
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
      else if (a > 0.1) az = px > 0 ? "右方" : "左方";
      const deg = Math.round(Math.abs(rl) * 90);
      let tilt = "";
      if (Math.abs(rl) >= 0.15) tilt = ` · 倾斜 ${deg}°`;
      else if (Math.abs(rl) >= 0.01) tilt = ` · 微倾 ${deg}°`;
      return `${az} · ${el} · ${dl}${tilt}`;
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
      presetSelect.addEventListener("change", () => this._applyPreset(presetSelect.value));
      presetWrap.appendChild(presetLabel);
      presetWrap.appendChild(presetSelect);
      container.appendChild(presetWrap);
      this.presetSelect = presetSelect;

      // ── 3D 空间画布（拖相机点微调，其余位置直接定位；滚轮=远近）──
      const canvas = document.createElement("canvas");
      canvas.className = "anima-cam-canvas";
      canvas.width = 250;
      canvas.height = 170;
      canvas.title = "拖相机点微调；从其他位置拖动可直接定位机位；滚轮调节远近";
      this.canvas = canvas;
      bindDrag(canvas, (e) => this._canvasDrag(e));
      const clearCanvasDrag = () => { this._dragMode = null; this._dragStart = null; };
      canvas.addEventListener("pointerup", clearCanvasDrag);
      canvas.addEventListener("pointercancel", clearCanvasDrag);
      canvas.addEventListener("lostpointercapture", clearCanvasDrag);
      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const pz = clamp(parseFloat(this.w.pz?.value ?? 0) - Math.sign(e.deltaY) * 0.05, -1, 1);
        this._setW(this.w.pz, Math.round(pz * 100) / 100);
        this._setW(this.w.preset, "自定义");
        this._clearNl();
        this._syncControls();
      }, { passive: false });
      container.appendChild(canvas);

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

      // ── 自然语言输入框（标准 widget 已隐藏，这里提供入口）──
      const nlRow = document.createElement("div");
      nlRow.className = "anima-cam-row";
      const nlLbl = document.createElement("span");
      nlLbl.className = "anima-cam-roll-label";
      nlLbl.textContent = "自然语言";
      const nlInput = document.createElement("input");
      nlInput.className = "anima-cam-nl";
      nlInput.type = "text";
      nlInput.placeholder = "如：俯视 近景 / 从背后 全身";
      nlInput.value = this.w.nl?.value || "";
      nlRow.appendChild(nlLbl);
      nlRow.appendChild(nlInput);
      container.appendChild(nlRow);
      this.nlInput = nlInput;
      nlInput.addEventListener("input", () => {
        this._setW(this.w.nl, nlInput.value);
        if (nlInput.value && nlInput.value.trim()) {
          const [px, py, pz, rl] = parseNl(nlInput.value, [0, 0, 0, 0]);
          this._draw3D(px, py, pz, rl);
          this._updatePreview(px, py, pz, rl);
          this.stateEl.textContent = this._describe(px, py, pz, rl) + "（自然语言识别）";
        } else {
          this._syncControls();
        }
      });

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
        const h = Math.max(136, Math.round(w * 170 / 250));
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
.anima-cam-preset-select:focus { outline:none; border-color:#8b5cf6; }
.anima-cam-canvas { width:100%; height:auto; background:linear-gradient(180deg,#171a22 0%,#0e1014 100%); border:1px solid var(--border-color, #2f3440); border-radius:10px; cursor:grab; touch-action:none; display:block; box-shadow:inset 0 1px 6px rgba(0,0,0,.35); }
.anima-cam-canvas:active { cursor:grabbing; }
.anima-cam-row { display:flex; align-items:center; gap:6px; }
.anima-cam-roll-label { font-size:11px; color:var(--fg-color, #999); flex:0 0 auto; min-width:40px; }
.anima-cam-nl { flex:1; min-width:0; background:var(--comfy-input-bg, #1b1e26); color:var(--fg-color, #ddd); border:1px solid var(--border-color, #383d4a); border-radius:6px; font-size:11px; padding:4px 8px; }
.anima-cam-nl:focus { outline:none; border-color:#8b5cf6; }
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
