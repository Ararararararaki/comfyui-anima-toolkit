"""TK 提示词扩写 — 零 LLM 的「标签 → 自然语言」，并可选做「按需补全」。

## 设计依据（来自本项目的实测与调研，不是猜测）

用户明确提出的约束：小 LLM "做不到什么很强的规范，还占用很大空间，约束力不是很强"，
而且"有角色可能会认不出"，同时"反推占用时间太长影响生图"。因此在模型能力、显存、
联网、耗时四个维度上都不应该引入 LLM 作为主线。

**核心洞察：Danbooru 标签本身就是英文短语**（`long hair` / `looking at viewer`），
所以拼装自然语言**不需要翻译、不需要生成**，只需要按语义分类套英文句式模板。
每个词汇都来自输入标签本身 → **结构上不可能幻觉**，且耗时在微秒级、零显存、零联网。

Anima 官方的说法也支持这么做：模型训练于 "Danbooru-style tags, natural language
captions, and combinations of tags and captions"，且 "You can mix tags and natural
language in arbitrary order."；官方还建议纯自然语言时"more descriptive is better —
aim for at least 2 sentences"，并特别指出多角色场景下**先说角色名再描述外观**。

## 两个输出口

* ``prompt``  —— 标签串本体（可选附加「按需补全」的词）
* ``natural`` —— 模板生成的自然语言段落（可单独接到提示词末尾）

自然语言是**独立输出口**而不是塞进标签串，因为 Anima 支持混合但两者的用途不同：
标签负责精确控制，自然语言负责标签覆盖不到的连贯描述。

## 补全（默认关闭）

补全只用 curated 清单（如缺失光影时补 `soft lighting`），词表在节点上可见可改，
且默认关闭 —— 它会改变提示词内容，应当由用户主动开启。不做统计共现猜测。
"""

import re

try:
    from .anima_tag_taxonomy import (
        category_of,
        normalise,
        normalise_spaces,
        split_prompt,
        taxonomy_for,
    )
except ImportError:  # 允许脱离包直接导入（单测）
    from anima_tag_taxonomy import (
        category_of,
        normalise,
        normalise_spaces,
        split_prompt,
        taxonomy_for,
    )


# 头发相关词的细分（用于把 `long hair` + `silver hair` 合并成 `long silver hair`）
HAIR_LENGTHS = ("absurdly long hair", "very long hair", "long hair", "medium hair",
                "short hair", "very short hair")
HAIR_STYLES = ("twintails", "twin braids", "ponytail", "braid", "french braid",
               "side braid", "bangs", "blunt bangs", "hime cut", "bob cut",
               "drill hair", "sidelocks", "hair intakes", "ahoge", "hair between eyes",
               "hair over one eye", "hair bun", "topknot", "wavy hair", "curly hair",
               "straight hair", "messy hair", "floating hair")
HAIR_COLOR_RE = re.compile(r"^([a-z][a-z \-]*?)\s+hair$")

# 常见词尾的「可读化」处理：标签是短语，直接放进句子即可，这里只补必要的介词/冠词
_ARTICLES = {"school uniform": "a school uniform", "kimono": "a kimono",
             "serafuku": "a serafuku", "maid": "a maid outfit"}

# VLM 输出的标记块。用 XML 式标记而非裸文本，因为实测这类模型对结构化标签的
# 遵循度明显更好（用户已有的反推 prompt 里就在用 `<character_1><n>…</n>` 这种写法）。
_TAGS_BLOCK_RE = re.compile(r"<\s*danbooru[_ ]?tags\s*>(.*?)<\s*/\s*danbooru[_ ]?tags\s*>", re.S | re.I)
_NATURAL_BLOCK_RE = re.compile(r"<\s*natural\s*>(.*?)<\s*/\s*natural\s*>", re.S | re.I)
_ANY_TAG_BLOCK_RE = re.compile(r"<\s*/?\s*(danbooru[_ ]?tags|natural)\s*>", re.I)

