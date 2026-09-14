"""TK Anima 格式化 — 把任意标签串规范成 Anima 底模要求的提示词形态。

## 为什么需要这一层

Anima 官方 model card（huggingface.co/circlestone-labs/Anima）给出的格式契约：

  * **Tag order**：``[quality/meta/year/safety] [1girl/1boy/1other] [character]
    [series] [artist] [general tags]`` —— 段内任意序，段间有固定顺序；
  * **artist 必须加 `@` 前缀**："You **must** put @ in front of the artist.
    The effect will be **very weak** if you don't."；
  * 官方所有示例都是**空格形式**（``@big chungus`` / ``jpeg artifacts`` / ``year 2025``），
    不是 Danbooru 的下划线形式。

而实际上游产出的是混合形态 —— 例如 WD14 Tagger 在 ``replace_underscore=False``
（其**默认值**）时输出 ``plana_\\(blue_archive\\), long_hair``：转义了括号但没转空格。
括号必须转义（ComfyUI 会把 ``(blue archive)`` 当 attention 权重语法解析），
下划线必须转空格（Anima 训练形态）—— 两者都要做，缺一不可。

## 与其它链路的一致性

本项目 TK Prompt Cards 的中文输入联想产出的是 ``kisaki \\(blue archive\\),``
（空格 + 转义括号）。本节点让反推链路与它保持一致，避免同一份工作流里两种形态混用。

## 长度闸门

社区实测（Diffusion Doodles 对 Anima 的评测）：过长提示词会**降低** adherence 与质量，
最佳区间约 2–3 段、15 行以内；官方也说明训练时用了随机 tag dropout，
"You don't need to include every single relevant tag"。所以裁剪是特性而非妥协。
"""

import re

try:
    from .anima_tag_taxonomy import (
        WEIGHT_RE,
        category_of,
        normalise,
        normalise_spaces,
        split_prompt,
        taxonomy_for,
    )
except ImportError:  # 允许脱离包直接导入（单测）
    from anima_tag_taxonomy import (
        WEIGHT_RE,
        category_of,
        normalise,
        normalise_spaces,
        split_prompt,
        taxonomy_for,
    )


# 已经带 @ 的 artist
_AT_PREFIX_RE = re.compile(r"^@+\s*(.+)$")


# 已经带 @ 的 artist
_AT_PREFIX_RE = re.compile(r"^@+\s*(.+)$")


