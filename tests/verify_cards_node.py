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
    log(f"PNG 拖拽区存在: {ui.first.locator('.tk-cards-png-drop').count() > 0}")
    log(f"PNG 选择按钮存在: {ui.first.locator('text=选择 PNG').count() > 0}")
    compact_state = ui.first.evaluate(
        """
        (ui) => {
          const png = ui.querySelector('.tk-cards-png-drop');
          const status = ui.querySelector('.tk-cards-translate-status-details');
          const input = ui.querySelector('.tk-cards-translate-input');
          const actions = ui.querySelector('.tk-cards-translate-actions');
          return {
            pngInline: png?.parentElement?.classList.contains('tk-cards-sec-btns'),
            statusCollapsed: status ? !status.open : false,
            translationModuleCollapsible: ui.querySelector('.tk-cards-translate-box')?.tagName === 'DETAILS',
            translationInputSharesRow: Boolean(input && actions && input.parentElement?.parentElement === actions.parentElement),
            hasCardGridResize: Boolean(ui.querySelector('.tk-cards-card-grid-resize-handle')),
            hasSavePrompt: [...ui.querySelectorAll('button')].some(b => (b.textContent || '').trim() === '存入 prompt 库'),
            hasLegacyComboSave: [...ui.querySelectorAll('button')].some(b => (b.textContent || '').includes('整段存组合卡')),
            hasUndoDelete: [...ui.querySelectorAll('button')].some(b => (b.textContent || '').trim() === '撤销删除'),
          };
        }
        """
    )
    log(f"紧凑布局检查: {compact_state}")
    if not compact_state["pngInline"] or not compact_state["statusCollapsed"] or not compact_state["translationModuleCollapsible"] or not compact_state["translationInputSharesRow"] or not compact_state["hasCardGridResize"]:
        raise AssertionError(f"紧凑布局不符合预期: {compact_state}")
    if not compact_state["hasSavePrompt"] or compact_state["hasLegacyComboSave"] or compact_state["hasUndoDelete"]:
        raise AssertionError(f"②区旧操作按钮仍存在: {compact_state}")

    # 卡片文字不能被 flex 行压缩成不可见高度
    if ui.first.locator(".tk-cards-card").count():
        text_height = ui.first.locator(".tk-cards-card-en").first.evaluate("el => el.getBoundingClientRect().height")
        log(f"卡片英文文本高度可见: {text_height >= 10} ({text_height:.1f}px)")

    # 中文翻译模块整体收起/展开，并记住状态
    translate_summary = ui.first.locator(".tk-cards-translate-box > summary")
    translate_summary.evaluate("el => el.click()")
    page.wait_for_timeout(100)
    collapsed_translation = ui.first.evaluate(
        """
        (ui) => ({
          open: ui.querySelector('.tk-cards-translate-box')?.open,
          saved: JSON.parse(localStorage.getItem('anima_tk_cards_ui_v1') || '{}').collapsed?.translate,
        })
        """
    )
    log(f"中文翻译模块收起: {collapsed_translation}")
    if collapsed_translation["open"] or collapsed_translation["saved"] is not True:
        raise AssertionError(f"中文翻译模块无法收起或未保存: {collapsed_translation}")
    translate_summary.evaluate("el => el.click()")
    page.wait_for_timeout(100)

    # ③ 卡片库分类页签（预置分类应有 角色/服饰/...）
    tabs = ui.first.locator(".tk-cards-cat").all_text_contents()
    log(f"分类页签: {tabs}")

    # 功能抽查 1：输入 → 拆卡 chips
    ui.first.locator("textarea.tk-cards-textarea").fill("1girl, long hair, 白色过膝袜、绝对领域")
    page.wait_for_timeout(300)
    chips = ui.first.locator(".tk-cards-chip").all_text_contents()
    log(f"chips: {chips}")

    # 功能抽查 2：整段写入工具箱 prompt 库，不进入③区小卡片
    ui.first.locator("text=存入 prompt 库").evaluate("el => el.click()")
    page.wait_for_timeout(1000)
    lib_items = ui.first.locator(".tk-cards-lib-item").all_text_contents()
    cards = ui.first.locator(".tk-cards-card-en").all_text_contents()
    log(f"整段入 prompt 库: {any('1girl' in text for text in lib_items)}，③区卡片数量: {len(cards)}")
    if not any("1girl" in text for text in lib_items):
        raise AssertionError("整段提示词没有进入①区 prompt 库")

    # 功能抽查 3：拖拽调整③区双语卡片显示范围并持久化
    card_grid_size = ui.first.evaluate(
        """
        (ui) => {
          const grid = ui.querySelector('.tk-cards-grid');
          const handle = ui.querySelector('.tk-cards-card-grid-resize-handle');
          if (!grid || !handle) return null;
          handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientY: 100 }));
          handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 180 }));
          handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 180 }));
          return {
            height: grid.style.height,
            aria: handle.getAttribute('aria-valuenow'),
            saved: JSON.parse(localStorage.getItem('anima_tk_cards_ui_v1') || '{}'),
          };
        }
        """
    )
    log(f"双语卡片显示范围: {card_grid_size}")
    if not card_grid_size or card_grid_size["height"] != "380px" or card_grid_size["aria"] != "380" or card_grid_size["saved"].get("cardGridHeight") != 380:
        raise AssertionError(f"双语卡片显示范围未正确保存: {card_grid_size}")

    # 功能抽查 4：追加去重（再点同一张卡 → 不重复）
    ui.first.locator(".tk-cards-cat").filter(has_text="全部").evaluate("el => el.click()")
    page.wait_for_timeout(300)
    before = ui.first.locator("textarea.tk-cards-textarea").input_value()
    ui.first.locator(".tk-cards-card").first.evaluate("el => el.click()")
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
