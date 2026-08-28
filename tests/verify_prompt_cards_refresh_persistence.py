"""真实 ComfyUI 回归：②区当前提示词输入应跨页面刷新保留。"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
sys.stdout.reconfigure(encoding="utf-8")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


def wait_app(page) -> None:
    page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
    page.wait_for_timeout(3_000)


def create_node(page) -> None:
    created = page.evaluate(
        """
        () => {
          const node = LiteGraph.createNode('TKPromptCards');
          if (!node) return null;
          window.app.graph.add(node);
          window.__cardsNode = node;
          return node.type;
        }
        """
    )
    check("TK Prompt Cards 节点创建", created == "TKPromptCards", created)
    page.wait_for_selector(".tk-cards-ui", timeout=15_000)


with tempfile.TemporaryDirectory(prefix="tk-prompt-refresh-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=str(CHROME), headless=True,
            viewport={"width": 1600, "height": 1000}, args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        wait_app(page)
        create_node(page)
        current = page.locator(".tk-cards-textarea").first
        expected = "portrait, white hair, long hair"
        current.fill(expected)
        page.wait_for_timeout(250)
        stored = page.evaluate("() => localStorage.getItem('anima_tk_cards_draft_v1')")
        check("输入后自动保存②区草稿", stored == expected, stored)

        page.reload(wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(3_000)
        create_node(page)
        restored = page.locator(".tk-cards-textarea").first.input_value()
        check("刷新后恢复②区提示词", restored == expected, restored)
        check("页面无 JS 异常", not page_errors, page_errors[:5])
        context.close()
