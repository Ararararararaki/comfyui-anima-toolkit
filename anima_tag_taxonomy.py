"""TK 标签分类索引 —— 纯逻辑层，零 ComfyUI 依赖，可独立单测。

数据来源：``data/tag_taxonomy.tsv.gz``（由 ``tools/build_tag_taxonomy.py`` 离线构建）。
该索引的权威性来自 Danbooru 官方 API 的 ``category`` 与 ``post_count`` 字段，
**不再依赖任何第三方插件目录**（旧实现读取 ComfyUI-Danbooru-Tag-Sorter-Node 的
xlsx + defaults_config.json，实测未安装时分类退化到 98.6% 未归类）。

索引格式（gzip 压缩的 TSV）::

    第 1 行: #{"version":1,"categories":[...],"groups":[...],"tag_count":N,...}
    其余行 : name \\t category_id \\t official_category \\t post_count \\t zh_names \\t groups

其中 ``name`` 是**归一化键**：小写 + 下划线转空格 + 去掉转义反斜杠。
后一步是必须的 —— WD14 Tagger 在 ``replace_underscore=False``（其默认值）时会输出
``plana_\\(blue_archive\\)``，而索引里存的是 ``plana (blue archive)``。

分类体系：前 12 类沿用原插件的名字与顺序（旧工作流的 UI 基线），后 8 类为新增。
语义标签组与分类**正交**：分类回答「这是什么」，组回答「这属于哪个主题」
（用于「剔除 furry / 剔除巨乳」这类按主题整族剔除）。
"""

import functools
import gzip
import json
import os
import pickle
import re
import threading
import time

# ── 分类体系：前 12 个的名字与顺序即旧行为基线，禁止改动 ──
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
    # 新增（追加在末尾，避免打乱旧工作流的控件索引）
    "角色身份词",
    "作品版权词",
    "发色发型词",
    "亚人特征词",
    "审查遮挡词",
    "文字水印词",
    "质量元词",
    "物件道具词",
)
LEGACY_CATEGORY_COUNT = 12

#: 分类名的集合视图：查表热路径里要反复判「这个片段是不是分类标题」，
#: ``in tuple`` 是线性扫描（20 项，实测比 frozenset 慢 2.4 倍），这里换成 O(1)。
CATEGORY_NAME_SET = frozenset(CATEGORY_NAMES)

# 权重可调的分类（未归类词不参与加权：它承载自然语言与未知词，加权无意义）
WEIGHTABLE_CATEGORIES = tuple(CATEGORY_NAMES[:LEGACY_CATEGORY_COUNT])

INDEX_FILENAME = "tag_taxonomy.tsv.gz"
CACHE_FILENAME = "tag_taxonomy.cache"

_LOCK = threading.RLock()

# 权重语法：`(tag:1.2)` / `tag:1.2` 的拆解（三个 TK 文本节点共用同一份）
WEIGHT_RE = re.compile(r"^\(?\s*(.+?)\s*:\s*([+-]?\d+(?:\.\d+)?)\s*\)?$")
_WEIGHT_RE = WEIGHT_RE  # 旧名保留，避免外部引用断裂


@functools.lru_cache(maxsize=1 << 16)
def normalise(value):
    """归一化成索引键：小写 + 下划线转空格 + 去掉转义反斜杠。

    去掉转义是必须的：WD14 在 ``replace_underscore=False`` 时输出
    ``plana_\\(blue_archive\\)``，索引里是 ``plana (blue archive)``。
    不处理的话角色 tag 会整体查不到 —— 而角色身份正是「换角色」场景的核心。

    ``lru_cache``：纯函数，且同一标签在一次执行里会被判三四次
    （黑名单 / 主题剔除 / 分类查表各一次），批量出图时重复率更高。
    """
    text = str(value or "").strip().casefold().replace("_", " ")
    return text.replace("\\(", "(").replace("\\)", ")").replace("\\", "")


@functools.lru_cache(maxsize=1 << 16)
def tag_lookup_keys(value):
    """返回一个标签片段可能对应的所有索引键（原形 + 去权重后的本体）。

    ``lru_cache`` 同上：热路径里同一片段会被重复求键。
    """
    raw = str(value or "").strip()
    if not raw:
        return ()
    keys = [normalise(raw)]
    weighted = _WEIGHT_RE.match(raw)
    if weighted:
        keys.append(normalise(weighted.group(1)))
    return tuple(dict.fromkeys(key for key in keys if key))


