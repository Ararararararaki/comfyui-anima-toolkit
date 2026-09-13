"""最小复现：读取括号转义后的卡片 Prompt 与 selection_data 原文。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
sys.stdout.reconfigure(encoding="utf-8")

with tempfile.TemporaryDirectory(prefix="tk-bracket-repro-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=str(CHROME), headless=True,
            viewport={"width": 1600, "height": 1000}, args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(5_000)
        page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('DanbooruGallery');
              window.app.graph.add(node);
              window.__reproNode = node;
              const ui = node._animaDanbooruGallery;
              ui.settings.promptOutput = { categories: ['general'], replaceUnderscores: true, escapeBrackets: true };
              const slash = String.fromCharCode(92);
              const alreadyEscaped = slash + '(already_escaped' + slash + ')';
              ui.posts = [{ id: 901, large_file_url: 'https://danbooru.donmai.us/data/repro.png', tag_string_general: `(smile) ${alreadyEscaped}` }];
              ui.renderPosts();
              const card = ui.grid.querySelector('.adg-card');
              card.classList.add('is-selected');
              card.querySelector('.adg-card-select')?.setAttribute('aria-pressed', 'true');
              ui.updateSelection();
            }
            """
        )
        result = page.evaluate(
            """
            () => {
              const ui = window.__reproNode._animaDanbooruGallery;
              const card = ui.grid.querySelector('.adg-card');
              return {
                cardPrompt: card?.dataset.prompt || '',
                selectionData: ui.selectionWidget?.value || '',
                parsedPrompt: JSON.parse(ui.selectionWidget?.value || '{}').selections?.[0]?.prompt || '',
              };
            }
            """
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        expected = r"\(smile\), \(already escaped\)"
        if result["parsedPrompt"] != expected:
            raise AssertionError(f"重复转义：expected={expected!r}, actual={result['parsedPrompt']!r}")
        print("idempotent bracket escaping: PASS")
        context.close()
