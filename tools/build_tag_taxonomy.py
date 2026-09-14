# -*- coding: utf-8 -*-
"""TK Toolkit — 构建自有标签分类索引（离线一次性工具）。

产出：``data/tag_taxonomy.tsv.gz``（随包发布，运行时零外部依赖）

## 为什么重做索引

现实现从第三方插件 ``ComfyUI-Danbooru-Tag-Sorter-Node`` 读 xlsx + defaults_config.json，
导致两个已实测的问题：
  1. 该插件没装时回退到本项目 CSV，分类退化为 **98.6% 未归类词**（`blue_hair` 被归到服饰词）；
  2. 该插件装了也有 **约 80% 未归类**：`defaults_config.json` 的 mapping 只覆盖 99 个
     (category, subcategory) 组合中的 76 个，漏掉的包含 ``二次元角色``(117244)、
     ``艺术家``(20418)、``物品``(17606)、``无法分类``(22042) 四个大类。

## 分类体系

**原 12 类名字与顺序完全不变**（旧工作流的行为基线），**新增 8 类**追加在后：
  12 角色身份词  13 作品版权词  14 发色发型词  15 亚人特征词
  16 审查遮挡词  17 文字水印词  18 质量元词    19 物件道具词

## 判定优先级（从高到低）

  0. Danbooru 官方 category：4=character → 角色身份词；3=copyright → 作品版权词；
     1=artist → 画师词；5=meta → 质量元词。**这是唯一权威来源，零歧义。**
  1. 精确规则：审查遮挡词 / 文字水印词 —— 这些官方都是 general，必须模式匹配才能抓出。
  2. 中文语义路径（本项目 CSV，约 2.5 万行有 ``[大类>小类]`` 标注）+ 原 76 条 mapping 语义。
  3. 命名模式兜底：发色发型词（``*_hair``）/ 亚人特征词（``*_ears`` / horns / tail / wings / halo）。
  4. 未归类词。

用法：
    python -X utf8 tools/harvest_danbooru_tags.py --min-count 3   # 先采集
    python -X utf8 tools/build_tag_taxonomy.py                    # 再构建
    python -X utf8 tools/build_tag_taxonomy.py --report           # 只看分类分布，不写文件
"""

import argparse
import collections
import csv
import glob
import gzip
import io
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
API_JSONL = os.path.join(DATA, "_sources", "danbooru_tags_api.jsonl")
ZH_JSON = os.path.join(DATA, "danbooru_tags_zh.json")
DESC_CSV = os.path.join(DATA, "danbooru_tags_with_description_v3_modified.csv")
GROUPS_JSON = os.path.join(DATA, "tag_groups.json")
OUT_PATH = os.path.join(DATA, "tag_taxonomy.tsv.gz")

# ── 分类体系：前 12 个顺序即旧行为基线，禁止改动 ──
CATEGORIES = [
    "画师词", "背景词", "人物对象词", "角色特征词", "角色五官词", "角色部位词",
    "性征部位词", "服饰词", "动作词", "角色表情词", "镜头词", "未归类词",
    # 新增（追加在末尾，默认值在节点侧为 True 以保证"不丢标签"）
    "角色身份词", "作品版权词", "发色发型词", "亚人特征词",
    "审查遮挡词", "文字水印词", "质量元词", "物件道具词",
]
CAT_ID = {name: index for index, name in enumerate(CATEGORIES)}

OFFICIAL_NAMES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta"}

