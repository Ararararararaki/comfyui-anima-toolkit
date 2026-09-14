"""TK Danbooru Tag Getter — 提取 / 过滤 / 加权 Danbooru 标签，自然语言段原样保留。

分类索引来自自建索引 ``data/tag_taxonomy.tsv.gz``（见 ``anima_tag_taxonomy``），
**不再依赖第三方插件 ComfyUI-Danbooru-Tag-Sorter-Node**：旧实现读它的
``danbooru_tags.xlsx`` + ``defaults_config.json``，实测未安装时分类退化为
98.6% 未归类词（``blue hair`` 被归到服饰词），安装了也仍有约 80% 落未归类词
（mapping 只覆盖 99 个分类组合中的 76 个）。

保留的兼容行为：
  * 前 12 个分类的**名字与顺序原样不变**（旧工作流的控件基线）；
  * ``tag_bundle`` 输入继续可用（兼容仍在用 Packer 的工作流）；
  * ``regex_blacklist`` / ``tag_blacklist`` 语义不变。
"""

import functools
import json
import os
import re

try:
    from .anima_tag_taxonomy import (
        CATEGORY_NAME_SET,
        CATEGORY_NAMES as TAXONOMY_CATEGORIES,
        LEGACY_CATEGORY_COUNT,
        PLUGIN_DIR,
        WEIGHT_RE,
        normalise,
        tag_lookup_keys,
        taxonomy_for,
    )
except ImportError:  # 允许脱离包直接导入（单测时把插件根目录加进 sys.path）
    from anima_tag_taxonomy import (
        CATEGORY_NAME_SET,
        CATEGORY_NAMES as TAXONOMY_CATEGORIES,
        LEGACY_CATEGORY_COUNT,
        PLUGIN_DIR,
        WEIGHT_RE,
        normalise,
        tag_lookup_keys,
        taxonomy_for,
    )


