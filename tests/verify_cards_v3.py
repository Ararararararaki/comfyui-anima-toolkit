# -*- coding: utf-8 -*-
"""回归测试：模拟用户环境的 v10 高版本 anima-lora 库 → 节点应能打开并正常 CRUD。"""
import os, json
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)
BASE = "http://127.0.0.1:8188"
LOG = []
def log(m):
    print(m); LOG.append(m)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    # 先用独立页面把库建成 v10（模拟面板升级后的状态）
    ctx = browser.new_context(viewport={"width": 1680, "height": 1050})
    boot = ctx.new_page()
    boot.goto(BASE, wait_until="domcontentloaded", timeout=60000)
    boot.evaluate("""async () => {
      await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora', 10);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('promptCategories')) db.createObjectStore('promptCategories', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('artists')) db.createObjectStore('artists', { keyPath: 'tag' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }""")
    # 检查版本
    v = boot.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const d = { version: db.version, stores: Array.from(db.objectStoreNames) };
      db.close();
      return d;
    }""")
    log(f"模拟库版本: {json.dumps(v, ensure_ascii=False)}")
    boot.close()

    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" or "TK Prompt Cards" in m.text else None)
    page.evaluate("""() => {
      window.addEventListener('unhandledrejection', (e) => console.error('REJECTION:', String(e.reason && e.reason.stack || e.reason)));
    }""")
    page.goto(BASE, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)

    page.evaluate("""() => {
      const app = window.comfyAPI.app.app;
      const node = LiteGraph.createNode('TKPromptCards');
      app.graph.add(node); node.pos = [80, 120];
      app.graph.setDirtyCanvas(true, true);
    }""")
    page.wait_for_timeout(1500)

    ui = page.locator(".tk-cards-ui")
    if ui.count() == 0:
        log("!! UI 未渲染"); browser.close(); sys.exit(1)
    log("UI 渲染 OK")

    # ①区库浏览（应有"库为空"提示，而不是报错）
    lib_text = ui.first.locator(".tk-cards-lib-list").inner_text()
    log(f"①区列表: {lib_text[:60]!r}")

    # 分类页签正常
    cats = ui.first.locator(".tk-cards-cat").all_text_contents()
    log(f"分类页签: {cats}")

    # 存卡 → 写库 → ①区出现
    page.locator(".tk-cards-ui textarea").fill("blue eyes, 白色连衣裙、长发")
    page.wait_for_timeout(300)
    chips = page.locator(".tk-cards-chip").all_text_contents()
    log(f"chips: {chips}")
    page.locator(".tk-cards-chip").first.click()   # blue eyes
    page.wait_for_timeout(2500)

    cards = page.locator(".tk-cards-card-en").all_text_contents()
    log(f"卡片视图: {cards}")
    lib_rows = page.locator(".tk-cards-lib-row").count()
    log(f"①区行数: {lib_rows}")

    db_check = page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('prompts', 'readonly');
      const q = tx.objectStore('prompts').getAll();
      const ps = await new Promise((res, rej) => { q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
      db.close();
      return { version: db.version, total: ps.length, mine: ps.filter(x => x.prompt === 'blue eyes').map(x => ({notes: x.notes, kind: x.kind})) };
    }""")
    log(f"库状态: {json.dumps(db_check, ensure_ascii=False)}")

    # 清理
    page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('prompts', 'readwrite');
      const q = tx.objectStore('prompts').getAll();
      q.onsuccess = () => {
        for (const p of q.result || []) {
          if (p.prompt === 'blue eyes') tx.objectStore('prompts').delete(p.id);
        }
      };
      tx.oncomplete = () => db.close();
    }""")
    log("清理完成")

    if errors:
        log("!!! 页面错误:")
        for e in errors[:10]:
            log("  " + e)
    else:
        log("无 JS 错误")

    ctx.close()
    browser.close()

with open(os.path.join(OUT, "verify_report_v3.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
print("done")