# ── 层 1：精确规则（这些官方 category 都是 general，必须靠模式匹配）──
# 优先级高于中文语义路径：路径表里 `blue hair` 被标成「时尚>发色」，
# 若直接按一级大类映射会误判为服饰词，所以结构性规则必须先跑。
STRUCTURE_RULES = [
    ("审查遮挡词", re.compile(
        r"^(censored|censored_[a-z_]+|mosaic_censoring|bar_censor|novelty_censor|"
        r"convenient_censoring|conveniently_censored|light_bar|censor_bar|pixelated|"
        r"steam_censoring|hair_censoring|shadow_censoring|object_censoring|"
        r"covered_nipples|conveniently_covered|nipple_tape|pasties|"
        r"unzensiert|uncensored_penis|uncensored)$")),
    ("文字水印词", re.compile(
        r"^(watermark|watermark_[a-z_]+|[a-z_]*_watermark|artist_name|signature|"
        r"[a-z_]*_signature|english_text|japanese_text|chinese_text|korean_text|"
        r"[a-z_]*_text|speech_bubble|thought_bubble|dialogue|translation_request|"
        r"web_address|dated|twitter_username|patreon_username|deviantart_username|"
        r"pixiv_username|[a-z_]*_username|[a-z_]*_logo|logo|commentary|"
        r"commentary_request|artist_request|source_request|tagme|"
        r"bad_twitter_id|bad_pixiv_id|bad_deviantart_id|bad_link|bad_id|"
        r"bad_source|md5_mismatch|third_party_edit|sample_watermark)$")),
    # 发型/发色：`<词>_hair` 是枚举型后缀（调研实测 5,967 条），
    # 但 `hair_ornament` / `hair_ribbon` 之类是发饰，不在此列。
    ("发色发型词", re.compile(
        r"^[a-z-]+_hair$|^[a-z-]+_haired$|^absurdly_long_hair$|"
        r"^(ahoge|bangs|braid|ponytail|twintails|hime_cut|bob_cut|drill_hair|"
        r"sidelocks|hair_intakes|hair_between_eyes|hair_over_eye|hair_over_eyes|"
        r"braided_hair|twin_braids|side_braid|french_braid|hair_bun|topknot|"
        r"mohawk|mullet|undercut|bowl_cut|flipped_hair|wavy_hair|curly_hair|"
        r"straight_hair|messy_hair|floating_hair|hair_flip)$")),
    # 亚人/非人特征：`*_ears` (1,152) / horns / tail / wings / halo
    ("亚人特征词", re.compile(
        r"^[a-z_-]+_ears$|^ears$|^[a-z_-]*_horns?$|^horns?$|^[a-z_-]*_tail$|^tail$|"
        r"^[a-z_-]*_wings?$|^wings?$|^(halo|multiple_halo|broken_halo|"
        r"pointy_ears|elf|demon_horns|dragon_horns|single_horn|"
        r"symbol-shaped_pupils|heart-shaped_pupils|slit_pupils|"
        r"fang|fangs|sharp_teeth|glowing_eyes|third_eye|tentacles?)$")),
    # 性征部位：`身体>体型` 在路径表里会被判成"角色部位词"，但胸部词应归性征
    ("性征部位词", re.compile(
        r"^(flat_chest|small_breasts|medium_breasts|large_breasts|huge_breasts|"
        r"gigantic_breasts|hyper_breasts|breasts|breast_hold|breast_press|"
        r"cleavage|underboob|sideboob|areolae?|nipples?|covered_nipples|"
        r"pectorals?|penis|pussy|testicles|anus|vagina|crotch|pubic_hair|"
        r"huge_ass|huge_butt|wide_hips|thick_thighs)$")),
    # 镜头/构图：路径表未覆盖，靠后缀 `*_focus` (366) / `*_shot`
    ("镜头词", re.compile(
        r"^(from_above|from_below|from_side|from_behind|from_front|from_outside|"
        r"close-?up|wide_shot|cowboy_shot|full_body|upper_body|lower_body|"
        r"depth_of_field|dutch_angle|straight-on|pov|"
        r"[a-z_-]+_focus|[a-z_-]+_shot|"
        r"panorama|scenery|foreshortening|perspective)$")),
    # 人数词：路径表只覆盖 6 条，实际有一整族
    ("人物对象词", re.compile(
        r"^\d+\+?(girl|boy|other)s?$|^solo(_focus)?$|"
        r"^multiple_(girls|boys|others)$|^no_humans$|^everyone$|"
        r"^(male|female)_focus$|^couple$|^group$")),
]

