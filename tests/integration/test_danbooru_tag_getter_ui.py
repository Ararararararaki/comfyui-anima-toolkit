"""真实 ComfyUI 页面检查 TK Danbooru Tag Getter 的面板：排版、便捷操作与手感。

integration 层（需要真实浏览器 + 真实 ComfyUI:8188）。

```bash
python -X utf8 tests/integration/test_danbooru_tag_getter_ui.py
```

它验证的是**回退后的原生风格面板**（2026-09-14 用户要求把面板退回 §11 之前的版本）：
20 个分类原生开关 + 权重输入框 + 场景预设下拉 + 主题剔除 chips + 三个排除输入 + 批量操作。
旧版脚本断言的是 12 分类 + 两个自然语言开关，2.13.0 之后早已不成立。
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
SCREENSHOT = Path(r"C:\Users\Toki\AppData\Local\Temp\tk-danbooru-getter-ui.png")
WIDGET = Path(__file__).resolve().parents[2] / "web" / "js" / "anima_danbooru_tag_getter_widget.js"

CATEGORY_COUNT = 20
# 内置场景预设已按用户要求（2026-09-14）全部移除 → 下拉只剩「自定义（不用预设）」。
# 用户自己保存的预设由 /anima/tag_presets 动态补进下拉，不在这条静态计数里。
PRESET_OPTIONS = 1
FILTER_FIELDS = 3           # 正则排除 / 精准排除 / 自定义剔除
BATCH_ACTIONS = ["全开", "全关", "反选", "权重归 1"]
NODE_TYPE = "AnimaTKDanbooruTagGetter"


with sync_playwright() as playwright:
    profile = tempfile.TemporaryDirectory(prefix="tk-danbooru-getter-ui-")
    context = playwright.chromium.launch_persistent_context(
        profile.name,
        executable_path=str(CHROME),
        headless=True,
        viewport={"width": 1440, "height": 900},
        args=["--no-first-run", "--disable-gpu"],
    )
    page = context.pages[0] if context.pages else context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on(
        "console",
        lambda message: errors.append(f"console.{message.type}: {message.text}")
        if message.type == "error"
        else None,
    )
    # 用仓库源码而不是运行目录里的副本：验证的是当前源码，不是部署残留。
    source_widget = WIDGET.read_text(encoding="utf-8")
    page.route(
        "**/anima_danbooru_tag_getter_widget.js",
        lambda route: route.fulfill(
            status=200, content_type="application/javascript", body=source_widget
        ),
    )
    page.goto("http://127.0.0.1:8188/", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function(
        "typeof LiteGraph !== 'undefined' && Boolean(window.app?.graph)", timeout=30_000
    )
    page.wait_for_timeout(3_000)
    errors.clear()

    created = page.evaluate(
        """
        (nodeType) => {
          window.app.graph.clear();
          const node = LiteGraph.createNode(nodeType);
          if (!node) return null;
          window.app.graph.add(node);
          node.pos = [60, 60];
          window.__tkDanbooruGetter = node;
          window.app.graph.setDirtyCanvas(true, true);
          return node.type;
        }
        """,
        NODE_TYPE,
    )
    if created != NODE_TYPE:
        raise AssertionError(f"node create failed: {created}")
    page.wait_for_timeout(1_200)
    page.screenshot(path=str(SCREENSHOT))

    state = page.evaluate(
        """
        () => {
          const node = window.__tkDanbooruGetter;
          const panel = document.querySelector('.tk-dtb-panel');
          if (!panel) return { panel: null };
          const columnBuckets = (selector, edge) => {
            const buckets = {};
            panel.querySelectorAll(selector).forEach((el) => {
              const box = el.getBoundingClientRect();
              const key = Math.round(edge === 'right' ? box.right : box.left);
              buckets[key] = (buckets[key] || 0) + 1;
            });
            return buckets;
          };
          return {
            panel: {
              rows: panel.querySelectorAll('.tk-dtb-row').length,
              weights: panel.querySelectorAll('.tk-dtb-weight-input').length,
              filters: panel.querySelectorAll('.tk-dtb-filter-input').length,
              chips: panel.querySelectorAll('.tk-dtb-chip').length,
              presetOptions: [...panel.querySelectorAll('.tk-dtb-preset option')].map(o => o.value),
              actions: [...panel.querySelectorAll('.tk-dtb-actions .tk-dtb-action')].map(a => a.textContent),
              weightColumnBuckets: columnBuckets('.tk-dtb-weight-input', 'right'),
              toggleColumnBuckets: columnBuckets('.tk-dtb-toggle', 'left'),
              scrollable: panel.scrollHeight > panel.clientHeight,
            },
            inputLabels: (node?.inputs || []).map(input => input.label || input.name),
          };
        }
        """
    )
    print(json.dumps(state, ensure_ascii=False))

    panel = state.get("panel")
    if not panel:
        raise AssertionError("panel did not render")

    assert panel["rows"] == CATEGORY_COUNT, f"expected {CATEGORY_COUNT} category rows: {panel}"
    assert panel["weights"] == CATEGORY_COUNT, f"expected one weight input per category: {panel}"
    assert panel["filters"] == FILTER_FIELDS, f"expected three exclude fields: {panel}"
    assert len(panel["presetOptions"]) == PRESET_OPTIONS, f"场景预设下拉不完整: {panel}"
    assert panel["actions"] == BATCH_ACTIONS, f"批量操作按钮不对: {panel}"
    # 三列对齐：两栏各成一列 → 每栏内所有行的顶点/终点完全一致
    assert len(panel["weightColumnBuckets"]) == 2, f"权重列没有对齐成两栏: {panel}"
    assert set(panel["weightColumnBuckets"].values()) == {CATEGORY_COUNT // 2}, \
        f"两栏权重列行数不等: {panel}"
    assert len(panel["toggleColumnBuckets"]) == 2, f"开关列没有对齐成两栏: {panel}"

    def widget_value(name):
        return page.evaluate(
            "(name) => (window.__tkDanbooruGetter?.widgets || []).find(w => w.name === name)?.value",
            name,
        )

    def click_action(label):
        page.locator(f".tk-dtb-actions .tk-dtb-action", has_text=label).first.click()
        page.wait_for_timeout(250)

    # 批量操作：全关 / 全开 / 反选
    click_action("全关")
    assert widget_value("画师词") is False and widget_value("物件道具词") is False, "全关没有关掉分类"
    click_action("全开")
    assert widget_value("画师词") is True and widget_value("物件道具词") is True, "全开没有打开分类"
    click_action("反选")
    assert widget_value("画师词") is False, "反选没有反转开关"

    # 权重：手改 + 双击归 1
    weight = page.locator(".tk-dtb-weight-input").first
    weight.fill("1.25")
    weight.press("Tab")
    page.wait_for_timeout(200)
    assert widget_value("画师词_weight") == 1.25, f"权重没有写回: {widget_value('画师词_weight')}"
    weight.dblclick()
    page.wait_for_timeout(200)
    assert widget_value("画师词_weight") == 1, "双击权重没有归 1.0"

    # 主题剔除 chips 与「清空」
    page.locator(".tk-dtb-chip").first.click()
    page.wait_for_timeout(200)
    assert "furry" in str(widget_value("exclude_groups")), "chip 没有写入 exclude_groups"
    page.locator(".tk-dtb-section-head .tk-dtb-action").first.click()
    page.wait_for_timeout(200)
    assert widget_value("exclude_groups") == "", "主题剔除「清空」没有生效"

    # 排除输入的「清空」
    regex_field = page.locator(".tk-dtb-filter-input").first
    regex_field.fill("censor|watermark")
    page.wait_for_timeout(150)
    page.locator(".tk-dtb-filter-row .tk-dtb-action").first.click()
    page.wait_for_timeout(200)
    assert widget_value("regex_blacklist") == "", "排除输入「清空」没有生效"

    page.screenshot(path=str(SCREENSHOT))
    if errors:
        raise AssertionError(f"new node interaction errors: {errors[:5]}")

    print(
        f"PASS UI panel: {CATEGORY_COUNT} rows, 三列对齐, 批量操作, "
        f"预设 {PRESET_OPTIONS} 项, chips 联动, 清空按钮; screenshot={SCREENSHOT}"
    )
    context.close()
    profile.cleanup()
