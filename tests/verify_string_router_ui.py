"""真实 ComfyUI 页面冒烟：TK String Router 的面板、模式切换和配置持久化。"""

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


with tempfile.TemporaryDirectory(prefix="tk-string-router-ui-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(CHROME),
            headless=True,
            viewport={"width": 1400, "height": 900},
            args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(f"console.{message.type}: {message.text}") if message.type == "error" else None)
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(3_000)
        # ComfyUI 启动阶段可能有与本节点无关的资源/初始化日志；只审计节点交互之后新增的错误。
        errors.clear()

        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TK String Router');
              if (!node) return null;
              window.app.graph.add(node);
              node.pos = [80, 120];
              window.__stringRouterNode = node;
              return node.type;
            }
            """
        )
        check("节点创建", created == "TK String Router", created)
        page.wait_for_selector(".tk-string-router", timeout=15_000)

        initial = page.evaluate(
            """
            () => {
              const ui = document.querySelector('.tk-string-router');
              const node = window.__stringRouterNode;
              return {
                rows: ui?.querySelectorAll('.tk-string-router-row').length || 0,
                mode: ui?.querySelector('.tk-string-router-mode')?.value,
                enabled: [...(ui?.querySelectorAll('.tk-string-router-control') || [])].map(el => el.checked),
                socketNames: (node?.inputs || []).map(input => input.name).filter(name => name.startsWith('string_')),
              };
            }
            """
        )
        print(json.dumps(initial, ensure_ascii=False))
        check("显示 6 个接口行", initial["rows"] == 6, initial)
        check("默认单选只开启接口 1", initial["mode"] == "single" and initial["enabled"] == [True, False, False, False, False, False], initial)
        check("底层接口保持稳定编号", initial["socketNames"] == [f"string_{i}" for i in range(1, 7)], initial)

        page.locator(".tk-string-router-name").nth(0).fill("标题")
        page.locator(".tk-string-router-mode").select_option("multi")
        page.locator(".tk-string-router-control").nth(1).check()
        page.locator(".tk-string-router-control").nth(3).check()
        multi = page.evaluate(
            """
            () => {
              const node = window.__stringRouterNode;
              const widget = (node?.widgets || []).find(item => item.name === 'router_settings');
              return { settings: JSON.parse(widget?.value || '{}') };
            }
            """
        )
        print(json.dumps(multi, ensure_ascii=False))
        saved = multi["settings"]
        check("多选开启接口 1/2/4", saved["mode"] == "multi" and saved["enabled"] == [True, True, False, True, False, False], saved)
        check("自定义名称写入工作流配置", saved["names"][0] == "标题", saved)
        check("页面无 JavaScript 错误", not errors, errors[:5])
        context.close()
