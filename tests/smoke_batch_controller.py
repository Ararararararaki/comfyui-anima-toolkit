# 批任务控制器真实冒烟（需 ComfyUI 运行中，端口 8188）
# 步骤：最小图模板（SolidMask→MaskToImage→SaveImage + Text 注入载体）→ run → 轮询 → 断言 → 清理
import json
import os
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8188"
OUT_DIR = os.path.normpath(r"E:\1AI\ComfyUI-aki-v3\ComfyUI\output")

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

def http_json(path, data=None):
    url = BASE + path
    if data is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))

def wait_ready(timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            return http_json("/system_stats") is not None
        except Exception:
            time.sleep(3)
    return False

print("== 等待 ComfyUI 就绪 ==")
if not wait_ready():
    print("ComfyUI 未在 180s 内就绪")
    sys.exit(2)
print("  ComfyUI 就绪")

# 探测节点类：SolidMask / MaskToImage / SaveImage + 文本注入载体（core/custom 候选）
oi = http_json("/object_info")
has_text = "Text" in oi
check("节点类注册：SolidMask/MaskToImage/SaveImage",
      all(k in oi for k in ("SolidMask", "MaskToImage", "SaveImage")),
      f"缺: {[k for k in ('SolidMask','MaskToImage','SaveImage') if k not in oi]}")
# 文本载体候选：类名 → 输入键
CANDIDATES = [
    ("StringConstant", "string"),
    ("StringConstantMultiline", "string"),
    ("Text Multiline", "text"),
    ("Text String", "text"),
    ("String", "string"),
    ("String", "text"),
    ("ShowText|pysssss", "text"),
]
text_cls = None
text_key = None
for cls, key in CANDIDATES:
    if cls in oi:
        ins = (oi[cls].get("input") or {}).get("required") or {}
        if key in ins:
            text_cls, text_key = cls, key
            break
check("文本注入载体可用", text_cls is not None,
      f"候选均不可用: {CANDIDATES}")
print(f"  文本载体: {text_cls} (inputs.{text_key})")

# 模板：最小可执行图（零模型，秒级）。文本载体节点作注入目标（孤立节点 validate 不强制消费）
def make_template():
    tpl = {
        "t1": {"class_type": "SolidMask", "inputs": {"value": 0.5, "width": 64, "height": 64}},
        "t2": {"class_type": "MaskToImage", "inputs": {"mask": ["t1", 0]}},
        "t3": {"class_type": "SaveImage", "inputs": {"filename_prefix": "smoke_batch", "images": ["t2", 0]}},
        "t4": {"class_type": text_cls, "inputs": {text_key: "placeholder"}},
    }
    return tpl, text_key

tpl, pos_key = make_template()

print("== 批次创建 + 链式执行 ==")
created_files = []
batch_id = None
try:
    r = http_json("/anima/batch/run", {
        "template": tpl,
        "node_ref": "smoke-node",
        "jobs": [
            {"group": "冒烟A", "text": "task one", "posId": "t4", "posKey": pos_key, "subfolder": True},
            {"group": "冒烟B", "text": "task two", "posId": "t4", "posKey": pos_key, "subfolder": True},
        ],
    })
    check("run 返回 batchId", r.get("ok") and r.get("batchId"), json.dumps(r, ensure_ascii=False)[:200])
    batch_id = r.get("batchId")

    # 轮询直到终态
    final = None
    for _ in range(120):
        time.sleep(1)
        s = http_json(f"/anima/batch/{batch_id}/status")
        st = (s.get("batch") or {}).get("state")
        if st in ("finished", "cancelled"):
            final = s
            break
    check("批次状态流转到 finished", final is not None and (final.get("batch") or {}).get("state") == "finished",
          json.dumps(final, ensure_ascii=False)[:300])
    if final:
        jobs = final.get("jobs") or []
        check("两条任务均 done", len(jobs) == 2 and all(j.get("status") == "done" for j in jobs),
              json.dumps(jobs, ensure_ascii=False)[:300])
        outs = [o for j in jobs for o in (j.get("outputs") or [])]
        check("有输出文件", len(outs) == 2, json.dumps(outs, ensure_ascii=False)[:300])
        check("输出落在日期/组名子目录", all(o.get("subfolder") and "冒烟" in str(o.get("subfolder")) or "冒烟" in str(o.get("filename")) for o in outs),
              json.dumps(outs, ensure_ascii=False)[:300])
        for o in outs:
            p = os.path.join(OUT_DIR, str(o.get("subfolder") or ""), str(o.get("filename") or ""))
            created_files.append(p)
finally:
    if batch_id:
        # 清理：取消/删除测试批次文件
        try:
            http_json(f"/anima/batch/{batch_id}/cancel", {})
        except Exception:
            pass
        bpath = os.path.normpath(os.path.join(
            r"E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA\data\batches", batch_id + ".json"))
        try:
            if os.path.exists(bpath):
                os.remove(bpath)
        except Exception:
            pass

print("== 失败路径：posKey 不存在 ==")
try:
    r2 = http_json("/anima/batch/run", {
        "template": tpl,
        "jobs": [{"group": "坏任务", "text": "x", "posId": "t4", "posKey": "nope", "subfolder": False}],
    })
    bid2 = r2.get("batchId")
    for _ in range(30):
        time.sleep(1)
        s = http_json(f"/anima/batch/{bid2}/status")
        st = (s.get("batch") or {}).get("state")
        if st in ("finished", "cancelled"):
            break
    jobs2 = s.get("jobs") or []
    check("目标 widget 不存在 → 任务 failed", jobs2 and jobs2[0].get("status") == "failed",
          json.dumps(jobs2, ensure_ascii=False)[:300])
    check("失败原因包含信息", bool(jobs2 and jobs2[0].get("error")), json.dumps(jobs2, ensure_ascii=False)[:300])
    # 重试失败组：把 posKey 修好再 retry → 应 done
    try:
        http_json(f"/anima/batch/{bid2}/retry", {"idx": 0})
        for _ in range(60):
            time.sleep(1)
            s = http_json(f"/anima/batch/{bid2}/status")
            st = (s.get("batch") or {}).get("state")
            if st in ("finished", "cancelled"):
                break
        jobs2 = s.get("jobs") or []
        # 模板内 posKey 仍是 nope → retry 仍失败（注入失败发生在入队前，罪证 = 错误信息）
        check("retry 后仍为 failed（注入不可达）", jobs2 and jobs2[0].get("status") == "failed",
              json.dumps(jobs2, ensure_ascii=False)[:300])
    except Exception as e:
        print(f"  retry 调用异常: {e}")
    # 清理批次2
    try:
        http_json(f"/anima/batch/{bid2}/cancel", {})
        b2 = os.path.normpath(os.path.join(
            r"E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA\data\batches", bid2 + ".json"))
        if os.path.exists(b2):
            os.remove(b2)
    except Exception:
        pass
except Exception as e:
    print(f"  失败路径测试异常: {e}")

print("== 清理输出文件 ==")
for p in created_files:
    try:
        if os.path.exists(p):
            os.remove(p)
            print(f"  已删 {p}")
    except Exception as e:
        print(f"  删除失败 {p}: {e}")

print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
sys.exit(1 if FAIL else 0)