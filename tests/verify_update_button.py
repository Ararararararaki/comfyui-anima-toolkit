"""验证更新按钮能识别提交差异并执行一键更新交互，不下载真实更新包。"""
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


with tempfile.TemporaryDirectory(prefix="tk-update-button-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(CHROME),
            headless=True,
            viewport={"width": 1600, "height": 1000},
            args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        version_requests: list[str] = []
        apply_requests: list[dict] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.route("**/anima/version*", lambda route: (
            version_requests.append(route.request.url) or route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "version": "2.3.0",
                    "latest": "2.3.0",
                    "behind": True,
                    "updateAvailable": True,
                    "localCommit": "1111111111111111",
                    "remoteCommit": "2222222222222222",
                    "commitChecked": True,
                    "packageChecked": True,
                    "packageMatch": False,
                    "canAutoUpdate": True,
                    "url": "https://github.com/Ararararararaki/comfyui-anima-toolkit",
                }),
            )
        ))
        page.route("**/anima/update/apply", lambda route: (
            apply_requests.append(json.loads(route.request.post_data or "{}")) or route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "ok": True,
                    "updatedFiles": 4,
                    "version": "2.3.0",
                    "commit": "2222222222222222",
                    "restartRequired": True,
                    "restartHint": "请通过绘世启动器重启 ComfyUI",
                }),
            )
        ))
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(1_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TK Batch LoRA Loader');
              if (!node) return null;
              window.app.graph.add(node);
              return node.type;
            }
            """
        )
        check("更新测试节点创建", created == "TK Batch LoRA Loader", created)
        page.wait_for_function("""document.querySelector('.anima-lora-widget .toolbar button[title*=\"安全更新\"]')?.textContent.includes(\"一键更新\")""", timeout=8_000)
        check("检测到提交差异后按钮变为一键更新", page.locator('.anima-lora-widget .toolbar button[title*="安全更新"]').inner_text() == "一键更新", version_requests)
        page.locator('.anima-lora-widget .toolbar button[title*="安全更新"]').click()
        page.wait_for_selector(".ug-modal .ug-apply", timeout=5_000)
        check("一键更新弹窗可用", page.locator(".ug-apply").inner_text() == "一键更新")
        page.locator(".ug-apply").click()
        page.wait_for_function("document.querySelector('.ug-status')?.textContent.includes('更新完成')", timeout=8_000)
        check("更新接口收到远端提交哈希", len(apply_requests) == 1 and apply_requests[0].get("expectedCommit") == "2222222222222222", apply_requests)
        check("更新完成提示重启绘世 GUI", "绘世启动器" in page.locator(".ug-status").inner_text())
        check("更新完成后按钮标记需重启", page.locator('.anima-lora-widget .toolbar button[title*="重启 ComfyUI"]').inner_text() == "需重启")
        check("更新按钮页面无 JS 异常", not page_errors, page_errors[:5])
        context.close()
