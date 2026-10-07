# -*- coding: utf-8 -*-
"""AnimaDex 角色库：**浮窗用的提示词素材源**（不是图源）。

## 定位（2026-09-26，YG 明确要求）

「AnimaDex 的角色选取**作为浮窗进行基础的提示词添加，而不是作为图源**，方便进行人物的替换」。

因此本模块**不注册任何 GallerySource**（不进 `/anima/gallery/sources`、不参与画廊图源下拉），
只提供「查角色 → 拿提示词素材」的能力，由前端浮窗消费。

## 数据来源（本地打底 + 后台刷新，YG 选定）

1. **本地快照打底**：`anima_animadex.json.gz`（随包下发，2.77 MB / 36,488 角色，
   实测 100% 有 `trigger`、100% 有预览图）。放**插件根目录且 `anima_` 前缀**是刻意的 ——
   内置更新链的发布白名单只认 `anima_*/services/web/app`，`data/` 被整个排除，
   放 data/ 老用户点更新拿不到。
2. **后台刷新**：`refresh_async()` 拉 AnimaDex 公开 API 的最新热门页，合并更新本地缓存
   （不阻塞、失败不影响本地打底）。

## 站点实测（2026-09-26）

    GET https://animadex.net/api/characters/search?sort=count&page=1&page_size=36
    → 200 / 0.13s，回包 {total, page, page_size, pages, results:[...]}
每条结果字段：slug / name / copyright / copyright_name / **trigger** / tags / count /
url / thumb_url / img_url / has_image / loras / rating / fav_count。
`trigger` 形如 `hatsune miku, vocaloid` —— 正是「基础提示词添加」要的东西。

## 提示词素材的分组（YG 要求「人物作品等、服饰配件等可以选择开启或不开启」）

角色的 `tags` 里混着两类词，用**项目自带的语义分类库**（`data/tag_taxonomy.tsv.gz`，
19 类）拆开，不自己写规则：
  · 服饰配件 = 分类 **7（服饰词）** 与 **19（物件道具词）**；
  · 其余（身体特征 / 五官 / 发型…）归入「特征」组，由前端决定要不要。
分类库不可用时退化为内置小词表，**绝不因为分类失败而让浮窗不可用**。

## 拼音联想（2026-09-27）

`suggest()` 除中英双语外还接**拼音路**：中文打不出汉字时输入 `chuyin`（全拼）或 `cywl`
（「初音未来」首字母缩写）即可命中角色。字表来自同目录 `anima_pinyin`（构建期预建数据，
**无任何第三方运行时依赖**），键在构建期算好，查询侧只做 dict 查 + 二分。
"""
from __future__ import annotations

try:
    from .anima_paths import plugin_root
except ImportError:
    from anima_paths import plugin_root


import bisect
import gzip
import json
import os
import re
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from typing import Any

__all__ = [
    "get_index",
    "warm_async",
    "animadex_status",
    "refresh_async",
]

PLUGIN_DIR = plugin_root()
SLIM_PATH = os.path.join(PLUGIN_DIR, "anima_animadex.json.gz")
RAW_PATH = os.path.join(PLUGIN_DIR, "data", "_sources", "animadex_characters.json")
TAXONOMY_PATH = os.path.join(PLUGIN_DIR, "data", "tag_taxonomy.tsv.gz")

ANIMADEX_API = "https://animadex.net/api/characters/search"
USER_AGENT = "ComfyUI-Anima-Batch-LoRA/1.0 (+animadex browser)"
#: 缩略图允许的主机（图片代理白名单，防 SSRF）
IMAGE_HOSTS = ("blobs.animadex.net", "animadex.net")

#: 分类库里的「服饰词 / 物件道具词」——见模块 docstring 的分组依据
OUTFIT_CATEGORY_IDS = {"7", "19"}
#: 作品分面的返回上限。**不是**分页参数，而是防呆上限：
#: 实测本机作品总数 3,702（覆盖全部 36,488 角色），取 5000 留足增长余量，
#: 同时挡住"传个天文数字把 36,488 行全吐出来"的误用。
_FACETS_MAX = 5000
#: 拼音前缀扫描的安全上界（命中太多时不必扫完整段；实测单次 ≤0.3 ms）
_PINYIN_SCAN_CAP = 512
#: 拼音路候选收集上限（排序前截断；浮层最多展示几十条，多余候选只是白付排序成本）
_PINYIN_CANDIDATE_CAP = 200
#: `suggest()` 的档位加成（`score = 帖数 + 加成`，降序）。**有界**是刻意的：
#: 档位只该是「有界的加分」，不该像原先那样硬隔离 —— 前缀命中压过中缀、哪怕热度差两个数量级，
#: 实测就是 `suggest('miku')` 首条变成 `Mikuma (Kancolle)`（1,245）而 `Hatsune Miku`（103,500）掉到第 14。
#: 档位语义：0 = slug/英文名精确；1 = slug/英文名/中文名**前缀**；2 = 英文名中缀 + 拼音命中；3 = 中文名中缀。
#: 取值依据（2026-09-27 本机实测，最大帖数 103,500）：精确档 1,000,000（保证仍必排第一）；
#: 前缀档 10,000（≈ 最大热度的 1/10）：`miku` 前缀最热的 `Mikuma`(1,245) 得 11,245，
#: 仍排在 `Hatsune Miku`(103,500) 之后 —— 热度照样能跨档胜出（2026-09-27 实测）。
_TIER_BONUS = (1_000_000, 10_000, 0, 0)
#: 后台刷新的页数上限（防呆）。**必须 clamp**：`POST /anima/animadex/refresh {"pages":999999}`
#: 会让后台线程按页发请求、每页 30s 超时，资源被长占（2026-09-27 冷审查发现的缺陷）。
#: 50 页 × 100 条 = 5,000 条，已远超「跟热度」的目的（默认 3 页）。
_REFRESH_MAX_PAGES = 50
#: 缩略图代理允许的协议（**与主机白名单同等重要**：只比 hostname 时 `ftp://blobs.animadex.net/…`
#: 能穿过白名单直接交给 urlopen —— 2026-09-27 冷审查发现的缺陷）。
_ALLOWED_IMAGE_SCHEMES = ("http", "https")
#: 整串拼接的「空键占位」：保证每行都占一行，偏移数组与行号一一对应（见 `_join_blob`）。
_BLOB_HOLE = "\x00"
#: `_blob_hits` 的密度分界：整串里该键命中数 ≤ 此值时走「逐命中二分」，超过则走「单调游标」。
#: 取值来自 2026-09-27 本机实测（见 `_blob_hits` docstring 的两组对照）。
_CURSOR_MIN_HITS = 1024
#: `suggest()` 的密度分派阈值：名字列命中数 > 此值时改走「线性扫一遍 + 原地判档」。
#: 依据 2026-09-27 实测（36,488 行）：`mi`（5,061 命中）blob 路 9 ms / 线性 25 ms；
#: `m`（24,617 命中）blob 路 36 ms / 线性 32 ms；`a`（67,852 命中）blob 路 63 ms / 线性 40 ms。
#: 拐点落在 8,192（≈ 22% 行数）附近，两侧各留一倍余量。
_DENSE_SCAN_MIN = 8192
#: 分类库缺失时的兜底词表（够用即可，不作为主判据）
OUTFIT_FALLBACK = (
    "dress", "skirt", "shirt", "uniform", "suit", "coat", "jacket", "sweater", "hoodie",
    "kimono", "yukata", "maid", "bikini", "swimsuit", "lingerie", "pantyhose", "thighhighs",
    "stockings", "socks", "gloves", "hat", "cap", "ribbon", "bow", "necktie", "scarf",
    "boots", "shoes", "sandals", "heels", "belt", "apron", "cape", "cloak", "armor",
    "necklace", "earrings", "hairband", "hair ornament", "backpack", "bag", "umbrella",
    "sword", "staff", "wand", "shield", "glasses", "goggles", "mask", "choker",
)


