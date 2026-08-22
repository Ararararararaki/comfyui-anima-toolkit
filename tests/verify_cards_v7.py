# -*- coding: utf-8 -*-
"""v7 回归：①分类下拉+条目删除+无悬浮层；③卡片拖拽/置顶/分类拖拽。"""
import json
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
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('prompts', 'readwrite');
      tx.objectStore('prompts').put({
        id: 'v7_del_me', prompt: 'del me entry', displayText: '待删词条',
        notes: '', tags: [], images: ["IMG"], primaryImage: "IMG",
        categoryId: 'uncategorized', isFavorite: false,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    }""".replace('"IMG"', '"' + TINY_PNG + '"'))
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

    # ①分类下拉
    cat_sel = page.locator(".tk-cards-lib-list").count()
    print("lib list:", cat_sel, "| libcat select:", page.locator("select.tk-cards-select").count() >= 1)

    # 无悬浮预览层残留
    print("tip layer removed:", page.locator(".tk-cards-lib-tip").count() == 0)

    # ①条目 hover ✕ → 二次确认删除 prompt 库条目
    item = page.locator(".tk-cards-lib-item").first
    item.hover()
    page.wait_for_timeout(300)
    page.locator(".tk-cards-lib-item .tk-cards-del").first.click()
    page.wait_for_timeout(200)
    print("lib del armed:", page.locator(".tk-cards-lib-item .tk-cards-del.arm").count())
    page.locator(".tk-cards-lib-item .tk-cards-del").first.click()
    page.wait_for_timeout(400)
    print("lib items after del:", page.locator(".tk-cards-lib-item").count())

    # ③：造 1 张卡 → 置顶按钮 → 拖拽排序（用 JS 触发 drop 简化验证：直接调 UI 方法不可达，
    # 改为验证 DOM 结构含 grip/pin）：
    page.locator(".tk-cards-ui textarea").fill("alpha, beta, gamma")
    page.wait_for_timeout(300)
    page.locator("text=一键入卡").first.click()
    page.wait_for_timeout(1200)
    cards = page.locator(".tk-cards-card")
    print("cards:", cards.count())
    page.locator(".tk-cards-card").first.hover()
    page.wait_for_timeout(300)
    print("grip exists:", page.locator(".tk-cards-grip").count() >= 3)
    print("pin exists:", page.locator(".tk-cards-pin").count() >= 3)

    # 置顶：点击第二张卡 ↑ → 顺序变化（alpha 应排最前——入卡顺序 alpha/beta/gamma，
    # 每张卡 order 按时间；验证点击第一张的 pin 后 DOM 顺序不变（已最前），
    # 点击第三张 pin → DOM 首卡变 gamma）
    page.locator(".tk-cards-card").nth(2).hover()
    page.wait_for_timeout(200)
    page.locator(".tk-cards-card .tk-cards-pin").nth(2).click()
    page.wait_for_timeout(500)
    first_en = page.locator(".tk-cards-card-en").first.inner_text()
    print("first card after pin:", first_en)

    # 分类 tab 可拖（draggable=true）
    draggable_tabs = page.locator(".tk-cards-cat[draggable='true']").count()
    print("draggable cat tabs:", draggable_tabs)

    # 清理
    page.evaluate("""async () => {
      const open = (name) => new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const lora = await open('anima-lora');
      const ltx = lora.transaction('prompts', 'readwrite');
      ltx.objectStore('prompts').delete('v7_del_me');
      const cd = await open('anima-tk-cards');
      const q = cd.transaction('cards', 'readonly').objectStore('cards').getAll();
      q.onsuccess = () => {
        const tx = cd.transaction('cards', 'readwrite');
        for (const c of q.result || []) {
          if (['alpha', 'beta', 'gamma'].includes(c.prompt)) tx.objectStore('cards').delete(c.id);
        }
      };
    }""")
    print("errors:", errors if errors else "none")
    b.close()