class AnimaTKDanbooruTagGetter:
    """从单一 Prompt 或 Danbooru Sorter 的 TAG_BUNDLE 提取并筛选多个分类。"""

    NODE_ID = "AnimaTKDanbooruTagGetter"
    DISPLAY_NAME = "TK Danbooru Tag Getter"
    CATEGORY = "TK/text"

    # 前 12 类 = 旧行为基线（名字与顺序禁止改动），后 8 类为新增。
    CATEGORY_NAMES = TAXONOMY_CATEGORIES
    NEW_CATEGORY_NAMES = tuple(CATEGORY_NAMES[LEGACY_CATEGORY_COUNT:])
    FILTER_INPUTS = ("regex_blacklist", "tag_blacklist")
    WEIGHT_INPUTS = {category: f"{category}_weight" for category in CATEGORY_NAMES}
    # 0 没有分类控制意义（是否输出由 BOOLEAN 开关决定），并会生成
    # 下游容易拒绝的 ``(tag:0)``；最小可调权重从 0.05 开始。
    CATEGORY_WEIGHT_MIN = 0.05
    CATEGORY_WEIGHT_MAX = 2.0

    #: 新增分类里**默认关闭**的两类：它们描述的是"画面里的坏东西"
    #: （审查遮挡 / 文字水印），默认就不该进提示词 —— 用户 2026-09-14 要求。
    #: 其余新增分类保持默认开启，理由见下面 new_switches 的注释。
    DEFAULT_OFF_CATEGORIES = ("审查遮挡词", "文字水印词")

    # ── 自定义预设：用户自己保存的开关快照（持久化在 data/tag_presets.json）──
    #: 自建预设文件名（跨工作流共用；与内置 PRESETS 分开，避免混在一起）
    CUSTOM_PRESET_FILENAME = "tag_presets.json"
    #: 自定义预设名不允许与内置重名（否则展开优先级会产生歧义）
    CUSTOM_PRESET_MAX = 64

    # ── 场景预设：一键切换整套分类开关 ──
    # 约定：``off`` 列出要关闭的分类，``only`` 表示"只开这些，其余全关"。
    # 预设只改开关状态，不引入任何隐藏状态（工作流保存后即固化为普通开关值）。
    PRESET_NONE = "自定义（不用预设）"
    PRESETS = {
        PRESET_NONE: {},
        "换角色（剥离身份/版权/画师）": {
            "off": ("角色身份词", "作品版权词", "画师词"),
        },
        "保特征换角色（留发色瞳色/亚人特征）": {
            "off": ("角色身份词", "作品版权词", "画师词", "角色部位词", "性征部位词"),
        },
        "换装（再剥离服饰）": {
            "off": ("角色身份词", "作品版权词", "画师词", "服饰词"),
        },
        "仅保留骨架（动作/表情/镜头/背景）": {
            "only": ("人物对象词", "动作词", "角色表情词", "镜头词", "背景词"),
        },
        "清除干扰（审查/水印/质量元）": {
            "off": ("审查遮挡词", "文字水印词", "质量元词"),
        },
    }


    # 权重控件同样按「旧 12 个在前、新 8 个在后」拆开，理由同上。
    LEGACY_WEIGHT_INPUTS = {
        category: f"{category}_weight"
        for category in CATEGORY_NAMES[:LEGACY_CATEGORY_COUNT]
    }
    NEW_WEIGHT_INPUTS = {
        category: f"{category}_weight"
        for category in CATEGORY_NAMES[LEGACY_CATEGORY_COUNT:]
    }

    # ── 前端面板元数据（唯一数据源）──
    # 过去前端 widget 里另抄了一份 CATEGORY_NAMES / PRESETS / 主题组 label，
    # 改后端不改前端就会静默不一致。现在前端只从 /object_info 读这里。
    _GROUP_META = None

    @classmethod
    def _group_meta(cls):
        """语义组的展示元数据（id / label / short / desc）。

        只取展示字段：``tags`` / ``rules`` 是后端匹配用的词表，没必要塞进
        /object_info（前端每次启动都会拉一次）。
        """
        if cls._GROUP_META is None:
            path = os.path.join(PLUGIN_DIR, "data", "tag_groups.json")
            try:
                with open(path, encoding="utf-8") as handle:
                    payload = json.load(handle)
                raw_groups = payload.get("groups") if isinstance(payload, dict) else payload
                cls._GROUP_META = [
                    {
                        "id": str(group.get("id", "")),
                        "label": str(group.get("label") or group.get("id", "")),
                        # short 供 chips 用（label 太长会把面板撑宽）；缺失时取 label 首段
                        "short": str(group.get("short")
                                     or str(group.get("label") or group.get("id", "")).split(" / ")[0]),
                        "desc": str(group.get("desc", "")),
                    }
                    for group in (raw_groups or [])
                    if isinstance(group, dict) and group.get("id")
                ]
            except Exception:
                # 数据文件缺失/损坏只让「主题剔除」的 chips 空着，不阻断节点加载
                cls._GROUP_META = []
        return cls._GROUP_META

    # ── 自定义预设库（用户自己保存的开关快照）──

    @classmethod
    def _preset_path(cls):
        return os.path.join(PLUGIN_DIR, "data", cls.CUSTOM_PRESET_FILENAME)

    @classmethod
    def custom_presets(cls):
        """读自定义预设库 ``{名称: {"flags": {...}, "weights": {...}}}``。

        文件缺失/损坏一律当空库 —— 面板少一个下拉项，不该阻断节点加载。
        """
        try:
            with open(cls._preset_path(), encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            return {}
        presets = payload.get("presets") if isinstance(payload, dict) else None
        return presets if isinstance(presets, dict) else {}

    @classmethod
    def custom_preset_names(cls):
        return sorted(cls.custom_presets())

    @classmethod
    def _write_custom_presets(cls, presets):
        """原子写：先写 .tmp 再 os.replace —— 中途失败不会留下半个文件。"""
        path = cls._preset_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "presets": presets}, handle,
                      ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)

    @classmethod
    def save_custom_preset(cls, name, flags, weights=None):
        """把当前开关（+ 权重）存成一个命名预设。返回 ``(ok, message)``。"""
        clean = str(name or "").strip()
        if not clean:
            return False, "预设名不能为空"
        if clean in cls.PRESETS:
            return False, f"「{clean}」与内置预设同名，换一个"
        if clean == cls.PRESET_NONE:
            return False, f"「{clean}」是保留名，换一个"
        if len(clean) > cls.CUSTOM_PRESET_MAX:
            return False, f"预设名太长（上限 {cls.CUSTOM_PRESET_MAX} 字符）"
        snapshot_flags = {
            category: bool((flags or {}).get(category, False)) for category in cls.CATEGORY_NAMES
        }
        snapshot_weights = {
            category: float((weights or {}).get(category, 1.0)) for category in cls.CATEGORY_NAMES
        }
        presets = cls.custom_presets()
        presets[clean] = {"flags": snapshot_flags, "weights": snapshot_weights}
        cls._write_custom_presets(presets)
        return True, f"已保存预设「{clean}」"

    @classmethod
    def delete_custom_preset(cls, name):
        """删除一个自定义预设。返回 ``(ok, message)``。"""
        clean = str(name or "").strip()
        presets = cls.custom_presets()
        if clean not in presets:
            return False, f"没有自定义预设「{clean}」"
        presets.pop(clean)
        cls._write_custom_presets(presets)
        return True, f"已删除预设「{clean}」"

    @classmethod
    def ui_meta(cls):
        """面板需要的元数据：分类表 / 预设表 / 自定义预设 / 默认关闭的分类。"""
        return {
            "categories": list(cls.CATEGORY_NAMES),
            "legacy_count": LEGACY_CATEGORY_COUNT,
            "preset_none": cls.PRESET_NONE,
            "default_off": list(cls.DEFAULT_OFF_CATEGORIES),
            "custom_presets": cls.custom_preset_names(),
            "presets": {
                name: {
                    "off": list(spec.get("off") or ()),
                    "only": list(spec.get("only") or ()),
                }
                for name, spec in cls.PRESETS.items()
            },
            "groups": cls._group_meta(),
        }

    @classmethod
    def INPUT_TYPES(cls):
        # ⚠️ 控件顺序即兼容性契约：ComfyUI 按 INPUT_TYPES 顺序序列化
        # widgets_values，旧工作流里已保存的数组按位置还原。
        # 因此**前 12 个分类开关必须留在 required 且顺序不变**，
        # 其余新增控件（8 个开关 / 8 个权重 / 预设 / 主题剔除）
        # 一律追加到 optional 的最末尾。
        legacy_switches = {
            category: ("BOOLEAN", {"default": False, "label_on": "选中", "label_off": "未选"})
            for category in cls.CATEGORY_NAMES[:LEGACY_CATEGORY_COUNT]
        }
        # 新增分类默认 **True**：这些词原本躺在「未归类词」里并被输出，
        # 若默认 False，升级后角色名/版权词会静默消失（破坏性变更）。
        # 例外：DEFAULT_OFF_CATEGORIES（审查遮挡词 / 文字水印词）是负面词类，默认关闭。
        new_switches = {
            category: ("BOOLEAN", {
                "default": category not in cls.DEFAULT_OFF_CATEGORIES,
                "label_on": "选中",
                "label_off": "未选",
            })
            for category in cls.CATEGORY_NAMES[LEGACY_CATEGORY_COUNT:]
        }
        weight_spec = lambda category: (  # noqa: E731
            "FLOAT",
            {
                "default": 1.0,
                "min": cls.CATEGORY_WEIGHT_MIN,
                "max": cls.CATEGORY_WEIGHT_MAX,
                "step": 0.05,
                "round": 0.05,
                "tooltip": f"{category} Tag 权重；1.0 保持原样，范围 0.05–2.0",
            },
        )
        return {
            "required": {
                **legacy_switches,
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
                        "tooltip": "统一输入：接入 WD14 / Packer / 任意来源的标签串；已知 Danbooru Tag 会自动分类，未知段落可选择保留。",
                    },
                ),
                # ⚠️ 这两个 BOOLEAN 是「自然语言模块」的**遗留占位**：前端 UI 与判定逻辑
                # 都已移除，节点固定为「自然语言原样保留、不套用标签排除规则」。
                # **不能删** —— 它们位于 INPUT_TYPES 中段，删掉会让旧工作流的
                # widgets_values 从这里开始整体前移，权重 / preset / 主题剔除全部错位
                # （与 natural_mode 同一个坑，见 optional 末尾注释）。前端已把它们隐藏。
                "include_natural_language": ("BOOLEAN", {"default": True}),
                "filter_natural_language": ("BOOLEAN", {"default": False}),
                **{
                    input_name: weight_spec(category)
                    for category, input_name in cls.LEGACY_WEIGHT_INPUTS.items()
                },
                # ────────── 以下为新增控件，必须保持在最末尾 ──────────
                **new_switches,
                **{
                    input_name: weight_spec(category)
                    for category, input_name in cls.NEW_WEIGHT_INPUTS.items()
                },
                "preset": (
                    # ⚠️ 必须是 STRING 而不是 COMBO：旧工作流没有这个控件，
                    # ComfyUI 会用 ""（空字符串）补足缺失的 widgets_values，
                    # 而 COMBO 的校验要求值必须落在选项列表内 → 直接报
                    # "Value not in list: preset: ''" 并让整个节点 Output will be ignored。
                    # 用 STRING 后空值可安全通过，前端仍把它渲染成下拉选择。
                    "STRING",
                    {
                        "default": cls.PRESET_NONE,
                        "multiline": False,
                        "tooltip": "场景预设：一键切换整套分类开关（前端为下拉选择；留空视为不用预设）",
                        # 前端面板的唯一数据源：分类表 / 预设表 / 主题组都在这里，
                        # ComfyUI 的 /object_info 会原样带出去（server.py: node_info）。
                        # 前端不再自己抄一份常量，改后端即改 UI。
                        "tk_ui": cls.ui_meta(),
                    },
                ),
                # ⚠️ 主题剔除模块已按用户要求（2026-09-14）整体移除：这两个控件**保留占位**
                # （删掉会让旧工作流 widgets_values 整体错位），但后端不再读、前端不再渲染。
                "exclude_groups": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "已废弃：主题剔除模块已移除，本控件仅为旧工作流占位",
                    },
                ),
                "exclude_groups_custom": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "已废弃：主题剔除模块已移除，本控件仅为旧工作流占位",
                    },
                ),
                # ⚠️⚠️ 新增控件必须追加在这里 —— INPUT_TYPES 的顺序就是 widgets_values
                # 的位置契约。把控件插在中间会让它后面所有控件整体错位
                # （2.13.0 的 natural_mode 一度插在 include/filter 之间，旧工作流的布尔值
                # 被它接收 → AttributeError，10 个工作流实例同时报错，穷举脚本抓到）。
                #
                # 2026-09-13：自然语言的 UI 模块（下拉 + 两个复选框）已按用户要求整体移除，
                # 行为固定为**保留（不过滤）**。但控件本身**一个都没删**：
                # 前端把这三个藏起来不渲染，后端也不再读它们的值，纯粹当位置占位。
                # 原因：删除控件会让旧工作流的 widgets_values 长度对不上 ——
                # 中间两个删了会整体错位，末尾这个删了则是多出一个值，而部分 ComfyUI
                # 前端版本在 configure 时没有 `if (this.widgets[i])` 保护，会直接抛异常。
                # 已有的工作流（含用户这两天在 2.13.0 上保存的）都带着这些值，不能冒险。
                "natural_mode": (
                    # 用 STRING 而非 COMBO：旧工作流缺这个控件时 ComfyUI 用 "" 补
                    # widgets_values，COMBO 的列表校验会直接让节点报
                    # "部分输入值不适用于该节点"。
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "已废弃：自然语言固定为「保留（不过滤）」，本控件仅为旧工作流占位",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("Tag String",)
    FUNCTION = "get_tags"
    CATEGORY = "TK/text"
    DESCRIPTION = "单一 Prompt 输入自动分类 Danbooru Tag，自然语言原样保留；兼容 Packer 分类包"

    @staticmethod
    def _normalise_tag(value):
        """归一化键：小写 + 下划线转空格 + **去掉转义反斜杠**。

        委托给 anima_tag_taxonomy.normalise，保证运行侧与索引构建侧完全一致。
        去转义那一步是关键：WD14 在 replace_underscore=False（其默认值）时会输出
        ``plana_\\(blue_archive\\)``，而索引里存的是 ``plana (blue archive)``；
        不处理的话角色 tag 整族查不到 —— 而角色身份正是「换角色」的核心。
        """
        return normalise(value)

    @classmethod
    def _prompt_tag_keys(cls, value):
        """返回原始 Tag、括号强调/权重 Tag 的统一查找键。"""
        return tag_lookup_keys(value)

    @classmethod
    def _category_weight(cls, category_flags, category):
        """读取并限制分类权重；缺失/非法/旧工作流的 0 按 1.0 处理。

        分类是否参与由对应 BOOLEAN 开关决定，0 作为分类权重没有实际用途，
        且旧工作流在新增 FLOAT 控件后可能把未保存值还原为 0；让它回到中性
        权重可避免生成 ``(tag:0)`` 这类下游无法接受的提示词。
        """
        raw = category_flags.get(cls.WEIGHT_INPUTS[category], 1.0)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = 1.0
        if value <= 0:
            value = 1.0
        value = max(cls.CATEGORY_WEIGHT_MIN, min(cls.CATEGORY_WEIGHT_MAX, value))
        value = round(value / 0.05) * 0.05
        return 1.0 if value <= 0 else value

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
        weighted = WEIGHT_RE.fullmatch(raw)
        if weighted:
            base = weighted.group(1).strip()
            try:
                weight *= float(weighted.group(2))
            except ValueError:
                base = raw
        else:
            base = raw
        return f"({base}:{cls._format_weight(weight)})"

    # ── 分类索引（自建，见 anima_tag_taxonomy） ──
    # 旧实现读取第三方插件 ComfyUI-Danbooru-Tag-Sorter-Node 的 xlsx +
    # defaults_config.json 并自带一套 fallback 猜测；现已整体替换为自建索引。
    # 判定优先级（官方 category → 结构规则 → cosplay → 中文语义路径 → 命名模式）
    # 全部在 tools/build_tag_taxonomy.py 里离线完成，运行时只做 O(1) 查表。
    # 索引实例由 anima_tag_taxonomy.shared_taxonomy() 提供：三个 TK 文本节点共用一份，
    # 不再各自加载（9.4MB 索引被解析三遍是纯粹的浪费）。
    # 测试注入点：设置 _TAXONOMY_OVERRIDE 后直接返回它，不加载真实索引。
    _TAXONOMY_OVERRIDE = None

    @classmethod
    def _taxonomy(cls):
        return taxonomy_for(cls)

    @classmethod
    def _lookup_tag(cls, piece):
        """返回 (分类名, 语义组元组)；索引未收录时返回 (None, ())。

        统一成 tuple 是为了让调用方可以直接解包/取下标 ——
        TagTaxonomy.lookup 未命中时返回 None（区分"未收录"与"归到未归类词"）。
        """
        hit = cls._taxonomy().lookup(piece)
        return hit if hit else (None, ())

    # ── 场景预设 ──

    @classmethod
    def _coerce_flag(cls, category, raw_value):
        """把控件值转成布尔，并对旧工作流补足的**空值**做语义修正。

        旧工作流里没有新增分类的控件，ComfyUI 会用空字符串补足缺失的
        ``widgets_values``；对 BOOLEAN 而言 `""` 会退化成 False，这与
        "新增分类默认开启（保证升级不丢标签）"的设计相悖 —— 角色名/版权词会静默消失。
        所以新增分类的空值一律视为 True；旧分类保持原语义（空值 = False）。

        前端 widget 也会做同样的修正，两处都做是为了覆盖 API 直连调用的场景。
        """
        if raw_value is None or raw_value == "":
            # 空值 = 旧工作流补位：按「该分类的默认值」处理
            # （负面词类 DEFAULT_OFF_CATEGORIES 默认关，其余新增分类默认开）
            return (category in cls.NEW_CATEGORY_NAMES
                    and category not in cls.DEFAULT_OFF_CATEGORIES)
        if isinstance(raw_value, str):
            return raw_value.strip().lower() not in {"", "0", "false", "off", "no", "none"}
        return bool(raw_value)

    @classmethod
    def _apply_preset(cls, preset_name, category_flags):
        """把预设展开成完整的分类开关字典。

        支持两种预设：
        * **内置**（``cls.PRESETS``）：只声明 ``off`` / ``only`` 规则；
        * **自定义**（``data/tag_presets.json``）：存的是用户保存的完整开关快照 + 权重。

        只改开关状态，不引入任何隐藏状态 —— 展开结果会写回各 BOOLEAN 控件，
        因此工作流保存后就是一份普通的开关快照，行为可预期、可手改。

        ⚠️ 必须从 ``dict(category_flags)`` 复制而不是重建：``category_flags``
        里除了分类布尔值还带着 ``<分类>_weight`` 键，重建会把权重全部丢掉，
        导致所有分类权重静默失效。
        """
        flags = dict(category_flags)
        for category in cls.CATEGORY_NAMES:
            flags[category] = cls._coerce_flag(category, category_flags.get(category))
        spec = cls.PRESETS.get(preset_name)
        if spec is None:
            custom = cls.custom_presets().get(str(preset_name or "").strip())
            if custom:
                return cls._apply_custom_preset(custom, flags)
            spec = {}
        if "only" in spec:
            allowed = set(spec["only"])
            for category in cls.CATEGORY_NAMES:
                flags[category] = category in allowed
        for category in spec.get("off", ()):
            if category in flags:
                flags[category] = False
        return flags

    @classmethod
    def _apply_custom_preset(cls, preset, flags):
        """应用自定义预设快照：开关 + 权重一起还原（权重键与控件名同名）。"""
        snapshot = preset.get("flags") or {}
        for category in cls.CATEGORY_NAMES:
            if category in snapshot:
                flags[category] = bool(snapshot[category])
        for category, value in (preset.get("weights") or {}).items():
            input_name = cls.WEIGHT_INPUTS.get(category)
            if input_name and isinstance(value, (int, float)):
                flags[input_name] = float(value)
        return flags

    # ── 主题剔除：**已按用户要求整体移除**（2026-09-14）──
    # `exclude_groups` / `exclude_groups_custom` 两个控件仍留在 INPUT_TYPES 里**占位**
    # （删控件会让旧工作流的 widgets_values 整体错位，见铁律），但前端不再渲染、
    # 后端也不再读它们的值 —— 与 `natural_mode` 那三个遗留控件同一种处理方式。

    @classmethod
    def _classify_prompt(cls, value, category_flags, regex_pattern, exact_blacklist):
        """将单一 Prompt 拆成已知 Tag 分类和未知自然语言，保持段落结构。"""
        # 仅勾选“未归类词”时沿用旧工作流语义：整段输入都视为自然语言，
        # 避免升级后旧节点突然丢掉已知 Tag；勾选任一具体分类才启用自动分类。
        #
        # ⚠️ 这个判断**只看旧 12 类**（排除未归类词），不看新增的 8 类：
        # 新增分类默认开启是为了"不丢标签"，若让它参与本判断，那些只勾了
        # 「未归类词」的旧工作流会突然开始自动分类，未被勾选的分类词（如 1girl）
        # 会被丢弃 —— 那是真实的破坏性变更。让新增分类保持默认值不影响本判断，
        # 自动分类不启用时它们的内容会整段作为自然语言原样输出，同样不丢。
        legacy_active = [
            name for name in cls.CATEGORY_NAMES[:LEGACY_CATEGORY_COUNT]
            if name != "未归类词"
        ]
        if not any(category_flags.get(name, False) for name in legacy_active):
            # 自然语言一律原样保留（用户 2026-09-13 要求去掉「保留 / 过滤」这套选择）：
            # 旧版的过滤会拿标签用的 regex_blacklist 去删自然语言句子，句子含
            # hair / background 就整段消失，是「下游提示词为空」的根因。
            return [], str(value or "").strip()
        buckets = {category: [] for category in cls.CATEGORY_NAMES}
        natural_paragraphs = []
        for paragraph in re.split(r"\n\s*\n", str(value or "").strip()):
            unknown_lines = []
            for line in paragraph.splitlines() or [paragraph]:
                unknown = []
                for piece in (part.strip() for part in re.split(r"[,，]", line)):
                    if not piece:
                        continue
                    if piece.rstrip(":：").strip() in CATEGORY_NAME_SET:
                        # 外部 Packer 的 ALL_TAGS 开启注释时会带“分类名:”标题，
                        # 它们是结构标记而非内容，不应成为自然语言输出。
                        continue
                    lookup_keys = cls._prompt_tag_keys(piece)
                    if any(key in exact_blacklist for key in lookup_keys) or (regex_pattern is not None and regex_pattern.search(piece)):
                        continue
                    # 分类查表只做一次（主题剔除移除后不再需要同时取语义组）
                    category = cls._lookup_tag(piece)[0]
                    if category in CATEGORY_NAME_SET:
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
        return selected, natural

    @staticmethod
    @functools.lru_cache(maxsize=64)
    def _compile_regex(regex_blacklist):
        """编译正则排除；同一模式在批量执行里会被反复请求，缓存住编译结果。"""
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
    @functools.lru_cache(maxsize=64)
    def _build_exact_blacklist(cls, tag_blacklist):
        """支持外部节点的逗号格式，同时允许在节点面板中每行填写一个 Tag。

        返回 ``frozenset``：它会被 lru_cache 共享（批量执行时同一份黑名单
        反复使用），不可变才不会让调用方意外改到缓存里的那份。
        """
        result = set()
        for tag in re.split(r"[,\r\n]+", str(tag_blacklist or "")):
            clean = tag.strip()
            if clean:
                result.add(clean.casefold())
                result.add(cls._normalise_tag(clean))
        return frozenset(result)

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

    def get_tags(self, tag_bundle=None, regex_blacklist="", tag_blacklist="", natural_language="",
                 include_natural_language=True, filter_natural_language=False,
                 preset=None, exclude_groups="", exclude_groups_custom="", natural_mode="",
                 **category_flags):
        """按分类与排除规则提取标签；自然语言段落一律原样保留。

        ``exclude_groups`` / ``exclude_groups_custom`` 与下面三个一样是**遗留形参**：
        主题剔除模块已按用户要求整体移除，值被忽略（控件仍占位，删了会让旧工作流错位）。

        ``include_natural_language`` / ``filter_natural_language`` / ``natural_mode``
        只是兼容旧工作流的**遗留形参**（控件仍在 INPUT_TYPES 里占位，ComfyUI 会照常传值），
        **不再参与任何判定**：用户明确要求删掉「保留 / 过滤 / 模式」这套重复选择，
        自然语言固定为原样输出，排除规则只作用于分类 Tag。
        """
        regex_pattern = self._compile_regex(regex_blacklist)
        exact_blacklist = self._build_exact_blacklist(tag_blacklist)
        # 场景预设：展开成完整开关表后再走原有逻辑。预设只是"批量设置开关"，
        # 展开后与手动勾选完全等价，因此不产生任何隐藏状态。
        category_flags = self._apply_preset(preset or self.PRESET_NONE, category_flags)
        selected_tags = []
        bundle_tags = []
        if not isinstance(tag_bundle, dict):
            # 单输入模式：没有结构化分类包时，直接把 Prompt 中的已知 Danbooru
            # Tag 重新分类，未识别段落作为自然语言原样输出。
            selected_tags, natural = self._classify_prompt(
                natural_language,
                category_flags,
                regex_pattern,
                exact_blacklist,
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
        # 自然语言沿用外部 Sorter 的语义，归入“未归类词”；不额外制造第 13 类。
        # 当没有 TAG_BUNDLE 时，它就是节点唯一的数据源，不能因为旧工作流
        # 没有保存分类布尔值而被静默丢弃；有分类包时仍由“未归类词”控制。
        # 这里不再有「保留自然语言」开关：自然语言永远保留（见 get_tags 文档串）。
        include_natural = (
            category_flags.get("未归类词", False)
            or (not isinstance(tag_bundle, dict) and bool(raw_natural_language))
        )
        if include_natural and raw_natural_language:
            tag_text = f"{tag_text}\n\n{raw_natural_language}" if tag_text else raw_natural_language
        return (tag_text,)


# ── 自定义预设库的 HTTP 接口（前端面板保存 / 删除预设用）──
# 预设存在插件目录的 data/tag_presets.json 里，跨工作流共用；前端只负责调用。
try:  # 脱离 ComfyUI 运行时（单测、纯逻辑导入）时不注册路由
    from aiohttp import web
    from server import PromptServer
except ImportError:  # pragma: no cover
    PromptServer = None
    web = None


if PromptServer is not None and web is not None and getattr(PromptServer, "instance", None):

    @PromptServer.instance.routes.get("/anima/tag_presets")
    async def anima_tag_presets_list(request):  # noqa: ARG001
        node = AnimaTKDanbooruTagGetter
        return web.json_response({
            "ok": True,
            "names": node.custom_preset_names(),
            "presets": node.custom_presets(),
        })

    @PromptServer.instance.routes.post("/anima/tag_presets")
    async def anima_tag_presets_update(request):
        node = AnimaTKDanbooruTagGetter
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"ok": False, "message": "请求体不是合法 JSON"}, status=400)
        if not isinstance(payload, dict):
            return web.json_response({"ok": False, "message": "请求体必须是对象"}, status=400)
        action = str(payload.get("action") or "save").strip().lower()
        if action == "delete":
            ok, message = node.delete_custom_preset(payload.get("name"))
        else:
            ok, message = node.save_custom_preset(
                payload.get("name"), payload.get("flags"), payload.get("weights"))
        return web.json_response(
            {"ok": ok, "message": message, "names": node.custom_preset_names()},
            status=200 if ok else 400,
        )


NODE_CLASS_MAPPINGS = {
    AnimaTKDanbooruTagGetter.NODE_ID: AnimaTKDanbooruTagGetter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaTKDanbooruTagGetter.NODE_ID: AnimaTKDanbooruTagGetter.DISPLAY_NAME,
}
