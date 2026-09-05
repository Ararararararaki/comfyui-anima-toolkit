"""真实 ComfyUI 回归：TK 批量 LoRA 输入框默认紧凑且可手动调整高度。"""
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


with tempfile.TemporaryDirectory(prefix="tk-batch-lora-input-") as profile:
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
        page.wait_for_timeout(1_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TK Batch LoRA Loader');
              if (!node) return null;
              window.app.graph.add(node);
              window.__batchInputNode = node;
              return node.type;
            }
            """
        )
        check("TK 批量 LoRA 节点创建", created == "TK Batch LoRA Loader", created)
        page.wait_for_timeout(600)
        initial = page.evaluate(
            """
            () => {
              const node = window.__batchInputNode;
              const widget = [...(node?.widgets || [])].find((item) => item.name === 'lora_syntax');
              const nodeId = String(node?.id ?? '');
              const visibleInNode = [...document.querySelectorAll('textarea, input')].find((item) => item.closest?.('[node-id]')?.getAttribute('node-id') === nodeId && item.getClientRects().length);
              const candidates = [visibleInNode, widget?.inputEl, widget?.element, ...(widget?.element?.querySelectorAll?.('textarea, input') || [])].filter(Boolean);
              const input = candidates.find((item) => /^(TEXTAREA|INPUT)$/.test(item.tagName) && item.isConnected && item.getClientRects().length) || candidates.find((item) => /^(TEXTAREA|INPUT)$/.test(item.tagName));
              if (!input) return null;
              return {
                height: input.getBoundingClientRect().height,
                resize: getComputedStyle(input).resize,
                overflowY: getComputedStyle(input).overflowY,
              };
            }
            """
        )
        check("输入框默认高度紧凑", initial and initial["height"] <= 130, initial)
        check("输入框保留垂直调整能力", initial and initial["resize"] == "vertical", initial)
        filled = page.evaluate(
            """
            () => {
              const node = window.__batchInputNode;
              const widget = [...(node?.widgets || [])].find((item) => item.name === 'lora_syntax');
              const nodeId = String(node?.id ?? '');
              const visibleInNode = [...document.querySelectorAll('textarea, input')].find((item) => item.closest?.('[node-id]')?.getAttribute('node-id') === nodeId && item.getClientRects().length);
              const candidates = [visibleInNode, widget?.inputEl, widget?.element, ...(widget?.element?.querySelectorAll?.('textarea, input') || [])].filter(Boolean);
              const input = candidates.find((item) => /^(TEXTAREA|INPUT)$/.test(item.tagName) && item.isConnected && item.getClientRects().length) || candidates.find((item) => /^(TEXTAREA|INPUT)$/.test(item.tagName));
              input.value = Array.from({length: 16}, (_, index) => `<lora:model_${index}:1.0>`).join(' ');
              input.dispatchEvent(new Event('input', {bubbles: true}));
              return input.getBoundingClientRect().height;
            }
            """
        )
        page.wait_for_timeout(250)
        after_input = page.evaluate(
            """
            () => {
              const node = window.__batchInputNode;
              const widget = [...(node?.widgets || [])].find((item) => item.name === 'lora_syntax');
              const nodeId = String(node?.id ?? '');
              const visibleInNode = [...document.querySelectorAll('textarea, input')].find((item) => item.closest?.('[node-id]')?.getAttribute('node-id') === nodeId && item.getClientRects().length);
              const candidates = [visibleInNode, widget?.inputEl, widget?.element, ...(widget?.element?.querySelectorAll?.('textarea, input') || [])].filter(Boolean);
              const input = candidates.find((item) => /^(TEXTAREA|INPUT)$/.test(item.tagName) && item.isConnected && item.getClientRects().length) || candidates.find((item) => /^(TEXTAREA|INPUT)$/.test(item.tagName));
              return input?.getBoundingClientRect().height || 0;
            }
            """
        )
        check("输入内容不会自动撑大节点", after_input <= 130, {"before": filled, "after": after_input})
        manual = page.evaluate(
            """
            () => {
              const node = window.__batchInputNode;
              const widget = [...(node?.widgets || [])].find((item) => item.name === 'lora_syntax');
              const nodeId = String(node?.id ?? '');
              const input = [...document.querySelectorAll('textarea, input')]
                .find((item) => item.closest?.('[node-id]')?.getAttribute('node-id') === nodeId && item.getClientRects().length);
              input.style.height = '150px';
              return input.getBoundingClientRect().height;
            }
            """
        )
        page.wait_for_timeout(120)
        persisted = page.evaluate(
            """
            () => {
              const node = window.__batchInputNode;
              return {
                height: [...document.querySelectorAll('textarea, input')]
                  .find((item) => item.closest?.('[node-id]')?.getAttribute('node-id') === String(node?.id ?? '') && item.getClientRects().length)
                  ?.getBoundingClientRect().height || 0,
                stored: localStorage.getItem(`anima_batch_lora_input_height_v1:${node?.id ?? 'unassigned'}`),
                keys: Object.keys(localStorage).filter((key) => key.startsWith('anima_batch_lora_input_height_v1:')),
              };
            }
            """
        )
        check("手动调整输入框高度生效", persisted and persisted["height"] > 120, {"manual": manual, "persisted": persisted})
        check("输入框高度可持久化", persisted and persisted["stored"] == str(round(persisted["height"])), persisted)
        context.close()
