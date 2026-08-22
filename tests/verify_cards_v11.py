# -*- coding: utf-8 -*-
"""v11：分类删除（hover ✕ → confirm → 卡片归并「通用」）。"""
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
      tx.objectStore('cardCategories').put({ id: 'cat_del_test', name: '临时分类', icon: '', sortOrder: 99 });
      tx.objectStore('cards').put({ id: 'c_del_test', prompt: 'test tag', notes: '', weight: '', lora: '', multi: false, categoryId: 'cat_del_test', isFavorite: false, createdAt: Date.now(), updatedAt: Date.now() });
    }""")
    pg.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const node = app.graph._nodes.find((n) => n.type === 'TKPromptCards');
      if (node && node._cardsUI) node._cardsUI.reloadCards();
    }""")
    pg.wait_for_timeout(800)
    tab = pg.locator(".tk-cards-cat", has_text="临时分类")
    print("临时分类 tab:", tab.count())
    tab.first.hover()
    pg.wait_for_timeout(300)
    print("hover 后删除按钮:", pg.locator(".tk-cards-cat-del").count())
    dialogs = []
    pg.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    pg.locator(".tk-cards-cat-del").last.click()
    pg.wait_for_timeout(800)
    print("确认弹窗:", len(dialogs) > 0)
    st = pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const cats = await new Promise((res, rej) => {
        const q = db.transaction('cardCategories', 'readonly').objectStore('cardCategories').getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
      const card = await new Promise((res, rej) => {
        const q = db.transaction('cards', 'readonly').objectStore('cards').get('c_del_test');
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      return { catGone: !cats.some((c) => c.id === 'cat_del_test'), cardCat: card ? card.categoryId : null };
    }""")
    print("分类已删:", st["catGone"], "| 卡片归并到:", st["cardCat"])
    pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      db.transaction('cards', 'readwrite').objectStore('cards').delete('c_del_test');
    }""")
    print("errors:", errs if errs else "none")
    b.close()