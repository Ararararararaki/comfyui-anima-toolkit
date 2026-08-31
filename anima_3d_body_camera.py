"""TK 可动素体相机。

这是一个独立的新节点。它不加载人物模型文件，也不把 3D 资源放进工作流：
前端用少量 Three.js 基础几何体组成可动的 FK 素体，后端只负责复用旧的
``CameraControlCore`` 生成相机提示词，并输出结构化的相机/姿势状态。
"""

from __future__ import annotations

import json
import math
from typing import Any

from aiohttp import web
from server import PromptServer

try:
    from . import anima_camera_control as _camera_control
except ImportError:  # 直接运行测试文件时使用
    import anima_camera_control as _camera_control  # type: ignore


# 只依赖旧相机节点的核心接口；预设接口在旧测试桩/精简安装中可能不存在。
# 这样新增节点不会阻断整个插件的导入和其他节点注册。
_CAMERA_CONTROL_AVAILABLE = all(
    hasattr(_camera_control, name) for name in ("DEFAULT_CONFIG_JSON", "CameraControlCore")
)
DEFAULT_CONFIG_JSON = getattr(_camera_control, "DEFAULT_CONFIG_JSON", "{}")
CameraControlCore = getattr(_camera_control, "CameraControlCore", None)
CUSTOM_PRESET = getattr(_camera_control, "CUSTOM_PRESET", "自定义")
_preset_entry = getattr(_camera_control, "_preset_entry", lambda _name: None)
all_preset_names = getattr(_camera_control, "all_preset_names", lambda: [CUSTOM_PRESET])


POSE_JOINTS = (
    "root", "waist", "chest", "neck", "head",
    "left_shoulder", "left_elbow", "right_shoulder", "right_elbow",
    "left_hip", "left_knee", "right_hip", "right_knee",
)

POSE_LIMITS = {"root": 45.0, "waist": 65.0, "chest": 70.0, "neck": 80.0, "head": 90.0}
CAMERA_DISTANCE_BASE = 5.0
CAMERA_DISTANCE_RANGE = 3.4


def _body_camera_config() -> dict[str, Any]:
    """给新节点补齐与 BSK 一致的四个轴权重。"""
    if not _CAMERA_CONTROL_AVAILABLE:
        return {}
    config = json.loads(DEFAULT_CONFIG_JSON)
    for name in ("front", "back", "left", "right"):
        config["azimuth"]["directions"][name].pop("weight", None)
    for name in ("bird", "high", "eye", "low", "worm"):
        config["elevation"]["categories"][name].pop("weight", None)
    for name in ("ecu", "cu", "medium", "full", "wide"):
        config["distance"]["categories"][name].pop("weight", None)
    config["distance"].setdefault("weight", 1.0)
    # 旧算法默认是 abs(y) * (1 + extra)，默认 extra=10，因此轴权重为 11。
    config["elevation"].setdefault("weight", 11.0)
    config["tilt"].setdefault("weight", 1.0)
    return config


BODY_CAMERA_DEFAULT_CONFIG = _body_camera_config()
BODY_CAMERA_DEFAULT_CONFIG_JSON = json.dumps(BODY_CAMERA_DEFAULT_CONFIG, ensure_ascii=False, separators=(",", ":"))


def _body_prompt_config(raw: Any) -> dict[str, Any]:
    """把旧/测试版配置收敛为 BSK 的四个轴权重，避免逐词权重污染新节点。"""
    if not _CAMERA_CONTROL_AVAILABLE:
        return {}
    config = CameraControlCore._load_config(raw)
    for name in ("front", "back", "left", "right"):
        config["azimuth"]["directions"].get(name, {}).pop("weight", None)
    for name in ("bird", "high", "eye", "low", "worm"):
        config["elevation"]["categories"].get(name, {}).pop("weight", None)
    for name in ("ecu", "cu", "medium", "full", "wide"):
        config["distance"]["categories"].get(name, {}).pop("weight", None)
    config["azimuth"].setdefault("weight", 10.0)
    config["elevation"].setdefault("weight", 11.0)
    config["distance"].setdefault("weight", 1.0)
    config["tilt"].setdefault("weight", 1.0)
    return config

