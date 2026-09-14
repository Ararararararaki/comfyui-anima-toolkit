"""TK Danbooru Tag Getter 的基础行为测试。"""

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from anima_danbooru_tag_getter import AnimaTKDanbooruTagGetter  # noqa: E402
from anima_tag_taxonomy import LEGACY_CATEGORY_COUNT  # noqa: E402


class FakeTaxonomy:
    """测试替身：只提供 {键: 分类名} 查表，避免单测加载 9.4MB 真实索引。"""

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
        # 走 lookup 而不是硬返回空：子类只需覆盖 lookup 就能同时影响组判定
        hit = self.lookup(value)
        return hit[1] if hit else ()


def test_schema_exposes_bundle_and_all_twelve_native_switches():
    """旧 12 类必须留在 required 且顺序不变 —— 这是旧工作流 widgets_values 的位置基线。

    新增的 8 类开关一律追加在 optional 末尾、默认 True（保证升级不丢标签）。
    自然语言相关的三个控件（natural_mode / include / filter）已废弃但**必须保留**：
    它们是位置占位，删掉会让已有工作流的 widgets_values 错位或超长。
    """
    types = AnimaTKDanbooruTagGetter.INPUT_TYPES()
    required = types["required"]
    optional = types["optional"]
    assert optional["tag_bundle"] == ("TAG_BUNDLE",)
    assert "tag_bundle" not in required

    legacy = list(AnimaTKDanbooruTagGetter.CATEGORY_NAMES[:LEGACY_CATEGORY_COUNT])
    assert list(required) == legacy
    assert all(required[name][0] == "BOOLEAN" for name in legacy)
    assert all(required[name][1]["default"] is False for name in legacy)

    for category in AnimaTKDanbooruTagGetter.NEW_CATEGORY_NAMES:
        assert optional[category][0] == "BOOLEAN"
        expected_default = category not in AnimaTKDanbooruTagGetter.DEFAULT_OFF_CATEGORIES
        assert optional[category][1]["default"] is expected_default, (
            "新增分类默认开启（审查遮挡词 / 文字水印词除外）：默认关闭会让升级后标签静默消失")

    # 新增控件必须排在所有旧控件之后，否则旧工作流的 widgets_values 会错位
    # （穷举脚本抓到过：natural_mode 一度插在 include/filter 之间，导致后面全部错位）
    optional_names = list(optional)
    first_new = AnimaTKDanbooruTagGetter.NEW_CATEGORY_NAMES[0]
    assert optional_names.index(first_new) > optional_names.index("未归类词_weight")
    assert optional_names[-4:] == ["preset", "exclude_groups", "exclude_groups_custom",
                                   "natural_mode"]
    # 旧控件的相对顺序也必须原样保持
    legacy_order = ["regex_blacklist", "tag_blacklist", "include_natural_language",
                    "filter_natural_language"]
    assert [n for n in optional_names if n in legacy_order] == legacy_order
    assert optional_names.index("filter_natural_language") < optional_names.index(
        AnimaTKDanbooruTagGetter.LEGACY_WEIGHT_INPUTS["画师词"])

    assert "自然语言" not in required
    assert optional["natural_language"][0] == "STRING"
    assert optional["natural_language"][1]["forceInput"] is True
    assert "统一输入" in optional["natural_language"][1]["tooltip"]
    # ── 自然语言遗留占位（2026-09-13：UI 模块整体移除，控件只占位不参与判定）──
    # 这三个键**必须存在且顺序不变**：前端已把它们隐藏，后端已不读它们，
    # 但它们占着 widgets_values 的位置。谁要删它们，先看本文件末尾的回归测试。
    assert optional["include_natural_language"][0] == "BOOLEAN"
    assert optional["filter_natural_language"][0] == "BOOLEAN"
    assert optional["include_natural_language"][1]["default"] is True
    assert optional["filter_natural_language"][1]["default"] is False
    assert "natural_mode" in optional
    # natural_mode / preset 都必须是 STRING 而非 COMBO：旧工作流缺这两个控件时
    # ComfyUI 用 "" 补 widgets_values，COMBO 的列表校验会让节点直接报
    # "部分输入值不适用于该节点"。这个坑已经踩过两次，用断言钉死。
    assert optional["natural_mode"][0] == "STRING"
    assert not isinstance(optional["natural_mode"][0], list)
    assert "已废弃" in optional["natural_mode"][1]["tooltip"]
    assert optional["preset"][0] == "STRING"
    assert not isinstance(optional["preset"][0], list)
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
    """旧工作流可能把分类布尔值还原为空，但自然语言仍必须原样输出。"""
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


