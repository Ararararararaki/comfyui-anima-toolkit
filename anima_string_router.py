"""TK String Router - route up to six STRING inputs into one STRING output."""

import json
import re


class AnimaStringRouter:
    """按节点内的单选/多选设置放行字符串输入。"""

    NAME = "TK String Router"
    CATEGORY = "TK/text"
    INPUT_COUNT = 6
    DEFAULT_SETTINGS = {
        "mode": "single",
        "enabled": [True, False, False, False, False, False],
        "selected": 0,
        "names": ["1", "2", "3", "4", "5", "6"],
    }
    SEPARATORS = {"逗号 ,": ", ", "空格": " ", "换行": "\n", "无": ""}

    @classmethod
    def INPUT_TYPES(cls):
        # optional + forceInput keeps all six ports available without forcing
        # users to connect every port before the node can be queued.
        optional = {
            f"string_{index}": (
                "STRING",
                {
                    "default": "",
                    "multiline": True,
                    "forceInput": True,
                    "placeholder": f"接口 {index}",
                },
            )
            for index in range(1, cls.INPUT_COUNT + 1)
        }
        return {
            "required": {
                "separator": (["逗号 ,", "空格", "换行", "无"], {"default": "逗号 ,"}),
            },
            "optional": optional,
            "hidden": {
                "router_settings": (
                    "STRING",
                    {"default": json.dumps(cls.DEFAULT_SETTINGS, ensure_ascii=False, separators=(",", ":"))},
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "route"
    DESCRIPTION = "6 路字符串单选/多选路由器：关闭的接口不会进入输出，可自定义接口名称"

    @classmethod
    def _defaults(cls):
        return {
            "mode": cls.DEFAULT_SETTINGS["mode"],
            "enabled": list(cls.DEFAULT_SETTINGS["enabled"]),
            "selected": cls.DEFAULT_SETTINGS["selected"],
            "names": list(cls.DEFAULT_SETTINGS["names"]),
        }

    @classmethod
    def _parse_settings(cls, raw):
        settings = cls._defaults()
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError, json.JSONDecodeError):
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}

        if parsed.get("mode") in {"single", "multi"}:
            settings["mode"] = parsed["mode"]
        enabled = parsed.get("enabled")
        if isinstance(enabled, list):
            settings["enabled"] = [cls._as_bool(enabled[i]) if i < len(enabled) else False for i in range(cls.INPUT_COUNT)]
        names = parsed.get("names")
        if isinstance(names, list):
            settings["names"] = [str(names[i]).strip() or str(i + 1) if i < len(names) else str(i + 1) for i in range(cls.INPUT_COUNT)]
        try:
            selected = int(parsed.get("selected", settings["selected"]))
        except (TypeError, ValueError):
            selected = settings["selected"]
        settings["selected"] = selected if 0 <= selected < cls.INPUT_COUNT else 0
        return settings

    @staticmethod
    def _as_bool(value):
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        return str(value).strip().lower() not in {"", "0", "false", "off", "no", "none"}

    def route(
        self,
        separator="逗号 ,",
        router_settings="",
        string_1="",
        string_2="",
        string_3="",
        string_4="",
        string_5="",
        string_6="",
    ):
        settings = self._parse_settings(router_settings)
        values = [string_1, string_2, string_3, string_4, string_5, string_6]
        if settings["mode"] == "single":
            selected = settings["selected"]
            parts = [values[selected]] if settings["enabled"][selected] else []
        else:
            parts = [value for value, enabled in zip(values, settings["enabled"]) if enabled]

        parts = [str(value).strip() for value in parts if str(value or "").strip()]
        result = self.SEPARATORS.get(separator, ", ").join(parts)
        if separator == "逗号 ,":
            result = re.sub(r"\s*,\s*,+", ",", result).strip(" ,")
        return (result,)


NODE_CLASS_MAPPINGS = {
    AnimaStringRouter.NAME: AnimaStringRouter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaStringRouter.NAME: "TK 字符串路由器",
}