# ── 层 3：中文语义路径 → 分类（沿用原 76 条 mapping 的语义，只补漏项）──
# 注意：该路径表里中英文混杂（如 `Object > Prop`），所以两种写法都要匹配。
PATH_RULES = [
    (re.compile(r"^(角色|作品|系列|版权|Character|Copyright|Series)"), "作品版权词"),
    (re.compile(r"^(作者|创作者|艺术家|画师|作者简介|艺人|作家|Artist|Creator)"), "画师词"),
    (re.compile(r"^(元数据|媒体|Metadata|Meta)"), "质量元词"),
    (re.compile(r"^(姿势|动作|行为|Pose|Action|Posture)"), "动作词"),
    (re.compile(r"^(面部表情|表情|Expression)"), "角色表情词"),
    (re.compile(r"^(背景|场景|环境|设置|画面|Background|Scene|Environment|Setting)"), "背景词"),
    (re.compile(r"^(性|性能|H|NSFW|Sex)"), "性征部位词"),
    (re.compile(r"^(物件|物品|对象|Object|Item|Prop)"), "物件道具词"),
]
# 「人物」/「身体」大类的子类细分（与原 mapping 语义一致）
PERSON_SUB_RULES = [
    (("发色", "发型", "头发", "hair"), "发色发型词"),
    (("种族", "耳朵", "翅膀", "尾巴", "角", "兽", "ear", "wing", "tail", "horn", "species"), "亚人特征词"),
    (("胸", "性器官", "生殖", "breast", "genital"), "性征部位词"),
    (("眼睛", "瞳孔", "面部", "脸型", "眉", "鼻", "嘴", "牙", "舌", "颜",
      "eye", "pupil", "face", "mouth", "teeth", "tongue"), "角色五官词"),
    (("姿势", "动作", "pose", "action"), "动作词"),
    (("肩部", "腿部", "腹部", "腰部", "指甲", "身材", "皮肤", "体型", "身",
      "body", "skin", "leg", "waist", "hip"), "角色部位词"),
    (("人数", "对象", "count", "object"), "人物对象词"),
    (("身份", "职业", "年龄", "occupation", "age"), "角色特征词"),
]


def normalise(name):
    """归一化成索引键：小写 + 下划线转空格 + **去掉转义反斜杠**。

    转义那一步是必须的：WD14 Tagger 在 `replace_underscore=False`（其默认值）时会输出
    `plana_\\(blue_archive\\)` 这种形式，而索引里存的是未转义的 `plana (blue archive)`。
    不去转义的话，角色 tag 会整体查不到 —— 而角色身份正是「换角色」场景的核心。
    """
    text = str(name or "").strip().casefold().replace("_", " ")
    return text.replace("\\(", "(").replace("\\)", ")").replace("\\", "")


def synthetic_tags():
    """Anima 官方提示词的 quality / meta / year / safety 段用词（合成条目）。

    这些是 SD / Pony / Anima 生态的惯例写法，**多数并不是 Danbooru tag**
    （`masterpiece`、`best quality`、`score_9`、`year 2025` 在 Danbooru 上不存在），
    但它们是 Anima 官方 Tag order 的第一段，必须能被识别并归入「质量元词」，
    否则会掉进「未归类词」，导致质量元词开关对它们失效。

    返回 {normalised key: (name, official_category, post_count)}，category=5 即 meta。
    """
    words = [
        "masterpiece", "best quality", "good quality", "normal quality",
        "low quality", "worst quality", "amazing quality", "great quality",
        "very aesthetic", "aesthetic", "displeasing", "very displeasing",
        "newest", "recent", "mid", "early", "old",
        "safe", "sensitive", "nsfw", "explicit", "questionable",
        "absurdres", "highres", "lowres", "jpeg artifacts", "official art",
        "anime screenshot", "rating safe", "rating questionable",
        "rating sensitive", "rating explicit",
    ]
    words += [f"score_{index}" for index in range(1, 10)]
    words += [f"year {year}" for year in range(2015, 2031)]
    return {normalise(word): (word, 5, 0) for word in words}


