"""TK Danbooru Tag Getter - extract, filter and merge TAG_BUNDLE categories."""

import re


class AnimaTKDanbooruTagGetter:
    """从 Danbooru Tag Sorter 的 TAG_BUNDLE 中按固定顺序提取多个分类。"""

    NODE_ID = "AnimaTKDanbooruTagGetter"
    DISPLAY_NAME = "TK Danbooru Tag Getter"
    CATEGORY = "TK/text"

    # 顺序必须与 ComfyUI-Danbooru-Tag-Sorter-Node 的默认分类顺序保持一致。
    CATEGORY_NAMES = (
        "画师词",
        "背景词",
        "人物对象词",
        "角色特征词",
        "角色五官词",
        "角色部位词",
        "性征部位词",
        "服饰词",
        "动作词",
        "角色表情词",
        "镜头词",
        "未归类词",
    )
    FILTER_INPUTS = ("regex_blacklist", "tag_blacklist")

    @classmethod
    def INPUT_TYPES(cls):
        # 使用分类名作为 BOOLEAN 输入名，让 ComfyUI 原生控件直接显示中文分类。
        # 这些开关会随工作流保存，不需要额外的前端 widget 或隐藏状态。
        category_switches = {
            category: ("BOOLEAN", {"default": False, "label_on": "选中", "label_off": "未选"})
            for category in cls.CATEGORY_NAMES
        }
        return {
            "required": {
                "tag_bundle": ("TAG_BUNDLE",),
                **category_switches,
            },
            "optional": {
                "regex_blacklist": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": "正则排除，例如：censor|watermark",
                    },
                ),
                "tag_blacklist": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "placeholder": "精准排除，逗号或换行分隔，例如：speech_bubble",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("Tag String",)
    FUNCTION = "get_tags"
    CATEGORY = "TK/text"
    DESCRIPTION = "从 TAG_BUNDLE 多选分类，按正则或精准排除后合并为 Tag String"

    @staticmethod
    def _compile_regex(regex_blacklist):
        expression = str(regex_blacklist or "").strip()
        if not expression:
            return None
        try:
            return re.compile(expression, re.IGNORECASE)
        except re.error as error:
            # 与外部 Packer 一致：正则写错时跳过正则，不阻断整个节点执行。
            print(f"[TK Danbooru Tag Getter] 正则排除无效，已跳过：{error}")
            return None

    @staticmethod
    def _build_exact_blacklist(tag_blacklist):
        """支持外部节点的逗号格式，同时允许在节点面板中每行填写一个 Tag。"""
        return {
            tag.strip().casefold()
            for tag in re.split(r"[,\r\n]+", str(tag_blacklist or ""))
            if tag.strip()
        }

    @staticmethod
    def _iter_category_tags(category_value):
        """读取外部 Getter 使用的字符串分类值，并跳过空片段。"""
        if not isinstance(category_value, str):
            return
        for raw_tag in category_value.split(","):
            tag = raw_tag.strip()
            if tag:
                yield tag

    def get_tags(self, tag_bundle, regex_blacklist="", tag_blacklist="", **category_flags):
        """提取、筛选选中的分类；不修改 TAG_BUNDLE，返回干净的逗号分隔字符串。"""
        if not isinstance(tag_bundle, dict):
            return ("",)

        regex_pattern = self._compile_regex(regex_blacklist)
        exact_blacklist = self._build_exact_blacklist(tag_blacklist)
        result = []
        seen = set()
        for category in self.CATEGORY_NAMES:
            if not category_flags.get(category, False):
                continue
            # 外部 Sorter 当前的真实结构是 dict[str, str]；缺失/空值直接跳过。
            category_value = tag_bundle.get(category)
            for tag in self._iter_category_tags(category_value) or ():
                if tag.casefold() in exact_blacklist:
                    continue
                if regex_pattern is not None and regex_pattern.search(tag):
                    continue
                dedupe_key = tag.casefold()
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)
                result.append(tag)

        return (", ".join(result),)


NODE_CLASS_MAPPINGS = {
    AnimaTKDanbooruTagGetter.NODE_ID: AnimaTKDanbooruTagGetter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaTKDanbooruTagGetter.NODE_ID: AnimaTKDanbooruTagGetter.DISPLAY_NAME,
}