def test_legacy_drop_switch_no_longer_drops_natural_language():
    """自然语言模块已移除（2026-09-13）：旧工作流里存着的 include=False 被忽略。

    这是行为契约，不是容错 —— 三个遗留控件只占位，不参与任何判定。
    """
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="1girl, A girl looks toward the viewer.",
        include_natural_language=False,
        **{"人物对象词": True, "未归类词": True},
    )
    assert result == ("1girl\n\nA girl looks toward the viewer.",)


def test_category_weights_wrap_only_selected_categories():
    original_override = AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE
    AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE = FakeTaxonomy({
        "1girl": "人物对象词",
        "smile": "角色表情词",
        "classroom": "背景词",
    })
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
        AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE = original_override
    assert result == ("classroom, (1girl:1.2), (smile:0.8)",)


def test_category_weight_multiplies_existing_tag_weight_and_preserves_default():
    original_override = AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE
    AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE = FakeTaxonomy({"smile": "角色表情词", "1girl": "人物对象词"})
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
        AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE = original_override
    assert weighted == ("1girl, (smile:0.6)",)
    assert plain == ("1girl, (smile:1.2)",)


def test_zero_weight_from_legacy_workflow_is_neutral_not_invalid():
    """新增权重控件在旧工作流恢复时可能还原为 0，不应输出 (tag:0)。"""
    original_override = AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE
    AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE = FakeTaxonomy({"smile": "角色表情词"})
    try:
        result = AnimaTKDanbooruTagGetter().get_tags(
            natural_language="smile",
            **{"角色表情词": True, "角色表情词_weight": 0.0},
        )
    finally:
        AnimaTKDanbooruTagGetter._TAXONOMY_OVERRIDE = original_override
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


def test_legacy_filter_switch_no_longer_deletes_natural_language():
    """真实故障回归 + 模块移除回归（2026-09-13）。

    用户配置 ``regex_blacklist="halo|hair|mole|background"``，旧版「过滤自然语言」按
    逗号片段套用该正则 → LLM 写的整句没有逗号 → 含 hair / background 就**整段被删**
    → 下游提示词为空。模块移除后，旧工作流里存着的 ``filter_natural_language=True``
    一律被忽略，句子必须原样保留。
    """
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language=LLM_NATURAL,
        regex_blacklist="halo|hair|mole|background",
        include_natural_language=True,
        filter_natural_language=True,
        **{"未归类词": True},
    )[0]
    assert "purple hair" in result
    assert "blurred background" in result


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
    assert result == (", ".join(
        f"tag-{index}" for index in range(len(AnimaTKDanbooruTagGetter.CATEGORY_NAMES))
    ),)


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


# ────────────── 场景预设（新增） ──────────────


def test_preset_off_turns_off_named_categories_only():
    preset = "换角色（剥离身份/版权/画师）"
    flags = AnimaTKDanbooruTagGetter._apply_preset(
        preset, {"人物对象词": True, "角色身份词": True, "作品版权词": True,
                 "画师词": True, "服饰词": True})
    assert flags["角色身份词"] is False
    assert flags["作品版权词"] is False
    assert flags["画师词"] is False
    assert flags["服饰词"] is True
    assert flags["人物对象词"] is True


