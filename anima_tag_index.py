# -*- coding: utf-8 -*-
"""本地标签索引：把「英文标签 + 帖数 + 汉字别名」做成一棵常驻内存的索引树。

## 为什么要有这个模块（2026-09-26 实测动因）

多重画廊的搜索联想原先**每次都远程问 Danbooru**：
  · 英文输入 → `/tags.json` 往返，实测中位 **835~1113 ms**，且同一查询复测仍 1046 ms（无结果缓存）；
  · 中文输入 → 扫 17.9MB 词典本地出候选（6~33 ms），但**冷启动首查 3.5~9.6 s**，
    且对每个候选**逐条远程验证帖数**。
而本机早已随包带着三份足够好的数据：
  · `data/danbooru_tags_with_description_v3_modified.csv` —— 205,000 个英文标签，**第 3 列就是帖数**；
  · `anima_alias_index.json` —— 36,480 角色 + 3,702 作品 + 131,913 标签的**汉字别名**
    （角色条目还带所属作品与帖数）；
  · `data/_sources/danbooru_aliases.jsonl` —— 40,997 行 D 站**英文别名 → 规范标签**
    （`{"a": 别名, "c": 规范标签}`），2026-09-26 接入：其中约 2 万条别名在本地标签表里
    **完全查不到**（如 `lightning_(ff13)` → `lightning_farron`），不接则这些输入必然空手而归。

实测（`.scratch/gallery-refactor-20260926/probe_local_index_perf.py`）：
    建索引合计 1188 ms（可后台预热）／英文前缀查询 0.00~0.04 ms／中文前缀 0.01~0.10 ms／
    中文子串扫描（47 万对）15~19 ms。
⇒ 那 835 ms 是**架构选择而非能力上限**。

## 设计纪律

· **纯离线**：本模块不发任何网络请求，不依赖 aiohttp / folder_paths，可脱离 ComfyUI 单测；
· **惰性 + 可预热**：首次使用才建索引；`warm_async()` 供插件加载时后台预热，避免首查卡顿；
· **帖数如实**：本地 CSV / 别名索引里的 count 是**快照值**，与 D 站实时值会有偏差
  （实测 `hatsune miku` 本地 115,420 vs 实时 146,492）。调用方应把 `count_is_snapshot=True`
  透传到界面，**不把快照冒充实时**；
· **失败绝不致命**：任一数据文件缺失/损坏，索引退化为空，联想回退到调用方原有路径。
· **别名只做纯增益**：别名表的条目只有「规范标签确实存在于本地标签表」时才收录 ——
  否则命中一个拿不到帖数/显示名的空壳，反而把真实候选挤出浮层（实测 40,997 行里
  约 45% 的规范标签不在本地表，一律跳过，**不硬塞**）。
· **拼音只做纯增益**（2026-09-27 接入 `anima_pinyin`）：中文用户打不出汉字时输入
  `chuyin` / `cywl` 也要能命中「初音未来」。字表与「拼音键 → 中文名」映射**全部构建期预建**，
  查询侧只做 dict 查与二分（与 `_tag_keys` / `_zh_grams` 同一纪律）；`anima_pinyin` 缺失
  或字表缺字时该路自动为空，其余联想不受影响。

## 三个新增文件 / 改动点速览（2026-09-27）

· `anima_pinyin.py`（新）—— 拼音字表 + 构建期纯函数（`pinyin_keys` / `pinyin_initials`），
  数据派生自 MIT 的 pinyin-data，无第三方运行时依赖；
· 本模块 `_build_pinyin_index()` —— 角色 / 作品中文名 → 拼音键（全拼 + 首字母缩写），
  与英文路同场排序（rank 2/3），查询侧 +0.2~0.4 ms；
· `anima_animadex.AnimaDexIndex._build_pinyin_index()` —— 同一套纪律接进浮窗 `suggest()`。
"""
from __future__ import annotations

import bisect
import csv
import json
import os
import threading
import time
import unicodedata
from typing import Any, Iterable

__all__ = [
    "has_cjk",
    "normalize_key",
    "TagIndex",
    "get_index",
    "warm_async",
    "index_status",
]

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PLUGIN_DIR, "data")
CSV_PATH = os.path.join(DATA_DIR, "danbooru_tags_with_description_v3_modified.csv")
ALIAS_PATH = os.path.join(PLUGIN_DIR, "anima_alias_index.json")
ALIAS_FALLBACK_PATH = os.path.join(DATA_DIR, "danbooru_alias_index.json")
#: D 站英文别名表（JSONL：`{"a": 别名, "c": 规范标签, "_page": n}`，全英文、无汉字）
DANBOORU_ALIASES_PATH = os.path.join(DATA_DIR, "_sources", "danbooru_aliases.jsonl")

