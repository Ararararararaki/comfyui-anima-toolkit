# -*- coding: utf-8 -*-
"""诊断：浏览器里 /anima/cards/classify 的实际请求与响应。"""
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1680, "height": 1050})
    page = ctx.new_page()
    page.on("response", lambda r: print("RESP:", r.status, r.url) if "/anima/cards" in r.url else None)
    page.on("request", lambda r: print("REQ :", r.method, r.url) if "/anima/cards" in r.url else None)
    page.goto("http://127.0.0.1:8188", wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)
    page.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const n = LiteGraph.createNode('TKPromptCards');
      app.graph.add(n);
    }""")
    page.wait_for_timeout(1500)
    page.locator(".tk-cards-ui textarea").fill("skadi (arknights), masterpiece best quality")
    page.wait_for_timeout(300)
    page.on("dialog", lambda d: (print("DIALOG:", d.message), d.dismiss()))
    page.locator("text=AI 入卡").first.click()
    page.wait_for_timeout(10000)
    b.close()