def category_patches():
    """上游仍在输出、但 Danbooru 已改名 / deprecate 的词，直接钉死分类。

    实测依据：WD14 Tagger 会输出 `silver_hair`，而 Danbooru 上它是
    ``is_deprecated=true`` 且**没有 active alias**（规范 tag 是 `grey_hair`），
    因此既进不了官方 category 也进不了别名解析，会掉进「未归类词」。
    这类词数量不多但都是反推链路的高频词，逐个钉死比引入整套旧词表更可控。

    分类按本项目的体系给出（不是 Danbooru 官方 category）。
    """
    return {
        # 发色（旧名 / 美式拼写）
        "silver hair": "发色发型词",
        "gray hair": "发色发型词",
        "gray eyes": "角色五官词",
        "silver eyes": "角色五官词",
        # 瞳色别名（Danbooru 归一到 yellow_eyes，但上游常直接输出）
        "amber eyes": "角色五官词",
        "golden eyes": "角色五官词",
        "hazel eyes": "角色五官词",
        # 光影词（Anima / SD 生态惯例写法，Danbooru 上多为 0 使用）
        "soft lighting": "背景词",
        "soft shadows": "背景词",
        "ambient lighting": "背景词",
        "cinematic lighting": "背景词",
        "rim lighting": "背景词",
        "studio lighting": "背景词",
        "natural lighting": "背景词",
        "warm lighting": "背景词",
        "cold lighting": "背景词",
        "dim lighting": "背景词",
        "indoor lighting": "背景词",
        "overhead lighting": "背景词",
        "window light": "背景词",
        "high contrast": "背景词",
        "chiaroscuro": "背景词",
        "bloom": "背景词",
        "light rays": "背景词",
        "god rays": "背景词",
        "lens flare": "背景词",
    }


def load_aliases():
    """读官方别名表：{normalised alias: normalised canonical}。"""
    path = os.path.join(DATA, "_sources", "danbooru_aliases.jsonl")
    if not os.path.isfile(path):
        return {}
    aliases = {}
    with io.open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            alias = normalise(record.get("a"))
            canonical = normalise(record.get("c"))
            if alias and canonical and alias != canonical:
                aliases[alias] = canonical
    return aliases


def expand_aliases(official, aliases, paths, max_depth=4):
    """把别名解析到规范 tag，并让它**继承规范 tag 的最终分类**。

    返回 ``{alias_key: 分类名}``（预设分类）；同时把别名条目并入 official。

    注意：必须复制**最终分类**而不是官方 category —— `anthro` 是 `furry` 的别名，
    而 `furry` 的官方 category 是 0（general），分类「亚人特征词」是规则层判出来的。
    只复制 category 的话，`anthro` 会被重新分类，落回「未归类词」。

    实测依据：WD14 会输出 `silver_hair`（Danbooru 规范 tag 是 `grey_hair`），
    不解析别名这类词就整族失效。
    """
    preset = {}
    for alias_key, canonical_key in aliases.items():
        if alias_key in official:
            continue
        target = canonical_key
        for _ in range(max_depth):
            if target in official:
                break
            next_key = aliases.get(target)
            if not next_key or next_key == target:
                target = None
                break
            target = next_key
        if not target or target not in official:
            continue
        _name, official_category, count = official[target]
        category_name = preset.get(target) or classify(target, official_category, paths.get(target))
        # 名字保留别名原形（用于输出），分类/频次沿用规范 tag
        official[alias_key] = (alias_key, official_category, count)
        preset[alias_key] = category_name
    return preset


