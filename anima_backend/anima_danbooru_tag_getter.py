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
        looks_like_tag_series,
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
        looks_like_tag_series,
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
    # ⚠️ 内置场景预设已按用户要求（2026-09-14）**全部移除**：用户要的是
    # "预设都归我自己管、默认预设也要能删"。现在 PRESETS 只剩"不用预设"，
    # 其余一律走自定义预设库（data/tag_presets.json，面板上可保存 / 可删除）。
    #
    # 旧工作流里 widgets_values 可能还存着已删除的内置预设名（例如"换装（再剥离服饰）"）：
    # preset 控件是 STRING 而不是 COMBO，所以不会报 "Value not in list"；
    # _apply_preset 查内置查不到、查自定义也查不到 → spec 为空 → 不覆盖任何开关，
    # 等价于"不用预设"，安全。
    #
    # 被移除的 6 条规则原文备份在
    # docs/HANDOFF-2026-09-14-二采CN升级与ACN接入.md（要恢复的话从那里抄回来，
    # 或者直接在面板上用自己的开关状态存一个自定义预设）。
    PRESETS = {
        PRESET_NONE: {},
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

        ⚠️ **显式传参优先，预设只补缺省键**（2026-09-20 修）。
        过去这里**无条件**用预设快照覆盖调用方传来的开关，于是：
        用户在面板上关掉「背景词」→ 提交值确实是 ``False``，但执行期被
        ``preset="普通过滤"``（快照里 ``背景词: true``）盖回去 ⇒
        「明明关了却还输出 simple background」，而且**面板与底栏都看不出异常**
        （报告是按覆盖后的值生成的，dropped 为空）。用户实报即此。
        现在：GUI 每次都传全量 20 个键 ⇒ 预设不再覆盖任何显式开关，名实不符的
        工作流直接以开关为准；只传 ``preset`` 名、不传开关的调用方（API/脚本）
        ``provided`` 为空 ⇒ 快照整套补上，**「选预设 = 整套套用」的能力不变**
        （该套用本身发生在前端 ``applyPreset`` 写开关那一刻）。

        只改开关状态，不引入任何隐藏状态 —— 展开结果会写回各 BOOLEAN 控件，
        因此工作流保存后就是一份普通的开关快照，行为可预期、可手改。

        ⚠️ 必须从 ``dict(category_flags)`` 复制而不是重建：``category_flags``
        里除了分类布尔值还带着 ``<分类>_weight`` 键，重建会把权重全部丢掉，
        导致所有分类权重静默失效。
        """
        # ★ 必须在下面 ``_coerce_flag`` 补全**之前**取"调用方真正传了哪些键"：
        # 补全之后 flags 恒为全量，就再也分不出"用户设的"与"预设补的"了。
        provided = {name for name in cls.CATEGORY_NAMES if name in category_flags}
        provided_weights = {name for name in cls.WEIGHT_INPUTS.values() if name in category_flags}
        flags = dict(category_flags)
        for category in cls.CATEGORY_NAMES:
            flags[category] = cls._coerce_flag(category, category_flags.get(category))
        spec = cls.PRESETS.get(preset_name)
        if spec is None:
            custom = cls.custom_presets().get(str(preset_name or "").strip())
            if custom:
                return cls._apply_custom_preset(custom, flags, provided, provided_weights)
            spec = {}
        # ⚠️ 内置「规则型」预设（only/off）**保持覆盖调用方的值** —— 与自定义快照相反。
        # 规则是"我明确要求只留这些 / 关掉这些"，本来就该压过当前开关
        # （语义由 `test_preset_off_turns_off_named_categories_only` 与
        #  `test_preset_only_turns_everything_else_off` 锁定：显式传 True 也要被 off 关掉）。
        # 自定义预设存的是"一份完整开关快照"，与用户手上的开关是**同一维度**的东西，
        # 所以只有那边改成"显式传参优先"（见 `_apply_custom_preset`）。
        if "only" in spec:
            allowed = set(spec["only"])
            for category in cls.CATEGORY_NAMES:
                flags[category] = category in allowed
        for category in spec.get("off", ()):
            if category in flags:
                flags[category] = False
        return flags

    @classmethod
    def _apply_custom_preset(cls, preset, flags, provided=None, provided_weights=None):
        """应用自定义预设快照：开关 + 权重一起还原（权重键与控件名同名）。

        ``provided`` / ``provided_weights`` = 调用方**显式**传了值的键名集合，
        它们优先于快照（见 ``_apply_preset`` 的说明）。省略时退化为旧行为（整套覆盖），
        以免任何按旧签名调用的地方（脚本、测试）语义突变。
        """
        provided = provided or set()
        provided_weights = provided_weights or set()
        snapshot = preset.get("flags") or {}
        for category in cls.CATEGORY_NAMES:
            if category in provided:
                continue
            if category in snapshot:
                flags[category] = bool(snapshot[category])
        for category, value in (preset.get("weights") or {}).items():
            input_name = cls.WEIGHT_INPUTS.get(category)
            if not input_name or input_name in provided_weights:
                continue
            if isinstance(value, (int, float)):
                flags[input_name] = float(value)
        return flags

    # ── 主题剔除：**已按用户要求整体移除**（2026-09-14）──
    # `exclude_groups` / `exclude_groups_custom` 两个控件仍留在 INPUT_TYPES 里**占位**
    # （删控件会让旧工作流的 widgets_values 整体错位，见铁律），但前端不再渲染、
    # 后端也不再读它们的值 —— 与 `natural_mode` 那三个遗留控件同一种处理方式。

    @classmethod
    def _auto_classify_active(cls, category_flags):
        """是否启用自动分类 —— **只看旧 12 类**（排除"未归类词"），不看新增的 8 类。

        新增分类默认开启是为了"不丢标签"，若让它参与本判断，那些只勾了
        「未归类词」的旧工作流会突然开始自动分类，未被勾选的分类词（如 1girl）
        会被丢弃 —— 那是真实的破坏性变更。让新增分类保持默认值不影响本判断，
        自动分类不启用时它们的内容会整段作为自然语言原样输出，同样不丢。
        """
        return any(
            category_flags.get(name, False)
            for name in cls.CATEGORY_NAMES[:LEGACY_CATEGORY_COUNT]
            if name != "未归类词"
        )

    @classmethod
    def _classify_prompt(cls, value, category_flags, regex_pattern, exact_blacklist,
                         report=None):
        """把提示词分类成 20 个桶。

        ``report`` 是**可选的诊断输出**（前端底栏用）：传入一个 dict 时，会在每个丢弃点
        记下"哪个词因为什么被丢掉"—— 类别开关关闭 / tag_blacklist 命中 / 正则命中 /
        未归类。不传就完全是原来的行为，零开销、零行为变化。
        """
        """将单一 Prompt 拆成已知 Tag 分类和未知自然语言，保持段落结构。"""
        # 仅勾选“未归类词”时沿用旧工作流语义：整段输入都视为自然语言，
        # 避免升级后旧节点突然丢掉已知 Tag；勾选任一具体分类才启用自动分类。
        # （为什么只看旧 12 类，见 `_auto_classify_active` 的文档串。）
        auto_classify = cls._auto_classify_active(category_flags)
        if report is not None:
            report["auto_classify"] = auto_classify
        if not auto_classify:
            # 自然语言一律原样保留（用户 2026-09-13 要求去掉「保留 / 过滤」这套选择）：
            # 旧版的过滤会拿标签用的 regex_blacklist 去删自然语言句子，句子含
            # hair / background 就整段消失，是「下游提示词为空」的根因。
            #
            # ⚠️ 这个分支同时意味着：**把旧 12 类全关掉时不会做任何分类**，整段原样输出。
            # 用户实测反馈过这个反直觉点（"全关 = 全过滤"是误解），底栏会显式提示。
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
                    # 诊断留痕：拆开原来的合并判断，才能区分"被黑名单丢"与"被正则丢"
                    if any(key in exact_blacklist for key in lookup_keys):
                        if report is not None:
                            report["dropped_by_blacklist"].append(piece)
                        continue
                    if regex_pattern is not None and regex_pattern.search(piece):
                        if report is not None:
                            report["dropped_by_regex"].append(piece)
                        continue
                    # 分类查表只做一次（主题剔除移除后不再需要同时取语义组）
                    category = cls._lookup_tag(piece)[0]
                    if category in CATEGORY_NAME_SET:
                        if category_flags.get(category, False):
                            buckets[category].append(piece)
                        elif report is not None:
                            report["dropped_by_category"].setdefault(category, []).append(piece)
                    else:
                        unknown.append(piece)
                        if report is not None:
                            report["unclassified"].append(piece)
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
        if report is not None:
            # 保留的词按类别记一份（底栏"✅ 保留"栏直接用它，不必再解析输出文本）。
            # **合并**而不是覆盖：双输入模式下分类包的保留词已经写进 report，
            # 空行之后若还有第二批标签，它也会从这条链路补进来。
            kept = report.setdefault("kept", {})
            for category, tags in buckets.items():
                if tags:
                    kept.setdefault(category, []).extend(tags)
        natural = "\n\n".join(natural_paragraphs)
        return selected, natural

    # ── 过滤诊断报告（前端底栏用）──

    @classmethod
    def _new_report(cls):
        """底栏报告的骨架：每个丢弃点一个桶，键名与前端渲染一一对应。"""
        return {
            "auto_classify": True,
            "kept": {},                  # {类别: [词]}
            "dropped_by_category": {},   # {类别: [词]} —— 类别开关关闭
            "dropped_by_blacklist": [],  # tag_blacklist 精确命中
            "dropped_by_regex": [],      # regex_blacklist 正则命中
            "dropped_by_dedup": [],      # 重复词
            "unclassified": [],          # 索引里查不到 → 原样进自然语言
            "natural_language": "",      # 最终原样输出的自然语言段
        }

    #: 报告里每个列表最多带这么多词，避免 ui 数据把执行历史撑大
    REPORT_ITEM_LIMIT = 40

    @classmethod
    def _finalise_report(cls, report):
        """裁剪长度并补统计数字，供前端底栏直接渲染。"""
        def clip(items):
            return list(items or [])[:cls.REPORT_ITEM_LIMIT]

        def clip_unique(items):
            # 同一个词可能从两条链路分别入账（分类包 + 空行后的第二批标签），
            # 底栏不该把 `blue sky` 列两遍 —— 保序去重后再裁剪。
            seen = set()
            unique = []
            for item in items or []:
                key = str(item).casefold()
                if key in seen:
                    continue
                seen.add(key)
                unique.append(item)
            return unique[:cls.REPORT_ITEM_LIMIT]

        trimmed = {
            "auto_classify": bool(report.get("auto_classify", True)),
            "kept": {k: clip_unique(v) for k, v in (report.get("kept") or {}).items()},
            "dropped_by_category": {k: clip(v) for k, v in
                                    (report.get("dropped_by_category") or {}).items()},
            "dropped_by_blacklist": clip(report.get("dropped_by_blacklist")),
            "dropped_by_regex": clip(report.get("dropped_by_regex")),
            "dropped_by_dedup": clip(report.get("dropped_by_dedup")),
            "unclassified": clip(report.get("unclassified")),
            "natural_language": str(report.get("natural_language") or "")[:2000],
        }
        trimmed["counts"] = {
            "kept": sum(len(v) for v in trimmed["kept"].values()),
            "dropped": (sum(len(v) for v in trimmed["dropped_by_category"].values())
                        + len(trimmed["dropped_by_blacklist"])
                        + len(trimmed["dropped_by_regex"])),
            "unclassified": len(trimmed["unclassified"]),
        }
        return trimmed

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

    @staticmethod
    def _split_off_tag_series(text):
        """挑出「看起来是另一批标签」的空行段落，返回 ``(标签批文本, 剩余自然语言)``。

        共享契约 ``split_prompt`` 把空行之后整段当自然语言，而这里的自然语言是
        **原样输出**、既不过滤也不分类。用户常把两批不同来源的标签直接粘在一起，
        于是第二批整段被当成句子吐出去 —— 症状就是「第二批标签不过滤、不分类」。

        判据与 TK Anima 格式化 / 提示词扩写共用（``anima_tag_taxonomy.looks_like_tag_series``）。
        本节点的输入直接接画廊 / Packer / 反推的输出，所以判据**必须保守**：
        宁可漏拆一批标签（原样输出，一个词都不丢），也不能把真正的句子拆成标签。
        """
        batch, natural = [], []
        for block in re.split(r"\n\s*\n", str(text or "").strip()):
            if not block.strip():
                continue
            (batch if looks_like_tag_series(block) else natural).append(block.strip())
        return ", ".join(batch), "\n\n".join(natural)

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
        report = self._new_report()
        if not isinstance(tag_bundle, dict):
            # 单输入模式：没有结构化分类包时，直接把 Prompt 中的已知 Danbooru
            # Tag 重新分类，未识别段落作为自然语言原样输出。
            selected_tags, natural = self._classify_prompt(
                natural_language,
                category_flags,
                regex_pattern,
                exact_blacklist,
                report,
            )
            tag_text = ", ".join(selected_tags)
            if natural:
                tag_text = f"{tag_text}\n\n{natural}" if tag_text else natural
            report["natural_language"] = natural
            # ⚠️ ui 通道的**每个值必须是 list** —— ComfyUI execution.py:411 用
            # `ui = {k: [y for x in uis for y in x[k]] for k in uis[0].keys()}`
            # 把多次调用的同名 ui 值拼成一个列表（它假定值是 list）。
            # 直接传 dict 会被 `for y in dict` 迭代成 **keys 列表**，前端拿到的就是
            # `['auto_classify','kept',…]`，所有字段 undefined、底栏退化成兜底文案
            # （用户 2026-09-20 实报"过滤诊断没有任何内容输出"，真机 executed 事件实测
            # outputKeys=["tk_filter_report"] / tkType="array"）。包一层 list 才合规。
            return {"ui": {"tk_filter_report": [self._finalise_report(report)]},
                    "result": (tag_text,)}
        else:
            result = []
            seen = set()
            for category in self.CATEGORY_NAMES:
                # 外部 Sorter 当前的真实结构是 dict[str, str]；缺失/空值直接跳过。
                category_value = tag_bundle.get(category)
                for tag in self._iter_category_tags(category_value) or ():
                    bundle_tags.append(tag)
                    if not category_flags.get(category, False):
                        report["dropped_by_category"].setdefault(category, []).append(tag)
                        continue
                    if tag.casefold() in exact_blacklist:
                        report["dropped_by_blacklist"].append(tag)
                        continue
                    if regex_pattern is not None and regex_pattern.search(tag):
                        report["dropped_by_regex"].append(tag)
                        continue
                    dedupe_key = tag.casefold()
                    if dedupe_key in seen:
                        report["dropped_by_dedup"].append(tag)
                        continue
                    seen.add(dedupe_key)
                    result.append((tag, category))
                    report["kept"].setdefault(category, []).append(tag)
            # 保留未加权原文给双输入去重逻辑使用，避免权重包裹后无法识别 ALL_TAGS 中的前置 Tag。
            selected_tags = [tag for tag, _category in result]
            tag_text = ", ".join(
                self._apply_category_weight(tag, category, category_flags)
                for tag, category in result
            )

        raw_natural_language = self._natural_language_tail(natural_language, selected_tags)
        raw_natural_language = self._remove_bundle_tags(raw_natural_language, bundle_tags)
        # 空行之后若其实是「另一批标签」（用户常把两批标签粘在一起），也参与分类过滤，
        # 而不是整段当自然语言原样吐出去。真正的句子照旧原样保留（见 _split_off_tag_series）。
        # 单输入模式不走这里 —— `_classify_prompt` 本来就逐段分类；
        # 未启用自动分类时也整段跳过，保持「一个词都不动」的旧语义。
        if self._auto_classify_active(category_flags):
            batch_text, raw_natural_language = self._split_off_tag_series(raw_natural_language)
            if batch_text:
                batch_tags, batch_natural = self._classify_prompt(
                    batch_text, category_flags, regex_pattern, exact_blacklist, report)
                # 与分类包里已选标签**跨去重**：同一个词不该在输出里出现两次。
                existing = {self._normalise_tag(tag).casefold() for tag in selected_tags}
                for tag in batch_tags:
                    key = self._normalise_tag(tag).casefold()
                    if key in existing:
                        continue
                    existing.add(key)
                    tag_text = f"{tag_text}, {tag}" if tag_text else tag
                if batch_natural:
                    raw_natural_language = (
                        f"{raw_natural_language}\n\n{batch_natural}"
                        if raw_natural_language else batch_natural
                    )
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
        # ⚠️ 双输入模式（接了 Danbooru Tag Sorter）此前**只回裸 tuple** ⇒ 前端 executed 事件
        # 取不到 ui.tk_filter_report，面板底部「过滤诊断」永远停在"尚未执行"占位
        # （用户 2026-09-20 实报"过滤诊断没有任何内容输出"）。
        # ui 通道是 ComfyUI 把执行期数据回传前端的**唯一**方式，因此两条返回路径必须同形；
        # 形状从 (text,) 变成 {"ui": …, "result": (text,)} 是安全的 —— 单输入模式一直是后者。
        report["natural_language"] = raw_natural_language
        # 见单输入分支的注释：ui 值必须是 list（ComfyUI 会按 list 展平）。
        return {"ui": {"tk_filter_report": [self._finalise_report(report)]},
                "result": (tag_text,)}


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
