from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOT = ROOT / ".scratch" / "danbooru-dropdown-final.png"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
sys.stdout.reconfigure(encoding="utf-8")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"FAIL {name}: {detail}")
    print(f"PASS {name}" + (f" — {detail}" if detail != "" else ""))


def main() -> None:
    SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="codex-adg-dropdown-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=str(CHROME),
                headless=True,
                viewport={"width": 1600, "height": 1000},
                args=["--no-first-run", "--disable-gpu"],
            )
            page = context.pages[0] if context.pages else context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
            page.wait_for_timeout(7_000)
            page.evaluate(
                """
                () => {
                  localStorage.removeItem('anima_danbooru_gallery_settings_v1');
                  const node = LiteGraph.createNode('DanbooruGallery');
                  app.graph.add(node);
                  node.pos = [80, 100];
                  app.canvas.centerOnNode?.(node);
                  app.graph.setDirtyCanvas(true);
                  node.widgets.find(widget => widget.name === '搜索标签').value = '1girl';
                  window.__adgNode = node;
                }
                """
            )
            page.locator(".anima-danbooru-gallery").wait_for(state="visible", timeout=15_000)
            page.wait_for_timeout(2_000)

            initial = page.evaluate(
                """
                () => ({
                  cards: document.querySelectorAll('.adg-card').length,
                  triggers: [...document.querySelectorAll('.adg-dropdown-trigger')].map(button => button.textContent.trim()),
                  details: document.querySelectorAll('.anima-danbooru-gallery details').length,
                  ranking: [...document.querySelectorAll('.adg-toolbar > button')].some(button => button.textContent.trim() === '排行'),
                  css: Boolean(document.querySelector('#anima-danbooru-gallery-style')?.sheet),
                  nodeHeight: window.__adgNode.size[1],
                })
                """
            )
            check("画廊真实搜索返回图片", initial["cards"] > 0, initial)
            check("分级/筛选/分类三个统一下拉入口", len(initial["triggers"]) == 3, initial["triggers"])
            check("旧 details 与独立排行入口已退休", initial["details"] == 0 and not initial["ranking"], initial)
            check("独立样式表已加载", initial["css"])
            check("节点高度仍受控", initial["nodeHeight"] <= 900, initial["nodeHeight"])

            page.evaluate(
                """
                () => {
                  window.__adgFetchCalls = 0;
                  const originalFetch = window.fetch;
                  window.fetch = (...args) => {
                    if (String(args[0]).includes('/anima/danbooru/posts')) window.__adgFetchCalls += 1;
                    return originalFetch(...args);
                  };
                }
                """
            )

            triggers = page.locator(".adg-dropdown-trigger")
            triggers.nth(0).click()
            rating_menu = page.locator(".adg-portal-menu.adg-rating-menu")
            rating_menu.wait_for(state="visible")
            geometry = rating_menu.evaluate(
                "menu => ({ parent: menu.parentElement === document.body, rect: menu.getBoundingClientRect().toJSON(), rootContains: Boolean(document.querySelector('.anima-danbooru-gallery')?.contains(menu)) })"
            )
            check("菜单通过 portal 显示且不受节点裁切", geometry["parent"] and not geometry["rootContains"], geometry)
            check(
                "菜单完整落在视口内",
                geometry["rect"]["left"] >= 0
                and geometry["rect"]["top"] >= 0
                and geometry["rect"]["right"] <= 1600
                and geometry["rect"]["bottom"] <= 1000,
                geometry["rect"],
            )
            rating_menu.locator(".adg-menu-choice", has_text="普通").click()
            rating_menu.locator(".adg-menu-choice", has_text="敏感").click()
            rating_menu.get_by_role("button", name="应用筛选").click()
            page.wait_for_timeout(900)
            rating_result = page.evaluate(
                """
                () => ({
                  rating: window.__adgNode._animaDanbooruGallery.settings.rating,
                  query: window.__adgNode._animaDanbooruGallery.currentQuery(),
                  calls: window.__adgFetchCalls,
                  badge: document.querySelectorAll('.adg-dropdown-trigger-badge')[0].textContent,
                  saved: JSON.parse(localStorage.getItem('anima_danbooru_gallery_settings_v1')).rating,
                })
                """
            )
            check("分级多选规范化并持久化", rating_result["rating"] == ["g", "s"] and rating_result["saved"] == ["g", "s"], rating_result)
            check("分级只在应用时请求一次", rating_result["calls"] == 1, rating_result["calls"])
            check("分级查询与触发器摘要正确", "rating:g,s" in rating_result["query"] and rating_result["badge"] == "2", rating_result)

            page.evaluate("window.__adgFetchCalls = 0")
            triggers.nth(1).click()
            filter_menu = page.locator(".adg-portal-menu.adg-filter-menu")
            filter_menu.wait_for(state="visible")
            rows = filter_menu.locator(".adg-cascade-row")
            check("筛选菜单包含四个级联子项", rows.count() == 4, rows.count())
            rows.nth(0).hover()
            page.wait_for_timeout(220)
            check("鼠标悬浮可展开子菜单", rows.nth(0).locator(".adg-submenu").is_visible())
            rows.nth(0).locator(".adg-menu-choice", has_text="本周").click()
            rows.nth(1).locator(".adg-menu-row-button").click()
            rows.nth(1).locator(".adg-menu-choice", has_text="≥ 100").click()
            rows.nth(3).locator(".adg-menu-row-button").click()
            rows.nth(3).locator(".adg-menu-choice", has_text="综合").click()
            filter_menu.get_by_role("button", name="应用筛选").click()
            page.wait_for_timeout(900)
            filter_result = page.evaluate(
                """
                () => ({
                  filters: window.__adgNode._animaDanbooruGallery.settings.filters,
                  query: window.__adgNode._animaDanbooruGallery.currentQuery(),
                  calls: window.__adgFetchCalls,
                  badge: document.querySelectorAll('.adg-dropdown-trigger-badge')[1].textContent,
                })
                """
            )
            check(
                "级联筛选应用正确",
                filter_result["filters"] == {"age": "1week", "minScore": "100", "minFavs": "", "order": "rank"},
                filter_result,
            )
            check("多个筛选项只触发一次搜索", filter_result["calls"] == 1, filter_result["calls"])
            check(
                "排序只有唯一 order owner",
                filter_result["query"].count("order:") == 1 and "order:rank" in filter_result["query"] and filter_result["badge"] == "3",
                filter_result,
            )
            duplicate_order = page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  ui.queryWidget.value = '1girl order:score';
                  const query = ui.currentQuery();
                  ui.queryWidget.value = '1girl';
                  return query;
                }
                """
            )
            check("搜索框中的 order 不会制造第二排序 owner", duplicate_order.count("order:") == 1 and "order:rank" in duplicate_order, duplicate_order)

            limit_result = page.evaluate(
                """
                async () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  ui.queryWidget.value = '1girl solo';
                  window.__adgFetchCalls = 0;
                  await ui.search({ resetPage: true });
                  const result = { calls: window.__adgFetchCalls, status: document.querySelector('.adg-status').textContent };
                  ui.queryWidget.value = '1girl';
                  return result;
                }
                """
            )
            check("超过 D站匿名标签限制时本地阻止请求并给出说明", limit_result["calls"] == 0 and "最多 2 个" in limit_result["status"], limit_result)

            page.evaluate("window.__adgFetchCalls = 0")
            triggers.nth(1).click()
            filter_menu = page.locator(".adg-portal-menu.adg-filter-menu")
            filter_menu.get_by_role("button", name="重置").click()
            page.wait_for_timeout(700)
            reset_result = page.evaluate(
                """
                () => ({
                  filters: window.__adgNode._animaDanbooruGallery.settings.filters,
                  calls: window.__adgFetchCalls,
                  badge: document.querySelectorAll('.adg-dropdown-trigger-badge')[1].textContent,
                })
                """
            )
            check("重置筛选清空状态且只请求一次", reset_result == {"filters": {"age": "", "minScore": "", "minFavs": "", "order": ""}, "calls": 1, "badge": ""}, reset_result)

            page.evaluate(
                """
                () => {
                  const ui = window.__adgNode._animaDanbooruGallery;
                  ui.settings.categories = [{ id: 'test_category', name: '测试分类' }];
                  ui.filterControls.refresh();
                }
                """
            )
            triggers.nth(2).click()
            category_menu = page.locator(".adg-portal-menu.adg-category-menu")
            category_menu.get_by_role("button", name="测试分类").click()
            category_result = page.evaluate(
                """
                () => ({
                  value: window.__adgNode._animaDanbooruGallery.settings.activeCategory,
                  label: document.querySelectorAll('.adg-dropdown-trigger-label')[2].textContent,
                })
                """
            )
            check("分类使用同一菜单壳并立即生效", category_result == {"value": "test_category", "label": "测试分类"}, category_result)

            triggers.nth(1).focus()
            page.keyboard.press("ArrowDown")
            filter_menu.wait_for(state="visible")
            page.keyboard.press("Escape")
            check("键盘可打开且 Esc 关闭", filter_menu.count() == 0)

            page.evaluate(
                """
                () => {
                  const current = window.__adgNode;
                  const second = LiteGraph.createNode('DanbooruGallery');
                  app.graph.add(second);
                  window.__adgSecond = second;
                  app.graph.remove(second);
                  return current.id;
                }
                """
            )
            migrated = page.evaluate("window.__adgSecond._animaDanbooruGallery.settings.rating")
            check("新节点可恢复多选分级", migrated == ["g", "s"], migrated)

            page.screenshot(path=str(SCREENSHOT), full_page=False)
            check("无画廊运行时异常", not errors, errors)
            context.close()

    print(json.dumps({"screenshot": str(SCREENSHOT), "status": "passed"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
