"""TK Danbooru Tag Getter 的基础行为测试。"""

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from anima_danbooru_tag_getter import AnimaTKDanbooruTagGetter  # noqa: E402


def test_schema_exposes_bundle_and_all_twelve_native_switches():
    required = AnimaTKDanbooruTagGetter.INPUT_TYPES()["required"]
    assert required["tag_bundle"] == ("TAG_BUNDLE",)
    assert list(required)[1:] == list(AnimaTKDanbooruTagGetter.CATEGORY_NAMES)
    assert all(required[name][0] == "BOOLEAN" for name in AnimaTKDanbooruTagGetter.CATEGORY_NAMES)


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

