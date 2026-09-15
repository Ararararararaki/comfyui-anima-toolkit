"""TK D站画廊：悬停 Prompt 分类与预览按钮回归检查。"""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "js" / "anima_danbooru_gallery_widget.js"
STYLES = ROOT / "web" / "css" / "anima_danbooru_gallery.css"


def test_hover_prompt_renders_saved_danbooru_groups_and_preview_action_is_visible():
    js = SOURCE.read_text(encoding="utf-8")
    css = STYLES.read_text(encoding="utf-8")

    tooltip_start = js.index("async showPromptTooltip")
    tooltip_end = js.index("\n    positionTooltip(event)", tooltip_start)
    tooltip = js[tooltip_start:tooltip_end]

    # The hover path must use the structured groups already attached to each card,
    # not only the flattened data-tags fallback.
    assert "card.dataset.promptGroups" in tooltip
    assert "PROMPT_CATEGORY_LABELS" in tooltip
    assert "adg-prompt-tooltip-section" in tooltip
    assert "adg-prompt-tooltip-category" in tooltip

    # The action must remain discoverable on narrow cards and be named explicitly.
    assert 'addAction("预览", "预览图片"' in js
    actions_css = css[css.index(".adg-card-actions"):css.index(".adg-prompt-tooltip")]
    assert "flex-wrap: wrap" in actions_css
    assert "max-width" in actions_css


def test_hidden_card_actions_do_not_swallow_clicks():
    """回归锁：操作条视觉隐藏时必须**同时禁用命中**。

    2026-09-15 实测：只写 ``opacity: 0`` 时，卡片顶部 182×44px 的隐形按钮仍然吃点击
    （``elementFromPoint`` 在"什么都没有"的位置命中 BUTTON「预览」「分类/入库」），
    用户表现为"图上按钮太大、老是误触"——点图片上半部却触发了下载 / 入库。
    """
    css = STYLES.read_text(encoding="utf-8")
    actions_css = css[css.index(".adg-card-actions"):css.index(".adg-prompt-tooltip")]
    assert "pointer-events: none" in actions_css, "隐藏时不得吃点击"
    assert "pointer-events: auto" in actions_css, "悬停 / 聚焦时必须恢复可点"
    assert ":focus-within" in actions_css, "键盘可达性不能丢"
    assert "@media (hover: none)" in actions_css, "触摸屏要常显，否则按钮彻底点不到"


def test_prompt_tooltip_flips_instead_of_pinning_to_the_edge():
    """回归锁：浮层放不下时要**翻到反侧**，不能贴边硬塞。

    用户原话「如果显示不去会被浏览器边框挤着硬显示」——旧实现只有 Math.min/Math.max 钳制，
    放不下就把浮层贴到视口边缘。另外浮层内容是**异步**填充的（"正在加载双语 Prompt…" →
    真面板），尺寸跳变后必须用同一锚点重算位置，否则大面板会盖住画廊并溢出视口。
    """
    js = SOURCE.read_text(encoding="utf-8")
    start = js.index("positionTooltip(event) {")   # 函数定义，不是事件绑定那处调用
    body = js[start:js.index("hidePromptTooltip()", start)]
    assert "tooltipAnchor" in body, "要记住锚点，供尺寸变化后重算"
    assert "flipped" in body, "放不下要翻到反侧"
    filled = js[js.index("tooltip.replaceChildren"):start]
    assert "this.positionTooltip();" in filled, "内容加载完要重新定位"


def test_gallery_auto_shrink_cannot_ratchet_the_node_smaller():
    """回归锁：自动收缩必须 ①尊重用户手动尺寸 ②同一内容只缩一次。

    否则「缩 → 竖向滚动条消失 → 内容区变宽 → 列数 +1 → 卡片变矮 → 内容总高变小 → 再缩」
    会一轮轮互相触发，节点"慢慢变小"；而用户手动放大又会被下一帧缩回去（"放大了也不填满"）。
    """
    js = SOURCE.read_text(encoding="utf-8")
    shrink = js[js.index("shrinkGridToContent(total) {"):js.index("setGridHeight(height) {")]
    assert "if (this.userResizedAt) return;" in shrink, "用户手动调过尺寸后不得再自动收缩"
    assert "this.shrunkTotal !== null" in shrink, "同一内容高度只缩一次"
    assert "noteExternalResize" in js, "要能识别用户拖动节点尺寸"
    # 所有程序化改尺寸都走 setGridHeight，否则 programmaticResizeAt 记不上、误判成用户拖动
    apply_grid = js[js.index("applyGridHeight() {"):js.index("loadFavorites() {")]
    assert "this.setGridHeight(height)" in apply_grid, "applyGridHeight 必须走 setGridHeight"


if __name__ == "__main__":
    test_hover_prompt_renders_saved_danbooru_groups_and_preview_action_is_visible()
    test_hidden_card_actions_do_not_swallow_clicks()
    test_prompt_tooltip_flips_instead_of_pinning_to_the_edge()
    test_gallery_auto_shrink_cannot_ratchet_the_node_smaller()
    print("PASS: Danbooru gallery grouped hover prompt and visible preview action")
