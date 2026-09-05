"""Regression test for the Danbooru Gallery search input caret placement."""
from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


DEFAULT_CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
DEFAULT_EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
BASE_QUERY = "alpha beta gamma"


def browser_path() -> Path:
    configured = os.environ.get("TK_BROWSER_EXECUTABLE")
    if configured:
        return Path(configured)
    return DEFAULT_CHROME


def run_caret_regression(executable: Path) -> str:
    if not executable.exists():
        raise RuntimeError(f"浏览器不存在：{executable}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=str(executable),
            headless=True,
            args=["--no-first-run", "--disable-gpu"],
        )
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
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
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('DanbooruGallery');
              if (!node) return null;
              node.pos = [40, 40];
              window.app.graph.add(node);
              window.__caretGallery = node;
              return node.type;
            }
            """
        )
        if created != "DanbooruGallery":
            raise AssertionError(f"画廊节点创建失败：{created!r}")
        input_box = page.locator("input.adg-query")
        input_box.wait_for(timeout=30_000)
        page.evaluate(
            """
            () => {
              const input = document.querySelector('input.adg-query');
              input.value = 'alpha beta gamma';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.blur();
            }
            """
        )
        box = input_box.bounding_box()
        if not box:
            raise AssertionError("搜索框没有可用的布局矩形")
        click_offset = page.evaluate(
            """
            () => {
              const input = document.querySelector('input.adg-query');
              const style = getComputedStyle(input);
              const canvas = document.createElement('canvas');
              const context = canvas.getContext('2d');
              context.font = style.font;
              return Number.parseFloat(style.paddingLeft || '0')
                + context.measureText('alpha be').width - 2;
            }
            """
        )
        # 按当前浏览器字体计算，落在 beta 单词内部，避开左侧内边距。
        page.mouse.click(box["x"] + click_offset, box["y"] + box["height"] / 2)
        page.keyboard.type("X")
        actual = input_box.input_value()
        browser.close()
        if actual.replace("X", "") != BASE_QUERY or actual.startswith("X") or actual.endswith("X"):
            raise AssertionError(f"光标落点错误：字符没有插入原文本内部，实际 {actual!r}")
        return actual


if __name__ == "__main__":
    executable = browser_path()
    print(f"browser={executable}")
    print(f"PASS: search caret insertion -> {run_caret_regression(executable)!r}")