def test_preset_only_turns_everything_else_off():
    flags = AnimaTKDanbooruTagGetter._apply_preset(
        "仅保留骨架（动作/表情/镜头/背景）",
        {category: True for category in AnimaTKDanbooruTagGetter.CATEGORY_NAMES})
    kept = {name for name, value in flags.items() if value is True}
    assert kept == {"人物对象词", "动作词", "角色表情词", "镜头词", "背景词"}


def test_preset_keeps_weight_keys_intact():
    """预设展开时不能丢掉 `<分类>_weight`，否则所有分类权重会静默失效。"""
    flags = AnimaTKDanbooruTagGetter._apply_preset(
        "清除干扰（审查/水印/质量元）",
        {"服饰词": True, "服饰词_weight": 1.35, "背景词_weight": 0.5})
    assert flags["服饰词_weight"] == 1.35
    assert flags["背景词_weight"] == 0.5


def test_preset_none_is_a_noop():
    source = {"背景词": True, "服饰词_weight": 0.8}
    flags = AnimaTKDanbooruTagGetter._apply_preset(AnimaTKDanbooruTagGetter.PRESET_NONE, source)
    assert flags["背景词"] is True
    assert flags["服饰词_weight"] == 0.8


def test_unknown_preset_falls_back_to_noop():
    flags = AnimaTKDanbooruTagGetter._apply_preset("不存在的预设", {"背景词": True})
    assert flags["背景词"] is True


# ────────────── 主题剔除（语义组，新增） ──────────────


def test_removed_theme_filter_ignores_legacy_group_values():
    """主题剔除模块已移除（2026-09-14）：旧工作流里存的组值必须**被忽略**而不是继续生效。

    这两个控件仍留在 INPUT_TYPES 里占位（删了会让 widgets_values 错位），
    所以这条锁保证「占位控件不再影响输出」。
    """
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="long hair, blue eyes, smile",
        exclude_groups="furry,big_breasts",
        exclude_groups_custom="我的黑名单 = long hair, blue eyes",
        **{"发色发型词": True, "角色五官词": True, "角色表情词": True},
    )
    # 三个词都在（按分类顺序：表情词 → 五官词 → 发色发型词）
    assert result == ("blue eyes, smile, long hair",)


def test_no_exclude_arguments_leaves_everything_untouched():
    # 输出按 CATEGORY_NAMES 顺序：角色表情词(9) 在 发色发型词(14) 之前
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="long hair, smile",
        **{"发色发型词": True, "角色表情词": True},
    )
    assert result == ("smile, long hair",)


# ────────────── 自定义预设（保存 / 应用 / 删除） ──────────────

def test_custom_preset_roundtrip(monkeypatch, tmp_path):
    preset_file = tmp_path / "tag_presets.json"
    monkeypatch.setattr(AnimaTKDanbooruTagGetter, "_preset_path",
                        classmethod(lambda cls: str(preset_file)))
    node = AnimaTKDanbooruTagGetter

    ok, message = node.save_custom_preset(
        "我的场景",
        {"画师词": True, "角色身份词": False, "镜头词": True},
        {"画师词": 1.6},
    )
    assert ok, message
    assert node.custom_preset_names() == ["我的场景"]

    flags = node._apply_preset("我的场景", {})
    assert flags["画师词"] is True
    assert flags["角色身份词"] is False
    assert flags["镜头词"] is True
    assert flags["画师词_weight"] == 1.6        # 权重也一起还原

    ok, _message = node.delete_custom_preset("我的场景")
    assert ok
    assert node.custom_preset_names() == []


def test_custom_preset_rejects_builtin_and_blank_names(monkeypatch, tmp_path):
    preset_file = tmp_path / "tag_presets.json"
    monkeypatch.setattr(AnimaTKDanbooruTagGetter, "_preset_path",
                        classmethod(lambda cls: str(preset_file)))
    node = AnimaTKDanbooruTagGetter

    assert node.save_custom_preset("", {})[0] is False
    assert node.save_custom_preset(node.PRESET_NONE, {})[0] is False
    assert node.save_custom_preset("换角色（剥离身份/版权/画师）", {})[0] is False
    assert node.save_custom_preset("x" * 200, {})[0] is False
    assert node.custom_preset_names() == []


