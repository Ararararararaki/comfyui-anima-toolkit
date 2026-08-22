# -*- coding: utf-8 -*-
"""v6 回归：双库隔离。入卡只写 anima-tk-cards，anima-lora（prompt 库）零污染；
②翻译不落库；一键入卡；快速分类菜单。"""
import json
from playwright.sync_api import sync_playwright

TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctxp = b.new_context(viewport={"width": 1680, "height": 1050})
    boot = ctxp.new_page()
    boot.goto("http://127.0.0.1:8188", wait_until="domcontentloaded", timeout=60000)
    # 建 v10 prompt 库（1 条带图完整词条，模拟用户面板数据）
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
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('prompts', 'readwrite');
      tx.objectStore('prompts').put({
        id: 'v6_prompt_entry',
        prompt: 'masterpiece, best quality, 1girl, long hair, full body',
        displayText: '完整生图词条',
        notes: '', tags: [], images: ["IMG"], primaryImage: "IMG",
        categoryId: 'uncategorized', isFavorite: false,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    }""".replace('"IMG"', '"' + TINY_PNG + '"'))
    # 确保卡片库不存在（全新）
    boot.evaluate("""async () => {
      const names = await new Promise((res) => {
        const r = indexedDB.open('anima-tk-cards', 1);
        r.onsuccess = () => { const d = r.result; res(Array.from(d.objectStoreNames)); d.close(); };
        r.onerror = () => res(null);
      });
      window.__cardStoreNames = names;
    }""")
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
    page.wait_for_timeout(1800)

    ui = page.locator(".tk-cards-ui")
    print("ui:", ui.count())

    # ①区显示 prompt 库 1 条（完整词条）
    lib_items = page.locator(".tk-cards-lib-item").count()
    print("lib items(prompt库):", lib_items)

    # ③区卡片库应为空 + 卡片分类默认
    cats = page.locator(".tk-cards-cat").all_text_contents()
    print("卡片分类:", cats)
    print("卡片数:", page.locator(".tk-cards-card").count())

    # ②区输入 → 「翻译」（只显示中文，不落库）
    page.locator(".tk-cards-ui textarea").fill("blue eyes, white dress")
    page.wait_for_timeout(300)
    page.locator("text=翻译").first.click()
    page.wait_for_timeout(3000)
    zh_shown = page.locator(".tk-cards-chip-zh").count()
    print("翻译后 chips 中文小字:", zh_shown)
    db_state = page.evaluate("""async () => {
      const open = (name) => new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const all = (db, s) => new Promise((res, rej) => {
        const q = db.transaction(s, 'readonly').objectStore(s).getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
      const lora = await open('anima-lora');
      const cardsDb = await open('anima-tk-cards');
      return {
        promptLibCount: (await all(lora, 'prompts')).length,
        cardStoreExists: !!cardsDb,
        cardStoreNames: cardsDb ? Array.from(cardsDb.objectStoreNames) : [],
        cardCount: cardsDb && cardsDb.objectStoreNames.contains('cards') ? (await all(cardsDb, 'cards')).length : -1,
      };
    }""")
    print("翻译后库状态:", json.dumps(db_state, ensure_ascii=False))
    ok_translate_no_pollution = db_state["cardCount"] == 0 and db_state["promptLibCount"] == 1

    # 「一键入卡」
    page.locator("text=一键入卡").first.click()
    page.wait_for_timeout(1200)
    db_state2 = page.evaluate("""async () => {
      const open = (name) => new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const all = (db, s) => new Promise((res, rej) => {
        const q = db.transaction(s, 'readonly').objectStore(s).getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
      const lora = await open('anima-lora');
      const cardsDb = await open('anima-tk-cards');
      const cs = await all(cardsDb, 'cards');
      return {
        promptLibCount: (await all(lora, 'prompts')).length,
        cardCount: cs.length,
        prompts: cs.map(c => c.prompt),
        notes: cs.map(c => c.notes || ''),
      };
    }""")
    print("入卡后库状态:", json.dumps(db_state2, ensure_ascii=False))
    ok_add = db_state2["cardCount"] == 2 and db_state2["promptLibCount"] == 1 and all(x in db_state2["prompts"] for x in ["blue eyes", "white dress"])
    print("卡片区显示:", page.locator(".tk-cards-card").count())

    # 快速分类：点 ▣ → 菜单出现 → 选另一个分类
    page.locator(".tk-cards-card").first.hover()
    page.wait_for_timeout(300)
    page.locator(".tk-cards-cat-btn").first.click()
    page.wait_for_timeout(300)
    quick_items = page.locator(".tk-cards-quickcat-item").count()
    print("快速分类菜单项:", quick_items)
    if quick_items > 1:
        page.locator(".tk-cards-quickcat-item").nth(1).click()
        page.wait_for_timeout(400)

    # 清理
    page.evaluate("""async () => {
      const open = (name) => new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const lora = await open('anima-lora');
      const ltx = lora.transaction('prompts', 'readwrite');
      ltx.objectStore('prompts').delete('v6_prompt_entry');
      const cd = await open('anima-tk-cards');
      const names = Array.from(cd.objectStoreNames);
      if (names.includes('cards')) {
        const q = cd.transaction('cards', 'readonly').objectStore('cards').getAll();
        q.onsuccess = () => {
          const tx = cd.transaction('cards', 'readwrite');
          for (const c of q.result || []) tx.objectStore('cards').delete(c.id);
        };
      }
    }""")
    print("errors:", errors if errors else "none")
    b.close()