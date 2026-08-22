"""验证 D站画廊两项改动（连 live 8188）：
1) 分类切换 = 本地分类浏览模式（按 id 拉取全量已归类图片，不再因搜索页过滤而空屏）
2) 收藏/评分/随机排序不再自动限定一周（currentQuery 不拼 age:；后端降级由响应 warnings 呈现）

退出码 0 = PASS；其他 = FAIL。
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SCREENSHOT = ROOT / ".scratch" / "danbooru-category-view.png"
URL = "http://127.0.0.1:8188"

checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  → {detail}" if detail else ""))


errors: list[str] = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(str(exc)))

    page.goto(URL, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_function("typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000)
    page.wait_for_timeout(7000)

    # 建画廊节点
    page.evaluate("""() => {
      localStorage.removeItem('anima_danbooru_gallery_settings_v1');
      localStorage.removeItem('anima_danbooru_gallery_favorites_v1');
    }""")
    page.evaluate("""() => {
      const node = LiteGraph.createNode('DanbooruGallery');
      app.graph.add(node);
      node.pos = [80, 100];
      app.canvas.centerOnNode?.(node);
      app.graph.setDirtyCanvas(true);
      window.__agentTestNode = node;
    }""")
    page.locator(".anima-danbooru-gallery").wait_for(state="visible", timeout=15_000)
    page.wait_for_timeout(2500)
    page.evaluate("""() => { window.__agentTestUI = window.__agentTestNode._animaDanbooruGallery; }""")

    # ── 1) 收藏排序不带 age 窗 ──
    query_after = page.evaluate(
        """() => {
          const ui = window.__agentTestUI || (
            window.__agentTestUI = (() => {
              // 找到画廊节点实例
              const graphs = [app.graph];
              for (const g of graphs) {
                for (const n of g._nodes) {
                  if (n._animaDanbooruGallery) return n._animaDanbooruGallery;
                }
              }
              return null;
            })()
          );
          return ui && ui.currentQuery();
        }"""
    )
    check("收藏排序查询不含 age 限定", "age:" not in (query_after or ""), f"query={query_after!r}")

    # 设排序=收藏并看 currentQuery
    setting_result = page.evaluate(
        """() => {
          const ui = window.__agentTestUI;
          if (!ui) return "no-ui";
          ui.settings.filters.order = "favcount";
          ui.saveSettings();
          ui.filterControls.refresh();
          return ui.currentQuery();
        }"""
    )
    check("favcount 排序 currentQuery 不拼 age", "age:" not in (setting_result or ""), f"query={setting_result!r}")
    page.evaluate(
        """() => { const ui = window.__agentTestUI; ui.settings.filters.order = ""; ui.saveSettings(); ui.filterControls.refresh(); }"""
    )

    # ── 2) 搜索获取真实图片 ──
    page.evaluate("""() => { const ui = window.__agentTestUI; if (ui) { ui.setQuery("1girl solo"); ui.search({ resetPage: true }); } }""")
    page.wait_for_function(
        """() => {
          const ui = window.__agentTestUI;
          return ui && (ui.posts.length > 0 || String(ui.status?.textContent || '').includes('失败') || String(ui.status?.textContent || '').includes('超时'));
        }""",
        timeout=60_000,
    )
    live_posts = page.evaluate("window.__agentTestUI.posts.length")
    check("搜索返回真实图片", int(live_posts or 0) > 0, f"posts={live_posts}")

    # ── 3) 归类前 3 张 → 切分类浏览 ──
    cat_setup = page.evaluate(
        """() => {
          const ui = window.__agentTestUI;
          const catId = 'c_verify_test';
          if (!ui.settings.categories.some(c => c.id === catId)) {
            ui.settings.categories.push({ id: catId, name: '验证分类' });
          }
          const ids = ui.posts.slice(0, 3).map(p => String(p.id)).filter(Boolean);
          for (const id of ids) ui.settings.postCategories[id] = catId;
          ui.saveSettings();
          ui.filterControls.refresh();
          ui.renderPosts();
          return { ids, catName: '验证分类' };
        }"""
    )
    check("已归类 3 张进「验证分类」", len(cat_setup.get("ids", [])) == 3, json.dumps(cat_setup, ensure_ascii=False))

    # 直接调用 applyActiveCategory（模拟点击分类菜单项后的 commit 路径）
    page.evaluate("() => window.__agentTestUI.applyActiveCategory('c_verify_test')")
    page.wait_for_function(
        """() => {
          const ui = window.__agentTestUI;
          return ui && ui.settings.activeCategory === 'c_verify_test' && !ui.grid.getAttribute?.('aria-busy') && String(ui.status?.textContent || '').includes('验证分类');
        }""",
        timeout=60_000,
    )
    cat_posts = page.evaluate("window.__agentTestUI.posts.length")
    cat_cards = page.locator(".anima-danbooru-gallery .adg-card").count()
    check("分类浏览模式拉取到该分类图片", int(cat_posts) >= 3, f"posts={cat_posts}")
    check("分类浏览模式渲染卡片", int(cat_cards) >= 3, f"cards={cat_cards}")
    cat_status = page.evaluate("window.__agentTestUI.status.textContent")
    check("状态栏显示分类名", "验证分类" in (cat_status or ""), cat_status)
    badge = page.locator(".adg-cat-mode-badge").count()
    check("分页区显示「本地分类浏览」徽标", badge >= 1)

    # ── 4) 切回全部分类 → 恢复搜索视图 ──
    page.evaluate("() => window.__agentTestUI.applyActiveCategory('')")
    page.wait_for_timeout(300)
    all_status = page.evaluate("window.__agentTestUI.status.textContent")
    all_posts = page.evaluate("window.__agentTestUI.posts.length")
    badge_after = page.locator(".adg-cat-mode-badge").count()
    check("切回全部分类保留搜索视图", int(all_posts) == int(live_posts), f"posts={all_posts}")
    check("分类徽标消失", badge_after == 0)

    page.screenshot(path=str(SCREENSHOT), full_page=False)
    browser.close()

# ── 汇总 ──
failed = [c for c in checks if not c[1]]
print("-" * 60)
if errors:
    real = [e for e in errors if "favicon" not in e and "net::" not in e]
    print(f"console errors: {len(real)}")
    for e in real[:5]:
        print("  ", e[:180])
if failed:
    print(f"FAILED {len(failed)}/{len(checks)}")
    sys.exit(1)
print(f"ALL PASS {len(checks)}/{len(checks)}")
sys.exit(0)