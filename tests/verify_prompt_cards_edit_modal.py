"""真实 ComfyUI 回归：Prompt Cards ①区双击编辑弹窗、滚动和可调高度。"""
from __future__ import annotations

import json
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


with tempfile.TemporaryDirectory(prefix="tk-prompt-cards-edit-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=str(CHROME), headless=True,
            viewport={"width": 1600, "height": 1000}, args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(5_000)
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
        page.evaluate(
            """
            () => {
              const ui = window.__cardsNode._cardsUI;
              ui.w.positive.value = 'seed prompt';
              ui.cats = [{ id: 'cat-test', name: '测试分类', sortOrder: 0 }];
              ui.prompts = [{ id: 'lib-test', prompt: 'old long prompt', displayText: '旧标题', notes: '旧注释', categoryId: 'cat-test', createdAt: 1 }];
              ui.cards = [{ id: 'card-test', prompt: 'card prompt', notes: 'card note', weight: '', lora: '', categories: ['card_all'], categoryId: 'card_all', createdAt: 1 }];
              ui._renderLibCatSel();
              ui._renderLibList();
              ui._renderCards();
            }
            """
        )
        lib_item = page.locator('.tk-cards-lib-item').first
        check("工具箱 prompt 库测试条目渲染", lib_item.count() == 1)
        lib_item.dblclick()
        page.wait_for_selector('.tk-cards-edit-modal[aria-label="编辑 Prompt 库条目"]', timeout=5_000)
        page.wait_for_timeout(350)
        state = page.evaluate(
            """
            () => {
              const ui = window.__cardsNode._cardsUI;
              const modal = document.querySelector('.tk-cards-edit-modal');
                return {
                positive: ui.w.positive.value,
                modal: Boolean(modal),
                formOverflow: modal ? getComputedStyle(modal.querySelector('.tk-cards-edit-form')).overflowY : '',
                saveButtons: modal ? modal.querySelectorAll('[data-a="save"]').length : 0,
                footerButtons: modal ? [...modal.querySelectorAll('.tk-cards-edit-btns button')].map(button => ({ text: button.textContent, rect: button.getBoundingClientRect().toJSON(), display: getComputedStyle(button).display, opacity: getComputedStyle(button).opacity })) : [],
              };
            }
            """
        )
        print("编辑弹窗底部按钮:", state["footerButtons"])
        check("双击编辑不改写当前提示词框", state["positive"] == "seed prompt", state)
        check("双击打开独立编辑弹窗", state["modal"] and state["saveButtons"] == 1, state)
        check("编辑表单自身可滚动", state["formOverflow"] in {"auto", "scroll"}, state)
        check("编辑弹窗底部保存/取消均可见", len(state["footerButtons"]) == 2 and all(item["rect"]["width"] > 0 and item["rect"]["height"] > 0 and item["display"] != "none" for item in state["footerButtons"]), state)
        page.screenshot(path=str(ROOT / ".scratch" / "tk-prompt-cards-edit-modal-open.png"), full_page=True)

        page.locator('.tk-cards-edit-modal [data-f="prompt"]').fill("new long prompt, with enough content to edit safely")
        page.locator('.tk-cards-edit-modal [data-a="save"]').click()
        page.wait_for_timeout(500)
        saved = page.evaluate("() => ({ modal: Boolean(document.querySelector('.tk-cards-edit-modal')), prompt: window.__cardsNode._cardsUI.prompts.find(p => p.id === 'lib-test')?.prompt || '' })")
        check("弹窗保存后关闭", not saved["modal"], saved)
        check("弹窗保存回写 Prompt 库", saved["prompt"] == "new long prompt, with enough content to edit safely", saved)

        resize = page.evaluate(
            """
            () => {
              const ui = window.__cardsNode._cardsUI;
              const handle = ui.libResizeEl;
              const before = ui.uiState.libHeight;
              handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, clientY: 100 }));
              handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 11, clientY: 220 }));
              handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11, clientY: 220 }));
              return { before, after: ui.uiState.libHeight, cssHeight: ui.libListEl.style.height, stored: JSON.parse(localStorage.getItem('anima_tk_cards_ui_v1') || '{}').libHeight };
            }
            """
        )
        check("①区高度把手可调整面板", resize["after"] > resize["before"] and resize["cssHeight"] == f"{resize['after']}px", resize)
        check("①区高度持久化", resize["stored"] == resize["after"], resize)
        check("页面无 JS 异常", not page_errors, page_errors[:5])
        page.screenshot(path=str(ROOT / ".scratch" / "tk-prompt-cards-edit-modal.png"), full_page=True)
        context.close()