class TagTaxonomy:
    """标签分类索引（懒加载 + 磁盘缓存 + 线程安全）。"""

    def __init__(self, plugin_dir, index_path=None, cache_path=None):
        self.plugin_dir = plugin_dir
        self.index_path = index_path or os.path.join(plugin_dir, "data", INDEX_FILENAME)
        self.cache_path = cache_path or os.path.join(plugin_dir, "data", CACHE_FILENAME)
        self._entries = None
        self._metadata = {}
        self._groups = []
        self._load_stats = {}

    # ── 加载 ──

    def _signature(self):
        try:
            stat = os.stat(self.index_path)
            return (int(stat.st_mtime), int(stat.st_size))
        except OSError:
            return None

    def load(self):
        """加载索引；优先命中 pickle 缓存，未命中则解析 TSV 并回写缓存。"""
        with _LOCK:
            if self._entries is not None:
                return self

            started = time.time()
            signature = self._signature()
            cached = self._load_cache(signature) if signature else None

            if cached is not None:
                self._metadata, self._entries, self._groups = cached
                self._load_stats = {"source": "cache", "seconds": time.time() - started}
                return self

            self._parse_index()
            self._save_cache(signature)
            self._load_stats = {"source": "index", "seconds": time.time() - started}
            return self

    def _parse_index(self):
        """解析 gzip TSV。索引不存在时降级为空索引（不抛异常，节点仍可用）。"""
        entries = {}
        metadata = {}
        if not os.path.isfile(self.index_path):
            self._metadata, self._entries, self._groups = {}, {}, []
            self._load_stats = {"source": "missing", "seconds": 0.0}
            return
        with gzip.open(self.index_path, "rt", encoding="utf-8") as handle:
            first = handle.readline()
            if first.startswith("#"):
                try:
                    metadata = json.loads(first[1:])
                except ValueError:
                    metadata = {}
            for line in handle:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 6:
                    continue
                try:
                    category = int(parts[1])
                    official = int(parts[2])
                    count = int(parts[3])
                except ValueError:
                    continue
                groups = tuple(part for part in parts[5].split(",") if part)
                entries[parts[0]] = (category, official, count, parts[4], groups)
        self._metadata = metadata
        self._entries = entries
        self._groups = list(metadata.get("groups") or [])

    def _load_cache(self, signature):
        if signature is None:
            return None
        try:
            with open(self.cache_path, "rb") as handle:
                payload = pickle.load(handle)
        except Exception:
            return None
        if not isinstance(payload, dict) or payload.get("signature") != signature:
            return None
        entries = payload.get("entries")
        if not isinstance(entries, dict):
            return None
        return payload.get("metadata") or {}, entries, payload.get("groups") or []

    def _save_cache(self, signature):
        """缓存写盘失败不影响功能（只读安装/磁盘满时静默跳过）；原子替换防半写。"""
        if signature is None:
            return
        tmp_path = self.cache_path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self.cache_path), exist_ok=True)
            with open(tmp_path, "wb") as handle:
                pickle.dump({
                    "signature": signature,
                    "metadata": self._metadata,
                    "entries": self._entries,
                    "groups": self._groups,
                }, handle, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp_path, self.cache_path)
        except Exception:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except OSError:
                pass

    # ── 查询 ──

    @property
    def ready(self):
        return self._entries is not None

    @property
    def size(self):
        return len(self._entries or {})

    @property
    def groups(self):
        return list(self._groups)

    @property
    def metadata(self):
        return dict(self._metadata)

    @property
    def load_stats(self):
        return dict(self._load_stats)

    @property
    def categories(self):
        """索引自带的分类名（应与 CATEGORY_NAMES 一致；不一致说明索引版本过期）。"""
        return list(self._metadata.get("categories") or CATEGORY_NAMES)

    def lookup(self, value):
        """返回 (分类名, 组元组) 或 None（未收录）。

        未收录不等于错误 —— 未知词应落到「未归类词」由调用方决定如何处理。
        """
        if self._entries is None:
            self.load()
        for key in tag_lookup_keys(value):
            entry = self._entries.get(key)
            if entry is not None:
                category = entry[0]
                name = CATEGORY_NAMES[category] if 0 <= category < len(CATEGORY_NAMES) else "未归类词"
                return name, entry[4]
        return None

    def category_of(self, value):
        hit = self.lookup(value)
        return hit[0] if hit else None

    def groups_of(self, value):
        hit = self.lookup(value)
        return hit[1] if hit else ()

    def match_groups(self, value, group_ids):
        """该标签是否属于给定的任一组（用于按主题剔除）。"""
        if not group_ids:
            return False
        hit = self.lookup(value)
        if not hit:
            return False
        return any(group in group_ids for group in hit[1])