# 给 VLM 的指令模板。要点：
#  1. 明确「只补现有标签里没有的」——否则模型会复述一遍已有的，浪费 token 又制造重复；
#  2. 明确「只用真实存在的 Danbooru 标签」——提高后续词表校验的通过率；
#  3. 要求输出光影/氛围/空间关系——这正是 WD14 这类标签模型天然缺失的维度。
VLM_INSTRUCTION_TEMPLATE = """你是一个 Danbooru 标签专家。观察提供的图片，按下面两个块输出，不要输出其它内容。

<danbooru_tags>
只允许使用真实存在的 Danbooru 标签（英文、下划线形式、逗号分隔）。
补充图片中可见、但【现有标签】里没有的元素，重点覆盖这几类：
服装材质与细节、配饰、身体姿态的细节、镜头角度与景别、光照方向与氛围、背景元素。
不要重复【现有标签】里已经有的。若没有可补充的，输出空。
</danbooru_tags>

<natural>
用 2-3 句英文自然语言描述这张图，必须包含具体的光影、氛围与空间关系，
不要罗列标签本身。
</natural>

【现有标签】
{existing_tags}"""


class AnimaTKPromptExpander:
    """零 LLM 的提示词扩写：标签 → 自然语言句子，可选按需补全。"""

    NODE_ID = "AnimaTKPromptExpander"
    DISPLAY_NAME = "TK 提示词扩写"
    CATEGORY = "TK/prompt"

    STYLE_CHOICES = ("简洁（1 句）", "标准（2-3 句）", "详细（3-4 句）")
    # ⚠️ 以 "" 开头：旧工作流没有这个控件时 ComfyUI 会用空字符串补 widgets_values，
    # COMBO 校验会因 '' 不在列表而让节点报"部分输入值不适用于该节点"。
    STYLE_OPTIONS = ("",) + STYLE_CHOICES
    FILL_LIGHTING_DEFAULT = "soft lighting, soft shadows"
    FILL_CAMERA_DEFAULT = "cowboy shot"
    FILL_QUALITY_DEFAULT = "masterpiece, best quality"

    # ── 索引（共享层，见 anima_tag_taxonomy.shared_taxonomy）──
    _TAXONOMY_OVERRIDE = None

    @classmethod
    def _taxonomy(cls):
        return taxonomy_for(cls)

    @classmethod
    def _category_of(cls, piece):
        return category_of(cls, piece)

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
                        "tooltip": "标签串；空行之后的段落视为自然语言原样保留",
                    },
                ),
            },
            "optional": {
                "write_natural": (
                    "BOOLEAN",
                    {"default": True, "label_on": "生成自然语言", "label_off": "只输出标签"},
                ),
                "style": (list(cls.STYLE_OPTIONS), {"default": cls.STYLE_CHOICES[1]}),
                "keep_input_natural": (
                    "BOOLEAN",
                    {"default": True, "label_on": "保留原文", "label_off": "替换原文"},
                ),
                "fill_lighting": (
                    "BOOLEAN",
                    {"default": False, "label_on": "补光影", "label_off": "不补"},
                ),
                "fill_lighting_tags": ("STRING", {"default": cls.FILL_LIGHTING_DEFAULT, "multiline": False}),
                "fill_camera": (
                    "BOOLEAN",
                    {"default": False, "label_on": "补镜头", "label_off": "不补"},
                ),
                "fill_camera_tags": ("STRING", {"default": cls.FILL_CAMERA_DEFAULT, "multiline": False}),
                "fill_quality": (
                    "BOOLEAN",
                    {"default": False, "label_on": "补质量词", "label_off": "不补"},
                ),
                "fill_quality_tags": ("STRING", {"default": cls.FILL_QUALITY_DEFAULT, "multiline": False}),
                "dedupe_filled": (
                    "BOOLEAN",
                    {"default": True, "label_on": "补全去重", "label_off": "不去重"},
                ),
                "vlm_output": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "forceInput": True,
                        "tooltip": "把 VLM 的返回接到这里（配合 vlm_prompt 指令使用）；"
                                   "会自动解析 <danbooru_tags> / <natural> 两个块",
                    },
                ),
                "validate_vlm_tags": (
                    "BOOLEAN",
                    {"default": True, "label_on": "校验标签", "label_off": "不校验"},
                ),
                "keep_unknown_vlm_tags": (
                    "BOOLEAN",
                    {"default": False, "label_on": "保留未收录", "label_off": "丢弃未收录"},
                ),
                "keep_vlm_natural": (
                    "BOOLEAN",
                    {"default": True, "label_on": "用 VLM 描述", "label_off": "用模板描述"},
                ),
                "existing_tags_override": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "placeholder": "可选：填了就把它当作【现有标签】写进 vlm_prompt，而不是用 prompt 输入",
                    },
                ),
                # ⚠️ 新增控件一律追加到最末尾：INPUT_TYPES 的顺序即 widgets_values
                # 的位置契约，插在中间会让旧工作流的后续控件整体错位。
                "normalise_output": (
                    "BOOLEAN",
                    {"default": True, "label_on": "输出 Anima 形态", "label_off": "保持原形态"},
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "natural", "vlm_prompt")
    FUNCTION = "expand"
    DESCRIPTION = ("零 LLM 的提示词扩写：把标签重组为英文自然语言（毫秒级、零幻觉），"
                   "可选按 curated 清单补全；并输出 vlm_prompt 指令，"
                   "让已有的 VLM 调用顺便补出图片里可见但标签缺失的元素。")
    SEARCH_ALIASES = ["prompt expander", "扩写", "自然语言", "natural language", "vlm"]

    # ── 解析 ──

    @staticmethod
    def _normalise_tag(tag):
        """把标签规范成 Anima 形态（去转义 + 空格化），供分析与输出共用。

        实现在 ``anima_tag_taxonomy.normalise_spaces``（保留大小写）：本模块的词表与
        正则都按空格形态书写，上游给的却是 `long_hair`，不规范化一个都匹配不上，
        头发合并与词表补全全部失效。查表路径请用 ``normalise``（会 casefold）。
        """
        return normalise_spaces(tag)

    @staticmethod
    def _split_input(value):
        """标签串 → (标签片段, 自然语言段落)，共用 split_prompt 的空行契约。"""
        return split_prompt(value)

    @classmethod
    def _collect(cls, tags):
        """把标签按分类归集，供句式模板使用。"""
        buckets = {}
        order = []
        for tag in tags:
            category = cls._category_of(tag) or "未归类词"
            buckets.setdefault(category, []).append(tag)
            order.append(tag)
        return buckets, order

    # ── 描述片段构造 ──

    @staticmethod
    def _join(parts, conjunction="and"):
        items = [part for part in parts if part]
        if not items:
            return ""
        if len(items) == 1:
            return items[0]
        return ", ".join(items[:-1]) + f" {conjunction} " + items[-1]

    @classmethod
    def _describe_hair(cls, hair_tags):
        """把发色与发型合并成可读短语：`long silver hair` / `blue hair in twintails`。"""
        colors, lengths, styles, other = [], [], [], []
        for tag in hair_tags:
            clean = tag.strip()
            if clean in HAIR_LENGTHS:
                # 只存长度形容词本身（`long hair` → `long`），
                # 否则拼 `" ".join(lengths + colors) + " hair"` 会变成 "long hair silver hair"
                lengths.append(clean[:-5].strip() if clean.endswith(" hair") else clean)
                continue
            if clean in HAIR_STYLES:
                styles.append(clean)
                continue
            match = HAIR_COLOR_RE.match(clean)
            if match and match.group(1) not in ("long", "short", "very long", "very short",
                                                "medium", "absurdly long"):
                colors.append(match.group(1))
                continue
            other.append(clean)

        head = ""
        if colors or lengths:
            head = " ".join(lengths + colors) + " hair"
        if styles:
            style_text = cls._join(styles)
            head = f"{head} in {style_text}" if head else f"hair in {style_text}"
        return cls._join([head] + other)

    @classmethod
    def _describe_subject(cls, buckets):
        counts = buckets.get("人物对象词", [])
        characters = buckets.get("角色身份词", [])
        series = buckets.get("作品版权词", [])

        subject = "a girl"
        lowered = [tag.casefold() for tag in counts]
        if any("2girls" in tag or "multiple girls" in tag for tag in lowered):
            subject = "two girls"
        elif any("1boy" in tag for tag in lowered):
            subject = "a boy"
        elif any("no humans" in tag for tag in lowered):
            subject = "no person"

        if characters:
            name = characters[0]
            match = re.match(r"^(.*?)\s*\((.*)\)$", name)
            if match:
                who = match.group(1).strip().title()
                source = match.group(2).strip().title()
                # Anima 官方建议：多角色场景先说角色名再描述外观
                subject = f"{who} from {source}"
            else:
                subject = name.title()
            if subject.startswith("Two girls"):
                subject = subject + " and another girl"
        elif series:
            subject = f"{subject} from {series[0].title()}"

        return subject

    @classmethod
    def _build_sentences(cls, buckets, style):
        """按 Anima 的"逻辑分块"建议组织句子：主体 → 细节 → 环境 → 氛围。"""
        subject = cls._describe_subject(buckets)

        features = []
        hair = cls._describe_hair(buckets.get("发色发型词", []))
        if hair:
            features.append(hair)
        eyes = buckets.get("角色五官词", [])
        if eyes:
            features.append(cls._join([tag for tag in eyes if "eye" in tag or "pupil" in tag]
                                      or eyes))
        demi = buckets.get("亚人特征词", [])
        if demi:
            features.append(cls._join(demi))

        sentence_one = subject
        if features:
            sentence_one += " with " + cls._join(features)

        outfit = buckets.get("服饰词", [])
        body = buckets.get("角色部位词", []) + buckets.get("性征部位词", [])
        actions = buckets.get("动作词", [])
        expressions = buckets.get("角色表情词", [])

        detail_parts = []
        if outfit:
            readable = [_ARTICLES.get(tag, tag) for tag in outfit]
            detail_parts.append("wearing " + cls._join(readable))
        if body:
            detail_parts.append(cls._join(body))
        if actions:
            detail_parts.append(cls._join(actions))
        if expressions:
            detail_parts.append(cls._join(expressions))
        if detail_parts:
            sentence_one += ", " + ", ".join(detail_parts)

        sentences = [sentence_one]
        if style == cls.STYLE_CHOICES[0]:
            return sentences

        camera = buckets.get("镜头词", [])
        background = buckets.get("背景词", [])
        props = buckets.get("物件道具词", [])
        scene_parts = []
        if camera:
            scene_parts.append(cls._join(camera))
        if background:
            scene_parts.append("in " + cls._join(background))
        if props:
            scene_parts.append("with " + cls._join(props))
        if scene_parts:
            sentences.append(", ".join(scene_parts))

        if style == cls.STYLE_CHOICES[1]:
            return sentences

        # 详细档：再补一层氛围/画质描述
        meta = buckets.get("质量元词", [])
        mood = [tag for tag in meta if any(key in tag for key in ("lighting", "light", "contrast"))]
        if mood:
            sentences.append("with " + cls._join(mood))
        return sentences

    # ── 补全 ──

    @staticmethod
    def _parse_fill_tags(value):
        return [part.strip() for part in re.split(r"[,，\r\n]+", str(value or "")) if part.strip()]

    @classmethod
    def _apply_fill(cls, tags, buckets, options):
        """按 curated 清单补全缺失项；返回 (新标签列表, 实际补进去的词)。"""
        additions = []
        if options.get("fill_lighting"):
            # 光影词在本索引里落在「背景词」（如 backlighting）或「质量元词」
            has_light = any(
                "light" in tag or "shadow" in tag
                for tag in buckets.get("背景词", []) + buckets.get("质量元词", [])
            )
            if not has_light:
                additions.extend(cls._parse_fill_tags(options.get("fill_lighting_tags")))
        if options.get("fill_camera"):
            # 「视线方向」词在本索引里归「角色表情词」（沿用原插件语义），
            # 但语义上属于镜头语言，检测已有镜头信息时必须一并算上，
            # 否则用户写了 looking at viewer 还会被硬塞一个 cowboy shot。
            camera_like = list(buckets.get("镜头词", [])) + [
                tag for tag in buckets.get("角色表情词", [])
                if "looking" in tag or "viewer" in tag
            ]
            if not camera_like:
                additions.extend(cls._parse_fill_tags(options.get("fill_camera_tags")))
        if options.get("fill_quality") and not buckets.get("质量元词"):
            additions.extend(cls._parse_fill_tags(options.get("fill_quality_tags")))

        if not additions:
            return list(tags), []

        existing = {normalise(tag) for tag in tags}
        applied = []
        for tag in additions:
            key = normalise(tag)
            if options.get("dedupe_filled", True) and key in existing:
                continue
            existing.add(key)
            applied.append(tag)
        return list(tags) + applied, applied

    # ── VLM 输出解析与词表校验 ──

    @classmethod
    def build_vlm_instruction(cls, existing_tags):
        """生成给 VLM 的指令（内嵌现有标签）。

        用法：把本节点的 ``vlm_prompt`` 输出接到你已有的 VLM/LLM 节点的提示词输入，
        由**那一次本来就要发生的调用**顺便补出标签 —— 不额外增加一次推理，
        因此不增加耗时。VLM 的返回再接到本节点的 ``vlm_output``。
        """
        listing = ", ".join(existing_tags) if existing_tags else "（无）"
        return VLM_INSTRUCTION_TEMPLATE.format(existing_tags=listing)

    @staticmethod
    def _parse_vlm_output(value):
        """解析 VLM 返回，返回 (标签列表, 自然语言)。缺块时对应项为空。"""
        raw = str(value or "").strip()
        if not raw:
            return [], ""
        tags_match = _TAGS_BLOCK_RE.search(raw)
        natural_match = _NATURAL_BLOCK_RE.search(raw)
        tags = []
        if tags_match:
            block = _ANY_TAG_BLOCK_RE.sub(" ", tags_match.group(1))
            tags = [part.strip() for part in re.split(r"[,，\r\n]+", block) if part.strip()]
        natural = ""
        if natural_match:
            natural = _ANY_TAG_BLOCK_RE.sub(" ", natural_match.group(1)).strip()
        return tags, natural

    @classmethod
    def _validate_vlm_tags(cls, tags):
        """按索引校验，返回 (合法标签, 未收录标签)。

        这是「补出来的仍是合法 Danbooru 标签」的保证。VLM 天然会吐
        ``soft afternoon light fills the room`` 这类**非标签短语**，
        直接塞进标签段会污染提示词；因此必须以 69 万条索引为准做一遍过筛。
        """
        taxonomy = cls._taxonomy()
        known, unknown = [], []
        seen = set()
        for tag in tags:
            key = normalise(tag)
            if not key or key in seen:
                continue
            seen.add(key)
            try:
                hit = taxonomy.lookup(tag)
            except AttributeError:
                hit = None
            # 测试替身（dict 式）没有 lookup 时按"合法"处理，保证纯逻辑可单测
            (known if hit is not None else unknown).append(tag)
        return known, unknown

    # ── 主流程 ──

    def expand(self, prompt="", write_natural=True, style=None, keep_input_natural=True,
               normalise_output=True, fill_lighting=False, fill_lighting_tags=None,
               fill_camera=False, fill_camera_tags=None, fill_quality=False,
               fill_quality_tags=None, dedupe_filled=True, vlm_output="",
               validate_vlm_tags=True, keep_unknown_vlm_tags=False, keep_vlm_natural=True,
               existing_tags_override=""):
        style = style or self.STYLE_CHOICES[1]
        tags, paragraphs = self._split_input(prompt)
        if normalise_output:
            tags = [self._normalise_tag(tag) for tag in tags if self._normalise_tag(tag)]
        # 分析与输出统一走规范化形式，保证下游拿到的是 Anima 形态
        buckets, _order = self._collect(tags)

        # ① 给 VLM/LLM 的指令：内嵌【现有标签】，让模型只补差集
        #    （用户工作流里就是这么接的：WD14 标签 → llama_cpp_instruct_adv 当上下文）
        override_tags, _ = self._split_input(existing_tags_override)
        instruction_source = override_tags if existing_tags_override.strip() else tags
        vlm_prompt = self.build_vlm_instruction(instruction_source)

        # ② 解析外部 VLM/LLM 的回复（由用户自己已有的本地模型节点产生）
        vlm_reply = str(vlm_output or "")

        # ③ 解析 VLM 返回并做词表校验
        vlm_tags, vlm_natural = self._parse_vlm_output(vlm_reply)
        vlm_known, vlm_unknown = ([], [])
        if vlm_tags:
            if validate_vlm_tags:
                vlm_known, vlm_unknown = self._validate_vlm_tags(vlm_tags)
            else:
                vlm_known = list(vlm_tags)
        if keep_unknown_vlm_tags:
            vlm_known = vlm_known + vlm_unknown
        if vlm_known:
            tags = tags + [self._normalise_tag(tag) for tag in vlm_known]

        # ③ 空输入保护：没有任何标签也没有自然语言时直接返回，
        #    但仍要把 vlm_prompt 给出去（它本身就是可用产物）
        if not tags and not paragraphs:
            return ("", "", vlm_prompt)

        buckets, _order = self._collect(tags)

        options = {
            "fill_lighting": fill_lighting,
            "fill_lighting_tags": self.FILL_LIGHTING_DEFAULT if fill_lighting_tags is None else fill_lighting_tags,
            "fill_camera": fill_camera,
            "fill_camera_tags": self.FILL_CAMERA_DEFAULT if fill_camera_tags is None else fill_camera_tags,
            "fill_quality": fill_quality,
            "fill_quality_tags": self.FILL_QUALITY_DEFAULT if fill_quality_tags is None else fill_quality_tags,
            "dedupe_filled": dedupe_filled,
        }
        filled_tags, applied = self._apply_fill(tags, buckets, options)
        tag_text = ", ".join(filled_tags)

        # ④ 自然语言优先级：VLM 描述 > 模板重组（VLM 描述含图片特有信息，模板只能重排标签）
        natural = ""
        if keep_vlm_natural and vlm_natural:
            natural = vlm_natural
        if write_natural and not natural:
            buckets, _ = self._collect(filled_tags)
            sentences = self._build_sentences(buckets, style)
            cleaned = []
            for sentence in sentences:
                text = str(sentence or "").strip().rstrip(".")
                if text:
                    # 每句首字母大写：多句拼接后第二句会以小写开头（如 "in classroom."）
                    cleaned.append(text[0].upper() + text[1:] + ".")
            natural = " ".join(cleaned)

        if keep_input_natural and paragraphs:
            extra = "\n\n".join(paragraphs)
            natural = (natural + "\n\n" + extra).strip() if natural else extra

        if not write_natural and not (keep_vlm_natural and vlm_natural):
            if keep_input_natural and paragraphs:
                natural = "\n\n".join(paragraphs)
            else:
                natural = ""

        return (tag_text, natural, vlm_prompt)


NODE_CLASS_MAPPINGS = {
    AnimaTKPromptExpander.NODE_ID: AnimaTKPromptExpander,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaTKPromptExpander.NODE_ID: AnimaTKPromptExpander.DISPLAY_NAME,
}
