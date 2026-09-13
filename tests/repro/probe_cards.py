# -*- coding: utf-8 -*-
"""侦查：TKPromptCards 注册名 vs 显示名 vs beforeRegisterNodeDef 匹配。"""
import json
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8188"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1680, "height": 1050})
    msgs = []
    page.on("console", lambda m: msgs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: msgs.append(f"pageerror: {e}"))
    reqs = []
    page.on("requestfailed", lambda r: reqs.append(f"FAIL {r.url} {r.failure}"))

    page.goto(BASE, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)

    info = page.evaluate("""() => {
      const out = {};
      out.hasLite = !!window.LiteGraph;
      out.registered = Object.keys(LiteGraph.registered_node_types || {}).filter(k => /TK|Anima|PromptCards/i.test(k)).slice(0, 20);
      // 查找节点定义（object_info 或 graph 里）
      const app = window.comfyAPI?.app?.app;
      out.hasApp = !!app;
      // 获取节点定义：通过扩展机制较难，尝试从 app 的 object_info
      out.objInfoKeys = Object.keys(window.comfyAPI?.api?.api?._objectInfo || {}).filter(k => /TKPrompt/i.test(k));
      return out;
    }""")
    print("INFO:", json.dumps(info, ensure_ascii=False, indent=1))

    # 添加节点
    try:
        added = page.evaluate("""() => {
          const app = window.comfyAPI.app.app;
          const cls = LiteGraph.registered_node_types["TKPromptCards"];
          if (!cls) return { ok: false, err: "not registered" };
          const node = LiteGraph.createNode("TKPromptCards");
          app.graph.add(node);
          node.pos = [100, 120];
          app.graph.setDirtyCanvas(true, true);
          return { ok: true, widgets: (node.widgets || []).map(w => w.name), domChild: !!node.element };
        }""")
        print("ADDED:", json.dumps(added, ensure_ascii=False))
    except Exception as e:
        print("ADD ERR:", e)
    page.wait_for_timeout(1500)

    ui = page.locator(".tk-cards-ui").count()
    print("tk-cards-ui count:", ui)
    # 打印扩展加载情况：页面里是否有我们 widget 文件
    scripts = page.evaluate("""() => Array.from(document.querySelectorAll('script')).map(s => s.src).filter(s => /anima/.test(s))""")
    print("anima scripts:", json.dumps(scripts, indent=1))
    print("--- console/errors ---")
    for m in msgs[:30]:
        print(m)
    for r in reqs[:10]:
        print(r)
    browser.close()