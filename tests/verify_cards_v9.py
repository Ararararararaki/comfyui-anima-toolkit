# -*- coding: utf-8 -*-
"""v9：AI 入卡 fallback（无 LLM → confirm 取消不崩溃）+ 确认清单（无 LLM 时不出现）。"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1680, "height": 1050})
    boot = ctx.new_page()
    boot.goto("http://127.0.0.1:8188", wait_until="domcontentloaded", timeout=60000)
    boot.evaluate("""async () => {
      await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora', 10);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', {keyPath:'id'});
          if (!db.objectStoreNames.contains('promptCategories')) db.createObjectStore('promptCategories', {keyPath:'id'});
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    }""")
    boot.close()
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8188", wait_until="networkidle", timeout=60000)
    pg.wait_for_timeout(2000)
    pg.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const n = LiteGraph.createNode('TKPromptCards');
      app.graph.add(n);
    }""")
    pg.wait_for_timeout(1500)
    pg.locator(".tk-cards-ui textarea").fill("blue eyes, white dress")
    pg.wait_for_timeout(300)
    dialogs = []
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    pg.locator("text=智能入卡").first.click()
    pg.wait_for_timeout(3000)
    print("智能入卡按钮:", pg.locator("text=智能入卡").count() > 0)
    print("confirm 弹窗（LLM 不可用应触发）:", len(dialogs))
    print("确认清单 overlay（此时不应出现）:", pg.locator(".tk-cards-ai-list").count())
    print("errors:", errs if errs else "none")
    b.close()
