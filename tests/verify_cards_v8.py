# -*- coding: utf-8 -*-
"""v8 回归：①区编辑（双击）+刷新按钮；③AI分类/LLM 按钮存在。"""
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
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('prompts', 'readwrite');
      tx.objectStore('prompts').put({
        id: 'v8_edit_me', prompt: 'test prompt v8', displayText: '标题V8',
        notes: '注释', tags: [], images: [], primaryImage: '',
        categoryId: 'uncategorized', isFavorite: false,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
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

    print("refresh btn:", page.locator("text=刷新").count() > 0)
    print("AI分类 btn:", page.locator("text=AI 分类").count() > 0)
    print("LLM btn:", page.locator("text=LLM").count() >= 1)

    # 双击①条目 → 编辑表单（标题 input data-f=title）
    page.locator(".tk-cards-lib-item").first.dblclick()
    page.wait_for_timeout(400)
    title_inp = page.locator('.tk-cards-lib-item [data-f="title"]')
    print("lib edit form:", title_inp.count())
    if title_inp.count():
        title_inp.fill("新标题V8改")
        page.locator('.tk-cards-lib-item [data-a="save"]').click()
        page.wait_for_timeout(600)
        # 验证 IndexedDB 更新
        r = page.evaluate("""async () => {
          const db = await new Promise((res, rej) => {
            const q = indexedDB.open('anima-lora');
            q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
          });
          return await new Promise((res, rej) => {
            const g = db.transaction('prompts', 'readonly').objectStore('prompts').get('v8_edit_me');
            g.onsuccess = () => res(g.result && g.result.displayText);
            g.onerror = () => rej(g.error);
          });
        }""")
        print("edited title persisted:", r)
    # 清理
    page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open('anima-lora');
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      db.transaction('prompts', 'readwrite').objectStore('prompts').delete('v8_edit_me');
    }""")
    print("errors:", errors if errors else "none")
    b.close()