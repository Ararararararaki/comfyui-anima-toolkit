# Anima Camera Control — 可视化相机提示词控制节点
#
# 算法忠实复刻 ComfyUI-bsk_UI 的 CameraControlNode（AGPL-3.0），
# 参考出处：https://github.com/.../ComfyUI-bsk_UI 的 camera_control_node.py
# 输出行为与该节点逐位对齐（方位 2D 比例分配 + 高度/距离档位 + 倾斜 + extras，
# 加权 (tag:weight) 与纯 tag 两种模式），确保「真正生效」且与用户既有工作流一致。
#
# 在 BSK 算法之上新增两类便捷控制（桌面批生图缺失的能力）：
#   1. 一键预设（PRESETS）：按 anima-prompt 实际机位用法定制，点选即得
#   2. 旧工作流兼容（parse_camera_nl）：保留历史 nl_prompt 的解析，不再作为当前 UI 入口
#
# 兼容旧工作流时优先级：nl_prompt > 预设 > 手动 pos_x/y/z/roll。

import os
import json
import math
import threading
from aiohttp import web
from server import PromptServer


# ============ 默认配置（与 BSK CameraControlNode 保持一致） ============
DEFAULT_CONFIG = {
    "weight_min": 0.1,
    "weight_max": 10.0,
    "no_weight": False,
    "no_weight_threshold": 0.5,
    "azimuth": {
        "enabled": True,
        "weight": 10.0,
        "deadzone_ratio": 0.2,
        "directions": {
            "front": {"tag": "from front", "enabled": True},
            "back":  {"tag": "from behind", "enabled": True},
            "left":  {"tag": "from right", "enabled": True},
            "right": {"tag": "from left", "enabled": True},
        },
    },
    "elevation": {
        "enabled": True,
        "extra": 10.0,
        "categories": {
            "bird": {"tag": "directly above, from above, aerial view,", "enabled": True},
            "high": {"tag": "high angle, from above", "enabled": True},
            "eye":  {"tag": "eye-level", "enabled": True},
            "low":  {"tag": "low angle, from below,", "enabled": True},
            "worm": {"tag": "directly below", "enabled": True},
        },
    },
    "distance": {
        "enabled": True,
        "extra": 0.0,
        "categories": {
            "ecu":    {"tag": "extreme close-up", "enabled": True},
            "cu":     {"tag": "close-up", "enabled": True},
            "medium": {"tag": "medium shot", "enabled": True},
            "full":   {"tag": "full body", "enabled": True},
            "wide":   {"tag": "wide shot", "enabled": True},
        },
    },
    "tilt": {
        "enabled": True,
        "deadzone": 0.15,
        "extra": 0.0,
        "dutch_tag": "dutch angle",
    },
    "extra_master": 1.0,
    "wheel_step": 0.0003,
    "extras": {
        "lens":        {"enabled": False, "value": "85mm lens"},
        "dof":         {"enabled": False, "value": "shallow depth of field", "weight": 1.3},
        "movement":    {"enabled": False, "value": "handheld camera"},
        "composition": {"enabled": False, "value": "rule of thirds"},
        "style":       {"enabled": False, "value": "cinematic"},
    },
}

DEFAULT_CONFIG_JSON = json.dumps(DEFAULT_CONFIG, ensure_ascii=False)

# 旧 schema 标记键（历史版本遗留，加载时迁移清除）
LEGACY_KEYS = {"two_tier", "axes", "negative"}

# 距离档位的 z 区间：档内权重随 z 从区间起点(0% 额外权重)线性爬到终点(100% 额外权重)。
DIST_RANGES = {
    "ecu":    (0.7, 1.0),
    "cu":     (0.2, 0.7),
    "medium": (-0.2, 0.2),
    "full":   (-0.7, -0.2),
    "wide":   (-1.0, -0.7),
}

# 可动素体相机使用独立的 UI 顺序：远景 → 中景 → 近景 → 全身 → 特写。
# 旧 TK Camera Control 不带 category_order，继续使用上面的旧分段。
BODY_DISTANCE_ORDER = ("wide", "medium", "cu", "full", "ecu")
BODY_DISTANCE_RANGES = {
    "wide":   (-1.0, -0.6),
    "medium": (-0.6, -0.2),
    "cu":     (-0.2, 0.2),
    "full":   (0.2, 0.6),
    "ecu":    (0.6, 1.0),
}

# 中景/全身/远景：距离越远(z 越小)权重越大，故档内 frac 反向计算；
# 特写/近景仍是越近(z 越大)权重越大。
DIST_FAR_STRONGER = {"medium", "full", "wide"}


