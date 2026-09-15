"""TK Prompt Cards 联想候选：键盘约定的回归锁。

背景（2026-09-15 用户要求重排交互）：原来 Enter **无条件**吃掉按键 ——
只要候选列表开着（它随时会冒出来），多行提示词就再也换不了行；而且没有
`isComposing` 保护，中文输入法按 Enter 上屏会被误判成"选词"，把半截拼音当 tag 插进去。

重排后的约定（① 区英文联想与 ② 区中文联想共用）：
  Tab → 接受当前高亮项（没有高亮时用第一项）＝「一键选第一个」
  ↑/↓ → 选择；Enter 只在**按过 ↑/↓ 之后**才确认；Shift+Enter 永远换行；Esc 关闭
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "js" / "anima_prompt_cards_widget.js"


def _method_body(js, signature):
    start = js.index(signature)
    return js[start:js.index("\n    }", start)]


def test_suggest_keys_keep_enter_available_for_newline():
    js = SOURCE.read_text(encoding="utf-8")
    for signature, key in (("_suggestKeyDown(e) {", "e."), ("_translateSuggestKeyDown(event) {", "event.")):
        body = _method_body(js, signature)
        assert f'{key}key === "Tab"' in body, f"{signature} 必须支持 Tab 接受"
        assert f'{key}key === "Enter"' in body, f"{signature} 仍要支持 Enter 确认"
        assert "isComposing" in body, f"{signature} 必须保护输入法组字（否则中文上屏被吃掉）"
        assert ">= 0" in body, f"{signature} 的 Enter 必须受高亮状态约束，否则又会吃掉换行"
        assert f'{key}shiftKey' in body, f"{signature} 要放行 Shift+Enter"


def test_suggest_defaults_to_no_selection_and_matches_visuals():
    """默认不得预高亮：DOM 的 .sel 必须与 _suggestIdx 一致，否则用户以为 Enter 会选它。"""
    js = SOURCE.read_text(encoding="utf-8")
    assert "this._suggestIdx = -1;" in js, "① 区默认未选择"
    assert "this._translateSuggestIdx = -1;" in js, "② 区默认未选择"
    assert '${i === 0 ? "sel" : ""}' not in js, "候选模板不得预置 sel 类"


def test_suggest_hover_syncs_keyboard_highlight():
    """鼠标悬停要同步键盘高亮，否则出现"看着 A、插入 B"。"""
    js = SOURCE.read_text(encoding="utf-8")
    assert js.count('addEventListener("mouseenter"') >= 2, "①② 区候选都要有 hover 同步高亮"


if __name__ == "__main__":
    test_suggest_keys_keep_enter_available_for_newline()
    test_suggest_defaults_to_no_selection_and_matches_visuals()
    test_suggest_hover_syncs_keyboard_highlight()
    print("PASS: prompt cards suggestion keyboard contract")
