# -*- coding: utf-8 -*-
"""v13：快速分类大弹窗 + 卡片拖到分类 tab 转移。"""
import json
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
    pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(['cardCategories', 'cards'], 'readwrite');
      tx.objectStore('cardCategories').put({ id: 'cat_a', name: '分组甲', icon: '', sortOrder: 1 });
      tx.objectStore('cardCategories').put({ id: 'cat_b', name: '分组乙', icon: '', sortOrder: 2 });
      tx.objectStore('cards').put({ id: 'c_x', prompt: 'test tag x', notes: '', weight: '', lora: '', multi: false, categoryId: 'cat_a', isFavorite: false, createdAt: Date.now(), updatedAt: Date.now() });
    }""")
    pg.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const node = app.graph._nodes.find((n) => n.type === 'TKPromptCards');
      if (node && node._cardsUI) node._cardsUI.reloadCards();
    }""")
    pg.wait_for_timeout(600)

    # 1) ▣ 大弹窗
    pg.locator(".tk-cards-card").first.hover()
    pg.wait_for_timeout(300)
    pg.locator(".tk-cards-cat-btn").first.click()
    pg.wait_for_timeout(400)
    dialog_items = pg.locator(".tk-cards-catpick-item").count()
    search_box = pg.locator('.tk-cards-overlay [data-a="search"]').count()
    print("大弹窗分类项:", dialog_items, "| 搜索框:", search_box)
    pg.locator(".tk-cards-overlay [data-a='close']").click()

    # 2) 卡片拖到分类 tab（模拟 dragstart 状态 + drop 事件）
    r = pg.evaluate("""async () => {
      const app = window.comfyAPI.app.app;
      const node = app.graph._nodes.find((n) => n.type === 'TKPromptCards');
      const ui = node._cardsUI;
      ui._dragCardId = 'c_x';
      ui._dragCardCat = 'cat_a';
      const tabs = Array.from(document.querySelectorAll('.tk-cards-cat'));
      const target = tabs.find((t) => t.textContent.includes('分组乙'));
      if (!target) return { ok: false, err: 'tab not found' };
      target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 400));
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const card = await new Promise((res, rej) => {
        const q = db.transaction('cards', 'readonly').objectStore('cards').get('c_x');
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      return { ok: true, categoryId: card ? card.categoryId : null };
    }""")
    print("拖到分类 tab 转移:", json.dumps(r, ensure_ascii=False))

    # 清理
    pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction(['cards', 'cardCategories'], 'readwrite');
      tx.objectStore('cards').delete('c_x');
      tx.objectStore('cardCategories').delete('cat_a');
      tx.objectStore('cardCategories').delete('cat_b');
    }""")
    print("errors:", errs if errs else "none")
    b.close()