def load_groups():
    """读语义标签组定义（data/tag_groups.json）。

    组与分类维度正交：分类回答「这是什么」，组回答「这属于哪个主题」，
    用于「剔除 furry / 剔除巨乳」这类按主题整族剔除的需求。
    """
    if not os.path.isfile(GROUPS_JSON):
        return []
    with io.open(GROUPS_JSON, encoding="utf-8") as handle:
        raw = json.load(handle)
    groups = []
    for item in raw.get("groups") or []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        # 统一成下划线形式：group_membership 会用下划线形式比对，
        # 而 normalise() 方向相反（转空格），这里不能复用它。
        tags = {str(tag).strip().casefold().replace(" ", "_")
                for tag in (item.get("tags") or []) if str(tag).strip()}
        patterns = []
        for expression in (item.get("rules") or []):
            try:
                patterns.append(re.compile(str(expression), re.IGNORECASE))
            except re.error as error:
                print(f"  !! 组 {item['id']} 的正则无效，已跳过：{expression} ({error})")
        groups.append({
            "id": str(item["id"]),
            "label": str(item.get("label") or item["id"]),
            "tags": tags,
            "patterns": patterns,
        })
    return groups


def group_membership(name, groups):
    """返回该 tag 命中的组 id 列表；精确命中优先，其次正则。"""
    norm = name.replace(" ", "_").casefold()
    hits = []
    for group in groups:
        if norm in group["tags"]:
            hits.append(group["id"])
            continue
        for pattern in group["patterns"]:
            if pattern.match(norm):
                hits.append(group["id"])
                break
    return hits


def load_official():
    """读官方采集结果（支持多个分片）：{normalised name: (preferred_name, category, post_count)}。

    官方全量 182 万条超过单查询的 page 1000 上限，所以采集是分片的
    （全局热度榜 + 按 category 定向补全），这里把它们合并。
    """
    files = sorted(glob.glob(os.path.join(DATA, "_sources", "danbooru_tags*.jsonl")))
    if not files:
        raise SystemExit(f"缺少官方采集结果：{DATA}/_sources/danbooru_tags*.jsonl\n"
                         f"请先运行 tools/harvest_danbooru_tags.py")
    result = {}
    for path in files:
        with io.open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                name = str(record.get("name") or "").strip()
                if not name or record.get("deprecated") or record.get("deleted"):
                    continue
                key = normalise(name)
                category = int(record.get("category") or 0)
                count = int(record.get("post_count") or 0)
                previous = result.get(key)
                # 同一归一化键冲突时保留频次更高者
                if previous is None or count > previous[2]:
                    result[key] = (name, category, count)
        print(f"    + {os.path.basename(path)}")
    return result


def load_paths():
    """读本项目 CSV 的 [大类>小类] 中文语义路径：{normalised name: path}。"""
    paths = {}
    if not os.path.isfile(DESC_CSV):
        return paths
    with io.open(DESC_CSV, encoding="utf-8-sig", newline="") as handle:
        for row in csv.reader(handle):
            if len(row) < 4:
                continue
            match = re.match(r"^\[([^\]]*)\]", row[3].strip())
            if match:
                paths[normalise(row[0])] = match.group(1).strip()
    return paths


def load_zh_names():
    """读中文名映射（中文→英文），反转成 {normalised english: [中文…]}。"""
    if not os.path.isfile(ZH_JSON):
        return {}
    with io.open(ZH_JSON, encoding="utf-8") as handle:
        raw = json.load(handle)
    reversed_map = collections.defaultdict(list)
    if isinstance(raw, dict):
        for zh, en in raw.items():
            if not isinstance(en, str) or not en.strip():
                continue
            reversed_map[normalise(en)].append(str(zh).strip())
    result = {}
    for key, values in reversed_map.items():
        unique = list(dict.fromkeys(values))[:3]
        result[key] = ",".join(unique)
    return result


