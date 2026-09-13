"""Regression coverage for Danbooru gallery sorting and overlay click isolation."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
BASE_URL = "http://127.0.0.1:8188/"


def browser_paths() -> list[Path]:
    configured = os.environ.get("TK_BROWSER_EXECUTABLE")
    if configured:
        return [Path(configured)]
    return [path for path in (CHROME, EDGE) if path.exists()]


def run(executable: Path) -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=str(executable),
            headless=True,
            args=["--no-first-run", "--disable-gpu"],
        )
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.route(
            "**/anima/danbooru/account",
            lambda route: (time.sleep(0.5), route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"logged_in": True, "tag_limit": 2}),
            )),
        )
        page.route(
            "**/anima/danbooru/suggest**",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"suggestions": ["blue_hair"]}),
            ),
        )
        post = {
            "id": 1,
            "file_url": "https://danbooru.donmai.us/data/test.png",
            "preview_file_url": "https://danbooru.donmai.us/data/test-preview.png",
            "image_width": 512,
            "image_height": 512,
            "tag_string": "1girl solo",
            "rating": "s",
            "score": 10,
            "fav_count": 99,
            "file_ext": "png",
        }
        requests: list[str] = []

        def posts(route):
            requests.append(route.request.url)
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"posts": [post], "tag_limit": 2}),
            )

        page.route("**/anima/danbooru/posts**", posts)
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.evaluate(
            """
            () => localStorage.setItem(
              'anima_danbooru_gallery_settings_v1',
              JSON.stringify({lastQuery: '1girl solo', filters: {order: 'favcount'}})
            )
            """
        )
        page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('DanbooruGallery');
              if (!node) throw new Error('DanbooruGallery node creation failed');
              window.app.graph.add(node);
              window.__interactionGallery = node;
            }
            """
        )
        page.locator("input.adg-query").wait_for(timeout=30_000)
        page.wait_for_timeout(800)
        initial_status = page.evaluate("() => window.__interactionGallery._animaDanbooruGallery.status.textContent")
        if "匿名最多" in initial_status:
            raise AssertionError(f"首次搜索在登录状态加载前误报为匿名：{initial_status!r}")
        page.evaluate(
            """
            () => {
              const ui = window.__interactionGallery._animaDanbooruGallery;
              ui.controller?.abort();
              ui.requestId += 1;
              ui.setQuery('1girl');
              ui.settings.filters.order = 'favcount';
              ui.tagLimitValue = 2;
            }
            """
        )
        page.evaluate(
            """
            async () => {
              const ui = window.__interactionGallery._animaDanbooruGallery;
              await ui.search({resetPage: true, skipFuzzy: true});
            }
            """
        )
        search_urls = [url for url in requests if "/anima/danbooru/posts?" in url]
        if not search_urls:
            raise AssertionError("没有捕获到画廊搜索请求")
        query = parse_qs(urlparse(search_urls[-1]).query).get("tags", [""])[0]
        if "order:favcount" not in query:
            raise AssertionError(f"收藏排序被请求链路丢失：{query!r}")

        # 登录账号即使仍是 Member=2，也不能把“排序被降级”的提示误报成匿名。
        page.evaluate(
            """
            () => {
              const ui = window.__interactionGallery._animaDanbooruGallery;
              ui.registered = true;
              ui.tagLimitValue = 2;
              ui.setQuery('1girl solo');
              ui.settings.filters.order = 'favcount';
              ui.filterControls.refresh();
            }
            """
        )
        page.evaluate(
            """
            async () => {
              const ui = window.__interactionGallery._animaDanbooruGallery;
              await ui.search({resetPage: true, skipFuzzy: true});
            }
            """
        )
        status = page.evaluate("() => window.__interactionGallery._animaDanbooruGallery.status.textContent")
        if "匿名最多" in status:
            raise AssertionError(f"已登录账号被误报为匿名：{status!r}")
        if "登录账号当前最多 2 个计数标签" not in status:
            raise AssertionError(f"登录账号的计数标签上限提示不准确：{status!r}")

        # 真实点击筛选菜单的“收藏”+“应用”，一次操作只能发起一次搜索请求。
        requests.clear()
        page.evaluate(
            """
            () => {
              const ui = window.__interactionGallery._animaDanbooruGallery;
              ui.setQuery('1girl');
              ui.settings.filters.order = '';
              ui.filterControls.refresh();
            }
            """
        )
        filter_trigger = page.locator(".anima-danbooru-gallery .adg-dropdown-trigger").filter(has_text="筛选").first
        filter_trigger.click()
        # 方向子菜单位于左列，展开后会横跨右列；它必须位于相邻“最低评分/文件类型”行之上，
        # 否则鼠标命中的是右列按钮，表现为菜单可见但选项点不到。
        direction_row = page.locator(".adg-filter-menu .adg-cascade-row").nth(4)
        direction_row.locator(":scope > .adg-menu-row-button").click()
        submenu = direction_row.locator(":scope > .adg-submenu")
        submenu.wait_for(state="visible", timeout=5000)
        submenu_position = submenu.evaluate("element => getComputedStyle(element).position")
        if submenu_position != "fixed":
            raise AssertionError(f"方向子菜单没有脱离网格层：position={submenu_position!r}")
        hit_target = submenu.locator(":scope > .adg-menu-choice", has_text="竖图")
        hit_box = hit_target.bounding_box()
        if not hit_box:
            raise AssertionError("方向子菜单选项没有布局矩形")
        actual_target = page.evaluate(
            """
            ({x, y}) => {
              const element = document.elementFromPoint(x, y);
              return element?.closest?.('.adg-submenu > .adg-menu-choice')?.textContent?.trim() || '';
            }
            """,
            {"x": hit_box["x"] + hit_box["width"] / 2, "y": hit_box["y"] + hit_box["height"] / 2},
        )
        if actual_target != "竖图":
            raise AssertionError(f"方向子菜单实际命中元素错误：{actual_target!r}")
        direction_row.locator(":scope > .adg-submenu .adg-menu-choice", has_text="竖图").click()
        direction_value = direction_row.locator(":scope > .adg-menu-row-button .adg-menu-current").inner_text()
        if direction_value != "竖图":
            raise AssertionError(f"方向子菜单点击被右列遮挡：{direction_value!r}")
        sort_row = page.locator(".adg-filter-menu .adg-cascade-row").nth(6)
        sort_trigger = sort_row.locator(":scope > .adg-menu-row-button")
        sort_trigger.click()
        page.get_by_role("menuitemradio", name="收藏", exact=True).click()
        page.locator(".adg-filter-menu button", has_text="应用筛选").click()
        page.wait_for_timeout(150)
        menu_search_urls = [url for url in requests if "/anima/danbooru/posts?" in url]
        if len(menu_search_urls) != 1:
            raise AssertionError(f"筛选收藏触发了多次搜索（疑似穿透）：{len(menu_search_urls)}")
        menu_query = parse_qs(urlparse(menu_search_urls[0]).query).get("tags", [""])[0]
        if "order:favcount" not in menu_query:
            raise AssertionError(f"筛选菜单的收藏排序没有进入请求：{menu_query!r}")

        # 将外部浮层逐一覆盖到画廊下方按钮上，验证不会补发底层点击。
        for overlay_class in ("adg-suggestions", "adg-portal-menu", "adg-dialog-overlay"):
            page.evaluate(
                """
                (overlayClass) => {
                  const ui = window.__interactionGallery._animaDanbooruGallery;
                  const underlying = ui.root.querySelector('.adg-toolbar-main button');
                  if (!underlying) throw new Error('找不到底层搜索按钮');
                  window.__underlyingClicks = 0;
                  window.__overlayClicks = 0;
                  ui.search = () => { window.__underlyingClicks += 1; };
                  ui.suggestions.style.display = 'none';
                  const overlay = document.createElement('div');
                  overlay.className = overlayClass;
                  overlay.style.cssText = 'position:fixed;display:block;z-index:100001;';
                  const rect = underlying.getBoundingClientRect();
                  overlay.style.left = `${rect.left}px`;
                  overlay.style.top = `${rect.top}px`;
                  overlay.style.width = `${rect.width}px`;
                  overlay.style.height = `${rect.height}px`;
                  const button = document.createElement('button');
                  button.type = 'button';
                  button.style.cssText = 'width:100%;height:100%;';
                  button.textContent = overlayClass;
                  button.onclick = () => { window.__overlayClicks += 1; };
                  overlay.append(button);
                  document.body.append(overlay);
                  window.__interactionOverlay = overlay;
                }
                """,
                overlay_class,
            )
            overlay = page.locator(f".{overlay_class} button")
            overlay.wait_for(timeout=5000)
            box = overlay.bounding_box()
            if not box:
                raise AssertionError(f"{overlay_class} 没有可用布局矩形")
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.wait_for_timeout(100)
            clicks = page.evaluate("({overlay: window.__overlayClicks, underlying: window.__underlyingClicks})")
            if clicks != {"overlay": 1, "underlying": 0}:
                raise AssertionError(f"{overlay_class} 点击穿透到底层按钮：{clicks}")
            page.evaluate("() => window.__interactionOverlay.remove()")
        browser.close()


if __name__ == "__main__":
    paths = browser_paths()
    if not paths:
        raise SystemExit("没有找到 Chrome/Edge；请设置 TK_BROWSER_EXECUTABLE")
    for path in paths:
        run(path)
        print(f"PASS: {path.name} 收藏排序请求与浮层点击隔离")
