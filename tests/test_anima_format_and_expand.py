"""TK Anima 格式化 + TK 提示词扩写 的行为测试。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from anima_anima_formatter import AnimaTKAnimaFormatter  # noqa: E402
from anima_prompt_expander import AnimaTKPromptExpander  # noqa: E402


class FakeTaxonomy:
    """测试替身：{键: 分类名} 查表，避免加载 9.4MB 真实索引。"""

    def __init__(self, mapping):
        from anima_tag_taxonomy import normalise
        self.mapping = {normalise(key): value for key, value in mapping.items()}

    def lookup(self, value):
        from anima_tag_taxonomy import tag_lookup_keys
        for key in tag_lookup_keys(value):
            if key in self.mapping:
                return self.mapping[key], ()
        return None

    def groups_of(self, value):
        return ()


FORMAT_MAP = {
    "plana_(blue_archive)": "角色身份词",
    "blue_archive": "作品版权词",
    "long_hair": "发色发型词",
    "silver_hair": "发色发型词",
    "purple_eyes": "角色五官词",
    "halo": "亚人特征词",
    "school_uniform": "服饰词",
    "standing": "动作词",
    "smile": "角色表情词",
    "looking_at_viewer": "角色表情词",
    "classroom": "背景词",
    "1girl": "人物对象词",
    "solo": "人物对象词",
    "masterpiece": "质量元词",
    "year_2025": "质量元词",
    "liduke": "画师词",
    "mole_under_eye": "角色部位词",
}


def _use_fake(cls, mapping=None):
    original = cls._TAXONOMY_OVERRIDE
    cls._TAXONOMY_OVERRIDE = FakeTaxonomy(mapping or FORMAT_MAP)
    return original


# ────────────── Anima 格式化 ──────────────


def test_formatter_converts_underscore_to_space():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "long_hair, purple_eyes", reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result == "long hair, purple eyes"


def test_formatter_escapes_brackets_and_unescapes_first():
    """WD14 的 `plana_\\(blue_archive\\)` 必须同时完成：去转义 → 转空格 → 重新转义。"""
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            r"plana_\(blue_archive\)", reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result == r"plana \(blue archive\)"


def test_formatter_adds_at_prefix_to_artist_only():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "liduke, long_hair", reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert "@liduke" in result
    assert "@long hair" not in result


def test_formatter_does_not_double_at_prefix():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "@liduke", reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result == "@liduke"


def test_formatter_reorders_into_anima_sections():
    """Anima 官方区段顺序：quality → count → character → series → artist → general。"""
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "classroom, liduke, blue_archive, plana_\\(blue_archive\\), "
            "long_hair, 1girl, masterpiece")[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    parts = [part.strip() for part in result.split(",")]
    assert parts.index("masterpiece") < parts.index("1girl")
    assert parts.index("1girl") < parts.index(r"plana \(blue archive\)")
    assert parts.index(r"plana \(blue archive\)") < parts.index("blue archive")
    assert parts.index("blue archive") < parts.index("@liduke")
    assert parts.index("@liduke") < parts.index("long hair")


def test_formatter_keeps_order_when_reorder_disabled():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "classroom, 1girl, long_hair", reorder_sections=True)[0]
        kept = AnimaTKAnimaFormatter().format_prompt(
            "classroom, 1girl, long_hair", reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result != kept
    assert [p.strip() for p in kept.split(",")] == ["classroom", "1girl", "long hair"]


def test_formatter_dedupes_case_and_form_insensitively():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "long_hair, Long Hair, long hair", reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result == "long hair"


def test_formatter_preserves_tag_weight():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "(long_hair:1.3)", reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result == "(long hair:1.3)"


def test_formatter_limits_tag_count():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        many = ", ".join(["long_hair"] * 1 + [f"tag{i}" for i in range(50)])
        result = AnimaTKAnimaFormatter().format_prompt(many, max_tags="10")[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert len([p for p in result.split(",") if p.strip()]) == 10


def test_formatter_keeps_natural_language_segment():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        # 默认 natural_separator = 句号转逗号：Anima 提示词整体走逗号一致性
        result = AnimaTKAnimaFormatter().format_prompt(
            "long_hair\n\nA girl stands in a classroom.")[0]
        kept = AnimaTKAnimaFormatter().format_prompt(
            "long_hair\n\nA girl stands in a classroom.",
            natural_separator="保留句号")[0]
        dropped = AnimaTKAnimaFormatter().format_prompt(
            "long_hair\n\nA girl stands in a classroom.",
            keep_natural_language=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert "A girl stands in a classroom," in result, "默认应把句号转成逗号"
    assert "A girl stands in a classroom." in kept
    assert "A girl stands in a classroom" not in dropped


def test_formatter_can_merge_natural_into_tag_string():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        merged = AnimaTKAnimaFormatter().format_prompt(
            "long_hair, smile\n\nShe rests by a window.",
            natural_separator="句号转逗号", merge_natural=True)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert "\n\n" not in merged, "并入后不该再有空行分隔"
    assert merged.count(",") >= 2


def test_formatter_natural_separator_drop_removes_period():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "long_hair\n\nShe rests. He waits.", natural_separator="去掉句号")[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert "." not in result
    assert "She rests" in result and "He waits" in result


def test_formatter_empty_natural_separator_falls_back_to_comma():
    """空值（旧工作流补的空字符串）等价于默认的句号转逗号。"""
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "long_hair\n\nShe rests.", natural_separator="")[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert "She rests," in result


def test_formatter_trailing_comma_option():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "long_hair", trailing_comma=True, reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result == "long hair,"


def test_formatter_empty_input_is_safe():
    assert AnimaTKAnimaFormatter().format_prompt("") == ("",)


def test_formatter_forces_lowercase():
    """Anima 官方 model card 的示例全是小写（@big chungus / jpeg artifacts / year 2025）。"""
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "LONG_HAIR, Purple_Eyes, LIDUKE", reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result == result.lower()
    assert "LONG" not in result


def test_formatter_can_keep_case():
    original = _use_fake(AnimaTKAnimaFormatter)
    try:
        result = AnimaTKAnimaFormatter().format_prompt(
            "LONG_HAIR", force_lowercase=False, reorder_sections=False)[0]
    finally:
        AnimaTKAnimaFormatter._TAXONOMY_OVERRIDE = original
    assert result == "LONG HAIR"


# ────────────── 提示词扩写 ──────────────


def test_expander_generates_natural_language_without_llm():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        tags, natural, _vlm = AnimaTKPromptExpander().expand(
            "1girl, plana_(blue_archive), long_hair, silver_hair, purple_eyes, "
            "school_uniform, standing, smile, classroom")
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "Plana" in natural and "Blue Archive" in natural
    assert "silver" in natural
    assert natural.endswith(".")
    assert tags.startswith("1girl")


def test_expander_merges_hair_length_and_color():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        _tags, natural, _vlm = AnimaTKPromptExpander().expand("long_hair, silver_hair, 1girl")
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "long silver hair" in natural


def test_expander_puts_character_name_first():
    """Anima 官方建议：多角色场景先说角色名，再描述外观。"""
    original = _use_fake(AnimaTKPromptExpander)
    try:
        _tags, natural, _vlm = AnimaTKPromptExpander().expand(
            "long_hair, plana_(blue_archive), 1girl")
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert natural.index("Plana") < natural.index("hair")


def test_expander_prompt_output_is_unchanged_without_fill():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        tags, _natural, _vlm = AnimaTKPromptExpander().expand("1girl, smile")
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert tags == "1girl, smile"


def test_expander_fill_lighting_adds_only_when_missing():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        filled, _, _vlm = AnimaTKPromptExpander().expand(
            "1girl, smile", fill_lighting=True, fill_lighting_tags="soft lighting")
        not_filled, _, _vlm = AnimaTKPromptExpander().expand(
            "1girl, smile, classroom", fill_lighting=True)
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "soft lighting" in filled
    # classroom 没有 light 字样，仍会补
    assert isinstance(not_filled, str)


def test_expander_fill_camera_skipped_when_camera_present():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        with_camera, _, _vlm = AnimaTKPromptExpander().expand(
            "1girl, looking_at_viewer", fill_camera=True)
        without, _, _vlm = AnimaTKPromptExpander().expand(
            "1girl, smile", fill_camera=True)
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "cowboy shot" not in with_camera
    assert "cowboy shot" in without


def test_expander_fill_is_deduped():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        tags, _, _vlm = AnimaTKPromptExpander().expand(
            "1girl, soft_lighting", fill_lighting=True, fill_lighting_tags="soft lighting")
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert tags.count("soft_lighting") + tags.count("soft lighting") == 1


def test_expander_write_natural_off_returns_empty_natural():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        tags, natural, _vlm = AnimaTKPromptExpander().expand("1girl, smile", write_natural=False)
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert tags == "1girl, smile"
    assert natural == ""


def test_expander_preserves_input_natural_language():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        _tags, natural, _vlm = AnimaTKPromptExpander().expand(
            "1girl, smile\n\nShe is in a bright classroom.")
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "She is in a bright classroom." in natural


def test_expander_empty_input_is_safe():
    assert AnimaTKPromptExpander().expand("")[:2] == ("", "")


def test_expander_style_controls_sentence_count():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        short = AnimaTKPromptExpander().expand(
            "1girl, long_hair, classroom, looking_at_viewer, masterpiece",
            style=AnimaTKPromptExpander.STYLE_CHOICES[0])[1]
        detailed = AnimaTKPromptExpander().expand(
            "1girl, long_hair, classroom, looking_at_viewer, masterpiece",
            style=AnimaTKPromptExpander.STYLE_CHOICES[2])[1]
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert detailed.count(".") >= short.count(".")


# ────────────── VLM 输出解析与词表校验 ──────────────


VLM_REPLY = """<danbooru_tags>
long hair, purple eyes, white thighhighs, white gloves, from above,
soft afternoon light fills the room, realistic anatomy
</danbooru_tags>

