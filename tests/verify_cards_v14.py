# -*- coding: utf-8 -*-
"""v14：拖到分类 tab 后 curCat 保持原分类（不跳转）。"""
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
    pg.evaluate("""async () => {
      const app = window.comfyAPI.app.app;
      const node = app.graph._nodes.find((n) => n.type === 'TKPromptCards');
      const ui = node._cardsUI;
      await ui.reloadCards();
      ui.curCat = 'cat_a';
      ui._renderCatTabs(); ui._renderCards();
    }""")
    pg.wait_for_timeout(400)
    r = pg.evaluate("""async () => {
      const app = window.comfyAPI.app.app;
      const node = app.graph._nodes.find((n) => n.type === 'TKPromptCards');
      const ui = node._cardsUI;
      ui._dragCardId = 'c_x';
      ui._dragCardCat = 'cat_a';
      const tabs = Array.from(document.querySelectorAll('.tk-cards-cat'));
      const target = tabs.find((t) => t.textContent.includes('分组乙'));
      target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 400));
      return { curCat: ui.curCat, cardCat: (await (async () => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('anima-tk-cards');
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        return await new Promise((res, rej) => {
          const q = db.transaction('cards', 'readonly').objectStore('cards').get('c_x');
          q.onsuccess = () => res(q.result ? q.result.categoryId : null);
          q.onerror = () => rej(q.error);
        });
      })()) };
    }""")
    print("curCat(应 cat_a):", r["curCat"], "| cardCat(应 cat_b):", r["cardCat"])
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