#: 单次查询的候选上限（前端浮层最多也就展示这么多）
MAX_RESULTS = 40
#: 前缀扫描的安全上界：命中太多时不必扫完整段（已按帖数排序）
_PREFIX_SCAN_CAP = 4000
#: 中文子串兜底的成本上界（实测 47 万对约 15~19 ms，可接受；超过此值则跳过兜底）
_SUBSTRING_CAP = 600_000
#: 拼音前缀扫描的安全上界（与 `_PREFIX_SCAN_CAP` 同义；实测单次 ≤0.3 ms）
_PINYIN_SCAN_CAP = 512


def has_cjk(value: Any) -> bool:
    """是否含汉字（只认 CJK 统一表意文字，不含假名）。"""
    return any("\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf" for ch in str(value or ""))


def normalize_key(value: Any) -> str:
    """查询/标签的规范化键：NFKC + 折叠大小写 + 去反斜杠 + 只留字母数字与汉字。

    与 `anima_prompt_cards._autocomplete_key` **逐字对齐** —— 两处若各写一套，
    同一输入会在画廊与卡片库得到不同结果，属最难排查的那类不一致。改这里请同步那边。
    """
    text = unicodedata.normalize("NFKC", str(value or "")).casefold().replace("\\", "")
    return "".join(ch for ch in text if ch.isalnum())


def _tag_count(tags: dict[str, tuple[str, int, str]], tag_key: str) -> int:
    """取标签帖数（缺失记 0）—— 构建期排序用。"""
    entry = tags.get(tag_key)
    return entry[1] if entry else 0


def _pinyin_add(
    bucket_map: dict[str, list[tuple[str, str]]], key: str, zh_text: str, tag_key: str
) -> None:
    """把 `(中文名, tag键)` 收进拼音键的桶：同一 tag 只收一次。

    2026-09-27 修（缺陷 16）：缩写键原实现写作 `if initials not in exact` —— 键已存在
    就整条丢弃，于是「两个角色中文名缩写相同」时只留先到者，另一个永远搜不到。实测缩写
    键 30,149 个里 **4,645 个存在 ≥2 个不同 tag 的冲突**；键 `cywl` 应含 13 个 tag
    （`hatsunemiku` / `hatsunemikuappend` / `hachunemiku` …），索引里只剩 1 个。
    全拼路用 `any` 去重保留了多个、缩写路没有 —— 现在两条路共用本函数，语义不会再分叉。
    """
    bucket = bucket_map.get(key)
    if bucket is None:
        bucket_map[key] = [(zh_text, tag_key)]
    elif not any(item[1] == tag_key for item in bucket):
        bucket.append((zh_text, tag_key))


