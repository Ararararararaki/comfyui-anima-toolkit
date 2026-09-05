import json

import pytest

from anima_clothing_draw import AnimaClothingDraw, _stable_index


def card(card_id, name, prompt, category_id="cat_a", category_name="裙装"):
    return {
        "id": card_id,
        "name": name,
        "prompt": prompt,
        "categoryId": category_id,
        "categoryName": category_name,
        "imageUrl": "https://example.test/outfit.jpg",
    }


def test_manual_selection_outputs_prompt_name_category_and_metadata():
    payload = {
        "version": 1,
        "mode": "手动选择",
        "categoryName": "裙装",
        "selected": card("dress-1", "黑色礼裙", "black dress, gloves"),
    }

    output = AnimaClothingDraw().draw("手动选择", 0, json.dumps(payload, ensure_ascii=False))
    result = output["result"]

    assert result[:3] == ("black dress, gloves", "黑色礼裙", "裙装")
    metadata = json.loads(result[3])
    assert metadata["id"] == "dress-1"
    assert metadata["mode"] == "手动选择"
    assert metadata["image_url"] == "https://example.test/outfit.jpg"
    assert metadata["has_image"] is True
    assert output["ui"]["clothing_draw"][0]["name"] == "黑色礼裙"


def test_random_selection_is_stable_and_ignores_browser_order():
    cards = [
        card("dress-2", "蓝裙", "blue dress"),
        card("dress-1", "黑裙", "black dress"),
    ]
    first = AnimaClothingDraw().draw(
        "随机抽取", 123, json.dumps({"mode": "随机抽取", "pool": cards})
    )
    second = AnimaClothingDraw().draw(
        "随机抽取", 123, json.dumps({"mode": "随机抽取", "pool": list(reversed(cards))})
    )

    assert first == second
    assert first["result"][1] in {"黑裙", "蓝裙"}
    assert 0 <= _stable_index(123, 2) < 2


def test_empty_pool_has_actionable_error():
    with pytest.raises(ValueError, match="没有可用的服装卡片"):
        AnimaClothingDraw().draw(
            "随机抽取", 0, json.dumps({"mode": "随机抽取", "categoryName": "泳装", "pool": []})
        )


def test_missing_manual_card_has_actionable_error():
    with pytest.raises(ValueError, match="尚未选择服装"):
        AnimaClothingDraw().draw("手动选择", 0, json.dumps({"mode": "手动选择"}))
