# TK Camera Control 自定义预设逻辑测试（不依赖运行中 ComfyUI）
# 运行：python tests/test_camera_presets.py
import os
import sys
import types
import tempfile
import shutil

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_server = types.ModuleType("server")
class _Routes:
    def __init__(self): self.items = []
    def get(self, path): return self._mk("get", path)
    def post(self, path): return self._mk("post", path)
    def _mk(self, method, path):
        def deco(fn):
            self.items.append((method, path, fn)); return fn
        return deco
class _PS:
    def __init__(self): self.routes = _Routes()
_PS.instance = _PS()
_server.PromptServer = _PS
sys.modules["server"] = _server

import anima_camera_control as acc

# 重定向预设文件到临时目录
tmp = tempfile.mkdtemp(prefix="cam_presets_")
acc._CAM_PRESETS_PATH = os.path.join(tmp, "camera_presets.json")

PASS = 0
FAIL = 0
def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  BAD {name}  {detail}")

print("== 预设名清洗 ==")
check("清洗非法字符", acc._safe_preset_name("a/b:c*d") == "a_b_c_d")
check("过长截断", len(acc._safe_preset_name("x" * 80)) <= 40)
check("空兜底", acc._safe_preset_name("  ") == "预设")

print("== 自定义预设存取 ==")
acc._save_custom_presets({"足控仰视V2": {"pos_x": 0.1, "pos_y": -0.4, "pos_z": 0.5, "roll": 0.2, "extra": "foot focus"}})
custom = acc._load_custom_presets()
check("保存读回", custom.get("足控仰视V2", {}).get("pos_y") == -0.4, str(custom))
check("extra 保留", custom.get("足控仰视V2", {}).get("extra") == "foot focus")

print("== 预设匹配（内置/自定义） ==")
p = acc._preset_entry("正面")
check("内置预设匹配", p is not None and p["pos_x"] == 0.0)
p = acc._preset_entry("足控仰视V2")
check("自定义预设匹配", p is not None and p["pos_y"] == -0.4)
check("未知预设 None", acc._preset_entry("不存在的预设") is None)

print("== 选项合并 ==")
names = acc.all_preset_names()
check("自定义在最前 + 内置 + 自定义去重", names[0] == "自定义" and "足控仰视V2" in names and "正面" in names, str(names)[:120])
check("无重复", len(names) == len(set(names)))

print("== 删除/导入 ==")
custom = acc._load_custom_presets()
del custom["足控仰视V2"]
acc._save_custom_presets(custom)
check("删除生效", "足控仰视V2" not in acc._load_custom_presets())
# 导入合并（模拟 import 路由逻辑）
raw = {"我的机位": {"pos_x": 0.3, "pos_y": 0, "pos_z": -0.2, "roll": 0, "extra": ""},
       "正面": {"pos_x": 9.0, "pos_y": 9.0, "pos_z": 9.0, "roll": 9.0, "extra": ""}}
custom = acc._load_custom_presets()
added = 0
skipped = 0
for name, p in raw.items():
    sname = acc._safe_preset_name(name)
    if sname in acc.PRESETS and sname not in custom:
        skipped += 1
        continue
    custom[sname] = {"pos_x": float(p["pos_x"]), "pos_y": float(p["pos_y"]), "pos_z": float(p["pos_z"]),
                     "roll": float(p["roll"]), "extra": str(p.get("extra") or "")}
    added += 1
acc._save_custom_presets(custom)
check("导入合并成功", added == 1 and skipped == 1 and "我的机位" in acc._load_custom_presets(), f"added={added} skipped={skipped}")
# 内置预设不被自定义覆盖（导入跳过）
check("内置预设未污染", acc.PRESETS["正面"]["pos_x"] == 0.0)

print("== execute 结构化输出（无 NL/预设 → manual） ==")
prompt, meta = acc.AnimaCameraControl().execute("自定义", "", 0.0, 0.0, 0.0, 0.0, "", acc.DEFAULT_CONFIG_JSON)
import json as _json
m = _json.loads(meta)
check("meta.mode=manual", m.get("mode") == "manual", meta[:120])
check("meta.pos 结构", set(m.get("pos", {}).keys()) == {"x", "y", "z", "roll"}, str(m)[:150])
check("meta.extras_enabled 齐全", set(m.get("extras_enabled", {}).keys()) == {"lens", "dof", "movement", "composition", "style"}, str(m)[:150])
prompt2, meta2 = acc.AnimaCameraControl().execute("足控仰视V2", "", 0.0, 0.0, 0.0, 0.0, "", acc.DEFAULT_CONFIG_JSON)
m2 = _json.loads(meta2)
check("自定义预设生效模式", m2.get("mode") == "preset" and m2.get("preset") == "足控仰视V2", meta2[:150])

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)