from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def main():
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        partial(SimpleHTTPRequestHandler, directory=str(ROOT)),
    )
    Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1100, "height": 800})
        page.goto(
            f"http://127.0.0.1:{server.server_port}/tests/clothing_draw_ui_harness.html",
            wait_until="networkidle",
        )
        page.wait_for_function("window.__ready && window.__node && document.querySelector('.tk-clothing-draw')")

        # Simulate LiteGraph's document/canvas mouse handler: any event that
        # leaves the DOM widget is treated as a node value-edit gesture.
        page.evaluate(
            """
            window.__valueEditLeaks = [];
            for (const type of ['pointerdown', 'mousedown', 'click']) {
              document.addEventListener(type, (event) => {
                if (event.target.closest('.tk-clothing-draw')) {
                  window.__valueEditLeaks.push(type);
                }
              });
            }
            """
        )

        page.locator(".tk-clothing-draw-preview").click()
        page.locator(".tk-clothing-draw-cardline").click()
        page.locator(".tk-clothing-draw-hint").click()
        assert page.evaluate("window.__valueEditLeaks") == [], (
            "clothing draw DOM events leaked to the canvas: "
            + str(page.evaluate("window.__valueEditLeaks"))
        )

        page.locator('[data-action="choose"]').click()
        page.locator('.tk-clothing-picker-overlay').wait_for()
        page.keyboard.press("Escape")
        assert page.locator('.tk-clothing-picker-overlay').count() == 0
        browser.close()
    server.shutdown()
    print("clothing draw pointer-event isolation passed")


if __name__ == "__main__":
    main()