def classify(name, official_category, path):
    """返回分类名。优先级见模块 docstring。"""
    # 层 0：官方 category —— 唯一权威来源，零歧义
    if official_category == 4:
        return "角色身份词"
    if official_category == 3:
        return "作品版权词"
    if official_category == 1:
        return "画师词"
    if official_category == 5:
        return "质量元词"

    norm = name.replace(" ", "_").casefold()

    # 层 1：结构规则（高置信度，必须先于语义路径跑）
    for category, pattern in STRUCTURE_RULES:
        if pattern.match(norm):
            return category

    # 层 1.5：`*_(cosplay)`（实测 27,820 条，官方全部是 general）。
    # 官方 implication 规则是 `*_(cosplay)` → cosplay + 对应角色 tag，
    # 所以它携带的是「角色身份」信息，换角色时必须能整体剥离。
    if norm.endswith("_(cosplay)"):
        return "角色身份词"

    # 层 2：中文语义路径（人工标注，约 2.5 万行）
    if path:
        parts = [part.strip() for part in re.split(r"\s*>\s*", path)]
        head, tail = parts[0], parts[-1]
        # 该路径表把发色/发型也放在「时尚」大类下，必须按子类拆开，
        # 否则 blue hair / twintails 会被误判成服饰词（改造前实测就是这个结果）。
        if re.match(r"^(时尚|时装|服装|服饰)", head):
            if any(key in tail for key in ("发色", "发型", "头发", "头发颜色")):
                return "发色发型词"
            return "服饰词"
        if re.match(r"^(人物|身体|角色)", head):
            for keys, target in PERSON_SUB_RULES:
                if any(key in tail for key in keys):
                    return target
            # 与原实现的兜底保持一致：未知不再猜，直接留给未归类词
            return "未归类词"
        for pattern, target in PATH_RULES:
            if pattern.match(head):
                return target

    return "未归类词"


