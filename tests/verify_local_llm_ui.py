"""前端回归：本地 LLM 管理按钮 + 弹窗（显示模型/许可/已加载状态）。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
sys.stdout.reconfigure(encoding="utf-8")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-llm-ui-") as profile:
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
        page.wait_for_timeout(3000)
        created = page.evaluate(
            """() => { const n = LiteGraph.createNode('TKPromptCards'); if (!n) return null;
                window.app.graph.add(n); window.__cardsNode = n; return n.type; }"""
        )
        check("节点创建", created == "TKPromptCards", created)
        page.wait_for_selector(".tk-cards-ui", timeout=15_000)

        ui = page.locator(".tk-cards-ui")
        translate_box = ui.locator(".tk-cards-translate-box")
        if not translate_box.evaluate("el => el.open"):
            translate_box.locator("> summary").click()
        status_details = ui.locator(".tk-cards-translate-status-details")
        if not status_details.evaluate("el => el.open"):
            status_details.locator("> summary").click()
        page.wait_for_selector(".tk-cards-ui [data-a='manage-local-llm']", timeout=15_000)
        llm_btn = ui.locator('[data-a="toggle-local-llm"]')
        manage_btn = ui.locator('[data-a="manage-local-llm"]')
        check("状态行有本地LLM操作按钮", llm_btn.count() == 1 and manage_btn.count() == 1)
        check("按钮显示模型操作标签", any(label in (llm_btn.text_content() or "") for label in ("启用 Gemma", "释放 Gemma")), llm_btn.text_content())
        check("按钮显示模型管理标签", manage_btn.text_content() == "管理模型", manage_btn.text_content())

        manage_btn.first.click()
        page.wait_for_selector(".tk-cards-llm-box", timeout=10_000)
        box_text = page.locator(".tk-cards-llm-box").text_content()
        check("弹窗列出 TranslateGemma", "TranslateGemma" in box_text)
        check("弹窗列出 Qwen3", "Qwen3" in box_text)
        check("弹窗不残留 NLLB", "NLLB" not in box_text)
        check("弹窗注明普通启动不加载", "普通启动不加载" in box_text and "按需加载" in box_text)
        check("模型列表含 qwen3-4b/gemma-4b 两项", "qwen3-4b" in box_text and "gemma-4b" in box_text, box_text[:200])
        check("未加载时有启用按钮", page.locator('.tk-cards-llm-box [data-a="load"]').count() == 2)
        check("无页面 JS 异常", len(page_errors) == 0, page_errors)
        print("ALL PASS")
