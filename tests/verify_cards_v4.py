# -*- coding: utf-8 -*-
"""回归：删除交互改 hover ✕ 后的端到端检查。"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctxp = b.new_context(viewport={"width": 1680, "height": 1050})
    boot = ctxp.new_page()
    boot.goto("http://127.0.0.1:8188", wait_until="domcontentloaded", timeout=60000)
    boot.evaluate("""async () => {
      await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora', 10);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', {keyPath:'id'});
          if (!db.objectStoreNames.contains('promptCategories')) db.createObjectStore('promptCategories', {keyPath:'id'});
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }""")
    boot.close()
    pg = ctxp.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto("http://127.0.0.1:8188", wait_until="networkidle", timeout=60000)
    pg.wait_for_timeout(2000)
    pg.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const n = LiteGraph.createNode('TKPromptCards');
      app.graph.add(n);
    }""")
    pg.wait_for_timeout(1500)
    ui = pg.locator(".tk-cards-ui")
    print("ui:", ui.count())
    pg.locator(".tk-cards-ui textarea").fill("1girl, long hair, blue eyes, 白色连衣裙")
    pg.wait_for_timeout(400)
    chips = pg.locator(".tk-cards-chip").count()
    xbtns = pg.locator(".tk-cards-chip-x").count()
    print("chips:", chips, "chip-x:", xbtns)
    pg.locator(".tk-cards-chip").first.click()
    pg.wait_for_timeout(1000)
    cards = pg.locator(".tk-cards-card").count()
    dels = pg.locator(".tk-cards-del").count()
    print("cards:", cards, "del-btns:", dels)
    pg.locator(".tk-cards-card").first.hover()
    pg.wait_for_timeout(300)
    pg.locator(".tk-cards-card .tk-cards-del").first.click()
    pg.wait_for_timeout(400)
    print("after-del cards:", pg.locator(".tk-cards-card").count())
    print("undo-btn:", pg.locator("text=撤销删除").count() > 0)
    # 清理测试写入
    pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const q = db.transaction('prompts', 'readonly').objectStore('prompts').getAll();
      q.onsuccess = () => {
        const tx = db.transaction('prompts', 'readwrite');
        for (const pr of q.result || []) {
          if (pr.kind === 'card' && pr.prompt === '1girl') tx.objectStore('prompts').delete(pr.id);
        }
      };
    }""")
    print("errors:", errors if errors else "none")
    b.close()