def has_cjk(value: Any) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf" for ch in str(value or ""))


def normalize_key(value: Any) -> str:
    """与 `anima_tag_index.normalize_key` 逐字对齐（同一套查询归一化）。"""
    text = unicodedata.normalize("NFKC", str(value or "")).casefold().replace("\\", "")
    return "".join(ch for ch in text if ch.isalnum())


def _join_blob(keys: list[str]) -> tuple[str, list[int]]:
    """归一化键列表 → 「一行一键」的整串 + 每行起始偏移。

    用途：把「逐行 `startswith` / `in`」降级成 **C 级正则扫 + 偏移二分**（见 `_blob_hits`）。
    分隔符取 `\\n` 是安全的：`normalize_key` 只留 `isalnum()` 字符，键内不可能含换行。
    偏移数组严格递增（每行至少占 1 个字符 + 1 个分隔符），故可直接二分折回行号。
    """
    offsets: list[int] = []
    position = 0
    for key in keys:
        offsets.append(position)
        position += len(key) + 1
    return "\n".join(keys), offsets


def _image_host_strict(url: Any) -> str:
    """取 URL 主机（小写）。**协议白名单在这里**：非 http(s) / 畸形 URL / 无主机 → 空串。

    复用 `anima_gallery_sources._image_host_of`（图源侧同一套判据，`_image_host_of` 里就卡了
    `scheme in ("http","https")`），取不到时退化为等价的本地实现（行为一致，由契约测试对齐）。

    2026-09-27 修（冷审查）：缩略图代理原先只比 hostname，不查 scheme ⇒
    `ftp://blobs.animadex.net/…` 这类非 http(s) URL 能穿过白名单直接交给 `urlopen`。
    """
    shared = None
    try:
        try:
            from .anima_gallery_sources import _image_host_of as shared
        except ImportError:
            from anima_gallery_sources import _image_host_of as shared
    except ImportError:
        shared = None
    if shared is not None:
        return shared(url)
    text = str(url or "")
    if not text:
        return ""
    try:
        parsed = urllib.parse.urlparse(text)
    except ValueError:  # 畸形 URL（例如未闭合的 IPv6 字面量 http://[::1）
        return ""
    if parsed.scheme not in _ALLOWED_IMAGE_SCHEMES:
        return ""
    return (parsed.hostname or "").lower()


def _clamp_pages(value: Any, default: int = 3) -> int:
    """刷新页数防呆：非数字 → 默认值；超上限 → **截断**到 `_REFRESH_MAX_PAGES`（不拒绝，只收口）。"""
    try:
        pages = int(value)
    except (TypeError, ValueError):
        pages = default
    return max(1, min(_REFRESH_MAX_PAGES, pages))


