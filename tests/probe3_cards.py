# -*- coding: utf-8 -*-
"""侦查 3：TKPromptCards 节点定义的名字/onNodeCreated 包装状态 vs TK Prompt Batch 对照。"""
import json
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8188"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(BASE, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)

    out = page.evaluate("""() => {
      const R = LiteGraph.registered_node_types || {};
      const keys = ["TKPromptCards", "TK Prompt Cards", "AnimaPromptBatch", "TK Prompt Batch", "AnimaPromptCards", "TKPromptBatch"];
      const res = {};
      for (const k of keys) {
        const t = R[k];
        if (!t) { res[k] = null; continue; }
        res[k] = {
          name: t.name, title: t.title, display_name: t.display_name,
          onCreatedWrapped: /PromptCards|CardsUI|anima_batch_panel|_animaBatchUI/.test(String(t.prototype.onNodeCreated)),
          widgetsInDef: (t.widgets || []).length,
        };
      }
      return res;
    }""")
    print(json.dumps(out, ensure_ascii=False, indent=1))
    browser.close()