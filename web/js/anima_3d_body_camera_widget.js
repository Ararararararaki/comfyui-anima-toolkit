import { installDOMWidgetSizeSync } from "./anima_dom_widget_size_sync.js";

// TK 可动素体相机：程序化低模 + 关节 FK + 轻量相机预览。
// 旧 TK Camera Control 使用自己的前端；这里不替换、不共享 UI 状态。
(function () {
  const NODE_NAME = "TK 3D Body Camera";
  const JOINTS = [
    ["root", "根部"], ["waist", "腰部"], ["chest", "胸腔"], ["neck", "颈部"], ["head", "头部"],
    ["left_shoulder", "左肩"], ["left_elbow", "左肘"],
    ["right_shoulder", "右肩"], ["right_elbow", "右肘"],
    ["left_hip", "左髋"], ["left_knee", "左膝"],
    ["right_hip", "右髋"], ["right_knee", "右膝"],
  ];
  const JOINT_NAMES = new Set(JOINTS.map(([name]) => name));
  const JOINT_LIMITS = { root: 45, waist: 65, chest: 70, neck: 80, head: 90 };
  const CAMERA_DISTANCE_BASE = 5.0;
  const CAMERA_DISTANCE_RANGE = 3.4;
  const CAMERA_PRESETS = {
    "正面": [0, 0, 0, 0], "背面": [1, 0, 0, 0], "左侧": [0.5, 0, 0, 0], "右侧": [-0.5, 0, 0, 0],
    "正上方俯视": [0, 1, 0, 0], "俯视": [0, 0.5, 0, 0], "仰视": [0, -0.5, 0, 0], "正下方仰视": [0, -1, 0, 0],
    "特写": [0, 0, 1, 0], "近景": [0, 0, 0.5, 0], "中景": [0, 0, 0, 0], "全身": [0, 0, -0.5, 0], "远景": [0, 0, -1, 0],
    "荷兰角": [0, 0, 0, 0.6],
  };
  const THREE_SOURCES = [
    // ComfyUI 的扩展静态路由会把 web 目录映射到扩展根路径；当前安装中的
    // Comfyui-Anima_camera_angle/js/three.module.js 对外地址是下面这一条。
    "/extensions/Comfyui-Anima_camera_angle/three.module.js",
    "/extensions/ComfyUI-Anima_camera_angle/three.module.js",
  ];
  const POSE_SLOT_KEY = "tk-pose-camera-slots-v1";
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // 这四个字段对应相机提示词的四个方位轴：左右、上下、距离和倾斜角。
  // 轴权重只控制强度，具体输出哪个 tag 仍由相机当前位置决定。
  const PROMPT_WEIGHT_FIELDS = [
    { id: "azimuth.weight", group: "方位权重", label: "左右方位", path: ["azimuth"], default: 10, min: 0, max: 10 },
    { id: "elevation.weight", group: "方位权重", label: "上下方位", path: ["elevation"], default: 11, min: 0, max: 20 },
    { id: "distance.weight", group: "方位权重", label: "距离方位", path: ["distance"], default: 1, min: 0, max: 10 },
    { id: "tilt.weight", group: "方位权重", label: "倾斜角", path: ["tilt"], default: 1, min: 0, max: 10 },
  ];
  const PROMPT_WEIGHT_BY_ID = Object.fromEntries(PROMPT_WEIGHT_FIELDS.map((field) => [field.id, field]));

  function readPromptConfig(raw) {
    let config = {};
    try { config = JSON.parse(raw || "{}"); } catch {}
    if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
    // 丢弃此前测试版的逐方向/逐景别权重，统一回到 BSK 的轴权重。
    for (const key of ["front", "back", "left", "right"]) delete config.azimuth?.directions?.[key]?.weight;
    for (const key of ["bird", "high", "eye", "low", "worm"]) delete config.elevation?.categories?.[key]?.weight;
    for (const key of ["ecu", "cu", "medium", "full", "wide"]) delete config.distance?.categories?.[key]?.weight;
    config.azimuth = config.azimuth || {};
    config.elevation = config.elevation || {};
    config.distance = config.distance || {};
    config.tilt = config.tilt || {};
    if (!Number.isFinite(Number(config.azimuth.weight))) config.azimuth.weight = 10;
    if (!Number.isFinite(Number(config.elevation.weight))) config.elevation.weight = 11;
    if (!Number.isFinite(Number(config.distance.weight))) config.distance.weight = 1;
    // 新素体节点沿用 BSK 的五档区间，并让距离滑块在档内连续影响权重。
    config.distance.follow_slider = true;
    if (!Number.isFinite(Number(config.tilt.weight))) config.tilt.weight = 1;
    return config;
  }

  function readNestedWeight(config, field) {
    let value = config;
    for (const key of field.path) value = value?.[key];
    const raw = value && typeof value === "object" ? value.weight : undefined;
    return clamp(finite(raw, field.default), field.min, field.max);
  }

  function writeNestedWeight(config, field, value) {
    let target = config;
    for (const key of field.path) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) target[key] = {};
      target = target[key];
    }
    target.weight = Math.round(clamp(value, field.min, field.max) * 10) / 10;
  }

  const promptFmtWeight = (value) => (Math.round(Number(value) * 100) / 100).toFixed(2);
  const promptSplitTags = (value) => String(value || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  const promptElevationKey = (value) => value > 0.7 ? "bird" : value > 0.2 ? "high" : value >= -0.2 ? "eye" : value >= -0.7 ? "low" : "worm";
  const promptDistanceKey = (value) => value > 0.7 ? "ecu" : value > 0.2 ? "cu" : value >= -0.2 ? "medium" : value >= -0.7 ? "full" : "wide";
  const DISTANCE_RANGES = { ecu: [0.7, 1], cu: [0.2, 0.7], medium: [-0.2, 0.2], full: [-0.7, -0.2], wide: [-1, -0.7] };
  const DISTANCE_FAR_STRONGER = new Set(["medium", "full", "wide"]);
  const DISTANCE_LABELS = { wide: "远景", medium: "中景", cu: "近景", full: "全身", ecu: "特写" };

  function promptDistanceDetails(config, value) {
    const z = finite(value);
    const key = promptDistanceKey(z);
    const [start, end] = DISTANCE_RANGES[key];
    const fraction = DISTANCE_FAR_STRONGER.has(key)
      ? clamp((end - z) / (end - start), 0, 1)
      : clamp((z - start) / (end - start), 0, 1);
    const distance = config.distance || {};
    const categories = distance.categories || {};
    const category = categories[key] || {};
    const baseWeight = Object.prototype.hasOwnProperty.call(distance, "weight")
      ? finite(distance.weight, 1)
      : Object.prototype.hasOwnProperty.call(category, "weight") ? finite(category.weight, 1) : 1;
    const extraMaster = finite(config.extra_master, 1);
    const extra = finite(distance.extra, 0);
    let weight = baseWeight + fraction * extraMaster * extra;
    if (distance.follow_slider) {
      // 保留 BSK 的远近方向：每一档内部随滑块线性变化，手动权重是该档中点值。
      const variation = Math.abs(extraMaster * extra) || Math.max(0.5, Math.abs(baseWeight) * 0.5);
      weight = baseWeight + (fraction - 0.5) * variation;
    }
    return {
      key,
      label: DISTANCE_LABELS[key],
      fraction,
      weight: clamp(weight, finite(config.weight_min, 0.1), finite(config.weight_max, 10)),
    };
  }

  function promptWeighted(tag, weight) {
    return promptSplitTags(tag).map((item) => `(${item}:${promptFmtWeight(weight)})`);
  }

  // 仅用于界面预览，计算顺序和权重含义与 CameraControlCore 保持一致；
  // 真正执行时仍由 Python 后端再次计算，不以浏览器预览作为最终输出来源。
  function buildPromptPreview(px, py, pz, roll, config) {
    const parts = [];
    const wmin = finite(config.weight_min, 0.1);
    const wmax = finite(config.weight_max, 5);
    const deadzone = finite(config.azimuth?.deadzone_ratio, 0.2);
    const clampWeight = (weight) => clamp(weight, wmin, wmax);
    const emitPlain = (tag) => promptSplitTags(tag);
    if (config.no_weight) {
      const angle = px * Math.PI;
      const ratios = { front: Math.max(0, Math.cos(angle)), back: Math.max(0, -Math.cos(angle)), right: Math.max(0, Math.sin(angle)), left: Math.max(0, -Math.sin(angle)) };
      const sum = Object.values(ratios).reduce((a, b) => a + b, 0);
      if (sum) Object.keys(ratios).forEach((key) => { ratios[key] /= sum; });
      const gate = clamp((1 - Math.abs(py)) / 0.1, 0, 1);
      let dominant = null;
      if (gate > 0) dominant = Object.keys(ratios).sort((a, b) => ratios[b] - ratios[a])[0];
      if (dominant) parts.push(...emitPlain(config.azimuth?.directions?.[dominant]?.tag));
      const elevation = config.elevation?.categories?.[promptElevationKey(py)];
      if (Math.abs(py) > 0.2 && elevation?.enabled !== false) parts.push(...emitPlain(elevation.tag));
      const distance = config.distance?.categories?.[promptDistanceKey(pz)];
      if (promptDistanceKey(pz) !== "medium" && distance?.enabled !== false) parts.push(...emitPlain(distance?.tag));
      if (config.tilt?.enabled !== false && Math.abs(roll) >= finite(config.tilt?.deadzone, 0.15)) parts.push(...emitPlain(config.tilt?.dutch_tag));
      return parts.length ? `${parts.join(", ")},` : "";
    }
    if (config.azimuth?.enabled !== false) {
      const angle = px * Math.PI;
      const ratios = { front: Math.max(0, Math.cos(angle)), back: Math.max(0, -Math.cos(angle)), right: Math.max(0, Math.sin(angle)), left: Math.max(0, -Math.sin(angle)) };
      const sum = Object.values(ratios).reduce((a, b) => a + b, 0);
      if (sum) Object.keys(ratios).forEach((key) => { ratios[key] /= sum; });
      const gate = clamp((1 - Math.abs(py)) / 0.1, 0, 1);
      for (const [name, ratio] of Object.entries(ratios)) {
        const item = config.azimuth?.directions?.[name];
        if (item?.enabled === false || ratio <= 0) continue;
        const weight = finite(config.azimuth?.weight, 10) * ratio * gate;
        if (weight >= deadzone) parts.push(...promptWeighted(item?.tag, clampWeight(weight)));
      }
    }
    if (config.elevation?.enabled !== false) {
      const item = config.elevation?.categories?.[promptElevationKey(py)];
      if (item?.tag && item.enabled !== false) {
        const weight = Math.abs(py) * (Object.prototype.hasOwnProperty.call(config.elevation || {}, "weight") ? finite(config.elevation.weight, 11) : 1 + finite(config.extra_master, 1) * finite(config.elevation?.extra, 0));
        if (weight >= deadzone) parts.push(...promptWeighted(item.tag, clampWeight(weight)));
      }
    }
    if (config.distance?.enabled !== false) {
      const details = promptDistanceDetails(config, pz); const key = details.key; const item = config.distance?.categories?.[key];
      if (item?.tag && item.enabled !== false) {
        parts.push(...promptWeighted(item.tag, clampWeight(details.weight)));
      }
    }
    if (config.tilt?.enabled !== false && Math.abs(roll) >= finite(config.tilt?.deadzone, 0.15)) parts.push(...promptWeighted(config.tilt?.dutch_tag, clampWeight(Object.prototype.hasOwnProperty.call(config.tilt || {}, "weight") ? finite(config.tilt.weight, 1) : 1 + finite(config.extra_master, 1) * finite(config.tilt?.extra, 0))));
    return parts.length ? `${parts.join(", ")},` : "";
  }

  function makePose(armAngle = 28) {
    const pose = {};
    JOINTS.forEach(([name]) => { pose[name] = { x: 0, y: 0, z: 0 }; });
    pose.left_shoulder.z = -armAngle;
    pose.right_shoulder.z = armAngle;
    return pose;
  }

  function normalizePose(raw) {
    let source = raw;
    if (typeof source === "string") {
      try { source = JSON.parse(source || "{}"); } catch { source = {}; }
    }
    if (!source || typeof source !== "object" || Array.isArray(source)) source = {};
    const result = {};
    JOINTS.forEach(([name]) => {
      const item = source[name] && typeof source[name] === "object" ? source[name] : {};
      const limit = JOINT_LIMITS[name] || 180;
      result[name] = {
        x: clamp(finite(item.x, 0), -limit, limit),
        y: clamp(finite(item.y, 0), -limit, limit),
        z: clamp(finite(item.z, 0), -limit, limit),
      };
    });
    return result;
  }

  function clonePose(pose) { return JSON.parse(JSON.stringify(normalizePose(pose))); }

  async function loadThree() {
    let lastError = null;
    for (const source of THREE_SOURCES) {
      try { return await import(new URL(source, window.location.href).href); } catch (error) { lastError = error; }
    }
    throw lastError || new Error("当前 ComfyUI 未提供项目内 Three.js");
  }

  function readSlots() {
    try {
      const value = JSON.parse(window.localStorage.getItem(POSE_SLOT_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch { return {}; }
  }

  class BodyCameraUI {
    constructor(node) {
      this.node = node;
      this.widgets = Object.fromEntries((node.widgets || []).map((widget) => [widget.name, widget]));
      this.state = {
        posePreset: this.widgets.pose_preset?.value || "A-Pose",
        pose: normalizePose(this.widgets.pose?.value || makePose()),
        preset: this.widgets.preset?.value || "自定义",
        px: finite(this.widgets.pos_x?.value), py: finite(this.widgets.pos_y?.value),
        pz: finite(this.widgets.pos_z?.value), roll: finite(this.widgets.roll?.value),
        fov: clamp(finite(this.widgets.fov?.value, 50), 20, 100),
      };
      this.selectedJoint = "left_shoulder";
      this.THREE = null;
      this.scene = null;
      this.displayCamera = null;
      this.renderer = null;
      this.modelRoot = null;
      this.jointMap = new Map();
      this.jointPickers = [];
      this.cameraRay = null;
      this.frame = 0;
      this.disposed = false;
      this.interaction = null;
      this.slots = readSlots();
    }

    build() {
      const root = document.createElement("section");
      root.className = "tk-3d-body-camera-ui";
      root.innerHTML = `
        <header class="tk-3d-body-camera-head"><strong>可动素体相机</strong><span data-status>正在加载本地 3D 引擎…</span></header>
        <div class="tk-3d-body-camera-viewport" data-viewport><canvas class="tk-3d-body-camera-canvas" data-canvas aria-label="拖拽模型旋转相机，点击关节后拖拽可摆姿势"></canvas><div class="tk-3d-body-camera-overlay"><span data-orientation>正面 · 平视</span><span data-selection>相机模式 · 滚轮调整距离</span></div></div>
        <div class="tk-3d-body-camera-toolbar"><span>视角</span><button type="button" data-quick="front">正面</button><button type="button" data-quick="side">侧面</button><button type="button" data-quick="back">背面</button><button type="button" data-quick="up">俯视</button><button type="button" data-quick="down">仰视</button><select data-camera-preset aria-label="机位预设"><option value="自定义">自定义</option>${Object.keys(CAMERA_PRESETS).map((name) => `<option value="${esc(name)}">${esc(name === "荷兰角" ? "倾斜角" : name)}</option>`).join("")}</select></div>
         <div class="tk-3d-body-camera-section tk-3d-body-camera-camera-section"><div class="tk-3d-body-camera-section-title"><strong>相机参数</strong><span data-camera-readout>实时更新</span></div><div class="tk-3d-body-camera-readouts" aria-live="polite"><span>Yaw <output data-camera-live="yaw">0°</output></span><span>Pitch <output data-camera-live="pitch">0°</output></span><span>Roll <output data-camera-live="roll">0°</output></span><span>距离 <output data-camera-live="distance">5.00</output></span><span>FOV <output data-camera-live="fov">50°</output></span></div><label class="tk-3d-body-camera-range"><span>距离</span><input data-camera="pz" type="range" min="-1" max="1" step="0.01"><output data-camera-output="pz"></output></label><div class="tk-3d-body-camera-distance-categories" aria-label="距离五档"><span data-distance-category="wide">远景</span><span data-distance-category="full">全身</span><span data-distance-category="medium">中景</span><span data-distance-category="cu">近景</span><span data-distance-category="ecu">特写</span></div><label class="tk-3d-body-camera-range"><span>倾斜角</span><input data-camera="roll" type="range" min="-1" max="1" step="0.01"><output data-camera-output="roll"></output></label><label class="tk-3d-body-camera-range"><span>FOV</span><input data-camera="fov" type="range" min="20" max="100" step="1"><output data-camera-output="fov"></output></label><div class="tk-3d-body-camera-normalized">坐标 X <output data-camera-live="x">0.00</output> · Y <output data-camera-live="y">0.00</output> · Z <output data-camera-live="z">0.00</output></div></div>
        <div class="tk-3d-body-camera-section tk-3d-body-camera-prompt-section"><div class="tk-3d-body-camera-section-title"><strong>提示词参数</strong><span data-prompt-active>方位权重</span></div><div class="tk-3d-body-camera-prompt-weight-groups" data-prompt-weights></div><div class="tk-3d-body-camera-prompt-preview"><span>当前输出</span><code data-prompt-preview>正在计算…</code></div></div>
        <div class="tk-3d-body-camera-section tk-3d-body-camera-pose-section"><div class="tk-3d-body-camera-section-title"><strong>摆姿势</strong><span>点击关节后在模型上拖拽，或编辑 XYZ</span></div><div class="tk-3d-body-camera-pose-actions"><button type="button" data-pose="a">A-Pose</button><button type="button" data-pose="t">T-Pose</button><button type="button" data-pose="reset">重置</button><select data-joint aria-label="选择关节"></select></div><div class="tk-3d-body-camera-axis-grid"><label>X<input data-axis="x" type="range" min="-180" max="180" step="1"><output data-axis-output="x">0°</output></label><label>Y<input data-axis="y" type="range" min="-180" max="180" step="1"><output data-axis-output="y">0°</output></label><label>Z<input data-axis="z" type="range" min="-180" max="180" step="1"><output data-axis-output="z">0°</output></label></div></div>
        <div class="tk-3d-body-camera-save-row"><input data-pose-name value="姿势1" aria-label="姿势名称"><button type="button" data-pose-action="save">保存</button><select data-pose-slot aria-label="已保存姿势"><option value="">选择已保存姿势</option></select><button type="button" data-pose-action="restore">恢复</button><button type="button" data-pose-action="delete">删除</button></div>
        <div class="tk-3d-body-camera-hint" data-hint>模型是无纹理低面数空壳；相机本体不显示，只显示少量视线与地面辅助线。</div>`;
      this.root = root;
      this.viewport = root.querySelector("[data-viewport]");
      this.canvas = root.querySelector("[data-canvas]");
      this.status = root.querySelector("[data-status]");
      this.orientation = root.querySelector("[data-orientation]");
      this.selection = root.querySelector("[data-selection]");
      this.cameraReadout = root.querySelector("[data-camera-readout]");
      this.jointSelect = root.querySelector("[data-joint]");
      this._buildJointSelect();
      this._buildPromptWeights();
      this._renderSlots();
      this._bindInteractions();
      this._hideRawWidgets();
      this._syncControls();
      return root;
    }

    mount(domWidget) {
      this.domWidget = domWidget;
      this.sizeSync = installDOMWidgetSizeSync({ node: this.node, domWidget, element: this.root, minHeight: 520, maxHeight: 1400, initialContentHeight: 860 });
      // ComfyUI 新版的 widget 网格可能为已隐藏原生输入保留隐式行；让
      // 自定义 DOM widget 跨过这些行，否则节点顶部会出现空白且尺寸会被撑大。
      this._fixWidgetLayout();
      this.layoutFrame = requestAnimationFrame(() => this._fixWidgetLayout());
      this.resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => this._resize()) : null;
      this.resizeObserver?.observe(this.viewport);
      this._loadThree();
    }

    _readPromptConfig() {
      return readPromptConfig(this.widgets.config?.value || "{}");
    }

    _buildPromptWeights() {
      const host = this.root.querySelector("[data-prompt-weights]");
      const groups = new Map();
      PROMPT_WEIGHT_FIELDS.forEach((field) => {
        let group = groups.get(field.group);
        if (!group) {
          group = document.createElement("div");
          group.className = "tk-3d-body-camera-prompt-group";
          group.innerHTML = `<strong>${esc(field.group)}</strong><div class="tk-3d-body-camera-prompt-grid"></div>`;
          groups.set(field.group, group);
          host.appendChild(group);
        }
        const grid = group.querySelector(".tk-3d-body-camera-prompt-grid");
        const row = document.createElement("label");
        row.className = "tk-3d-body-camera-prompt-weight";
        row.title = `${field.label}：可拖动滑块，也可直接输入；步进 0.1`;
        row.innerHTML = `<span>${esc(field.label)}</span><input data-prompt-weight="${field.id}" type="range" min="${field.min}" max="${field.max}" step="0.1"><input class="tk-3d-body-camera-prompt-weight-number" data-prompt-weight-number="${field.id}" type="number" min="${field.min}" max="${field.max}" step="0.1" inputmode="decimal" aria-label="${esc(field.label)}权重"><em>权重</em>`;
        const range = row.querySelector("[data-prompt-weight]");
        const number = row.querySelector("[data-prompt-weight-number]");
        const commit = (value) => {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) return this._syncPromptControls(this._readPromptConfig());
          this._setPromptWeight(field, parsed);
        };
        range.addEventListener("input", () => commit(range.value));
        number.addEventListener("change", () => commit(number.value));
        number.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commit(number.value); number.blur(); } });
        grid.appendChild(row);
      });
    }

    _setPromptWeight(field, value) {
      const config = this._readPromptConfig();
      writeNestedWeight(config, field, value);
      this._setWidget("config", JSON.stringify(config));
      this._syncControls();
    }

    _syncPromptControls(config) {
      PROMPT_WEIGHT_FIELDS.forEach((field) => {
        const value = readNestedWeight(config, field);
        const range = this.root.querySelector(`[data-prompt-weight="${field.id}"]`);
        const number = this.root.querySelector(`[data-prompt-weight-number="${field.id}"]`);
        if (range) range.value = value;
        if (number) number.value = promptFmtWeight(value);
      });
      const azName = Math.abs(this.state.px) > 0.72 ? "背面" : Math.abs(this.state.px) > 0.22 ? (this.state.px > 0 ? "左侧" : "右侧") : "正面";
      const distanceDetails = promptDistanceDetails(config, this.state.pz);
      const azimuthField = PROMPT_WEIGHT_BY_ID["azimuth.weight"];
      const elevationField = PROMPT_WEIGHT_BY_ID["elevation.weight"];
      const distanceField = PROMPT_WEIGHT_BY_ID["distance.weight"];
      const tiltField = PROMPT_WEIGHT_BY_ID["tilt.weight"];
      const active = [
        `${azName} · ${azimuthField.label} ${promptFmtWeight(readNestedWeight(config, azimuthField))}`,
        `${elevationField.label} ${promptFmtWeight(readNestedWeight(config, elevationField))}`,
        `${distanceField.label} 基准 ${promptFmtWeight(readNestedWeight(config, distanceField))} · 当前 ${promptFmtWeight(distanceDetails.weight)}（${distanceDetails.label}）`,
      ];
      if (Math.abs(this.state.roll) >= 0.15) active.push(`${tiltField.label} ${promptFmtWeight(readNestedWeight(config, tiltField))}`);
      this.root.querySelector("[data-prompt-active]").textContent = `当前：${active.join(" · ")}`;
      const preview = buildPromptPreview(this.state.px, this.state.py, this.state.pz, this.state.roll, config);
      this.root.querySelector("[data-prompt-preview]").textContent = preview || "（当前机位没有启用的相机词）";
    }

    _buildJointSelect() {
      this.jointSelect.innerHTML = JOINTS.map(([name, label]) => `<option value="${name}">${label}</option>`).join("");
      this.jointSelect.value = this.selectedJoint;
    }

    _fixWidgetLayout() {
      const widgetRow = this.root?.closest(".lg-node-widget");
      const widgetGrid = this.root?.closest(".lg-node-widgets");
      if (widgetRow) { widgetRow.style.gridRow = "1 / -1"; widgetRow.style.minHeight = "0px"; widgetRow.style.position = "absolute"; widgetRow.style.inset = "0"; widgetRow.style.height = "auto"; widgetRow.style.display = "flex"; widgetRow.style.flex = "none"; widgetRow.style.width = "auto"; }
      if (widgetGrid) {
        // 只有一个自定义 DOM widget 时，改用单列 flex，避免新版 grid 为
        // 已隐藏输入生成隐式空行；左侧缩放把手保留为绝对定位覆盖层。
        widgetGrid.style.display = "flex"; widgetGrid.style.flexDirection = "column"; widgetGrid.style.position = "relative"; widgetGrid.style.height = "100%"; widgetGrid.style.minHeight = "0px";
        const resizeHandle = [...widgetGrid.children].find((child) => String(child.className || "").includes("z-10"));
        if (resizeHandle) { resizeHandle.style.position = "absolute"; resizeHandle.style.inset = "0 auto 0 0"; resizeHandle.style.zIndex = "3"; }
      }
    }

    _bindInteractions() {
      this.root.querySelectorAll("[data-quick]").forEach((button) => button.addEventListener("click", () => {
        const values = { front: [0, 0], side: [-0.5, 0], back: [1, 0], up: [0, 0.55], down: [0, -0.55] }[button.dataset.quick] || [0, 0];
        this._setCamera(values[0], values[1], this.state.pz, this.state.roll, this.state.fov);
      }));
      this.root.querySelector("[data-camera-preset]").addEventListener("change", (event) => {
        const values = CAMERA_PRESETS[event.target.value];
        if (values) this._setCamera(...values, this.state.fov, event.target.value);
      });
      this.root.querySelectorAll("[data-camera]").forEach((input) => input.addEventListener("input", () => {
        const key = input.dataset.camera;
        this.state[key] = key === "fov" ? clamp(input.value, 20, 100) : clamp(input.value, -1, 1);
        this._setWidget(key === "fov" ? "fov" : key === "pz" ? "pos_z" : "roll", this.state[key]);
        this._syncControls();
      }));
      this.jointSelect.addEventListener("change", () => { this.selectedJoint = this.jointSelect.value; this._updateJointControls(); this._setSelection(); });
      this.root.querySelectorAll("[data-axis]").forEach((input) => input.addEventListener("input", () => {
        this._setJointAxis(input.dataset.axis, input.value);
      }));
      this.root.querySelectorAll("[data-pose]").forEach((button) => button.addEventListener("click", () => {
        const pose = button.dataset.pose === "t" ? makePose(90) : makePose(28);
        this.state.pose = pose;
        this.state.posePreset = button.dataset.pose === "t" ? "T-Pose" : "A-Pose";
        this._syncPose();
        this._applyPose();
        this._hint(button.dataset.pose === "reset" ? "已重置为 A-Pose" : `已切换为 ${this.state.posePreset}`);
      }));
      this.root.querySelector("[data-pose-action=save]").addEventListener("click", () => this._savePose());
      this.root.querySelector("[data-pose-action=restore]").addEventListener("click", () => this._restorePose());
      this.root.querySelector("[data-pose-action=delete]").addEventListener("click", () => this._deletePose());
      this.canvas.addEventListener("pointerdown", (event) => this._pointerDown(event));
      this.canvas.addEventListener("pointermove", (event) => this._pointerMove(event));
      ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => this.canvas.addEventListener(type, () => this._pointerUp()));
      this._wheelHandler = (event) => {
        if (!this.canvas.contains(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        // 常见缩放手感：向上滚靠近，向下滚远离。deltaY 向下为正，
        // 而 pos_z 越大代表距离越近，所以这里需要取反。
        this.state.pz = clamp(this.state.pz - event.deltaY * 0.0018, -1, 1);
        this._setWidget("pos_z", this.state.pz);
        this._syncControls();
      };
      // ComfyUI 画布会在节点 DOM 之前接管 wheel；用 document 捕获阶段先处理
      // 命中本节点画布的滚轮，Chrome/Edge 均可用，且只在本 UI 内阻止外层缩放。
      document.addEventListener("wheel", this._wheelHandler, { capture: true, passive: false });
    }

    _pointerDown(event) {
      event.preventDefault();
      event.stopPropagation();
      const hit = this._pickJoint(event);
      if (hit) {
        this.selectedJoint = hit;
        this.jointSelect.value = hit;
        this._updateJointControls();
        this.interaction = { type: "joint", id: event.pointerId, x: event.clientX, y: event.clientY, rotation: { ...this.state.pose[hit] } };
        this._setSelection();
      } else {
        this.interaction = { type: "camera", id: event.pointerId, x: event.clientX, y: event.clientY, px: this.state.px, py: this.state.py };
        this.state.preset = "自定义";
        this._setWidget("preset", "自定义");
      }
      try { this.canvas.setPointerCapture(event.pointerId); } catch {}
      this.canvas.classList.add("is-dragging");
    }

    _pointerMove(event) {
      const move = this.interaction;
      if (!move || move.id !== event.pointerId) return;
      const rect = this.canvas.getBoundingClientRect();
      if (move.type === "joint") {
        const dx = event.clientX - move.x;
        const dy = event.clientY - move.y;
        const limit = JOINT_LIMITS[this.selectedJoint] || 180;
        this.state.pose[this.selectedJoint] = {
          x: clamp(move.rotation.x - dy * 1.25, -limit, limit),
          y: clamp(move.rotation.y + dx * 1.25, -limit, limit),
          z: move.rotation.z,
        };
        this.state.posePreset = "自定义";
        this._setWidget("pose_preset", "自定义");
        this._syncPose();
        this._applyPose();
      } else {
        // 拖拽遵循“抓住画面转动”的手感：向右拖，视角向左转；向上拖，视角向下转。
        this.state.px = ((move.px - (event.clientX - move.x) / Math.max(1, rect.width) * 1.6 + 1) % 2 + 2) % 2 - 1;
        this.state.py = clamp(move.py + (event.clientY - move.y) / Math.max(1, rect.height) * 1.25, -1, 1);
        this._setWidget("pos_x", this.state.px);
        this._setWidget("pos_y", this.state.py);
        this._syncControls();
      }
      this.requestRender();
    }

    _pointerUp() {
      this.interaction = null;
      this.canvas.classList.remove("is-dragging");
      this.requestRender();
    }

    _pickJoint(event) {
      if (!this.THREE || !this.displayCamera || !this.jointPickers.length) return null;
      const rect = this.canvas.getBoundingClientRect();
      const pointer = new this.THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const raycaster = new this.THREE.Raycaster();
      raycaster.setFromCamera(pointer, this.displayCamera);
      const hit = raycaster.intersectObjects(this.jointPickers, false)[0];
      return hit?.object?.userData?.jointName || null;
    }

    _hideRawWidgets() {
      ["pose_preset", "pose", "preset", "pos_x", "pos_y", "pos_z", "roll", "fov", "extra_tags", "config"].forEach((name) => {
        const widget = this.widgets[name];
        if (!widget) return;
        widget.hidden = true;
        widget.type = "hidden";
        widget.options = { ...(widget.options || {}), hidden: true };
        widget.draw = () => {};
        widget.computeSize = () => [0, -4];
        if (widget.element) widget.element.style.display = "none";
      });
    }

    _setWidget(name, value) {
      const widget = this.widgets[name];
      if (!widget) return;
      widget.value = value;
      try { widget.callback?.(value); } catch {}
    }

    _setCamera(px, py, pz, roll, fov, presetName = "自定义") {
      this.state.px = clamp(px, -1, 1); this.state.py = clamp(py, -1, 1); this.state.pz = clamp(pz, -1, 1); this.state.roll = clamp(roll, -1, 1); this.state.fov = clamp(fov, 20, 100);
      this.state.preset = presetName;
      this._setWidget("preset", presetName);
      this._setWidget("pos_x", this.state.px); this._setWidget("pos_y", this.state.py); this._setWidget("pos_z", this.state.pz); this._setWidget("roll", this.state.roll); this._setWidget("fov", this.state.fov);
      this._syncControls();
    }

    _setJointAxis(axis, value) {
      const limit = JOINT_LIMITS[this.selectedJoint] || 180;
      this.state.pose[this.selectedJoint][axis] = clamp(value, -limit, limit);
      this.state.posePreset = "自定义";
      this._setWidget("pose_preset", "自定义");
      this._syncPose();
      this._applyPose();
    }

    _syncPose() { this._setWidget("pose", JSON.stringify(clonePose(this.state.pose))); this.node.graph?.setDirtyCanvas?.(true, true); }

    _applyPose() {
      this.jointMap.forEach((joint, name) => {
        const rotation = this.state.pose[name] || { x: 0, y: 0, z: 0 };
        joint.rotation.set(rotation.x * Math.PI / 180, rotation.y * Math.PI / 180, rotation.z * Math.PI / 180);
      });
      this._updateJointControls();
      this.requestRender();
    }

    _syncControls() {
      const promptConfig = this._readPromptConfig();
      this.root.querySelectorAll("[data-camera]").forEach((input) => { input.value = this.state[input.dataset.camera]; });
      const yaw = Math.round(this.state.px * 180); const pitch = Math.round(this.state.py * 90); const roll = Math.round(this.state.roll * 90); const distance = (CAMERA_DISTANCE_BASE - this.state.pz * CAMERA_DISTANCE_RANGE).toFixed(2);
      const distanceDetails = promptDistanceDetails(promptConfig, this.state.pz);
      this.cameraReadout.textContent = `yaw ${yaw}° · pitch ${pitch}° · roll ${roll}°`;
      this.root.querySelector('[data-camera-live="yaw"]').textContent = `${yaw}°`;
      this.root.querySelector('[data-camera-live="pitch"]').textContent = `${pitch}°`;
      this.root.querySelector('[data-camera-live="roll"]').textContent = `${roll}°`;
      this.root.querySelector('[data-camera-live="distance"]').textContent = distance;
      this.root.querySelector('[data-camera-live="fov"]').textContent = `${Math.round(this.state.fov)}°`;
      this.root.querySelector('[data-camera-live="x"]').textContent = this.state.px.toFixed(2);
      this.root.querySelector('[data-camera-live="y"]').textContent = this.state.py.toFixed(2);
      this.root.querySelector('[data-camera-live="z"]').textContent = this.state.pz.toFixed(2);
      this.root.querySelector('[data-camera-output="pz"]').textContent = `${distance} · ${distanceDetails.label} · 权重 ${promptFmtWeight(distanceDetails.weight)}`;
      this.root.querySelectorAll("[data-distance-category]").forEach((item) => item.classList.toggle("is-active", item.dataset.distanceCategory === distanceDetails.key));
      this.root.querySelector('[data-camera-output="roll"]').textContent = `${Math.round(this.state.roll * 90)}°`;
      this.root.querySelector('[data-camera-output="fov"]').textContent = `${Math.round(this.state.fov)}°`;
      this.root.querySelector("[data-camera-preset]").value = this.state.preset || "自定义";
      const horizontal = Math.abs(this.state.px) > 0.72 ? "背面" : Math.abs(this.state.px) > 0.22 ? (this.state.px > 0 ? "左侧" : "右侧") : "正面";
      const vertical = this.state.py > 0.28 ? "俯视" : this.state.py < -0.28 ? "仰视" : "平视";
      this.orientation.textContent = `${horizontal} · ${vertical}`;
      this._syncPromptControls(promptConfig);
      this._updateJointControls();
      this.requestRender();
    }

    _updateJointControls() {
      const rotation = this.state.pose[this.selectedJoint] || { x: 0, y: 0, z: 0 };
      this.root.querySelectorAll("[data-axis]").forEach((input) => { input.value = rotation[input.dataset.axis]; this.root.querySelector(`[data-axis-output="${input.dataset.axis}"]`).textContent = `${Math.round(rotation[input.dataset.axis])}°`; });
    }

    _setSelection() {
      const label = JOINTS.find(([name]) => name === this.selectedJoint)?.[1] || this.selectedJoint;
      this.selection.textContent = `${label} · 拖拽调整 X/Y`; this.jointMap.forEach((joint, name) => joint.userData.selected = name === this.selectedJoint); this.requestRender();
    }

    _renderSlots() {
      const select = this.root.querySelector("[data-pose-slot]");
      select.innerHTML = '<option value="">选择已保存姿势</option>' + Object.keys(this.slots).sort().map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
    }

    _savePose() {
      const input = this.root.querySelector("[data-pose-name]");
      const name = (input.value || "").trim() || "姿势1";
      this.slots[name] = clonePose(this.state.pose);
      try { window.localStorage.setItem(POSE_SLOT_KEY, JSON.stringify(this.slots)); } catch {}
      this._renderSlots(); this.root.querySelector("[data-pose-slot]").value = name; this._hint(`已保存姿势「${name}」`);
    }

    _restorePose() {
      const name = this.root.querySelector("[data-pose-slot]").value;
      if (!name || !this.slots[name]) return this._hint("请先选择已保存姿势");
      this.state.pose = clonePose(this.slots[name]); this.state.posePreset = "自定义"; this._setWidget("pose_preset", "自定义"); this._syncPose(); this._applyPose(); this._hint(`已恢复姿势「${name}」`);
    }

    _deletePose() {
      const name = this.root.querySelector("[data-pose-slot]").value;
      if (!name || !this.slots[name]) return;
      delete this.slots[name];
      try { window.localStorage.setItem(POSE_SLOT_KEY, JSON.stringify(this.slots)); } catch {}
      this._renderSlots(); this._hint(`已删除姿势「${name}」`);
    }

    _hint(text) { const hint = this.root.querySelector("[data-hint]"); hint.textContent = text; clearTimeout(this.hintTimer); this.hintTimer = setTimeout(() => { if (!this.disposed) hint.textContent = "模型是无纹理低面数空壳；相机本体不显示，只显示少量视线与地面辅助线。"; }, 2600); }

    async _loadThree() {
      try { this.THREE = await loadThree(); if (this.disposed) return; this._setupScene(); this._setStatus("就绪 · 程序化低模 FK 素体"); }
      catch (error) { this._setStatus("3D 引擎不可用"); this.root.classList.add("is-error"); this._hint(`无法加载项目内 Three.js：${error?.message || error}`); }
    }

    _setStatus(text) { this.status.textContent = text; }

    _setupScene() {
      const T = this.THREE;
      this.scene = new T.Scene();
      this.displayCamera = new T.PerspectiveCamera(this.state.fov, 1, 0.01, 30);
      this.renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.setClearColor(0x101318, 1);
      if (T.SRGBColorSpace) this.renderer.outputColorSpace = T.SRGBColorSpace;
      this.scene.add(new T.HemisphereLight(0xdbe5ff, 0x242630, 1.7));
      const key = new T.DirectionalLight(0xffffff, 2.2); key.position.set(3, 4, 4); this.scene.add(key);
      const fill = new T.DirectionalLight(0x9c8bff, 0.8); fill.position.set(-3, 2, -2); this.scene.add(fill);
      this.modelRoot = new T.Group(); this.modelRoot.name = "procedural-low-poly-fk-shell"; this.scene.add(this.modelRoot);
      this._buildHelpers(); this._buildBody(); this._resize(); this.requestRender();
    }

    _material(color, opacity = 1) { return new this.THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, flatShading: true, transparent: opacity < 1, opacity }); }

    _joint(parent, name, x, y, z) {
      const T = this.THREE; const joint = new T.Group(); joint.name = `joint-${name}`; joint.position.set(x, y, z); joint.userData.jointName = name;
      const marker = new T.Mesh(new T.SphereGeometry(0.055, 6, 4), this._material(0xb9a6ff, 0.56)); marker.userData.jointName = name; joint.add(marker); this.jointPickers.push(marker); parent.add(joint); this.jointMap.set(name, joint); return joint;
    }

    _segment(parent, length, radius, color, direction = 1) {
      const T = this.THREE; const mesh = new T.Mesh(new T.CylinderGeometry(radius, radius * 1.05, length, 7), this._material(color)); mesh.position.y = direction * length / 2; parent.add(mesh); return mesh;
    }

    _buildBody() {
      const T = this.THREE; const skin = 0xb9a6ff; const limb = 0x8e97ae; const accent = 0xd8c8ff;
      const root = this._joint(this.modelRoot, "root", 0, 0, 0);
      const pelvis = new T.Mesh(new T.CylinderGeometry(0.34, 0.42, 0.32, 8), this._material(skin)); pelvis.position.y = 0.2; root.add(pelvis);
      const waist = this._joint(root, "waist", 0, 0.42, 0); this._segment(waist, 0.38, 0.31, skin, 1);
      const chest = this._joint(waist, "chest", 0, 0.40, 0); const torso = new T.Mesh(new T.CylinderGeometry(0.43, 0.33, 0.55, 8), this._material(skin)); torso.position.y = 0.25; chest.add(torso);
      const neck = this._joint(chest, "neck", 0, 0.57, 0); this._segment(neck, 0.18, 0.13, skin, 1);
      const head = this._joint(neck, "head", 0, 0.22, 0); const skull = new T.Mesh(new T.SphereGeometry(0.25, 8, 6), this._material(skin)); skull.position.y = 0.18; head.add(skull);
      const face = new T.Mesh(new T.ConeGeometry(0.075, 0.18, 6), this._material(accent)); face.rotation.x = Math.PI / 2; face.position.set(0, 0.17, 0.25); head.add(face);
      [["left", -1], ["right", 1]].forEach(([side, sign]) => {
        const shoulder = this._joint(chest, `${side}_shoulder`, sign * 0.46, 0.40, 0); this._segment(shoulder, 0.82, 0.105, limb, -1);
        const elbow = this._joint(shoulder, `${side}_elbow`, 0, -0.84, 0); this._segment(elbow, 0.40, 0.085, limb, -1);
        const hand = new T.Mesh(new T.SphereGeometry(0.105, 6, 4), this._material(limb)); hand.position.y = -0.48; elbow.add(hand);
        const hip = this._joint(root, `${side}_hip`, sign * 0.21, 0.12, 0); this._segment(hip, 1.18, 0.14, limb, -1);
        const knee = this._joint(hip, `${side}_knee`, 0, -1.22, 0); this._segment(knee, 0.60, 0.105, limb, -1);
        const foot = new T.Mesh(new T.BoxGeometry(0.18, 0.12, 0.34), this._material(limb)); foot.position.set(0, -0.66, 0.10); knee.add(foot);
      });
      this._applyPose();
    }

    _buildHelpers() {
      const T = this.THREE; const helper = new T.Group(); const faint = new T.LineBasicMaterial({ color: 0x8d96aa, transparent: true, opacity: 0.26 }); const accent = new T.LineBasicMaterial({ color: 0xb9a6ff, transparent: true, opacity: 0.48 });
      const circle = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; circle.push(new T.Vector3(Math.sin(a) * 1.55, 0.01, Math.cos(a) * 1.55)); }
      helper.add(new T.LineLoop(new T.BufferGeometry().setFromPoints(circle), faint));
      helper.add(new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 2.85, 0)]), faint));
      this.cameraRay = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, CAMERA_DISTANCE_BASE), new T.Vector3(0, 0, 0)]), accent); helper.add(this.cameraRay); this.scene.add(helper); this.helperGroup = helper;
    }

    _cameraPosition() {
      const radius = CAMERA_DISTANCE_BASE - this.state.pz * CAMERA_DISTANCE_RANGE; const az = this.state.px * Math.PI; const elevation = this.state.py * Math.PI * 0.46; const targetY = 0;
      return new this.THREE.Vector3(Math.sin(az) * Math.cos(elevation) * radius, targetY + Math.sin(elevation) * radius, Math.cos(az) * Math.cos(elevation) * radius);
    }

    _updateCamera() {
      if (!this.displayCamera || !this.THREE) return;
      const target = new this.THREE.Vector3(0, 0, 0); const position = this._cameraPosition(); this.displayCamera.position.copy(position); this.displayCamera.fov = this.state.fov; this.displayCamera.up.set(0, 1, 0); this.displayCamera.lookAt(target); this.displayCamera.rotateZ(this.state.roll * Math.PI / 2); this.displayCamera.updateProjectionMatrix();
      if (this.cameraRay) { this.cameraRay.geometry.setFromPoints([position, target]); this.cameraRay.geometry.computeBoundingSphere(); }
    }

    _resize() {
      if (!this.renderer || !this.viewport) return; const rect = this.viewport.getBoundingClientRect(); const width = Math.max(160, Math.floor(rect.width)); const height = Math.max(160, Math.floor(rect.height)); this.renderer.setSize(width, height, false); this.displayCamera.aspect = width / height; this.displayCamera.updateProjectionMatrix(); this.requestRender();
    }

    requestRender() {
      if (this.disposed || this.frame || !this.renderer) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; if (this.disposed || !this.renderer) return; this._updateCamera(); this.renderer.render(this.scene, this.displayCamera); });
    }

    restore() {
      this.state.posePreset = this.widgets.pose_preset?.value || this.state.posePreset;
      this.state.pose = normalizePose(this.widgets.pose?.value || this.state.pose);
      this.state.px = finite(this.widgets.pos_x?.value, this.state.px); this.state.py = finite(this.widgets.pos_y?.value, this.state.py); this.state.pz = finite(this.widgets.pos_z?.value, this.state.pz); this.state.roll = finite(this.widgets.roll?.value, this.state.roll); this.state.fov = clamp(finite(this.widgets.fov?.value, this.state.fov), 20, 100); this._syncControls(); this._applyPose();
    }

    dispose() {
      if (this.disposed) return; this.disposed = true; if (this.frame) cancelAnimationFrame(this.frame); if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame); this.frame = 0; this.resizeObserver?.disconnect(); this.sizeSync?.dispose?.(); if (this._wheelHandler) document.removeEventListener("wheel", this._wheelHandler, true);
      this.scene?.traverse?.((object) => { object.geometry?.dispose?.(); if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.()); else object.material?.dispose?.(); }); this.renderer?.dispose?.(); this.jointMap.clear(); this.jointPickers = [];
    }
  }

  function injectStyle() {
    if (document.getElementById("tk-3d-body-camera-style")) return;
    const style = document.createElement("style"); style.id = "tk-3d-body-camera-style"; style.textContent = `
.tk-3d-body-camera-ui{--tk-bg:#101216;--tk-panel:#181b21;--tk-panel-2:#20242b;--tk-line:rgba(232,237,255,.14);--tk-muted:#969eae;--tk-text:#e9ebf2;--tk-accent:#b9a6ff;box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;gap:7px;padding:9px;color:var(--tk-text);background:#101216;font:12px/1.32 Inter,system-ui,sans-serif;overflow:hidden}.tk-3d-body-camera-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto}.tk-3d-body-camera-head>div{display:flex;align-items:baseline;gap:8px}.tk-3d-body-camera-head strong{font-size:15px}.tk-3d-body-camera-kicker{font-size:9px;letter-spacing:.12em;color:var(--tk-accent)}.tk-3d-body-camera-head>span{font-size:10px;color:#a9dbbd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.is-error .tk-3d-body-camera-head>span{color:#f5a5a5}.tk-3d-body-camera-viewport{position:relative;flex:1 1 280px;min-height:190px;min-width:0;overflow:hidden;border:1px solid var(--tk-line);border-radius:7px;background:#15181e}.tk-3d-body-camera-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab}.tk-3d-body-camera-canvas.is-dragging{cursor:grabbing}.tk-3d-body-camera-overlay{position:absolute;left:9px;right:9px;bottom:7px;display:flex;justify-content:space-between;pointer-events:none;color:#dfe2ef;font-size:10px;text-shadow:0 1px 3px #000}.tk-3d-body-camera-overlay span:last-child{color:#b0b7c6}.tk-3d-body-camera-toolbar,.tk-3d-body-camera-pose-actions,.tk-3d-body-camera-save-row{display:flex;align-items:center;gap:5px;min-width:0;flex:0 0 auto}.tk-3d-body-camera-toolbar>span{color:var(--tk-muted);font-size:10px;flex:0 0 auto}.tk-3d-body-camera-ui button,.tk-3d-body-camera-ui select,.tk-3d-body-camera-ui input{font:inherit;color:var(--tk-text);background:var(--tk-panel-2);border:1px solid var(--tk-line);border-radius:5px}.tk-3d-body-camera-ui button{padding:4px 7px;cursor:pointer;white-space:nowrap}.tk-3d-body-camera-ui button:hover,.tk-3d-body-camera-ui select:hover{border-color:var(--tk-accent)}.tk-3d-body-camera-toolbar select{margin-left:auto;min-width:76px;max-width:112px;padding:4px}.tk-3d-body-camera-section{flex:0 1 auto;min-height:0;padding:7px 8px;border:1px solid var(--tk-line);border-radius:7px;background:var(--tk-panel)}.tk-3d-body-camera-section-title{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}.tk-3d-body-camera-section-title strong{font-size:11px}.tk-3d-body-camera-section-title span,.tk-3d-body-camera-hint{color:var(--tk-muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tk-3d-body-camera-camera-section{display:grid;gap:4px}.tk-3d-body-camera-range{display:grid;grid-template-columns:34px minmax(0,1fr) 93px;align-items:center;gap:6px;color:#cdd2df;font-size:10px}.tk-3d-body-camera-range input,.tk-3d-body-camera-axis-grid input{min-width:0;width:100%;accent-color:var(--tk-accent)}.tk-3d-body-camera-range output,.tk-3d-body-camera-axis-grid output{color:var(--tk-accent);font-variant-numeric:tabular-nums;text-align:right}.tk-3d-body-camera-pose-actions select{min-width:0;flex:1;padding:4px}.tk-3d-body-camera-axis-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:5px}.tk-3d-body-camera-axis-grid label{display:grid;grid-template-columns:18px minmax(0,1fr) 30px;align-items:center;gap:4px;color:#cdd2df;font-size:10px}.tk-3d-body-camera-save-row input{min-width:58px;flex:1;padding:5px 6px}.tk-3d-body-camera-save-row select{min-width:72px;flex:1;padding:5px 6px}.tk-3d-body-camera-save-row button{padding:4px 6px;font-size:10px}.tk-3d-body-camera-hint{text-align:center;flex:0 0 auto}.tk-3d-body-camera-ui button:focus-visible,.tk-3d-body-camera-ui select:focus-visible,.tk-3d-body-camera-ui input:focus-visible{outline:2px solid rgba(185,166,255,.78);outline-offset:1px}@media(max-width:460px){.tk-3d-body-camera-toolbar{flex-wrap:wrap}.tk-3d-body-camera-toolbar select{margin-left:0;flex:1}.tk-3d-body-camera-axis-grid{grid-template-columns:1fr}.tk-3d-body-camera-save-row{flex-wrap:wrap}.tk-3d-body-camera-save-row input,.tk-3d-body-camera-save-row select{flex-basis:42%}}`;
    // 预览保留在 DOM widget 中，但控件视觉完全贴近 ComfyUI 原生节点：
    // 无渐变、无营销式标签、无大圆角卡片，只保留必要的分隔线和原生控件状态。
    style.textContent += `.tk-3d-body-camera-ui{--tk-bg:#1e1e1e;--tk-panel:#252525;--tk-panel-2:#303030;--tk-line:#4a4a4a;--tk-muted:#aaa;--tk-text:#ddd;--tk-accent:#aaa;gap:4px;padding:4px;background:var(--tk-bg);font:12px Arial,sans-serif;color:var(--tk-text)}.tk-3d-body-camera-head{min-height:20px;padding:2px 4px;border-bottom:1px solid var(--tk-line)}.tk-3d-body-camera-head strong{font-size:13px;font-weight:600}.tk-3d-body-camera-head>span{color:#aaa;font-size:11px}.tk-3d-body-camera-viewport{flex:1 1 330px;min-height:240px;border:1px solid #555;border-radius:2px;background:#181818}.tk-3d-body-camera-overlay{left:6px;right:6px;bottom:5px;font-size:11px;text-shadow:0 1px 2px #000}.tk-3d-body-camera-toolbar,.tk-3d-body-camera-pose-actions,.tk-3d-body-camera-save-row{gap:3px}.tk-3d-body-camera-toolbar>span{color:#bbb;font-size:11px}.tk-3d-body-camera-ui button,.tk-3d-body-camera-ui select,.tk-3d-body-camera-ui input{color:#ddd;background:#303030;border:1px solid #555;border-radius:2px;box-shadow:none}.tk-3d-body-camera-ui button{padding:3px 6px}.tk-3d-body-camera-ui button:hover,.tk-3d-body-camera-ui select:hover{border-color:#888;background:#383838}.tk-3d-body-camera-ui button:active{background:#444}.tk-3d-body-camera-ui button:focus-visible,.tk-3d-body-camera-ui select:focus-visible,.tk-3d-body-camera-ui input:focus-visible{outline:1px solid #aaa;outline-offset:0}.tk-3d-body-camera-toolbar select{margin-left:auto;padding:3px;min-width:80px;max-width:120px}.tk-3d-body-camera-section{padding:4px 5px;border:0;border-top:1px solid #454545;border-radius:0;background:transparent}.tk-3d-body-camera-section-title{margin-bottom:4px}.tk-3d-body-camera-section-title strong{font-size:12px;font-weight:600}.tk-3d-body-camera-section-title span,.tk-3d-body-camera-hint{color:#aaa;font-size:11px}.tk-3d-body-camera-readouts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:3px;margin-bottom:4px}.tk-3d-body-camera-readouts span{display:flex;justify-content:space-between;gap:3px;padding:2px 4px;background:#292929;border:1px solid #414141;border-radius:2px;color:#aaa;font-size:10px}.tk-3d-body-camera-readouts output,.tk-3d-body-camera-normalized output{color:#ddd;font-variant-numeric:tabular-nums}.tk-3d-body-camera-range{grid-template-columns:34px minmax(0,1fr) 116px;gap:5px;color:#bbb}.tk-3d-body-camera-range output{color:#ddd}.tk-3d-body-camera-distance-categories{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;margin:-1px 121px 1px 39px;color:#888;font-size:9px;line-height:14px;white-space:nowrap}.tk-3d-body-camera-distance-categories span{text-align:center;border:1px solid transparent;border-radius:2px}.tk-3d-body-camera-distance-categories span.is-active{color:#ddd;background:#3b3b3b;border-color:#666}.tk-3d-body-camera-normalized{padding-top:3px;color:#999;font-size:10px;border-top:1px solid #383838}.tk-3d-body-camera-pose-actions select{padding:3px}.tk-3d-body-camera-axis-grid{gap:4px;margin-top:4px}.tk-3d-body-camera-axis-grid label{color:#bbb}.tk-3d-body-camera-axis-grid output{color:#ddd}.tk-3d-body-camera-save-row input,.tk-3d-body-camera-save-row select{padding:3px 5px}.tk-3d-body-camera-save-row button{padding:3px 5px;font-size:11px}.tk-3d-body-camera-hint{text-align:left;padding:1px 4px}.tk-3d-body-camera-prompt-weight-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;max-height:235px;overflow:auto}.tk-3d-body-camera-prompt-group{min-width:0}.tk-3d-body-camera-prompt-group>strong{display:block;padding-bottom:2px;color:#bbb;font-size:11px}.tk-3d-body-camera-prompt-grid{display:grid;gap:2px}.tk-3d-body-camera-prompt-weight{display:grid;grid-template-columns:34px minmax(20px,1fr) 43px;align-items:center;gap:4px;min-width:0;color:#bbb;font-size:10px}.tk-3d-body-camera-prompt-weight>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tk-3d-body-camera-prompt-weight input[type=range]{width:100%;min-width:0;accent-color:#aaa}.tk-3d-body-camera-prompt-weight-number{box-sizing:border-box;width:100%;padding:2px 3px;text-align:right}.tk-3d-body-camera-prompt-weight em{display:none}.tk-3d-body-camera-prompt-preview{display:grid;grid-template-columns:42px minmax(0,1fr);gap:5px;margin-top:5px;padding-top:4px;border-top:1px solid #383838;color:#999;font-size:10px}.tk-3d-body-camera-prompt-preview code{min-width:0;max-height:38px;overflow:auto;color:#ddd;font:10px/1.35 Consolas,monospace;white-space:normal;overflow-wrap:anywhere}@media(max-width:620px){.tk-3d-body-camera-prompt-weight-groups{grid-template-columns:1fr}.tk-3d-body-camera-readouts{grid-template-columns:repeat(3,minmax(0,1fr))}}`;
    document.head.appendChild(style);
  }

  function init() {
    const api = window.comfyAPI?.app?.app; if (!api?.registerExtension) return setTimeout(init, 500);
    api.registerExtension({ name: "TK.ThreeDBodyCamera.Widget", async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_NAME) return;
      const originalCreated = nodeType.prototype.onNodeCreated; const originalConfigure = nodeType.prototype.onConfigure; const originalRemoved = nodeType.prototype.onRemoved;
      nodeType.prototype.onNodeCreated = function () { const result = originalCreated?.apply(this, arguments); const ui = new BodyCameraUI(this); this._tk3dBodyCamera = ui; const root = ui.build(); if (!this.properties?.tk3dBodyCameraInitialized) { this.setSize?.([520, 680]); this.properties = { ...(this.properties || {}), tk3dBodyCameraInitialized: true }; } const domWidget = this.addDOMWidget?.("tk_3d_body_camera_ui", "custom", root, { serialize: false, hideOnZoom: false }); ui.mount(domWidget); return result; };
      nodeType.prototype.onConfigure = function () { const result = originalConfigure?.apply(this, arguments); setTimeout(() => this._tk3dBodyCamera?.restore(), 0); return result; };
      nodeType.prototype.onRemoved = function () { this._tk3dBodyCamera?.dispose?.(); return originalRemoved?.apply(this, arguments); };
    }});
  }
  injectStyle(); init();
})();
