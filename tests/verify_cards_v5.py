# -*- coding: utf-8 -*-
"""v5 回归：①区网格多列 + 悬浮预览图 + 删除二次确认 + 全译按钮。"""
from playwright.sync_api import sync_playwright

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

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
          if (!db.objectStoreNames.contains('artists')) db.createObjectStore('artists', {keyPath:'tag'});
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('prompts', 'readwrite');
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        tx.objectStore('prompts').put({
          id: 'v5test_' + i,
          prompt: 'test card prompt ' + i + ', long hair, blue eyes',
          displayText: 'V5测试条目' + i,
          notes: '注释' + i,
          tags: [], images: ["__TINY__"], primaryImage: "__TINY__",
          categoryId: 'uncategorized', isFavorite: i === 0,
          kind: i % 2 ? 'card' : 'prompt',
          createdAt: now + i, updatedAt: now + i,
        });
      }
    }""".replace("__TINY__", TINY_PNG))
    boot.close()

    page = ctxp.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://127.0.0.1:8188", wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)
    page.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const n = LiteGraph.createNode('TKPromptCards');
      app.graph.add(n);
    }""")
    page.wait_for_timeout(1500)

    ui = page.locator(".tk-cards-ui")
    print("ui:", ui.count())

    # ①区网格列数：5 个条目，容器宽 / 条目宽 >= 3 → 多列
    items = page.locator(".tk-cards-lib-item")
    print("lib items:", items.count())
    if items.count() >= 3:
      box = items.first.bounding_box()
      cont = page.locator(".tk-cards-lib-list").bounding_box()
      cols = max(1, int(cont["width"] // box["width"])) if box and cont else 1
      print("estimated columns:", cols)

    # 悬浮预览图：hover 第一条 → tip 出现且含 img
    items.first.hover()
    page.wait_for_timeout(700)
    tip_imgs = page.locator(".tk-cards-lib-tip img").count()
    print("hover tip img:", tip_imgs)
    page.mouse.move(10, 10)
    page.wait_for_timeout(300)

    # ②区全译按钮
    print("translate-all btn:", page.locator("text=全译入卡").count() > 0)

    # 追加一个卡片（用②区文本 → chip 存卡）→ ③卡片视图
    page.locator(".tk-cards-ui textarea").fill("blue eyes, 白色连衣裙")
    page.wait_for_timeout(300)
    page.locator(".tk-cards-chip").first.click()
    page.wait_for_timeout(600)
    card = page.locator(".tk-cards-card")
    print("cards:", card.count())

    # 删除二次确认：第一次点 ✕ → arm（text ✓删?）；点卡片外部复位；再次点 ✕ 两次 → 删除
    card.first.hover()
    page.wait_for_timeout(300)
    page.locator(".tk-cards-card .tk-cards-del").first.click()
    page.wait_for_timeout(200)
    print("after 1st click (armed):", page.locator(".tk-cards-del.arm").count())
    page.locator(".tk-cards-card .tk-cards-del").first.click()
    page.wait_for_timeout(300)
    print("after 2nd click (deleted):", page.locator(".tk-cards-card").count())

    # 清理 v5 测试数据
    page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const q = db.transaction('prompts', 'readonly').objectStore('prompts').getAll();
      q.onsuccess = () => {
        const tx = db.transaction('prompts', 'readwrite');
        for (const pr of q.result || []) {
          if (String(pr.id || '').startsWith('v5test_') || (pr.kind === 'card' && pr.prompt === 'blue eyes')) {
            tx.objectStore('prompts').delete(pr.id);
          }
        }
      };
    }""")
    print("errors:", errors if errors else "none")
    b.close()