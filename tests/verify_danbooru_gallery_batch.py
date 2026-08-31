"""Verify D gallery multi-selection expands to sequential batch jobs."""
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


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


def main() -> None:
    run_payloads: list[dict] = []
    status_calls = 0
    with tempfile.TemporaryDirectory(prefix="tk-danbooru-gallery-batch-") as profile:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                executable_path=str(BROWSER),
                headless=True,
                viewport={"width": 1600, "height": 1000},
                args=["--no-first-run", "--disable-gpu"],
            )
            page = context.pages[0] if context.pages else context.new_page()

            def fake_posts(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"posts": [], "tag_limit": 2}))

            def fake_account(route):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"logged_in": False, "tag_limit": 2}))

            def fake_run(route):
                run_payloads.append(json.loads(route.request.post_data or "{}"))
                route.fulfill(status=200, content_type="application/json", body=json.dumps({
                    "ok": True,
                    "batchId": "bgallery-test",
                    "summary": {
                        "id": "bgallery-test", "state": "running", "total": 2,
                        "counts": {"pending": 1, "queued": 1, "running": 0, "done": 0, "failed": 0},
                    },
                }))

            def fake_status(route):
                nonlocal status_calls
                status_calls += 1
                if status_calls == 1:
                    route.abort()
                    return
                if status_calls == 2:
                    summary = {"id": "bgallery-test", "state": "running", "total": 2, "counts": {"pending": 1, "queued": 1, "running": 0, "done": 0, "failed": 0}}
                    jobs = [{"idx": 0, "group": "D站图片 #101", "status": "queued"}, {"idx": 1, "group": "D站图片 #102", "status": "pending"}]
                else:
                    summary = {"id": "bgallery-test", "state": "finished", "total": 2, "counts": {"pending": 0, "queued": 0, "running": 0, "done": 2, "failed": 0}}
                    jobs = [{"idx": 0, "group": "D站图片 #101", "status": "done"}, {"idx": 1, "group": "D站图片 #102", "status": "done"}]
                route.fulfill(status=200, content_type="application/json", body=json.dumps({
                    "ok": True, "batch": {"id": "bgallery-test", "state": summary["state"], "total": 2},
                    "summary": summary, "jobs": jobs,
                }))

            page.route("**/anima/danbooru/posts**", fake_posts)
            page.route("**/anima/danbooru/account", fake_account)
            page.route("**/anima/batch/run", fake_run)
            page.route("**/anima/batch/*/status", fake_status)
            page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
            page.wait_for_timeout(800)
            created = page.evaluate(
                """
                () => {
                  const node = LiteGraph.createNode('DanbooruGallery');
                  if (!node) return null;
                  node.pos = [40, 40];
                  window.app.graph.add(node);
                  window.__batchGallery = node;
                  return node.type;
                }
                """
            )
            check("画廊节点创建", created == "DanbooruGallery", created)
            page.wait_for_selector(".anima-danbooru-gallery", timeout=15_000)
            setup = page.evaluate(
                """
                () => {
                  const ui = window.__batchGallery._animaDanbooruGallery;
                  ui.posts = [
                    { id: 101, large_file_url: 'https://danbooru.donmai.us/data/one.png', preview_file_url: 'https://danbooru.donmai.us/data/one.jpg', tag_string_character: 'sample_character', tag_string_general: '1girl', rating: 'g', score: 1, fav_count: 1, image_width: 512, image_height: 512, file_ext: 'png', source: 'danbooru' },
                    { id: 102, large_file_url: 'https://danbooru.donmai.us/data/two.png', preview_file_url: 'https://danbooru.donmai.us/data/two.jpg', tag_string_character: 'sample_character', tag_string_general: 'solo', rating: 'g', score: 2, fav_count: 2, image_width: 512, image_height: 512, file_ext: 'png', source: 'danbooru' },
                  ];
                  ui.renderPosts();
                  const cards = [...ui.grid.querySelectorAll('.adg-card')];
                  // 用户先点第二张，再 Ctrl/⌘ 点击第一张；批量任务应保留这个点击顺序。
                  cards[1].querySelector('.adg-card-select')?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
                  cards[0].querySelector('.adg-card-select')?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
                  const graphApp = window.comfyAPI?.app?.app || window.app;
                  const nodeId = String(ui.node.id);
                  graphApp.graphToPrompt = () => ({ output: { [nodeId]: { class_type: 'DanbooruGallery', inputs: { selection_data: ui.selectionWidget.value } } } });
                  return { cards: cards.length, selected: ui.selectedGallerySelections().length, button: ui.galleryBatchBtn?.textContent || '', enabled: ui.galleryBatchBtn?.disabled === false, hasTemplateApi: typeof graphApp.graphToPrompt === 'function' };
                }
                """
            )
            check("两张卡片进入选中状态", setup["cards"] == 2 and setup["selected"] == 2, setup)
            check("批量入队按钮启用", setup["enabled"] and setup["button"].startswith("批量入队 2"), setup)
            check("工作流模板 API 可用", setup["hasTemplateApi"], setup)
            button_rect = page.locator(".adg-batch-queue").bounding_box()
            if not button_rect:
                raise AssertionError("批量入队按钮没有可点击区域")
            page.mouse.click(button_rect["x"] + button_rect["width"] / 2, button_rect["y"] + button_rect["height"] / 2)
            page.wait_for_function("() => document.querySelector('.adg-batch-panel')?.textContent.includes('批次')", timeout=5_000)
            page.wait_for_timeout(100)
            check("批量入队请求一次", len(run_payloads) == 1, run_payloads)
            payload = run_payloads[0] if run_payloads else {}
            check("批量入队携带当前 ComfyUI client_id", bool(payload.get("client_id")), payload)
            jobs = payload.get("jobs") or []
            check("生成两个独立 jobs", len(jobs) == 2, payload)
            selections = []
            for job in jobs:
                patches = job.get("patches") or []
                value = json.loads(patches[0]["value"]) if patches else {}
                selections.append(value.get("selections") or [])
            check("每个 job 只包含一张图片", [len(items) for items in selections] == [1, 1], selections)
            check("任务顺序保持点击顺序", [items[0].get("post_id") for items in selections] == ["102", "101"], selections)
            page.wait_for_timeout(250)
            reconnect_text = page.locator(".adg-batch-panel").text_content() or ""
            check("状态断线时显示自动重连", "状态重连中" in reconnect_text or "正在连接批次状态接口" in reconnect_text, reconnect_text)
            page.wait_for_timeout(1_500)
            check("批次状态至少轮询一次", status_calls >= 1, status_calls)
            page.wait_for_timeout(1_500)
            panel_text = page.locator(".adg-batch-panel").text_content() or ""
            check("批次完成状态显示", status_calls >= 2 and "完成 2/2" in panel_text, {"status_calls": status_calls, "panel": panel_text})
            check("无页面异常", not page.locator("body").evaluate("(body) => body.innerText.includes('批量入队失败')"), panel_text)
            context.close()


if __name__ == "__main__":
    main()
