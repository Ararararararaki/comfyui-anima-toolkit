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
                **category_switches,
            },
            "optional": {
                # 没有连接 D 站分类包时，节点仍可按自然语言排除规则处理普通 Prompt。
                "tag_bundle": ("TAG_BUNDLE",),
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
                "natural_language": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "forceInput": True,
                        "tooltip": "可选：接入普通 Prompt/自然语言；默认也会应用自然语言过滤。",
                    },
                ),
                "include_natural_language": ("BOOLEAN", {"default": True, "label_on": "保留", "label_off": "过滤掉"}),
                "filter_natural_language": ("BOOLEAN", {"default": True, "label_on": "过滤", "label_off": "不过滤"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("Tag String",)
    FUNCTION = "get_tags"
    CATEGORY = "TK/text"
    DESCRIPTION = "按分类和排除规则过滤标签；普通 Prompt/自然语言默认也应用排除规则"

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

    @staticmethod
    def _natural_language_tail(value, selected_tags):
        """兼容把整段 Prompt 接入原文口：去掉重复的前置标签，保留自然语言段落。"""
        raw = str(value or "").strip()
        if not raw or not selected_tags or "\n\n" not in raw:
            return raw
        prefix, tail = re.split(r"\n\s*\n", raw, maxsplit=1)
        prefix_parts = [part.strip() for part in prefix.split(",") if part.strip()]
        if len(prefix_parts) < 3:
            return raw
        selected = {tag.casefold() for tag in selected_tags}
        matched = sum(1 for part in prefix_parts if part.casefold() in selected)
        short_parts = sum(1 for part in prefix_parts if len(part.split()) <= 6)
        # 只有当空行前明显是逗号标签串时才剥离，普通自然语言段落保持原文。
        if matched >= 1 and short_parts / len(prefix_parts) >= 0.6 and tail.strip():
            return tail.strip()
        return raw

    @staticmethod
    def _remove_bundle_tags(value, bundle_tags):
        """从 ALL_TAGS/整段 Prompt 中移除 Packer 已识别的分类 Tag。"""
        raw = str(value or "").strip()
        known = {tag.casefold() for tag in bundle_tags if str(tag).strip()}
        if not raw or not known:
            return raw
        paragraphs = []
        for paragraph in re.split(r"\n\s*\n", raw):
            kept_lines = []
            for line in paragraph.splitlines() or [paragraph]:
                pieces = [piece.strip() for piece in line.split(",") if piece.strip()]
                kept = [piece for piece in pieces if piece.casefold() not in known]
                if kept:
                    kept_lines.append(", ".join(kept))
            if kept_lines:
                paragraphs.append("\n".join(kept_lines))
        return "\n\n".join(paragraphs)

    @staticmethod
    def _filter_natural_language(value, regex_pattern, exact_blacklist):
        """按排除规则过滤自然语言中的逗号片段，保留其余句子和段落。"""
        raw = str(value or "").strip()
        if not raw or (regex_pattern is None and not exact_blacklist):
            return raw
        paragraphs = []
        for paragraph in re.split(r"\n\s*\n", raw):
            kept_lines = []
            for line in paragraph.splitlines() or [paragraph]:
                pieces = [piece.strip() for piece in line.split(",") if piece.strip()]
                if not pieces:
                    continue
                kept = [
                    piece for piece in pieces
                    if piece.casefold() not in exact_blacklist
                    and (regex_pattern is None or not regex_pattern.search(piece))
                ]
                if kept:
                    kept_lines.append(", ".join(kept))
            if kept_lines:
                paragraphs.append("\n".join(kept_lines))
        return "\n\n".join(paragraphs)

    def get_tags(self, tag_bundle=None, regex_blacklist="", tag_blacklist="", natural_language="", include_natural_language=True, filter_natural_language=True, **category_flags):
        """按分类/排除规则提取标签，并按选项处理普通 Prompt/自然语言。"""
        regex_pattern = self._compile_regex(regex_blacklist)
        exact_blacklist = self._build_exact_blacklist(tag_blacklist)
        selected_tags = []
        bundle_tags = []
        if not isinstance(tag_bundle, dict):
            tag_text = ""
        else:
            result = []
            seen = set()
            for category in self.CATEGORY_NAMES:
                # 外部 Sorter 当前的真实结构是 dict[str, str]；缺失/空值直接跳过。
                category_value = tag_bundle.get(category)
                for tag in self._iter_category_tags(category_value) or ():
                    bundle_tags.append(tag)
                    if not category_flags.get(category, False):
                        continue
                    if tag.casefold() in exact_blacklist:
                        continue
                    if regex_pattern is not None and regex_pattern.search(tag):
                        continue
                    dedupe_key = tag.casefold()
                    if dedupe_key in seen:
                        continue
                    seen.add(dedupe_key)
                    result.append(tag)
            selected_tags = result
            tag_text = ", ".join(result)

        raw_natural_language = self._natural_language_tail(natural_language, selected_tags)
        raw_natural_language = self._remove_bundle_tags(raw_natural_language, bundle_tags)
        if filter_natural_language:
            raw_natural_language = self._filter_natural_language(raw_natural_language, regex_pattern, exact_blacklist)
        # 自然语言沿用外部 Sorter 的语义，归入“未归类词”；不额外制造第 13 类。
        # 当没有 TAG_BUNDLE 时，它就是节点唯一的数据源，不能因为旧工作流
        # 没有保存分类布尔值而被静默丢弃；有分类包时仍由“未归类词”控制。
        include_natural = include_natural_language and (
            category_flags.get("未归类词", False)
            or (not isinstance(tag_bundle, dict) and bool(raw_natural_language))
        )
        if include_natural and raw_natural_language:
            tag_text = f"{tag_text}\n\n{raw_natural_language}" if tag_text else raw_natural_language
        return (tag_text,)


NODE_CLASS_MAPPINGS = {
    AnimaTKDanbooruTagGetter.NODE_ID: AnimaTKDanbooruTagGetter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaTKDanbooruTagGetter.NODE_ID: AnimaTKDanbooruTagGetter.DISPLAY_NAME,
}