class AnimaDexIndex:
    """角色库索引（构建后只读，天然线程安全）。"""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.by_slug: dict[str, dict[str, Any]] = {}
        # 预建的归一化键（与 rows 同序）——**构建时算一次**。
        # 2026-09-26 实测踩坑：原先在 search() 里现算 normalize_key，36,488 行 × 3 个字段
        # 每次查询要 400ms；预建后降到毫秒级。归一化是纯函数，没有「实时性」需求。
        self._slug_keys: list[str] = []
        self._name_keys: list[str] = []
        self._series_keys: list[str] = []
        self._zh_by_slug: dict[str, str] = {}  # 归一化 slug → 中文名（来自别名索引）
        #: 归一化 slug → **归一化**中文名（联想用；预建，避免每次查询重算）
        self._zh_key_by_slug: dict[str, str] = {}
        #: 预建 (归一化中文名, 归一化 slug) —— search() 的中文匹配直接遍历它。
        #: 必须在 __init__ 里给出空值：中文表加载失败（别名索引缺失）时 search 仍要能跑。
        self._zh_entries: list[tuple[str, str]] = []
        #: 拼音联想（2026-09-27 接入 `anima_pinyin`）：拼音键 → [(中文名, 归一化 slug), ...]。
        #: 与 `_slug_keys` / `_zh_entries` 同一纪律 —— **构建期预建**，查询侧只做 dict 查 + 二分。
        #: 缺字（字表外生僻字）或 `anima_pinyin` 缺失时为空表，拼音路自动失效，其余联想照常。
        self._pinyin_exact: dict[str, list[tuple[str, str]]] = {}
        self._pinyin_keys: list[str] = []
        self.pinyin_key_count = 0
        #: 预建「整串 + 行起始偏移」三件套（slug / 英文名 / 中文名），供 `_blob_hits` 用。
        #: 2026-09-27：`suggest()` 原先每次逐行扫 36,488 行（单次 ~8 ms，纯 miss 查询也是这个数）；
        #: 改成正则扫整串 + 偏移二分后，候选生成降到 C 级（实测见 `_blob_hits`）。
        self._slug_blob = ""
        self._slug_offsets: list[int] = []
        self._name_blob = ""
        self._name_offsets: list[int] = []
        self._zh_blob = ""
        self._zh_offsets: list[int] = []
        self._outfit_tags: set[str] = set()    # 服饰/道具类 tag（分类库或兜底词表）
        self._taxonomy_ready = False
        #: 作品/系列聚合结果（`series_facets()` 懒算一次后缓存，不再每次扫 36,488 行）
        self._series_facets: list[dict[str, Any]] | None = None
        self._facets_lock = threading.Lock()
        self.build_ms = 0.0
        self.loaded_from = ""
        self.errors: list[str] = []

    # ---------- 构建 ----------

    def build(self) -> "AnimaDexIndex":
        started = time.perf_counter()
        self._load_rows()
        self._load_taxonomy()
        self._load_zh_names()
        self._build_pinyin_index()
        self._build_blobs()
        self.build_ms = (time.perf_counter() - started) * 1000
        return self

    def _load_rows(self) -> None:
        """优先读随包的精简快照；退回完整快照（本机开发时的原始文件）。"""
        rows: list[dict[str, Any]] = []
        if os.path.isfile(SLIM_PATH):
            try:
                with gzip.open(SLIM_PATH, "rt", encoding="utf-8") as handle:
                    payload = json.load(handle)
                for item in payload if isinstance(payload, list) else []:
                    if not isinstance(item, dict):
                        continue
                    rows.append({
                        "slug": str(item.get("s") or ""),
                        "name": str(item.get("n") or ""),
                        "copyright_name": str(item.get("cn") or ""),
                        "trigger": str(item.get("t") or ""),
                        "tags": [str(t) for t in (item.get("g") or []) if str(t).strip()],
                        "count": int(item.get("p") or 0),
                        "thumb_url": str(item.get("i") or ""),
                    })
                self.loaded_from = "slim"
            except (OSError, ValueError, TypeError) as error:
                self.errors.append(f"slim: {type(error).__name__}: {error}")
        if not rows and os.path.isfile(RAW_PATH):
            try:
                with open(RAW_PATH, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
                for item in payload if isinstance(payload, list) else []:
                    if not isinstance(item, dict):
                        continue
                    rows.append({
                        "slug": str(item.get("slug") or ""),
                        "name": str(item.get("name") or ""),
                        "copyright_name": str(item.get("copyright_name") or ""),
                        "trigger": str(item.get("trigger") or ""),
                        "tags": [str(t) for t in (item.get("tags") or []) if str(t).strip()],
                        "count": int(item.get("count") or 0),
                        "thumb_url": str(item.get("thumb_url") or ""),
                    })
                self.loaded_from = "raw"
            except (OSError, ValueError, TypeError) as error:
                self.errors.append(f"raw: {type(error).__name__}: {error}")

        rows = [row for row in rows if row["slug"]]
        self.rows = rows
        self.by_slug = {row["slug"]: row for row in rows}
        # 预建归一化键（构建时一次，供 search() 直接比较）
        self._slug_keys = [normalize_key(row["slug"]) for row in rows]
        self._name_keys = [normalize_key(row["name"]) for row in rows]
        self._series_keys = [normalize_key(row["copyright_name"]) for row in rows]
        #: 归一化 slug → row（拼音路用：构建期存的是归一化键，`by_slug` 是原始 slug）
        self._by_key = {key: row for key, row in zip(self._slug_keys, rows) if key}
        #: 归一化 slug → **行号**（`suggest()` 的拼音路要把 `_pinyin_hits` 回的 row 折回行号合并档位）
        self._index_by_key = {key: index for index, key in enumerate(self._slug_keys) if key}

    def _load_taxonomy(self) -> None:
        """读分类库，只保留「服饰词 / 物件道具词」两类（省内存，实测这两类够用）。"""
        if not os.path.isfile(TAXONOMY_PATH):
            return
        try:
            with gzip.open(TAXONOMY_PATH, "rt", encoding="utf-8") as handle:
                handle.readline()  # 表头是 JSON 注释行
                for line in handle:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) < 2 or parts[1] not in OUTFIT_CATEGORY_IDS:
                        continue
                    key = normalize_key(parts[0])
                    if key:
                        self._outfit_tags.add(key)
            self._taxonomy_ready = bool(self._outfit_tags)
        except (OSError, ValueError, TypeError) as error:
            self.errors.append(f"taxonomy: {type(error).__name__}: {error}")

    def _load_zh_names(self) -> None:
        """从别名索引取角色中文名（复用 `anima_tag_index` 已加载的表，不重复读 9.3MB）。"""
        try:
            from .anima_tag_index import get_index as _tag_index_get
        except ImportError:
            try:
                from anima_tag_index import get_index as _tag_index_get  # type: ignore[no-redef]
            except ImportError:
                return
        try:
            tag_index = _tag_index_get()
        except Exception:
            return
        if tag_index is None:
            return
        entries: list[tuple[str, str]] = []
        for slug, meta in (getattr(tag_index, "characters", None) or {}).items():
            if not isinstance(meta, dict):
                continue
            tag = normalize_key(meta.get("t") or slug)
            names = [str(x).strip() for x in (meta.get("zh") or []) if has_cjk(x)]
            if not tag or not names:
                continue
            self._zh_by_slug[tag] = names[0]
            self._zh_key_by_slug[tag] = normalize_key(names[0])
            # 预建 (归一化中文名, 归一化 slug)：search() 直接比较，不再每次重算归一化。
            # 2026-09-26 实测：不预建时中文查询 ~85ms（31,671 次 normalize_key/查询），预建后降到毫秒级。
            for name in names:
                entries.append((normalize_key(name), tag))
        self._zh_entries = entries

    def _build_pinyin_index(self) -> None:
        """预建「拼音键 → 角色中文名」索引（`anima_pinyin` 提供字表，**无第三方依赖**）。

        目的：中文用户打不出汉字时输入 `chuyin`（全拼）或 `cywl`（初音未来的首字母缩写）
        也能在浮窗里选中角色 —— 与 `suggest()` 的中英双语联想同属「替换人物」的主入口。

        键两路：全拼（多音字展开去重）与首字母缩写。范围只有**角色的中文名**（实测
        36,480 条源表 / 31,671 个有中文名的角色），不做作品名 —— 作品筛选走
        `series_facets()` 下拉，拼音检索对它的收益远低于角色名。

        纪律与 `_zh_entries` 完全一致：键全部构建期算一次，`suggest()` 里只做 dict 查 + 二分
        （见 `search()` 注释里那个 400ms 的踩坑）；缺字或模块缺失时留空表，拼音路自动失效。

        成本实测：构建 +0.2 s（在后台预热线程内），产出 100,080 个键；查询侧 +0.3 ms。
        """
        try:
            from .anima_pinyin import pinyin_initials, pinyin_keys
        except ImportError:
            try:
                from anima_pinyin import pinyin_initials, pinyin_keys  # type: ignore[no-redef]
            except ImportError:
                # 纯增益模块缺失：不报错、不影响其余检索（失败绝不致命）
                return
        exact: dict[str, list[tuple[str, str]]] = {}
        for tag, zh_name in self._zh_by_slug.items():
            keys = pinyin_keys(zh_name)
            if not keys:
                continue
            for key in keys:
                bucket = exact.get(key)
                if bucket is None:
                    exact[key] = [(zh_name, tag)]
                elif bucket[-1][1] != tag and not any(item[1] == tag for item in bucket):
                    bucket.append((zh_name, tag))
            initials = pinyin_initials(zh_name)
            if initials and initials not in exact:
                exact[initials] = [(zh_name, tag)]
        self._pinyin_exact = exact
        self._pinyin_keys = sorted(exact.keys())
        self.pinyin_key_count = len(exact)

    # ---------- 查询 ----------

    def _build_blobs(self) -> None:
        """预建三列「整串 + 行起始偏移」——把候选生成从 Python 逐行循环降级成 C 级正则扫。

        2026-09-27 冷审查缺陷 6 的「全表扫 36,488 行」在这里收口：`suggest()` 原先每次查询都
        `for index, row in enumerate(self.rows)` 逐行 `startswith` / `in`，实测 8–12 ms（纯 miss 也是 8.4 ms）。
        改成 `re.finditer` 扫整串 + 偏移折回行号后，同查询降到 ~1–3 ms（见 `_blob_hits` 注释）。

        必须在 `_load_rows()` 与 `_load_zh_names()` **之后**调用（中文名整串要用后者建的表）。
        空键用 `_BLOB_HOLE` 占位 —— 否则空串会在整串里匹配到一切，污染候选。
        """
        self._slug_blob, self._slug_offsets = _join_blob(self._slug_keys)
        self._name_blob, self._name_offsets = _join_blob(self._name_keys)
        zh_keys = [self._zh_key_by_slug.get(key, "") or _BLOB_HOLE for key in self._slug_keys]
        self._zh_blob, self._zh_offsets = _join_blob(zh_keys)

    def _blob_hits(self, blob: str, offsets: list[int], pattern: "re.Pattern[str]",
                   key: str) -> list[int]:
        """整串正则扫 → 命中所在**行号**列表（可能含重复；调用方按 `dict` 合并档位）。

        偏移数组与整串同源（`_join_blob`），行号 = 最后一个起始偏移 ≤ 命中位置的行。
        键只含 `isalnum()` 字符 ⇒ 命中不可能跨行（分隔符 `\\n` 不在键内），故行号判定无歧义。

        折回行号**按命中密度二选一**（2026-09-27 实测，两种极端各差一个数量级）：
        · 稀疏（命中 ≤ `_CURSOR_MIN_HITS`）→ 逐命中 `bisect`（C 级 log n）：`miku` 149 命中 0.05 ms；
        · 密集 → 单调游标（`finditer` 位置递增，游标只前进，整趟 O(行数)）：`a` 67,852 命中 17.7 ms
          （同查询逐命中 `bisect` 要 27 ms）。
        密度用 `str.count` 预判 —— 与 `finditer` 同为「从左到右不重叠」计数，估得**精确**，代价一次 C 级扫。
        """
        if not blob:
            return []
        if blob.count(key) <= _CURSOR_MIN_HITS:
            return [
                bisect.bisect_right(offsets, match.start()) - 1
                for match in pattern.finditer(blob)
            ]
        out: list[int] = []
        append = out.append
        cursor = 0
        last = len(offsets) - 1
        for match in pattern.finditer(blob):
            position = match.start()
            while cursor < last and offsets[cursor + 1] <= position:
                cursor += 1
            append(cursor)
        return out

    def search(self, query: str, limit: int = 36, page: int = 1) -> dict[str, Any]:
        """按 slug / 英文名 / 作品名 / **中文名** 检索；空查询 = 按热度榜返回。"""
        try:
            limit = max(1, min(120, int(limit)))
            page = max(1, int(page))
        except (TypeError, ValueError):
            limit, page = 36, 1
        key = normalize_key(query)
        if not key:
            ranked = sorted(self.rows, key=lambda row: -row["count"])
        else:
            # 中文查询：先经中文名表定位（键与 slug 都用**归一化**形式比较 —— 2026-09-26 实测踩坑：
            # 原先拿原始 slug（`hatsune_miku`）去比归一化集合（`hatsunemiku`），永远匹配不上，
            # 表现为「中文搜角色一律 0 结果」而英文正常）。
            # 2026-09-27 修（冷审查缺陷 14）：`_zh_entries` 的 name_key **全部含汉字**（建表时按
            # `has_cjk` 过滤），故查询键不含汉字时这个子串判断**不可能命中** —— 原先却每次查询都
            # 遍历它（纯英文查询白付 31,671+ 次子串比较）。按 `has_cjk(key)` 分支，语义等价、纯提速。
            if has_cjk(key):
                zh_hits = {tag for name_key, tag in self._zh_entries if key in name_key}
            else:
                zh_hits = set()
            hits: list[tuple[int, dict[str, Any]]] = []
            for index, row in enumerate(self.rows):
                slug_key = self._slug_keys[index]
                name_key = self._name_keys[index]
                series_key = self._series_keys[index]
                rank = None
                if slug_key == key or name_key == key:
                    rank = 0
                elif slug_key.startswith(key) or name_key.startswith(key):
                    rank = 1
                elif key in slug_key or key in name_key:
                    rank = 2
                elif series_key and key in series_key:
                    rank = 3
                elif slug_key in zh_hits:
                    rank = 4
                if rank is not None:
                    hits.append((rank, row))
            hits.sort(key=lambda item: (item[0], -item[1]["count"]))
            ranked = [row for _rank, row in hits]
        start = (page - 1) * limit
        window = ranked[start:start + limit]
        return {
            "total": len(ranked),
            "page": page,
            "limit": limit,
            "results": [self._row_payload(row) for row in window],
        }

    def suggest(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """**中英双语 + 拼音联想**（2026-09-26 中英双语；2026-09-27 加拼音 + 改热度主导排序）。

        双向：输入中文出英文名（`初音` → Hatsune Miku），输入英文出中文名（`miku` → 初音未来）；
        拼音路救的是「中文打不出汉字」：`chuyin`（全拼）/ `cywl`（初音未来首字母缩写）→ 初音未来。

        排序：**热度主导 + 有界档位加成** —— `score = 帖数 + _TIER_BONUS[档位]` 降序。
        2026-09-27 修（冷审查缺陷 6）：原先按 `(档位, 帖数)` **硬隔离**，前缀命中一律压过中缀，
        实测 `suggest('miku')` 首条是 `Mikuma (Kancolle)`（1,245），真正的 `Hatsune Miku`（103,500）
        被挤到第 14。档位只该是**有界的加分**，不该压过数量级的热度差；精确档给足大值（仍必排第一）。

        候选生成不再逐行扫 36,488 行：默认走 `_blob_hits`（预建整串正则扫 + 偏移折回行号）；
        候选集接近半张表时（单字符查询）改走 `_scan_tiers` 线性扫 —— 那种情形下线性才是最优解。
        """
        key = normalize_key(query)
        if not key:
            return []
        try:
            limit = max(1, min(30, int(limit)))
        except (TypeError, ValueError):
            limit = 10
        # 候选生成：一次 C 级正则扫（预建整串，见 `_build_blobs`）→ 命中**行号**，不再逐行扫 36,488 行。
        # 前缀 ⊂ 中缀，故「含 key」的候选集天然覆盖精确/前缀两档，无需再单独做前缀二分。
        pattern = re.compile(re.escape(key))
        tier_of: dict[int, int] = {}
        # 密度分派（2026-09-27 实测）：候选集接近半张表时，**任何**候选枚举都不可能比
        # 「线性扫一遍 + 原地判档」便宜 —— 单字符 `a` 命中 135,682 次（每行 slug/name 各一次），
        # blob 路的「枚举 + 判档」要 40 ms，线性 36,488 次只要 25 ms；
        # 而 `mi`（5,061 命中）blob 路 9 ms、线性要 25 ms，blob 路赢。
        # 阈值取 8,192（≈ 22% 行数）——两侧的实测拐点，见 `_DENSE_SCAN_MIN`。
        if self._name_blob.count(key) > _DENSE_SCAN_MIN:
            self._scan_tiers(key, tier_of)
        else:
            # ⚠️ 档位判定**逐命中内联**，不抽成函数：密集键下一次 Python 函数调用的开销
            # 就能把总耗时推高 13 ms（2026-09-27 实测 53.5 → 66.6 ms）。
            lookup = tier_of.get
            for index in self._blob_hits(self._slug_blob, self._slug_offsets, pattern, key):
                column_key = self._slug_keys[index]
                tier = 0 if column_key == key else (1 if column_key.startswith(key) else 2)
                if lookup(index, 9) > tier:
                    tier_of[index] = tier
            for index in self._blob_hits(self._name_blob, self._name_offsets, pattern, key):
                column_key = self._name_keys[index]
                tier = 0 if column_key == key else (1 if column_key.startswith(key) else 2)
                if lookup(index, 9) > tier:
                    tier_of[index] = tier
            for index in self._blob_hits(self._zh_blob, self._zh_offsets, pattern, key):
                column_key = self._zh_key_by_slug.get(self._slug_keys[index], "")
                tier = 1 if column_key.startswith(key) else 3
                if lookup(index, 9) > tier:
                    tier_of[index] = tier
        # 拼音路（2026-09-27）：中文打不出汉字时的入口 —— `chuyin` / `cywl` → 初音未来。
        # 与英文/中文命中**同场排序**（复用 rank 2 档位语义），故不会被高优先档挤空。
        # 键全部构建期预建（见 `_build_pinyin_index`），此处只有 dict 查 + 二分 + 有界扫描。
        if self._pinyin_keys and len(tier_of) < limit * 4:
            lookup = tier_of.get
            for rank, row in self._pinyin_hits(key):
                index = self._index_by_key.get(normalize_key(row["slug"]))
                if index is not None and lookup(index, 9) > rank:
                    tier_of[index] = rank
        # 终排：**热度主导 + 有界档位加成**（`score = 帖数 + _TIER_BONUS[档位]`）——
        # 2026-09-27 修（冷审查缺陷 6）：原先按 (档位, 热度) 硬隔离，前缀一律压过中缀，
        # 实测 `suggest('miku')` 首条是 `Mikuma (Kancolle)`(1,245)，`Hatsune Miku`(103,500) 掉到第 14。
        scored = [(self.rows[index]["count"] + _TIER_BONUS[tier], self.rows[index])
                  for index, tier in tier_of.items()]
        scored.sort(key=lambda item: (-item[0], item[1]["slug"]))
        return [{
            "slug": row["slug"],
            "name": row["name"],
            "zh": self._zh_by_slug.get(normalize_key(row["slug"]), ""),
            "series": row["copyright_name"],
            "count": row["count"],
            "thumb": row["thumb_url"],
        } for _score, row in scored[:limit]]

    def _scan_tiers(self, key: str, tier_of: dict[int, int]) -> None:
        """密集键（候选集接近半张表）的兜底：线性扫一遍 + 原地判档，写进 `tier_of`。

        判档优先级必须与 blob 路的 `min()` **完全一致**（差分测试覆盖）：
        英文前缀(0/1) → 中文前缀(1) → 英文中缀(2) → 中文中缀(3)。
        注意中文前缀要排在英文中缀**之前**（min(1,2)=1）—— 这是改前 `suggest()` 的原始档位顺序。
        """
        for index in range(len(self.rows)):
            slug_key = self._slug_keys[index]
            name_key = self._name_keys[index]
            zh_key = self._zh_key_by_slug.get(slug_key, "")
            if slug_key.startswith(key) or name_key.startswith(key):
                tier_of[index] = 0 if (slug_key == key or name_key == key) else 1
            elif zh_key.startswith(key):
                tier_of[index] = 1
            elif key in slug_key or key in name_key:
                tier_of[index] = 2
            elif zh_key and key in zh_key:
                tier_of[index] = 3

    def _pinyin_hits(self, key: str) -> list[tuple[int, dict[str, Any]]]:
        """拼音路候选：精确键（`cywl`）→ 前缀二分（`chuy` → `chuyin…`），按热度降序。

        返回 `(rank, row)`；拼音命中统一取 `rank` 2（与 `suggest()` 的「中缀命中」同档）——
        **不区分精确/前缀**：实测精确键（`chuyin`）与前缀键（`chuyinweilai`）常指向同一批角色，
        若精确键给更高档，某个冷门同名角色（帖数 58）会盖住真正的热门角色（帖数 103,500），
        症状是「拼音能搜到但首条是错的人」（2026-09-27 实测踩过）。同档内一律按热度决先后。

        构建期存的是「归一化 slug → 中文名」，这里用 `_by_key`（归一化 slug → row）
        还原成 `rows` 行 —— `by_slug` 用的是**原始** slug，直接拿归一化键去查会永远查不到
        （与 `search()` 里那个「中文搜角色一律 0 结果」的踩坑同源）。
        """
        candidates: list[tuple[int, str, str]] = []
        for zh_name, tag in self._pinyin_exact.get(key, ()):
            candidates.append((2, tag, zh_name))
        start = bisect.bisect_left(self._pinyin_keys, key)
        for index in range(start, min(start + _PINYIN_SCAN_CAP, len(self._pinyin_keys))):
            candidate_key = self._pinyin_keys[index]
            if not candidate_key.startswith(key):
                break
            for zh_name, tag in self._pinyin_exact.get(candidate_key, ()):
                candidates.append((2, tag, zh_name))
        out: list[tuple[int, dict[str, Any]]] = []
        seen: set[str] = set()
        for rank, tag, _zh_name in candidates:
            if tag in seen:
                continue
            seen.add(tag)
            row = self._by_key.get(tag)
            if row is None:
                continue
            out.append((rank, row))
            if len(out) >= _PINYIN_CANDIDATE_CAP:
                break
        # ⚠️ 必须先按热度降序、**再按 rank 稳定排序**：同一拼音键（`chuyin`）能映射到多个角色，
        # 直接按 rank 排会让某个冷门同名角色（帖数 58）盖住真正的热门角色（帖数 103,500）——
        # 2026-09-27 实测踩过，症状是「拼音能搜到但首条是错的人」。
        out.sort(key=lambda item: -item[1]["count"])
        out.sort(key=lambda item: item[0])
        return out

    def _row_payload(self, row: dict[str, Any]) -> dict[str, Any]:
        groups = self.tag_groups(row["tags"])
        return {
            "slug": row["slug"],
            "name": row["name"],
            "series": row["copyright_name"],
            "trigger": row["trigger"],
            "count": row["count"],
            "thumb": row["thumb_url"],
            "zh": self._zh_by_slug.get(normalize_key(row["slug"]), ""),
            # 两组素材分开给前端 —— YG 要求「人物作品等 / 服饰配件等可选择开启或不开启」
            "features": groups["features"],
            "outfit": groups["outfit"],
        }

    def tag_groups(self, tags: list[str]) -> dict[str, list[str]]:
        """把角色特征词拆成「服饰配件」与「其余特征」两组（分类库为准，兜底词表兜底）。"""
        outfit: list[str] = []
        features: list[str] = []
        for raw in tags:
            text = str(raw or "").strip()
            if not text:
                continue
            key = normalize_key(text)
            if self._taxonomy_ready:
                is_outfit = key in self._outfit_tags
            else:
                is_outfit = any(word in text.lower() for word in OUTFIT_FALLBACK)
            (outfit if is_outfit else features).append(text)
        return {"outfit": outfit, "features": features}

    def series_facets(self, limit: int = _FACETS_MAX) -> list[dict[str, Any]]:
        """按作品 / 系列聚合角色数（浮窗「作品」下拉的数据源）。

        2026-09-27：**懒算一次并缓存**（首次调用遍历一遍 rows，之后只切缓存切片）——
        36,488 行的聚合不该在每次请求里重跑（与 search() 的预建键同一套纪律）。
        分组直接吃构建时预建的 `_series_keys`，因此同一作品的不同写法
        （`Vocaloid` / `vocaloid`）不会裂成两项；显示名取该组**首个出现的原始写法**，
        保留站点原貌。排序：角色数降序，同数按名称升序（结果稳定可复现）。
        """
        with self._facets_lock:
            if self._series_facets is None:
                counts: dict[str, int] = {}
                display: dict[str, str] = {}
                for index, row in enumerate(self.rows):
                    key = self._series_keys[index]
                    if not key:
                        continue
                    counts[key] = counts.get(key, 0) + 1
                    if key not in display:
                        display[key] = str(row["copyright_name"] or "").strip()
                self._series_facets = sorted(
                    ({"name": display[key], "count": count} for key, count in counts.items()),
                    key=lambda item: (-item["count"], item["name"].lower()),
                )
            # ⚠️ 2026-09-27 修正（主会话独立抽查抓到的真 bug）：
            # 原实现写死 `min(200, int(limit))`，**limit 参数形同虚设** ——
            # 实测传 200 / 1000 / 100000 都只回 200 项，而作品总数 **3,702**
            # （覆盖全部 36,488 角色），于是「按作品筛选」只覆盖 24,029 个角色（66%），
            # 长尾作品在界面上根本选不到。上限改为 `_FACETS_MAX`（够覆盖现状且防呆）。
            try:
                limit = max(1, min(_FACETS_MAX, int(limit)))
            except (TypeError, ValueError):
                limit = _FACETS_MAX
            # 返回副本：调用方拿到的列表不能反向污染缓存
            return [dict(item) for item in self._series_facets[:limit]]

    def stats(self) -> dict[str, Any]:
        return {
            "characters": len(self.rows),
            "loaded_from": self.loaded_from,
            "build_ms": round(self.build_ms, 1),
            "taxonomy_outfit_tags": len(self._outfit_tags),
            "taxonomy_ready": self._taxonomy_ready,
            "zh_names": len(self._zh_by_slug),
            # 拼音路规模（0 = 字表缺失或角色名全部缺字；不影响其余检索）
            "pinyin_key_count": self.pinyin_key_count,
            "errors": list(self.errors),
        }


# ---------- 单例 / 预热 / 后台刷新 ----------

_INDEX: AnimaDexIndex | None = None
_LOCK = threading.RLock()
_WARM_THREAD: threading.Thread | None = None
_REFRESH_STATE: dict[str, Any] = {"running": False, "last_at": 0.0, "updated": 0, "error": ""}


def get_index(build: bool = True) -> AnimaDexIndex | None:
    global _INDEX
    with _LOCK:
        if _INDEX is not None:
            return _INDEX
        if not build:
            return None
        index = AnimaDexIndex().build()
        _INDEX = index
        try:
            print(
                "[AnimaDex] 角色库就绪：%s 角色（来源 %s / 中文名 %s / 服饰分类 %s）/ 构建 %.0f ms"
                % (f"{len(index.rows):,}", index.loaded_from or "-", f"{len(index._zh_by_slug):,}",
                   f"{len(index._outfit_tags):,}", index.build_ms)
            )
        except Exception:
            pass
        return _INDEX


def warm_async() -> threading.Thread | None:
    """后台预热（幂等）：把解析 2.77MB gzip + 建索引的成本挪出首次打开浮窗。"""
    global _WARM_THREAD
    with _LOCK:
        if _INDEX is not None:
            return None
        if _WARM_THREAD is not None and _WARM_THREAD.is_alive():
            return _WARM_THREAD

        def worker() -> None:
            try:
                from .services.background_budget import background_slot
                with background_slot() as admitted:
                    if admitted:
                        get_index()
            except Exception as error:  # noqa: BLE001
                print(f"[AnimaDex] 预热失败（打开浮窗时会重试）：{error}")

        thread = threading.Thread(target=worker, name="tk-animadex-warm", daemon=True)
        _WARM_THREAD = thread
        thread.start()
        return thread


def animadex_status() -> dict[str, Any]:
    index = get_index(build=False)
    base = {"ready": index is not None, "warming": bool(_WARM_THREAD and _WARM_THREAD.is_alive())}
    if index is not None:
        base.update(index.stats())
    base["refresh"] = dict(_REFRESH_STATE)
    return base


def refresh_async(pages: int = 3) -> dict[str, Any]:
    """后台刷新：拉 API 最新热门页，**只更新本地已有角色的帖数与缩略图**（增量、不阻塞）。

    刻意不重抓全量：全量实测要 1227 秒（1014 页），不适合在用户点一下时跑。
    目的只是让热度排序与缩略图跟上站上变化，新角色的补齐留给后续版本。

    页数一律过 `_clamp_pages`（2026-09-27 修冷审查缺陷 9）：路由侧已 clamp，这里再兜一道 ——
    本函数是公开 API（`__all__` 之外但模块级），别把「防呆」只押在调用方身上。
    """
    pages = _clamp_pages(pages)
    with _LOCK:
        if _REFRESH_STATE["running"]:
            return {"started": False, "reason": "已有刷新任务在跑"}
        _REFRESH_STATE.update({"running": True, "error": ""})

    def worker() -> None:
        updated = 0
        try:
            index = get_index()
            if index is None:
                raise RuntimeError("索引未就绪")
            for page in range(1, pages + 1):
                url = f"{ANIMADEX_API}?" + urllib.parse.urlencode(
                    {"sort": "count", "page": page, "page_size": 100}
                )
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                              "Accept": "application/json"})
                with urllib.request.urlopen(request, timeout=30) as response:
                    payload = json.loads(response.read().decode("utf-8", "replace") or "{}")
                for item in payload.get("results") or []:
                    if not isinstance(item, dict):
                        continue
                    slug = str(item.get("slug") or "").strip()
                    row = index.by_slug.get(slug)
                    if row is None:
                        continue
                    new_count = int(item.get("count") or 0)
                    new_thumb = str(item.get("thumb_url") or "")
                    if new_count and new_count != row["count"]:
                        row["count"] = new_count
                        updated += 1
                    if new_thumb and new_thumb != row["thumb_url"]:
                        row["thumb_url"] = new_thumb
            _REFRESH_STATE.update({"updated": updated, "last_at": time.time(), "error": ""})
            print(f"[AnimaDex] 后台刷新完成：更新 {updated} 条热度/缩略图")
        except Exception as error:  # noqa: BLE001
            _REFRESH_STATE.update({"error": f"{type(error).__name__}: {error}"})
            print(f"[AnimaDex] 后台刷新失败（本地打底不受影响）：{error}")
        finally:
            with _LOCK:
                _REFRESH_STATE["running"] = False

    thread = threading.Thread(target=worker, name="tk-animadex-refresh", daemon=True)
    thread.start()
    return {"started": True}


