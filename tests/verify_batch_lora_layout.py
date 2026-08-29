"""真实 ComfyUI 回归：TK 批量 LoRA 节点高度与内部列表布局同步。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-batch-lora-layout-") as profile:
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
        page.wait_for_timeout(3_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TK Batch LoRA Loader');
              if (!node) return null;
              window.app.graph.add(node);
              const ui = node._animaUI;
              ui.loras = [{ name: 'demo/subdir', weight: 0.9, disabled: false }];
              ui._render(ui.listEl);
              const beforeSize = [...node.size];
              node.setSize([520, 620]);
              window.__batchNode = node;
              window.__batchBeforeSize = beforeSize;
              return node.type;
            }
            """
        )
        check("TK 批量 LoRA 节点创建", created == "TK Batch LoRA Loader", created)
        page.wait_for_selector(".anima-lora-widget .lora-row", timeout=15_000)
        state = page.evaluate(
            """
            () => {
              const node = window.__batchNode;
              const ui = document.querySelector('.anima-lora-widget');
              const list = ui?.querySelector('.list');
              const widget = [...(node?.widgets || [])].find(w => w.name === 'anima_batch_ui');
              const rect = (el) => el?.getBoundingClientRect().toJSON() || null;
              const ancestors = [];
              let cursor = ui;
              for (let i = 0; cursor && i < 5; i++, cursor = cursor.parentElement) {
                ancestors.push({ tag: cursor.tagName, className: cursor.className, rect: rect(cursor), style: cursor.getAttribute('style') || '' });
              }
              return {
                nodeSize: node?.size || null,
                beforeSize: window.__batchBeforeSize || null,
                nodePos: node?.pos || null,
                widgetNames: (node?.widgets || []).map(w => ({ name: w.name, type: w.type, size: w.computeSize?.(520) || null })),
                uiRect: rect(ui),
                ancestors,
                listRect: rect(list),
                uiStyle: ui ? { height: getComputedStyle(ui).height, maxHeight: getComputedStyle(ui).maxHeight } : null,
                listStyle: list ? { height: getComputedStyle(list).height, minHeight: getComputedStyle(list).minHeight, maxHeight: getComputedStyle(list).maxHeight, overflowY: getComputedStyle(list).overflowY } : null,
                widgetSize: widget?.computeSize?.(520) || null,
                rowCount: ui?.querySelectorAll('.lora-row').length || 0,
              };
            }
            """
        )
        print(json.dumps(state, ensure_ascii=False))
        check("节点高度不产生大块上方空白", state["uiRect"] and state["uiRect"]["top"] - 100 < 200, state)
        check("LoRA 列表随节点尺寸提供可用高度", state["listRect"] and state["listRect"]["height"] >= 300, state)
        check("LoRA 列表可滚动", state["listStyle"] and state["listStyle"]["overflowY"] in {"auto", "scroll"}, state)
        negative_weight = page.evaluate(
            """
            () => {
              const ui = window.__batchNode?._animaUI;
              if (!ui) return null;
              const input = ui.listEl.querySelector('.weight-val');
              input.value = '-0.75';
              input.dispatchEvent(new Event('change', { bubbles: true }));
              const manual = { weight: ui.loras[0].weight, syntax: ui.loraWidget.value };
              ui.loras[0].weight = 0.1;
              ui._render(ui.listEl);
              const dec = ui.listEl.querySelector('.weight-step');
              dec.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }));
              window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40 }));
              window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 40 }));
              return { manual, dragged: { weight: ui.loras[0].weight, syntax: ui.loraWidget.value } };
            }
            """
        )
        print(json.dumps(negative_weight, ensure_ascii=False))
        check("手动输入支持负权重", negative_weight and negative_weight["manual"]["weight"] == -0.75 and "-0.75" in negative_weight["manual"]["syntax"], negative_weight)
        check("拖动步进支持负权重", negative_weight and negative_weight["dragged"]["weight"] < 0 and "-" in negative_weight["dragged"]["syntax"], negative_weight)
        resized = page.evaluate(
            """
            () => {
              const node = window.__batchNode;
              const ui = document.querySelector('.anima-lora-widget');
              const list = ui?.querySelector('.list');
              const height = () => list?.getBoundingClientRect().height || 0;
              node.setSize([520, 360]);
              const small = height();
              node.setSize([520, 620]);
              const large = height();
              return { small, large, delta: large - small };
            }
            """
        )
        check("调整节点边框会同步改变 LoRA 列表高度", resized and resized["delta"] >= 100, resized)
        context.close()
