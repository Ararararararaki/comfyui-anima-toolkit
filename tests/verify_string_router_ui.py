"""真实 ComfyUI 页面检查 TK String Router 的节点布局和交互。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BEFORE_SHOT = Path(r"C:\Users\Toki\AppData\Local\Temp\tk-string-router-before.png")
AFTER_SHOT = Path(r"C:\Users\Toki\AppData\Local\Temp\tk-string-router-after.png")


with sync_playwright() as playwright:
    profile = tempfile.TemporaryDirectory(prefix="tk-string-router-ui-")
    context = playwright.chromium.launch_persistent_context(
        profile.name,
        executable_path=str(CHROME),
        headless=True,
        viewport={"width": 1440, "height": 900},
        args=["--no-first-run", "--disable-gpu"],
    )
    page = context.pages[0] if context.pages else context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(f"console.{message.type}: {message.text}") if message.type == "error" else None)
    page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
    page.wait_for_timeout(3_000)
    errors.clear()

    created = page.evaluate(
        """
        () => {
          window.app.graph.clear();
          const node = LiteGraph.createNode('TK String Router');
          if (!node) return null;
          window.app.graph.add(node);
          node.pos = [80, 100];
          window.__tkStringRouter = node;
          window.app.graph.setDirtyCanvas(true, true);
          return node.type;
        }
        """
    )
    if created != "TK String Router":
        raise AssertionError(f"node create failed: {created}")
    page.wait_for_timeout(1_000)
    page.screenshot(path=str(BEFORE_SHOT if not page.locator(".tk-sr-panel").count() else AFTER_SHOT))

    state = page.evaluate(
        """
        () => {
          const node = window.__tkStringRouter;
          const ui = document.querySelector('.tk-sr-panel');
          const settings = (node?.widgets || []).find(widget => widget.name === 'router_settings');
          return {
            nodeSize: node?.size || null,
            panel: ui ? {
              rows: ui.querySelectorAll('.tk-sr-row').length,
              title: ui.querySelector('.tk-sr-title')?.textContent || '',
              mode: ui.querySelector('.tk-sr-mode')?.value || '',
              columns: getComputedStyle(ui.querySelector('.tk-sr-grid')).gridTemplateColumns,
            } : null,
            settings: settings?.value || '',
          };
        }
        """
    )
    print(json.dumps(state, ensure_ascii=False))

    if state["panel"]:
        if state["panel"]["rows"] != 6:
            raise AssertionError(f"expected six rows: {state}")
        if state["panel"]["mode"] != "single":
            raise AssertionError(f"expected single mode: {state}")

        page.locator(".tk-sr-index").nth(1).click()
        selected_by_index = page.evaluate(
            """
            () => JSON.parse((window.__tkStringRouter?.widgets || []).find(widget => widget.name === 'router_settings')?.value || '{}').enabled
            """
        )
        if selected_by_index != [False, True, False, False, False, False]:
            raise AssertionError(f"clicking row index did not select exactly once: {selected_by_index}")
        page.locator(".tk-sr-index").nth(0).click()

        page.locator(".tk-sr-name").nth(0).fill("主提示")
        page.locator(".tk-sr-mode").nth(0).select_option("multi")
        page.locator(".tk-sr-control").nth(1).check()
        page.locator(".tk-sr-control").nth(3).check()
        saved = page.evaluate(
            """
            () => JSON.parse((window.__tkStringRouter?.widgets || []).find(widget => widget.name === 'router_settings')?.value || '{}')
            """
        )
        if saved.get("mode") != "multi" or saved.get("enabled") != [True, True, False, True, False, False] or saved.get("names", [""])[0] != "主提示":
            raise AssertionError(f"settings not persisted: {saved}")

        if page.locator(".tk-sr-mode").count() != 2:
            raise AssertionError("expected mode and label-source selectors")
        page.locator(".tk-sr-mode").nth(1).select_option("original")
        label_mode = page.evaluate(
            """
            () => JSON.parse((window.__tkStringRouter?.widgets || []).find(widget => widget.name === 'router_settings')?.value || '{}').labelSource
            """
        )
        if label_mode != "original":
            raise AssertionError(f"label source mode not persisted: {label_mode}")
        page.locator(".tk-sr-mode").nth(1).select_option("custom")

        rows = page.locator(".tk-sr-row")
        rows.nth(0).drag_to(rows.nth(2))
        reordered = page.evaluate(
            """
            () => JSON.parse((window.__tkStringRouter?.widgets || []).find(widget => widget.name === 'router_settings')?.value || '{}').order
            """
        )
        if reordered != [2, 1, 0, 3, 4, 5]:
            raise AssertionError(f"dragging rows did not swap output order: {reordered}")

        connection_label = page.evaluate(
            """
            () => {
              const ui = window.__tkStringRouter?._tkStringRouterUI;
              if (!ui) return null;
              const fakeNode = {
                inputs: [{ link: 314 }],
                graph: {
                  links: new Map([[314, { origin_id: 99, origin_slot: 0 }]]),
                  nodes: [{
                    id: 99,
                    title: '测试源节点',
                    properties: { 'Node name for S&R': 'PrimitiveStringMultiline' },
                    outputs: [{ name: 'text', type: 'STRING' }],
                  }],
                },
              };
              return {
                custom: ui.getConnectionLabel.call({ node: fakeNode, settings: { labelSource: 'custom' } }, 0),
                original: ui.getConnectionLabel.call({ node: fakeNode, settings: { labelSource: 'original' } }, 0),
              };
            }
            """
        )
        if connection_label != {"custom": "测试源节点 · text", "original": "PrimitiveStringMultiline · text"}:
            raise AssertionError(f"connection label not resolved: {connection_label}")
        page.screenshot(path=str(AFTER_SHOT))
        print(f"PASS UI panel: 6 rows, drag reorder, connection label, mode/name persistence; screenshot={AFTER_SHOT}")
    else:
        print(f"BASELINE screenshot={BEFORE_SHOT}")

    if errors:
        raise AssertionError(f"new node interaction errors: {errors[:5]}")
    context.close()
    profile.cleanup()