# ---------- 路由（与其它模块同写法；独立运行时退化为空装饰器）----------

def _register_routes() -> Any:
    try:
        from server import PromptServer  # type: ignore

        return PromptServer.instance.routes
    except Exception:

        class _NullRoutes:
            def get(self, *_a: Any, **_k: Any):
                def deco(func: Any) -> Any:
                    return func

                return deco

            def post(self, *_a: Any, **_k: Any):
                def deco(func: Any) -> Any:
                    return func

                return deco

        return _NullRoutes()


routes = _register_routes()


@routes.get("/anima/animadex/search")
async def animadex_search(request: Any) -> Any:
    """浮窗检索：`?q=&page=&limit=`。本地打底，返回即可用（不依赖任何外部网络）。"""
    from aiohttp import web  # 局部导入：独立探针环境没有 aiohttp 时也能 import 本模块

    query = str(request.query.get("q", "") or "").strip()
    try:
        page = int(request.query.get("page", 1))
        limit = int(request.query.get("limit", 36))
    except (TypeError, ValueError):
        page, limit = 1, 36
    index = get_index()
    if index is None:
        return web.json_response({"success": False, "error": "角色库未就绪", "results": []}, status=503)
    payload = index.search(query, limit=limit, page=page)
    return web.json_response({"success": True, **payload})


