"""TK 光影提示词节点的预设、格式与注册测试。"""

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from anima_lighting_prompt import (  # noqa: E402
    LIGHTING_PRESETS,
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    AnimaTKLightingPrompt,
)


FORBIDDEN_NON_LIGHTING_TAGS = {
    "masterpiece",
    "best quality",
    "cinematic style",
    "photorealistic",
    "realistic skin",
    "8k",
    "ultra detailed",
}
UNIVERSAL_FORBIDDEN_TAGS = {
    "sunset",
    "sunlight",
    "moonlight",
    "neon lights",
    "window light",
    "light rays",
    "lens flare",
    "volumetric lighting",
    "backlighting",
    "sidelighting",
    "overhead lighting",
    "rim lighting",
    "candlelight",
    "overcast",
}
HIGH_RISK_EFFECT_TAGS = {
    "dramatic lighting",
    "harsh lighting",
    "strong lighting",
    "lens flare",
    "light rays",
    "volumetric lighting",
    "glowing",
    "bloom",
}


def test_schema_is_one_combined_preset_dropdown_with_simple_advanced_options():
    required = AnimaTKLightingPrompt.INPUT_TYPES()["required"]
    assert list(required) == ["preset", "enable_custom_tags", "custom_tags"]
    assert required["preset"][0] == list(LIGHTING_PRESETS)
    assert required["preset"][1]["default"] == "通用｜平衡柔光"
    assert required["enable_custom_tags"][0] == "BOOLEAN"
    assert required["custom_tags"][0] == "STRING"


def test_four_universal_presets_are_environment_agnostic():
    universal = [data for data in LIGHTING_PRESETS.values() if data["scope"] == "universal"]
    assert len(universal) == 4
    for data in universal:
        assert set(data["tags"]).isdisjoint(UNIVERSAL_FORBIDDEN_TAGS)


def test_default_is_soft_but_has_visible_contrast():
    tags = set(LIGHTING_PRESETS[AnimaTKLightingPrompt.DEFAULT_PRESET]["tags"])
    assert {"soft lighting", "soft shadows", "ambient lighting", "high contrast"} <= tags


def test_every_preset_is_distinct_and_contains_only_unique_tags():
    signatures = []
    for name, data in LIGHTING_PRESETS.items():
        tags = data["tags"]
        assert tags, name
        assert len(tags) == len({tag.casefold() for tag in tags}), name
        signatures.append(tuple(tag.casefold() for tag in tags))
    assert len(signatures) == len(set(signatures))


def test_presets_exclude_quality_style_and_high_risk_effect_tags():
    for name, data in LIGHTING_PRESETS.items():
        tags = {tag.casefold() for tag in data["tags"]}
        assert tags.isdisjoint(FORBIDDEN_NON_LIGHTING_TAGS), name
        assert tags.isdisjoint(HIGH_RISK_EFFECT_TAGS), name


def test_every_preset_outputs_normalized_english_comma_format():
    node = AnimaTKLightingPrompt()
    for preset in LIGHTING_PRESETS:
        output = node.build_prompt(preset)[0]
        assert output.endswith(","), preset
        assert not output.endswith(",,"), preset
        assert "，" not in output, preset
        assert "\n" not in output, preset
        assert preset not in output


def test_custom_tags_are_optional_normalized_and_deduplicated():
    node = AnimaTKLightingPrompt()
    base = node.build_prompt("通用｜平衡柔光", False, "rim lighting")[0]
    assert "rim lighting" not in base

    extended = node.build_prompt(
        "通用｜平衡柔光",
        True,
        "rim lighting, Soft Shadows,\nfill light,,",
    )[0]
    assert extended == (
        "soft lighting, soft shadows, ambient lighting, high contrast, rim lighting, fill light,"
    )


def test_unknown_preset_falls_back_to_safe_default():
    node = AnimaTKLightingPrompt()
    assert node.build_prompt("旧工作流里不存在的预设") == node.build_prompt(node.DEFAULT_PRESET)


def test_node_registration_and_output_contract():
    assert NODE_CLASS_MAPPINGS == {"AnimaTKLightingPrompt": AnimaTKLightingPrompt}
    assert NODE_DISPLAY_NAME_MAPPINGS == {"AnimaTKLightingPrompt": "TK 光影提示词"}
    assert AnimaTKLightingPrompt.RETURN_TYPES == ("STRING",)
    assert AnimaTKLightingPrompt.RETURN_NAMES == ("lighting_prompt",)
    assert AnimaTKLightingPrompt.CATEGORY == "TK/prompt"


if __name__ == "__main__":
    tests = [
        test_schema_is_one_combined_preset_dropdown_with_simple_advanced_options,
        test_four_universal_presets_are_environment_agnostic,
        test_default_is_soft_but_has_visible_contrast,
        test_every_preset_is_distinct_and_contains_only_unique_tags,
        test_presets_exclude_quality_style_and_high_risk_effect_tags,
        test_every_preset_outputs_normalized_english_comma_format,
        test_custom_tags_are_optional_normalized_and_deduplicated,
        test_unknown_preset_falls_back_to_safe_default,
        test_node_registration_and_output_contract,
    ]
    for test in tests:
        test()
    print(f"PASS: {len(tests)} Lighting Prompt tests")