# ============ 一键预设（按 anima-prompt 实际机位用法定制） ============
# pos_x ∈ [-1,1] 方位环绕；pos_y ∈ [-1,1] 俯仰（+俯视/-仰视）；pos_z ∈ [-1,1] 景别（+特写/-远景）；
# roll ∈ [-1,1] 倾斜（|roll|≥0.15 出 dutch angle）。
# extra：预设附加的纯 tag（足控/角色焦点等 BSK 方位算法不覆盖、但用户实际在用的词）。
PRESETS = {
    # ── 方位 ──
    "正面":      {"pos_x": 0.0, "pos_y": 0.0, "pos_z": 0.0, "roll": 0.0},
    "背面":      {"pos_x": 1.0, "pos_y": 0.0, "pos_z": 0.0, "roll": 0.0},
    "左侧":      {"pos_x": 0.5, "pos_y": 0.0, "pos_z": 0.0, "roll": 0.0},
    "右侧":      {"pos_x": -0.5, "pos_y": 0.0, "pos_z": 0.0, "roll": 0.0},
    # ── 俯仰 ──
    "正上方俯视": {"pos_x": 0.0, "pos_y": 1.0, "pos_z": 0.0, "roll": 0.0},
    "俯视":      {"pos_x": 0.0, "pos_y": 0.5, "pos_z": 0.0, "roll": 0.0},
    "仰视":      {"pos_x": 0.0, "pos_y": -0.5, "pos_z": 0.0, "roll": 0.0},
    "正下方仰视": {"pos_x": 0.0, "pos_y": -1.0, "pos_z": 0.0, "roll": 0.0},
    # ── 景别 ──
    "特写":      {"pos_x": 0.0, "pos_y": 0.0, "pos_z": 1.0, "roll": 0.0},
    "近景":      {"pos_x": 0.0, "pos_y": 0.0, "pos_z": 0.5, "roll": 0.0},
    "中景":      {"pos_x": 0.0, "pos_y": 0.0, "pos_z": 0.0, "roll": 0.0},
    "全身":      {"pos_x": 0.0, "pos_y": 0.0, "pos_z": -0.5, "roll": 0.0},
    "远景":      {"pos_x": 0.0, "pos_y": 0.0, "pos_z": -1.0, "roll": 0.0},
    # ── 倾斜 ──
    "荷兰角":    {"pos_x": 0.0, "pos_y": 0.0, "pos_z": 0.0, "roll": 0.6},
    # ── 组合预设（anima-prompt 实际用法） ──
    "足控仰视":   {"pos_x": 0.0, "pos_y": -0.5, "pos_z": 0.5, "roll": 0.0,
                 "extra": "straight-on, foot focus"},
    "角色特写":   {"pos_x": 0.0, "pos_y": 0.0, "pos_z": 1.0, "roll": 0.0,
                 "extra": "face focus, looking at viewer"},
    "角色中景":   {"pos_x": 0.0, "pos_y": 0.0, "pos_z": 0.0, "roll": 0.0,
                 "extra": "looking at viewer"},
}

CUSTOM_PRESET = "自定义"
PRESET_NAMES = [CUSTOM_PRESET] + list(PRESETS.keys())


# ============ 用户自定义预设（data/camera_presets.json，2026-08-24） ============
# 结构：{名称: {"pos_x","pos_y","pos_z","roll","extra"}}，与内置 PRESETS 同构。
# 保存/重命名/删除/导入导出走 /anima/camera/presets* API；节点 preset 下拉
# 与 camera_preview（批量联动）都会合并自定义预设。

_CAM_PRESETS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "camera_presets.json")
_CAM_PRESETS_LOCK = threading.Lock()