def main():
    parser = argparse.ArgumentParser(description="构建自有标签分类索引")
    parser.add_argument("--report", action="store_true", help="只打印分布，不写文件")
    parser.add_argument("--min-count", type=int, default=0, help="只收录 post_count >= 该值的标签")
    args = parser.parse_args()

    started = time.time()
    print("=" * 74)
    print("加载数据源")
    official = load_official()
    print(f"  官方标签 (API)     : {len(official)}")
    paths = load_paths()
    print(f"  中文语义路径 (CSV) : {len(paths)}")
    zh_names = load_zh_names()
    print(f"  中文名映射         : {len(zh_names)}")
    groups = load_groups()
    print(f"  语义标签组         : {len(groups)}  " + ", ".join(g["id"] for g in groups))

    synthetic = synthetic_tags()
    added = {key: value for key, value in synthetic.items() if key not in official}
    official.update(added)
    print(f"  合成补充词 (Anima 质量/年份/安全) : {len(added)}")

    aliases = load_aliases()
    print(f"  官方别名表         : {len(aliases)}")
    preset_categories = expand_aliases(official, aliases, paths)
    print(f"  → 别名扩展新增     : {len(preset_categories)} 条（继承规范 tag 的最终分类）")

    patches = category_patches()
    patch_applied = 0
    for name, category in patches.items():
        key = normalise(name)
        if key not in official:
            official[key] = (name, 5, 0)
        if preset_categories.get(key) != category:
            preset_categories[key] = category
            patch_applied += 1
    print(f"  → 分类补丁         : {patch_applied} 条（deprecate 旧名 / Anima 惯例词）")

    # 标签宇宙：官方 ∪ 语义路径（保证 CSV 里有分类但 API 漏掉的老 tag 不丢）
    universe = set(official) | set(paths)
    if args.min_count > 0:
        universe = {key for key in universe
                    if official.get(key, ("", 0, 0))[2] >= args.min_count}
    print(f"  标签宇宙           : {len(universe)}")

    rows = []
    distribution = collections.Counter()
    layer_stats = collections.Counter()
    group_stats = collections.Counter()
    samples = collections.defaultdict(list)
    for key in universe:
        preferred, official_category, count = official.get(key, (key, 0, 0))
        # 别名条目直接沿用规范 tag 的最终分类，避免被重新分类而落回未归类词
        category = preset_categories.get(key) or classify(key, official_category, paths.get(key))
        distribution[category] += 1
        if len(samples[category]) < 6:
            samples[category].append(key)
        layer_stats[
            "official" if official_category in (1, 3, 4, 5)
            else "path" if paths.get(key)
            else "rule"
        ] += 1
        members = group_membership(key, groups)
        for group_id in members:
            group_stats[group_id] += 1
        rows.append((key, CAT_ID[category], official_category, count,
                     zh_names.get(key, ""), ",".join(members)))

    total = len(rows)
    print()
    print("=" * 74)
    print(f"分类分布（共 {total} 个标签）")
    print("=" * 74)
    for name in CATEGORIES:
        number = distribution.get(name, 0)
        marker = "+" if CATEGORIES.index(name) >= 12 else " "
        print(f" {marker} {name:<10} {number:>8}  {number / total * 100:5.2f}%   "
              + " ".join(samples.get(name, [])[:4]))
    unknown = distribution.get("未归类词", 0)
    print(f"\n  未归类词占比 {unknown / total * 100:.2f}%"
          f"   （改造前实测：装了 Packer 约 80%，没装 98.6%）")
    print(f"  判定来源分布: {dict(layer_stats)}")

    if groups:
        print()
        print("语义标签组命中规模（与分类正交，用于『剔除某主题』）：")
        for group in groups:
            number = group_stats.get(group["id"], 0)
            print(f"      {group['label']:<18} {number:>7} 个标签   ({group['id']})")

    print("\n关键探针：")
    probes = ["kisaki (blue archive)", "blue archive", "hatsune miku", "touhou",
              "blue hair", "twintails", "animal ears", "horns", "halo", "tail",
              "freckles", "tattoo", "large breasts", "abs",
              "censored", "mosaic censoring", "watermark", "english text", "signature",
              "highres", "absurdres", "year 2025", "monochrome",
              "school uniform", "thighhighs", "maid", "looking at viewer",
              "1girl", "solo", "from above", "depth of field", "backlighting",
              "standing", "smile", "classroom", "phone", "sword"]
    official_by_key = {key: value for key, value in official.items()}
    for probe in probes:
        key = normalise(probe)
        preferred, official_category, count = official_by_key.get(key, (probe, 0, 0))
        category = classify(key, official_category, paths.get(key))
        print(f"  {probe:<24} -> {category:<10} (official={OFFICIAL_NAMES.get(official_category, official_category)}, "
              f"count={count}, path={paths.get(key, '-')!r})")

    if args.report:
        print("\n--report：未写文件")
        return 0

    print()
    print("=" * 74)
    os.makedirs(DATA, exist_ok=True)
    metadata = {
        "version": 1,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "categories": CATEGORIES,
        "groups": [{"id": g["id"], "label": g["label"]} for g in groups],
        "tag_count": total,
        "source": "danbooru.donmai.us API (category, post_count) + local zh semantic paths",
        "notice": ("Tag metadata from Danbooru (danbooru.donmai.us). "
                   "Semantic category mapping and tag groups are TK Toolkit's own design."),
    }
    with gzip.open(OUT_PATH, "wt", encoding="utf-8", compresslevel=9) as handle:
        handle.write("#" + json.dumps(metadata, ensure_ascii=False, separators=(",", ":")) + "\n")
        for row in rows:
            handle.write("\t".join(str(field) for field in row) + "\n")

    size = os.path.getsize(OUT_PATH)
    print(f"已写出 {OUT_PATH}")
    print(f"  标签数 : {total}")
    print(f"  文件   : {size / 1048576:.2f} MB (gzip)")
    print(f"  耗时   : {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