@routes.get("/anima/animadex/suggest")
async def animadex_suggest_route(request: Any) -> Any:
    """中英双语联想：`?q=&limit=`。输入中文出英文名，反之亦然（替换人物的核心入口）。"""
    from aiohttp import web

    query = str(request.query.get("q", "") or "").strip()
    try:
        limit = int(request.query.get("limit", 10))
    except (TypeError, ValueError):
        limit = 10
    index = get_index()
    if index is None:
        return web.json_response({"success": False, "error": "角色库未就绪", "suggestions": []}, status=503)
    return web.json_response({"success": True, "suggestions": index.suggest(query, limit=limit)})


@routes.get("/anima/animadex/facets")
async def animadex_facets_route(request: Any) -> Any:
    """作品 / 系列聚合：`?limit=`（**默认全量**，防呆上限 `_FACETS_MAX`）。浮窗「作品」下拉用它填充选项。

    聚合在 `AnimaDexIndex` 内**缓存一次**（懒算），本路由只做切片 —— 不遍历 36,488 行。

    ⚠️ 2026-09-27 修正：原先默认与上限都是 200，而**前端不传 limit** ⇒ 下拉只有 200 项，
    3,702 个作品里 94% 选不到（只覆盖 66% 的角色）。默认改为全量后，下拉能覆盖所有作品。
    """
    from aiohttp import web

    try:
        limit = int(request.query.get("limit", _FACETS_MAX))
    except (TypeError, ValueError):
        limit = _FACETS_MAX
    index = get_index()
    if index is None:
        return web.json_response({"success": False, "error": "角色库未就绪", "series": []}, status=503)
    return web.json_response({"success": True, "series": index.series_facets(limit=limit)})