# ══════════════════════════════════════════════════════════════════════════
# 共享运行时：三个 TK 文本节点（Tag Getter / Anima 格式化 / 提示词扩写）
# 过去各自实现了一份「加载索引 / 查分类 / 归一化标签 / 按空行切分输入」，
# 同一份 9.4 MB 索引被解析并驻留三份。这里收敛成唯一实现 —— 改一处即可。
# ══════════════════════════════════════════════════════════════════════════

#: 插件根目录（索引与 data/ 的相对基准）
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))

#: 标签段与自然语言段的分隔符。**这是节点间的输出/输入契约**：
#: Tag Getter 用它输出，Anima 格式化与提示词扩写用它切分。改这里等于改三个节点。
NATURAL_GAP = "\n\n"

_SHARED_TAXONOMY = None


def shared_taxonomy():
    """进程级共享索引实例。

    索引是只读的（加载后不再变化），跨节点复用安全；三个节点各持一份只会
    让同一份 693k 标签的表在内存里存三遍。

    读路径走**双检锁的无锁快路径**：实例一旦就绪就不再碰锁 ——
    查表热路径上每个标签都会取一次索引（实测 122 次/执行），
    每次都进 RLock 是纯粹的浪费。
    """
    global _SHARED_TAXONOMY
    taxonomy = _SHARED_TAXONOMY
    if taxonomy is not None:
        return taxonomy
    with _LOCK:
        if _SHARED_TAXONOMY is None:
            _SHARED_TAXONOMY = TagTaxonomy(PLUGIN_DIR).load()
        return _SHARED_TAXONOMY


def taxonomy_for(owner, override_attr="_TAXONOMY_OVERRIDE"):
    """节点类取索引入口。

    ``<NodeClass>._TAXONOMY_OVERRIDE`` 是历史留存的**测试注入点**，
    保留它可以让既有单测（FakeTaxonomy）继续工作，不必改测试。
    """
    override = getattr(owner, override_attr, None)
    if override is not None:
        return override
    return shared_taxonomy()


def category_of(owner, value, override_attr="_TAXONOMY_OVERRIDE"):
    """标签 → 分类名；未收录返回 None（未收录 ≠ 错误，交给调用方决定去向）。"""
    try:
        hit = taxonomy_for(owner, override_attr).lookup(value)
    except AttributeError:
        return None
    return hit[0] if hit else None


def normalise_spaces(value):
    """去转义 + 下划线转空格 + 压空白，**保留原始大小写**。

    与 ``normalise`` 的唯一差别是大小写：``normalise`` 用于查表（必须 casefold），
    本函数用于要保留书写形态的输出路径（例如扩写节点写自然语言）。
    """
    text = str(value or "").strip()
    if not text:
        return ""
    text = text.replace("\\(", "(").replace("\\)", ")").replace("\\", "")
    return re.sub(r"\s+", " ", text.replace("_", " ")).strip()


def split_prompt(value):
    """把节点输入拆成 ``(标签片段列表, 自然语言段落列表)``。

    契约（三个节点共享）：空行之前按逗号/换行切标签，空行之后整段视为自然语言。
    这个形态正是 Tag Getter 的输出，也是 Anima 格式化与提示词扩写的输入。
    """
    raw = str(value or "").strip()
    if not raw:
        return [], []
    if NATURAL_GAP not in raw:
        return [part.strip() for part in re.split(r"[,，]", raw) if part.strip()], []
    head, tail = raw.split(NATURAL_GAP, 1)
    pieces = [part.strip() for part in re.split(r"[,，\n]", head) if part.strip()]
    paragraphs = [block.strip() for block in re.split(r"\n\s*\n", tail) if block.strip()]
    return pieces, paragraphs