def test_unknown_preset_name_is_still_a_noop(monkeypatch, tmp_path):
    monkeypatch.setattr(AnimaTKDanbooruTagGetter, "_preset_path",
                        classmethod(lambda cls: str(tmp_path / "tag_presets.json")))
    flags = AnimaTKDanbooruTagGetter._apply_preset("根本没有这个预设", {"背景词": True})
    assert flags["背景词"] is True


def test_default_off_categories_are_disabled_and_reported():
    """审查遮挡词 / 文字水印词默认关闭（负面词类），且空值修正也按关闭处理。"""
    node = AnimaTKDanbooruTagGetter
    optional = node.INPUT_TYPES()["optional"]
    for category in node.DEFAULT_OFF_CATEGORIES:
        assert optional[category][1]["default"] is False, f"{category} 应默认关闭"
        assert node._coerce_flag(category, "") is False, f"{category} 的空值应修正为 False"
    # 其余新增分类仍然默认开启（升级不丢标签）
    for category in node.NEW_CATEGORY_NAMES:
        if category in node.DEFAULT_OFF_CATEGORIES:
            continue
        assert optional[category][1]["default"] is True, f"{category} 应默认开启"
        assert node._coerce_flag(category, "") is True
    # 元数据里也要告诉前端
    assert node.ui_meta()["default_off"] == list(node.DEFAULT_OFF_CATEGORIES)



# ────────────── 旧工作流的空值补足（真实报错回归） ──────────────


def test_preset_is_string_so_empty_value_from_legacy_workflow_is_accepted():
    """真实故障回归：旧工作流没有 preset 控件，ComfyUI 用 "" 补足 widgets_values。

    当 preset 声明为 COMBO 时，"" 不在选项列表内，会直接报
    ``Value not in list: preset: ''`` 并让节点 ``Output will be ignored``。
    所以它必须是 STRING，且空值等价于"不用预设"。
    """
    optional = AnimaTKDanbooruTagGetter.INPUT_TYPES()["optional"]
    assert optional["preset"][0] == "STRING", "preset 必须是 STRING 才能容忍空字符串"
    assert not isinstance(optional["preset"][0], list), "preset 不能再是 COMBO"

    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="smile, long_hair",
        preset="",
        **{"角色表情词": True, "发色发型词": True},
    )
    # Tag Getter 保持标签原样输出（规范化是 TK Anima 格式化 的职责）
    assert result == ("smile, long_hair",)


def test_unknown_preset_value_is_tolerated():
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="smile",
        preset="某个已经不存在的旧预设",
        **{"角色表情词": True},
    )
    assert result == ("smile",)


def test_legacy_empty_flag_stays_false_for_original_categories():
    """旧分类的空值仍表示"未勾选"，不能因为容错而意外打开。"""
    flags = AnimaTKDanbooruTagGetter._apply_preset("", {"画师词": "", "背景词": True})
    assert flags["画师词"] is False
    assert flags["背景词"] is True


def test_empty_flag_means_true_for_new_categories():
    """新增分类在旧工作流里不存在，空值必须视为 True —— 否则升级后角色名静默消失。"""
    flags = AnimaTKDanbooruTagGetter._apply_preset(
        "", {"角色身份词": "", "作品版权词": "", "画师词": ""})
    assert flags["角色身份词"] is True
    assert flags["作品版权词"] is True
    assert flags["画师词"] is False


# ────────────── 自然语言模块移除（真实故障回归，2026-09-13） ──────────────
#
# 背景：这一块前后长出了四个控件 —— include_natural_language、filter_natural_language、
# natural_mode，加上 natural_language 输入本身。「保留」与「过滤」同时开时语义互相打架
# （过滤会拿标签用的 regex_blacklist 去删自然语言句子），随后又加了下拉做"收敛"，
# 等于同一件事摆三个控件。用户明确要求**整块去掉**。
# 现在的契约：三个控件只占位（前端隐藏、后端不读），自然语言永远原样保留。
# 有分类包时它仍归「未归类词」分类开关管（那是分类语义，不是被移除的模块）。

