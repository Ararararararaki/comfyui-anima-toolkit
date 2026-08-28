"""验证 TK LoRA/模型下载弹窗的目标目录选择，不发起真实大文件下载。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
sys.stdout.reconfigure(encoding="utf-8")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-download-targets-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=str(CHROME), headless=True,
            viewport={"width": 1600, "height": 1000}, args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(5_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TK Batch LoRA Loader');
              if (!node) return null;
              window.app.graph.add(node);
              window.__downloadNode = node;
              return node.type;
            }
            """
        )
        check("TK 批量 LoRA 节点创建", created == "TK Batch LoRA Loader", created)
        page.wait_for_selector(".anima-lora-widget", timeout=15_000)
        page.evaluate("() => document.querySelector('.anima-lora-widget .toolbar .btn-browse')?.click()")
        page.wait_for_selector(".bm-modal", timeout=8_000)
        page.locator(".bm-url").click()
        page.wait_for_selector(".bd-target", timeout=8_000)
        page.wait_for_function("document.querySelectorAll('.bd-target option').length >= 4", timeout=8_000)
        target_state = page.evaluate(
            """
            () => {
              const select = document.querySelector('.bd-target');
              return {
                options: [...(select?.options || [])].map(option => ({ value: option.value, label: option.textContent || '' })),
                value: select?.value || '',
                heading: document.querySelector('.bd-modal h3')?.textContent || document.querySelector('.bd-modal')?.textContent || '',
              };
            }
            """
        )
        labels = [item["label"] for item in target_state["options"]]
        check("下载弹窗支持目录选择", len(labels) >= 4 and any("Checkpoint" in label for label in labels), target_state)
        check("Checkpoint 目录映射可见", any("models\\checkpoints" in label for label in labels), labels)
        page.locator(".bd-target").select_option("checkpoints:0")
        check("可选中 Checkpoint 目录", page.locator(".bd-target").input_value() == "checkpoints:0", target_state)

        queue_requests: list[dict] = []
        cancel_requests: list[str] = []
        page.route("**/anima/lora/download/queue", lambda route: (
            queue_requests.append(json.loads(route.request.post_data or "{}")) or route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ok": True, "jobs": [{"progressId": "ui-smoke-1", "label": "ui-smoke", "status": "queued"}]}),
            )
        ))
        page.route("**/anima/lora/download/list", lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"ok": True, "jobs": []})
        ))
        page.route("**/anima/lora/download/status*", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"progressId": "ui-smoke-1", "done": 100, "total": 100, "status": "done", "filename": "ui-smoke.safetensors"}),
        ))
        page.route("**/anima/lora/download/cancel*", lambda route: (
            cancel_requests.append(route.request.url) or route.fulfill(
                status=200, content_type="application/json", body=json.dumps({"ok": True})
            )
        ))
        page.locator(".bd-urls").fill("https://civitai.com/models/123456/ui-smoke")
        page.locator(".bd-start").click()
        page.wait_for_function("document.querySelector('.bd-log')?.textContent.includes('已加入后台下载')", timeout=8_000)
        page.wait_for_function("[...document.querySelectorAll('.bd-pct')].at(-1)?.textContent === '✓'", timeout=8_000)
        check("节点下载提交到后台队列", len(queue_requests) == 1 and len(queue_requests[0].get("items", [])) == 1, queue_requests)
        check("节点下载任务完成状态可显示", page.locator(".bd-pct").last.inner_text() == "✓")
        page.locator(".bd-cancel").click()
        check("关闭节点下载窗口不取消后台任务", not cancel_requests, cancel_requests)
        page.screenshot(path=str(ROOT / ".scratch" / "tk-download-targets.png"), full_page=True)
        check("页面无 JS 异常", not page_errors, page_errors[:5])
        context.close()
