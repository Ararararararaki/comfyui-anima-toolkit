"""百度翻译 provider 的 Prompt Cards 设置入口回归测试（不读取或回显密钥）。"""
from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=str(CHROME), headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
    page.evaluate(
        """
        () => {
          const node = LiteGraph.createNode('TKPromptCards');
          window.app.graph.add(node);
          window.__baiduCardsNode = node;
        }
        """
    )
    page.wait_for_selector(".tk-cards-ui", timeout=15_000)
    page.wait_for_selector(".tk-cards-translate-status-details", timeout=10_000)
    page.locator(".tk-cards-translate-status-details > summary").click()
    page.wait_for_timeout(300)
    page.wait_for_function("String(document.querySelector('.tk-cards-translate-status')?.innerHTML || '').includes('百度')", timeout=10_000)
    status_text = page.locator(".tk-cards-translate-status").inner_text()
    check("翻译源列表包含百度翻译", "百度翻译" in status_text, status_text)
    manage = page.locator('[data-a="manage-baidu"]')
    check("翻译状态提供百度设置入口", manage.count() == 1)
    manage.evaluate("el => el.click()")
    page.wait_for_selector(".tk-cards-baidu-box", timeout=8_000)
    check("百度设置包含 APPID 输入", page.locator('.tk-cards-baidu-box [data-a="appid"]').count() == 1)
    check("百度设置包含 API Key 输入", page.locator('.tk-cards-baidu-box [data-a="api-key"]').count() == 1)
    check("百度设置包含模型选择", page.locator('.tk-cards-baidu-box [data-a="model"] option').count() == 2)
    check("百度设置包含连接测试", page.locator('.tk-cards-baidu-box [data-a="test"]').count() == 1)
    page.locator('.tk-cards-baidu-box [data-a="close"]').click()
    check("关闭百度设置窗口", page.locator(".tk-cards-baidu-box").count() == 0)
    browser.close()

print("ALL PASS")
