# -*- coding: utf-8 -*-
"""v15：多分类（同词入两分类合并）+ AI 清单 ✕ 移除词。"""
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

    # 1) 同词入两个分类 → 合并为一张卡（categories 数组）
    r1 = pg.evaluate("""async () => {
      const app = window.comfyAPI.app.app;
      const node = app.graph._nodes.find((n) => n.type === 'TKPromptCards');
      const ui = node._cardsUI;
      await ui.reloadCards();
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      // 动态建两个分类
      const cats = await new Promise((res, rej) => {
        const q = db.transaction('cardCategories', 'readonly').objectStore('cardCategories').getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
      const mk = (id, name) => { if (!cats.some(c => c.id === id)) { db.transaction('cardCategories', 'readwrite').objectStore('cardCategories').put({ id, name, icon: '', sortOrder: 50 }); } };
      mk('cat_x', '分类X'); mk('cat_y', '分类Y');
      ui.cardCats = (await new Promise((res, rej) => {
        const q = db.transaction('cardCategories', 'readonly').objectStore('cardCategories').getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      })).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      await ui.addCard('cat_x', { en: 'multi tag', zh: '', weight: '' });
      await ui.addCard('cat_y', { en: 'multi tag', zh: '', weight: '' });
      const cs = await new Promise((res, rej) => {
        const q = db.transaction('cards', 'readonly').objectStore('cards').getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
      const mine = cs.filter(c => c.prompt === 'multi tag');
      return { count: mine.length, cats: mine.length ? (mine[0].categories || []) : [] };
    }""")
    print("同词两分类入卡:", json.dumps(r1, ensure_ascii=False))
    ok_merge = r1["count"] == 1 and set(r1["cats"]) == {"cat_x", "cat_y"}

    # 2) ▣ 多选弹窗（checkbox）
    pg.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      app.graph._nodes.find((n) => n.type === 'TKPromptCards')._cardsUI.reloadCards();
    }""")
    pg.wait_for_timeout(600)
    pg.locator(".tk-cards-card").first.hover()
    pg.wait_for_timeout(300)
    pg.locator(".tk-cards-cat-btn").first.click()
    pg.wait_for_timeout(400)
    checks = pg.locator('.tk-cards-catpick-item input[type="checkbox"]').count()
    print("多选弹窗 checkbox 数:", checks)
    pg.locator('.tk-cards-overlay [data-a="close"]').click()

    # 3) AI 入卡清单 ✕ 移除词（真实 LLM）
    pg.locator(".tk-cards-ui textarea").fill("remove me word, keep me word")
    pg.wait_for_timeout(300)
    pg.locator("text=AI 入卡").first.click()
    pg.wait_for_timeout(15000)
    rows = pg.locator(".tk-cards-ai-row").count()
    rm_btns = pg.locator(".tk-cards-ai-rm").count()
    print("AI 清单行/移除按钮:", rows, "/", rm_btns)
    if rows:
        # 移除第 1 行
        pg.locator(".tk-cards-ai-rm").first.click()
        pg.wait_for_timeout(200)
        confirm_text = pg.locator('[data-a="confirm"]').inner_text()
        print("移除一行后确认按钮包含[1 张]:", "1 张" in confirm_text)
        pg.locator('[data-a="confirm"]').click()
        pg.wait_for_timeout(3000)
        st = pg.evaluate("""async () => {
          const db = await new Promise((res, rej) => {
            const r = indexedDB.open('anima-tk-cards');
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
          });
          const q = db.transaction('cards', 'readonly').objectStore('cards').getAll();
          const cs = await new Promise((res, rej) => { q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
          return {
            removedWord: cs.some(c => c.prompt === 'remove me word'),
            keptWord: cs.some(c => c.prompt === 'keep me word'),
          };
        }""")
        print("被移除词未入库:", not st["removedWord"], "| 保留词已入库:", st["keptWord"])
    else:
        print("!! 清单未出现")

    # 清理
    pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const q = db.transaction('cards', 'readonly').objectStore('cards').getAll();
      q.onsuccess = () => {
        const tx = db.transaction(['cards', 'cardCategories'], 'readwrite');
        for (const c of q.result || []) {
          if (['multi tag', 'remove me word', 'keep me word'].includes(c.prompt)) tx.objectStore('cards').delete(c.id);
        }
        tx.objectStore('cardCategories').delete('cat_x');
        tx.objectStore('cardCategories').delete('cat_y');
      };
    }""")
    print("errors:", errs if errs else "none")
    b.close()