def _load_custom_presets() -> dict:
    with _CAM_PRESETS_LOCK:
        try:
            if os.path.exists(_CAM_PRESETS_PATH):
                with open(_CAM_PRESETS_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    out = {}
                    for name, p in data.items():
                        if not isinstance(p, dict):
                            continue
                        out[str(name)] = {
                            "pos_x": float(p.get("pos_x", 0.0)),
                            "pos_y": float(p.get("pos_y", 0.0)),
                            "pos_z": float(p.get("pos_z", 0.0)),
                            "roll": float(p.get("roll", 0.0)),
                            "extra": str(p.get("extra", "") or ""),
                        }
                    return out
        except Exception as e:
            print(f"[TK Camera Control] 自定义预设读取失败（按空处理）: {e}")
    return {}


def _save_custom_presets(presets: dict):
    with _CAM_PRESETS_LOCK:
        os.makedirs(os.path.dirname(_CAM_PRESETS_PATH), exist_ok=True)
        tmp = _CAM_PRESETS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(presets, f, ensure_ascii=False, indent=1)
        os.replace(tmp, _CAM_PRESETS_PATH)


def _preset_entry(name: str) -> dict | None:
    """内置或自定义预设 → 参数 dict（含 extra）。"""
    p = PRESETS.get(name)
    if p is not None:
        return p
    return _load_custom_presets().get(name)


def _safe_preset_name(name: str) -> str:
    s = str(name or "").strip().replace("/", "_").replace("\\", "_").replace(":", "_")[:40]
    for ch in '*?<>|"':
        s = s.replace(ch, "_")
    return s or "预设"


def all_preset_names() -> list:
    """节点下拉选项：自定义 + 内置 + 用户自定义（去重保序）。"""
    names = [CUSTOM_PRESET] + list(PRESETS.keys())
    for n in _load_custom_presets().keys():
        if n not in names:
            names.append(n)
    return names


def _has_any(text: str, keywords) -> bool:
    """子串匹配（大小写不敏感），任一关键词命中即 True。"""
    t = text.lower()
    return any(k.lower() in t for k in keywords)


def parse_camera_nl(text, base=(0.0, 0.0, 0.0, 0.0)):
    """自然语言 → (pos_x, pos_y, pos_z, roll)。规则式解析，覆盖常用机位描述。

    未命中的维度保持 base 值（支持叠加部分描述，如「近景，俯视」）。
    返回 tuple[float, float, float, float]。
    """
    px, py, pz, rl = (float(v) for v in base)
    t = (text or "").lower()

    # ── 俯仰 (pos_y)：+俯视 / -仰视 ──
    if _has_any(t, ("正上方", "鸟瞰", "航拍", "aerial", "directly above",
                    "top-down", "top down", "bird's eye", "birds eye")):
        py = 1.0
    elif _has_any(t, ("俯视", "俯拍", "高角度", "高角", "from above",
                      "high angle", "looking down", "overhead")):
        py = 0.5
    elif _has_any(t, ("仰视", "仰拍", "低角度", "低角", "from below",
                      "low angle", "looking up")):
        py = -0.5
    elif _has_any(t, ("正下方", "directly below", "worm's eye", "worm eye")):
        py = -1.0
    elif _has_any(t, ("平视", "eye level", "eye-level", "straight-on", "straight on")):
        py = 0.0

    # ── 景别 (pos_z)：+特写 / -远景 ──
    if _has_any(t, ("大特写", "extreme close", "extreme closeup")):
        pz = 1.0
    elif _has_any(t, ("特写", "close-up", "close up", "closeup")):
        pz = 0.8
    elif _has_any(t, ("近景", "medium close")):
        pz = 0.4
    elif _has_any(t, ("中景", "medium shot", "medium")):
        pz = 0.0
    elif _has_any(t, ("全身", "full body", "full shot", "全身照")):
        pz = -0.5
    elif _has_any(t, ("远景", "wide shot", "wide angle", "大远景")):
        pz = -1.0

    # ── 方位 (pos_x)：BSK 方位 2D 映射 ──
    if _has_any(t, ("背面", "背后", "身后", "背影", "from behind", "back view")):
        px = 1.0
    elif _has_any(t, ("侧面", "侧拍", "侧视", "from the side", "side view", "profile")):
        px = 0.5
    elif _has_any(t, ("左侧", "从左", "from the left")):
        px = 0.5   # BSK：right 方向输出 "from left"（相机在左）
    elif _has_any(t, ("右侧", "从右", "from the right")):
        px = -0.5
    elif _has_any(t, ("正面", "正对", "from front", "front view")):
        px = 0.0

    # ── 倾斜 (roll) ──
    if _has_any(t, ("荷兰角", "倾斜", "dutch", "tilted")):
        rl = 0.6
    elif _has_any(t, ("水平", "level", "straight")):
        rl = 0.0

    return (px, py, pz, rl)


class CameraControlCore:
    """相机算法核心（与 BSK CameraControlNode 逐位对齐）。

    拆成独立类便于 AnimaCameraControl 节点复用与单元测试。
    """

    # ---------- 工具 ----------
    @staticmethod
    def _fmt_weight(w):
        return f"{round(float(w), 2):.2f}"

    @staticmethod
    def _split_tags(tag):
        return [t.strip() for t in str(tag).split(",") if t.strip()]

    @classmethod
    def _emit_weighted(cls, tag, w):
        return [f"({t}:{cls._fmt_weight(w)})" for t in cls._split_tags(tag)]

    @classmethod
    def _emit_plain(cls, tag):
        return cls._split_tags(tag)

    @staticmethod
    def _merge_defaults(cfg, base):
        for k, v in base.items():
            if k not in cfg:
                cfg[k] = v
            elif isinstance(v, dict) and isinstance(cfg[k], dict):
                CameraControlCore._merge_defaults(cfg[k], v)
        return cfg

    @classmethod
    def _has_legacy_keys(cls, obj):
        if not isinstance(obj, dict):
            return False
        for k, v in obj.items():
            if k in LEGACY_KEYS:
                return True
            if isinstance(v, dict) and cls._has_legacy_keys(v):
                return True
        return False

    @classmethod
    def _strip_legacy_keys(cls, obj):
        if not isinstance(obj, dict):
            return
        for k in list(obj.keys()):
            if k in LEGACY_KEYS:
                del obj[k]
            elif isinstance(obj[k], dict):
                cls._strip_legacy_keys(obj[k])

    @classmethod
    def _load_config(cls, raw):
        if not raw:
            return json.loads(DEFAULT_CONFIG_JSON)
        try:
            cfg = json.loads(raw)
        except Exception:
            cfg = json.loads(DEFAULT_CONFIG_JSON)
        if cls._has_legacy_keys(cfg):
            cfg["weight_min"] = DEFAULT_CONFIG["weight_min"]
            cfg["weight_max"] = DEFAULT_CONFIG["weight_max"]
            cls._strip_legacy_keys(cfg)
        cls._merge_defaults(cfg, json.loads(DEFAULT_CONFIG_JSON))
        return cfg

    @staticmethod
    def _elevation_key(y):
        if y > 0.7:
            return "bird"
        if y > 0.2:
            return "high"
        if y >= -0.2:
            return "eye"
        if y >= -0.7:
            return "low"
        return "worm"

    @staticmethod
    def _distance_key(z, category_order=None):
        if tuple(category_order or ()) == BODY_DISTANCE_ORDER:
            if z > 0.6:
                return "ecu"
            if z > 0.2:
                return "full"
            if z >= -0.2:
                return "cu"
            if z >= -0.6:
                return "medium"
            return "wide"
        if z > 0.7:
            return "ecu"
        if z > 0.2:
            return "cu"
        if z >= -0.2:
            return "medium"
        if z >= -0.7:
            return "full"
        return "wide"

    @classmethod
    def distance_weight_details(cls, cfg, z):
        """返回当前距离档位和实际权重；follow_slider 是新节点的可选增强。"""
        z = float(z)
        distance_cfg = cfg.get("distance") or {}
        category_order = distance_cfg.get("category_order")
        ranges = BODY_DISTANCE_RANGES if tuple(category_order or ()) == BODY_DISTANCE_ORDER else DIST_RANGES
        key = cls._distance_key(z, category_order)
        start, end = ranges[key]
        if key in DIST_FAR_STRONGER:
            frac = max(0.0, min(1.0, (end - z) / (end - start)))
        else:
            frac = max(0.0, min(1.0, (z - start) / (end - start)))

        category_cfg = (distance_cfg.get("categories") or {}).get(key) or {}
        extra_master = float(cfg.get("extra_master", 1.0))
        extra = float(distance_cfg.get("extra", 0.0))
        if "weight" in distance_cfg:
            base_weight = float(distance_cfg.get("weight", 1.0))
        elif "weight" in category_cfg:
            base_weight = float(category_cfg.get("weight", 1.0))
        else:
            base_weight = 1.0
        if distance_cfg.get("follow_slider", False):
            # BSK 的 frac 保留“近档/远档的方向性”。以 0.5 为中心，
            # 让距离滑块在当前档位内连续改变权重，同时保留手动权重作为中心值。
            variation = abs(extra_master * extra)
            if variation <= 0:
                variation = max(0.5, abs(base_weight) * 0.5)
            weight = base_weight + (frac - 0.5) * variation
        else:
            weight = base_weight + frac * extra_master * extra

        wmin = float(cfg.get("weight_min", 0.1))
        wmax = float(cfg.get("weight_max", 10.0))
        weight = min(wmax, max(wmin, weight))
        return {"key": key, "fraction": frac, "weight": weight}

    @classmethod
    def _distance_parts(cls, cfg, z):
        details = cls.distance_weight_details(cfg, z)
        key = details["key"]
        cat = (cfg["distance"].get("categories") or {}).get(key)
        if not cat or not cat.get("tag") or not cat.get("enabled", True):
            return []
        # 新节点使用 distance.weight 作为统一的「距离权重」，当前档位只
        # 决定输出哪个距离 tag，不再让特写/近景/中景/全身/远景各自持有
        # 一套互相独立的权重。保留 category.weight 仅为兼容此前测试版配置。
        return cls._emit_weighted(cat["tag"], details["weight"])

    @classmethod
    def _weighted_tilt(cls, cfg):
        tilt = cfg.get("tilt", {})
        if not tilt.get("enabled", True):
            return []
        extra_master = float(cfg.get("extra_master", 1.0))
        extra = float(tilt.get("extra", 0.0))
        wmax = float(cfg.get("weight_max", 10.0))
        w = float(tilt.get("weight", 1.0)) + extra_master * extra if "weight" in tilt else 1.0 + extra_master * extra
        w = min(wmax, max(0.1, w))
        return cls._emit_weighted(tilt.get("dutch_tag", ""), w)

    # ---------- 主计算 ----------
    @classmethod
    def compute(cls, pos_x, pos_y, pos_z, roll, config):
        cfg = cls._load_config(config)
        if cfg.get("no_weight"):
            return cls._compute_no_weight(float(pos_x), float(pos_y), float(pos_z), float(roll), cfg)
        parts = []

        wmin = float(cfg.get("weight_min", 0.1))
        wmax = float(cfg.get("weight_max", 5.0))
        dz = float(cfg.get("azimuth", {}).get("deadzone_ratio", 0.2))

        # ---------- 方位（Azimuth）2D 比例分配 ----------
        if cfg.get("azimuth", {}).get("enabled", True):
            az = float(pos_x) * math.pi
            front = max(0.0, math.cos(az))
            back = max(0.0, -math.cos(az))
            right = max(0.0, math.sin(az))
            left = max(0.0, -math.sin(az))
            s = front + back + left + right
            if s > 0:
                front /= s
                back /= s
                left /= s
                right /= s
            AZ_POLE = 0.9
            az_gate = max(0.0, min(1.0, (1.0 - abs(float(pos_y))) / (1.0 - AZ_POLE)))
            # 先限制整个方位预算，再按方向比例分配。
            # 如果直接对每个方向单独套 weight_max，当 azimuth.weight > weight_max
            # 时，左右方向会在大段角度被钳成同一个最高值，3D 机位虽在移动，
            # 提示词权重却不变。
            az_weight = max(0.0, float(cfg["azimuth"].get("weight", 0.0)))
            az_budget = min(az_weight, wmax) * az_gate
            for name, ratio in (("front", front), ("back", back), ("left", left), ("right", right)):
                dir_cfg = cfg["azimuth"]["directions"].get(name, {})
                if not dir_cfg.get("enabled", True):
                    continue
                if "weight" in dir_cfg:
                    # 有独立权重时，权重表示该方向在正对机位时的目标值，
                    # 再按连续方位比例和俯仰门控衰减；斜向机位仍会自然混合。
                    direction_budget = min(max(0.0, float(dir_cfg.get("weight", 0.0))), wmax)
                    w = ratio * direction_budget * az_gate
                else:
                    w = ratio * az_budget
                if ratio <= 0 or w < dz:
                    continue
                w = min(wmax, max(wmin, w))
                parts.extend(cls._emit_weighted(dir_cfg.get("tag", ""), w))

        # ---------- 高度（Elevation） ----------
        if cfg.get("elevation", {}).get("enabled", True):
            elev_key = cls._elevation_key(float(pos_y))
            elev_cat = (cfg["elevation"].get("categories") or {}).get(elev_key)
            if elev_cat and elev_cat.get("tag") and elev_cat.get("enabled", True):
                extra_master = float(cfg.get("extra_master", 1.0))
                elev_extra = float(cfg["elevation"].get("extra", 0.0))
                if "weight" in cfg["elevation"]:
                    ew = abs(float(pos_y)) * float(cfg["elevation"].get("weight", 1.0))
                elif "weight" in elev_cat:
                    ew = abs(float(pos_y)) * float(elev_cat.get("weight", 1.0))
                else:
                    ew = abs(float(pos_y)) * (1.0 + extra_master * elev_extra)
                if ew >= dz:
                    ew = min(wmax, max(wmin, ew))
                    parts.extend(cls._emit_weighted(elev_cat["tag"], ew))

        # ---------- 距离（Distance） ----------
        if cfg.get("distance", {}).get("enabled", True):
            parts.extend(cls._distance_parts(cfg, float(pos_z)))

        # ---------- 倾斜（Tilt） ----------
        if cfg.get("tilt", {}).get("enabled", True):
            if abs(float(roll)) >= float(cfg["tilt"]["deadzone"]):
                parts.extend(cls._weighted_tilt(cfg))

        # ---------- 额外相机提示词 ----------
        extras = cfg.get("extras", {})
        for key in ("lens", "dof", "movement", "composition", "style"):
            e = extras.get(key)
            if not e or not e.get("enabled"):
                continue
            val = (e.get("value") or "").strip()
            if not val:
                continue
            if key == "dof":
                parts.append(f"({val}:{cls._fmt_weight(e.get('weight', 1.3))})")
            else:
                parts.append(val)

        result = ", ".join(parts)
        if result:
            result += ","
        return result

    @classmethod
    def _compute_no_weight(cls, pos_x, pos_y, pos_z, roll, cfg):
        parts = []
        thr = float(cfg.get("no_weight_threshold", 0.5))
        az = cfg.get("azimuth", {})
        if az.get("enabled", True):
            a = float(pos_x) * math.pi
            front = max(0.0, math.cos(a))
            back = max(0.0, -math.cos(a))
            right = max(0.0, math.sin(a))
            left = max(0.0, -math.sin(a))
            s = front + back + left + right
            if s > 0:
                front /= s
                back /= s
                left /= s
                right /= s
            AZ_POLE = 0.9
            az_gate = max(0.0, min(1.0, (1.0 - abs(float(pos_y))) / (1.0 - AZ_POLE)))
            if az_gate > 0:
                dirs = (("front", front), ("back", back), ("left", left), ("right", right))
                dom = None
                dom_r = -1.0
                for name, ratio in dirs:
                    d = az.get("directions", {}).get(name, {})
                    if not d.get("enabled", True):
                        continue
                    if ratio > dom_r:
                        dom_r = ratio
                        dom = name
                if dom is not None and dom_r > 0:
                    parts.extend(cls._emit_plain(az["directions"][dom].get("tag", "")))
                for name, ratio in dirs:
                    if name == dom:
                        continue
                    d = az.get("directions", {}).get(name, {})
                    if not d.get("enabled", True):
                        continue
                    if ratio >= thr:
                        parts.extend(cls._emit_plain(d.get("tag", "")))
        if cfg.get("elevation", {}).get("enabled", True):
            ek = cls._elevation_key(float(pos_y))
            if ek != "eye":
                ecat = (cfg["elevation"].get("categories") or {}).get(ek)
                if ecat and ecat.get("tag") and ecat.get("enabled", True):
                    parts.extend(cls._emit_plain(ecat["tag"]))
        if cfg.get("distance", {}).get("enabled", True):
            dk = cls._distance_key(float(pos_z), (cfg.get("distance") or {}).get("category_order"))
            if dk != "medium":
                dcat = (cfg["distance"].get("categories") or {}).get(dk)
                if dcat and dcat.get("tag") and dcat.get("enabled", True):
                    parts.extend(cls._emit_plain(dcat["tag"]))
        if cfg.get("tilt", {}).get("enabled", True) and abs(float(roll)) >= float(cfg["tilt"]["deadzone"]):
            parts.extend(cls._emit_plain(cfg["tilt"].get("dutch_tag", "")))
        extras = cfg.get("extras", {})
        for key in ("lens", "dof", "movement", "composition", "style"):
            e = extras.get(key)
            if not e or not e.get("enabled"):
                continue
            val = (e.get("value") or "").strip()
            if val:
                parts.append(val)
        result = ", ".join(parts)
        return result + "," if result else ""


class AnimaCameraControl:
    NAME = "TK Camera Control"
    CATEGORY = "TK/camera"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset": (all_preset_names(), {"default": CUSTOM_PRESET, "label": "机位预设"}),
                "nl_prompt": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "（旧工作流兼容字段）",
                    "tooltip": "旧工作流兼容字段；当前 TK 相机控制 UI 不再显示自然语言输入。",
                }),
                "pos_x": ("FLOAT", {
                    "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                    "label": "左右方位 (X)",
                }),
                "pos_y": ("FLOAT", {
                    "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                    "label": "上下俯仰 (Y)",
                }),
                "pos_z": ("FLOAT", {
                    "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                    "label": "前后景别 (Z)",
                }),
                "roll": ("FLOAT", {
                    "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                    "label": "倾斜角 (Roll)",
                }),
                "extra_tags": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "附加相机 tag（如 foot focus / face focus），追加到末尾",
                    "tooltip": "可选：手动追加的纯 tag，与算法输出合并。",
                }),
                "config": ("STRING", {
                    "multiline": True,
                    "default": DEFAULT_CONFIG_JSON,
                }),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("相机提示词", "camera_meta")
    FUNCTION = "execute"
    DESCRIPTION = "可视化控制相机机位，输出对应相机提示词（忠实复刻 BSK 算法：方位 2D 比例 + 高度/距离档位 + 倾斜 + extras；支持一键预设与用户自定义预设）；第二输出 camera_meta 为 JSON 结构化参数（mode/preset/坐标/生效开关），供下游节点/脚本消费；旧工作流的 nl_prompt 仅作兼容保留"

    def execute(self, preset, nl_prompt, pos_x, pos_y, pos_z, roll, extra_tags, config):
        px, py, pz, rl = float(pos_x), float(pos_y), float(pos_z), float(roll)

        # 优先级：旧工作流 nl_prompt > 预设（内置/自定义） > 手动
        nl = (nl_prompt or "").strip()
        mode = "nl" if nl else ("preset" if (preset and preset != CUSTOM_PRESET) else "manual")
        if nl:
            px, py, pz, rl = parse_camera_nl(nl, (px, py, pz, rl))
            extra_preset = ""
        elif preset and preset != CUSTOM_PRESET:
            p = _preset_entry(preset)
            if p is not None:
                px, py, pz, rl = p["pos_x"], p["pos_y"], p["pos_z"], p.get("roll", 0.0)
                extra_preset = p.get("extra", "")
            else:
                extra_preset = ""
        else:
            extra_preset = ""

        prompt = CameraControlCore.compute(px, py, pz, rl, config)

        # 附加 tag：预设自带 extra + 手动 extra_tags（去重保序）
        extras = []
        for chunk in (extra_preset, extra_tags or ""):
            for t in chunk.split(","):
                t = t.strip()
                if t and t not in extras:
                    extras.append(t)
        if extras:
            suffix = ", ".join(extras)
            prompt = (prompt.rstrip().rstrip(",") + ", " + suffix + ",").strip(", ").strip() + ","
            prompt = prompt.strip()

        # 结构化元数据（第二输出）：实际生效参数 + 生效开关
        try:
            cfg = json.loads(config) if config else {}
        except Exception:
            cfg = {}
        meta = {
            "mode": mode,
            "preset": preset if (preset and preset != CUSTOM_PRESET) else "",
            "nl_prompt": nl,
            "pos": {"x": round(px, 4), "y": round(py, 4), "z": round(pz, 4), "roll": round(rl, 4)},
            "extra_tags": extras,
            "enabled": {
                "azimuth": bool((cfg.get("azimuth") or {}).get("enabled", True)),
                "elevation": bool((cfg.get("elevation") or {}).get("enabled", True)),
                "distance": bool((cfg.get("distance") or {}).get("enabled", True)),
                "tilt": bool((cfg.get("tilt") or {}).get("enabled", True)),
            },
            "extras_enabled": {k: bool((cfg.get("extras") or {}).get(k, {}).get("enabled")) for k in
                               ("lens", "dof", "movement", "composition", "style")},
        }
        # 兜底：无任何输出时返回空串（下游可安全拼接）
        return (prompt, json.dumps(meta, ensure_ascii=False))