PROMPT_WEIGHT_FIELDS = {
    "azimuth": {"weight": ("左右方位", 10.0)},
    "elevation": {"weight": ("上下方位", 11.0)},
    "distance": {"weight": ("距离方位", 1.0)},
    "tilt": {"weight": ("倾斜角", 1.0)},
}


def _rotation(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> dict[str, float]:
    return {"x": float(x), "y": float(y), "z": float(z)}


def _pose_template(arm_angle: float) -> dict[str, dict[str, float]]:
    """生成 A/T 姿势的完整状态；局部旋转采用角度，便于 UI 编辑和保存。"""
    pose = {name: _rotation() for name in POSE_JOINTS}
    pose["left_shoulder"]["z"] = -float(arm_angle)
    pose["right_shoulder"]["z"] = float(arm_angle)
    return pose


DEFAULT_POSE = _pose_template(28.0)
T_POSE = _pose_template(90.0)


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _read_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value or "{}")
        except (TypeError, ValueError):
            return {}
    return value


def normalize_pose(raw: Any) -> dict[str, dict[str, float]]:
    """只接受已知关节和有限角度，补齐缺省关节并限制异常输入。"""
    source = _read_json(raw)
    if not isinstance(source, dict):
        source = {}
    result: dict[str, dict[str, float]] = {}
    legacy_aliases = {
        "left_shoulder": "left_upper_arm", "right_shoulder": "right_upper_arm",
        "left_hip": "left_thigh", "right_hip": "right_thigh",
        "left_knee": "left_ankle", "right_knee": "right_ankle",
    }
    for name in POSE_JOINTS:
        item = source.get(name, source.get(legacy_aliases.get(name, ""), {}))
        if not isinstance(item, dict):
            item = {}
        default = DEFAULT_POSE[name]
        limit = POSE_LIMITS.get(name, 180.0)
        result[name] = {
            axis: round(max(-limit, min(limit, _finite(item.get(axis), default[axis]))), 3)
            for axis in ("x", "y", "z")
        }
    return result


def pose_for_preset(name: str, raw: Any = None) -> dict[str, dict[str, float]]:
    if str(name or "") == "T-Pose":
        return normalize_pose(T_POSE)
    if str(name or "") == "自定义":
        return normalize_pose(raw)
    return normalize_pose(DEFAULT_POSE)


def _append_extra_tags(prompt: str, *chunks: str) -> str:
    extras: list[str] = []
    for chunk in chunks:
        for tag in str(chunk or "").split(","):
            tag = tag.strip()
            if tag and tag not in extras:
                extras.append(tag)
    if not extras:
        return prompt
    base = prompt.rstrip().rstrip(",")
    return f"{base + ', ' if base else ''}{', '.join(extras)},"


