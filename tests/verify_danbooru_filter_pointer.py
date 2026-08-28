"""真实 ComfyUI 回归：高级筛选左侧级联菜单不阻挡右侧栏目点击。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-danbooru-filter-pointer-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(CHROME),
            headless=True,
            viewport={"width": 1600, "height": 1000},
            args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.route("**/anima/danbooru/account", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"logged_in": False, "tag_limit": 2})))
        page.route("**/anima/danbooru/posts**", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"posts": [], "tag_limit": 2})))
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(3_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('DanbooruGallery');
              if (!node) return null;
              window.app.graph.add(node);
              window.__galleryNode = node;
              return node.type;
            }
            """
        )
        check("D 站画廊节点创建", created == "DanbooruGallery", created)
        page.wait_for_selector(".anima-danbooru-gallery", timeout=15_000)
        trigger = page.locator(".anima-danbooru-gallery .adg-dropdown-trigger").filter(has_text="筛选").first
        trigger.evaluate("el => el.click()")
        page.wait_for_selector(".adg-filter-menu", timeout=5_000)
        rows = page.locator(".adg-filter-grid .adg-cascade-row")
        check("高级筛选有左右两列", rows.count() >= 2, rows.count())
        left = rows.nth(0)
        right = rows.nth(1)
        left.hover()
        page.wait_for_timeout(260)
        hover_state = page.evaluate(
            """
            () => {
              const rows = [...document.querySelectorAll('.adg-filter-grid .adg-cascade-row')];
              const left = rows[0];
              return { leftOpen: Boolean(left?.classList.contains('is-open')), submenuVisible: getComputedStyle(left?.querySelector(':scope > .adg-submenu')).display !== 'none' };
            }
            """
        )
        print(json.dumps(hover_state, ensure_ascii=False))
        check("悬浮左侧不自动展开遮挡子菜单", not hover_state["leftOpen"] and not hover_state["submenuVisible"], hover_state)
        left_rect = left.bounding_box()
        right_rect = right.bounding_box()
        if not left_rect or not right_rect:
            raise AssertionError("筛选行没有可点击矩形")
        page.mouse.move(left_rect["x"] + left_rect["width"] / 2, left_rect["y"] + left_rect["height"] / 2)
        page.mouse.move(right_rect["x"] + right_rect["width"] / 2, right_rect["y"] + right_rect["height"] / 2, steps=12)
        page.wait_for_timeout(60)
        page.mouse.click(right_rect["x"] + right_rect["width"] / 2, right_rect["y"] + right_rect["height"] / 2)
        page.wait_for_timeout(250)
        right_open = right.evaluate("el => el.classList.contains('is-open')")
        check("右侧筛选项可正常点击", right_open, hover_state)
        left.evaluate("el => el.querySelector(':scope > .adg-menu-row-button')?.click()")
        page.wait_for_timeout(100)
        check("点击左侧才展开其级联选项", left.evaluate("el => el.classList.contains('is-open')"))
        trigger.click(force=True)
        page.locator('.anima-danbooru-gallery button[title^="设置画廊"]').click(force=True)
        page.wait_for_selector(".adg-dialog-overlay .adg-settings-dialog", timeout=5_000)
        style_state = page.evaluate(
            """
            () => {
              const overlay = document.querySelector('.adg-dialog-overlay');
              const dialog = overlay?.querySelector('.adg-dialog');
              const save = overlay?.querySelector('.adg-settings-save-button');
              return {
                accent: overlay ? getComputedStyle(overlay).getPropertyValue('--adg-accent').trim() : '',
                dialogBackground: dialog ? getComputedStyle(dialog).backgroundImage : '',
                saveBackground: save ? getComputedStyle(save).backgroundColor : '',
              };
            }
            """
        )
        check("画廊设置弹窗使用新灰黑背景", "linear-gradient" in style_state["dialogBackground"], style_state)
        check("画廊设置使用米白强调色", style_state["accent"] == "#d0c9bb" and style_state["saveBackground"] == "rgb(208, 201, 187)", style_state)
        page.locator(".adg-dialog-actions button").first.click()
        context.close()
