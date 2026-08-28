"""回归：bridge 一次性投递——重启/刷新不重放历史残留；新版本正常投递。

前提：真实 ComfyUI（8188）+ 有真实 LoRA 文件。测试会临时写/删 anima_bridge.json，
结束后恢复「无 bridge」状态。
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
BRIDGE = Path(r"E:\1AI\ComfyUI-aki-v3\ComfyUI\custom_nodes\ComfyUI-Anima-Batch-LoRA\anima_bridge.json")
TEST_LORA = "2200s"  # models/loras/2200s.safetensors
sys.stdout.reconfigure(encoding="utf-8")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


def write_bridge(ts_ms: int, names: list[str]) -> None:
    loras = " ".join(f"<lora:{n}:1.00>" for n in names)
    BRIDGE.write_text(json.dumps({
        "loras": loras,
        "lora_list": [{"name": n, "model_strength": 1, "trigger_words": []} for n in names],
        "updatedAt": ts_ms,
        "_receivedAt": ts_ms / 1000,
    }), encoding="utf-8")


def ui_state(page):
    return page.evaluate(
        """() => {
          const node = window.app.graph._nodes.find((n) => n.type === 'TK Batch LoRA Loader');
          const ui = node && node._animaUI;
          return ui ? { names: (ui.loras || []).map((l) => l.name) } : null;
        }"""
    )


with tempfile.TemporaryDirectory(prefix="tk-bridge-") as profile:
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
        page.wait_for_timeout(3000)

        def create_node():
            return page.evaluate(
                """() => {
                  const node = LiteGraph.createNode('TK Batch LoRA Loader');
                  if (!node) return null;
                  window.app.graph.add(node);
                  return node.type;
                }"""
            )

        try:
            # 0) 前置：确保无 bridge 残留
            check("前置：bridge 为空", not BRIDGE.exists())

            # 1) 版本 A 投递 → 节点出现该 LoRA
            ts_a = int(time.time() * 1000)
            write_bridge(ts_a, [TEST_LORA])
            check("写入版本 A 后 status 生效", page.evaluate(
                "async () => (await (await fetch('/anima/bridge/status')).json()).loras.length === 1"))
            created = create_node()
            check("TK Batch LoRA Loader 节点创建", created == "TK Batch LoRA Loader", created)
            page.wait_for_function("""
                () => {
                  const n = window.app.graph._nodes.find((x) => x.type === 'TK Batch LoRA Loader');
                  return n && n._animaUI && n._animaUI.loras.some((l) => l.name === '2200s');
                }
            """, timeout=20_000)
            check("版本 A 投递后节点出现该 LoRA", TEST_LORA in ui_state(page)["names"], ui_state(page))

            # 2) 模拟重启：刷新页面 + 重建节点（bridge 文件仍在，版本不变）
            page.reload(wait_until="domcontentloaded")
            page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
            page.wait_for_timeout(3000)
            check("重建节点", create_node() == "TK Batch LoRA Loader")
            page.wait_for_timeout(7000)  # 覆盖 5s 轮询
            st2 = ui_state(page)
            check("重启后不重放版本 A（用户已删的条目不复活）", TEST_LORA not in st2["names"], st2)

            # 3) 新版本 B 投递（面板再次发送）→ 正常投递
            ts_b = ts_a + 60_000
            second = "@muiu-000066".replace(".safetensors", "")
            write_bridge(ts_b, [TEST_LORA, second])
            page.wait_for_function("""
                () => {
                  const n = window.app.graph._nodes.find((x) => x.type === 'TK Batch LoRA Loader');
                  return n && n._animaUI && n._animaUI.loras.some((l) => l.name === '@muiu-000066');
                }
            """, timeout=20_000)
            st3 = ui_state(page)
            check("新版本 B 正常投递新条目", "@muiu-000066" in st3["names"], st3)

            check("无页面 JS 异常", len(page_errors) == 0, page_errors)
            print("ALL PASS")
        finally:
            # 清理：删测试 bridge，恢复无 bridge 状态
            if BRIDGE.exists():
                BRIDGE.unlink()
            print("cleanup: bridge removed")