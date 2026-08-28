"""真实 ComfyUI 回归：②区独立中文输入、Danbooru 候选选择、单条翻译和联想不遮挡输入。"""
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


with tempfile.TemporaryDirectory(prefix="tk-prompt-translate-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=str(CHROME), headless=True,
            viewport={"width": 1600, "height": 1000}, args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        translate_urls: list[str] = []
        semantic_requests: list[str] = []
        resolve_requests: list[str] = []
        glossary_posts: list[dict] = []

        def track_request(request):
            if "/anima/danbooru/resolve" in request.url:
                resolve_requests.append(request.url)

        page.on("request", track_request)

        def fake_translate(route):
            translate_urls.append(route.request.url)
            q = route.request.url.split("q=", 1)[-1]
            from urllib.parse import unquote
            value = unquote(q.split("&", 1)[0])
            if value == "双脚被绑着挂起":
                route.fulfill(status=502, content_type="application/json", body=json.dumps({"ok": False, "error": "翻译源不可用"}))
                return
            result = {"白发": "white hair", "长发": "long hair", "white hair": "白发"}.get(value, value)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "translatedText": result, "provider": "google", "source": "google", "quality": {"status": "ok"}}))

        def fake_semantic(route):
            semantic_requests.append(json.loads(route.request.post_data or "{}").get("query", ""))
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "tags": [
                    {"name": "bound_feet", "cn_name": "被绑住的脚", "post_count": 321, "category": 0, "score": 0.91},
                    {"name": "hanging", "cn_name": "悬挂", "post_count": 654, "category": 0, "score": 0.84},
                ],
                "query": "双脚被绑着挂起",
            }))

        def fake_glossary(route):
            glossary_posts.append(json.loads(route.request.post_data or "{}"))
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))

        page.route("**/api/translate*", fake_translate)
        page.route("**/danbooru_anima/vec_search*", fake_semantic)
        page.route("**/anima/translate/glossary*", fake_glossary)
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

        ui = page.locator(".tk-cards-ui")
        current = ui.locator(".tk-cards-textarea").first
        chinese = ui.locator(".tk-cards-translate-input")
        source = ui.locator(".tk-cards-translate-source select")
        check("②区存在独立中文输入框", chinese.count() == 1)
        check("②区可以手动选择翻译源", source.count() == 1)
        source.select_option("google")
        check("翻译源选择会记忆", page.evaluate("() => localStorage.getItem('anima_tk_cards_translate_source_v1')") == "google")
        current.fill("portrait")
        chinese.fill("白发")
        ui.get_by_role("button", name="仅翻译").evaluate("el => el.click()")
        page.wait_for_selector(".tk-cards-resolve-translation", timeout=30_000)
        check("仅翻译不初始化 BGE-M3", not semantic_requests, semantic_requests)
        page.locator(".tk-cards-resolve-translation").fill("white hair")
        ui.get_by_role("button", name="保存译文").evaluate("el => el.click()")
        page.wait_for_timeout(250)
        check("手动译文可保存到用户词典", glossary_posts and glossary_posts[-1].get("translated_text") == "white hair", glossary_posts)

        chinese.fill("白发, 长发")
        ui.get_by_role("button", name="翻译并校准").evaluate("el => el.click()")
        page.wait_for_selector(".tk-cards-resolve-candidate", timeout=30_000)
        check("中文输入生成规范候选", page.locator(".tk-cards-resolve-candidate").count() >= 2)
        check("手动翻译源传给后端", any("source=google" in url for url in translate_urls), translate_urls)
        labels = page.locator(".tk-cards-resolve-tags strong").all_text_contents()
        check("候选展示使用 Anima 空格格式", any("white hair" in label for label in labels), labels)
        page.locator('.tk-cards-resolve-candidate').filter(has_text="white hair").first.evaluate("el => el.click()")
        page.wait_for_timeout(300)
        prompt_after_first = current.input_value()
        check("选择候选加入当前提示词", prompt_after_first == "portrait, white hair", prompt_after_first)
        check("加入结果不含 Danbooru 下划线", "white_hair" not in prompt_after_first, prompt_after_first)

        chinese.fill("长发")
        ui.get_by_role("button", name="翻译并校准").evaluate("el => el.click()")
        page.wait_for_selector(".tk-cards-resolve-candidate", timeout=30_000)
        page.locator('.tk-cards-resolve-candidate').filter(has_text="long hair").first.evaluate("el => el.click()")
        page.wait_for_timeout(300)
        prompt_after_second = current.input_value()
        check("多条候选用英文逗号连接", prompt_after_second == "portrait, white hair, long hair", prompt_after_second)

        chinese.fill("双脚被绑着挂起")
        ui.get_by_role("button", name="翻译并校准").evaluate("el => el.click()")
        page.wait_for_selector(".tk-cards-resolve-candidate", timeout=30_000)
        natural_status = page.locator(".tk-cards-resolve-source span").first.text_content() or ""
        check("自然语言翻译失败不回显中文原文", "双脚被绑着挂起" not in natural_status and ("未返回英文" in natural_status or "翻译源不可用" in natural_status), natural_status)
        check("自然语言经过语义标签解析", page.locator('.tk-cards-resolve-candidate').filter(has_text="bound feet").count() == 1)

        # ②区单个片段快捷翻译：只请求译文并显示在当前卡片，不进入候选/校准流程。
        current.fill("white hair")
        page.evaluate("() => window.__cardsNode._cardsUI._renderChips()")
        semantic_before_single = len(semantic_requests)
        resolve_before_single = len(resolve_requests)
        page.locator(".tk-cards-chip-translate").first.evaluate("el => el.click()")
        page.wait_for_selector(".tk-cards-chip-translation", timeout=30_000)
        check("单个提示词片段可快捷查看译文", "白发" in (page.locator(".tk-cards-chip-translation").first.text_content() or ""))
        check("单卡快捷翻译不调用语义检索", len(semantic_requests) == semantic_before_single, semantic_requests)
        check("单卡快捷翻译不调用 Danbooru 校准", len(resolve_requests) == resolve_before_single, resolve_requests)
        check("单卡快捷翻译不打开校准候选", page.locator(".tk-cards-resolve-candidate").count() == 0)

        # 联想列表定位在输入框下方，不能盖住正在输入的文字。
        page.evaluate(
            """
            () => {
              const ui = window.__cardsNode._cardsUI;
              ui.cards = [{ id: 'suggest-card', prompt: 'long hair', notes: '长发', categories: [] }];
              ui.curTextEl.value = 'lo';
              ui.curTextEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            """
        )
        page.wait_for_selector(".tk-cards-suggest-item", timeout=5_000)
        geometry = page.evaluate(
            """
            () => {
              const input = document.querySelector('.tk-cards-textarea');
              const menu = document.querySelector('.tk-cards-suggest');
              return { value: input?.value || '', input: input?.getBoundingClientRect().toJSON(), menu: menu?.getBoundingClientRect().toJSON() };
            }
            """
        )
        check("联想匹配不改写当前输入", geometry["value"] == "lo", geometry)
        check("联想列表位于输入框下方", geometry["menu"]["top"] >= geometry["input"]["bottom"], geometry)
        check("页面无 JS 异常", not page_errors, page_errors[:5])
        page.screenshot(path=str(ROOT / ".scratch" / "tk-prompt-translation-resolve.png"), full_page=True)
        context.close()
