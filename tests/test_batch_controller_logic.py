# 批任务控制器纯逻辑测试（不依赖运行中 ComfyUI）
# 运行：python tests/test_batch_controller_logic.py
import os
import sys
import json
import tempfile
import types
import asyncio
import time

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

print("== 画廊单卡输入补丁 ==")
gallery_template = {
    "17": {"class_type": "DanbooruGallery", "inputs": {"selection_data": "old selection"}},
    "18": {"class_type": "SaveImage", "inputs": {"filename_prefix": "anima", "images": ["17", 0]}},
}
gallery_job = {
    "group": "D站图片 1",
    "patches": [{
        "nodeId": "17",
        "input": "selection_data",
        "value": '{"selections":[{"image_url":"https://danbooru.donmai.us/data/one.png"}]}',
    }],
}
p, err = apb._inject_into_template(gallery_template, gallery_job)
check("画廊补丁任务不需要文本目标", err is None and "danbooru.donmai.us/data/one.png" in p["17"]["inputs"]["selection_data"], str(err))
check("补丁模板未被原地污染", gallery_template["17"]["inputs"]["selection_data"] == "old selection", "补丁注入必须深拷贝模板")
p, err = apb._inject_into_template(gallery_template, {
    "patches": [{"nodeId": "99", "input": "selection_data", "value": "x"}],
})
check("补丁目标节点不存在报错", err is not None and "99" in err, str(err))
p, err = apb._inject_into_template(gallery_template, {
    "patches": [{"nodeId": "17", "input": "missing", "value": "x"}],
})
check("补丁输入不存在报错", err is not None and "missing" in err, str(err))
p, err = apb._inject_into_template(gallery_template, {"text": ""})
check("空补丁任务报错", err is not None and "缺少" in err, str(err))

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

print("== 链式批次只推进一条在途任务 ==")
advance_calls = []
old_enqueue = apb._enqueue_job

async def fake_enqueue(batch, job):
    advance_calls.append(job["idx"])
    job["prompt_id"] = f"fake-{job['idx']}"
    job["status"] = apb.ST_QUEUED

try:
    apb._enqueue_job = fake_enqueue
    chain = {
        "id": "bchain", "state": apb.BS_RUNNING,
        "jobs": [
            {"idx": 0, "status": apb.ST_PENDING, "prompt_id": None},
            {"idx": 1, "status": apb.ST_PENDING, "prompt_id": None},
        ],
    }
    asyncio.run(apb._advance_batch(chain))
    check("第一次只入队第一项", advance_calls == [0] and chain["jobs"][0]["status"] == apb.ST_QUEUED and chain["jobs"][1]["status"] == apb.ST_PENDING, advance_calls)
    chain["jobs"][0]["status"] = apb.ST_DONE
    asyncio.run(apb._advance_batch(chain))
    check("第一项完成后才入队第二项", advance_calls == [0, 1] and chain["jobs"][1]["status"] == apb.ST_QUEUED, advance_calls)
finally:
    apb._enqueue_job = old_enqueue

print("== 后端批次心跳不依赖浏览器轮询 ==")
worker_batch = {
    "id": "bworker", "state": apb.BS_RUNNING,
    "jobs": [
        {"idx": 0, "status": apb.ST_QUEUED, "prompt_id": "p0"},
        {"idx": 1, "status": apb.ST_PENDING, "prompt_id": None},
    ],
}
worker_sync_calls = []
worker_enqueue_calls = []
old_load = apb._load_batch
old_sync = apb._sync_job_status
old_enqueue = apb._enqueue_job

def fake_worker_load(batch_id):
    return worker_batch if batch_id == "bworker" else None

def fake_worker_sync(batch):
    worker_sync_calls.append(True)
    batch["jobs"][0]["status"] = apb.ST_DONE
    return True

async def fake_worker_enqueue(batch, job):
    worker_enqueue_calls.append(job["idx"])
    job["status"] = apb.ST_QUEUED
    job["prompt_id"] = "p1"

try:
    apb._load_batch = fake_worker_load
    apb._sync_job_status = fake_worker_sync
    apb._enqueue_job = fake_worker_enqueue
    keep_running = asyncio.run(apb._batch_worker_tick("bworker"))
    check("后端心跳可独立刷新批次", keep_running and worker_sync_calls == [True], worker_sync_calls)
    check("无浏览器状态请求也会推进下一条", worker_enqueue_calls == [1], worker_enqueue_calls)
finally:
    apb._load_batch = old_load
    apb._sync_job_status = old_sync
    apb._enqueue_job = old_enqueue

print("== 队列状态短暂缺失不立即判中断 ==")
class EmptyQueue:
    def get_current_queue_volatile(self):
        return [], []
    def get_history(self, prompt_id=None):
        return {}

queue_batch = {"jobs": [{"idx": 0, "status": apb.ST_QUEUED, "prompt_id": "p-missing"}]}
old_prompt_queue = _PS.instance.prompt_queue if hasattr(_PS.instance, "prompt_queue") else None
_PS.instance.prompt_queue = EmptyQueue()
old_grace = apb._BATCH_MISSING_GRACE_SECONDS
try:
    apb._BATCH_MISSING_GRACE_SECONDS = 60.0
    first_missing = apb._sync_job_status(queue_batch)
    check("第一次队列缺失只记录观察时间", first_missing and queue_batch["jobs"][0]["status"] == apb.ST_QUEUED and "_missing_since" in queue_batch["jobs"][0], queue_batch)
    queue_batch["jobs"][0]["_missing_since"] = time.time() - 61
    second_missing = apb._sync_job_status(queue_batch)
    check("持续缺失超过缓冲才标记中断", second_missing and queue_batch["jobs"][0]["status"] == apb.ST_INTERRUPTED, queue_batch)
finally:
    apb._BATCH_MISSING_GRACE_SECONDS = old_grace
    if old_prompt_queue is None:
        delattr(_PS.instance, "prompt_queue")
    else:
        _PS.instance.prompt_queue = old_prompt_queue

print("== 预览事件客户端关联 ==")
class RecordingQueue:
    def __init__(self):
        self.items = []

    def put(self, item):
        self.items.append(item)

recording_queue = RecordingQueue()
fake_execution = types.ModuleType("execution")

async def fake_validate_prompt(prompt_id, prompt, partial_execution_list):
    return True, None, ["output-node"], {}

fake_execution.validate_prompt = fake_validate_prompt
fake_execution.SENSITIVE_EXTRA_DATA_KEYS = set()
old_execution = sys.modules.get("execution")
old_queue = getattr(_PS.instance, "prompt_queue", None)
sys.modules["execution"] = fake_execution
_PS.instance.prompt_queue = recording_queue
try:
    preview_pid, preview_error = asyncio.run(apb._queue_prompt_inner(
        {"output-node": {"class_type": "PreviewImage", "inputs": {}}},
        {}, "bpreview", 0, 1.0, client_id="browser-preview-client"))
    queued_extra_data = recording_queue.items[0][3] if recording_queue.items else {}
    check(
        "批量入队保留 ComfyUI client_id",
        preview_error is None and preview_pid and queued_extra_data.get("client_id") == "browser-preview-client",
        str((preview_pid, preview_error, queued_extra_data)),
    )
finally:
    if old_execution is None:
        sys.modules.pop("execution", None)
    else:
        sys.modules["execution"] = old_execution
    if old_queue is None:
        delattr(_PS.instance, "prompt_queue")
    else:
        _PS.instance.prompt_queue = old_queue

print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)