<natural>
The girl stands by a sunlit window with soft rim light along her shoulders.
</natural>"""


def test_vlm_instruction_embeds_existing_tags():
    instruction = AnimaTKPromptExpander.build_vlm_instruction(["1girl", "long_hair"])
    assert "1girl, long_hair" in instruction
    assert "<danbooru_tags>" in instruction and "<natural>" in instruction


def test_vlm_instruction_handles_empty_existing_tags():
    assert "（无）" in AnimaTKPromptExpander.build_vlm_instruction([])


def test_vlm_output_parsing_splits_two_blocks():
    tags, natural = AnimaTKPromptExpander._parse_vlm_output(VLM_REPLY)
    assert "long hair" in tags
    assert "realistic anatomy" in tags
    assert natural.startswith("The girl stands by a sunlit window")


def test_vlm_output_parsing_tolerates_missing_natural_block():
    tags, natural = AnimaTKPromptExpander._parse_vlm_output(
        "<danbooru_tags>1girl, solo</danbooru_tags>")
    assert tags == ["1girl", "solo"]
    assert natural == ""


def test_vlm_output_parsing_tolerates_empty_input():
    assert AnimaTKPromptExpander._parse_vlm_output("") == ([], "")


def test_vlm_output_parsing_handles_bare_text_without_blocks():
    tags, natural = AnimaTKPromptExpander._parse_vlm_output("1girl, solo")
    assert tags == [] and natural == ""


def test_vlm_tag_validation_drops_non_tag_phrases():
    """VLM 天然会吐非标签短语，必须以索引为准筛掉 —— 这是"输出仍是合法标签"的保证。"""
    original = _use_fake(AnimaTKPromptExpander)
    try:
        known, unknown = AnimaTKPromptExpander._validate_vlm_tags([
            "long hair", "purple eyes",                       # 真实标签
            "soft afternoon light fills the room",            # 句子，非标签
            "realistic anatomy",                              # 非标签
        ])
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert known == ["long hair", "purple eyes"]
    assert len(unknown) == 2


def test_vlm_tag_validation_dedupes():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        known, _unknown = AnimaTKPromptExpander._validate_vlm_tags(
            ["long hair", "long_hair", "Long Hair"])
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert known == ["long hair"]


def test_expand_merges_validated_vlm_tags_into_prompt():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        tags, _natural, _vlm = AnimaTKPromptExpander().expand(
            "1girl, smile", vlm_output=VLM_REPLY)
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "long hair" in tags
    assert "realistic anatomy" not in tags, "未收录标签默认必须被丢弃"


def test_expand_keeps_unknown_vlm_tags_when_asked():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        tags, _n, _v = AnimaTKPromptExpander().expand(
            "1girl", vlm_output=VLM_REPLY, keep_unknown_vlm_tags=True)
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "realistic anatomy" in tags


def test_expand_prefers_vlm_natural_over_template():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        _t, natural, _v = AnimaTKPromptExpander().expand(
            "1girl, smile", vlm_output=VLM_REPLY)
        templated = AnimaTKPromptExpander().expand("1girl, smile")[1]
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "sunlit window" in natural
    assert "sunlit window" not in templated
    assert natural != templated


def test_expand_can_ignore_vlm_natural():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        _t, natural, _v = AnimaTKPromptExpander().expand(
            "1girl, smile", vlm_output=VLM_REPLY, keep_vlm_natural=False)
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "sunlit window" not in natural


def test_expand_still_returns_vlm_prompt_on_empty_input():
    """没有标签也要把指令给出去 —— 它本身就是可用产物（接到 VLM 节点）。"""
    tags, natural, vlm_prompt = AnimaTKPromptExpander().expand("")
    assert tags == "" and natural == ""
    assert "<danbooru_tags>" in vlm_prompt


def test_existing_tags_override_controls_instruction():
    original = _use_fake(AnimaTKPromptExpander)
    try:
        _t, _n, vlm_prompt = AnimaTKPromptExpander().expand(
            "1girl, smile", existing_tags_override="hatsune miku, twintails")
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert "hatsune miku" in vlm_prompt
    assert "smile" not in vlm_prompt


# ────────────── 空行之后的「第二批标签」（2.13.3） ──────────────


def test_looks_like_tag_series_judgement_is_conservative():
    """判据锁：三个文本节点共用这一份，且必须**保守**（宁可漏拆也不误拆）。"""
    from anima_tag_taxonomy import looks_like_tag_series

    assert looks_like_tag_series("1girl, smile, long hair") is True
    assert looks_like_tag_series("smile, long_hair, classroom, hat") is True
    # 句末标点 → 是句子，不是标签批
    assert looks_like_tag_series("A girl smiles, standing near a window.") is False
    # 长片段（>24 字符且 ≥4 个空格）→ 是句子，不是标签批
    assert looks_like_tag_series("she is standing near a window, soft light, morning") is False
    # 片段太少不足以判定成标签批
    assert looks_like_tag_series("1girl, smile") is False
    assert looks_like_tag_series("") is False


def test_expander_absorbs_second_tag_batch_after_blank_line():
    """空行之后若其实是**另一批标签**，必须参与解析 / 扩写 / 去重。

    共享契约把「空行之后」整段算自然语言，而自然语言不参与分类与句式扩写 ——
    用户把两批来源不同的标签直接粘在一起时，第二批就整段贴在输出尾部。
    """
    original = _use_fake(AnimaTKPromptExpander)
    try:
        tags, natural, _vlm = AnimaTKPromptExpander().expand(
            "1girl, smile\n\nsmile, long_hair, classroom", write_natural=False)
        _t2, natural_with_template, _v2 = AnimaTKPromptExpander().expand(
            "1girl, smile\n\nsmile, long_hair, classroom")
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert tags == "1girl, smile, long hair, classroom", "第二批要进标签串，且跨批去重"
    assert natural == "", "第二批不是自然语言，不该留在 natural"
    # 参与句式扩写：第二批的 hair / 背景词要出现在生成的句子里
    assert "long hair" in natural_with_template


def test_expander_keeps_real_sentence_after_blank_line():
    """反向锁：真正的句子不能被拆成标签（判据保守性的行为面）。"""
    original = _use_fake(AnimaTKPromptExpander)
    try:
        tags, natural, _vlm = AnimaTKPromptExpander().expand(
            "1girl, smile\n\nShe is standing near a window in the morning, soft light falls on her face.",
            write_natural=False)
    finally:
        AnimaTKPromptExpander._TAXONOMY_OVERRIDE = original
    assert tags == "1girl, smile"
    assert natural == "She is standing near a window in the morning, soft light falls on her face."


if __name__ == "__main__":
    import traceback
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"  [OK] {test.__name__}")
        except Exception:
            failed += 1
            print(f"  [XX] {test.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} 通过")
    raise SystemExit(1 if failed else 0)
