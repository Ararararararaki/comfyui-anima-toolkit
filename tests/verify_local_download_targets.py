"""验证 TK Toolkit 本地工具箱 URL 下载弹窗的模型目录选择。"""
from __future__ import annotations

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
        page.screenshot(path=str(ROOT / ".scratch" / "tk-local-download-targets.png"), full_page=True)
        check("本地工具箱页面无 JS 异常", not page_errors, page_errors[:5])
        context.close()
