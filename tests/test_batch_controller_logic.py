# 批任务控制器纯逻辑测试（不依赖运行中 ComfyUI）
# 运行：python tests/test_batch_controller_logic.py
import os
import sys
import json
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── stub ComfyUI 依赖 ──
_folder = types.ModuleType("folder_paths")
_folder.get_input_directory = lambda: os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "input")
sys.modules["folder_paths"] = _folder

_server = types.ModuleType("server")
class _Routes:
    def __init__(self):
        self.items = []
    def get(self, path):
        return self._mk("get", path)
    def post(self, path):
        return self._mk("post", path)
    def _mk(self, method, path):
        def deco(fn):
            self.items.append((method, path, fn))
            return fn
        return deco
class _PS:
    def __init__(self):
        self.routes = _Routes()
_PS.instance = _PS()
_server.PromptServer = _PS
sys.modules["server"] = _server

# 伪包：让 anima_prompt_batch 的 `.anima_prompt_parser` 相对导入可解析
_pkg = types.ModuleType("anima_tk_batch")
_pkg.__path__ = [os.path.dirname(os.path.dirname(os.path.abspath(__file__)))]
_pkg.__package__ = "anima_tk_batch"
sys.modules["anima_tk_batch"] = _pkg

import anima_tk_batch.anima_prompt_batch as apb

PASS = 0
FAIL = 0

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")

# ── 模板注入 ──
template = {
    "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "old", "clip": ["1", 0]}},
    "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "neg old", "clip": ["1", 0]}},
    "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "anima", "images": ["7", 0]}},
    "10": {"class_type": "PreviewImage", "inputs": {"filename_prefix": "preview", "images": ["7", 0]}},
}

print("== 正向注入 ==")
p, err = apb._inject_into_template(template, {"posId": "5", "posKey": "text", "text": "new prompt"})
check("正向文本注入", err is None and p["5"]["inputs"]["text"] == "new prompt", str(err))
check("模板未被原地污染", template["5"]["inputs"]["text"] == "old", "注入函数必须深拷贝模板")

print("== 负向注入 ==")
p, err = apb._inject_into_template(template, {
    "posId": "5", "posKey": "text", "text": "pos", "negId": "6", "negKey": "text", "neg": "bad stuff"})
check("负向注入", err is None and p["6"]["inputs"]["text"] == "bad stuff", str(err))
p, err = apb._inject_into_template(template, {
    "posId": "5", "posKey": "text", "text": "pos", "negId": "6", "negKey": "text", "neg": ""})
check("空负向不碰负向节点", err is None and p["6"]["inputs"]["text"] == "neg old", str(err))

print("== 子目录覆盖 ==")
p, err = apb._inject_into_template(template, {
    "posId": "5", "posKey": "text", "text": "pos", "group": "组1 / 特写", "subfolder": True})
check("子目录注入成功", err is None, str(err))
pref9 = p["9"]["inputs"]["filename_prefix"]
pref10 = p["10"]["inputs"]["filename_prefix"]
check("SaveImage 前缀被覆盖", pref9 != "anima" and "组1" in pref9 and "特写" in pref9 and "anima" in pref9, pref9)
check("PreviewImage 前缀同步覆盖", pref10 == pref9, pref10)
t2 = {"5": {"class_type": "CLIPTextEncode", "inputs": {"text": "x"}}}
p, err = apb._inject_into_template(t2, {"posId": "5", "posKey": "text", "text": "pos", "group": "g", "subfolder": True})
check("无保存节点时报错", err is not None and "SaveImage" in err, str(err))

print("== 错误分支 ==")
p, err = apb._inject_into_template(template, {"posId": "99", "posKey": "text", "text": "x"})
check("目标节点不存在报错", err is not None and "99" in err, str(err))
p, err = apb._inject_into_template(template, {"posId": "5", "posKey": "nope", "text": "x"})
check("目标 widget 不存在报错", err is not None, str(err))

print("== 组名清洗 ==")
check("组名清洗", apb._safe_group_name("a/b:c*d") == "a_b_c_d")
check("组名防穿越", apb._safe_group_name("..") == "_")
check("组名空兜底", apb._safe_group_name("  ") == "组")

print("== 批次持久化 round-trip ==")
tmp = tempfile.mkdtemp(prefix="anima_batch_test_")
old_dir = apb.BATCH_DIR
try:
    apb.BATCH_DIR = tmp
    batch = {
        "id": "btest123", "created": 1.0, "updated": 1.0, "state": apb.BS_RUNNING,
        "node_ref": "17", "template": template,
        "jobs": [{"idx": 0, "group": "g1", "text": "a", "posId": "5", "posKey": "text",
                  "status": apb.ST_PENDING, "prompt_id": None, "error": None, "outputs": []}],
    }
    apb._save_batch(batch)
    loaded = apb._load_batch("btest123")
    check("批次写盘读回", loaded is not None and loaded["id"] == "btest123" and loaded["template"]["5"]["inputs"]["text"] == "old")
    with apb._batch_lock("btest123"):
        pass
    check("批次锁可用", True)
    # list 用临时目录
    fl = apb._batch_path("btest123")
    check("路径构造", fl.endswith("btest123.json"), fl)
finally:
    apb.BATCH_DIR = old_dir
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)