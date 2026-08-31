# 批任务后台推进冒烟：创建后不请求 status，确认服务端心跳仍能完成全部任务。
import json
import os
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8188"
BATCH_DIR = os.path.normpath(
    r"E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA\data\batches"
)
OUT_DIR = os.path.normpath(r"E:\1AI\ComfyUI-aki-v3\ComfyUI\output")


def http_json(path, data=None):
    url = BASE + path
    if data is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    template = {
        "t1": {"class_type": "SolidMask", "inputs": {"value": 0.5, "width": 64, "height": 64}},
        "t2": {"class_type": "MaskToImage", "inputs": {"mask": ["t1", 0]}},
        "t3": {"class_type": "SaveImage", "inputs": {"filename_prefix": "smoke_worker", "images": ["t2", 0]}},
        "t4": {"class_type": "StringConstant", "inputs": {"string": "placeholder"}},
    }
    batch_id = None
    outputs = []
    try:
        created = http_json("/anima/batch/run", {
            "template": template,
            "node_ref": "worker-smoke",
            "jobs": [
                {"group": "后台A", "text": "worker one", "posId": "t4", "posKey": "string"},
                {"group": "后台B", "text": "worker two", "posId": "t4", "posKey": "string"},
            ],
        })
        batch_id = created["batchId"]
        # 故意不访问 /status：如果仍依赖浏览器轮询，第二条任务会停在 pending。
        time.sleep(8)
        status = http_json(f"/anima/batch/{batch_id}/status")
        jobs = status.get("jobs") or []
        outputs = [item for job in jobs for item in (job.get("outputs") or [])]
        passed = (
            (status.get("batch") or {}).get("state") == "finished"
            and len(jobs) == 2
            and all(job.get("status") == "done" for job in jobs)
        )
        print(f"后台心跳批次：{batch_id}")
        print(f"状态：{(status.get('batch') or {}).get('state')}，任务：{[job.get('status') for job in jobs]}，输出：{len(outputs)}")
        return 0 if passed else 1
    finally:
        if batch_id:
            try:
                http_json(f"/anima/batch/{batch_id}/cancel", {})
            except Exception:
                pass
            path = os.path.join(BATCH_DIR, batch_id + ".json")
            if os.path.isfile(path):
                os.remove(path)
        for item in outputs:
            path = os.path.join(OUT_DIR, str(item.get("subfolder") or ""), str(item.get("filename") or ""))
            if os.path.isfile(path):
                os.remove(path)


if __name__ == "__main__":
    sys.exit(main())
