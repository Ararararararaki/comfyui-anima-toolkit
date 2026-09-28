"""画廊本地分类库 —— **按图源隔离**，同一图源内跨节点 / 跨工作流共享。

## 为什么要有这个模块（用户 2026-09-20 实报三件事）

1. **"多个画廊的分类居然不是共享的，这是巨大毛病"** ——
   分类原本存在**每个节点的** ``settings`` 里（``settings.categories`` 是分类定义、
   ``settings.postCategories`` 是图片归属），而 settings 会随工作流写进
   ``node.properties`` + localStorage ⇒ **同一工作流里两个画廊各有一份分类库**、互不可见。
   改为后端单文件存储后，同一图源的画廊节点、工作流共享同一份分类库。

2. **"P站画廊的分类是个摆设"** —— 分类浏览的实现是「拿到 id → 按 ``id:`` 元标签回查 D站帖子」，
   而 ``id:`` 只有 D站有 ⇒ P站/C站 的分类浏览永远是空的。
   现在**每条归类记录同时存一份条目快照**（图片 URL / prompt / 尺寸 / 图源…），
   分类浏览直接读本地快照，**不需要回查任何图源** ⇒ 三个图源通用。

3. **"D站和P站的分类还不是独立的，这是个大问题"**（同日第二轮实报）——
   上一版把分类库提到后端，却**没有源维度**：P站 建的分类会出现在 D站 的分类下拉里，
   计数还是两边混着算。现在分类库按 ``source`` **分区**：每个图源一套
   ``categories`` + ``posts``，分区之间互不可见；同一图源内仍然跨节点共享。

## 存储格式（``data/gallery_categories.json``，version 2）

```jsonc
{
  "version": 2,
  "sources": {
    "danbooru": {
      "categories": [
        {"id": "uncategorized", "name": "未分类", "sortOrder": 0},
        {"id": "cat_美图_1758xxxx", "name": "美图", "sortOrder": 1}
      ],
      "posts": {
        "danbooru:6365680": {                // ← key = "<source>:<id>"，跨源不会撞号
          "categoryId": "cat_美图_1758xxxx",
          "updatedAt": 1758xxxx,
          "snapshot": {                      // → 分类浏览直接渲染这份，不查图源
            "source": "danbooru", "id": "6365680",
            "preview_url": "...", "full_url": "...",
            "width": 1200, "height": 1600, "prompt": "...", "tags": ["..."],
            "rating": "g", "score": 12, "source_url": "...", "meta": {}
          }
        }
      },
      "updatedAt": 1758xxxx
    },
    "pixiv": { "categories": [...], "posts": {...}, "updatedAt": ... }
  }
}
```

**version 1 → 2 的迁移**（读文件时自动做一次，原文件先备份成
``gallery_categories.json.v1-backup-<时间戳>``）：旧库只有一套分类定义，按
「谁用过就归谁」分发 —— 某分类下有 P站 的帖子，就在 P站 分区里建同名同 id 的分类；
一条帖子都没有的分类归 D站（历史来源就是 D站）。**不删任何数据**。

## 线程/进程安全

ComfyUI 的 HTTP 路由跑在多线程里（aiohttp + 可能的线程池），所以：
* 读改写全程持 ``_LOCK``（可重入锁）；
* 落盘走**原子替换**（写临时文件 → ``os.replace``），不会出现半截 JSON；
* 文件损坏时把它备份成 ``.corrupt-<时间戳>`` 再重建，**绝不静默丢用户数据**。

核心数据层（``CategoryStore``）刻意**不依赖 aiohttp**，便于离线单测。
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
import threading
import time
from contextlib import contextmanager
from typing import Any

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PLUGIN_DIR, "data")
STORE_PATH = os.path.join(DATA_DIR, "gallery_categories.json")

UNCATEGORIZED_ID = "uncategorized"
UNCATEGORIZED_NAME = "未分类"

#: 当前存储版本（v2 = 按 source 分区）
STORE_VERSION = 2
#: 缺省图源：旧数据没有源前缀时按它归档（历史来源就是 D站）
DEFAULT_SOURCE = "danbooru"
#: 图源标识的合法形态（短标识；URL、含斜杠的东西一律不是图源标识）
SOURCE_ID_RE = re.compile(r"^[a-z0-9_]{1,32}$")

#: 单条快照保留的字段 —— **与协议层 ITEM_KEYS 逐字对齐**（`anima_gallery_sources.ITEM_KEYS`）。
#: 理由：前端渲染走的是 `galleryItemToPost(item)`，它吃的就是这套键。若这里用另一套命名
#: （imageUrl / thumbnailUrl…），"本地快照"与"搜索返回的 item"就成了两种形状，分类浏览
#: 必须再写一条渲染分支 —— 而**杜绝这种分叉**正是多源画廊当初定 13 键契约的目的。
SNAPSHOT_FIELDS = (
    "source", "id", "preview_url", "full_url", "width", "height",
    "tags", "prompt", "negative_prompt", "rating", "score", "source_url", "meta",
    # 展示补充：不属于 ITEM_KEYS，但适配器输出里本来就有，分类浏览用得上
    "file_ext", "video",
)
#: 快照里允许有多长的字符串（prompt 可能很长，但别无限）
SNAPSHOT_STR_LIMIT = 4000
#: 单个图源的分类数量上限（够用且防呆）
MAX_CATEGORIES = 200
#: 单个图源的条目数量上限；超了只在返回值里提示，**不自动删用户数据**
MAX_POSTS = 200_000


class CategoryStoreError(Exception):
    """数据层可预期的错误（路由层据此回 400）。"""


_MONOTONIC_MS_LOCK = threading.Lock()
_LAST_MS = 0


def _now_ms() -> int:
    """毫秒时间戳，且**同进程内严格单调递增**。

    连续操作（同一毫秒内多次归类/建类）若都拿到同一个毫秒值，list_posts 按
    updatedAt 倒序时相等元素会保持原插入顺序，「最近归类的排最前」就不成立
    （test_category_browse_is_sorted_by_update_time 捕获的正是这个：同一毫秒内
    连续归类三张，最新的那张反而排在最后）。
    """
    global _LAST_MS
    with _MONOTONIC_MS_LOCK:
        now = int(time.time() * 1000)
        if now <= _LAST_MS:
            now = _LAST_MS + 1
        _LAST_MS = now
        return now


def _clean_text(value: Any, limit: int = 200) -> str:
    return str(value or "").strip()[:limit]


def clean_source(value: Any) -> str:
    """图源标识归一化：**非法值一律落 ``DEFAULT_SOURCE``**（绝不隐式造出一个垃圾分区）。

    不做白名单 —— 图源适配器是**可插拔**的（``anima_gallery_sources`` 容错加载），
    写死三个名字会让新增图源静默丢分类。但形态必须收口：它同时是 JSON 的键与 URL 参数。
    """
    source = str(value or "").strip().lower()
    return source if SOURCE_ID_RE.match(source) else DEFAULT_SOURCE


def split_post_key(key: Any) -> tuple[str, str]:
    """``<source>:<id>`` → ``(source, id)``；没有前缀时按 D站 归档（旧数据形态）。

    ⚠️ 前缀不像图源标识时返回 ``("", "")`` —— **让调用方报错**，而不是把它塞进一个垃圾分区。
    真实事故（2026-09-20 实测）：前端误把 D站 原生 post 的 ``source``（作品来源 URL）当前缀，
    键变成 ``https://twitter.com/…:4583512``；旧实现会把它清成
    ``httpstwittercombartolomeobari2status…`` 这样一个谁都不认识的源，
    归类以"目标分类不存在"失败、数据静默丢失，用户看到的是"分类建好了却切换不进去"。
    """
    text = _clean_text(key, 128)
    if not text:
        return DEFAULT_SOURCE, ""
    source, sep, post_id = text.partition(":")
    if not sep:
        return DEFAULT_SOURCE, text          # 没有冒号 → 旧的纯 id 形态
    if not post_id:
        return "", ""                        # 有前缀但 id 为空（如 "pixiv:"）→ 非法，别当成纯 id
    if not SOURCE_ID_RE.match(source) or "/" in post_id or "://" in text:
        return "", ""
    return source, post_id


def make_post_key(source: Any, post_id: Any) -> str:
    """``<source>:<id>`` —— 跨源唯一。

    真实原因：D站/P站 的帖子 id 都是纯数字，**直接拿 id 当键会撞号**
    （例如 D站 123456 与 P站 123456 会被当成同一张图，分类互相覆盖）。
    """
    src = str(source or "").strip().lower()
    if not SOURCE_ID_RE.match(src):
        raise CategoryStoreError(f"图源标识不合法（须是 danbooru/pixiv 这类短标识）：{str(source or '')[:60]}")
    pid = _clean_text(post_id, 64)
    if not pid:
        raise CategoryStoreError("缺少帖子 id，无法生成分类键")
    return f"{src}:{pid}"


def sanitize_snapshot(raw: Any) -> dict:
    """只保留白名单字段，并裁剪超长字符串。

    快照会被**长期保存**，所以这里必须收口：一份 post JSON 动辄几十 KB
    （C站带 meta、D站带 tag 列表），几千张就能把 data/ 撑到几百 MB。
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for field in SNAPSHOT_FIELDS:
        if field not in raw:
            continue
        value = raw[field]
        if isinstance(value, str):
            value = value[:SNAPSHOT_STR_LIMIT]
        elif isinstance(value, bool) or value is None:
            value = value
        elif isinstance(value, (int, float)):
            # NaN / Infinity 会被 json.dump 写成非严格 JSON（浏览器 JSON.parse 直接抛错 ⇒
            # 整个图源的分类库都读不出来）—— 数值字段必须有限，否则丢弃。
            if isinstance(value, float) and not math.isfinite(value):
                continue
            value = value
        elif isinstance(value, list):
            # 只保留短小的字符串列表（如 tags）
            value = [str(item)[:120] for item in value[:60]]
        elif isinstance(value, dict):
            # `meta` 是嵌套对象（C站 的 civitaiResources、D站 的 fav_count…）。
            # 浅收口：只留一层标量，且限制条数与长度 —— 不能原样存，那正是会把文件撑爆的东西。
            cleaned: dict[str, Any] = {}
            for sub_key, sub_value in list(value.items())[:30]:
                if isinstance(sub_value, str):
                    cleaned[str(sub_key)[:60]] = sub_value[:600]
                elif isinstance(sub_value, bool) or sub_value is None:
                    cleaned[str(sub_key)[:60]] = sub_value
                elif isinstance(sub_value, (int, float)):
                    if isinstance(sub_value, float) and not math.isfinite(sub_value):
                        continue                       # 同上：NaN/Infinity 不落盘
                    cleaned[str(sub_key)[:60]] = sub_value
            value = cleaned
        else:
            continue
        out[field] = value
    return out


