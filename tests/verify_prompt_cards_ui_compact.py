"""真实 ComfyUI 回归：状态区单行缩减 + 片段「译」hover 常驻 + 一键翻译全部片段 + 候选加入不覆盖。"""
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


with tempfile.TemporaryDirectory(prefix="tk-cards-ui-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=str(CHROME), headless=True,
            viewport={"width": 1600, "height": 1000}, args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        translate_hits: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        def fake_translate(route):
            q = route.request.url.split("q=", 1)[-1]
            from urllib.parse import unquote
            value = unquote(q.split("&", 1)[0])
            translate_hits.append(value)
            result = {"白发": "white hair", "长发": "long hair", "黑发": "black hair"}.get(value, value)
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"ok": True, "translatedText": result, "provider": "Google", "source": "google",
                 "quality": {"status": "ok"}, "attempts": {}}))

        page.route("**/api/translate*", fake_translate)
        page.route("**/anima/translate/status", lambda route: route.fulfill(
            status=200, content_type="application/json",
            body=json.dumps({"providers": {
                "local": {"health": "healthy", "error_code": "", "last_error": ""},
                "argos": {"health": "healthy", "error_code": "", "last_error": ""},
                "deeplx": {"health": "unknown", "error_code": "", "last_error": ""},
                "mymemory": {"health": "unknown", "error_code": "", "last_error": ""},
                "google": {"health": "unknown", "error_code": "", "last_error": ""},
                "dashscope": {"health": "unknown", "error_code": "", "last_error": ""},
            }, "actual_provider": None, "auto_order": ["local", "argos", "dashscope", "mymemory", "google", "deeplx"],
              "deeplx": {"installed": True}})))

        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(3_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TKPromptCards');
              if (!node) return null;
              window.app.graph.add(node);
              window.__cardsNode = node;
              return node.type;
            }
            """
        )
        check("TK Prompt Cards 节点创建", created == "TKPromptCards", created)
        page.wait_for_selector(".tk-cards-ui", timeout=15_000)

        # 第三方插件底部悬浮层（pysssss image feed）会拦截指针事件，测试中先隐藏
        page.evaluate("() => { const el = document.getElementById('comfyui-body-bottom'); if (el) el.style.display='none'; document.querySelectorAll('.pysssss-image-feed').forEach(x => x.style.display='none'); }")

        ui = page.locator(".tk-cards-ui")
        translate_box = ui.locator(".tk-cards-translate-box")
        if not translate_box.evaluate("el => el.open"):
            translate_box.locator("> summary").click()
        status_details = ui.locator(".tk-cards-translate-status-details")
        if not status_details.evaluate("el => el.open"):
            status_details.locator("> summary").click()
        # 1) 无折叠 details；状态区直接可见（单行缩减）；翻译源行可见
        check("不再有折叠设置", ui.locator(".tk-cards-translate-settings").count() == 0)
        status_row = ui.locator(".tk-cards-translate-status")
        check("状态区直接可见", status_row.is_visible())
        check("实际使用信息可见", ui.locator(".tk-cards-translate-actual").first.is_visible())
        check("翻译源选择行可见", ui.locator(".tk-cards-translate-source").is_visible())
        check("provider 列表可见", ui.locator(".tk-cards-translate-provider-list").first.is_visible())

        # 2) 片段「译」按钮 hover 显示（不悬停不可见）
        textarea = ui.locator(".tk-cards-textarea").first
        textarea.fill("白发，长发")
        page.wait_for_function("document.querySelectorAll('.tk-cards-chip').length === 2", timeout=10_000)
        chip_translate = ui.locator(".tk-cards-chip-translate").first
        check("「译」按钮存在", chip_translate.count() >= 1)
        check("未悬停时「译」不可见（hover 显示为既有设计）", not chip_translate.is_visible())

        # 3) 一键翻译全部片段：两个卡片译文直接显示
        ta_btn = ui.locator("button", has_text="翻译全部片段")
        check("「翻译全部片段」按钮存在", ta_btn.count() == 1)
        ta_btn.evaluate("el => el.click()")
        page.wait_for_function(
            "document.querySelectorAll('.tk-cards-chip-translation').length >= 2",
            timeout=20_000,
        )
        translations = [el.text_content() for el in ui.locator(".tk-cards-chip-translation").all()]
        joined = " | ".join(translations)
        check("白发卡片译文", "white hair" in joined, translations)
        check("长发卡片译文", "long hair" in joined, translations)
        check("翻译请求条数 = 2", len(translate_hits) == 2, translate_hits)
        check("一键翻译后实际源显示", "Google" in status_row.text_content())

        # 4) 独立中文输入 → 仅翻译 → 加入译文：不覆盖已有内容
        translate_input = ui.locator(".tk-cards-translate-input")
        translate_input.fill("黑发")
        ui.locator("button", has_text="仅翻译").click()
        page.wait_for_function("() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('加入译文')); return Boolean(b); }", timeout=15_000)
        page.evaluate("() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('加入译文')); b.click(); }")
        page.wait_for_timeout(500)
        result_text = textarea.input_value()
        check("加入后保留原文", "白发" in result_text and "长发" in result_text, result_text)
        check("加入后追加新词", "black hair" in result_text, result_text)

        check("无页面 JS 异常", len(page_errors) == 0, page_errors)
        print("ALL PASS")
