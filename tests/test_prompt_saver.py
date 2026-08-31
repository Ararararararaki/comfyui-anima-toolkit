"""TK Prompt Saver 的自动保存回传数据测试。"""

import json
import sys
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from anima_prompt_saver import AnimaTKPromptSaver  # noqa: E402


def make_settings(**overrides):
    settings = AnimaTKPromptSaver._defaults()
    settings.update(overrides)
    return json.dumps(settings, ensure_ascii=False)


def test_schema_exposes_six_prompt_inputs_and_output_node():
    schema = AnimaTKPromptSaver.INPUT_TYPES()
    assert list(schema["optional"]) == [name for index in range(1, 7) for name in (f"prompt_{index}", f"image_{index}")]
    assert all(schema["optional"][f"image_{index}"][0] == "IMAGE" for index in range(1, 7))
    assert schema["hidden"]["prompt_category"][0] == "STRING"
    assert AnimaTKPromptSaver.OUTPUT_NODE is True
    assert AnimaTKPromptSaver.RETURN_NAMES == ("prompt",)


def test_single_mode_outputs_and_records_only_selected_prompt():
    output = AnimaTKPromptSaver().save_prompts(
        router_settings=make_settings(enabled=[True, False, True, False, False, False], selected=2),
        prompt_category="cat_style",
        prompt_1="ignored",
        prompt_3="selected prompt",
    )
    assert output["result"] == ("selected prompt",)
    assert [record["prompt"] for record in output["ui"]["prompt_saver"]] == ["selected prompt"]
    assert output["ui"]["prompt_saver"][0]["categoryId"] == "cat_style"


def test_multi_mode_records_each_enabled_prompt_in_order():
    output = AnimaTKPromptSaver().save_prompts(
        separator="换行",
        router_settings=make_settings(mode="multi", enabled=[True, False, True, True, False, False], names=["主提示", "2", "补充", "负面"]),
        prompt_category="uncategorized",
        prompt_1="first",
        prompt_3="third",
        prompt_4="fourth",
    )
    assert output["result"] == ("first\nthird\nfourth",)
    assert [record["displayText"] for record in output["ui"]["prompt_saver"]] == ["主提示", "补充", "负面"]
    assert [record["sourceInput"] for record in output["ui"]["prompt_saver"]] == ["prompt_1", "prompt_3", "prompt_4"]


def test_disabled_and_empty_prompts_are_not_saved():
    output = AnimaTKPromptSaver().save_prompts(
        router_settings=make_settings(mode="multi", enabled=[True, True, True, False, False, False]),
        prompt_1="first",
        prompt_2="   ",
        prompt_3="third",
    )
    assert [record["prompt"] for record in output["ui"]["prompt_saver"]] == ["first", "third"]


def test_no_enabled_prompt_returns_empty_save_payload():
    output = AnimaTKPromptSaver().save_prompts(
        router_settings=make_settings(enabled=[False, False, False, False, False, False]),
        prompt_1="should not save",
    )
    assert output["result"] == ("",)
    assert output["ui"]["prompt_saver"] == []


def test_each_prompt_record_gets_its_matching_preview_image():
    node = AnimaTKPromptSaver()
    with patch.object(node, "_image_to_data_url", side_effect=lambda image: f"preview:{image}"):
        output = node.save_prompts(
            router_settings=make_settings(mode="multi", enabled=[True, False, True, False, False, False]),
            prompt_1="first",
            prompt_3="third",
            image_1="image-one",
            image_3="image-three",
        )
    records = output["ui"]["prompt_saver"]
    assert [record["previewImage"] for record in records] == ["preview:image-one", "preview:image-three"]


def test_missing_values_and_malformed_settings_are_safe():
    node = AnimaTKPromptSaver()
    assert node.save_prompts(router_settings="not-json", prompt_1="safe")["result"] == ("safe",)
    assert node.save_prompts(prompt_category="", prompt_1="safe")["ui"]["prompt_saver"][0]["categoryId"] == "uncategorized"


if __name__ == "__main__":
    tests = [
        test_schema_exposes_six_prompt_inputs_and_output_node,
        test_single_mode_outputs_and_records_only_selected_prompt,
        test_multi_mode_records_each_enabled_prompt_in_order,
        test_disabled_and_empty_prompts_are_not_saved,
        test_no_enabled_prompt_returns_empty_save_payload,
        test_each_prompt_record_gets_its_matching_preview_image,
        test_missing_values_and_malformed_settings_are_safe,
    ]
    for test in tests:
        test()
    print(f"PASS: {len(tests)} Prompt Saver tests")