class TagIndex:
    """常驻内存的标签索引（构建后只读，天然线程安全）。"""

    def __init__(self) -> None:
        # 英文：key → (显示标签, 帖数, 类别)
        self.tags: dict[str, tuple[str, int, str]] = {}
        # 排序后的英文键，供 bisect 前缀定位
        self._tag_keys: list[str] = []
        # 中文：(中文键, tag键, 中文显示, 帖数, 作品键, 作品显示)
        self._zh_rows: list[tuple[str, str, str, int, str, str]] = []
        self._zh_sorted = False
        # tag键 → 首选中文显示名（构建期预建，`lookup_zh` 只做一次 dict 查）
        self._zh_by_tag: dict[str, str] = {}
        # 中文 2-gram 倒排：{二字组: [行号]}，用于子串匹配粗筛
        self._zh_grams: dict[str, list[int]] = {}
        # 英文别名 → 规范标签（键均为归一化键）；查询侧只做字典查 + 二分
        self._alias_map: dict[str, str] = {}
        # 别名原始写法（归一化键 → 原文），供浮层显示「由别名 X 映射而来」
        self._alias_display: dict[str, str] = {}
        # 排序后的别名键，供 bisect 前缀定位（与 _tag_keys 同纪律：构建期预建）
        self._alias_keys: list[str] = []
        # 拼音（构建期预建，见 _build_pinyin_index）：
        #   拼音键 → [(中文显示名, tag键), ...]；桶内按帖数降序（构建期排好，截断时才不会丢热门）
        self._pinyin_exact: dict[str, list[tuple[str, str]]] = {}
        #   拼音键 → 同一列表（前缀路要按 key 遍历，dict 即可，无需重复存一份）
        self._pinyin_prefix: dict[str, list[tuple[str, str]]] = {}
        #   排序后的拼音键，供 bisect 前缀定位
        self._pinyin_keys: list[str] = []
        self.pinyin_name_count: int = 0
        self.pinyin_key_count: int = 0
        # 元信息
        self.built_at: float = 0.0
        self.build_ms: float = 0.0
        self.tag_count: int = 0
        self.zh_pair_count: int = 0
        self.alias_count: int = 0
        self.alias_skipped: int = 0
        self.series: dict[str, dict[str, Any]] = {}
        self.characters: dict[str, dict[str, Any]] = {}
        self.sources_loaded: list[str] = []
        self.errors: list[str] = []

    # ---------- 构建 ----------

    def build(self) -> "TagIndex":
        started = time.perf_counter()
        self._load_tags_csv()
        self._load_alias_index()
        # 别名表必须在标签表（CSV + 别名索引补入）齐备之后载入：收录判据是「规范标签在不在 tags 里」
        self._load_danbooru_aliases()
        self._tag_keys = sorted(self.tags.keys())
        # 中文行排序：先按中文键（供 bisect 前缀），同行再按帖数降序（供直接取头部）
        self._zh_rows.sort(key=lambda row: (row[0], -row[3]))
        self._zh_sorted = True
        # 首选中文名映射：只读 `_zh_rows` / 源表，不做任何重排（故可紧跟排序之后）
        self._build_zh_by_tag()
        # 排序完成后才建 2-gram 倒排（行号与 _zh_rows 顺序绑定，之后不得重排）
        self._build_zh_grams()
        # 拼音索引最后建：吃 characters / series 两张源表，桶内按帖数排序（不依赖 _zh_rows 行序）
        self._build_pinyin_index()
        self.tag_count = len(self.tags)
        self.zh_pair_count = len(self._zh_rows)
        self.built_at = time.time()
        self.build_ms = (time.perf_counter() - started) * 1000
        return self

    def _load_tags_csv(self) -> None:
        """载入英文标签表（第 1 列标签 / 第 2 列类别 / 第 3 列帖数 / 第 4 列中文说明）。"""
        try:
            with open(CSV_PATH, "r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.reader(handle):
                    if len(row) < 4:
                        continue
                    tag = str(row[0] or "").strip()
                    key = normalize_key(tag)
                    if not key or key in self.tags:
                        continue
                    try:
                        count = max(0, int(str(row[2] or "0").strip()))
                    except (TypeError, ValueError):
                        count = 0
                    self.tags[key] = (tag, count, str(row[1] or "0").strip())
            self.sources_loaded.append("csv")
        except (OSError, UnicodeError) as error:
            self.errors.append(f"csv: {type(error).__name__}: {error}")

    def _load_alias_index(self) -> None:
        """载入别名索引：characters / series / aliases 三张表都变成中文查询行。"""
        path = None
        for candidate in (ALIAS_PATH, ALIAS_FALLBACK_PATH):
            if os.path.isfile(candidate):
                path = candidate
                break
        if path is None:
            self.errors.append("alias_index: 文件缺失")
            return
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError, TypeError) as error:
            self.errors.append(f"alias_index: {type(error).__name__}: {error}")
            return
        if not isinstance(payload, dict):
            self.errors.append("alias_index: 顶层不是对象")
            return

        characters = payload.get("characters") if isinstance(payload.get("characters"), dict) else {}
        series = payload.get("series") if isinstance(payload.get("series"), dict) else {}
        aliases = payload.get("aliases") if isinstance(payload.get("aliases"), dict) else {}
        self.characters = characters
        self.series = series

        def series_display(series_key: str) -> str:
            meta = series.get(series_key)
            if isinstance(meta, dict):
                for field in ("sn", "n"):
                    text = str(meta.get(field) or "").strip()
                    if text:
                        return text
            return str(series_key or "")

        # ① characters：角色主表（带作品与帖数，质量最高）
        for _slug, meta in characters.items():
            if not isinstance(meta, dict):
                continue
            tag = str(meta.get("t") or "").strip()
            if not tag:
                continue
            key = normalize_key(tag)
            try:
                count = max(0, int(meta.get("c") or 0))
            except (TypeError, ValueError):
                count = 0
            series_key = str(meta.get("s") or "")
            display = series_display(series_key)
            for zh in meta.get("zh") or ():
                zh_text = str(zh or "").strip()
                if zh_text and has_cjk(zh_text):
                    self._zh_rows.append((normalize_key(zh_text), key, zh_text, count, series_key, display))
                    # 角色也补进英文表：CSV 里可能没有该角色（新角色/别名写法不同）
                    self.tags.setdefault(key, (tag, count, "4"))

        # ② series：作品表（查「东方」「原神」这类作品名）
        for series_key, meta in series.items():
            if not isinstance(meta, dict):
                continue
            tag = str(meta.get("n") or series_key or "").strip()
            if not tag:
                continue
            key = normalize_key(tag)
            try:
                count = max(0, int(meta.get("c") or 0))
            except (TypeError, ValueError):
                count = 0
            display = series_display(series_key)
            for zh in meta.get("zh") or ():
                zh_text = str(zh or "").strip()
                if zh_text and has_cjk(zh_text):
                    self._zh_rows.append((normalize_key(zh_text), key, zh_text, count, series_key, display))
            self.tags.setdefault(key, (tag, count, "3"))

        # ③ aliases：全量标签别名（覆盖面最广，帖数用 CSV 里的真值补齐）
        for raw_tag, names in aliases.items():
            if not isinstance(names, (list, tuple)):
                continue
            key = normalize_key(raw_tag)
            if not key:
                continue
            entry = self.tags.get(key)
            count = entry[1] if entry else 0
            for zh in names:
                zh_text = str(zh or "").strip()
                if zh_text and has_cjk(zh_text):
                    self._zh_rows.append((normalize_key(zh_text), key, zh_text, count, "", ""))
        self.sources_loaded.append("alias_index")

    def _load_danbooru_aliases(self) -> None:
        """载入 D 站英文别名表（JSONL 每行 `{"a": 别名, "c": 规范标签}`）→ `别名键 → 规范标签键`。

        实测结构（`head -3 data/_sources/danbooru_aliases.jsonl`）：
            {"a":"noyabr","c":"noyabr_(yinzhizhen)","_page":1}
            {"a":"drunkenjurei.","c":"notsumami_sake","_page":1}
            {"a":"favilia","c":"breadgunn","_page":1}
        40,997 行**全英文、零汉字**（故不产生中文行，只服务英文查询路）。

        收录判据（**不硬塞**）：`c` 归一化后必须已存在于 `self.tags`，否则该别名命中后
        拿不到显示名与帖数，会以 count=0 的空壳挤占浮层候选位。实测 40,997 行里
        canonical 在本地标签表中的约 54%，其余一律跳过并计数（`alias_skipped`）。

        成本：一次 2.5MB 行读 + 一次字典查 + 一次 2 万键排序，全部发生在**构建期**
        （后台预热线程内），查询侧只做 `dict.get` 与 `bisect` —— 与 `_tag_keys` 同一纪律。
        """
        if not os.path.isfile(DANBOORU_ALIASES_PATH):
            # 纯增益数据：缺失不是错误，只是少一路命中（与 CSV/别名索引缺失的语义不同）
            return
        alias_map: dict[str, str] = {}
        alias_display: dict[str, str] = {}
        skipped = 0
        try:
            with open(DANBOORU_ALIASES_PATH, "r", encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        skipped += 1
                        continue
                    if not isinstance(obj, dict):
                        skipped += 1
                        continue
                    raw_alias = str(obj.get("a") or "").strip()
                    alias_key = normalize_key(raw_alias)
                    canon_key = normalize_key(obj.get("c"))
                    if not alias_key or not canon_key or alias_key == canon_key:
                        skipped += 1
                        continue
                    if canon_key not in self.tags:
                        skipped += 1
                        continue
                    # 别名可能重复指向同一规范标签：保留首个（文件内按 `_page` 分页采集）
                    if alias_key not in alias_map:
                        alias_map[alias_key] = canon_key
                        alias_display[alias_key] = raw_alias
        except (OSError, UnicodeError) as error:
            self.errors.append(f"danbooru_aliases: {type(error).__name__}: {error}")
            return
        self._alias_map = alias_map
        self._alias_display = alias_display
        self._alias_keys = sorted(alias_map.keys())
        self.alias_count = len(alias_map)
        self.alias_skipped = skipped
        self.sources_loaded.append("danbooru_aliases")

    # ---------- 查询 ----------

    def suggest(self, query: str, limit: int = MAX_RESULTS) -> list[dict[str, Any]]:
        """统一联想入口：中文走别名前缀 + 子串兜底，英文走标签前缀。

        返回 [{tag, count, zh, series, zh_all, score, match}] —— 字段名与
        `anima_prompt_cards._autocomplete_result` 保持同义，便于前端复用渲染。
        """
        normalized = normalize_key(query)
        if not normalized:
            return []
        try:
            limit = max(1, min(MAX_RESULTS, int(limit)))
        except (TypeError, ValueError):
            limit = MAX_RESULTS
        if has_cjk(query):
            return self._suggest_zh(normalized, limit)
        return self._suggest_en(normalized, limit)

    def _suggest_en(self, normalized: str, limit: int) -> list[dict[str, Any]]:
        """英文：别名精确 → 标签/别名前缀 → 中缀兜底，各档内按帖数降序。

        别名路（2026-09-26 接入 `danbooru_aliases.jsonl`）救的是「输入旧名/别名查不到」
        那类必然空手而归的查询：`lightning_(ff13)` → `lightning_farron`、
        `mii_1oo` → `kuro_miya`（实测这两条改前 0 命中且要付 30ms 中缀全表扫描）。
        查询侧只有一次 `dict.get` 与一次 `bisect`，**不做归一化、不做全表扫描**
        （归一化键与排序键都在构建期预建，与 `_tag_keys` 同一纪律）。
        """
        hits: list[tuple[int, str, str, int, str]] = []
        # ① 别名精确命中：强信号，与「标签完全相等」同档（rank 0），排最前
        exact_key = self._alias_map.get(normalized)
        if exact_key is not None:
            entry = self.tags.get(exact_key)
            if entry is not None:
                hits.append(
                    (0, entry[0], exact_key, entry[1], self._alias_display.get(normalized, ""))
                )
        # ② 标签前缀（既有路径：二分 + 有界扫描）
        start = bisect.bisect_left(self._tag_keys, normalized)
        for index in range(start, min(start + _PREFIX_SCAN_CAP, len(self._tag_keys))):
            key = self._tag_keys[index]
            if not key.startswith(normalized):
                break
            entry = self.tags.get(key)
            if entry is None:
                continue
            # 完全相等排最前，其次是前缀
            hits.append((0 if key == normalized else 1, entry[0], key, entry[1], ""))
        # ③ 别名前缀：`lightn` → 别名 `lightning_(ff13)` → 规范标签 `lightning_farron`
        alias_start = bisect.bisect_left(self._alias_keys, normalized)
        for index in range(alias_start, min(alias_start + _PREFIX_SCAN_CAP, len(self._alias_keys))):
            alias_key = self._alias_keys[index]
            if not alias_key.startswith(normalized):
                break
            canon_key = self._alias_map.get(alias_key)
            if canon_key is None:
                continue
            entry = self.tags.get(canon_key)
            if entry is None:
                continue
            hits.append((2, entry[0], canon_key, entry[1], self._alias_display.get(alias_key, "")))
        if not hits:
            # 兜底：中缀匹配（`sune_mi` 这类中间片段），成本可控（205k 次子串判断）
            for key, (tag, count, _cat) in self.tags.items():
                if normalized in key and len(normalized) >= 3:
                    hits.append((3, tag, key, count, ""))
        hits.sort(key=lambda row: (row[0], -row[3], row[1]))
        # ④ 拼音路（纯增益，与英文命中一起排序，不挤占也不被挤占）：
        #    `chuyin` → 「初音未来」/ `cywl` → 首字母缩写。候选池已经远超 limit 时不必再扫
        #    （那种查询英文侧本就够喂满浮层），否则每次英文查询都要白付一次拼音扫描。
        if len(hits) < limit * 4:
            for rank, tag, key, count, zh in self._suggest_pinyin(normalized, limit):
                hits.append((rank, tag, key, count, zh))
            hits.sort(key=lambda row: (row[0], -row[3], row[1]))
        # 同一规范标签可能被「别名路」与「标签路」各命中一次：去重保留排序靠前者
        seen: set[str] = set()
        result: list[dict[str, Any]] = []
        for _rank, tag, key, count, alias in hits:
            if key in seen:
                continue
            seen.add(key)
            result.append(self._row(tag, key, count, "", "", alias))
            if len(result) >= limit:
                break
        return result

    def _suggest_pinyin(self, normalized: str, limit: int) -> list[tuple[int, str, str, int, str]]:
        """拼音路：精确键（`cywl` / `chuyinweilai`）→ 前缀二分（`chuy` → `chuyin…`）。

        返回 `(rank, 显示标签, tag键, 帖数, 中文名)`；拼音命中统一取 `rank` 2（与英文路的
        「别名前缀」同档），**不区分精确/前缀** —— 两者常指向同一批角色，若精确键给更高档，
        某个冷门同名角色会盖住真正的热门角色（`anima_animadex` 侧 2026-09-27 实测踩过：
        「拼音能搜到但首条是错的人」）。同档内一律按帖数决先后，与英文命中同一把尺子。

        键全部构建期预建（见 `_build_pinyin_index`），此处只有 `dict.get` + `bisect` + 有界扫描，
        **不做任何实时拼音转换**；`zh` 由构建期存下的 (中文名, tag键) 元组直接取，无回查。
        """
        if limit <= 0 or not self._pinyin_keys:
            return []
        # 候选收集成 (rank, tag键, 中文显示名)：显示名在构建期已知，不必回查
        candidates: list[tuple[int, str, str]] = []
        for zh_text, tag_key in self._pinyin_exact.get(normalized, ()):
            candidates.append((2, tag_key, zh_text))
        start = bisect.bisect_left(self._pinyin_keys, normalized)
        for index in range(start, min(start + _PINYIN_SCAN_CAP, len(self._pinyin_keys))):
            key = self._pinyin_keys[index]
            if not key.startswith(normalized):
                break
            for zh_text, tag_key in self._pinyin_prefix.get(key, ()):
                candidates.append((2, tag_key, zh_text))
        out: list[tuple[int, str, str, int, str]] = []
        seen: set[str] = set()
        for rank, tag_key, zh_text in candidates:
            if tag_key in seen:
                continue
            seen.add(tag_key)
            entry = self.tags.get(tag_key)
            if entry is None:
                continue
            out.append((rank, entry[0], tag_key, entry[1], zh_text))
            if len(out) >= limit:
                break
        return out

    def _build_zh_grams(self) -> None:
        """建中文 2-gram 倒排索引：`{二字组: [行号, ...]}`。

        只用查询的**第一个**二字组做粗筛（足够），再对候选行做精确 `in` 判断。
        为什么要做：中文子串匹配原先要遍历全部 23.5 万行（47 万对展开后更久），
        实测「蓝档」这类中间片段查询耗时 42ms；倒排粗筛后只扫命中的那一小撮行。

        **索引每行的全部二字组（2026-09-27 修，缺陷 3）**：原实现写作
        `range(min(len(text) - 1, 6))` —— 只收每个词的前 6 个二字组，于是第 7 个字符位
        起的二字组不在表里，而 `_zh_gram_candidates` 却把「不在表里」当成「不可能有子串
        命中」的**有效推断**，直接返回空。实测：`suggest('幕杀')` → 0 条，而
        「007大破天幕杀机」（'幕杀' 起于第 7 位）确实存在；`suggest('达全')` 同病
        （'00量子型高达全刃式'，起于第 7 位）。

        成本实测（本机 235,540 行）：全量 157,601 键 / 构建 447 ms，截断版 156,684 键 /
        257 ms —— **只多 917 个键、多 190 ms**，因为中文名绝大多数在 7 字以内；且这 190 ms
        发生在后台预热线程内，不占首查。反过来若走「桶缺失即线性扫描」那条修法，实测
        每次未命中的中文查询要付 **25.6 ms**（235,540 行全扫），而快速否定是 0.06 ms。

        行号按 `_zh_rows` 的**当前顺序**记录 —— 故本索引必须在 `_zh_rows` 排序完成后才建，
        且**不得在之后重排 `_zh_rows`**（`build()` 里排序紧接其后调用本方法）。
        """
        grams: dict[str, list[int]] = {}
        for index, row in enumerate(self._zh_rows):
            text = row[0]
            # 全量收录：不设上限，「二字组不在表里 ⇒ 无子串命中」才是有效推断
            for position in range(len(text) - 1):
                gram = text[position:position + 2]
                bucket = grams.get(gram)
                if bucket is None:
                    grams[gram] = [index]
                else:
                    bucket.append(index)
        self._zh_grams = grams

    def _build_pinyin_index(self) -> None:
        """预建「拼音键 → 中文名」索引（`anima_pinyin` 提供字表，**无第三方依赖**）。

        目的：中文用户打不出汉字时输入 `chuyin`（全拼）或 `cywl`（首字母缩写）也能命中
        「初音未来」。为什么必须在构建期预建：运行时转换要做「汉字→拼音 + 多音字消歧」，
        每次查询现算 —— 与 `search()` 里 400ms 那个踩坑同源。故查询侧只做 dict 查 + 二分。

        范围（**刻意收窄**）：只做 `anima_alias_index.json` 里**角色 / 作品的中文名**
        （实测 36,480 + 3,702 条源表 / 50,599 条中文名），**不做** 23.5 万条通用标签别名 ——
        后者会把键数从 ~13 万推到数十万，构建与内存都不划算，且收益极低（用户不会用拼音搜
        「蓝档」这类抽象标签）。范围收窄后仍是纯增益：命中不了的名字不影响任何既有路径。

        键的两路：全拼（`chuyinweilai`，多音字展开去重）与首字母缩写（`cywl`）。
        缺字（字表外的生僻字）整名放弃，**不产出半截拼音** —— 宁可不出候选。

        成本实测（本机，36,488 角色 / 23.5 万中文对）：构建 +0.4~0.5 s（在后台预热线程内，
        不占首查），产出 129,595 个键；查询侧 +0.2~0.4 ms。
        """
        try:
            from .anima_pinyin import pinyin_initials, pinyin_keys
        except ImportError:
            try:
                from anima_pinyin import pinyin_initials, pinyin_keys  # type: ignore[no-redef]
            except ImportError:
                # 纯增益模块缺失：拼音路为空，其余联想照常（失败绝不致命）
                self.errors.append("pinyin: 模块缺失")
                return
        names: list[tuple[str, str]] = []
        # 来源直接取 characters / series 两张源表（构建期已在内存），不猜 `_zh_rows` 的行号段
        for source in (self.characters, self.series):
            for source_key, meta in source.items():
                if not isinstance(meta, dict):
                    continue
                tag_key = normalize_key(meta.get("t") or meta.get("n") or source_key)
                if not tag_key:
                    continue
                for zh in meta.get("zh") or ():
                    zh_text = str(zh or "").strip()
                    if zh_text and has_cjk(zh_text):
                        names.append((zh_text, tag_key))
        exact: dict[str, list[tuple[str, str]]] = {}
        converted = 0
        for zh_text, tag_key in names:
            keys = pinyin_keys(zh_text)
            if not keys:
                # 字表缺字（生僻字）→ 整名放弃，不计入 converted
                continue
            converted += 1
            for key in keys:
                _pinyin_add(exact, key, zh_text, tag_key)
            # 首字母缩写由逐字首读音声母拼出（`初音未来` → `cywl`）
            # —— 与全拼路共用 `_pinyin_add`（原实现是 `initials not in exact` 才写，
            #    缩写冲突时只留首条；见该函数 docstring 的实测数字）
            initials = pinyin_initials(zh_text)
            if initials:
                _pinyin_add(exact, initials, zh_text, tag_key)
        # 桶内按帖数降序：`_suggest_pinyin` 会在 limit 处截断，桶内顺序即优先级。
        # 实测最大桶 824 条、33 个键超过 limit(40) —— 不排序则截断按源表遍历顺序走，
        # 会把热门角色截掉、留下冷门同名（`anima_animadex` 侧踩过同类问题）。
        for bucket in exact.values():
            bucket.sort(key=lambda item: -_tag_count(self.tags, item[1]))
        self._pinyin_exact = exact
        self._pinyin_prefix = exact
        self._pinyin_keys = sorted(exact.keys())
        self.pinyin_name_count = converted
        self.pinyin_key_count = len(exact)
        if exact:
            self.sources_loaded.append("pinyin")

    def _zh_gram_candidates(self, normalized: str) -> list[int] | None:
        """用 2-gram 倒排粗筛候选行号；无法粗筛（查询过短 / 索引未建）时返回 None。

        桶缺失时返回 `[]`（快速否定，0.06 ms）—— 该推断的有效性**依赖倒排表收录每行的
        全部二字组**（`_build_zh_grams`，2026-09-27 已由截断改为全量）。若将来为省内存
        重新截断索引，这里必须改回 `None`（退回线性扫描，实测 25.6 ms/次），否则漏结果
        的缺陷会静默复活。
        """
        grams = getattr(self, "_zh_grams", None)
        if not grams or len(normalized) < 2:
            return None
        bucket = grams.get(normalized[:2])
        if bucket is None:
            # 首二字组不在表里 ⇒ 不可能有子串命中（全量索引下这是**有效**推断，见 docstring）
            return []
        return bucket

    def _suggest_zh(self, normalized: str, limit: int) -> list[dict[str, Any]]:
        """中文：前缀二分（快）→ 前缀凑不满 limit 时补子串匹配（兜住「蓝档」这类中间片段）。

        子串匹配走 **2-gram 倒排索引**（见 `_build_zh_grams`）：先用查询的前两个字符
        定位候选行号集合，再对候选做精确 `in` 判断。实测把「蓝档」这类查询从
        全表 47 万对扫描（42ms）降到只扫命中集合（<5ms）。
        查询长度 <2 时无法建 gram，退回线性扫描（那种查询本身也极少）。

        **兜底触发条件（2026-09-27 修，缺陷 3 的一半）**：原实现写作 `if not rows` ——
        只有前缀**零命中**才兜底，于是「既有前缀命中、又有中缀命中」的查询会静默丢掉
        中缀那批。实测 `suggest('复活')` 只回 12 条、真实命中 17 条：前缀侧命中 14 行
        （'复活节彩蛋' 等）就满足了 `rows` 非空，'巫女复活' / '潘尼拉的复活' /
        '怒首领蜂大复活' / '垣根帝督复活后' / '0723怨伤复活班' 全被跳过。现在改成
        「前缀凑不满 limit 就补」，与 `_suggest_en` 的中缀兜底语义对齐。
        """
        rows: list[tuple[str, str, str, int, str, str]] = []
        if self._zh_sorted:
            start = bisect.bisect_left(self._zh_rows, (normalized,))
            for index in range(start, min(start + _PREFIX_SCAN_CAP, len(self._zh_rows))):
                row = self._zh_rows[index]
                if not row[0].startswith(normalized):
                    break
                rows.append(row)
        # 前缀行数已达 limit ⇒ 不必再付子串扫描；否则补足（重复行由下方 tag 键去重兜住）
        if len(rows) < limit and len(self._zh_rows) <= _SUBSTRING_CAP:
            candidates = self._zh_gram_candidates(normalized)
            if candidates is not None:
                for index in candidates:
                    row = self._zh_rows[index]
                    if normalized in row[0]:
                        rows.append(row)
            elif not rows:
                # 单字查询建不了 gram，只能线性扫描（实测 24.8 ms）—— 故这一支仍**只在
                # 前缀零命中**时兜底：`suggest('幕')` 前缀已有 20 行，若在此线性扫描
                # 单键耗时从 0.02 ms 涨到 24.8 ms（联想浮层是逐键触发的，不能这么付）
                for row in self._zh_rows:
                    if normalized in row[0]:
                        rows.append(row)
        # 按帖数降序，汉字显示名去重
        rows.sort(key=lambda row: (-row[3], row[2]))
        seen: set[str] = set()
        result: list[dict[str, Any]] = []
        for _zh_key, tag_key, zh_display, count, series_key, series_display in rows:
            if tag_key in seen:
                continue
            seen.add(tag_key)
            result.append(self._row(tag_key, tag_key, count, zh_display, series_display))
            if len(result) >= limit:
                break
        return result

    def _row(
        self,
        tag: str,
        tag_key: str,
        count: int,
        zh: str = "",
        series_display: str = "",
        alias: str = "",
    ) -> dict[str, Any]:
        entry = self.tags.get(tag_key)
        display = entry[0] if entry else tag
        return {
            "tag": display,
            "tag_key": tag_key,
            "count": int(count or 0),
            "zh": zh,
            "series": series_display,
            # 由别名映射而来时填原始别名写法（空串 = 直接命中标签本身）
            "alias": alias,
            # 明确标注帖数来源：本地快照 ≠ D 站实时（实测差约 21%）
            "count_is_snapshot": True,
        }

    def _build_zh_by_tag(self) -> None:
        """预建 `tag键 → 首选中文名`（`lookup_zh` 走它，O(1)）。

        优先级（2026-09-27 修，缺陷 12）：
          ① 角色 / 作品主表 —— 这两张表的 `zh` 列表**主名在首**（数据源顺序即优先级），取首条；
          ② 其余（标签别名表）—— 取帖数最高者。

        原实现是「扫 `_zh_rows`，遇到第一个同 tag 的行就 break」，而 `_zh_rows` 按**中文键**
        排序，与「谁是主名」无关：实测 `lookup_zh('hatsune miku')` 返回「兔子洋装」
        （'兔' U+5154 排在 '初' U+521D 之前），而主表 `characters['hatsunemiku'].zh` 给的是
        `['初音未来', '彩色糖果', '兔子洋装', '初音', '望月礼服']` —— 主名是「初音未来」。
        顺带去掉两个无效动作：一个算了却没用的 `bisect`，以及每次查询的全表扫描
        （实测 235,540 行 16.7 ms → O(1)）。
        """
        best: dict[str, str] = {}
        for source in (self.characters, self.series):
            for source_key, meta in source.items():
                if not isinstance(meta, dict):
                    continue
                tag_key = normalize_key(meta.get("t") or meta.get("n") or source_key)
                if not tag_key or tag_key in best:
                    continue
                for zh in meta.get("zh") or ():
                    zh_text = str(zh or "").strip()
                    if zh_text and has_cjk(zh_text):
                        best[tag_key] = zh_text  # 首条即主名
                        break
        # 主表没给名的（通用标签别名）才回落到 `_zh_rows`，同 tag 取帖数最高者
        best_count: dict[str, int] = {}
        for row in self._zh_rows:
            tag_key, zh_text, count = row[1], row[2], row[3]
            if tag_key in best:
                continue
            if count > best_count.get(tag_key, -1):
                best_count[tag_key] = count
                best[tag_key] = zh_text
        self._zh_by_tag = best

    def lookup_zh(self, tag: str) -> str:
        """英文 tag → 首选中文显示名（供画廊卡片/浮层标注）。

        O(1)：走构建期预建的 `_zh_by_tag`（见 `_build_zh_by_tag`）。
        """
        key = normalize_key(tag)
        if not key:
            return ""
        return self._zh_by_tag.get(key, "")

    def stats(self) -> dict[str, Any]:
        return {
            "tag_count": self.tag_count,
            "zh_pair_count": self.zh_pair_count,
            "alias_count": self.alias_count,
            "alias_skipped": self.alias_skipped,
            # 拼音路规模（0 = 字表缺失或名字全部缺字；不影响其余联想）
            "pinyin_key_count": self.pinyin_key_count,
            "pinyin_name_count": self.pinyin_name_count,
            "series_count": len(self.series),
            "character_count": len(self.characters),
            "build_ms": round(self.build_ms, 1),
            "built_at": self.built_at,
            "sources": list(self.sources_loaded),
            "errors": list(self.errors),
        }


# ---------- 单例与预热 ----------

_INDEX: TagIndex | None = None
_INDEX_LOCK = threading.RLock()
_WARM_THREAD: threading.Thread | None = None


def get_index(build: bool = True) -> TagIndex | None:
    """取索引单例；`build=False` 时只返回已建好的（供预热线程自己调用）。"""
    global _INDEX
    with _INDEX_LOCK:
        if _INDEX is not None:
            return _INDEX
        if not build:
            return None
        index = TagIndex().build()
        _INDEX = index
        try:
            print(
                "[多源画廊·本地索引] 就绪：%s 标签 / %s 中文对 / %s 拼音键 / 构建 %.0f ms"
                % (f"{index.tag_count:,}", f"{index.zh_pair_count:,}",
                   f"{index.pinyin_key_count:,}", index.build_ms)
            )
        except Exception:
            pass
        return _INDEX


def warm_async() -> threading.Thread | None:
    """后台预热（幂等）。插件加载时调用，把 ~1.2s 的建索引成本挪出首次查询。"""
    global _WARM_THREAD
    with _INDEX_LOCK:
        if _INDEX is not None:
            return None
        if _WARM_THREAD is not None and _WARM_THREAD.is_alive():
            return _WARM_THREAD

        def worker() -> None:
            try:
                get_index()
            except Exception as error:  # noqa: BLE001 —— 预热失败不应影响插件加载
                print(f"[多源画廊·本地索引] 预热失败（首次查询时会重试）：{error}")

        thread = threading.Thread(target=worker, name="tk-gallery-tag-index", daemon=True)
        _WARM_THREAD = thread
        thread.start()
        return thread


def index_status() -> dict[str, Any]:
    """诊断用：索引规模与加载错误（不含任何用户数据）。"""
    index = get_index(build=False)
    if index is None:
        return {"ready": False, "warming": bool(_WARM_THREAD and _WARM_THREAD.is_alive())}
    return {"ready": True, "warming": False, **index.stats()}
