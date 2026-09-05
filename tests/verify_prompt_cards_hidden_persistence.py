"""真实 ComfyUI 回归：隐藏的 Prompt Cards 片段必须随工作流重建保留。"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
sys.stdout.reconfigure(encoding="utf-8")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-cards-hidden-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(CHROME),
            headless=True,
            viewport={"width": 1600, "height": 1000},
            args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        try:
            page.wait_for_load_state("networkidle", timeout=30_000)
        except Exception:
            # ComfyUI 的 websocket/长轮询可能让 networkidle 不稳定；DOM 已就绪
            # 时仍继续做后续可观测验证。
            pass
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(2_000)
        # 用 CDP 禁用缓存 + ignoreCache reload，等价于浏览器 Ctrl+Shift+R，
        # 不接管用户的真实鼠标/键盘。
        cdp = context.new_cdp_session(page)
        cdp.send("Network.enable")
        cdp.send("Network.setCacheDisabled", {"cacheDisabled": True})
        cdp.send("Page.reload", {"ignoreCache": True})
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(2_000)
        page.evaluate("() => localStorage.clear()")
        page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TKPromptCards');
              if (!node) throw new Error('TKPromptCards node unavailable');
              window.app.graph.add(node);
              window.__hiddenSourceNode = node;
            }
            """
        )
        page.wait_for_selector(".tk-cards-ui", timeout=15_000)
        page.evaluate(
            """
            () => {
              const bottom = document.getElementById('comfyui-body-bottom');
              if (bottom) bottom.style.display = 'none';
              document.querySelectorAll('.pysssss-image-feed').forEach((el) => { el.style.display = 'none'; });
            }
            """
        )
        ui = page.locator(".tk-cards-ui").last
        textarea = ui.locator(".tk-cards-textarea").first
        textarea.fill("white hair, long hair")
        page.wait_for_function("document.querySelectorAll('.tk-cards-chip').length === 2", timeout=10_000)
        ui.locator(".tk-cards-chip").first.hover()
        ui.locator('[data-piece-action="visibility"]').first.click()
        page.wait_for_function("document.querySelectorAll('.tk-cards-chip.is-hidden').length === 1", timeout=10_000)
        serialized = page.evaluate("() => window.__hiddenSourceNode.serialize()")
        check("隐藏后仍有可见文本输出", serialized["widgets_values"][0] == "long hair", serialized)

        page.evaluate(
            """
            (data) => {
              const node = LiteGraph.createNode('TKPromptCards');
              window.app.graph.add(node);
              node.configure(data);
              window.__hiddenRestoredNode = node;
            }
            """,
            serialized,
        )
        page.wait_for_timeout(2_000)
        restored = page.evaluate(
            """
            () => {
              const ui = window.__hiddenRestoredNode?._cardsUI;
              return {
                pieces: ui?.promptPieces || [],
                visibleText: ui?.curTextEl?.value || '',
                hiddenCount: ui?.chipsEl?.querySelectorAll('.tk-cards-chip.is-hidden').length || 0,
                chipCount: ui?.chipsEl?.querySelectorAll('.tk-cards-chip').length || 0,
              };
            }
            """
        )
        check("工作流重建后保留隐藏片段", len(restored["pieces"]) == 2, restored)
        check("工作流重建后仍只输出可见片段", restored["visibleText"] == "long hair", restored)
        check("工作流重建后隐藏视觉状态仍在", restored["hiddenCount"] == 1 and restored["chipCount"] == 2, restored)
        context.close()
