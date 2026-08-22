# -*- coding: utf-8 -*-
"""v10 全链路：/anima/cards/classify 真实 DashScope 分类 + AI 入卡确认流程落库验证。"""
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

    # 1) 后端 classify 直测
    import urllib.request
    body = json.dumps({
        "cards": [
            {"id": "a", "text": "skadi (arknights)"},
            {"id": "b", "text": "masterpiece, best quality"},
            {"id": "c", "text": "sitting on a chair, legs crossed"},
        ],
        "cats": ["通用", "角色", "画风", "姿势", "场景", "质量词", "LoRA 触发词"],
    }).encode()
    req = urllib.request.Request("http://127.0.0.1:8188/anima/cards/classify", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.loads(r.read())
    print("classify API:", json.dumps(res, ensure_ascii=False))

    page = ctx.new_page()
    errs = []
    dlgs = []
    page.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
    page.on("console", lambda m: errs.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("dialog", lambda d: (dlgs.append(d.message), d.dismiss()))
    page.goto("http://127.0.0.1:8188", wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)
    page.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const n = LiteGraph.createNode('TKPromptCards');
      app.graph.add(n);
    }""")
    page.wait_for_timeout(1800)

    # 2) AI 入卡：输入 → 确认清单出现（含 LLM 建议分类）
    page.locator(".tk-cards-ui textarea").fill("skadi (arknights), masterpiece best quality, sitting on a chair")
    page.wait_for_timeout(300)
    page.locator("text=AI 入卡").first.click()
    page.wait_for_timeout(15000)  # 等 LLM 分类 + 清单渲染
    print("dialogs:", dlgs)
    rows = page.locator(".tk-cards-ai-row")
    print("确认清单行数:", rows.count())
    if rows.count():
        cats_picked = page.locator(".tk-cards-ai-cat").evaluate_all(
            "els => els.map(e => e.value)")
        print("清单预选分类(按行):", cats_picked)
        # 3) 确认入卡
        page.locator('button:has-text("确认入卡")').first.click()
        page.wait_for_timeout(2500)
    else:
        print("!! 清单未出现（LLM 分类失败？）")

    # 4) 落库验证：按分类统计
    db_state = page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const q = db.transaction('cards', 'readonly').objectStore('cards').getAll();
      const cs = await new Promise((res, rej) => { q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
      const cats = await new Promise((res, rej) => {
        const cq = db.transaction('cardCategories', 'readonly').objectStore('cardCategories').getAll();
        cq.onsuccess = () => res(cq.result || []); cq.onerror = () => rej(cq.error);
      });
      const nameOf = {};
      for (const c of cats) nameOf[c.id] = c.name;
      const mine = cs.filter(x => ['skadi (arknights)', 'masterpiece best quality', 'sitting on a chair'].includes(x.prompt));
      return mine.map(x => ({ prompt: x.prompt, cat: nameOf[x.categoryId] || x.categoryId }));
    }""")
    print("落库结果:", json.dumps(db_state, ensure_ascii=False))

    # 5) 清理
    page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-tk-cards');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const q = db.transaction('cards', 'readonly').objectStore('cards').getAll();
      q.onsuccess = () => {
        const tx = db.transaction('cards', 'readwrite');
        for (const c of q.result || []) {
          if (['skadi (arknights)', 'masterpiece best quality', 'sitting on a chair'].includes(c.prompt)) {
            tx.objectStore('cards').delete(c.id);
          }
        }
      };
    }""")
    print("errors:", errs if errs else "none")
    b.close()