NODE_CLASS_MAPPINGS = {
    AnimaCameraControl.NAME: AnimaCameraControl,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaCameraControl.NAME: "TK 相机控制",
}


# ============ 相机预览 API（批量节点注入相机词时用） ============

@PromptServer.instance.routes.get("/anima/camera/preview")
async def camera_preview(request):
    """按参数计算相机提示词（供批量节点在队列展开时拼接相机词）。

    优先级与节点 execute 一致：自然语言 > 预设 > 手动 pos。
    """
    try:
        x = float(request.query.get("x", "0"))
        y = float(request.query.get("y", "0"))
        z = float(request.query.get("z", "0"))
        roll = float(request.query.get("roll", "0"))
    except ValueError:
        return web.json_response({"prompt": ""})
    config = request.query.get("config", "")
    extra = (request.query.get("extra") or "").strip()
    preset = (request.query.get("preset") or "").strip()
    nl = (request.query.get("nl") or "").strip()

    # 复刻 execute 的优先级（含用户自定义预设）
    if nl:
        x, y, z, roll = parse_camera_nl(nl, (x, y, z, roll))
        extra_preset = ""
    elif preset and preset != CUSTOM_PRESET:
        p = _preset_entry(preset)
        if p is not None:
            x, y, z, roll = p["pos_x"], p["pos_y"], p["pos_z"], p.get("roll", 0.0)
            extra_preset = p.get("extra", "")
        else:
            extra_preset = ""
    else:
        extra_preset = ""

    try:
        prompt = CameraControlCore.compute(x, y, z, roll, config)
    except Exception:
        prompt = ""

    extras = []
    for chunk in (extra_preset, extra):
        for t in chunk.split(","):
            t = t.strip()
            if t and t not in extras:
                extras.append(t)
    if extras:
        suffix = ", ".join(extras)
        prompt = (prompt.rstrip().rstrip(",") + ", " + suffix + ",").strip(", ").strip() + ","
        prompt = prompt.strip()

    return web.json_response({"prompt": prompt})


