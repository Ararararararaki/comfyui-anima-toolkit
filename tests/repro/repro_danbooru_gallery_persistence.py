"""Reproduce D gallery settings loss across a workflow configure/refresh-like rebuild."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BROWSER = Path(os.environ.get("TK_BROWSER_EXECUTABLE", str(CHROME)))


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-danbooru-gallery-persistence-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(BROWSER),
            headless=True,
            viewport={"width": 1600, "height": 1000},
            args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(500)
        result = page.evaluate(
            """
            () => {
              const graph = window.app.graph;
              graph.clear();
              const node = LiteGraph.createNode('DanbooruGallery');
              graph.add(node);
              const ui = node._animaDanbooruGallery;
              ui.settings.lastQuery = '1girl blue_hair';
              ui.settings.filters = { ...ui.settings.filters, order: 'favcount', age: '1week' };
              ui.settings.categories = [{ id: 'c1', name: '测试分类', tags: ['1girl'] }];
              ui.settings.activeCategory = 'c1';
              ui.saveSettings();
              const before = { id: node.id, settings: ui.settings, key: ui.settingsKey(), stored: localStorage.getItem(ui.settingsKey()) };
              const workflow = graph.serialize();
              graph.clear();
              graph.configure(workflow);
              const restored = graph._nodes.find((item) => item.type === 'DanbooruGallery');
              const restoredUi = restored?._animaDanbooruGallery;
              return {
                before,
                workflowNode: workflow.nodes.find((item) => item.type === 'DanbooruGallery'),
                after: restored && restoredUi ? { id: restored.id, settings: restoredUi.settings, key: restoredUi.settingsKey(), stored: localStorage.getItem(restoredUi.settingsKey()) } : null,
              };
            }
            """
        )
        before = result["before"]["settings"]
        workflow_node = result["workflowNode"]
        after = result["after"]["settings"]
        check("工作流序列化包含画廊设置", "tk_danbooru_gallery_settings_v1" in workflow_node["properties"], workflow_node)
        check("刷新/重建后搜索词保留", after["lastQuery"] == before["lastQuery"], result)
        check("刷新/重建后筛选保留", after["filters"] == before["filters"], result)
        check("刷新/重建后分类保留", after["categories"] == before["categories"], result)
        check("刷新/重建后当前分类保留", after["activeCategory"] == before["activeCategory"], result)
        print("danbooru gallery persistence regression passed")
        context.close()