LLM_NATURAL = ("A girl with long purple hair rests peacefully, her eyes gently closed. "
               "Soft light bathes her face against a blurred background.")


def test_natural_language_is_preserved_for_every_legacy_widget_value():
    """旧工作流里残留的任何取值都不得再影响输出：一律原样保留自然语言。"""
    legacy_values = (
        {"include_natural_language": False},                                    # 旧「不保留」
        {"filter_natural_language": True},                                      # 旧「过滤」
        {"include_natural_language": False, "filter_natural_language": True},    # 旧「全开」= 空提示词 bug
        {"natural_mode": "保留（不过滤）"},
        {"natural_mode": "按排除规则过滤"},
        {"natural_mode": "丢弃自然语言"},
    )
    for legacy in legacy_values:
        result = AnimaTKDanbooruTagGetter().get_tags(
            natural_language=LLM_NATURAL,
            regex_blacklist="halo|hair|mole|background",
            **legacy,
            **{"未归类词": True},
        )[0]
        assert "purple hair" in result, legacy
        assert "blurred background" in result, legacy


def test_legacy_workflow_short_widgets_values_do_not_drop_character_tags():
    """端到端：模拟旧工作流的 15 个 widgets_values（后续控件全部被补成空值）。"""
    legacy_values = ["False", "True", "True", "False", "True", "True", "True",
                     "False", "True", "True", "True", "True", "halo|hair", "", ""]
    names = list(AnimaTKDanbooruTagGetter.CATEGORY_NAMES[:12]) + ["regex_blacklist", "tag_blacklist"]
    flags = {}
    for name, value in zip(names, legacy_values):
        if name in AnimaTKDanbooruTagGetter.CATEGORY_NAMES:
            flags[name] = value
    # 其余控件（新增分类 / 权重 / preset / 剔除）在旧工作流里都是 ""
    for category in AnimaTKDanbooruTagGetter.CATEGORY_NAMES[12:]:
        flags.setdefault(category, "")
    result = AnimaTKDanbooruTagGetter().get_tags(
        natural_language="plana_\\(blue_archive\\), long_hair, smile",
        preset="",
        regex_blacklist=legacy_values[12],
        **flags,
    )[0]
    assert "plana" in result, "升级后角色 tag 不应消失"
    # 注意：该工作流的 regex_blacklist 就是 "halo|hair"，会命中并排除 long_hair
    # —— 这是用户既有配置的预期结果，不是回归。
    assert "long_hair" not in result


# ────────────── 共享层与前端元数据契约（2026-09-13 去重） ──────────────


def test_text_nodes_all_resolve_taxonomy_through_the_shared_helper():
    """三个 TK 文本节点必须共用一份索引。

    过去 Tag Getter / Anima 格式化 / 提示词扩写各自持有 TagTaxonomy 实例，
    同一份 9.4 MB 索引被解析并驻留三份 —— 这是纯浪费，且三处实现会各自漂移。
    """
    from anima_anima_formatter import AnimaTKAnimaFormatter
    from anima_prompt_expander import AnimaTKPromptExpander

    classes = (AnimaTKDanbooruTagGetter, AnimaTKAnimaFormatter, AnimaTKPromptExpander)
    sentinel = FakeTaxonomy({"smile": "角色表情词"})
    originals = [cls._TAXONOMY_OVERRIDE for cls in classes]
    try:
        # 测试注入点必须仍然有效（否则所有 FakeTaxonomy 单测失效）
        for cls in classes:
            cls._TAXONOMY_OVERRIDE = sentinel
            assert cls._taxonomy() is sentinel
        # 清掉 override 后，三者拿到的必须是**同一个对象**
        for cls in classes:
            cls._TAXONOMY_OVERRIDE = None
        instances = [cls._taxonomy() for cls in classes]
        assert instances[0] is instances[1] is instances[2]
    finally:
        for cls, original in zip(classes, originals):
            cls._TAXONOMY_OVERRIDE = original


