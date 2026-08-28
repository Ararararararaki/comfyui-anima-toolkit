"""验证 TK Toolkit 本地工具箱 URL 下载弹窗的模型目录选择。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
APP_URL = "http://127.0.0.1:8188/extensions/ComfyUI-Anima-Batch-LoRA/app/"
sys.stdout.reconfigure(encoding="utf-8")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-local-download-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=str(CHROME), headless=True,
            viewport={"width": 1600, "height": 1000}, args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(APP_URL, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_selector("#localUrlBtn", timeout=30_000)
        page.locator("#localUrlBtn").click(force=True)
        page.wait_for_selector(".ld-modal", timeout=8_000)
        page.wait_for_function("document.querySelectorAll('#ld-target option').length >= 4", timeout=10_000)
        labels = page.locator("#ld-target option").all_text_contents()
        check("本地工具箱 URL 下载支持目录选择", len(labels) >= 4 and any("Checkpoint" in label for label in labels), labels)
        check("本地工具箱可看到 Checkpoint 目录", any("models\\checkpoints" in label for label in labels), labels)
        page.locator("#ld-target").select_option("checkpoints:0")
        check("本地工具箱可选中 Checkpoint 目录", page.locator("#ld-target").input_value() == "checkpoints:0")
        queue_requests: list[dict] = []
        cancel_requests: list[str] = []
        page.route("**/anima/lora/download/queue", lambda route: (
            queue_requests.append(json.loads(route.request.post_data or "{}")) or route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ok": True, "jobs": [{"progressId": "toolkit-ui-smoke-1", "label": "ui-smoke", "status": "queued"}]}),
            )
        ))
        page.route("**/anima/lora/download/list", lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"ok": True, "jobs": []})
        ))
        page.route("**/anima/lora/download/status*", lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"progressId": "toolkit-ui-smoke-1", "done": 100, "total": 100, "status": "done", "filename": "ui-smoke.safetensors"}),
        ))
        page.route("**/anima/lora/download/cancel*", lambda route: (
            cancel_requests.append(route.request.url) or route.fulfill(
                status=200, content_type="application/json", body=json.dumps({"ok": True})
            )
        ))
        page.locator(".ld-urls").fill("https://civitai.com/models/123456/ui-smoke")
        page.locator(".ld-start").click()
        page.wait_for_function("document.querySelector('.ld-log')?.textContent.includes('已加入后台下载')", timeout=8_000)
        page.wait_for_function("[...document.querySelectorAll('.ld-pct')].at(-1)?.textContent === '✓'", timeout=8_000)
        check("Toolkit 下载提交到后台队列", len(queue_requests) == 1 and len(queue_requests[0].get("items", [])) == 1, queue_requests)
        check("Toolkit 下载任务完成状态可显示", page.locator(".ld-pct").last.inner_text() == "✓")
        page.locator(".ld-cancel").click()
        check("关闭 Toolkit 下载窗口不取消后台任务", not cancel_requests, cancel_requests)
        page.screenshot(path=str(ROOT / ".scratch" / "tk-local-download-targets.png"), full_page=True)
        check("本地工具箱页面无 JS 异常", not page_errors, page_errors[:5])
        context.close()
