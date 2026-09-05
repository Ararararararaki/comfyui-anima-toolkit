"""真实 ComfyUI 回归：Prompt Cards 操作不能抹平用户的提示词分组。"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-cards-group-format-") as profile:
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
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(1_500)
        page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TKPromptCards');
              if (!node) throw new Error('TKPromptCards node unavailable');
              window.app.graph.clear();
              window.app.graph.add(node);
              window.__groupNode = node;
            }
            """
        )
        page.wait_for_selector(".tk-cards-ui", timeout=15_000)
        result = page.evaluate(
            """
            () => {
              const ui = window.__groupNode?._cardsUI;
              if (!ui?.curTextEl) throw new Error('Prompt Cards UI not ready');
              const setText = (value) => {
                ui.curTextEl.value = value;
                ui.onCurInput();
              };
              setText('1girl, solo\\n\\nwhite ha');
              ui.curTextEl.setSelectionRange(ui.curTextEl.value.length, ui.curTextEl.value.length);
              ui._applySuggest({ prompt: 'white hair', weight: '' });
              const afterSuggest = ui.curText();
              ui._appendResolvedText('blue eyes');
              const afterAppend = ui.curText();
              ui._togglePieceVisibility(1);
              const afterHide = ui.curText();
              ui._setPieceWeight(2, 1.2);
              const afterWeight = ui.curText();
              return { afterSuggest, afterAppend, afterHide, afterWeight };
            }
            """
        )
        check("联想替换保留空行分组", result["afterSuggest"] == "1girl, solo\n\nwhite hair", result)
        check("追加候选不合并已有分组", result["afterAppend"] == "1girl, solo\n\nwhite hair, blue eyes", result)
        check("隐藏片段不抹掉后续分组", result["afterHide"] == "1girl\n\nwhite hair, blue eyes", result)
        check("权重操作不抹掉分组", result["afterWeight"] == "1girl\n\n(white hair:1.2), blue eyes", result)
        context.close()
print("prompt cards group-format regression passed")