def test_split_prompt_contract_is_implemented_once():
    """「空行分隔标签段与自然语言段」只允许有一份实现。"""
    from anima_anima_formatter import AnimaTKAnimaFormatter
    from anima_prompt_expander import AnimaTKPromptExpander
    from anima_tag_taxonomy import NATURAL_GAP, split_prompt

    assert NATURAL_GAP == "\n\n"
    value = "1girl, long_hair\n\nA girl looks at the viewer."
    expected = (["1girl", "long_hair"], ["A girl looks at the viewer."])
    assert split_prompt(value) == expected
    assert AnimaTKAnimaFormatter._split_segments(value) == expected
    assert AnimaTKPromptExpander._split_input(value) == expected
    assert split_prompt("") == ([], [])
    assert split_prompt("a, b") == (["a", "b"], [])


def test_ui_meta_is_the_single_source_for_the_panel():
    """后端仍提供面板的权威元数据（经 /object_info 出到浏览器，前端可选使用）。

    2026-09-14 前端按用户要求退回原生风格版本后，面板不再**依赖**这份元数据
    （未重启 ComfyUI 时后端还是旧代码，拿不到 tk_ui，预设下拉会整个消失）。
    这份元数据因此从「唯一数据源」降级为「权威参考 + 未来的在线数据源」，
    一致性由下面那条 fallback 锁保证。
    """
    import json as _json

    meta = AnimaTKDanbooruTagGetter.ui_meta()
    assert meta["categories"] == list(AnimaTKDanbooruTagGetter.CATEGORY_NAMES)
    assert meta["legacy_count"] == LEGACY_CATEGORY_COUNT
    assert meta["preset_none"] == AnimaTKDanbooruTagGetter.PRESET_NONE
    assert meta["default_off"] == list(AnimaTKDanbooruTagGetter.DEFAULT_OFF_CATEGORIES)
    assert isinstance(meta["custom_presets"], list)
    assert set(meta["presets"]) == set(AnimaTKDanbooruTagGetter.PRESETS)
    for spec in meta["presets"].values():
        assert set(spec) == {"off", "only"}, "前端按 off/only 两个键展开预设"
    # 必须 JSON 可序列化：它要走 /object_info
    assert _json.loads(_json.dumps(meta, ensure_ascii=False))["categories"] == meta["categories"]
    # 组元数据只带展示字段（tags / rules 是后端匹配用的词表，不进 /object_info）
    for group in meta["groups"]:
        assert set(group) == {"id", "label", "short", "desc"}
        assert group["id"] and group["short"]
    # 必须挂在 preset 控件的 options 上，前端才读得到
    preset_options = AnimaTKDanbooruTagGetter.INPUT_TYPES()["optional"]["preset"][1]
    assert preset_options["tk_ui"] == meta


def _widget_source():
    return (ROOT / "web" / "js" / "anima_danbooru_tag_getter_widget.js").read_text(encoding="utf-8")


def _js_string_array(source, name):
    """取出 ``const NAME = [ ... ];`` 里的字符串字面量（按出现顺序）。"""
    match = re.search(rf"const {name} = \[(.*?)\];", source, re.S)
    assert match, f"前端缺少 {name} 兜底表"
    return re.findall(r'"((?:[^"\\]|\\.)*)"', match.group(1))


def _js_presets(source, preset_none):
    """解析前端 PRESETS 字面量 → {名称: {"off": [...], "only": [...]}}。"""
    block = re.search(r"const PRESETS = \{(.*?)\n  \};", source, re.S)
    assert block, "前端缺少 PRESETS 兜底表"
    body = block.group(1)
    heads = list(re.finditer(r'\n    (?:\[PRESET_NONE\]|"((?:[^"\\]|\\.)*)")\s*:\s*\{', body))
    presets = {}
    for index, head in enumerate(heads):
        name = head.group(1) or preset_none
        end = heads[index + 1].start() if index + 1 < len(heads) else len(body)
        spec = {}
        for kind in ("off", "only"):
            found = re.search(rf"{kind}: \[(.*?)\]", body[head.end():end], re.S)
            if found:
                spec[kind] = re.findall(r'"((?:[^"\\]|\\.)*)"', found.group(1))
        presets[name] = spec
    return presets


