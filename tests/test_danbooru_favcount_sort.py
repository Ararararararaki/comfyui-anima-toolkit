"""Live regression for favorite-count sorting fallback in the gallery endpoint."""
from __future__ import annotations

import json
from urllib.parse import quote

from playwright.sync_api import sync_playwright


URL = "http://127.0.0.1:8188/anima/danbooru/posts"


with sync_playwright() as playwright:
    request = playwright.request.new_context()
    response = request.get(f"{URL}?tags={quote('1girl order:favcount')}&limit=1&force=1", timeout=60_000)
    if response.status != 200:
        raise AssertionError(f"收藏排序请求失败：HTTP {response.status} {response.text()[:300]!r}")
    payload = response.json()
    if not isinstance(payload.get("posts"), list):
        raise AssertionError(f"收藏排序响应缺少 posts：{json.dumps(payload, ensure_ascii=False)[:500]}")
    warnings = [str(item) for item in payload.get("warnings", [])]
    if not any("favcount" in warning for warning in warnings):
        raise AssertionError(f"收藏排序降级 warning 缺少排序字段：{warnings!r}")
    request.dispose()

print("PASS: order:favcount 超时降级后仍返回 200，并保留 warning")
