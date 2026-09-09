"""TK Lighting Prompt - curated lighting presets for Anima Base workflows."""

import re


# The local Danbooru database confirms tags such as backlighting, sidelighting,
# high contrast, chiaroscuro, sunlight, moonlight, dim lighting and window light.
# The remaining lighting phrases below are intentionally limited to common Anima
# prompt vocabulary. In particular, soft lighting and soft shadows repeatedly
# occur in the project's Civitai Anima reference set even though they are not
# canonical tags in the current local Danbooru export.
LIGHTING_PRESETS = {
    "通用｜平衡柔光": {
        "tags": ("soft lighting", "soft shadows", "ambient lighting", "high contrast"),
        "scope": "universal",
        "note": "默认长期使用；柔和光影配合明确明暗分离，不限定环境或光源方向。",
    },
    "通用｜高对比柔光": {
        "tags": ("high contrast", "soft lighting", "soft shadows"),
        "scope": "universal",
        "note": "提高明暗反差，同时用柔光和柔影抑制刺眼强光与硬阴影。",
    },
    "通用｜柔和立体": {
        "tags": ("chiaroscuro", "soft lighting", "soft shadows"),
        "scope": "universal",
        "note": "用明暗塑形增强体积感，不指定时间、天气或具体光源。",
    },
    "通用｜低干预环境光": {
        "tags": ("ambient lighting", "soft lighting", "soft shadows"),
        "scope": "universal",
        "note": "最保守的图生图选项，侧重保留原图环境与主光关系。",
    },
    "室内｜明亮柔光": {
        "tags": ("indoor lighting", "ambient lighting", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "明亮室内的均匀柔光，不额外指定窗户或灯具。",
    },
    "室内｜暗色柔光": {
        "tags": ("dim lighting", "soft lighting", "soft shadows", "high contrast"),
        "scope": "scene",
        "note": "暗色室内保持层次，避免 harsh lighting 一类硬光词。",
    },
    "室内｜窗边柔光": {
        "tags": ("window light", "sidelighting", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "明确使用窗边侧光，适合靠窗人物和室内日光场景。",
    },
    "室内｜暖色环境光": {
        "tags": ("warm lighting", "ambient lighting", "soft shadows"),
        "scope": "scene",
        "note": "不绑定具体灯具的暖色室内环境光。",
    },
    "室内｜烛光低照度": {
        "tags": ("candlelight", "warm lighting", "dim lighting", "soft shadows"),
        "scope": "scene",
        "note": "明确烛光来源，适合低照度暖色场景。",
    },
    "人像｜棚拍柔光": {
        "tags": ("studio lighting", "soft lighting", "soft shadows", "rim lighting"),
        "scope": "scene",
        "note": "人物棚拍的柔和主光与轻轮廓分离。",
    },
    "室外｜白天自然光": {
        "tags": ("sunlight", "natural lighting", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "明确白天日光，柔化直射光与投影。",
    },
    "室外｜阴天柔光": {
        "tags": ("overcast", "ambient lighting", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "阴天漫射感，反差温和且光线方向不强。",
    },
    "室外｜斑驳日光": {
        "tags": ("dappled sunlight", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "树影、窗格等局部斑驳光，属于明确的专用光效。",
    },
    "时段｜黄昏暖光": {
        "tags": ("sunset", "warm lighting", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "明确黄昏时段与暖色光，不用于需要保留原时间的图生图。",
    },
    "夜景｜月光柔影": {
        "tags": ("moonlight", "dim lighting", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "明确月光夜景，保留低照度同时避免生硬阴影。",
    },
    "夜景｜城市柔光": {
        "tags": ("neon lights", "dim lighting", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "城市夜景专用；不加入 bloom、lens flare 或 light rays。",
    },
    "环境｜冷色柔光": {
        "tags": ("cold lighting", "ambient lighting", "soft lighting", "soft shadows"),
        "scope": "scene",
        "note": "冷色环境光，不强制月光、夜晚或霓虹灯。",
    },
    "方向｜柔和逆光": {
        "tags": ("backlighting", "soft lighting", "soft shadows"),
        "scope": "directional",
        "note": "明确逆光方向，但不叠加光束、镜头光晕或体积光。",
    },
    "方向｜柔和侧光": {
        "tags": ("sidelighting", "soft lighting", "soft shadows", "high contrast"),
        "scope": "directional",
        "note": "侧向塑形并保留柔影，适合强化面部和身体转折。",
    },
    "方向｜柔和顶光": {
        "tags": ("overhead lighting", "soft lighting", "soft shadows", "high contrast"),
        "scope": "directional",
        "note": "明确顶部光源，以柔光降低眼窝和鼻下硬阴影风险。",
    },
    "方向｜柔和轮廓光": {
        "tags": ("rim lighting", "soft lighting", "soft shadows"),
        "scope": "directional",
        "note": "用轮廓光分离人物与背景，不加入 glowing 或 bloom。",
    },
    "氛围｜柔和电影光": {
        "tags": ("cinematic lighting", "soft lighting", "soft shadows", "ambient lighting"),
        "scope": "mood",
        "note": "只使用电影式光照，不加入 cinematic style 等画风词。",
    },
    "氛围｜高级低调光": {
        "tags": ("dim lighting", "high contrast", "soft shadows"),
        "scope": "mood",
        "note": "低照度、高反差、柔和阴影，避免强光、硬阴影和过曝词。",
    },
}


class AnimaTKLightingPrompt:
    """Return one directly connectable, comma-terminated lighting tag string."""

    NODE_ID = "AnimaTKLightingPrompt"
    DISPLAY_NAME = "TK 光影提示词"
    CATEGORY = "TK/prompt"
    DEFAULT_PRESET = "通用｜平衡柔光"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preset": (list(LIGHTING_PRESETS), {"default": cls.DEFAULT_PRESET}),
                "enable_custom_tags": (
                    "BOOLEAN",
                    {"default": False, "label_on": "启用追加", "label_off": "不追加"},
                ),
                "custom_tags": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "placeholder": "可选：额外光影 tags，使用英文逗号或换行分隔",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("lighting_prompt",)
    FUNCTION = "build_prompt"
    DESCRIPTION = "为 Anima Base 输出可直接拼接的光影预设；默认通用平衡柔光，可选追加自定义光影 tags。"
    SEARCH_ALIASES = ["anima lighting", "lighting prompt", "光影", "灯光", "光照"]

    @staticmethod
    def _split_tags(value):
        if isinstance(value, (tuple, list)):
            parts = value
        else:
            parts = re.split(r"[,\r\n]+", str(value or ""))
        for part in parts:
            tag = str(part or "").strip().strip(",").strip()
            if tag:
                yield tag

    @classmethod
    def _format_tags(cls, *tag_sources):
        tags = []
        seen = set()
        for source in tag_sources:
            for tag in cls._split_tags(source):
                key = tag.casefold()
                if key in seen:
                    continue
                seen.add(key)
                tags.append(tag)
        return f"{', '.join(tags)}," if tags else ""

    def build_prompt(self, preset=DEFAULT_PRESET, enable_custom_tags=False, custom_tags=""):
        preset_data = LIGHTING_PRESETS.get(preset, LIGHTING_PRESETS[self.DEFAULT_PRESET])
        extras = custom_tags if enable_custom_tags else ""
        return (self._format_tags(preset_data["tags"], extras),)


NODE_CLASS_MAPPINGS = {
    AnimaTKLightingPrompt.NODE_ID: AnimaTKLightingPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaTKLightingPrompt.NODE_ID: AnimaTKLightingPrompt.DISPLAY_NAME,
}