def test_frontend_widget_fallback_tables_stay_in_sync_with_backend():
    """前端内置兜底表必须与后端逐项一致（防漂移锁）。

    2026-09-14：按用户要求把面板回退到原生风格版本，前端重新内置了
    CATEGORY_NAMES / PRESETS / DEFAULT_OFF_CATEGORIES。原因是**场景预设不能依赖
    /object_info 的 tk_ui** —— ComfyUI 没重启时后端还是旧代码、元数据缺失，
    自绘预设下拉会整个消失（用户实际故障）。

    内置可以，但不许与后端漂移：这条锁把两边逐项比对，改一边不改另一边立刻红。
    （同一天主题剔除模块被移除，所以前端不再有 SHOWCASE_GROUPS 可比。）
    """
    node = AnimaTKDanbooruTagGetter
    source = _widget_source()

    assert _js_string_array(source, "CATEGORY_NAMES") == list(node.CATEGORY_NAMES), \
        "前端分类表与后端 CATEGORY_NAMES 不一致"

    legacy = re.search(r"const LEGACY_CATEGORY_COUNT = (\d+);", source)
    assert legacy and int(legacy.group(1)) == LEGACY_CATEGORY_COUNT, \
        "前端 LEGACY_CATEGORY_COUNT 与后端不一致"

    assert re.search(rf'const PRESET_NONE = "{re.escape(node.PRESET_NONE)}";', source), \
        "前端 PRESET_NONE 与后端不一致"

    expected_presets = {
        name: {kind: list(values) for kind, values in spec.items()}
        for name, spec in node.PRESETS.items()
    }
    assert _js_presets(source, node.PRESET_NONE) == expected_presets, \
        "前端场景预设表与后端 PRESETS 不一致（含 off/only 明细）"

    assert _js_string_array(source, "DEFAULT_OFF_CATEGORIES") == list(node.DEFAULT_OFF_CATEGORIES), \
        "前端默认关闭分类表与后端 DEFAULT_OFF_CATEGORIES 不一致"

    # 主题剔除已移除：前端不该再引用那套 chips 数据
    assert "SHOWCASE_GROUPS" not in source, "主题剔除已移除，前端不该再有主题组表"
    assert "hideNativeWidget" in source, "自绘面板必须继续隐藏被替代的原生控件"
    assert "savePreset" in source and "/anima/tag_presets" in source, \
        "前端必须保留自定义预设的保存/删除入口"


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
        test_legacy_drop_switch_no_longer_drops_natural_language,
        test_category_weights_wrap_only_selected_categories,
        test_category_weight_multiplies_existing_tag_weight_and_preserves_default,
        test_zero_weight_from_legacy_workflow_is_neutral_not_invalid,
        test_legacy_bundle_weight_keeps_all_tags_deduplication,
        test_legacy_filter_switch_no_longer_deletes_natural_language,
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
        test_text_nodes_all_resolve_taxonomy_through_the_shared_helper,
        test_split_prompt_contract_is_implemented_once,
        test_ui_meta_is_the_single_source_for_the_panel,
        test_frontend_widget_fallback_tables_stay_in_sync_with_backend,
        test_removed_theme_filter_ignores_legacy_group_values,
        test_no_exclude_arguments_leaves_everything_untouched,
        test_custom_preset_roundtrip,
        test_custom_preset_rejects_builtin_and_blank_names,
        test_unknown_preset_name_is_still_a_noop,
        test_default_off_categories_are_disabled_and_reported,
    ]
    for test in tests:
        test()
    print(f"PASS: {len(tests)} Danbooru Tag Getter tests")
