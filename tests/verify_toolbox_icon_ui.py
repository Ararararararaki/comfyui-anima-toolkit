"""真实 ComfyUI 冒烟：工具箱入口图标设置、跨页面同步与默认图标回退。"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:8188"
APP_URL = f"{BASE}/extensions/ComfyUI-Anima-Batch-LoRA/app/"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with tempfile.TemporaryDirectory(prefix="tk-toolbox-icon-ui-") as profile:
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(CHROME),
            headless=True,
            viewport={"width": 1600, "height": 1000},
            args=["--no-first-run", "--disable-gpu"],
        )
        comfy = context.pages[0] if context.pages else context.new_page()
        page_errors: list[str] = []
        comfy.on("pageerror", lambda error: page_errors.append(str(error)))
        comfy.goto(BASE + "/", wait_until="domcontentloaded", timeout=30_000)
        comfy.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        comfy.wait_for_selector(".anima-menu-icon", timeout=15_000)
        comfy.wait_for_timeout(1_500)

        icon = comfy.locator(".anima-menu-icon").first
        default_src = icon.get_attribute("src") or ""
        check("ComfyUI 顶栏入口图标存在", bool(default_src), default_src)
        check("默认入口图标指向仓库图标", "/img/anima-btn.jpg" in default_src, default_src)

        panel = context.new_page()
        panel.goto(APP_URL, wait_until="domcontentloaded", timeout=30_000)
        panel.wait_for_timeout(3_000)
        panel.locator("#settingsBtn").click()
        panel.wait_for_selector("#toolboxIconPreview", timeout=10_000)
        check("设置页显示图标预览", panel.locator("#toolboxIconPreview").count() == 1)
        check("设置页提供上传、URL、恢复按钮", all(
            panel.locator(selector).count() == 1
            for selector in ("#toolboxIconUploadBtn", "#toolboxIconUrlBtn", "#toolboxIconResetBtn")
        ))

        custom = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        settings = panel.evaluate("() => JSON.parse(localStorage.getItem('anima_settings') || '{}')")
        settings["toolboxIcon"] = custom
        panel.evaluate("value => localStorage.setItem('anima_settings', JSON.stringify(value))", settings)
        comfy.wait_for_function(
            "src => document.querySelector('.anima-menu-icon')?.src === src",
            arg=custom,
            timeout=10_000,
        )
        check("设置页保存后顶栏图标即时同步", True)
        check("设置页无 JS 异常", not page_errors, page_errors[:5])
        context.close()
