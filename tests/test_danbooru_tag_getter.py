"""TK Danbooru Tag Getter 的基础行为测试。"""

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from anima_danbooru_tag_getter import AnimaTKDanbooruTagGetter  # noqa: E402


def test_schema_exposes_bundle_and_all_twelve_native_switches():
    required = AnimaTKDanbooruTagGetter.INPUT_TYPES()["required"]
    optional = AnimaTKDanbooruTagGetter.INPUT_TYPES()["optional"]
    assert optional["tag_bundle"] == ("TAG_BUNDLE",)
    assert "tag_bundle" not in required
    assert list(required)[:len(AnimaTKDanbooruTagGetter.CATEGORY_NAMES)] == list(AnimaTKDanbooruTagGetter.CATEGORY_NAMES)
    assert all(required[name][0] == "BOOLEAN" for name in AnimaTKDanbooruTagGetter.CATEGORY_NAMES)
    assert "自然语言" not in required
    assert optional["natural_language"][0] == "STRING"
    assert optional["natural_language"][1]["forceInput"] is True
    assert "统一输入" in optional["natural_language"][1]["tooltip"]
    assert optional["include_natural_language"][0] == "BOOLEAN"
    assert optional["filter_natural_language"][0] == "BOOLEAN"
    assert optional["include_natural_language"][1]["default"] is True
    assert optional["filter_natural_language"][1]["default"] is True
    for category in AnimaTKDanbooruTagGetter.CATEGORY_NAMES:
        weight = optional[AnimaTKDanbooruTagGetter.WEIGHT_INPUTS[category]]
        assert weight[0] == "FLOAT"
        assert weight[1]["default"] == 1.0
        assert weight[1]["min"] == 0.05
        assert weight[1]["max"] == 2.0


def test_single_category():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"背景词": "classroom, window, "},
        **{"背景词": True},
    )
    assert result == ("classroom, window",)


def test_multiple_categories_keep_fixed_order():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"镜头词": "looking at viewer, ", "画师词": "watercolor, "},
        **{"镜头词": True, "画师词": True},
    )
    assert result == ("watercolor, looking at viewer",)


def test_none_selected_outputs_empty():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"画师词": "watercolor, ", "背景词": "outdoor, "},
    )
    assert result == ("",)


def test_optional_natural_language_is_preserved_after_filtered_tags():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"人物对象词": "1girl, ", "动作词": "squatting, "},
        **{
            "人物对象词": True,
            "动作词": True,
            "未归类词": True,
            "natural_language": "A medium shot captures a fox-eared girl in a large basin.",
        },
    )
    assert result == ("1girl, squatting\n\nA medium shot captures a fox-eared girl in a large basin.",)


def test_natural_language_only_does_not_require_tag_bundle():
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="1girl, soft smile, A medium shot captures her expression.",
        **{"未归类词": True},
    )
    assert result == ("1girl, soft smile, A medium shot captures her expression.",)


def test_natural_language_only_without_bundle_is_not_dropped_when_category_state_is_missing():
    """旧工作流可能把分类布尔值还原为空，但自然语言仍是可过滤的输入。"""
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="indoors, a girl looks toward the viewer.",
        include_natural_language=True,
        **{"未归类词": False},
    )
    assert result == ("indoors, a girl looks toward the viewer.",)


def test_single_prompt_input_classifies_known_tags_and_keeps_natural_language():
    """统一 Prompt 输入应把已知 Danbooru Tag 分类，并可保留未知自然语言。"""
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="1girl, smile, A girl looks toward the viewer.",
        **{"人物对象词": True, "角色表情词": True, "未归类词": True},
    )
    assert result == ("1girl, smile\n\nA girl looks toward the viewer.",)


def test_single_prompt_input_handles_weighted_tags_and_packer_headers():
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="1girl, (smile:1.2), 角色表情词:\nA girl looks toward the viewer.",
        **{"人物对象词": True, "角色表情词": True, "未归类词": True},
    )
    assert result == ("1girl, (smile:1.2)\n\nA girl looks toward the viewer.",)


def test_single_prompt_input_can_drop_natural_language_without_dropping_tags():
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="1girl, A girl looks toward the viewer.",
        include_natural_language=False,
        **{"人物对象词": True, "未归类词": True},
    )
    assert result == ("1girl",)