# ============ 用户自定义预设 API（2026-08-24） ============

@PromptServer.instance.routes.get("/anima/camera/presets")
async def camera_presets_get(request):
    """列出预设：builtin（内置只读）+ custom（用户自定义）。"""
    return web.json_response({
        "ok": True,
        "builtin": PRESETS,
        "custom": _load_custom_presets(),
    })


@PromptServer.instance.routes.post("/anima/camera/presets")
async def camera_presets_save(request):
    """保存/覆盖一条自定义预设。body: {name, pos_x, pos_y, pos_z, roll, extra}。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    name = _safe_preset_name(body.get("name") or "")
    if not name:
        return web.json_response({"ok": False, "error": "预设名不能为空"}, status=400)
    if name in PRESETS:
        return web.json_response({"ok": False, "error": f"「{name}」是内置预设，不能覆盖"}, status=409)
    try:
        entry = {
            "pos_x": float(body.get("pos_x", 0.0)),
            "pos_y": float(body.get("pos_y", 0.0)),
            "pos_z": float(body.get("pos_z", 0.0)),
            "roll": float(body.get("roll", 0.0)),
            "extra": str(body.get("extra", "") or "").strip(),
        }
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "pos_x/y/z/roll 必须是数字"}, status=400)
    custom = _load_custom_presets()
    custom[name] = entry
    _save_custom_presets(custom)
    return web.json_response({"ok": True, "name": name, "count": len(custom)})


@PromptServer.instance.routes.post("/anima/camera/presets/delete")
async def camera_presets_delete(request):
    """删除自定义预设。body: {name}。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    name = str(body.get("name") or "").strip()
    custom = _load_custom_presets()
    if name not in custom:
        return web.json_response({"ok": False, "error": f"自定义预设「{name}」不存在"}, status=404)
    del custom[name]
    _save_custom_presets(custom)
    return web.json_response({"ok": True, "count": len(custom)})


