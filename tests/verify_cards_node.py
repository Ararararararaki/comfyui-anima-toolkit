# -*- coding: utf-8 -*-
"""视觉验证 TK Prompt Cards 节点：加载页面 → 添加节点 → 三区截图 + 功能抽查。"""
import os, sys, json
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)

BASE = "http://127.0.0.1:8188"
LOG = []

def log(msg):
    print(msg)
    LOG.append(msg)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1680, "height": 1050})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

    page.goto(BASE, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(3000)

    # 添加 TK Prompt Cards 节点（LiteGraph 全局）
    try:
        page.evaluate("""() => {
          const app = window.comfyAPI.app.app;
          const cls = LiteGraph.registered_node_types["TKPromptCards"];
          if (!cls) throw new Error("TKPromptCards 未注册");
          const node = LiteGraph.createNode("TKPromptCards");
          app.graph.add(node);
          node.pos = [80, 120];
          app.graph.setDirtyCanvas(true, true);
        }""")
        page.wait_for_timeout(1500)
        log("节点添加成功")
    except Exception as e:
        log(f"节点添加失败: {e}")
        page.screenshot(path=os.path.join(OUT, "01_add_failed.png"), full_page=True)
        browser.close()
        sys.exit(1)

    # 节点 UI 是否存在
    ui = page.locator(".tk-cards-ui")
    if ui.count() == 0:
        log("!! .tk-cards-ui 未渲染 —— 新前端 shadow DOM? 检查 DOM")
        page.screenshot(path=os.path.join(OUT, "02_no_ui.png"), full_page=True)
        # 找节点是否在 DOM
        nodes = page.locator(".litegraph .node").count()
        log(f"litegraph node count: {nodes}")
        browser.close()
        sys.exit(1)
    log(f".tk-cards-ui 渲染数: {ui.count()}")
    ui.first.screenshot(path=os.path.join(OUT, "03_cards_ui.png"))

    # 三区标题抽查
    for label in ["① 工具箱 prompt 库", "② 当前提示词", "③ 卡片视图"]:
        found = ui.first.locator(f"text={label}").count()
        log(f"区[{label}] 存在: {found > 0}")

    # ③ 卡片库分类页签（预置分类应有 角色/服饰/...）
    tabs = ui.first.locator(".tk-cards-cat").all_text_contents()
    log(f"分类页签: {tabs}")

    # 功能抽查 1：输入 → 拆卡 chips
    ui.first.locator("textarea.tk-cards-textarea").fill("1girl, long hair, 白色过膝袜、绝对领域")
    page.wait_for_timeout(300)
    chips = ui.first.locator(".tk-cards-chip").all_text_contents()
    log(f"chips: {chips}")

    # 功能抽查 2：保存当前整段为组合卡
    ui.first.locator("text=＋ 整段存为组合卡").click()
    page.wait_for_timeout(2000)  # 等待自动翻译（可能触发 DeepLX）
    cats = ui.first.locator(".tk-cards-cat").all_text_contents()
    log(f"存卡后分类: {cats}")
    # 卡片 grid 里应有 1girl 组合卡
    cards = ui.first.locator(".tk-cards-card-en").all_text_contents()
    log(f"卡片列表: {cards}")

    # 功能抽查 3：追加去重（再点同一张卡 → 不重复）
    ui.first.locator(".tk-cards-cat", has_text="角色").click()
    page.wait_for_timeout(300)
    before = ui.first.locator("textarea.tk-cards-textarea").input_value()
    ui.first.locator(".tk-cards-card").first.click()
    page.wait_for_timeout(300)
    after = ui.first.locator("textarea.tk-cards-textarea").input_value()
    log(f"追加去重: before={before!r} after={after!r} same={before == after}")

    # 整体截图
    ui.first.screenshot(path=os.path.join(OUT, "04_cards_ui_final.png"))

    # 错误汇总
    if errors:
        log("!!! 页面错误:")
        for e in errors[:10]:
            log("  " + e)
    else:
        log("无页面 JS 错误")

    browser.close()

with open(os.path.join(OUT, "verify_report.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(LOG) + "\n")
print("done ->", OUT)
