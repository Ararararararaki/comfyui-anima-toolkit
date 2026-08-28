"""真实前端回归：中文/英文搜索联想均显示双语词条、帖数，并可点击替换。"""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(
        str(Path.cwd() / ".scratch" / f"danbooru-search-bilingual-profile-{os.getpid()}"),
        executable_path=str(CHROME),
        headless=True,
        viewport={"width": 1600, "height": 1000},
        args=["--no-first-run", "--disable-gpu"],
    )
    page = context.pages[0] if context.pages else context.new_page()
    page.route(
        "**/anima/danbooru/account",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"logged_in": False, "tag_limit": 2}),
        ),
    )
    page.route(
        "**/anima/danbooru/posts**",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"posts": [], "tag_limit": 2}),
        ),
    )

    def suggest(route):
        q = parse_qs(urlparse(route.request.url).query).get("q", [""])[0]
        if any("\u4e00" <= char <= "\u9fff" for char in q):
            details = [{"tag": "imagining", "translation": "想象", "postCount": 8200, "category": "general"}]
        else:
            details = [{"tag": "artist_name", "translation": "画师姓名", "postCount": 618000, "category": "meta"}]
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({
                "suggestions": [item["tag"] for item in details],
                "suggestionDetails": details,
                "didYouMean": [],
                "rewrites": [],
            }, ensure_ascii=False),
        )

    page.route("**/anima/danbooru/suggest**", suggest)
    page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
    page.wait_for_timeout(2_000)
    page.evaluate("localStorage.removeItem('anima_danbooru_gallery_settings_v1')")
    page.evaluate(
        """
        () => {
          const node = LiteGraph.createNode('DanbooruGallery');
          window.app.graph.add(node);
          window.__bilingualSearchNode = node;
        }
        """
    )
    page.wait_for_selector(".anima-danbooru-gallery", timeout=15_000)
    page.evaluate("window.__bilingualSearchUI = window.__bilingualSearchNode._animaDanbooruGallery")
    base_height = page.locator(".anima-danbooru-gallery").bounding_box()["height"]

    page.evaluate(
        """
        () => {
          const ui = window.__bilingualSearchUI;
          ui.queryInput.value = '想';
          ui.queryWidget.value = '想';
          ui.queryInput.setSelectionRange(1, 1);
          ui.queryInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        """
    )
    page.wait_for_selector(".adg-suggestions.is-localized .adg-localized-suggestion", timeout=10_000)
    chinese_text = " ".join(page.locator(".adg-localized-suggestion").all_text_contents())
    layout = page.evaluate(
        """
        () => {
          const root = document.querySelector('.anima-danbooru-gallery');
          const suggestions = document.querySelector('.adg-suggestions');
          return {
            parent: suggestions?.parentElement?.tagName || '',
            position: suggestions ? getComputedStyle(suggestions).position : '',
            height: root?.getBoundingClientRect().height || 0,
          };
        }
        """
    )
    check("联想浮层挂在搜索框下方", layout["parent"] == "BODY" and layout["position"] == "fixed", layout)
    check("联想浮层不撑高节点", layout["height"] <= base_height + 1, layout)
    check("中文联想显示中文词", "想象" in chinese_text, chinese_text)
    check("中文联想显示英文标签", "imagining" in chinese_text, chinese_text)
    check("中文联想显示帖数", "8.2k" in chinese_text, chinese_text)
    page.locator('.adg-localized-suggestion[data-q="imagining"]').click()
    page.wait_for_function("window.__bilingualSearchUI.queryInput.value === 'imagining'", timeout=10_000)
    check("点击中文候选替换为英文标签", page.evaluate("window.__bilingualSearchUI.queryInput.value") == "imagining")

    page.evaluate(
        """
        () => {
          const ui = window.__bilingualSearchUI;
          ui.queryInput.value = 'ar';
          ui.queryWidget.value = 'ar';
          ui.queryInput.setSelectionRange(2, 2);
          ui.queryInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        """
    )
    page.wait_for_selector(".adg-suggestions.is-localized .adg-localized-suggestion", timeout=10_000)
    english_text = " ".join(page.locator(".adg-localized-suggestion").all_text_contents())
    check("英文联想显示标签", "artist name" in english_text, english_text)
    check("英文联想显示帖数", "618k" in english_text, english_text)
    page.locator('.adg-localized-suggestion[data-q="artist_name"]').click()
    page.wait_for_function("window.__bilingualSearchUI.queryInput.value === 'artist_name'", timeout=10_000)
    check("点击英文候选保留原有搜索流程", page.evaluate("window.__bilingualSearchUI.queryInput.value") == "artist_name")
    context.close()

print("ALL PASS")
