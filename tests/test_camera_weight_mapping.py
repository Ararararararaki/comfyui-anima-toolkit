"""TK Camera Control 方位权重映射回归测试。

回归场景：方位总权重为 10、最大权重为 5 时，方向权重仍应随 3D 机位
连续变化，不能因为逐方向钳制而在一大段角度保持 5。
"""
import copy
import json
import re
import sys
import types


sys.path.insert(0, str(__file__).rsplit("\\tests\\", 1)[0])


server = types.ModuleType("server")


class _Routes:
    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn


class _PromptServer:
    instance = types.SimpleNamespace(routes=_Routes())


server.PromptServer = _PromptServer
sys.modules["server"] = server

import anima_camera_control as camera  # noqa: E402


WEIGHT_RE = re.compile(r"\(([^:]+):([0-9.]+)\)")


def weights_at(config, pos_x):
    prompt = camera.CameraControlCore.compute(pos_x, 0.0, 0.0, 0.0, config)
    return {tag: float(weight) for tag, weight in WEIGHT_RE.findall(prompt)}


def main():
    cfg = copy.deepcopy(camera.DEFAULT_CONFIG)
    cfg["weight_max"] = 5.0
    cfg["elevation"]["enabled"] = False
    cfg["distance"]["enabled"] = False
    cfg["tilt"]["enabled"] = False
    raw = json.dumps(cfg, ensure_ascii=False)

    left_values = [weights_at(raw, x)["from left"] for x in (0.25, 0.35, 0.45, 0.50)]
    right_values = [weights_at(raw, -x)["from right"] for x in (0.25, 0.35, 0.45, 0.50)]
    behind_values = [weights_at(raw, x)["from behind"] for x in (0.75, 0.85, 0.95, 1.00)]

    assert left_values == sorted(left_values) and len(set(left_values)) == len(left_values), left_values
    assert right_values == sorted(right_values) and len(set(right_values)) == len(right_values), right_values
    assert behind_values == sorted(behind_values) and len(set(behind_values)) == len(behind_values), behind_values
    assert left_values[-1] == right_values[-1] == behind_values[-1] == 5.0
    assert max(left_values + right_values + behind_values) <= 5.0
    print("PASS TK 相机左右/背面方位权重连续变化")


def _test_camera_weight_mapping_script_regression():
    """原 __main__ 自检体（逐行搬入，未改内容）。"""
    main()

if __name__ == "__main__":
    _test_camera_weight_mapping_script_regression()


def test_test_camera_weight_mapping_script_regression():
    """把本文件的脚本自检接进 pytest。

    这些断言原本只在 `python test_camera_weight_mapping.py` 时执行，而 pytest 不跑 `__main__`，
    等于长期不在 CI 覆盖里。包装与直跑调用的是**同一个** `_test_camera_weight_mapping_script_regression()`，
    不会出现两套逻辑。
    """
    try:
        _test_camera_weight_mapping_script_regression()
    except SystemExit as exc:
        # 这类脚本用 sys.exit(0) 表示成功（自建 PASS/FAIL 计数器），
        # pytest 会把 SystemExit 当失败 —— 必须捕获并检查退出码。
        assert exc.code in (None, 0), f"脚本自检失败（exit={exc.code}）"

