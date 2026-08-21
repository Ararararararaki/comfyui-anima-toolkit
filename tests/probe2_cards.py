# -*- coding: utf-8 -*-
"""侦查 2：扩展注册表 + 扩展文件 HTTP 可达性。"""
import json
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8188"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(BASE, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)

    exts = page.evaluate("""() => {
      const app = window.comfyAPI?.app?.app;
      if (!app) return { err: "no app" };
      const names = (app.extensions || []).map(e => String(e.name || "")).filter(Boolean);
      return { count: names.length, anima: names.filter(n => /TK|Anima|Prompt|Batch|Cards/i.test(n)), all: names.slice(0, 60) };
    }""")
    print("EXTENSIONS:", json.dumps(exts, ensure_ascii=False, indent=1))

    # 直接请求扩展文件
    for url in [
        "/extensions/ComfyUI-Anima-Batch-LoRA/js/anima_prompt_cards_widget.js",
        "/extensions/ComfyUI-Anima-Batch-LoRA/js/anima_prompt_batch_widget.js",
        "/extensions",
    ]:
        r = page.request.get(BASE + url)
        body = r.text()[:120] if r.status == 200 else ""
        print(f"GET {url} -> {r.status} {body}")

    browser.close()