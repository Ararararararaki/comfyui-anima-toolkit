# -*- coding: utf-8 -*-
"""v12：入卡查重——同英文文本两次入库只落 1 张。"""
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
    # 点击 chip 存卡两次（同文本）
    pg.locator(".tk-cards-ui textarea").fill("blue eyes, white dress")
    pg.wait_for_timeout(300)
    pg.locator(".tk-cards-chip").first.click()   # blue eyes 第 1 次
    pg.wait_for_timeout(800)
    pg.locator(".tk-cards-chip").first.click()   # 第 2 次（应跳过）
    pg.wait_for_timeout(800)
    st = pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const q = db.transaction('cards', 'readonly').objectStore('cards').getAll();
      const cs = await new Promise((res, rej) => { q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
      return cs.filter((c) => c.prompt === 'blue eyes').length;
    }""")
    print("blue eyes 入库数量（应=1）:", st)
    # 清理
    pg.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const q = db.transaction('cards', 'readonly').objectStore('cards').getAll();
      q.onsuccess = () => {
        const tx = db.transaction('cards', 'readwrite');
        for (const c of q.result || []) {
          if (['blue eyes', 'white dress'].includes(c.prompt)) tx.objectStore('cards').delete(c.id);
        }
      };
    }""")
    print("errors:", errs if errs else "none")
    b.close()