# -*- coding: utf-8 -*-
"""端到端验证 TK Prompt Cards（IndexedDB 联动版）：
添加节点 → 三区渲染 → 存卡（写 IndexedDB）→ ①区库浏览出现 → 追加/去重 → 截图。"""
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
    page = browser.new_page(viewport={"width": 1680, "height": 1050})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)

    # 确保库存在（headless 是新 profile：首次打开时按节点同样的 onupgradeneeded 建表）
    page.evaluate("""async () => {
      await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('promptCategories')) db.createObjectStore('promptCategories', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    }""")

    # 备份现有库状态（测试后恢复）
    backup = page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora', 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const all = async (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const q = tx.objectStore(name).getAll();
        q.onsuccess = () => res(q.result || []);
        q.onerror = () => rej(q.error);
      });
      return { prompts: await all('prompts'), cats: await all('promptCategories') };
    }""")

    try:
        page.evaluate("""() => {
          const app = window.comfyAPI.app.app;
          const node = LiteGraph.createNode('TKPromptCards');
          app.graph.add(node); node.pos = [80, 120];
          app.graph.setDirtyCanvas(true, true);
        }""")
        page.wait_for_timeout(1200)
        log("节点添加 OK")
    except Exception as e:
        log(f"节点添加失败: {e}")
        browser.close(); sys.exit(1)

    ui = page.locator(".tk-cards-ui")
    if ui.count() == 0:
        log("!! .tk-cards-ui 未渲染"); browser.close(); sys.exit(1)
    log(".tk-cards-ui 渲染 OK")
    ui.first.screenshot(path=os.path.join(OUT, "v2_ui_initial.png"))

    # 三区
    for lbl in ["① 工具箱 prompt 库", "② 当前提示词", "③ 卡片视图"]:
        log(f"区[{lbl}]: {ui.first.locator(f'text={lbl}').count() > 0}")

    # 分类页签（IndexedDB 里现有/默认）
    cats = ui.first.locator(".tk-cards-cat").all_text_contents()
    log(f"分类页签: {cats}")

    # 存卡：在②区输入 → 拆卡 → 点第一个 chip 存为卡片 → IndexedDB 写入
    page.locator(".tk-cards-ui textarea").fill("1girl, long hair, 白色过膝袜、绝对领域")
    page.wait_for_timeout(300)
    chips = page.locator(".tk-cards-chip").all_text_contents()
    log(f"chips: {chips}")
    page.locator(".tk-cards-chip").first.click()  # '1girl' → addCard（自动翻译）
    page.wait_for_timeout(2500)

    # ③卡片视图出现 1girl
    cards = page.locator(".tk-cards-card-en").all_text_contents()
    log(f"卡片视图条目: {cards}")

    # ①库浏览出现刚存的卡片
    lib_rows = page.locator(".tk-cards-lib-row").count()
    log(f"①库浏览行数: {lib_rows}")

    # 追加去重：点卡片 → textarea 变为 '1girl, long hair, ...'（已有 1girl → 追加 long hair？1girl chip 只存了 1girl）
    page.locator(".tk-cards-card").first.click()
    page.wait_for_timeout(300)
    ta = page.locator(".tk-cards-ui textarea").input_value()
    log(f"点击卡片后 textarea: {ta!r}")
    # 再点一次 → 去重不重复
    page.locator(".tk-cards-card").first.click()
    page.wait_for_timeout(300)
    ta2 = page.locator(".tk-cards-ui textarea").input_value()
    log(f"再点一次（去重）: {ta2!r} same={ta == ta2}")

    # IndexedDB 校验
    db_state = page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora', 1);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const all = async (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const q = tx.objectStore(name).getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
      const ps = await all('prompts');
      const mine = ps.filter(p => (p.kind === 'card' && p.prompt === '1girl'));
      return { total: ps.length, added: mine.map(p => ({prompt: p.prompt, notes: p.notes, cat: p.categoryId})) };
    }""")
    log(f"IndexedDB 新增: {json.dumps(db_state, ensure_ascii=False)}")

    ui.first.screenshot(path=os.path.join(OUT, "v2_ui_final.png"))

    # 清理：删除测试写入的条目，恢复备份（只清理本次新增的 1girl 卡）
    page.evaluate("""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('anima-lora', 1);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const all = async (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const q = tx.objectStore(name).getAll();
        q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error);
      });
      const ps = await all('prompts');
      const tx = db.transaction('prompts', 'readwrite');
      for (const p of ps) {
        if (p.kind === 'card' && p.prompt === '1girl' && String(p.notes||'').includes('女孩')) {
          tx.objectStore('prompts').delete(p.id);
        }
      }
      await new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
    }""")
    log("清理测试条目完成")

    if errors:
        log("!!! 页面错误:")
        for e in errors[:8]:
            log("  " + e)
    else:
        log("无页面 JS 错误")

    browser.close()

with open(os.path.join(OUT, "verify_report_v2.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
print("done")