def test_category_weights_wrap_only_selected_categories():
    original_index = AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX
    AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX = {
        "1girl": "人物对象词",
        "smile": "角色表情词",
        "classroom": "背景词",
    }
    try:
        result = AnimaTKDanbooruTagGetter().get_tags(
            natural_language="1girl, smile, classroom",
            **{
                "人物对象词": True,
                "角色表情词": True,
                "背景词": True,
                "人物对象词_weight": 1.2,
                "角色表情词_weight": 0.8,
                "背景词_weight": 1.0,
            },
        )
    finally:
        AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX = original_index
    assert result == ("classroom, (1girl:1.2), (smile:0.8)",)


def test_category_weight_multiplies_existing_tag_weight_and_preserves_default():
    original_index = AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX
    AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX = {"smile": "角色表情词", "1girl": "人物对象词"}
    try:
        weighted = AnimaTKDanbooruTagGetter().get_tags(
            natural_language="(smile:1.2), 1girl",
            **{"角色表情词": True, "人物对象词": True, "角色表情词_weight": 0.5},
        )
        plain = AnimaTKDanbooruTagGetter().get_tags(
            natural_language="(smile:1.2), 1girl",
            **{"角色表情词": True, "人物对象词": True},
        )
    finally:
        AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX = original_index
    assert weighted == ("1girl, (smile:0.6)",)
    assert plain == ("1girl, (smile:1.2)",)


def test_zero_weight_from_legacy_workflow_is_neutral_not_invalid():
    """新增权重控件在旧工作流恢复时可能还原为 0，不应输出 (tag:0)。"""
    original_index = AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX
    AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX = {"smile": "角色表情词"}
    try:
        result = AnimaTKDanbooruTagGetter().get_tags(
            natural_language="smile",
            **{"角色表情词": True, "角色表情词_weight": 0.0},
        )
    finally:
        AnimaTKDanbooruTagGetter._TAG_CATEGORY_INDEX = original_index
    assert result == ("smile",)


def test_legacy_bundle_weight_keeps_all_tags_deduplication():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"人物对象词": "1girl, ", "角色表情词": "smile, ", "背景词": "classroom, "},
        natural_language="1girl, smile, classroom\n\nA girl looks toward viewer.",
        **{
            "人物对象词": True,
            "角色表情词": True,
            "背景词": True,
            "未归类词": True,
            "人物对象词_weight": 1.2,
            "角色表情词_weight": 0.8,
        },
    )
    assert result == ("classroom, (1girl:1.2), (smile:0.8)\n\nA girl looks toward viewer.",)


def test_natural_language_filter_applies_exact_blacklist_without_dropping_other_text():
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="1girl, halo hair, soft smile, A medium shot captures her expression.",
        tag_blacklist="halo hair",
        filter_natural_language=True,
        **{"未归类词": True},
    )
    assert result == ("1girl, soft smile, A medium shot captures her expression.",)


def test_natural_language_can_be_excluded_explicitly():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"人物对象词": "1girl, "},
        **{
            "人物对象词": True,
            "natural_language": "A medium shot captures her expression.",
            "未归类词": False,
        },
    )
    assert result == ("1girl",)


def test_full_prompt_input_does_not_duplicate_prefix_tags():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"人物对象词": "1girl, ", "动作词": "squatting, "},
        **{
            "人物对象词": True,
            "动作词": True,
            "未归类词": True,
            "natural_language": "1girl, squatting, red cloak\n\nA medium shot captures a fox-eared girl.",
        },
    )
    assert result == ("1girl, squatting\n\nA medium shot captures a fox-eared girl.",)


def test_packer_bundle_and_all_tags_are_filtered_together():
    """Packer 的分类包与 ALL_TAGS 同时接入时，只保留选中分类和剩余未归类文本。"""
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"人物对象词": "1girl, ", "背景词": "indoors, "},
        **{
            "人物对象词": True,
            "背景词": False,
            "未归类词": True,
            "natural_language": "1girl, indoors, A girl looks toward the viewer.",
        },
    )
    assert result == ("1girl\n\nA girl looks toward the viewer.",)


