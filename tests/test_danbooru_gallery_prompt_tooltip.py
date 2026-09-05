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


if __name__ == "__main__":
    test_hover_prompt_renders_saved_danbooru_groups_and_preview_action_is_visible()
    print("PASS: Danbooru gallery grouped hover prompt and visible preview action")
