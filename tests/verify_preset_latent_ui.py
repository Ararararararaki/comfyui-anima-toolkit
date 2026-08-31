# -*- coding: utf-8 -*-
"""在运行中的 ComfyUI 页面验证 TK 空 Latent 的比例菜单和缩放按钮。"""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:8188"
NODE_NAME = "AnimaPresetEmptyLatent"


def main() -> None:
    errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
        page.on(
            "console",
            lambda message: errors.append(f"console: {message.text}")
            if message.type == "error" and any(
                key in message.text.lower()
                for key in ("anima_preset_latent", "anima.presetemptylatent", "apl-ratio", "apl-")
            )
            else None,
        )
        page.goto(BASE, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_function("(name) => Boolean(window.LiteGraph?.registered_node_types?.[name])", arg=NODE_NAME, timeout=30_000)
        page.wait_for_timeout(1500)

        page.evaluate(
            """(name) => {
              const app = window.comfyAPI?.app?.app || window.app;
              app.graph.clear();
              const node = window.LiteGraph.createNode(name);
              node.pos = [100, 100];
              app.graph.add(node);
              app.graph.setDirtyCanvas(true, true);
              window.__tkPresetLatentTestNode = node;
            }""",
            NODE_NAME,
        )
        page.wait_for_selector(".anima-preset-latent", state="attached", timeout=10_000)
        root = page.locator(".anima-preset-latent").last

        initial = page.evaluate(
            """() => {
              const node = window.__tkPresetLatentTestNode;
              const ui = node._animaPresetLatentUI;
              return {
                width: node.widgets.find((widget) => widget.name === 'width')?.value,
                height: node.widgets.find((widget) => widget.name === 'height')?.value,
                scaleColumns: [...document.querySelectorAll('.anima-preset-latent .apl-scale-list')].map((column) => ({
                  side: column.dataset.side,
                  factors: [...column.querySelectorAll('.apl-scale-option')].map((button) => button.dataset.factor),
                })),
                scaleButtons: [...document.querySelectorAll('.anima-preset-latent .apl-scale-option')].map((button) => ({
                  factor: button.dataset.factor,
                  resolution: button.querySelector('.apl-scale-resolution')?.textContent,
                })),
                ratioTrigger: document.querySelector('.apl-ratio-trigger')?.textContent,
                menuInBody: Boolean(document.body.querySelector('.apl-ratio-menu')),
              };
            }"""
        )
        if initial["width"] != 1024 or initial["height"] != 1024:
            raise AssertionError(f"默认分辨率异常: {initial}")
        expected_columns = [
            {"side": "down", "factors": ["0.5", "0.6", "0.7", "0.8", "0.9"]},
            {"side": "up", "factors": ["1.1", "1.2", "1.3", "1.4", "1.5"]},
        ]
        if initial["scaleColumns"] != expected_columns:
            raise AssertionError(f"缩放倍率双列布局异常: {initial['scaleColumns']}")
        if [item["factor"] for item in initial["scaleButtons"]] != [*expected_columns[0]["factors"], *expected_columns[1]["factors"]]:
            raise AssertionError(f"整体缩放按钮缺失: {initial['scaleButtons']}")
        if initial["scaleButtons"][-1]["resolution"] != "1536 × 1536":
            raise AssertionError(f"缩放后的具体分辨率显示异常: {initial['scaleButtons']}")

        root.locator(".apl-scale-option", has_text="×1.5").click()
        scaled = page.evaluate(
            """() => {
              const node = window.__tkPresetLatentTestNode;
              return {
                width: node.widgets.find((widget) => widget.name === 'width')?.value,
                height: node.widgets.find((widget) => widget.name === 'height')?.value,
              };
            }"""
        )
        if scaled != {"width": 1536, "height": 1536}:
            raise AssertionError(f"×1.5 未同时缩放宽高: {scaled}")

        # 将当前测试节点恢复到默认尺寸，验证比例菜单固定使用 1536px 标准长边。
        page.evaluate(
            """() => {
              const node = window.__tkPresetLatentTestNode;
              const ui = node._animaPresetLatentUI;
              for (const widget of node.widgets.filter((item) => item.name === 'width' || item.name === 'height')) {
                widget.value = 1024;
                widget.callback?.(1024);
              }
              ui.render();
            }""",
        )
        page.wait_for_selector(".anima-preset-latent", state="attached", timeout=10_000)
        root = page.locator(".anima-preset-latent").last
        ratio_trigger = root.locator(".apl-ratio-trigger")
        ratio_trigger.hover()
        page.wait_for_selector(".apl-ratio-menu", state="visible", timeout=3000)
        menu_state = page.evaluate(
            """() => {
              const menu = document.querySelector('.apl-ratio-menu');
              const rows = [...menu.querySelectorAll('.apl-ratio-row')];
              const row = rows.find((item) => item.querySelector('.apl-ratio-name')?.textContent === '16:9');
              row?.querySelector('.apl-ratio-row-button')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              return {
                rows: rows.length,
                menuPosition: getComputedStyle(menu).position,
                optionLabels: [...row.querySelectorAll('.apl-ratio-option')].map((button) => button.textContent.trim()),
              };
            }"""
        )
        if menu_state["rows"] != 13 or menu_state["menuPosition"] != "fixed":
            raise AssertionError(f"比例悬浮菜单结构异常: {menu_state}")
        caption = page.locator(".apl-menu-caption").inner_text()
        if "标准长边 1536px" not in caption:
            raise AssertionError(f"比例菜单标准基准异常: {caption}")
        if not any("1536 × 864" in label and "×1.00" in label for label in menu_state["optionLabels"]):
            raise AssertionError(f"16:9 基准分辨率或倍率没有显示: {menu_state['optionLabels']}")

        # 点击 16:9 的标准长边选项。
        page.locator(".apl-ratio-row").filter(has_text="16:9").locator(".apl-ratio-option").nth(2).click()
        ratio_applied = page.evaluate(
            """() => {
              const node = window.__tkPresetLatentTestNode;
              return {
                width: node.widgets.find((widget) => widget.name === 'width')?.value,
                height: node.widgets.find((widget) => widget.name === 'height')?.value,
                current: document.querySelectorAll('.anima-preset-latent')[document.querySelectorAll('.anima-preset-latent').length - 1]?.querySelector('.apl-current')?.textContent,
                menuCount: document.querySelectorAll('.apl-ratio-menu').length,
              };
            }"""
        )
        if ratio_applied["width"] != 1536 or ratio_applied["height"] != 864:
            raise AssertionError(f"16:9 分辨率应用错误: {ratio_applied}")
        if ratio_applied["menuCount"] != 0 or "1536×864" not in ratio_applied["current"].replace(" ", ""):
            raise AssertionError(f"应用后菜单/当前尺寸状态异常: {ratio_applied}")

        # 打开菜单后删除节点，验证 Portal 菜单不会残留。
        root.locator(".apl-ratio-trigger").hover()
        page.wait_for_selector(".apl-ratio-menu", state="visible", timeout=3000)
        page.evaluate("() => { const app = window.comfyAPI?.app?.app || window.app; app.graph.remove(window.__tkPresetLatentTestNode); }")
        page.wait_for_timeout(100)
        remaining_menu = page.locator(".apl-ratio-menu").count()
        if remaining_menu != 0:
            raise AssertionError(f"删除节点后悬浮菜单残留: {remaining_menu}")

        if errors:
            raise AssertionError(f"页面出现错误: {errors}")
        print("PASS TK 空 Latent UI：缩放、比例菜单、具体尺寸、菜单清理", json.dumps(ratio_applied, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    main()