@PromptServer.instance.routes.get("/anima/camera/presets/export")
async def camera_presets_export(request):
    """导出全部自定义预设（JSON 备份）。"""
    return web.json_response({"ok": True, "device": "anima-camera-presets", "presets": _load_custom_presets()})


@PromptServer.instance.routes.post("/anima/camera/presets/import")
async def camera_presets_import(request):
    """导入自定义预设（合并，同名覆盖）。body: {presets: {名称: {...}}} 或直接 {名称: {...}}。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    raw = body.get("presets") if isinstance(body, dict) and isinstance(body.get("presets"), dict) else body
    if not isinstance(raw, dict) or not raw:
        return web.json_response({"ok": False, "error": "presets 不能为空"}, status=400)
    custom = _load_custom_presets()
    added = 0
    n_conflict_builtin = 0
    for name, p in raw.items():
        if not isinstance(p, dict):
            continue
        sname = _safe_preset_name(name)
        if not sname:
            continue
        if sname in PRESETS and sname not in custom:
            n_conflict_builtin += 1
            continue
        try:
            custom[sname] = {
                "pos_x": float(p.get("pos_x", 0.0)),
                "pos_y": float(p.get("pos_y", 0.0)),
                "pos_z": float(p.get("pos_z", 0.0)),
                "roll": float(p.get("roll", 0.0)),
                "extra": str(p.get("extra", "") or "").strip(),
            }
            added += 1
        except (TypeError, ValueError):
            continue
    _save_custom_presets(custom)
    return web.json_response({"ok": True, "count": added,
                              "skipped_builtin": n_conflict_builtin})
