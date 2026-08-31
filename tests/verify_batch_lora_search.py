"""真实 ComfyUI 回归：TK 批量 LoRA 浏览页的中文/模糊/元数据搜索。"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Route, sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
LORAS = [
    {
        "name": "anime_style.safetensors",
        "filename": "anime_style.safetensors",
        "relativePath": "anime_style.safetensors",
        "size": 1024,
        "lastModified": 1,
    },
    {
        "name": "characters/blue_hair.safetensors",
        "filename": "characters/blue_hair.safetensors",
        "relativePath": "characters/blue_hair.safetensors",
        "size": 2048,
        "lastModified": 2,
    },
    {
        "name": "mix/White-Hair.safetensors",
        "filename": "mix/White-Hair.safetensors",
        "relativePath": "mix/White-Hair.safetensors",
        "size": 4096,
        "lastModified": 3,
    },
]
INFO = {
    "anime_style.safetensors": {
        "name": "anime_style.safetensors",
        "modelName": "幻想少女 光影风格",
        "creator": "画师甲",
        "versionName": "v1",
        "trainedWords": ["蓝发少女", "anime girl"],
        "tags": ["风格", "光影"],
        "previewUrl": None,
        "modelId": 101,
        "source": "test",
    },
    "characters/blue_hair.safetensors": {
        "name": "characters/blue_hair.safetensors",
        "modelName": "蓝色少女",
        "creator": "作者乙",
        "versionName": "v2",
        "trainedWords": ["blue hair"],
        "tags": ["角色"],
        "previewUrl": None,
        "modelId": 102,
        "source": "test",
    },
    "mix/White-Hair.safetensors": {
        "name": "mix/White-Hair.safetensors",
        "modelName": "白发角色",
        "creator": "作者丙",
        "versionName": "v3",
        "trainedWords": ["white hair"],
        "tags": ["角色"],
        "previewUrl": None,
        "modelId": 103,
        "source": "test",
    },
}


def check(name: str, condition: bool, detail: object = "") -> None:
    if not condition:
        raise AssertionError(f"{name}: {detail}")
    print(f"PASS {name}")


def info_response(route: Route) -> None:
    name = parse_qs(urlparse(route.request.url).query).get("name", [""])[0]
    route.fulfill(
        status=200,
        content_type="application/json",
        body=json.dumps(INFO.get(name, {"name": name, "source": "not_on_civitai"}), ensure_ascii=False),
    )


if not CHROME.exists():
    raise RuntimeError(f"未找到 Chrome: {CHROME}")

with tempfile.TemporaryDirectory(prefix="tk-batch-lora-search-") as profile:
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
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.route(
            "**/anima/loras",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"loras": LORAS, "total": len(LORAS)}),
            ),
        )
        page.route(
            "**/anima/meta",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"categories": ["角色", "风格"], "loraMeta": {}, "loraGroups": []}),
            ),
        )
        page.route("**/anima/lora/info*", info_response)
        page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
        page.wait_for_timeout(2_000)
        created = page.evaluate(
            """
            () => {
              const node = LiteGraph.createNode('TK Batch LoRA Loader');
              if (!node) return null;
              window.app.graph.add(node);
              window.__searchNode = node;
              return node.type;
            }
            """
        )
        check("TK 批量 LoRA 节点创建", created == "TK Batch LoRA Loader", created)
        page.wait_for_selector(".anima-lora-widget", timeout=15_000)
        page.evaluate("() => document.querySelector('.anima-lora-widget .toolbar .btn-browse')?.click()")
        page.wait_for_selector(".bm-modal", timeout=8_000)
        page.wait_for_selector(".bm-card", timeout=8_000)
        page.wait_for_timeout(800)

        search = page.locator(".bm-search")
        search.fill("蓝色 少女")
        page.wait_for_timeout(250)
        check("中文多关键词搜索", page.locator(".bm-card").count() == 1)
        check("中文搜索命中模型名称", page.locator(".bm-card").first.get_attribute("data-name") == "characters/blue_hair.safetensors")

        search.fill("画师甲")
        page.wait_for_timeout(250)
        check("作者字段搜索", page.locator(".bm-card").count() == 1)

        search.fill("blue hair")
        page.wait_for_timeout(250)
        check("触发词搜索", page.locator(".bm-card").count() == 1)

        search.fill("角色")
        page.wait_for_timeout(250)
        check("标签搜索", page.locator(".bm-card").count() == 2)

        search.fill("mix\\white hair")
        page.wait_for_timeout(250)
        check("路径分隔符和空格归一化搜索", page.locator(".bm-card").count() == 1)

        search.fill("不存在的 LoRA")
        page.wait_for_timeout(250)
        check("无结果提示", page.locator(".bm-list").get_by_text("没有匹配的 LoRA").count() == 1)
        check("搜索页面无 JS 异常", not page_errors, page_errors[:5])
        context.close()
