"""TK String Router 的纯 Python 行为测试。"""

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from anima_string_router import AnimaStringRouter  # noqa: E402


def settings(**overrides):
    value = AnimaStringRouter._defaults()
    value.update(overrides)
    return json.dumps(value, ensure_ascii=False)


def test_single_only_routes_selected_enabled_input():
    node = AnimaStringRouter()
    result = node.route(
        separator="逗号 ,",
        router_settings=settings(enabled=[False, True, True, False, False, False], selected=1),
        string_1="should be ignored",
        string_2="second",
        string_3="third",
    )
    assert result == ("second",)


def test_single_disabled_selected_input_outputs_nothing():
    node = AnimaStringRouter()
    result = node.route(
        router_settings=settings(enabled=[True, False, False, False, False, False], selected=1),
        string_1="first",
        string_2="closed",
    )
    assert result == ("",)


def test_multi_routes_enabled_inputs_in_socket_order():
    node = AnimaStringRouter()
    result = node.route(
        separator="逗号 ,",
        router_settings=settings(mode="multi", enabled=[True, False, True, True, False, True]),
        string_1=" first ",
        string_2="closed",
        string_3="third",
        string_4="",
        string_6="sixth",
    )
    assert result == ("first, third, sixth",)


def test_custom_names_do_not_change_routing_contract():
    node = AnimaStringRouter()
    result = node.route(
        separator="换行",
        router_settings=settings(mode="multi", enabled=[False, True, False, False, False, False], names=["标题", "正文"]),
        string_2="正文内容",
    )
    assert result == ("正文内容",)


def test_malformed_settings_fall_back_safely():
    node = AnimaStringRouter()
    assert node.route(router_settings="not-json", string_1="safe") == ("safe",)


if __name__ == "__main__":
    tests = [
        test_single_only_routes_selected_enabled_input,
        test_single_disabled_selected_input_outputs_nothing,
        test_multi_routes_enabled_inputs_in_socket_order,
        test_custom_names_do_not_change_routing_contract,
        test_malformed_settings_fall_back_safely,
    ]
    for test in tests:
        test()
    print(f"PASS: {len(tests)} string router tests")