class Anima3DBodyCamera:
    """极简可动素体 + 相机观察器；前端 FK，后端输出相机提示词。"""

    NAME = "TK 3D Body Camera"
    CATEGORY = "TK/camera"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pose_preset": (["A-Pose", "T-Pose", "自定义"], {"default": "A-Pose", "label": "默认姿势"}),
                "pose": ("STRING", {"default": json.dumps(DEFAULT_POSE, ensure_ascii=False, separators=(",", ":")), "multiline": False, "label": "姿势 JSON"}),
                "preset": (all_preset_names(), {"default": CUSTOM_PRESET, "label": "机位预设"}),
                "pos_x": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01, "label": "水平角度 (X)"}),
                "pos_y": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01, "label": "俯仰角度 (Y)"}),
                "pos_z": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01, "label": "距离 (Z)"}),
                "roll": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01, "label": "倾斜角 (Roll)"}),
                "fov": ("FLOAT", {"default": 50.0, "min": 20.0, "max": 100.0, "step": 1.0, "label": "视场角 (FOV)"}),
                "extra_tags": ("STRING", {"default": "", "multiline": True, "label": "附加相机 tag"}),
                "config": ("STRING", {"default": BODY_CAMERA_DEFAULT_CONFIG_JSON, "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("相机提示词", "camera_meta")
    FUNCTION = "execute"
    DESCRIPTION = "极简低模 FK 素体相机预览：每侧手臂保留肩/肘、腿部保留髋/膝，可拖动关节摆姿势；复用 TK 相机控制的 BSK 提示词算法。"

    def execute(self, pose_preset, pose, preset, pos_x, pos_y, pos_z, roll, fov, extra_tags, config):
        px, py, pz, rl = (_finite(pos_x), _finite(pos_y), _finite(pos_z), _finite(roll))
        preset_name = str(preset or CUSTOM_PRESET)
        if preset_name != CUSTOM_PRESET:
            selected = _preset_entry(preset_name)
            if selected is not None:
                px = _finite(selected.get("pos_x"), px)
                py = _finite(selected.get("pos_y"), py)
                pz = _finite(selected.get("pos_z"), pz)
                rl = _finite(selected.get("roll"), rl)
                preset_extra = selected.get("extra", "")
            else:
                preset_extra = ""
        else:
            preset_extra = ""

        prompt_config = _body_prompt_config(config)
        prompt = CameraControlCore.compute(px, py, pz, rl, json.dumps(prompt_config, ensure_ascii=False, separators=(",", ":")))
        prompt = _append_extra_tags(prompt, preset_extra, extra_tags)
        pose_state = pose_for_preset(str(pose_preset or "A-Pose"), pose)
        fov_value = round(max(20.0, min(100.0, _finite(fov, 50.0))), 2)
        parsed_config = prompt_config
        prompt_weights = {}
        for group, fields in PROMPT_WEIGHT_FIELDS.items():
            prompt_weights[group] = {}
            section = parsed_config.get(group) or {}
            for key, (_label, fallback) in fields.items():
                item = section
                try:
                    prompt_weights[group][key] = round(float(item.get("weight", fallback)), 3) if isinstance(item, dict) else fallback
                except (TypeError, ValueError):
                    prompt_weights[group][key] = fallback
        meta = {
            "schema": "tk-pose-camera/v1",
            "representation": "procedural-low-poly-fk-shell",
            "camera": {
                "yaw": round(px * 180.0, 3),
                "pitch": round(py * 90.0, 3),
                "distance": round(CAMERA_DISTANCE_BASE - pz * CAMERA_DISTANCE_RANGE, 3),
                "roll": round(rl * 90.0, 3),
                "fov": fov_value,
                "normalized": {"x": round(px, 4), "y": round(py, 4), "z": round(pz, 4), "roll": round(rl, 4)},
            },
            "pose_preset": str(pose_preset or "A-Pose"),
            "pose": pose_state,
            "preset": preset_name if preset_name != CUSTOM_PRESET else "",
            "extra_tags": [x.strip() for x in str(extra_tags or "").split(",") if x.strip()],
            "enabled": {
                "azimuth": bool((parsed_config.get("azimuth") or {}).get("enabled", True)),
                "elevation": bool((parsed_config.get("elevation") or {}).get("enabled", True)),
                "distance": bool((parsed_config.get("distance") or {}).get("enabled", True)),
                "tilt": bool((parsed_config.get("tilt") or {}).get("enabled", True)),
            },
            "prompt_weights": prompt_weights,
        }
        return prompt, json.dumps(meta, ensure_ascii=False, separators=(",", ":"))


# 精简测试环境可能只提供旧节点的空桩；这种情况下不注册依赖缺失的新节点，
# 但不能因此阻断其它节点的注册。正常 ComfyUI 环境会注册唯一的新节点。
NODE_CLASS_MAPPINGS = {Anima3DBodyCamera.NAME: Anima3DBodyCamera} if _CAMERA_CONTROL_AVAILABLE else {}
NODE_DISPLAY_NAME_MAPPINGS = {Anima3DBodyCamera.NAME: "TK 可动素体相机"} if _CAMERA_CONTROL_AVAILABLE else {}


@PromptServer.instance.routes.get("/anima/body-camera/models")
async def body_camera_models(request):
    """兼容之前前端探测接口；现在没有外部模型可下载。"""
    return web.json_response({
        "ok": True,
        "models": [{
            "id": "procedural-low-poly-fk-shell",
            "label": "程序化低模空壳素体",
            "asset": "",
            "url": "",
            "description": "由低面数球体、圆柱和体块组成，无纹理、无外部模型文件。",
        }],
    })
