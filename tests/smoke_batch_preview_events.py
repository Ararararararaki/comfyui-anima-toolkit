"""真实 ComfyUI 回归：批量任务必须把预览/执行事件发回发起浏览器。

前提：本机 ComfyUI 运行在 8188。测试使用零模型工作流，监听 ComfyUI websocket，
断言 PreviewImage 的 executed 事件包含当前批次 prompt_id 和图片数据。
"""

import json
import os
import sys
import time
import urllib.request
import uuid

import websocket


BASE = "http://127.0.0.1:8188"
WS_BASE = "ws://127.0.0.1:8188/ws"
BATCH_DIR = os.path.normpath(
    r"E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA\data\batches"
)
TEMP_DIR = os.path.normpath(r"E:\1AI\ComfyUI-aki-v3\ComfyUI\temp")


def http_json(path, data=None):
    url = BASE + path
    if data is None:
        request = urllib.request.Request(url)
    else:
        request = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def drain_socket(ws):
    messages = []
    while True:
        try:
            messages.append(ws.recv())
        except websocket.WebSocketTimeoutException:
            return messages


def main():
    client_id = uuid.uuid4().hex
    ws = websocket.create_connection(
        f"{WS_BASE}?clientId={client_id}",
        timeout=0.5,
        origin=BASE,
    )
    ws.send(json.dumps({"type": "feature_flags", "data": {}}))
    drain_socket(ws)

    template = {
        "t1": {"class_type": "SolidMask", "inputs": {"value": 0.5, "width": 64, "height": 64}},
        "t2": {"class_type": "MaskToImage", "inputs": {"mask": ["t1", 0]}},
        "t3": {"class_type": "PreviewImage", "inputs": {"images": ["t2", 0]}},
    }
    batch_id = None
    prompt_id = None
    outputs = []
    events = []
    try:
        created = http_json(
            "/anima/batch/run",
            {
                "template": template,
                "node_ref": "preview-event-smoke",
                "client_id": client_id,
                "jobs": [
                    {
                        "group": "预览事件回归",
                        "patches": [{"nodeId": "t1", "input": "value", "value": 0.5}],
                    }
                ],
            },
        )
        batch_id = created["batchId"]

        deadline = time.time() + 30
        final = None
        while time.time() < deadline:
            try:
                message = ws.recv()
                events.append(message)
            except websocket.WebSocketTimeoutException:
                pass
            status = http_json(f"/anima/batch/{batch_id}/status")
            jobs = status.get("jobs") or []
            if jobs and jobs[0].get("prompt_id"):
                prompt_id = jobs[0]["prompt_id"]
            state = (status.get("batch") or {}).get("state")
            if state in ("finished", "failed", "cancelled"):
                final = status
                outputs = [o for job in jobs for o in (job.get("outputs") or [])]
                break

        # 状态接口先落盘并不代表 websocket 已经把同一任务的最后几条事件
        # 发完；把当前 socket 中的事件排空，避免测试自身截断 executed。
        events.extend(drain_socket(ws))

        parsed_events = []
        for item in events:
            if not isinstance(item, str):
                continue
            try:
                parsed_events.append(json.loads(item))
            except json.JSONDecodeError:
                continue
        event_prompt_ids = [
            (event.get("data") or {}).get("prompt_id")
            for event in parsed_events
            if event.get("type") in {"execution_start", "executed", "execution_success"}
        ]
        full_prompt_id = next(
            (value for value in event_prompt_ids if value and str(value).startswith(str(prompt_id))),
            prompt_id,
        )
        executed = []
        lifecycle = []
        for event in parsed_events:
            if event.get("type") == "executed":
                data = event.get("data") or {}
                if data.get("prompt_id") == full_prompt_id:
                    executed.append(data)
            if event.get("type") in {"execution_start", "execution_success", "execution_error"}:
                lifecycle.append(event)

        has_preview_output = any(
            isinstance(item.get("output"), dict)
            and item["output"].get("images")
            for item in executed
        )
        passed = bool(final and (final.get("batch") or {}).get("state") == "finished")
        passed = passed and bool(prompt_id) and bool(executed) and has_preview_output
        print(f"client_id={client_id}")
        print(f"prompt_id={full_prompt_id}")
        print(f"batch_state={(final.get('batch') or {}).get('state') if final else None}")
        print(f"lifecycle={[item.get('type') for item in lifecycle]}")
        print(f"executed_preview={len(executed)}")
        print(f"outputs={len(outputs)}")
        if not passed:
            print("events_without_binary_preview=[executed is the standard PreviewImage event]")
        return 0 if passed else 1
    finally:
        try:
            ws.close()
        except Exception:
            pass
        if batch_id:
            try:
                http_json(f"/anima/batch/{batch_id}/cancel", {})
            except Exception:
                pass
            batch_path = os.path.join(BATCH_DIR, batch_id + ".json")
            if os.path.isfile(batch_path):
                os.remove(batch_path)
        for item in outputs:
            filename = str(item.get("filename") or "")
            subfolder = str(item.get("subfolder") or "")
            path = os.path.join(TEMP_DIR, subfolder, filename)
            if os.path.isfile(path):
                os.remove(path)


if __name__ == "__main__":
    sys.exit(main())
