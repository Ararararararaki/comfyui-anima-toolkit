"""真实 ComfyUI 回归：当前提示词卡片隐藏/恢复，以及只翻译未翻译片段。"""
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


with tempfile.TemporaryDirectory(prefix="tk-cards-visibility-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(CHROME),
            headless=True,
            viewport={"width": 1600, "height": 1000},
            args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        translate_hits: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        cards_payload = {
            "version": 2,
            "categories": [{"id": "card_all", "name": "通用", "sortOrder": 0}],
            "cards": [
                {"id": "card-white", "en": "white hair", "zh": "白发", "categories": ["card_all"]},
                {"id": "card-long", "en": "long hair", "zh": "", "categories": ["card_all"]},
            ],
        }

        def fake_cards(route):
            if route.request.method == "GET":
                route.fulfill(status=200, content_type="application/json", body=json.dumps(cards_payload, ensure_ascii=False))
            else:
                route.continue_()

        def fake_translate(route):
            from urllib.parse import unquote

            value = unquote(route.request.url.split("q=", 1)[-1].split("&", 1)[0])
            translate_hits.append(value)
            result = {"long hair": "长发"}.get(value, value)
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ok": True, "translatedText": result, "provider": "Google", "source": "google"}),
            )

        page.route("**/anima/cards*", fake_cards)
        page.route("**/api/translate*", fake_translate)
        page.route(
            "**/anima/translate/status",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"providers": {}, "auto_order": []}),
            ),
        )
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(2_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TKPromptCards');
              if (!node) return null;
              window.app.graph.add(node);
              return node.type;
            }
            """
        )
        check("TK Prompt Cards 节点创建", created == "TKPromptCards", created)
        page.wait_for_selector(".tk-cards-ui", timeout=15_000)
        page.evaluate(
            """
            () => {
              const el = document.getElementById('comfyui-body-bottom');
              if (el) el.style.display = 'none';
              document.querySelectorAll('.pysssss-image-feed').forEach(x => x.style.display = 'none');
            }
            """
        )

        ui = page.locator(".tk-cards-ui")
        textarea = ui.locator(".tk-cards-textarea").first
        textarea.fill("white hair, long hair")
        page.wait_for_function("document.querySelectorAll('.tk-cards-chip').length === 2", timeout=10_000)
        page.wait_for_timeout(300)
        textarea.press("Escape")

        hide = ui.locator('[data-piece-action="visibility"]').first
        check("每个当前提示词片段都有隐藏按钮", hide.count() == 1)
        ui.locator('.tk-cards-chip').first.hover()
        hide.click()
        page.wait_for_function("document.querySelector('.tk-cards-textarea').value === 'long hair'", timeout=10_000)
        check("隐藏片段从上方 Prompt 消失", textarea.input_value() == "long hair", textarea.input_value())
        check("隐藏片段仍保留在下方卡片", ui.locator('.tk-cards-chip').count() == 2)
        check("隐藏状态有明确视觉标记", ui.locator('.tk-cards-chip.is-hidden').count() == 1)
        ui.locator('.tk-cards-chip').first.hover()
        ui.locator('[data-piece-action="visibility"]').first.click()
        page.wait_for_function("document.querySelector('.tk-cards-textarea').value === 'white hair, long hair'", timeout=10_000)
        check("恢复片段重新进入上方 Prompt", textarea.input_value() == "white hair, long hair", textarea.input_value())
        check("恢复后清除隐藏视觉标记", ui.locator('.tk-cards-chip.is-hidden').count() == 0)

        pending = ui.locator("button", has_text="翻译未翻译片段")
        check("存在翻译未翻译片段按钮", pending.count() == 1)
        pending.click()
        page.wait_for_function("document.querySelectorAll('.tk-cards-chip-translation').length >= 1", timeout=20_000)
        check("只翻译未翻译片段", translate_hits == ["long hair"], translate_hits)
        check("翻译结果显示在对应卡片", "译：长发" in (ui.text_content() or ""), ui.text_content())
        check("无页面 JS 异常", not page_errors, page_errors[:5])
        print("ALL PASS")