class AnimaTKAnimaFormatter:
    """把标签串规范成 Anima 形态：空格 / 转义括号 / @artist / 区段重排 / 长度闸门。"""

    NODE_ID = "AnimaTKAnimaFormatter"
    DISPLAY_NAME = "TK Anima 格式化"
    CATEGORY = "TK/prompt"

    # Anima 官方区段顺序在本项目的分类体系里的对应关系。
    # 未列出的分类（服装/动作/表情/镜头/背景/物件/光照类等）统一归入 general 段。
    SECTION_ORDER = (
        "质量元词",        # quality / meta / year / safety
        "人物对象词",      # 1girl / 1boy / solo …
        "角色身份词",      # character
        "作品版权词",      # series
        "画师词",          # artist
    )
    # general 段的内部顺序：沿用分类体系顺序，保证结果稳定可复现
    GENERAL_ORDER = (
        "发色发型词", "亚人特征词", "角色特征词", "角色五官词", "角色部位词",
        "性征部位词", "服饰词", "动作词", "角色表情词", "镜头词", "背景词",
        "物件道具词", "审查遮挡词", "文字水印词", "未归类词",
    )
    MAX_TAGS_CHOICES = ("不限制", "20", "30", "40", "60", "80", "120")
    MAX_LINES_CHOICES = ("不限制", "6", "8", "10", "15", "20")
    # 自然语言的标点处理。Anima 提示词整体是逗号连接的标签串形态，
    # 而语言模型写出来的自然语言天然以句号断句 —— 直接拼进提示词会出现
    # "…… a window. Soft light ……" 这种句号，破坏逗号一致性。
    NATURAL_SEPARATOR_CHOICES = ("句号转逗号", "去掉句号", "保留句号")
    # ⚠️ 选项元组必须以 "" 开头：旧工作流没有这些控件，ComfyUI 会用空字符串补足
    # 缺失的 widgets_values，而 COMBO 的校验要求值落在列表内，'' 不在就会让节点
    # 直接报 "部分输入值不适用于该节点"。这个坑在 TK Danbooru Tag Getter 上踩过两次。
    MAX_TAGS_OPTIONS = ("",) + MAX_TAGS_CHOICES
    MAX_LINES_OPTIONS = ("",) + MAX_LINES_CHOICES
    NATURAL_SEPARATOR_OPTIONS = ("",) + NATURAL_SEPARATOR_CHOICES

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "forceInput": True,
                        "tooltip": "任意来源的标签串（WD14 / 过滤后的标签 / 手写）",
                    },
                ),
            },
            "optional": {
                "to_spaces": (
                    "BOOLEAN",
                    {"default": True, "label_on": "转空格", "label_off": "保留下划线"},
                ),
                "escape_brackets": (
                    "BOOLEAN",
                    {"default": True, "label_on": "转义括号", "label_off": "不转义"},
                ),
                "at_artist": (
                    "BOOLEAN",
                    {"default": True, "label_on": "加 @", "label_off": "不加"},
                ),
                "reorder_sections": (
                    "BOOLEAN",
                    {"default": True, "label_on": "按 Anima 区段重排", "label_off": "保持原序"},
                ),
                "dedupe": (
                    "BOOLEAN",
                    {"default": True, "label_on": "去重", "label_off": "不去重"},
                ),
                "max_tags": (list(cls.MAX_TAGS_OPTIONS), {"default": "不限制"}),
                "max_lines": (list(cls.MAX_LINES_OPTIONS), {"default": "不限制"}),
                "keep_natural_language": (
                    "BOOLEAN",
                    {"default": True, "label_on": "保留", "label_off": "丢弃"},
                ),
                "trailing_comma": (
                    "BOOLEAN",
                    {"default": False, "label_on": "加尾逗号", "label_off": "不加"},
                ),
                # ⚠️ 新增控件一律追加到最末尾：INPUT_TYPES 的顺序即 widgets_values
                # 的位置契约，插在中间会让旧工作流的后续控件整体错位。
                "force_lowercase": (
                    "BOOLEAN",
                    {"default": True, "label_on": "全小写", "label_off": "保留大小写"},
                ),
                "natural_separator": (
                    list(cls.NATURAL_SEPARATOR_OPTIONS),
                    {
                        "default": cls.NATURAL_SEPARATOR_CHOICES[0],
                        "tooltip": "自然语言段的标点：Anima 提示词整体走逗号，"
                                   "句号会打断这个一致性",
                    },
                ),
                "merge_natural": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "并入标签串",
                        "label_off": "独立成段",
                        "tooltip": "开启后自然语言会与标签串合并成一条逗号连接的长提示词"
                                   "（不再用空行分隔）",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "format_prompt"
    DESCRIPTION = ("把标签串规范为 Anima 形态：下划线转空格、括号转义、artist 加 @、"
                   "按官方区段顺序重排、长度闸门。artist 不加 @ 时效果会明显变弱。")
    SEARCH_ALIASES = ["anima format", "anima prompt", "格式化", "提示词格式"]

    # ── 索引（共享层，见 anima_tag_taxonomy.shared_taxonomy）──
    # 三个 TK 文本节点共用一份索引；这里是测试注入点。
    _TAXONOMY_OVERRIDE = None

    @classmethod
    def _taxonomy(cls):
        return taxonomy_for(cls)

    @classmethod
    def _category_of(cls, piece):
        return category_of(cls, piece)

    # ── 单个标签的规范化 ──

    @staticmethod
    def _split_piece(piece):
        """拆出权重与本体；返回 (本体, 权重或 None)。"""
        raw = str(piece or "").strip()
        if not raw:
            return "", None
        match = WEIGHT_RE.match(raw)
        if match:
            return match.group(1).strip(), match.group(2)
        return raw, None

    @classmethod
    def _normalise_piece(cls, piece, to_spaces=True, escape_brackets=True, at_artist=False,
                         category=None, force_lowercase=True):
        """把单个标签规范成 Anima 形态，保留（并在必要时重打包）权重。"""
        body, weight = cls._split_piece(piece)
        if not body:
            return "", None

        # 去转义 + 下划线转空格 + 压空白：与索引侧共用同一实现，
        # 避免「查表用一套归一化、输出用另一套」这类漂移。
        text = normalise_spaces(body) if to_spaces else body.strip()
        text = text.replace("\\(", "(").replace("\\)", ")").replace("\\", "")
        if not to_spaces:
            text = re.sub(r"\s+", " ", text).strip()
        # Anima 官方 model card 里的示例全部是小写（@big chungus / jpeg artifacts /
        # year 2025 / masterpiece, best quality），所以统一压成小写。
        # CLAUDE/AGENTS 里那些全大写的写法（BREAK、AND）不属于标签，这里不做保护。
        if force_lowercase:
            text = text.lower()

        if at_artist and category == "画师词":
            text = "@" + _AT_PREFIX_RE.sub(r"\1", text)

        if escape_brackets:
            # 只转义裸露的圆括号；已有反斜杠的已在上面统一清掉
            text = text.replace("(", "\\(").replace(")", "\\)")

        return text, weight

    @staticmethod
    def _pack(text, weight):
        if weight is None:
            return text
        return f"({text}:{weight})"

    # ── 主流程 ──

    @staticmethod
    def _split_segments(value):
        """把输入拆成 (标签片段列表, 自然语言段落列表)。

        实现在 ``anima_tag_taxonomy.split_prompt``：与 Tag Getter 的输出形态、
        提示词扩写的输入解析共用同一份契约（空行分隔标签段与自然语言段），
        不再各写一份正则。
        """
        return split_prompt(value)

    @staticmethod
    def _apply_natural_separator(text, mode):
        """把自然语言段的标点规范成逗号。

        Anima 提示词整体是「逗号连接的标签串」形态，而语言模型写出来的自然语言
        天然以句号断句 —— 直接拼进去就会出现 `... a window. Soft light ...`
        这种句号，打断逗号一致性（用户明确反馈过这一点）。
        """
        raw = str(text or "").strip()
        if not raw:
            return ""
        if mode == "句号转逗号":
            # 句号/问号/感叹号（中英）统一转逗号，并合并重复逗号。
            # 注意**不要** strip 掉尾部的逗号 —— `${sentence}.` 的转换结果就该是
            # `${sentence},`，strip(" ,") 会把句尾那个逗号也吃掉（用户要的正是它）。
            converted = re.sub(r"[.。!！?？]+\s*", ", ", raw)
            converted = re.sub(r",\s*,+", ", ", converted)
            return re.sub(r"\s+", " ", converted).strip()
        if mode == "去掉句号":
            removed = re.sub(r"[.。!！?？]+\s*", " ", raw)
            return re.sub(r"\s+", " ", removed).strip()
        return raw

    @classmethod
    def format_prompt(cls, prompt="", to_spaces=True, escape_brackets=True, at_artist=True,
                      reorder_sections=True, dedupe=True, max_tags="不限制",
                      max_lines="不限制", keep_natural_language=True, trailing_comma=False,
                      force_lowercase=True, natural_separator="", merge_natural=False):
        pieces, paragraphs = cls._split_segments(prompt)

        buckets = {name: [] for name in cls.SECTION_ORDER + cls.GENERAL_ORDER}
        extras = []          # 索引未收录、也没有分类的片段
        seen = set()

        for piece in pieces:
            body, _weight = cls._split_piece(piece)
            if not body:
                continue
            category = cls._category_of(piece)
            text, weight = cls._normalise_piece(
                piece, to_spaces, escape_brackets, at_artist, category, force_lowercase)
            if not text:
                continue
            key = normalise(text.lstrip("@"))
            if dedupe and key in seen:
                continue
            seen.add(key)
            packed = cls._pack(text, weight)
            if category in buckets:
                buckets[category].append(packed)
            else:
                extras.append(packed)

        if reorder_sections:
            ordered = []
            for name in cls.SECTION_ORDER + cls.GENERAL_ORDER:
                ordered.extend(buckets[name])
            ordered.extend(extras)
        else:
            # 保持原序：按输入顺序回填（去重后）
            order_index = {}
            for index, piece in enumerate(pieces):
                body, _weight = cls._split_piece(piece)
                if body:
                    order_index.setdefault(normalise(body), index)
            flat = []
            for name in cls.SECTION_ORDER + cls.GENERAL_ORDER:
                flat.extend(buckets[name])
            flat.extend(extras)
            ordered = sorted(
                flat,
                key=lambda item: order_index.get(normalise(cls._split_piece(item)[0].lstrip("@")), 10 ** 6),
            )

        if max_tags != "不限制":
            try:
                ordered = ordered[: int(max_tags)]
            except ValueError:
                pass

        tag_text = ", ".join(ordered)
        if trailing_comma and tag_text:
            tag_text += ","

        if keep_natural_language and paragraphs:
            if max_lines != "不限制":
                try:
                    paragraphs = paragraphs[: int(max_lines)]
                except ValueError:
                    pass
            natural = "\n\n".join(paragraphs)
            # 标点规范化：句号 → 逗号（或去掉），让提示词整体保持逗号一致性
            separator = natural_separator or cls.NATURAL_SEPARATOR_CHOICES[0]
            natural = cls._apply_natural_separator(natural, separator)
            if not natural:
                return (tag_text,)
            if merge_natural and tag_text:
                # 并入标签串：不再用空行分隔，整条提示词都是逗号连接
                merged = f"{tag_text}, {natural}"
                merged = re.sub(r",\s*,+", ", ", merged).strip(" ,")
                if trailing_comma:
                    merged += ","
                return (merged,)
            return (f"{tag_text}\n\n{natural}" if tag_text else natural,)
        return (tag_text,)


NODE_CLASS_MAPPINGS = {
    AnimaTKAnimaFormatter.NODE_ID: AnimaTKAnimaFormatter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaTKAnimaFormatter.NODE_ID: AnimaTKAnimaFormatter.DISPLAY_NAME,
}
