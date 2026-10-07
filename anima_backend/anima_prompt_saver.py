"""TK Prompt Saver - route prompts and auto-save them with optional previews."""

import base64
from io import BytesIO
import json


class AnimaTKPromptSaver:
    """执行节点时返回选中提示词记录，由前端写入共享 Prompt 库。"""

    NODE_ID = "AnimaTKPromptSaver"
    DISPLAY_NAME = "TK Prompt Saver"
    CATEGORY = "TK/prompt"
    INPUT_COUNT = 6
    DEFAULT_SETTINGS = {
        "mode": "single",
        "enabled": [True, False, False, False, False, False],
        "selected": 0,
        "names": ["提示词 1", "提示词 2", "提示词 3", "提示词 4", "提示词 5", "提示词 6"],
    }
    SEPARATORS = {"逗号 ,": ", ", "换行": "\n", "空格": " ", "无": ""}

    @classmethod
    def INPUT_TYPES(cls):
        prompt_inputs = {}
        for index in range(1, cls.INPUT_COUNT + 1):
            prompt_inputs[f"prompt_{index}"] = (
                "STRING",
                {
                    "default": "",
                    "multiline": True,
                    "forceInput": True,
                    "placeholder": f"提示词 {index}",
                },
            )
            prompt_inputs[f"image_{index}"] = ("IMAGE",)
        return {
            "required": {
                "separator": (["逗号 ,", "换行", "空格", "无"], {"default": "逗号 ,"}),
            },
            "optional": prompt_inputs,
            "hidden": {
                "router_settings": (
                    "STRING",
                    {"default": json.dumps(cls.DEFAULT_SETTINGS, ensure_ascii=False, separators=(",", ":"))},
                ),
                "prompt_category": ("STRING", {"default": "uncategorized"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "save_prompts"
    CATEGORY = "TK/prompt"
    OUTPUT_NODE = True
    DESCRIPTION = "多路提示词单选/多选，节点执行时自动保存到 TK Toolkit Prompt 库，可带对应预览图"

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
            settings["enabled"] = [bool(enabled[index]) if index < len(enabled) else False for index in range(cls.INPUT_COUNT)]
        names = parsed.get("names")
        if isinstance(names, list):
            settings["names"] = [
                str(names[index]).strip() or f"提示词 {index + 1}" if index < len(names) else f"提示词 {index + 1}"
                for index in range(cls.INPUT_COUNT)
            ]
        try:
            selected = int(parsed.get("selected", settings["selected"]))
        except (TypeError, ValueError):
            selected = settings["selected"]
        settings["selected"] = selected if 0 <= selected < cls.INPUT_COUNT else 0
        return settings

    @staticmethod
    def _clean_prompt(value):
        return str(value or "").strip()

    @staticmethod
    def _image_to_data_url(image):
        """把 ComfyUI IMAGE 的第一帧压成 Prompt 库可直接显示的 JPEG data URL。"""
        if image is None:
            return ""
        try:
            from PIL import Image

            tensor = image.detach().cpu() if hasattr(image, "detach") else image
            if hasattr(tensor, "ndim") and tensor.ndim == 4:
                tensor = tensor[0]
            if not hasattr(tensor, "ndim") or tensor.ndim != 3:
                return ""
            array = tensor.clamp(0, 1).mul(255).byte().numpy()
            channels = array.shape[-1]
            if channels == 1:
                picture = Image.fromarray(array[:, :, 0], "L").convert("RGB")
            elif channels == 4:
                picture = Image.fromarray(array, "RGBA").convert("RGB")
            elif channels == 3:
                picture = Image.fromarray(array, "RGB")
            else:
                return ""
            resampling = getattr(Image, "Resampling", Image)
            picture.thumbnail((384, 384), resampling.LANCZOS)
            output = BytesIO()
            picture.save(output, format="JPEG", quality=80, optimize=True)
            encoded = base64.b64encode(output.getvalue()).decode("ascii")
            return f"data:image/jpeg;base64,{encoded}"
        except Exception as error:
            print(f"[TK Prompt Saver] 预览图编码失败，继续保存无图 Prompt：{error}")
            return ""

    def save_prompts(
        self,
        separator="逗号 ,",
        router_settings="",
        prompt_category="uncategorized",
        **prompt_values,
    ):
        """返回路由结果和待写入 Prompt 库的记录，不在 Python 侧写浏览器数据库。"""
        settings = self._parse_settings(router_settings)
        values = [prompt_values.get(f"prompt_{index}", "") for index in range(1, self.INPUT_COUNT + 1)]
        images = [prompt_values.get(f"image_{index}") for index in range(1, self.INPUT_COUNT + 1)]
        if settings["mode"] == "single":
            selected = settings["selected"]
            selected_indexes = [selected] if settings["enabled"][selected] else []
        else:
            selected_indexes = [index for index, enabled in enumerate(settings["enabled"]) if enabled]

        records = []
        parts = []
        category_id = self._clean_prompt(prompt_category) or "uncategorized"
        for index in selected_indexes:
            prompt = self._clean_prompt(values[index])
            if not prompt:
                continue
            name = settings["names"][index] or f"提示词 {index + 1}"
            parts.append(prompt)
            records.append(
                {
                    "prompt": prompt,
                    "displayText": name,
                    "categoryId": category_id,
                    "sourceInput": f"prompt_{index + 1}",
                    "previewImage": self._image_to_data_url(images[index]),
                }
            )

        result = self.SEPARATORS.get(separator, ", ").join(parts)
        return {"ui": {"prompt_saver": records}, "result": (result,)}


NODE_CLASS_MAPPINGS = {
    AnimaTKPromptSaver.NODE_ID: AnimaTKPromptSaver,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaTKPromptSaver.NODE_ID: AnimaTKPromptSaver.DISPLAY_NAME,
}