class CategoryStore:
    """``data/gallery_categories.json``（按图源分区）的读写门面。"""

    def __init__(self, path: str = STORE_PATH):
        self.path = path
        self._lock = threading.RLock()

    # ── 存储层 ────────────────────────────────────────────────────────────

    @contextmanager
    def _process_lock(self):
        """**跨进程 / 跨实例**互斥。

        实例内的 ``_lock``（RLock）只保护同一个 ``CategoryStore`` 的线程；但"多开一个 ComfyUI"
        或"ComfyUI 运行中跑同步脚本"是**第二个写者**。子代理 2026-09-20 实测：两个实例并发写
        会丢 80/80 条（`os.replace` 的目标是同一个文件，临时名唯一并不能解决"读-改-写"交错）。
        锁文件与数据文件分开，所以不影响 ``os.replace`` 的原子替换。
        """
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        handle = open(f"{self.path}.lock", "a+b")
        try:
            if os.name == "nt":                       # pragma: no cover - 平台分支
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:                                     # pragma: no cover - 平台分支
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            try:
                if os.name == "nt":                   # pragma: no cover
                    import msvcrt
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:                                 # pragma: no cover
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            handle.close()

    def _empty_source(self) -> dict:
        return {
            "categories": [
                {"id": UNCATEGORIZED_ID, "name": UNCATEGORIZED_NAME, "sortOrder": 0},
            ],
            "posts": {},
        }

    def _empty(self) -> dict:
        return {"version": STORE_VERSION, "sources": {}}

    #: 读文件时依次尝试的编码。用户用记事本/编辑器看过或存过这个 JSON 是**现实场景**：
    #: UTF-8 BOM、ANSI/GBK、UTF-16 都会让纯 ``utf-8`` 读取抛错 —— 而旧实现把这类
    #: 情况一律当成"文件损坏"，把**好数据**改名成 ``.corrupt-*`` 再返回空库，
    #: 随后任何一次写操作就把空库写回主路径 ⇒ 用户看到"分类突然全没了"。
    _READ_ENCODINGS = ("utf-8-sig", "gbk")

    def _load_payload(self) -> Any:
        """读 JSON：先容错常见编码，都解不出才算真损坏。"""
        with open(self.path, "rb") as handle:
            raw = handle.read()
        encodings = list(self._READ_ENCODINGS)
        if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):     # UTF-16 只在有 BOM 时才敢试
            encodings.insert(1, "utf-16")
        last_error: Exception | None = None
        for encoding in encodings:
            try:
                text = raw.decode(encoding)
            except (UnicodeDecodeError, LookupError) as error:
                last_error = error
                continue
            try:
                return json.loads(text)
            except json.JSONDecodeError as error:
                last_error = error
                break                                 # 编码对了、JSON 真坏了 → 不必再试别的编码
        raise last_error if last_error is not None else ValueError("无法解析分类库")

    def _quarantine(self, reason: Any) -> None:
        """把**确实**没法用的文件改名留档（绝不静默丢用户数据）。"""
        backup = f"{self.path}.corrupt-{int(time.time())}"
        try:
            os.replace(self.path, backup)
            detail = f"已备份为 {os.path.basename(backup)}"
        except OSError:
            detail = "备份失败"
        print(f"[多重画廊·分类库] 文件无法解析（{reason}），{detail}，将重建。")

    def _read_unlocked(self) -> dict:
        if not os.path.isfile(self.path):
            return self._empty()
        try:
            payload = self._load_payload()
        except OSError as error:
            # ⚠️ 权限/占用（Windows 上另一个写者正在 os.replace）**绝不能**当成"损坏"：
            #    旧实现会把好文件改名成 .corrupt-* 再返回空库，一次写操作就把空库写回主路径
            #    —— 子代理 2026-09-20 实测两实例并发时 80/80 条全丢。这里如实抛出，一个字节不动。
            raise CategoryStoreError(
                f"分类库文件无法读取（{error}）：请确认没有别的程序正在写它") from error
        except (ValueError, UnicodeDecodeError) as error:
            self._quarantine(error)
            return self._empty()
        if not isinstance(payload, dict):
            # 顶层是数组/标量：合法 JSON 但不是本模块的格式 —— 同样留档，别静默覆盖
            self._quarantine(f"顶层不是对象（{type(payload).__name__}）")
            return self._empty()
        try:
            version = int(payload.get("version") or 1)
        except (TypeError, ValueError):
            version = 1                               # version 写成 "2.0" 之类：别让整个接口 500
        sources = payload.get("sources")
        # `sources` 已存在就**按 v2 读**（哪怕 version 字段缺失/是坏的）——
        # 否则 `_upgrade_v1` 只认顶层 categories/posts，会把一份好端端的 v2 库清空。
        if version < STORE_VERSION and not (isinstance(sources, dict) and sources):
            # ★★ 升级自检（闸门必须放在**调用方**，不能放在 `_upgrade_v1` 内部 ——
            #    放内部的话，升级实现本身有 bug 时闸门跟着一起坏，等于没有）：
            #    合法条目一条都不许少，少一条就中止升级、原文件一个字节都不动。
            #    用户 2026-09-20 明确要求："不要因为这个，让更新的用户都损失分类里的图片。"
            raw_posts = payload.get("posts") if isinstance(payload.get("posts"), dict) else {}
            expected = len([key for key in raw_posts if split_post_key(key)[1]])
            upgraded = self._upgrade_v1(payload)
            actual = sum(len(bucket.get("posts") or {}) for bucket in upgraded["sources"].values())
            if actual < expected:
                raise CategoryStoreError(
                    f"分类库升级自检失败（{expected} → {actual} 条）：已中止升级，原文件未改动"
                    f"（备份 {os.path.basename(self.path)}.v1-backup-*）。"
                    "请把 data/gallery_categories.json 发给维护者排查。")
            payload = upgraded
            try:
                self._write_unlocked(payload)
            except OSError as error:      # 写不进去也要让本次会话能用（内存里已是 v2）
                print(f"[多重画廊·分类库] v1→v2 迁移落盘失败（{error}），本次仅内存生效。")
        if not isinstance(payload.get("sources"), dict):
            payload["sources"] = {}
        payload["version"] = STORE_VERSION
        for bucket in payload["sources"].values():
            if isinstance(bucket, dict):
                self._ensure_uncategorized(bucket)
        return payload

    def _upgrade_v1(self, payload: dict) -> dict:
        """v1（全局单库）→ v2（按 source 分区）：**谁用过就归谁**，一条都不丢。

        旧数据可能畸形（这是"用户升级后分类不见了"的高发区），所以这里逐项收口：
        没有 id 的分类补一个 id（不能因为缺 id 就丢分类）、重复 id 去重、
        归属指向不存在的分类时归入「未分类」（否则会留下"下拉里没有、条目却挂着"的孤儿）、
        值不是对象的条目保留 key 并归入「未分类」。
        """
        # ★ 备份必须在**任何原地修改之前**：旧实现先改归属再写备份 ⇒ 备份里看到的是改过的值，
        #   原始的 categoryId 在备份里也找不到了（"备份是原文件的忠实副本"这条性质被破坏）。
        backup = f"{self.path}.v1-backup-{int(time.time())}"
        try:
            with open(backup, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False, indent=1))
            detail = f"原文件已备份为 {os.path.basename(backup)}"
        except OSError as error:
            detail = f"备份失败（{error}）"

        raw_categories = [i for i in (payload.get("categories") or []) if isinstance(i, dict)]
        old_posts = payload.get("posts") if isinstance(payload.get("posts"), dict) else {}

        by_id: dict[str, dict] = {}
        for item in raw_categories:
            category_id = str(item.get("id") or "")
            if not category_id:                      # 缺 id → 补一个，别丢分类
                category_id = self._new_category_id(str(item.get("name") or "c"), DEFAULT_SOURCE)
                base, suffix = category_id, 1        # 同 slug 同毫秒会撞 → 加序号，别被 setdefault 吃掉
                while category_id in by_id:
                    suffix += 1
                    category_id = f"{base}-{suffix}"
                item = {**item, "id": category_id}
            by_id.setdefault(category_id, item)      # 重复 id 只留第一条

        # ① 帖子按 key 前缀落到各源
        posts_by_source: dict[str, dict] = {}
        dropped_keys: list[str] = []
        for raw_key, item in old_posts.items():
            source, post_id = split_post_key(raw_key)
            if not post_id:
                dropped_keys.append(str(raw_key))    # 非法键（URL 前缀 / 空 id）无法定源 → 计数上报
                continue
            if not isinstance(item, dict):
                # 值不是对象（旧数据畸形）：保留 key 并归入「未分类」，别静默丢条目
                item = {"categoryId": UNCATEGORIZED_ID, "updatedAt": _now_ms(), "snapshot": {}}
            posts_by_source.setdefault(source, {})[f"{source}:{post_id}"] = item

        # ② 悬空归属 → 「未分类」（分类被删但条目没退的旧数据）
        for posts in posts_by_source.values():
            for item in posts.values():
                if str(item.get("categoryId") or "") not in by_id:
                    item["categoryId"] = UNCATEGORIZED_ID

        # ③ 分类定义按「该源是否有帖子用它」分发；没被任何源用到的归缺省源
        used: dict[str, set[str]] = {}
        for source, posts in posts_by_source.items():
            used[source] = {str(i.get("categoryId") or "") for i in posts.values()}
        payload_out = self._empty()
        for source, posts in posts_by_source.items():
            bucket = payload_out["sources"].setdefault(source, self._empty_source())
            bucket["posts"] = posts
            for category_id in used.get(source, set()):
                category = by_id.get(category_id)
                if category is not None and not any(
                    str(c.get("id")) == category_id for c in bucket["categories"]
                ):
                    bucket["categories"].append(copy.deepcopy(category))
        default_bucket = payload_out["sources"].setdefault(DEFAULT_SOURCE, self._empty_source())
        for category in by_id.values():
            if str(category.get("id")) == UNCATEGORIZED_ID:
                continue
            if any(str(category.get("id")) in ids for ids in used.values()):
                continue
            default_bucket["categories"].append(copy.deepcopy(category))
        if isinstance(payload.get("updatedAt"), int):
            default_bucket["updatedAt"] = payload["updatedAt"]

        print(f"[多重画廊·分类库] 升级到 v2（按图源分区）：{detail}；"
              f"图源 {sorted(payload_out['sources'])}"
              + (f"；丢弃非法键 {len(dropped_keys)} 个（{dropped_keys[:3]}）" if dropped_keys else "")
              + "。")
        return payload_out

    @staticmethod
    def _ensure_uncategorized(bucket: dict) -> None:
        """「未分类」是**保留分类**：不能删、改名，且永远排在最前。"""
        if not isinstance(bucket.get("categories"), list):
            bucket["categories"] = []
        if not isinstance(bucket.get("posts"), dict):
            bucket["posts"] = {}
        categories = bucket["categories"]
        existing = next(
            (item for item in categories
             if isinstance(item, dict) and str(item.get("id")) == UNCATEGORIZED_ID),
            None,
        )
        if existing is None:
            categories.insert(0, {"id": UNCATEGORIZED_ID,
                                  "name": UNCATEGORIZED_NAME, "sortOrder": 0})
        else:
            existing["name"] = UNCATEGORIZED_NAME
            existing["sortOrder"] = 0

    def _write_unlocked(self, payload: dict) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        # 临时名带 pid + 线程 id：即使有两个 CategoryStore 实例指向同一文件（测试/多模块），
        # 也不会互相把对方的半截临时文件 rename 过去。
        temp = f"{self.path}.tmp-{os.getpid()}-{threading.get_ident()}"
        with open(temp, "w", encoding="utf-8") as handle:
            # allow_nan=False：宁可写失败，也不让 NaN/Infinity 落盘变成非严格 JSON
            # （浏览器 JSON.parse 一抛错，整个图源的分类库都读不出来）
            json.dump(payload, handle, ensure_ascii=False, indent=1, allow_nan=False)
        os.replace(temp, self.path)          # 原子替换：读端永远看不到半截文件

    def _bucket(self, payload: dict, source: Any, create: bool = False) -> dict | None:
        """取某图源的分区；``create=False`` 时不存在返回 ``None``（**不隐式建空分区**）。"""
        key = clean_source(source)
        bucket = payload["sources"].get(key)
        if not isinstance(bucket, dict):
            if not create:
                return None
            bucket = self._empty_source()
            payload["sources"][key] = bucket
        self._ensure_uncategorized(bucket)
        return bucket

    @staticmethod
    def _sorted_categories(bucket: dict) -> list[dict]:
        def sort_key(item: dict):
            is_uncategorized = str(item.get("id")) == UNCATEGORIZED_ID
            return (0 if is_uncategorized else 1,
                    int(item.get("sortOrder") or 0),
                    str(item.get("name") or ""))
        return sorted((i for i in bucket["categories"] if isinstance(i, dict)), key=sort_key)

    @staticmethod
    def _find_category(bucket: dict, category_id: Any) -> dict | None:
        target = str(category_id or "")
        return next((i for i in bucket["categories"]
                     if isinstance(i, dict) and str(i.get("id")) == target), None)

    @staticmethod
    def _new_category_id(name: str, source: str = "") -> str:
        """分类 id：``cat_<source>_<名字slug>_<毫秒>``。

        带图源前缀的理由（2026-09-20 子代理复查指出）：id 原先不含源，两个源在同一毫秒
        各建一个同名分类会生成**完全相同**的 id —— 分区隔离本身还在，但任何"只按
        ``categoryId`` 查、不带 ``source``"的下游代码就会串源。带前缀后一眼可辨、也不会撞。
        """
        slug = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fff]+", "-", str(name)).strip("-")[:32]
        prefix = f"{clean_source(source)}_" if source else ""
        return f"cat_{prefix}{slug or 'c'}_{_now_ms()}"

    # ── 查询 ──────────────────────────────────────────────────────────────

    def snapshot_all(self, source: Any = None) -> dict:
        """前端启动 / 换源时拉一次：**该图源**的分类列表 + 轻量归属映射（不含快照）。

        ``postCategories`` 只含本分区的条目 ⇒ 前端计数天然不会把别的图源算进来。
        """
        key = clean_source(source)
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            bucket = self._bucket(payload, key)
            if bucket is None:
                return {"source": key, "categories": self._sorted_categories(self._empty_source()),
                        "postCategories": {}, "total": 0, "updatedAt": None}
            return {
                "source": key,
                "categories": self._sorted_categories(bucket),
                "postCategories": {
                    post_key: str(item.get("categoryId") or "")
                    for post_key, item in bucket["posts"].items()
                    if isinstance(item, dict)
                },
                "total": len(bucket["posts"]),
                "updatedAt": bucket.get("updatedAt"),
            }

    def sources_summary(self) -> dict:
        """诊断用：每个图源各有多少分类 / 条目（分类库"分家"了没有，一眼可见）。"""
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            return {
                source: {
                    "categories": len(self._sorted_categories(bucket)),
                    "posts": len(bucket.get("posts") or {}),
                }
                for source, bucket in payload["sources"].items()
                if isinstance(bucket, dict)
            }

    def list_posts(self, category_id: str | None = None, source: Any = None) -> dict:
        """分类浏览用：返回**该图源**该分类下的完整条目快照（不回查图源）。"""
        key = clean_source(source)
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            bucket = self._bucket(payload, key)
            items: list[dict] = []
            if bucket is not None:
                for post_key, item in bucket["posts"].items():
                    if not isinstance(item, dict):
                        continue
                    if category_id and str(item.get("categoryId") or "") != str(category_id):
                        continue
                    snapshot = item.get("snapshot") if isinstance(item.get("snapshot"), dict) else {}
                    items.append({"postKey": post_key,
                                  "categoryId": item.get("categoryId"),
                                  "updatedAt": item.get("updatedAt"),
                                  **snapshot})
                items.sort(key=lambda entry: int(entry.get("updatedAt") or 0), reverse=True)
            return {"items": items, "total": len(items),
                    "categoryId": category_id or None, "source": key}

    # ── 写操作 ────────────────────────────────────────────────────────────

    def create_category(self, name: Any, source: Any = None) -> dict:
        clean = _clean_text(name, 40)
        if not clean:
            raise CategoryStoreError("分类名不能为空")
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            bucket = self._bucket(payload, source, create=True)
            if len(bucket["categories"]) >= MAX_CATEGORIES:
                raise CategoryStoreError(f"分类数量已达上限 {MAX_CATEGORIES}")
            existing = next((i for i in bucket["categories"]
                             if isinstance(i, dict) and str(i.get("name")) == clean), None)
            if existing:                       # 同名视为幂等，直接返回既有的
                return {"category": existing, "created": False, "source": clean_source(source)}
            order = max((int(i.get("sortOrder") or 0)
                         for i in bucket["categories"] if isinstance(i, dict)), default=0) + 1
            category = {"id": self._new_category_id(clean, clean_source(source)),
                        "name": clean, "sortOrder": order}
            bucket["categories"].append(category)
            bucket["updatedAt"] = _now_ms()
            self._write_unlocked(payload)
            return {"category": category, "created": True, "source": clean_source(source)}

    def rename_category(self, category_id: Any, name: Any, source: Any = None) -> dict:
        clean = _clean_text(name, 40)
        if not clean:
            raise CategoryStoreError("分类名不能为空")
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            bucket = self._bucket(payload, source)
            category = self._find_category(bucket, category_id) if bucket is not None else None
            if category is None:
                raise CategoryStoreError("分类不存在")
            if str(category["id"]) == UNCATEGORIZED_ID:
                raise CategoryStoreError("「未分类」是保留分类，不能改名")
            category["name"] = clean
            bucket["updatedAt"] = _now_ms()
            self._write_unlocked(payload)
            return {"category": category}

    def delete_category(self, category_id: Any, source: Any = None) -> dict:
        """删分类 → 该类下的图片**退回「未分类」**（不删条目，避免误删用户数据）。"""
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            bucket = self._bucket(payload, source)
            category = self._find_category(bucket, category_id) if bucket is not None else None
            if category is None:
                raise CategoryStoreError("分类不存在")
            if str(category["id"]) == UNCATEGORIZED_ID:
                raise CategoryStoreError("「未分类」是保留分类，不能删除")
            bucket["categories"] = [i for i in bucket["categories"] if i is not category]
            moved = 0
            for item in bucket["posts"].values():
                if isinstance(item, dict) and str(item.get("categoryId") or "") == str(category["id"]):
                    item["categoryId"] = UNCATEGORIZED_ID
                    moved += 1
            bucket["updatedAt"] = _now_ms()
            self._write_unlocked(payload)
            return {"deleted": category["id"], "movedToUncategorized": moved}

    def reorder_categories(self, ordered_ids: Any, source: Any = None) -> dict:
        if not isinstance(ordered_ids, list):
            raise CategoryStoreError("orderedIds 必须是数组")
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            bucket = self._bucket(payload, source)
            if bucket is None:
                # 不隐式建空分区（与 _bucket(create=False) 的约定一致：没这个源就是没数据）
                return {"categories": []}
            position = {}
            for index, raw in enumerate(ordered_ids):
                position[str(raw)] = index + 1        # 「未分类」由 _sorted_categories 强制置顶
            for item in bucket["categories"]:
                if isinstance(item, dict) and str(item.get("id")) in position:
                    item["sortOrder"] = position[str(item["id"])]
            bucket["updatedAt"] = _now_ms()
            self._write_unlocked(payload)
            return {"categories": self._sorted_categories(bucket)}

    def set_post_category(self, post_key: Any, category_id: Any, snapshot: Any = None,
                          source: Any = None, post_id: Any = None) -> dict:
        """归类（``categoryId`` 为空 = 取消归类并删除该条目）。

        **图源从 ``postKey`` 前缀推导**（前端传的就是 ``<source>:<id>``），
        所以"在 P站 把图归到 D站 的分类"这种串源写入会在这一层被挡住。

        ``snapshot`` 会被 ``sanitize_snapshot`` 收口后**长期保存** —— 这是
        "分类浏览不再回查图源" 的数据基础。
        """
        key = _clean_text(post_key, 128)
        if not key:
            # 前端没给 key 时用 source+id 兜底生成，避免这类调用直接失败
            key = make_post_key(source, post_id)
        key_source, key_post_id = split_post_key(key)
        if not key_post_id:
            raise CategoryStoreError(
                "分类键不合法：图源前缀必须是 danbooru/pixiv 这类短标识（不能是作品来源 URL）"
                f"：{key[:80]}")
        key = f"{key_source}:{key_post_id}"
        clean_category = _clean_text(category_id, 80)
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            bucket = self._bucket(payload, key_source, create=True)
            if not clean_category:
                existed = bucket["posts"].pop(key, None) is not None
                bucket["updatedAt"] = _now_ms()
                self._write_unlocked(payload)
                return {"postKey": key, "source": key_source, "categoryId": None, "removed": existed}
            if self._find_category(bucket, clean_category) is None:
                raise CategoryStoreError("目标分类不存在")
            if key not in bucket["posts"] and len(bucket["posts"]) >= MAX_POSTS:
                raise CategoryStoreError(f"条目数量已达上限 {MAX_POSTS}，请先清理")
            entry = bucket["posts"].get(key)
            if not isinstance(entry, dict):
                entry = {}
            entry["categoryId"] = clean_category
            entry["updatedAt"] = _now_ms()
            clean_snapshot = sanitize_snapshot(snapshot)
            if clean_snapshot:
                entry["snapshot"] = clean_snapshot
            elif not isinstance(entry.get("snapshot"), dict):
                entry["snapshot"] = {}            # 没有快照也允许归类，只是分类浏览里显示占位
            bucket["posts"][key] = entry
            bucket["updatedAt"] = _now_ms()
            self._write_unlocked(payload)
            return {"postKey": key, "source": key_source, "categoryId": clean_category,
                    "snapshot": entry.get("snapshot") or {}}

    def remove_post(self, post_key: Any, source: Any = None) -> dict:
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            key_source, key_post_id = split_post_key(post_key)
            if not key_post_id:
                return {"removed": False}
            bucket = self._bucket(payload, key_source or source)
            removed = bucket["posts"].pop(f"{key_source}:{key_post_id}", None) is not None if bucket else False
            if bucket is not None:
                bucket["updatedAt"] = _now_ms()
                self._write_unlocked(payload)
            return {"removed": removed}

    def migrate(self, categories: Any, post_categories: Any,
                snapshots: Any = None, source: Any = None) -> dict:
        """把**节点本地**的旧分类数据并进**该图源**的分区（幂等，可重复调用）。

        背景：分类以前存在节点的 ``settings`` 里，所以升级后每个节点都握着一份
        "自己的"分类库。这里做**并集**而不是覆盖：
        * 同名分类复用该分区已有的那条（不重复建）；
        * 冲突的归属以**分区内已有值优先**（``globalWins`` 可关，用于"以本地为准"的显式迁移）；
        * 已存在的条目只补缺（快照为空时用本地快照填）；
        * 归属的 key 前缀与目标图源不一致时**跳过**（跨源污染比丢几条更糟）。
        """
        target_source = clean_source(source)
        clean_categories = [i for i in (categories or []) if isinstance(i, dict)]
        clean_posts = post_categories if isinstance(post_categories, dict) else {}
        pool = snapshots if isinstance(snapshots, dict) else {}
        created, merged, filled, skipped = 0, 0, 0, 0
        with self._process_lock(), self._lock:
            payload = self._read_unlocked()
            bucket = self._bucket(payload, target_source, create=True)
            name_to_id = {str(i.get("name")): str(i.get("id"))
                          for i in bucket["categories"] if isinstance(i, dict)}
            # 旧 id → 目标 id：同名复用**也要记**，否则旧归属（`{"danbooru:1": "local_1"}`）
            # 会因为 local_1 没被建出来而整条丢掉 —— 那正是"更新后分类没了"的来源。
            id_remap: dict[str, str] = {}
            # ① 分类定义：同名复用，新名新建
            for raw in clean_categories:
                name = _clean_text(raw.get("name"), 40)
                raw_id = str(raw.get("id") or "")
                if not name:
                    continue
                if name in name_to_id:
                    if raw_id:
                        id_remap[raw_id] = name_to_id[name]
                    continue
                if len(bucket["categories"]) >= MAX_CATEGORIES:
                    skipped += 1                   # 限额与 create_category 一致，别被迁移绕过
                    continue
                # 本地 id 已被**别的**分类占用 → 换新 id。否则分区内出现两条同 id：
                # 下拉列两条、点开是同一批图、删一条把两条的图全退回未分类（子代理 2026-09-20 实测）。
                if raw_id and self._find_category(bucket, raw_id) is not None:
                    raw_id = ""
                category = {"id": raw_id or self._new_category_id(name, target_source),
                            "name": name,
                            "sortOrder": int(raw.get("sortOrder") or len(name_to_id) + 1)}
                bucket["categories"].append(category)
                name_to_id[name] = category["id"]
                if raw_id:
                    id_remap[raw_id] = category["id"]
                created += 1
            # ② 归属：key 统一成 <source>:<id>，且只收本图源的条目
            for raw_key, raw_category in clean_posts.items():
                if not raw_category:
                    continue
                key_source, post_id = split_post_key(raw_key)
                if not post_id or key_source != target_source:
                    skipped += 1
                    continue
                target = (self._find_category(bucket, raw_category)
                          or self._find_category(bucket, id_remap.get(str(raw_category), "")))
                if target is None:
                    skipped += 1
                    continue
                key = f"{key_source}:{post_id}"
                snapshot = sanitize_snapshot(pool.get(raw_key) or pool.get(key))
                entry = bucket["posts"].get(key)
                if isinstance(entry, dict) and entry.get("categoryId"):
                    # 已有归属 → **不覆盖归属**；但快照为空时补填（docstring 承诺的行为，
                    # 旧实现直接整条跳过，于是 `snapshots` 参数等于死参数）
                    if snapshot and not entry.get("snapshot"):
                        entry["snapshot"] = snapshot
                        filled += 1
                    skipped += 1
                    continue
                if len(bucket["posts"]) >= MAX_POSTS:
                    skipped += 1
                    continue
                bucket["posts"][key] = {
                    "categoryId": target["id"],
                    "updatedAt": _now_ms(),
                    "snapshot": snapshot or {},
                }
                merged += 1
            bucket["updatedAt"] = _now_ms()
            self._write_unlocked(payload)
            return {"source": target_source, "created": created, "migrated": merged,
                    "filled": filled, "skipped": skipped, "total": len(bucket["posts"])}


