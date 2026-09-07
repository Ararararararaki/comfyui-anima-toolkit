"""真实 ComfyUI 页面检查 TK Danbooru Tag Getter 的原生风格布局和交互。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BEFORE_SHOT = Path(r"C:\Users\Toki\AppData\Local\Temp\tk-danbooru-getter-before.png")
AFTER_SHOT = Path(r"C:\Users\Toki\AppData\Local\Temp\tk-danbooru-getter-after.png")


with sync_playwright() as playwright:
    profile = tempfile.TemporaryDirectory(prefix="tk-danbooru-getter-ui-")
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
    # 直接替换运行目录中的同名脚本，验证当前源码而不是尚未更新的旧副本。
    source_widget = (Path(__file__).resolve().parents[1] / "web" / "js" / "anima_danbooru_tag_getter_widget.js").read_text(encoding="utf-8")
    page.route("**/anima_danbooru_tag_getter_widget.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body=source_widget))
    page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
    page.wait_for_timeout(3_000)
    errors.clear()

    node_type = "AnimaTKDanbooruTagGetter"
    created = page.evaluate(
        """
        (nodeType) => {
          window.app.graph.clear();
          const node = LiteGraph.createNode(nodeType);
          if (!node) return null;
          window.app.graph.add(node);
          node.pos = [80, 100];
          window.__tkDanbooruGetter = node;
          window.app.graph.setDirtyCanvas(true, true);
          return node.type;
        }
        """,
        node_type,
    )
    if created != node_type:
        raise AssertionError(f"node create failed: {created}")
    page.wait_for_timeout(1_000)
    page.screenshot(path=str(BEFORE_SHOT if not page.locator(".tk-dtb-panel").count() else AFTER_SHOT))

    state = page.evaluate(
        """
        () => {
          const node = window.__tkDanbooruGetter;
          const widgets = node?.widgets || [];
          const panel = document.querySelector('.tk-dtb-panel');
          return {
            nodeSize: node?.size || null,
            inputNames: (node?.inputs || []).map(input => input.name),
            inputLabels: (node?.inputs || []).map(input => input.label || input.name),
            widgetNames: widgets.map(widget => widget.name),
            panel: panel ? {
              rows: panel.querySelectorAll('.tk-dtb-row').length,
              weights: panel.querySelectorAll('.tk-dtb-weight-input').length,
              filters: panel.querySelectorAll('.tk-dtb-filter-input').length,
              naturalToggles: panel.querySelectorAll('.tk-dtb-natural-toggle').length,
              columns: getComputedStyle(panel.querySelector('.tk-dtb-grid')).gridTemplateColumns,
              title: panel.querySelector('.tk-dtb-title')?.textContent || '',
            } : null,
            values: Object.fromEntries(widgets.filter(widget => widget.name !== 'tag_bundle').map(widget => [widget.name, widget.value])),
          };
        }
        """
    )
    print(json.dumps(state, ensure_ascii=False))

    if state["panel"]:
        if state["panel"]["rows"] != 12:
            raise AssertionError(f"expected 12 category rows: {state}")
        if state["panel"]["weights"] != 12:
            raise AssertionError(f"expected one weight control per category: {state}")
        if state["panel"]["filters"] != 2:
            raise AssertionError(f"expected regex and exact filter fields: {state}")
        if state["panel"]["naturalToggles"] != 2:
            raise AssertionError(f"expected include/filter natural-language toggles: {state}")
        if "统一 Prompt" not in state["inputLabels"]:
            raise AssertionError(f"unified prompt input label missing: {state}")
        if not state["panel"]["title"]:
            raise AssertionError(f"missing panel title: {state}")
        restored_zero = page.evaluate(
            """
            () => {
              const node = window.__tkDanbooruGetter;
              const widget = (node?.widgets || []).find(item => item.name === '画师词_weight');
              if (!widget) return null;
              widget.value = 0;
              node._tkDanbooruTagGetterUI?.load();
              return {
                widget: widget.value,
                visible: node._tkDanbooruTagGetterUI?.weightControls.get('画师词')?.value || '',
              };
            }
            """
        )
        if not restored_zero or restored_zero["widget"] != 1 or restored_zero["visible"] not in {"1", "1.0"}:
            raise AssertionError(f"legacy zero weight was not normalized to neutral 1.0: {restored_zero}")
        page.locator(".tk-dtb-label").nth(1).click()
        after_label_click = page.evaluate(
            """
            () => (window.__tkDanbooruGetter?.widgets || []).find(widget => widget.name === '背景词')?.value
            """
        )
        if after_label_click is not True:
            raise AssertionError(f"clicking category text did not enable exactly once: {after_label_click}")
        page.locator(".tk-dtb-label").nth(1).click()
        after_second_label_click = page.evaluate(
            """
            () => (window.__tkDanbooruGetter?.widgets || []).find(widget => widget.name === '背景词')?.value
            """
        )
        if after_second_label_click is not False:
            raise AssertionError(f"clicking category text did not disable exactly once: {after_second_label_click}")
        page.locator(".tk-dtb-toggle").nth(0).click()
        page.locator(".tk-dtb-toggle").nth(3).click()
        page.locator(".tk-dtb-filter-input").nth(0).fill("logo|watermark")
        page.locator(".tk-dtb-filter-input").nth(1).fill("speech_bubble\nthought_bubble")
        natural_toggles = page.locator(".tk-dtb-natural-toggle input")
        if natural_toggles.count() != 2:
            raise AssertionError(f"natural-language toggles missing: {natural_toggles.count()}")
        natural_toggles.nth(0).uncheck()
        include_after_uncheck = page.evaluate(
            """
            () => (window.__tkDanbooruGetter?.widgets || []).find(widget => widget.name === 'include_natural_language')?.value
            """
        )
        if include_after_uncheck is not False:
            raise AssertionError(f"include natural-language toggle did not persist false: {include_after_uncheck}")
        natural_toggles.nth(0).check()
        weight_input = page.locator(".tk-dtb-weight-input").nth(0)
        weight_input.fill("1.25")
        weight_input.press("Tab")
        values = page.evaluate(
            """
            () => {
              const node = window.__tkDanbooruGetter;
              return Object.fromEntries((node?.widgets || []).map(widget => [widget.name, widget.value]));
            }
            """
        )
        if values.get("画师词") is not True or values.get("角色特征词") is not True:
            raise AssertionError(f"checkbox values were not persisted: {values}")
        if values.get("regex_blacklist") != "logo|watermark" or values.get("tag_blacklist") != "speech_bubble\nthought_bubble":
            raise AssertionError(f"filter values were not persisted: {values}")
        if values.get("画师词_weight") != 1.25:
            raise AssertionError(f"category weight was not persisted: {values}")
        page.screenshot(path=str(AFTER_SHOT))
        print(f"PASS UI panel: 12 rows, compact grid, native boolean values persisted; screenshot={AFTER_SHOT}")
    else:
        print(f"BASELINE screenshot={BEFORE_SHOT}")

    if errors:
        raise AssertionError(f"new node interaction errors: {errors[:5]}")
    context.close()
    profile.cleanup()