@routes.get("/anima/animadex/status")
async def animadex_status_route(request: Any) -> Any:
    from aiohttp import web

    return web.json_response(animadex_status())


@routes.post("/anima/animadex/refresh")
async def animadex_refresh_route(request: Any) -> Any:
    """手动触发后台刷新（本地打底 + 后台刷新里的「后台刷新」那一半）。

    页数 **clamp 到 `_REFRESH_MAX_PAGES`**（2026-09-27 修冷审查缺陷 9）：原先路由直接 `int()`
    不设上限，`{"pages": 999999}` 会让后台线程按页发请求（每页 30s 超时）把资源长占。
    """
    from aiohttp import web

    try:
        pages = _clamp_pages((await request.json()).get("pages", 3))
    except Exception:
        pages = 3
    return web.json_response(refresh_async(pages=pages))


@routes.get("/anima/animadex/image")
async def animadex_image(request: Any) -> Any:
    """缩略图代理：只允许 AnimaDex 的图床主机（防 SSRF），并缓存一天。

    **协议 + 主机双重白名单**（2026-09-27 修冷审查缺陷 11）：主机判定改走 `_image_host_strict`
    （复用 `anima_gallery_sources._image_host_of`，它内部卡 `scheme in ("http","https")`）——
    原先只比 hostname，`ftp://blobs.animadex.net/…` 这类非 http(s) URL 能穿过白名单交给 `urlopen`。
    """
    from aiohttp import web

    url = str(request.query.get("url", "") or "")
    if not url:
        return web.json_response({"error": "缺少 url"}, status=400)
    host = _image_host_strict(url)
    if not any(host == allowed or host.endswith("." + allowed) for allowed in IMAGE_HOSTS):
        return web.json_response({"error": "该主机不在 AnimaDex 图床白名单内"}, status=403)
    try:
        request_obj = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request_obj, timeout=30) as response:
            body = response.read()
            content_type = response.headers.get("Content-Type") or "image/webp"
        return web.Response(body=body, content_type=content_type,
                            headers={"Cache-Control": "public, max-age=86400"})
    except Exception as error:  # noqa: BLE001
        return web.json_response({"error": f"取图失败：{type(error).__name__}"}, status=502)
