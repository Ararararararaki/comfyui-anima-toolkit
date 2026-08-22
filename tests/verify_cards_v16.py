# -*- coding: utf-8 -*-
"""v16：②区卡片库联想补全（输入联想 → 点击/Enter 替换光标词）。"""
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
    # 造 3 张卡：blonde hair / blue eyes / black dress
    pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const cats = await new Promise((res, rej) => {
        const q = db.transaction('cardCategories', 'readonly').objectStore('cardCategories').getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
      const fallback = (cats.find(c => c.id === 'card_all') || cats[0]).id;
      const tx = db.transaction('cards', 'readwrite');
      const now = Date.now();
      tx.objectStore('cards').put({ id: 's1', prompt: 'blonde hair', notes: '金发', categories: [fallback], categoryId: fallback, isFavorite: false, createdAt: now, updatedAt: now });
      tx.objectStore('cards').put({ id: 's2', prompt: 'blue eyes', notes: '蓝眼睛', categories: [fallback], categoryId: fallback, isFavorite: false, createdAt: now + 1, updatedAt: now + 1 });
      tx.objectStore('cards').put({ id: 's3', prompt: 'black dress', notes: '黑裙', categories: [fallback], categoryId: fallback, isFavorite: false, createdAt: now + 2, updatedAt: now + 2 });
    }""")
    pg.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const node = app.graph._nodes.find((n) => n.type === 'TKPromptCards');
      if (node && node._cardsUI) node._cardsUI.reloadCards();
    }""")
    pg.wait_for_timeout(600)

    # 输入 "1girl, bl" → 联想出现（blonde hair / blue eyes）
    ta = pg.locator(".tk-cards-ui textarea")
    ta.click()
    pg.keyboard.type("1girl, bl")
    pg.wait_for_timeout(500)
    items = pg.locator(".tk-cards-suggest-item")
    print("联想项:", items.count())
    texts = items.all_text_contents() if items.count() else []
    print("联想内容:", texts)

    # 点击第一项（按时间倒序=black dress）→ 替换光标处 "bl"，保留逗号后空格
    if items.count():
        items.first.click()
        pg.wait_for_timeout(400)
        val = ta.input_value()
        print("替换后 textarea:", val)
        print("替换正确:", val == "1girl, black dress")

    # Enter 路径：再输入 ", bl" → 光标在末尾 → 键盘 Enter 选第一条
    ta.click()
    pg.keyboard.press("ControlOrMeta+End")
    pg.keyboard.type(", bl")
    pg.wait_for_timeout(500)
    items2 = pg.locator(".tk-cards-suggest-item")
    print("第二次联想项:", items2.count())
    if items2.count():
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(400)
        val2 = ta.input_value()
        print("Enter 替换后:", val2)
    else:
        print("!! 第二次联想未出现")

    # 清理
    pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('cards', 'readwrite');
      tx.objectStore('cards').delete('s1');
      tx.objectStore('cards').delete('s2');
      tx.objectStore('cards').delete('s3');
    }""")
    print("errors:", errs if errs else "none")
    b.close()