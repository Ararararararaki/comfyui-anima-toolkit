from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:8765/tests/clothing_draw_ui_harness.html"


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1100, "height": 800})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(URL, wait_until="networkidle")
        page.wait_for_function("window.__ready && window.__node && document.querySelector('.tk-clothing-draw')")

        assert not errors, errors
        assert page.locator('[data-role="state"]').inner_text().startswith("已读取 2 张")
        assert page.locator('[data-role="scope"] option').count() == 4

        page.locator('[data-action="choose"]').click()
        page.locator('.tk-clothing-picker-overlay').wait_for()
        assert page.locator('.tk-clothing-picker-card').count() == 2

        page.locator('[data-role="picker-search"]').fill("泳装")
        page.wait_for_timeout(180)
        assert page.locator('.tk-clothing-picker-card').count() == 1
        assert page.locator('.tk-clothing-picker-card-title').inner_text() == "红色泳装"

        page.locator('.tk-clothing-picker-card[data-id="outfit-2"]').click()
        page.wait_for_timeout(80)
        assert page.locator('[data-role="name"]').inner_text() == "红色泳装"
        assert page.locator('[data-role="prompt"]').input_value() == "red swimsuit, beach"
        assert page.locator('[data-role="scope"]').input_value() == "swim"

        page.once("dialog", lambda dialog: dialog.accept("夏日泳装"))
        page.locator('[data-action="rename"]').click()
        page.wait_for_timeout(80)
        assert page.locator('[data-role="name"]').inner_text() == "夏日泳装"

        page.locator('[data-action="draw"]').click()
        page.wait_for_timeout(100)
        payload = page.evaluate("JSON.parse(window.__node.widgets.find(w => w.name === 'selection_data').value)")
        assert payload["mode"] == "随机抽取"
        assert payload["selected"]["id"] == "outfit-2"

        page.evaluate("window.__node.onExecuted({clothing_draw: [{id: 'outfit-1', name: '黑色制服', prompt: 'black uniform, pleated skirt', category_id: 'uniform', category: '制服'}]})")
        page.wait_for_timeout(100)
        assert page.locator('[data-role="name"]').inner_text() == "黑色制服"
        assert page.locator('[data-role="prompt"]').input_value() == "black uniform, pleated skirt"

        page.locator('[data-action="choose"]').click()
        page.locator('.tk-clothing-picker-overlay').wait_for()
        grid = page.locator('.tk-clothing-picker-grid')
        before = page.evaluate("window.__wheelBubbles")
        grid.hover()
        page.mouse.wheel(0, 300)
        page.wait_for_timeout(30)
        after = page.evaluate("window.__wheelBubbles")
        assert after == before, "picker wheel bubbled into the canvas/document"

        page.evaluate("window.__node.onRemoved()")
        assert page.locator('.tk-clothing-picker-overlay').count() == 0
        assert not errors, errors
        browser.close()
    print("clothing draw UI smoke passed")


if __name__ == "__main__":
    main()