def test_all_categories_are_supported():
    bundle = {category: f"tag-{index}, " for index, category in enumerate(AnimaTKDanbooruTagGetter.CATEGORY_NAMES)}
    flags = {category: True for category in AnimaTKDanbooruTagGetter.CATEGORY_NAMES}
    result = AnimaTKDanbooruTagGetter().get_tags(bundle, **flags)
    assert result == (", ".join(f"tag-{index}" for index in range(12)),)


def test_empty_and_missing_categories_are_skipped():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"画师词": "", "背景词": "  , , ", "人物对象词": "1girl, "},
        **{"画师词": True, "背景词": True, "人物对象词": True, "服饰词": True},
    )
    assert result == ("1girl",)


def test_duplicate_tags_are_removed_case_insensitively():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"画师词": "watercolor, 1girl, ", "背景词": "Watercolor, 1girl, classroom,, "},
        **{"画师词": True, "背景词": True},
    )
    assert result == ("watercolor, 1girl, classroom",)


def test_exact_blacklist_filters_comma_and_newline_entries():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"画师词": "watercolor, speech_bubble, ", "背景词": "classroom, Thought_Bubble, "},
        **{
            "画师词": True,
            "背景词": True,
            "tag_blacklist": "speech_bubble\nthought_bubble",
        },
    )
    assert result == ("watercolor, classroom",)


def test_regex_blacklist_is_case_insensitive_and_applies_before_merge():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"画师词": "watercolor, logo_mark, ", "背景词": "watermark, classroom, "},
        **{"画师词": True, "背景词": True, "regex_blacklist": "logo|watermark"},
    )
    assert result == ("watercolor, classroom",)


def test_invalid_regex_is_ignored_without_blocking_exact_filter():
    result = AnimaTKDanbooruTagGetter().get_tags(
        {"画师词": "speech_bubble, watercolor, "},
        **{"画师词": True, "regex_blacklist": "[", "tag_blacklist": "speech_bubble"},
    )
    assert result == ("watercolor",)


def test_tag_bundle_is_not_modified():
    bundle = {"画师词": "watercolor, ", "背景词": "classroom, "}
    original = dict(bundle)
    AnimaTKDanbooruTagGetter().get_tags(bundle, **{"画师词": True, "背景词": True})
    assert bundle == original


def test_invalid_bundle_and_non_string_category_do_not_raise():
    node = AnimaTKDanbooruTagGetter()
    assert node.get_tags(None, **{"画师词": True}) == ("",)
    assert node.get_tags({"画师词": ["not", "the", "bundle", "shape"]}, **{"画师词": True}) == ("",)


if __name__ == "__main__":
    tests = [
        test_schema_exposes_bundle_and_all_twelve_native_switches,
        test_single_category,
        test_multiple_categories_keep_fixed_order,
        test_none_selected_outputs_empty,
        test_optional_natural_language_is_preserved_after_filtered_tags,
        test_natural_language_only_does_not_require_tag_bundle,
        test_natural_language_only_without_bundle_is_not_dropped_when_category_state_is_missing,
        test_single_prompt_input_classifies_known_tags_and_keeps_natural_language,
        test_single_prompt_input_handles_weighted_tags_and_packer_headers,
        test_single_prompt_input_can_drop_natural_language_without_dropping_tags,
        test_category_weights_wrap_only_selected_categories,
        test_category_weight_multiplies_existing_tag_weight_and_preserves_default,
        test_zero_weight_from_legacy_workflow_is_neutral_not_invalid,
        test_legacy_bundle_weight_keeps_all_tags_deduplication,
        test_natural_language_filter_applies_exact_blacklist_without_dropping_other_text,
        test_natural_language_can_be_excluded_explicitly,
        test_full_prompt_input_does_not_duplicate_prefix_tags,
        test_packer_bundle_and_all_tags_are_filtered_together,
        test_all_categories_are_supported,
        test_empty_and_missing_categories_are_skipped,
        test_duplicate_tags_are_removed_case_insensitively,
        test_exact_blacklist_filters_comma_and_newline_entries,
        test_regex_blacklist_is_case_insensitive_and_applies_before_merge,
        test_invalid_regex_is_ignored_without_blocking_exact_filter,
        test_tag_bundle_is_not_modified,
        test_invalid_bundle_and_non_string_category_do_not_raise,
    ]
    for test in tests:
        test()
    print(f"PASS: {len(tests)} Danbooru Tag Getter tests")