# ── HTTP 路由（供前端面板调用）────────────────────────────────────────────
# 与 anima_gallery_*.py 的其它路由同风格；脱离 ComfyUI 运行时（单测）时不注册。
# ⚠️ 所有读写都带 `source`（GET 走 query、POST 走 body），缺省 = D站（兼容旧前端）。
STORE = CategoryStore()

try:  # pragma: no cover - 仅在 ComfyUI 运行时可用
    from aiohttp import web
    from server import PromptServer
except ImportError:  # pragma: no cover
    PromptServer = None
    web = None


if PromptServer is not None and web is not None and getattr(PromptServer, "instance", None):

    def _error(error: Exception, status: int = 400):
        return web.json_response({"ok": False, "error": str(error)}, status=status)

    @PromptServer.instance.routes.get("/anima/gallery/categories")
    async def anima_gallery_categories_get(request):
        """一次拉全**该图源**：分类定义 + 轻量归属映射（启动 / 换源时各调一次）。"""
        source = request.query.get("source")
        if (request.query.get("summary") or "").lower() in ("1", "true", "yes"):
            return web.json_response({"ok": True, "sources": STORE.sources_summary()})
        return web.json_response({"ok": True, **STORE.snapshot_all(source)})

    @PromptServer.instance.routes.post("/anima/gallery/categories")
    async def anima_gallery_categories_post(request):
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return _error("请求体不是合法 JSON")
        if not isinstance(payload, dict):
            return _error("请求体必须是对象")
        action = _clean_text(payload.get("action") or "create", 20).lower()
        source = payload.get("source")
        try:
            if action == "create":
                return web.json_response({"ok": True, **STORE.create_category(
                    payload.get("name"), source)})
            if action == "rename":
                return web.json_response({"ok": True, **STORE.rename_category(
                    payload.get("id"), payload.get("name"), source)})
            if action == "delete":
                return web.json_response({"ok": True, **STORE.delete_category(
                    payload.get("id"), source)})
            if action == "reorder":
                return web.json_response({"ok": True, **STORE.reorder_categories(
                    payload.get("orderedIds"), source)})
            return _error(f"未知 action：{action}")
        except CategoryStoreError as error:
            return _error(error)

    @PromptServer.instance.routes.get("/anima/gallery/posts")
    async def anima_gallery_posts_get(request):
        """分类浏览：直接返回**该图源**的本地条目快照，**不回查任何图源**。"""
        category_id = request.query.get("category") or None
        source = request.query.get("source")
        return web.json_response({"ok": True, **STORE.list_posts(category_id, source)})

    @PromptServer.instance.routes.post("/anima/gallery/posts/category")
    async def anima_gallery_posts_category_post(request):
        """归类 / 改类 / 取消归类（categoryId 传空 = 取消）。图源取自 postKey 前缀。"""
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return _error("请求体不是合法 JSON")
        if not isinstance(payload, dict):
            return _error("请求体必须是对象")
        try:
            return web.json_response({"ok": True, **STORE.set_post_category(
                payload.get("postKey"),
                payload.get("categoryId"),
                payload.get("snapshot"),
                payload.get("source"),
                payload.get("id"),
            )})
        except CategoryStoreError as error:
            return _error(error)

    @PromptServer.instance.routes.post("/anima/gallery/posts/remove")
    async def anima_gallery_posts_remove_post(request):
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return _error("请求体不是合法 JSON")
        if not isinstance(payload, dict):
            return _error("请求体必须是对象")
        return web.json_response({"ok": True, **STORE.remove_post(
            payload.get("postKey"), payload.get("source"))})

    @PromptServer.instance.routes.post("/anima/gallery/categories/migrate")
    async def anima_gallery_categories_migrate_post(request):
        """把节点本地的旧分类并进**该图源**的分区（幂等）。"""
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return _error("请求体不是合法 JSON")
        if not isinstance(payload, dict):
            return _error("请求体必须是对象")
        return web.json_response({"ok": True, **STORE.migrate(
            payload.get("categories"),
            payload.get("postCategories"),
            payload.get("snapshots"),
            payload.get("source"),
        )})
