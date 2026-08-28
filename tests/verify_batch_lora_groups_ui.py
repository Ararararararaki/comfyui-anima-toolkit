"""真实 ComfyUI 回归：LoRA 组使用新色调与三列卡片布局。"""
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


groups = [
    {"name": name, "loras": [{"name": f"demo/{name}", "weight": 0.8} for _ in range(3)]}
    for name in ("角色", "画风", "光影", "场景", "细节", "常用")
]

with tempfile.TemporaryDirectory(prefix="tk-batch-groups-ui-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile, executable_path=str(CHROME), headless=True,
            viewport={"width": 1600, "height": 1000}, args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.route("**/anima/meta", lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps({"loraGroups": groups, "categories": [], "loraMeta": {}})
        ))
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(2_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TK Batch LoRA Loader');
              if (!node) return null;
              window.app.graph.add(node);
              window.__groupNode = node;
              node._animaUI.loras = [{name: 'demo/a', weight: 0.8, disabled: false}];
              return node.type;
            }
            """
        )
        check("LoRA 组测试节点创建", created == "TK Batch LoRA Loader", created)
        page.wait_for_selector(".anima-lora-widget", timeout=15_000)
        page.evaluate("() => window.__groupNode._animaUI._groupsModal(window.__groupNode._animaUI.listEl)")
        page.wait_for_selector(".anima-group-modal .anima-group-grid", timeout=8_000)
        state = page.evaluate(
            """
            () => {
              const modal = document.querySelector('.anima-group-modal');
              const grid = modal?.querySelector('.anima-group-grid');
              const style = grid ? getComputedStyle(grid) : null;
              const card = modal?.querySelector('.anima-group-card');
              const modalStyle = modal ? getComputedStyle(modal) : null;
              return {
                width: modal?.getBoundingClientRect().width || 0,
                cards: modal?.querySelectorAll('.anima-group-card').length || 0,
                columns: style?.gridTemplateColumns || '',
                modalBackground: modalStyle?.backgroundColor || '',
                cardBackground: card ? getComputedStyle(card).backgroundColor : '',
                saveButtonColor: modal?.querySelector('.anima-group-save-btn') ? getComputedStyle(modal.querySelector('.anima-group-save-btn')).backgroundColor : '',
              };
            }
            """
        )
        print(json.dumps(state, ensure_ascii=False))
        check("LoRA 组弹窗宽度已增加", state["width"] >= 780, state)
        check("LoRA 组以卡片形式呈现", state["cards"] == 6, state)
        check("LoRA 组宽屏默认至少三列", len(state["columns"].split()) >= 3, state)
        check("LoRA 组使用新灰黑色调", state["cardBackground"] in {"rgb(23, 25, 27)", "rgb(29, 32, 35)"}, state)
        check("LoRA 组保存按钮使用米白强调色", state["saveButtonColor"] == "rgb(208, 201, 187)", state)
        page.screenshot(path=str(ROOT / ".scratch" / "tk-batch-lora-groups-modern.png"), full_page=True)
        check("LoRA 组页面无 JS 异常", not page_errors, page_errors[:5])
        context.close()
