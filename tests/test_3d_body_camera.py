"""TK 可动素体相机的后端公共接口测试。"""

import json
import sys
import types


sys.path.insert(0, "E:/claude program/ComfyUI-Anima-Batch-LoRA")

server = types.ModuleType("server")


class _Routes:
    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn


server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=_Routes()))
sys.modules["server"] = server

import anima_3d_body_camera as body_camera  # noqa: E402


def check(condition, message):
    if not condition:
        raise AssertionError(message)


node = body_camera.Anima3DBodyCamera
required = node.INPUT_TYPES()["required"]
check(node.NAME == "TK 3D Body Camera", "新节点内部名称必须稳定")
check({"pose_preset", "pose", "preset", "pos_x", "pos_y", "pos_z", "roll", "fov"}.issubset(required), "节点输入不完整")
check(node.RETURN_TYPES == ("STRING", "STRING"), "节点应输出 prompt 和 camera_meta")
check("tk_body_shell" not in node.DESCRIPTION, "新方案不能依赖旧 GLB")

raw = {"left_elbow": {"x": 999, "y": "bad", "z": -20}, "unknown": {"x": 1}}
pose = body_camera.normalize_pose(raw)
check(set(pose) == set(body_camera.POSE_JOINTS), "姿势必须补齐所有已知关节")
check(pose["left_elbow"] == {"x": 180.0, "y": 0.0, "z": -20.0}, "关节角度应清理并限制异常值")
check("unknown" not in pose, "未知关节不能进入状态")

prompt, meta_text = node().execute(
    "自定义",
    json.dumps(raw),
    "自定义",
    0.5,
    -0.25,
    0.4,
    0.0,
    120,
    "face focus",
    body_camera.DEFAULT_CONFIG_JSON,
)
meta = json.loads(meta_text)
check("from right" in prompt or "from left" in prompt, "相机方位仍应复用旧提示词算法")
check("face focus" in prompt, "附加 tag 应保留")
check(meta["representation"] == "procedural-low-poly-fk-shell", "必须声明程序化低模表示")
check(meta["camera"]["fov"] == 100.0, "FOV 应限制在 20..100")
check(meta["camera"]["yaw"] == 90.0 and meta["camera"]["pitch"] == -22.5, "相机角度映射不正确")
check(meta["camera"]["distance"] == 3.64, "相机实际距离映射不正确")
check(len(meta["pose"]) == len(body_camera.POSE_JOINTS), "camera_meta 必须带完整姿势")

custom_config = json.loads(body_camera.BODY_CAMERA_DEFAULT_CONFIG_JSON)
custom_config["azimuth"]["weight"] = 1.3
custom_config["distance"]["weight"] = 0.7
custom_prompt, custom_meta_text = node().execute(
    "A-Pose", "{}", "自定义", 0, 0, 0, 0, 50, "", json.dumps(custom_config)
)
custom_meta = json.loads(custom_meta_text)
check("(from front:1.30)" in custom_prompt, "独立方位权重没有进入 BSK 提示词计算")
check("(medium shot:0.70)" in custom_prompt, "统一距离权重没有进入 BSK 提示词计算")
check("weight_min" not in custom_prompt and "camera_meta" not in custom_prompt and "{" not in custom_prompt, "相机提示词不应混入配置或 camera_meta JSON")
check(custom_meta["prompt_weights"]["azimuth"]["weight"] == 1.3, "camera_meta 没有返回左右方位权重")
check(custom_meta["prompt_weights"]["distance"]["label"] == "中景", "距离档位标签不正确")
check(custom_meta["prompt_weights"]["distance"]["effective_weight"] == 0.7, "距离档内中心点应保持手动权重")

distance_config = json.loads(body_camera.BODY_CAMERA_DEFAULT_CONFIG_JSON)
distance_categories = []
distance_weights = []
for pz in (-1.0, -0.5, 0.0, 0.5, 1.0):
    details = body_camera.CameraControlCore.distance_weight_details(distance_config, pz)
    distance_categories.append(details["key"])
    distance_weights.append(details["weight"])
check(distance_categories == ["wide", "full", "medium", "cu", "ecu"], "距离必须分为远景/全身/中景/近景/特写五档")
near_full = body_camera.CameraControlCore.distance_weight_details(distance_config, -0.21)["weight"]
far_full = body_camera.CameraControlCore.distance_weight_details(distance_config, -0.69)["weight"]
far_close = body_camera.CameraControlCore.distance_weight_details(distance_config, 0.21)["weight"]
near_close = body_camera.CameraControlCore.distance_weight_details(distance_config, 0.69)["weight"]
check(distance_weights[2] == 1.0 and near_full < far_full and far_close < near_close, "距离滑块没有在档位内连续改变权重")

_, t_pose_meta = node().execute(
    "T-Pose", "{}", "自定义", 0, 0, 0, 0, 50, "", body_camera.DEFAULT_CONFIG_JSON
)
check(json.loads(t_pose_meta)["pose"]["left_shoulder"]["z"] == -90.0, "T-Pose 姿势没有生效")

print("PASS TK 可动素体相机后端接口、FK 姿势和相机元数据")
