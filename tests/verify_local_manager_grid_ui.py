"""真实 ComfyUI 冒烟：本地 LoRA 列表/网格切换与自定义预览图持久化。"""
from __future__ import annotations

import base64
import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:8188"
APP_URL = f"{BASE}/extensions/ComfyUI-Anima-Batch-LoRA/app/"
BROWSERS = [
    ("Chrome", Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")),
    ("Edge", Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")),
    ("Edge x86", Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")),
]


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


def cached_file(name: str) -> dict[str, object]:
    return {
        "name": name,
        "path": name,
        "size": 1024 * 1024,
        "lastModified": 1,
        "sha256": "a" * 64,
        "matched": True,
        "matchData": {
            "modelId": 1,
            "modelName": "Grid UI Smoke Test",
            "versionId": 1,
            "versionName": "v1",
            "trainedWords": [],
            "images": [],
            "creator": "test",
            "description": "",
            "downloadCount": 1234,
            "thumbsUpCount": 56,
            "baseModel": "test",
            "tags": [],
            "nsfw": False,
        },
        "matchError": "",
        "scanning": False,
    }


def run_ui_smoke(playwright, browser_name: str, executable: Path, image_path: str) -> None:
    with tempfile.TemporaryDirectory(prefix=f"tk-local-grid-ui-{browser_name.lower().replace(' ', '-')}-") as profile:
        context = playwright.chromium.launch_persistent_context(
            profile,
            executable_path=str(executable),
            headless=True,
            viewport={"width": 1600, "height": 1000},
            args=["--no-first-run", "--disable-gpu"],
        )
        page = context.pages[0] if context.pages else context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(APP_URL, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_selector("#localGridViewBtn", timeout=15_000)
        page.evaluate(
            """file => localStorage.setItem('anima_local_loras_v2', JSON.stringify({
                data: [file], timestamp: Date.now(), version: 1
            }))""",
            cached_file("grid-smoke.safetensors"),
        )
        page.evaluate(
            """localStorage.setItem('anima_local_categories_v1_mc', JSON.stringify({
                data: {'grid-smoke': ['风格']}, timestamp: Date.now(), version: 1
            }))"""
        )
        page.reload(wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_selector("#localGridViewBtn", timeout=15_000)
        page.wait_for_timeout(1_000)

        page.locator("#localGridViewBtn").click()
        page.wait_for_function("document.querySelector('.local-split')?.classList.contains('local-display-grid')")
        check(f"{browser_name} 网格视图切换", True)
        check("网格模式显示卡片", page.locator("#localFileList .local-grid-card").count() == 1)
        check("网格模式隐藏详情区域", page.locator(".local-display-grid .local-main").count() == 1)
        check("搜索筛选和分类位于左栏", page.locator(".local-display-grid .local-sidebar-tools .local-grid-cat-btn").count() >= 2)
        check("主要操作位于左栏", page.locator(".local-display-grid .local-grid-sidebar-actions").count() == 1)
        check("卡片描述使用悬浮层", page.evaluate("getComputedStyle(document.querySelector('.local-grid-body')).position") == "absolute")
        check("卡片悬浮按钮可见", page.evaluate("getComputedStyle(document.querySelector('.local-grid-actions')).opacity") == "1")
        check("已匹配使用绿色圆点", page.locator(".local-grid-status-dot.matched").count() == 1)
        check("匹配状态不显示文字徽章", page.locator(".local-grid-card .local-list-badge").count() == 0)
        check("分类与元数据同一行", page.locator(".local-grid-meta .local-grid-tags").count() == 1)
        check("卡片显示对应 LoRA 页面按钮", page.locator(".local-open-model").count() == 1)
        page.evaluate("window.__openedModelUrl = ''; window.open = url => { window.__openedModelUrl = url; return null; }")
        page.locator(".local-open-model").click()
        check(
            "地球按钮打开对应 Civitai 页面",
            page.evaluate("window.__openedModelUrl") == "https://civitai.com/models/1?modelVersionId=1",
        )

        page.locator(".local-preview-upload").click()
        page.wait_for_selector("#localPreviewDropzone", timeout=5_000)
        check("自定义预览图显示悬浮上传弹窗", page.locator("#localPreviewDropzone").count() == 1)
        check("上传弹窗提供选择文件", page.locator("#localPreviewFileBtn").count() == 1)
        with page.expect_file_chooser() as chooser_info:
            page.locator("#localPreviewFileBtn").click()
        chooser_info.value.set_files(image_path)
        page.wait_for_selector(".local-grid-custom", timeout=10_000)
        check("卡片显示自定义预览标记", True)

        page.locator(".local-preview-upload").click()
        page.wait_for_selector("#localPreviewDropzone", timeout=5_000)
        image_data = base64.b64encode(Path(image_path).read_bytes()).decode()
        page.evaluate(
            """data => {
                const zone = document.querySelector('#localPreviewDropzone');
                const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
                const file = new File([bytes], 'dropped-preview.png', {type: 'image/png'});
                const transfer = new DataTransfer();
                transfer.items.add(file);
                zone.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
            }""",
            image_data,
        )
        page.wait_for_function("!document.querySelector('#localPreviewModal')")
        check("拖拽图片上传后关闭弹窗", True)

        page.locator(".local-grid-body").click()
        page.wait_for_function("!document.querySelector('.local-split')?.classList.contains('local-display-grid')")
        check("点击网格卡片进入详情并恢复列表布局", page.locator("#pageLocalDetail.active").count() == 1)

        page.reload(wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_selector("#localGridViewBtn", timeout=15_000)
        page.wait_for_timeout(1_000)
        page.locator("#localGridViewBtn").click()
        page.wait_for_selector(".local-grid-custom", timeout=10_000)
        check("刷新后从 IndexedDB 恢复自定义预览图", True)

        page.locator("#localListViewBtn").click()
        page.wait_for_function("!document.querySelector('.local-split')?.classList.contains('local-display-grid')")
        check("列表视图切换恢复", True)
        check("无页面 JS 异常", not errors, errors[:5])
        context.close()


with tempfile.NamedTemporaryFile(prefix="tk-preview-", suffix=".png", delete=False) as image_file:
    # 1x1 PNG；只验证文件选择、压缩、IndexedDB 恢复链路，不依赖外部图片。
    image_file.write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
    image_path = image_file.name

available = [(name, path) for name, path in BROWSERS if path.exists()]
if not available:
    raise RuntimeError("未找到 Chrome 或 Edge 可执行文件")

with sync_playwright() as playwright:
    for browser_name, executable in available:
        run_ui_smoke(playwright, browser_name, executable, image_path)
