"""TK Danbooru Tag Getter - extract, filter and merge TAG_BUNDLE categories."""

import csv
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET


class AnimaTKDanbooruTagGetter:
    """从单一 Prompt 或 Danbooru Sorter 的 TAG_BUNDLE 提取并筛选多个分类。"""

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
    WEIGHT_INPUTS = {category: f"{category}_weight" for category in CATEGORY_NAMES}
    CATEGORY_WEIGHT_MIN = 0.0
    CATEGORY_WEIGHT_MAX = 2.0
    _TAG_CATEGORY_INDEX = None

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
                        "tooltip": "统一输入：接入 Packer 的 ALL_TAGS 或普通 Prompt；已知 Danbooru Tag 会自动分类，未知段落可选择保留。",
                    },
                ),
                "include_natural_language": ("BOOLEAN", {"default": True, "label_on": "保留", "label_off": "过滤掉"}),
                "filter_natural_language": ("BOOLEAN", {"default": True, "label_on": "过滤", "label_off": "不过滤"}),
                **{
                    input_name: (
                        "FLOAT",
                        {
                            "default": 1.0,
                            "min": cls.CATEGORY_WEIGHT_MIN,
                            "max": cls.CATEGORY_WEIGHT_MAX,
                            "step": 0.05,
                            "round": 0.05,
                            "tooltip": f"{category} Tag 权重；1.0 保持原样，范围 0.0–2.0",
                        },
                    )
                    for category, input_name in cls.WEIGHT_INPUTS.items()
                },
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("Tag String",)
    FUNCTION = "get_tags"
    CATEGORY = "TK/text"
    DESCRIPTION = "单一 Prompt 输入自动分类 Danbooru Tag，并按开关保留自然语言；兼容 Packer 分类包"

    @staticmethod
    def _normalise_tag(value):
        return str(value or "").strip().casefold().replace("_", " ")

    @classmethod
    def _prompt_tag_keys(cls, value):
        """返回原始 Tag、括号强调/权重 Tag 的统一查找键。"""
        raw = str(value or "").strip()
        if not raw:
            return ()
        keys = [cls._normalise_tag(raw)]
        weighted = re.fullmatch(r"\(?\s*(.+?)\s*:\s*[+-]?\d+(?:\.\d+)?\s*\)?", raw)
        if weighted:
            keys.append(cls._normalise_tag(weighted.group(1)))
        return tuple(dict.fromkeys(key for key in keys if key))

    @classmethod
    def _category_weight(cls, category_flags, category):
        """读取并限制分类权重；缺失/非法值按 1.0 处理，兼容旧工作流。"""
        raw = category_flags.get(cls.WEIGHT_INPUTS[category], 1.0)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = 1.0
        value = max(cls.CATEGORY_WEIGHT_MIN, min(cls.CATEGORY_WEIGHT_MAX, value))
        return round(value / 0.05) * 0.05

    @staticmethod
    def _format_weight(value):
        text = f"{float(value):.2f}".rstrip("0").rstrip(".")
        return "0" if text in {"", "-0"} else text

    @classmethod
    def _apply_category_weight(cls, tag, category, category_flags):
        """按分类强度包裹 Tag；1.0 不增加括号，已有 Tag 权重按乘数合并。"""
        raw = str(tag or "").strip()
        weight = cls._category_weight(category_flags, category)
        if not raw or abs(weight - 1.0) < 1e-9:
            return raw
        weighted = re.fullmatch(r"\(?\s*(.+?)\s*:\s*([+-]?\d+(?:\.\d+)?)\s*\)?", raw)
        if weighted:
            base = weighted.group(1).strip()
            try:
                weight *= float(weighted.group(2))
            except ValueError:
                base = raw
        else:
            base = raw
        return f"({base}:{cls._format_weight(weight)})"

    @classmethod
    def _sorter_root(cls):
        """查找 Packer 的分类数据库；找不到时回退到本节点随附的说明 CSV。"""
        plugin_dir = os.path.dirname(os.path.abspath(__file__))
        candidates = [
            os.path.normpath(os.path.join(plugin_dir, "..", "ComfyUI-Danbooru-Tag-Sorter-Node")),
            os.path.normpath(os.path.join(plugin_dir, "ComfyUI-Danbooru-Tag-Sorter-Node")),
        ]
        for candidate in candidates:
            if os.path.isdir(candidate):
                return candidate
        return ""

    @classmethod
    def _category_mapping(cls):
        root = cls._sorter_root()
        path = os.path.join(root, "defaults_config.json") if root else ""
        try:
            with open(path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            mapping = {}
            for item in raw.get("mapping", []):
                if isinstance(item, list) and len(item) >= 3:
                    mapping[(str(item[0]).strip(), str(item[1]).strip())] = str(item[2]).strip()
            return mapping
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return {}

    @classmethod
    def _fallback_category(cls, original_category, original_subcategory):
        """无 Packer 配置文件时的保守分类，未知项一律留给“未归类词”。"""
        category = str(original_category or "").strip()
        subcategory = str(original_subcategory or "").strip()
        if category in {"人物", "角色"}:
            if any(key in subcategory for key in ("对象", "人数")):
                return "人物对象词"
            if any(key in subcategory for key in ("面部", "脸型", "眉毛", "瞳孔", "鼻子", "嘴巴", "牙齿", "舌头")):
                return "角色五官词"
            if any(key in subcategory for key in ("头发", "眼睛", "翅膀")):
                return "角色特征词"
            if any(key in subcategory for key in ("肩部", "腿部", "腹部", "腰部", "指甲")):
                return "角色部位词"
            if any(key in subcategory for key in ("胸部", "性器官")):
                return "性征部位词"
        if category in {"服饰", "时尚"}:
            return "服饰词"
        if category in {"表情动作", "动作"}:
            if any(key in subcategory for key in ("表情", "哭", "笑", "生气", "不开心", "蔑视")):
                return "角色表情词"
            return "动作词"
        if category in {"镜头", "构图"}:
            if any(key in subcategory for key in ("表情", "朝向")):
                return "角色表情词"
            return "镜头词"
        if category in {"画面", "场景", "环境"}:
            if any(key in subcategory for key in ("艺术", "画师")):
                return "画师词"
            return "背景词"
        return "未归类词"

    @classmethod
    def _load_tag_category_index(cls):
        if cls._TAG_CATEGORY_INDEX is not None:
            return cls._TAG_CATEGORY_INDEX
        root = cls._sorter_root()
        mapping = cls._category_mapping()
        index = {}
        xlsx_path = os.path.join(root, "tags_database", "danbooru_tags.xlsx") if root else ""
        try:
            # 直接读取 xlsx XML，比 openpyxl 启动完整工作簿更快，避免首次执行阻塞过久。
            namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
            with zipfile.ZipFile(xlsx_path) as archive:
                shared = []
                if "xl/sharedStrings.xml" in archive.namelist():
                    shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
                    for item in shared_root.findall(f"{namespace}si"):
                        shared.append("".join(text.text or "" for text in item.iter(f"{namespace}t")))
                sheet_root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            rows = sheet_root.findall(f".//{namespace}sheetData/{namespace}row")
            if not rows:
                raise ValueError("分类数据库没有工作表数据")

            def cell_value(cell):
                value = cell.find(f"{namespace}v")
                if value is None:
                    return ""
                raw = value.text or ""
                if cell.get("t") == "s":
                    try:
                        return shared[int(raw)]
                    except (IndexError, TypeError, ValueError):
                        return ""
                return raw

            def row_values(row):
                values = {}
                for cell in row.findall(f"{namespace}c"):
                    reference = cell.get("r", "")
                    letters = re.match(r"[A-Z]+", reference.upper())
                    if not letters:
                        continue
                    column = 0
                    for letter in letters.group(0):
                        column = column * 26 + ord(letter) - ord("A") + 1
                    values[column - 1] = cell_value(cell)
                return values

            header = row_values(rows[0])
            columns = {name: next(index for index, value in header.items() if str(value).strip().casefold() == name) for name in ("english", "category", "subcategory")}
            for row in rows[1:]:
                values = row_values(row)
                tag = cls._normalise_tag(values.get(columns["english"], ""))
                if not tag:
                    continue
                original = (
                    values.get(columns["category"], ""),
                    values.get(columns["subcategory"], ""),
                )
                category = mapping.get(tuple(str(value or "").strip() for value in original))
                index[tag] = category if category in cls.CATEGORY_NAMES else cls._fallback_category(*original)
        except Exception:
            index = {}

        if not index:
            # 说明 CSV 没有表头：english,type,count,description。描述首段含 [大类>小类]。
            csv_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "danbooru_tags_with_description_v3_modified.csv")
            try:
                with open(csv_path, "r", encoding="utf-8-sig", newline="") as handle:
                    for row in csv.reader(handle):
                        if len(row) < 4:
                            continue
                        tag = cls._normalise_tag(row[0])
                        description = row[3].strip()
                        closing = description.find("]")
                        path = description[1:closing] if description.startswith("[") and closing > 0 else ""
                        original = tuple(part.strip() for part in path.split(">", 1)) if ">" in path else ("", "")
                        category = mapping.get(original) or cls._fallback_category(*original)
                        if tag:
                            index[tag] = category
            except OSError:
                pass
        cls._TAG_CATEGORY_INDEX = index
        return index

    @classmethod
    def _classify_prompt(cls, value, category_flags, regex_pattern, exact_blacklist, include_natural_language, filter_natural_language):
        """将单一 Prompt 拆成已知 Tag 分类和未知自然语言，保持段落结构。"""
        # 仅勾选“未归类词”时沿用旧工作流语义：整段输入都视为自然语言，
        # 避免升级后旧节点突然丢掉已知 Tag；勾选任一具体分类才启用自动分类。
        if not any(category_flags.get(category, False) for category in cls.CATEGORY_NAMES[:-1]):
            natural = str(value or "").strip()
            if filter_natural_language:
                natural = cls._filter_natural_language(natural, regex_pattern, exact_blacklist)
            return [], natural if include_natural_language else ""
        index = cls._load_tag_category_index()
        buckets = {category: [] for category in cls.CATEGORY_NAMES}
        natural_paragraphs = []
        for paragraph in re.split(r"\n\s*\n", str(value or "").strip()):
            unknown_lines = []
            for line in paragraph.splitlines() or [paragraph]:
                unknown = []
                for piece in (part.strip() for part in re.split(r"[,，]", line)):
                    if not piece:
                        continue
                    if piece.rstrip(":：").strip() in cls.CATEGORY_NAMES:
                        # Packer ALL_TAGS 开启注释时会带“分类名:”标题，不应成为自然语言输出。
                        continue
                    lookup_keys = cls._prompt_tag_keys(piece)
                    if any(key in exact_blacklist for key in lookup_keys) or (regex_pattern is not None and regex_pattern.search(piece)):
                        continue
                    category = next((index.get(key) for key in lookup_keys if key in index), None)
                    if category in cls.CATEGORY_NAMES:
                        if category_flags.get(category, False):
                            buckets[category].append(piece)
                    else:
                        unknown.append(piece)
                if unknown:
                    unknown_lines.append(", ".join(unknown))
            if unknown_lines:
                natural_paragraphs.append("\n".join(unknown_lines))
        selected = []
        seen = set()
        for category in cls.CATEGORY_NAMES:
            for tag in buckets[category]:
                lookup_keys = cls._prompt_tag_keys(tag)
                key = lookup_keys[-1] if len(lookup_keys) > 1 else cls._normalise_tag(tag)
                if key not in seen:
                    seen.add(key)
                    selected.append(cls._apply_category_weight(tag, category, category_flags))
        natural = "\n\n".join(natural_paragraphs)
        if filter_natural_language:
            natural = cls._filter_natural_language(natural, regex_pattern, exact_blacklist)
        if include_natural_language and natural:
            return selected, natural
        return selected, ""

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

    @classmethod
    def _build_exact_blacklist(cls, tag_blacklist):
        """支持外部节点的逗号格式，同时允许在节点面板中每行填写一个 Tag。"""
        result = set()
        for tag in re.split(r"[,\r\n]+", str(tag_blacklist or "")):
            clean = tag.strip()
            if clean:
                result.add(clean.casefold())
                result.add(cls._normalise_tag(clean))
        return result

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

    @classmethod
    def _remove_bundle_tags(cls, value, bundle_tags):
        """从 ALL_TAGS/整段 Prompt 中移除 Packer 已识别的分类 Tag。"""
        raw = str(value or "").strip()
        known = {
            key
            for tag in bundle_tags
            if str(tag).strip()
            for key in (str(tag).casefold(), cls._normalise_tag(tag))
        }
        if not raw or not known:
            return raw
        paragraphs = []
        for paragraph in re.split(r"\n\s*\n", raw):
            kept_lines = []
            for line in paragraph.splitlines() or [paragraph]:
                pieces = [piece.strip() for piece in re.split(r"[,，]", line) if piece.strip()]
                kept = [piece for piece in pieces if piece.casefold() not in known and cls._normalise_tag(piece) not in known]
                if kept:
                    kept_lines.append(", ".join(kept))
            if kept_lines:
                paragraphs.append("\n".join(kept_lines))
        return "\n\n".join(paragraphs)

    @classmethod
    def _filter_natural_language(cls, value, regex_pattern, exact_blacklist):
        """按排除规则过滤自然语言中的逗号片段，保留其余句子和段落。"""
        raw = str(value or "").strip()
        if not raw or (regex_pattern is None and not exact_blacklist):
            return raw
        paragraphs = []
        for paragraph in re.split(r"\n\s*\n", raw):
            kept_lines = []
            for line in paragraph.splitlines() or [paragraph]:
                pieces = [piece.strip() for piece in re.split(r"[,，]", line) if piece.strip()]
                if not pieces:
                    continue
                kept = [
                    piece for piece in pieces
                    if piece.casefold() not in exact_blacklist and cls._normalise_tag(piece) not in exact_blacklist
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
            # 单输入模式：没有结构化分类包时，直接把 Prompt 中的已知 Danbooru
            # Tag 重新分类，未识别段落交给“保留自然语言”开关。
            selected_tags, natural = self._classify_prompt(
                natural_language,
                category_flags,
                regex_pattern,
                exact_blacklist,
                include_natural_language,
                filter_natural_language,
            )
            tag_text = ", ".join(selected_tags)
            if natural:
                tag_text = f"{tag_text}\n\n{natural}" if tag_text else natural
            return (tag_text,)
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
                    result.append((tag, category))
            # 保留未加权原文给双输入去重逻辑使用，避免权重包裹后无法识别 ALL_TAGS 中的前置 Tag。
            selected_tags = [tag for tag, _category in result]
            tag_text = ", ".join(
                self._apply_category_weight(tag, category, category_flags)
                for tag, category in result
            )

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
