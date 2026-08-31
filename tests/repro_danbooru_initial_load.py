"""Capture the first real D gallery load in a Chromium-family browser."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BROWSER = Path(os.environ.get("TK_BROWSER_EXECUTABLE", str(CHROME)))
sys.stdout.reconfigure(encoding="utf-8")


def main() -> None:
    responses: list[dict[str, object]] = []
    requests: list[str] = []
    page_errors: list[str] = []
    mock_first_invalid = os.environ.get("TK_MOCK_FIRST_INVALID") == "1"
    mock_attempts = 0
    with tempfile.TemporaryDirectory(prefix="tk-danbooru-first-load-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=str(BROWSER),
                headless=True,
                viewport={"width": 1600, "height": 1000},
                args=["--no-first-run", "--disable-gpu"],
            )
            page = context.pages[0] if context.pages else context.new_page()
            page.on("pageerror", lambda error: page_errors.append(str(error)))

            def capture_request(request):
                if "/anima/danbooru/posts?" in request.url:
                    requests.append(request.url)

            def capture_response(response):
                if "/anima/danbooru/posts?" not in response.url:
                    return
                try:
                    body = response.text()
                except Exception as error:  # pragma: no cover - diagnostic path
                    body = f"<read failed: {error}>"
                parsed = None
                parse_error = ""
                try:
                    parsed = json.loads(body.lstrip("\ufeff"))
                except Exception as error:
                    parse_error = str(error)
                responses.append(
                    {
                        "status": response.status,
                        "content_type": response.headers.get("content-type", ""),
                        "length": len(body),
                        "prefix": body[:180],
                        "suffix": body[-120:],
                        "json_ok": parsed is not None,
                        "parse_error": parse_error,
                    }
                )

            page.on("request", capture_request)
            page.on("response", capture_response)
            if mock_first_invalid:
                def mock_posts(route):
                    nonlocal mock_attempts
                    mock_attempts += 1
                    if mock_attempts == 1:
                        route.fulfill(status=200, content_type="application/json", body="truefalse")
                    else:
                        route.fulfill(
                            status=200,
                            content_type="application/json",
                            body=json.dumps({"posts": [], "tag_limit": 2}),
                        )

                page.route("**/anima/danbooru/posts**", mock_posts)
            page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
            page.wait_for_timeout(2_000)
            created = page.evaluate(
                """
                () => {
                  const node = LiteGraph.createNode('DanbooruGallery');
                  if (!node) return null;
                  node.pos = [40, 40];
                  window.app.graph.add(node);
                  window.__firstLoadGallery = node;
                  return node.type;
                }
                """
            )
            if created != "DanbooruGallery":
                raise AssertionError(f"gallery node creation failed: {created!r}")
            page.wait_for_timeout(5_000 if mock_first_invalid else 30_000)
            state = page.evaluate(
                """
                () => {
                  const ui = window.__firstLoadGallery?._animaDanbooruGallery;
                  return {
                    status: ui?.status?.textContent || '',
                    cards: ui?.grid?.querySelectorAll('.adg-card').length || 0,
                    posts: ui?.posts?.length || 0,
                    searchCount: ui?.requestId || 0,
                  };
                }
                """
            )
            if mock_first_invalid:
                if mock_attempts != 2 or len(responses) != 2 or not responses[1]["json_ok"]:
                    raise AssertionError(f"invalid first response was not recovered: {responses!r}")
                if "搜索失败" in str(state["status"]):
                    raise AssertionError(f"search remained failed after retry: {state!r}")
            print(json.dumps({"browser": str(BROWSER), "mock_first_invalid": mock_first_invalid, "mock_attempts": mock_attempts, "requests": requests, "responses": responses, "state": state, "page_errors": page_errors}, ensure_ascii=False, indent=2))
            context.close()


if __name__ == "__main__":
    main()
