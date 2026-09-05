"""TK Clothing Draw node.

The clothing library itself lives in the browser's ``clothing-db`` IndexedDB
database.  The companion web widget serializes a small, portable snapshot of
the selected card (or the candidate pool) into ``selection_data``.  Keeping
the execution boundary as plain JSON means the Python node does not need a
second clothing database or a browser-specific dependency.
"""

from __future__ import annotations

import json
from typing import Any


NODE_NAME = "AnimaClothingDraw"
MAX_SNAPSHOT_CARDS = 20000


def _text(value: Any) -> str:
    return str(value or "").strip()


def _card_snapshot(value: Any) -> dict[str, Any] | None:
    """Return the small card shape accepted from the browser widget."""
    if not isinstance(value, dict):
        return None
    prompt = _text(value.get("prompt"))
    if not prompt:
        return None
    card_id = _text(value.get("id"))
    name = _text(value.get("name")) or prompt[:20]
    category_id = _text(value.get("categoryId"))
    category_name = _text(value.get("categoryName")) or "未分类"
    image_url = _text(value.get("imageUrl"))
    result: dict[str, Any] = {
        "id": card_id or None,
        "name": name,
        "prompt": prompt,
        "category_id": category_id or None,
        "category": category_name,
        "has_image": bool(value.get("hasImage") or image_url),
    }
    # imageUrl is metadata only; imageBlob must never be serialized into the
    # workflow and is deliberately not accepted here.
    if image_url:
        result["image_url"] = image_url
    return result


def _parse_payload(raw: Any) -> dict[str, Any]:
    try:
        payload = json.loads(raw or "{}")
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("TK 服装抽卡：服装库快照不是有效 JSON，请在节点中点击「刷新服装库」") from exc
    if not isinstance(payload, dict):
        raise ValueError("TK 服装抽卡：服装库快照格式错误")
    return payload


def _stable_index(seed: int, length: int) -> int:
    """Small unsigned hash shared with the browser preview implementation."""
    value = ((int(seed) & 0xFFFFFFFF) ^ 0x9E3779B9) & 0xFFFFFFFF
    value = (((value ^ (value >> 16)) * 0x45D9F3B) & 0xFFFFFFFF)
    value = (((value ^ (value >> 16)) * 0x45D9F3B) & 0xFFFFFFFF)
    value = (value ^ (value >> 16)) & 0xFFFFFFFF
    return value % length


class AnimaClothingDraw:
    """Draw one clothing card from the local TK Toolkit clothing library."""

    NAME = NODE_NAME
    CATEGORY = "TK/prompt"
    # Emit a small UI payload so the ComfyUI frontend can reflect the card
    # actually selected during execution (including seed randomization).
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("服装提示词", "服装名称", "服装分类", "服装数据")
    FUNCTION = "draw"
    DESCRIPTION = (
        "从 TK Toolkit 本地服装库随机抽取或手动选择一套服装。"
        "图片在节点选择器中预览，节点输出名称、分类、提示词和结构化数据。"
    )
    SEARCH_ALIASES = [
        "TK clothing draw",
        "clothing gacha",
        "outfit random",
        "服装抽卡",
        "服装选择",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["随机抽取", "手动选择"], {"default": "随机抽取", "label": "选择模式"}),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 2**63 - 1,
                        "step": 1,
                        "label": "抽卡种子",
                        "tooltip": "随机抽取使用的稳定种子；点击节点中的「随机抽取」会自动更换种子。",
                    },
                ),
            },
            "hidden": {
                "selection_data": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, mode="随机抽取", seed=0, selection_data="{}", **kwargs):
        # The snapshot contains the selected card/candidate pool.  Include it
        # in the cache key so a manual selection or library refresh reruns the
        # node even when the visible seed did not change.
        return json.dumps(
            {"mode": str(mode), "seed": int(seed), "selection_data": str(selection_data or "{}")},
            ensure_ascii=False,
            sort_keys=True,
        )

    @staticmethod
    def _choose_random(cards: list[dict[str, Any]], seed: int) -> dict[str, Any]:
        # Sort by id for a stable result regardless of IndexedDB cursor order.
        ordered = sorted(cards, key=lambda card: (_text(card.get("id")), _text(card.get("name"))))
        return ordered[_stable_index(seed, len(ordered))]

    def draw(self, mode="随机抽取", seed=0, selection_data="{}", **kwargs):
        payload = _parse_payload(selection_data)
        payload_mode = _text(payload.get("mode"))
        effective_mode = payload_mode if payload_mode in {"随机抽取", "手动选择"} else _text(mode) or "随机抽取"
        if effective_mode not in {"随机抽取", "手动选择"}:
            effective_mode = "随机抽取"

        selected: dict[str, Any] | None = None
        if effective_mode == "手动选择":
            selected = _card_snapshot(payload.get("selected"))
            if selected is None:
                raise ValueError("TK 服装抽卡：尚未选择服装，请点击「选择服装」")
        else:
            raw_cards = payload.get("pool", [])
            if not isinstance(raw_cards, list):
                raw_cards = []
            if len(raw_cards) > MAX_SNAPSHOT_CARDS:
                raw_cards = raw_cards[:MAX_SNAPSHOT_CARDS]
            cards = [card for value in raw_cards if (card := _card_snapshot(value)) is not None]
            if not cards:
                # A resolved selection is kept as a safe fallback when a
                # workflow was saved before the pool snapshot was refreshed.
                selected = _card_snapshot(payload.get("selected"))
            else:
                selected = self._choose_random(cards, int(seed))
            if selected is None:
                category = _text(payload.get("categoryName")) or "当前分类"
                raise ValueError(f"TK 服装抽卡：{category}中没有可用的服装卡片，请先刷新服装库")

        result = {
            "version": 1,
            "mode": effective_mode,
            "seed": int(seed),
            "id": selected.get("id"),
            "name": selected["name"],
            "prompt": selected["prompt"],
        "category_id": selected.get("category_id"),
        "category": selected["category"],
        "has_image": bool(selected.get("has_image")),
    }
        if selected.get("image_url"):
            result["image_url"] = selected["image_url"]
        result_json = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        return {
            "ui": {"clothing_draw": [result]},
            "result": (
                selected["prompt"],
                selected["name"],
                selected["category"],
                result_json,
            ),
        }


NODE_CLASS_MAPPINGS = {
    NODE_NAME: AnimaClothingDraw,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_NAME: "TK 服装抽卡",
}
