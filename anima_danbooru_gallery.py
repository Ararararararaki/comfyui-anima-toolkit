"""D站画廊节点：受控 Danbooru 搜索、图片代理与工作流输出。"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import asyncio
import atexit
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait as futures_wait
from typing import Any, NamedTuple
from urllib.parse import urlencode, urlparse
import urllib.request

from aiohttp import web
import numpy as np
from PIL import Image
import requests
import torch

from server import PromptServer


DANBOORU_POSTS_URL = "https://danbooru.donmai.us/posts.json"
DANBOORU_ALLOWED_SUFFIX = ".donmai.us"
DANBOORU_HEADERS = {
    # Danbooru 的 Cloudflare 会拒绝带 ComfyUI 标识的默认 UA；保持源节点已实测可用的描述性 UA。
    "User-Agent": "Danbooru-Gallery/1.0",
    "Accept": "application/json",
}
MAX_SEARCH_TAGS = 12
MAX_PAGE_SIZE = 48
MIN_PAGE_SIZE = 1
CACHE_TTL_SECONDS = 30
CACHE_MAX_ENTRIES = 64
REQUEST_INTERVAL_SECONDS = 0.2
# Several cards can enter the internal scroll viewport together. Bound the
# proxy fan-out so a single gallery does not create dozens of concurrent CDN
# requests and starve the search/API requests.
IMAGE_PROXY_CONCURRENCY = 3
# Danbooru 对这几种 "慢排序" 在无时间窗时会对全库排序导致数据库超时（500）。
# 自动附带一个免费 metatag 时间窗即可稳定返回（与前端 anima_danbooru_gallery_widget.js 常量保持一致）。
SLOW_ORDERS = frozenset({"score", "favcount", "random"})
# 慢排序时间窗必须带 < 前缀（D站 的 age:1week 是「恰好一周前」等值语义会显示过期内容；
# age:<1week 才是近一周）。前端 anima_danbooru_gallery_widget.js currentQuery 同样拼 age:<。
DEFAULT_SLOW_ORDER_WINDOW = "<1week"
FREE_METATAGS = frozenset({
    "rating", "status", "is", "age", "date", "id", "limit", "score", "downvotes",
    "favcount", "width", "height", "ratio", "mpixels", "filesize", "filetype",
    "duration", "md5", "pixiv_id", "pixiv", "parent", "child", "upvote", "embedded",
    "tagcount",
})


# ---------- Danbooru 连通性：走系统代理（与源插件 PROXY_CONFIG="auto" 同约定） ----------
# 直连 danbooru.donmai.us 在本机网络下时通时断（照 Clash 代理即稳定），requests 默认只读 env 代理、
# 不读系统代理；这里是按源插件同样的语义解析代理：
#   显式 DANBOORU_PROXY_CONFIG 或 PROXY_CONFIG("http://...") > env HTTPS/HTTP_PROXY > 系统代理(WinINET) > 直连
PROXY_CONFIG = "auto"  # "auto" | "http://127.0.0.1:7890" | ""/None/off = 直连


def _resolve_danbooru_proxies() -> dict[str, str] | None:
    cfg = os.environ.get("DANBOORU_PROXY_CONFIG", PROXY_CONFIG or "").strip()
    if cfg.lower() not in {"", "auto", "none", "direct", "off"}:
        return {"http": cfg, "https": cfg}
    if PROXY_CONFIG.lower() not in {"", "auto", "none", "direct", "off"}:
        return {"http": PROXY_CONFIG, "https": PROXY_CONFIG}
    for env_name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = os.environ.get(env_name, "").strip()
        if value and value.lower() not in {"", "none", "direct", "off"}:
            return {"http": value, "https": value}
    # requests 不读系统代理；落地用 urllib 的 getproxies()（Windows 下=读注册表 WinINET 系统代理）
    try:
        system = urllib.request.getproxies()
        proxy = system.get("https") or system.get("http")
        if proxy and proxy.lower() not in {"", "none", "direct", "off"}:
            return {"http": proxy, "https": proxy}
    except Exception:
        pass
    # 系统代理读取失败/为空（如 Clash 系统代理开关短暂关闭、注册表瞬时空窗）：
    # 探测本机常见代理端口兜底，避免静默直连被墙导致「全部 20s 超时」。
    return _fallback_proxy()


# 常见本地代理端口（Clash 7890/7897/7891、V2Ray 10809、SS 1080、备用 2080）
FALLBACK_PROXY_PORTS = (7890, 7897, 7891, 10809, 2080, 1080)
_fallback_cache: dict[str, tuple[float, str]] = {}


def _probe_proxy_alive(server: str, timeout: float = 0.5) -> bool:
    """TCP 快速探测代理端口是否活着（把死代理拒之门外，不白等 20s）。"""
    try:
        parsed = urlparse(server)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 7890
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def _fallback_proxy() -> dict[str, str] | None:
    """并行探测常见本地代理端口，命中的代理 30s 内复用（避免每次请求重复探测）。"""
    now = time.monotonic()
    cached = _fallback_cache.get("last")
    if cached is not None and now - cached[0] < 30:
        server = cached[1]
        return {"http": server, "https": server} if server else None
    servers = [f"http://127.0.0.1:{port}" for port in FALLBACK_PROXY_PORTS]
    try:
        with ThreadPoolExecutor(max_workers=len(servers)) as pool:
            alive = list(pool.map(_probe_proxy_alive, servers))
    except Exception:
        alive = [False] * len(servers)
    server = next((s for s, ok in zip(servers, alive) if ok), "")
    _fallback_cache["last"] = (now, server)
    return {"http": server, "https": server} if server else None


_danbooru_session = requests.Session()
_danbooru_session.headers.update(DANBOORU_HEADERS)

_image_proxy_semaphore: asyncio.Semaphore | None = None


def _get_image_proxy_semaphore() -> asyncio.Semaphore:
    global _image_proxy_semaphore
    if _image_proxy_semaphore is None:
        _image_proxy_semaphore = asyncio.Semaphore(IMAGE_PROXY_CONCURRENCY)
    return _image_proxy_semaphore

# 直连被判定为不可达（连接挂起/超时一次后）→ 进程内记住「D站必须走代理」，
# 后续请求不再尝试直连（DNS 被劫持到黑洞 IP 时直连会白等）。
_direct_blocked = False
_direct_blocked_lock = threading.Lock()


def _mark_direct_blocked() -> None:
    global _direct_blocked
    with _direct_blocked_lock:
        _direct_blocked = True


def _proxy_candidates() -> list[dict[str, str]]:
    """按优先级收集代理候选（去重、过滤死值），供活性探测选路。"""
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(proxies: dict[str, str] | None) -> None:
        if not proxies:
            return
        server = proxies.get("https") or proxies.get("http")
        if not server or server in seen:
            return
        seen.add(server)
        candidates.append({"http": server, "https": server})

    cfg = os.environ.get("DANBOORU_PROXY_CONFIG", PROXY_CONFIG or "").strip()
    if cfg.lower() not in {"", "auto", "none", "direct", "off"}:
        add({"http": cfg, "https": cfg})
    for env_name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = os.environ.get(env_name, "").strip()
        if value and value.lower() not in {"", "none", "direct", "off"}:
            add({"http": value, "https": value})
    try:
        system = urllib.request.getproxies()
        add({"http": system.get("https") or system.get("http"), "https": system.get("https") or system.get("http")})
    except Exception:
        pass
    for port in FALLBACK_PROXY_PORTS:
        add({"http": f"http://127.0.0.1:{port}", "https": f"http://127.0.0.1:{port}"})
    return candidates


# 主路径的探测结果缓存：(单调时间, 选中的代理 server 或 ""=直连, 选中的请求头键)
# ⚠️ 2026-09-26 实测补上：原先只有 _fallback_proxy() 有缓存，主路径每次请求都全量重探，
# 而 pool.map 必须等最慢的那个死端口吃满 0.5s 超时 —— 本机 5 个死端口 ⇒ **每个请求白付 512ms**
# （实测三轮 512.7/511.9/511.2ms）。英文联想因此长期卡在 835~1113ms，与「搜索很慢」的用户体感同源。
_PROXY_PICK_LOCK = threading.Lock()
_PROXY_PICK_CACHE: dict[str, Any] = {"stamp": 0.0, "server": None, "proxies": None}
_PROXY_PICK_TTL = 30.0
#: 首轮探测的等待上限：只等「第一个活下来的」，不给死端口留满超时。
#: 死端口在 Windows 上 connect 直接吃满 timeout（实测 506~513ms），必须避免 let 它拖住整条链路。
_PROXY_FIRST_HIT_WAIT = 0.25


def _probe_first_alive(candidates: list[dict[str, str]]) -> dict[str, str] | None:
    """**并发滚动探测**：全部候选同时开探，谁先活着返回谁，不等其它 future。

    历史（2026-09-27 实测更正）：上一版是**串行 for + 0.25s 超时**，注释声称「零等待」，
    但那只在活代理恰好排首位时成立（本机 7890 排首位，所以没暴露）。实测反例：
      · 6 个候选全死 → `_apply_danbooru_proxy()` 冷路径 **2076ms**（串行累加 1524ms
        + 失败后再全量 `pool.map` 兜底 540ms）；
      · 活端口排最后 → **1538ms**。
    对照：本函数并发版在两种场景都≈**254ms**（= 单个候选的探测耗时）。
    且活端口排首位时仍保留**≈2ms**：先扫一遍「已完成的 future」，命中即返回 ——
    本机 7890 是 0.3ms 完成，所以首轮扫描就命中，不会被后面 250ms 才失败的死端口拖住。
    （⚠️ 不能用 `as_completed` 直接取第一个结果：它按**完成先后**而非**候选优先级**迭代，
    死端口 250ms 完成、活端口 0.3ms 完成时反而先撞上死端口，实测让首位场景退化成 266ms。）

    返回顺序仍按候选优先级：取「已完成的 future 里候选下标最小且活着」的那个；
    若多个几乎同时完成，同样按下标取最小者（保持「按优先级选路」的原语义）。
    """
    if not candidates:
        return None
    servers = [c.get("https") or c.get("http") or "" for c in candidates]
    pool: ThreadPoolExecutor | None = None
    try:
        pool = ThreadPoolExecutor(max_workers=min(len(servers), 8))
        submitted: list[tuple[int, Any]] = [
            (index, pool.submit(_probe_proxy_alive, server, _PROXY_FIRST_HIT_WAIT))
            for index, server in enumerate(servers)
            if server
        ]
        # 每轮等「下一个完成的」就重扫一遍已完成集合（按候选优先级取最小下标），
        # 于是活端口 0.3ms 完成时首轮即返回，而全死场景只等到 ~250ms 就收口。
        # +0.03s 是给「探测本体（urlparse + socket）在超时之外的开销」留的收口余量。
        deadline = time.monotonic() + _PROXY_FIRST_HIT_WAIT + 0.03
        done: set[Any] = set()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                newly, _ = futures_wait(
                    [future for _index, future in submitted],
                    timeout=remaining,
                    return_when=FIRST_COMPLETED,
                )
            except Exception:
                break
            done |= newly
            for index, future in sorted(submitted, key=lambda item: item[0]):
                if future in done:
                    try:
                        if future.result():
                            return candidates[index]
                    except Exception:
                        pass
            if not newly:
                break
    except Exception:
        return None
    finally:
        # ⚠️ 必须 `wait=False`：`with ThreadPoolExecutor(...)` 的 `__exit__` 会 join 所有
        # worker，于是「2ms 就返回」仍会被 6 个死端口各自的 250ms 拖满 —— 实测 258ms，
        # 正好把本函数的收益全部吃掉。死端口的探测线程在后台自然收尾即可（进程级 daemon）。
        if pool is not None:
            pool.shutdown(wait=False)
    return None


def _apply_danbooru_proxy() -> None:
    """每次请求前按当前环境实时解析代理（不再重启时一次性固化）。

    策略：在所有候选代理里挑「活着」的第一个（TCP 活性探测，并发滚动，见 `_probe_first_alive`），
    全部探测失败才直连。这样即使 Clash 系统代理开关被关/指向死端口/重启瞬间，
    也能自动落到可用的本地代理。

    缓存（2026-09-26 实测修复）：选路结果 30s 内复用 —— 见 `_PROXY_PICK_CACHE` 上方注释。
    原先该缓存只落在 `_fallback_proxy()`，主路径每次请求重探，白付 ~512ms/请求。

    2026-09-27 两处修正（冷审查实测）：
      ① `_direct_blocked` 判定**提到缓存检查之前**。原先它在缓存之后，于是「直连被判死」
         这个更强的信号会被 30s 缓存压住 —— 缓存里若存着「直连(空 dict)」的选路结果，
         接下来 30s 内每次请求都照旧直连，正是「直连被墙」重复发生的来源。
      ② session 代理改成**整体原子赋值**（`proxies = dict(chosen)`），不再
         `clear()` 后再 `update()` —— 那两步之间并发的画廊缩略图请求会读到空代理 = 直连。
    """
    global _direct_blocked
    now = time.monotonic()
    if _direct_blocked:
        # 直连曾失败：只用探测到的活代理，绝不直连。**先于缓存判定**（见 docstring ①）。
        fb = _fallback_proxy()
        if fb:
            _danbooru_session.proxies = dict(fb)  # 原子赋值（见 docstring ②）
            return
    with _PROXY_PICK_LOCK:
        cached = _PROXY_PICK_CACHE
        if cached["proxies"] is not None and now - float(cached["stamp"]) < _PROXY_PICK_TTL:
            _danbooru_session.proxies = dict(cached["proxies"])  # 原子赋值（见 docstring ②）
            return
    candidates = _proxy_candidates()
    picked = _probe_first_alive(candidates)
    # 注意：`_probe_first_alive` 已是**并发滚动**探测（全部候选同时开探），
    # 它的 None 就是「所有候选都死了」的完整结论，无需再做一次全量 `pool.map` 兜底 ——
    # 旧代码那一步会让全死场景多付 ~540ms（实测总 2076ms）。
    chosen: dict[str, str] = dict(picked) if picked else {}
    # 原子赋值（空 dict = 直连，语义同旧 clear()）；不再 clear()+update() 两步。
    _danbooru_session.proxies = dict(chosen)
    with _PROXY_PICK_LOCK:
        _PROXY_PICK_CACHE.update({"stamp": now, "proxies": chosen, "server": chosen.get("https") or ""})


# ---------- Danbooru 账号（上限按账号等级：Member=2、Gold=6、Platinum+=不限；登录后限流更宽） ----------
# 凭证只存本机插件目录 data/danbooru_account.json，绝不上传/不入 git。
_account_lock = threading.Lock()
_account_path = Path(__file__).with_name("data") / "danbooru_account.json"
_account_cache: dict[str, str] | None = None


def _load_account() -> dict[str, str]:
    global _account_cache
    with _account_lock:
        if _account_cache is not None:
            return _account_cache
        try:
            data = json.loads(_account_path.read_text(encoding="utf-8"))
            username = str(data.get("username") or "").strip()
            api_key = str(data.get("api_key") or "").strip()
            _account_cache = {"username": username, "api_key": api_key} if (username and api_key) else {}
        except (OSError, ValueError, TypeError):
            _account_cache = {}
        return _account_cache


def _registered() -> bool:
    acc = _load_account()
    return bool(acc.get("username") and acc.get("api_key"))


# ---------- D站 收藏读写（2026-09-27）----------------------------------------------
# 背景：画廊旧版的「★ 收藏」是**纯本地 localStorage 描边**（全文件没有任何地方读它做筛选/排序），
# 2026-09-21 被整体移除；用户实报"收藏了图片却找不到存放的地方"。现在做成**真正的 D站 收藏**：
#
#   读（列表）→ 标签搜索 `ordfav:<login>`：**完全复用既有搜索链路**，分页 / 无限滚动 /
#                缩略图代理 / 浮层全部白送 —— 画廊只需要多一个"我的收藏"入口。
#   读（状态）→ `GET /posts?tags=ordfav:<login>&limit=N` 拿回收藏的 post_id 集合，
#                卡片据此显示已收藏态（**一次请求**，不逐张查）。
#   读（总数）→ `GET /counts/posts.json?tags=ordfav:<login>`（`/posts.json` 不回 total）。
#   写        → `POST /favorites`（表单 post_id + Basic Auth）/ `DELETE /favorites/<record_id>`。
#                ⚠️ 取消收藏用的是**收藏记录 id**（不是 post_id），所以要先查出来。
#
# ⚠️ 凭据只从 data/danbooru_account.json 读；绝不进日志、绝不回给前端（只回 logged_in/username）。
_DANBOORU_API_ROOT = "https://danbooru.donmai.us"
_DANBOORU_FAVORITES_MINE = "/posts.json"      # ordfav: 搜索（读列表 + 读状态集合）
_DANBOORU_FAVORITES_WRITE = "/favorites.json"  # POST 新增 / DELETE /favorites/<id>
_DANBOORU_FAVORITE_COUNTS = "/counts/posts.json"
FAVORITES_STATE_LIMIT = 200   # 状态集合一次最多拉多少张（够覆盖一屏到几十屏）
_danbooru_identity_lock = threading.Lock()
_danbooru_identity_cache: dict[str, Any] | None = None


def _danbooru_auth() -> tuple[str, str] | None:
    """本机凭证；未登录返回 None（**不抛异常** —— 调用方据此给"请先登录"的友好提示）。"""
    acc = _load_account()
    username = str(acc.get("username") or "").strip()
    api_key = str(acc.get("api_key") or "").strip()
    if not username or not api_key:
        return None
    return username, api_key


def _danbooru_request(method: str, path: str, *, params: Any = None, data: Any = None,
                      auth: tuple[str, str] | None = None, timeout: int = 20) -> requests.Response:
    """带代理探测 + 换路重试的 D站 请求。

    为什么不复用 `_danbooru_json()`：它只做 GET、且不支持 Basic Auth / 表单体 ——
    收藏的写路径两者都要。换路逻辑与它保持一致（有代理 → 试直连；已直连 → 试兜底代理），
    代理一律**整体原子赋值**（并发取图线程不能读到空 proxies）。
    """
    _apply_danbooru_proxy()
    kwargs: dict[str, Any] = {"timeout": (6, timeout)}
    if params is not None:
        kwargs["params"] = params
    if data is not None:
        kwargs["data"] = data
    if auth is not None:
        kwargs["auth"] = auth
    try:
        resp = _danbooru_session.request(method, _DANBOORU_API_ROOT + path, **kwargs)
    except (requests.Timeout, requests.ConnectionError) as first:
        if _danbooru_session.proxies:
            _danbooru_session.proxies = {}
        else:
            _mark_direct_blocked()
            fb = _fallback_proxy()
            if fb:
                _danbooru_session.proxies = dict(fb)
        try:
            resp = _danbooru_session.request(method, _DANBOORU_API_ROOT + path, **kwargs)
        except (requests.Timeout, requests.ConnectionError) as second:
            raise RuntimeError(f"连不上 D站：{second}") from second
        del first
    return resp


def _danbooru_identity(force: bool = False) -> dict[str, Any]:
    """当前账号的 `{id, name, level, favorite_count, favorite_limit}`（进程内缓存）。

    写收藏要先知道 **user_id**（查询自己的收藏记录时按 user_id 过滤），
    总数/上限则用来在界面上说清"还剩多少条可用"。
    """
    global _danbooru_identity_cache
    auth = _danbooru_auth()
    if auth is None:
        return {}
    with _danbooru_identity_lock:
        if _danbooru_identity_cache is not None and not force:
            return _danbooru_identity_cache
    try:
        resp = _danbooru_request("GET", "/profile.json", auth=auth, timeout=15)
        if resp.status_code != 200:
            return {}
        data = resp.json()
    except (RuntimeError, ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    identity = {
        "id": int(data.get("id") or 0),
        "name": str(data.get("name") or ""),
        "level": str(data.get("level_string") or ""),
        "favorite_count": int(data.get("favorite_count") or 0),
        "favorite_limit": int(data.get("favorite_limit") or 0),
    }
    with _danbooru_identity_lock:
        _danbooru_identity_cache = identity
    return identity


def _clear_danbooru_identity() -> None:
    """切换账号 / 改凭证后必须清缓存（否则会拿旧账号的 user_id 去写收藏）。"""
    global _danbooru_identity_cache
    with _danbooru_identity_lock:
        _danbooru_identity_cache = None


def _favorite_write_error(status: int, body: str) -> str:
    """把 D站 收藏接口的失败翻成人话（上限 / 重复 / 权限）。"""
    text = (body or "").strip()
    lowered = text.lower()
    if "favorite limit" in lowered or "limit reached" in lowered or "maximum" in lowered:
        return "收藏已达 D站 账号上限（免费账号 200 条）：先在 D站 网站清理一些，或提升账号等级"
    if "already" in lowered or "taken" in lowered:
        return "这张图已经在你的 D站 收藏里了"
    if not text:
        return f"D站 拒绝这次操作（HTTP {status}）"
    return f"D站 拒绝这次操作（HTTP {status}）：{text[:160]}"


def _favorite_ids_for_user(login: str, limit: int = FAVORITES_STATE_LIMIT) -> list[str]:
    """当前账号收藏的 post_id 列表（按 ordfav 搜索，最近优先）。

    走的是**普通 posts.json 搜索**（与画廊其它请求同一条路），所以它天然继承代理/重试/风控行为。
    """
    try:
        resp = _danbooru_request("GET", _DANBOORU_FAVORITES_MINE,
                                 params={"tags": f"ordfav:{login}", "limit": str(limit), "page": "1"}, timeout=25)
        if resp.status_code != 200:
            return []
        rows = resp.json()
    except (RuntimeError, ValueError, TypeError):
        return []
    if not isinstance(rows, list):
        return []
    ids: list[str] = []
    for row in rows:
        if isinstance(row, dict) and row.get("id") is not None:
            ids.append(str(row["id"]))
    return ids


def _favorite_total(login: str) -> int:
    """收藏总数（`/counts/posts.json`；拿不到返回 -1，调用方显示"未知"）。"""
    try:
        resp = _danbooru_request("GET", _DANBOORU_FAVORITE_COUNTS, params={"tags": f"ordfav:{login}"}, timeout=15)
        if resp.status_code != 200:
            return -1
        payload = resp.json()
        counts = payload.get("counts") if isinstance(payload, dict) else None
        if isinstance(counts, dict) and counts.get("posts") is not None:
            return int(counts["posts"])
    except (RuntimeError, ValueError, TypeError):
        return -1
    return -1


def _account_params() -> dict[str, str]:
    acc = _load_account()
    if acc.get("username") and acc.get("api_key"):
        return {"login": acc["username"], "api_key": acc["api_key"]}
    return {}


# 计数标签上限按账号等级（实测：Member(level 20)=2、Gold(30)+=6，与匿名同为 2 的 Member 会让
# 「登录后 6 个」的旧假设放行 3~6 标签查询 → D站 422 TagLimitError）。等级缓存 1 小时。
_account_level_cache: int | None = None
_account_level_at: float = 0.0


def _account_tag_limit() -> int:
    global _account_level_cache, _account_level_at
    if not _registered():
        return 2
    now = time.time()
    if _account_level_cache is None or now - _account_level_at > 3600:
        level = 0
        try:
            data = _danbooru_json("https://danbooru.donmai.us/profile.json", {}, timeout=10)
            level = int(_safe_get(data, "level", 0) or 0)
        except Exception:
            level = 0  # 拉不到等级 → 保守按 2
        _account_level_cache = level
        _account_level_at = now
    return 6 if _account_level_cache >= 30 else 2


async def _account_tag_limit_async() -> int:
    """在工作线程查询账号等级，避免同步 Playwright 触碰 aiohttp 事件循环。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _account_tag_limit)


class _RateLimiter:
    def __init__(self, interval_seconds: float):
        self._interval_seconds = interval_seconds
        self._lock = threading.Lock()
        self._next_allowed_at = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = max(0.0, self._next_allowed_at - now)
            self._next_allowed_at = max(now, self._next_allowed_at) + self._interval_seconds
        if delay:
            time.sleep(delay)


@dataclass(frozen=True)
class SearchRequest:
    tags: str
    page: int
    limit: int
    force: bool = False

    @property
    def cache_key(self) -> tuple[str, int, int]:
        return (self.tags, self.page, self.limit)


_rate_limiter = _RateLimiter(REQUEST_INTERVAL_SECONDS)
_cache_lock = threading.Lock()
_search_cache: OrderedDict[tuple[str, int, int], tuple[float, list[dict[str, Any]]]] = OrderedDict()
_translation_lock = threading.Lock()
_translations: dict[str, str] | None = None
_translation_path = Path(__file__).with_name("data") / "danbooru_tags_zh.json"


def _search_tag_rewrite(token: str) -> tuple[str, str | None]:
    """把包含中文的搜索词反查为本地词典中的 Danbooru 英文标签。"""
    marker = ""
    body = token
    if body.startswith(("-", "~")):
        marker, body = body[0], body[1:]
    prefix, separator, _ = body.partition(":")
    if separator and prefix in FREE_METATAGS:
        return token, None
    if not any("\u4e00" <= char <= "\u9fff" for char in body):
        return token, None
    candidates = _local_zh_exact_tag_candidates(body, limit=1)
    if not candidates:
        return token, None
    rewritten = marker + candidates[0]
    return rewritten, f"{token} → {rewritten}"


def normalize_search_tags_with_rewrites(raw_tags: str) -> tuple[str, list[str]]:
    """规范化搜索标签，并返回中文词条实际采用的英文标签。"""
    seen: set[str] = set()
    normalized: list[str] = []
    rewrites: list[str] = []
    for raw_token in str(raw_tags or "").strip().split():
        token = raw_token.strip().lower().replace(" ", "_")
        if not token or token in seen:
            continue
        token, rewrite = _search_tag_rewrite(token)
        if token in seen:
            continue
        seen.add(token)
        normalized.append(token)
        if rewrite:
            rewrites.append(rewrite)
        if len(normalized) >= MAX_SEARCH_TAGS:
            break
    return " ".join(normalized), rewrites


def normalize_search_tags(raw_tags: str) -> str:
    """规范化标签，保留搜索语义但避免重复和无意义请求。"""
    return normalize_search_tags_with_rewrites(raw_tags)[0]


def count_restricted_search_tags(tags: str) -> int:
    """Danbooru 匿名/Member 搜索最多两个非 free metatag。"""
    count = 0
    for raw_token in str(tags or "").split():
        token = raw_token.lstrip("-~").lower()
        if token in {"or", "(", ")"}:
            continue
        prefix, separator, _ = token.partition(":")
        if not separator or prefix not in FREE_METATAGS:
            count += 1
    return count


def _bounded_int(value: str | None, default: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(value or default)))
    except (TypeError, ValueError):
        return default


def _order_value(tags: str) -> str:
    """从规范化标签里取唯一的 order:* 值（排序唯一 owner：前端 settings.filters.order）。"""
    for token in str(tags or "").split():
        if token.startswith("order:"):
            return token.split(":", 1)[1].lower().lstrip("+")
    return ""


def _has_age_tag(tags: str) -> bool:
    """慢排序需要时间窗兜底；已有用户显式 age:* 时不重复附加。"""
    return any(token.startswith("age:") for token in str(tags or "").split())


def _friendly_danbooru_error(error: requests.RequestException) -> str:
    """把 Danbooru 的 JSON 错误体转成用户能看懂的中文，而不是透传 "500 Server Error: ..." 这类原始串。"""
    response = getattr(error, "response", None)
    payload: dict[str, Any] | None = None
    if response is not None:
        try:
            parsed = response.json()
            if isinstance(parsed, dict):
                payload = parsed
        except ValueError:
            payload = None
    if payload is not None:
        raw_message = str(payload.get("message") or payload.get("error") or "").strip()
        error_name = str(payload.get("error") or "")
        status_code = getattr(response, "status_code", 0)
        if "Canceled" in error_name or "timeout" in raw_message.lower():
            return "D站 数据库超时：搜索范围过大。评分/收藏/随机排序必须带「时间」筛选，或改用「综合」排序。"
        if status_code == 422 or "TagLimitError" in error_name:
            return "D站 搜索限制：普通标签 + 排序最多 2 个计数标签。请减少普通标签，善用评级/时间/评分/收藏等筛选。"
        if raw_message:
            return f"D站 返回错误（HTTP {status_code}）：{raw_message}"
    return f"Danbooru 请求失败：{error}"


# ---------- Cloudflare 风控自救：内置浏览器网关 ----------
# Danbooru 的 Cloudflare 会对机房/代理出口 IP 做「Just a moment / 请稍候」交互式人机校验：
#   requests / urllib / curl / curl_cffi / cloudscraper 全都会被拦（导入依赖的 UA/TLS/JS 行为不足）。
#   实测只有「真实浏览器渲染引擎内的 fetch」（本机 Edge/Chrome）能稳定通过。
# 因此当 requests 路径被风控（403/503 校验页，或表现为超时/断连）时，惰性拉起一个
#   最小化于屏幕外的隐形式 Edge 窗口做网关，后续搜索/原图/下载全部改走真实页面 fetch；
#   网关一旦成功即常驻复用（避免反复开窗），ComfyUI 退出时 atexit 自动清理。
CF_BLOCKED_MSG = (
    "D站 当前被 Cloudflare 风控拦截；插件已自动尝试内置浏览器网关（Edge）仍未成功。"
    "请稍后再试，或在 Clash Verge 中切换「🔰 选择节点」的节点/地区。"
)
CF_CHALLENGE_ANCHORS = (
    "just a moment", "please wait", "请稍候",
    "cf-chl", "__cf_chl", "checking your browser",
)


def _is_cloudflare_challenge(status: int, body: str) -> bool:
    """识别 Cloudflare 的交互式人机校验页（403/503 + 特征锚点）。"""
    if status not in (403, 503):
        return False
    low = (body or "")[:2048].lower()
    return any(anchor in low for anchor in CF_CHALLENGE_ANCHORS)


def _resp_is_cf(resp: requests.Response) -> bool:
    """仅当响应像是校验页/HTML 时才解码正文做风控判断，避免无谓解码大图字节。"""
    ctype = (resp.headers.get("Content-Type") or "").lower()
    if resp.status_code in (403, 503) or "html" in ctype or "text" in ctype:
        try:
            return _is_cloudflare_challenge(resp.status_code, resp.text)
        except Exception:
            return False
    return False


_browser_lock = threading.Lock()
_browser: "_DanbooruBrowser | None" = None
_browser_working = False  # 网关成功过一次后置 True：后续请求直连网关，跳过 requests 往返


def _safe_get(mapping: Any, key: str, default: Any) -> Any:
    return mapping.get(key, default) if isinstance(mapping, dict) else default


class _DanbooruBrowser:
    """内置浏览器网关：用真实 Edge/Chrome 渲染引擎过 Cloudflare，供 API 与图片下载复用。"""

    _WARM_INTERVAL_SECONDS = 1100  # CF 的 __cf_bm/cf_clearance 约半小时有效，提前续活

    def __init__(self) -> None:
        self._playwright: Any = None
        self._context: Any = None
        self._page: Any = None
        self._channel: str = ""
        self._lock = threading.Lock()
        self._last_warm = 0.0

    def start(self) -> bool:
        try:
            from playwright.sync_api import sync_playwright
        except Exception as error:
            print(f"[多重画廊·风控网关] 未安装 playwright（需 pip install playwright 才能自动过风控）：{error}")
            return False
        try:
            self._playwright = sync_playwright().start()
        except Exception as error:
            print(f"[多重画廊·风控网关] playwright 驱动启动失败：{error}")
            return False
        launch_kwargs: dict[str, Any] = dict(
            headless=False,  # 无头模式过不了 CF 的交互式校验（已实测），用静默有头模式
            args=[
                "--window-position=-5000,-5000",  # 窗口移出屏幕，对用户不可见地常驻
                "--window-size=640,480",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-sync",
            ],
            viewport={"width": 640, "height": 480},
        )
        px = _resolve_danbooru_proxies()
        if px:
            server = px.get("https") or px.get("http")
            if server:
                launch_kwargs["proxy"] = {"server": server}
        context = None
        for channel in ("msedge", "chrome"):
            try:
                context = self._playwright.chromium.launch_persistent_context(
                    user_data_dir=tempfile.mkdtemp(prefix="anima_dbrowser_"),
                    channel=channel,
                    **launch_kwargs,
                )
                self._channel = channel
                break
            except Exception:
                context = None
        if context is None:
            print("[多重画廊·风控网关] 本机未找到可用的 Edge/Chrome，无法自动过风控")
            self.shutdown()
            return False
        self._context = context
        self._page = context.new_page()
        try:
            self._warm()
        except Exception as error:
            print(f"[多重画廊·风控网关] 预热 Danbooru 失败：{error}；网关不可用")
            self.shutdown()
            return False
        return True

    def shutdown(self) -> None:
        try:
            if self._context is not None:
                self._context.close()
        except Exception:
            pass
        try:
            if self._playwright is not None:
                self._playwright.stop()
        except Exception:
            pass
        self._context = None
        self._page = None
        self._playwright = None

    def _warm(self) -> None:
        page = self._page
        try:
            page.goto("https://danbooru.donmai.us/", wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_function(
                    "() => (document.title || '').includes('Danbooru') && document.readyState === 'complete'",
                    timeout=45000,
                )
            except Exception:
                print("[多重画廊·风控网关] 浏览器校验未完全就绪，继续尝试")
        finally:
            # ⚠️ 无论成功失败都必须记账。这是 2026-09-21 用户实报「P站 栏目选某些图片后
            #    节点一直卡住不继续」的两条根因之一：
            #    原来 `self._last_warm` 只在整个 _warm 走完后才赋值，而 `page.goto` **不在 try 内**
            #    ⇒ goto 超时（60s）抛异常时这一行被跳过 ⇒ `time.time() - self._last_warm`
            #    永远 > _WARM_INTERVAL_SECONDS ⇒ **下一次取图又重跑一遍 warm**（60s + 45s）。
            #    一张图 60s、十张图就是十分钟，用户看到的就是"卡住不动"。
            self._last_warm = time.time()

    def _run(self, script: str, argument: Any) -> Any:
        with self._lock:
            if time.time() - self._last_warm > self._WARM_INTERVAL_SECONDS:
                self._warm()
            # Playwright Python 的 Page.evaluate 不接受 timeout 参数；用页面默认超时
            # 保留 25s 兜底，否则异常会让浏览器网关每次都直接失败。
            self._page.set_default_timeout(25000)
            return self._page.evaluate(script, argument)

    def json(self, url: str, params: dict[str, Any]) -> Any:
        full = url + "?" + urlencode(params)
        # 同 bytes()：evaluate 层没有超时，必须 JS 自带（见那里的说明）
        result = self._run(
            "async (u) => { const c = new AbortController(); const timer = setTimeout(() => c.abort(), 20000); "
            "try { const r = await fetch(u, {headers: {'Accept':'application/json'}, signal: c.signal}); "
            "const t = await r.text(); return {s: r.status, t}; } "
            "finally { clearTimeout(timer); } }",
            full,
        )
        status = _safe_get(result, "s", 0)
        text = str(_safe_get(result, "t", "") or "")
        if status == 200:
            return json.loads(text)
        raise RuntimeError(f"D站 搜索失败（HTTP {status}）：{text[:240]}")

    def bytes(self, url: str) -> tuple[bytes, str]:
        # ⚠️ 超时必须由 JS 自己带（AbortController），因为 **Playwright 的
        #    `page.set_default_timeout()` 不作用于 `page.evaluate`** ——
        #    实测 `inspect.signature(Page.evaluate)` 只有 (self, expression, arg)，没有 timeout 参数，
        #    所以下面 `_run` 里那句 set_default_timeout(25000) 对本次求值是**无效兜底**。
        #    原先裸写 `await fetch(u)`：一旦 CDN 出现半开连接 / 极慢响应，JS 永不 settle
        #    ⇒ Python 侧永久阻塞在该 evaluate ⇒ 节点永不返回。
        #    这正是 2026-09-21 用户实报「一直卡在画廊节点不继续」的另一条根因。
        result = self._run(
            "async (u) => { const c = new AbortController(); const timer = setTimeout(() => c.abort(), 20000); "
            "try { const r = await fetch(u, {signal: c.signal}); "
            "const b = await r.arrayBuffer(); const d = new Uint8Array(b); "
            "const CH = 65536; const parts = []; "
            "for (let i = 0; i < d.length; i += CH) { parts.push(String.fromCharCode.apply(null, d.subarray(i, i + CH))); } "
            "return {s: r.status, ct: r.headers.get('content-type') || '', b64: btoa(parts.join(''))}; } "
            "finally { clearTimeout(timer); } }",
            url,
        )
        status = _safe_get(result, "s", 0)
        if status != 200:
            raise RuntimeError(f"图片获取失败（HTTP {status}）")
        data = base64.b64decode(_safe_get(result, "b64", "") or "")
        ctype = str(_safe_get(result, "ct", "") or "application/octet-stream")
        return data, ctype


def _get_browser() -> "_DanbooruBrowser | None":
    global _browser
    with _browser_lock:
        if _browser is None:
            candidate = _DanbooruBrowser()
            if not candidate.start():
                return None
            _browser = candidate
        return _browser


def _browser_json_or_none(url: str, params: dict[str, Any]) -> Any:
    browser = _get_browser()
    if browser is None:
        return None
    try:
        return browser.json(url, params)
    except Exception as error:
        print(f"[多重画廊] 浏览器网关搜索失败：{error}")
        return None


def _browser_bytes_or_none(url: str) -> tuple[bytes, str] | None:
    browser = _get_browser()
    if browser is None:
        return None
    try:
        return browser.bytes(url)
    except Exception as error:
        print(f"[多重画廊] 浏览器网关图片失败：{error}")
        return None


def _close_browser() -> None:
    global _browser
    with _browser_lock:
        if _browser is not None:
            try:
                _browser.shutdown()
            except Exception:
                pass
            _browser = None


atexit.register(_close_browser)


def _danbooru_json(url: str, params: dict[str, Any], timeout: int = 20) -> Any:
    """requests 优先；连接 6s 快速失败，失败后代理↔直连互切重试一次，仍失败切内置浏览器网关。

    历史教训：系统代理短暂失效时若直接 requests 超时 20s 再切网关，用户感知就是
    「画廊请求全部超时」（曾反复优化四五次未根治）。现在 connect 6s 即放弃换路，
    最坏路径 = 6s + 6s + 网关，总耗时显著下降且多路兜底。
    """
    global _browser_working
    if _browser_working:
        got = _browser_json_or_none(url, params)
        if got is not None:
            return got
        _browser_working = False  # 网关失能 → 回退 requests 重试
    _apply_danbooru_proxy()
    try:
        resp = _danbooru_session.get(url, params=params, timeout=(6, timeout))
    except (requests.Timeout, requests.ConnectionError) as error:
        # 第一路失败（被风控/节点不稳/系统代理空窗）→ 换一条路径重试：
        # 当前走代理 → 试直连；当前直连 → 试探测到的兜底代理
        if _danbooru_session.proxies:
            _danbooru_session.proxies.clear()
        else:
            _mark_direct_blocked()  # 直连失败一次 → 进程内记住「D站必须走代理」
            fb = _fallback_proxy()
            if fb:
                _danbooru_session.proxies.update(fb)
        try:
            resp = _danbooru_session.get(url, params=params, timeout=(6, timeout))
        except (requests.Timeout, requests.ConnectionError):
            # 双路 requests 都失败 → 浏览器网关兜底（真浏览器渲染引擎过 CF）
            got = _browser_json_or_none(url, params)
            if got is not None:
                _browser_working = True
                return got
            _apply_danbooru_proxy()  # 还原现场
            raise error
    if not _resp_is_cf(resp):
        resp.raise_for_status()
        return resp.json()
    got = _browser_json_or_none(url, params)
    if got is not None:
        _browser_working = True
        return got
    raise RuntimeError(CF_BLOCKED_MSG)


def _danbooru_get_image(url: str, timeout: int = 30, allow_browser: bool = True,
                        extra_headers: dict[str, str] | None = None) -> tuple[bytes, str]:
    """下载 Danbooru 图片/视频字节（requests 优先，连接 6s 快速失败 + 换路重试 + 浏览器网关兜底）。

    ``extra_headers``（2026-09-27 新增）：本次请求**专属**的请求头（如 P站 的 Referer）。
    走 requests 的 per-request headers —— 与 session 默认头合并、request 优先，因此
    **不再需要**改 `_danbooru_session.headers`，也就不需要那把把第三方图源取图串行化的全局锁。
    第三方图源一律配合 ``allow_browser=False`` 使用（网关对它们必然 403，见下）。

    ``allow_browser=False``：**禁用内置浏览器网关兜底**，第三方图源（P站/C站）必须这样调。
    理由：网关是一个停在 ``danbooru.donmai.us`` 的页面，从它发起
    ``fetch("https://i.pximg.net/...")`` 属**跨域**请求，浏览器会带上
    ``Referer: https://danbooru.donmai.us/``，而 P站 CDN 校验 Referer 必须含 pixiv.net
    （见本文件顶部的「取图铁律」）⇒ **必然 403**。也就是说网关对第三方图源既不可能成功，
    又要白付一次 warm（最坏 60s + 45s），纯属有害无益。
    """
    global _browser_working
    # allow_browser=False 时让每次调用都直接拿到 None（等价于"网关不可用"）：
    # 第三方图源因此只走 requests 的两条路，失败就如实报错，不再空等网关。
    browser = _browser_bytes_or_none if allow_browser else (lambda _u: None)
    if allow_browser and _browser_working:
        got = browser(url)
        if got is not None:
            return got
        _browser_working = False
    _apply_danbooru_proxy()
    # ⚠️ 并发安全（2026-09-27）：代理一律**整体原子赋值**，不再 clear()/update() 两步 ——
    # 两步之间并发的取图线程会读到空 proxies（= 直连），与 `_apply_danbooru_proxy` 同一约定。
    try:
        resp = _danbooru_session.get(url, headers=extra_headers, timeout=(6, timeout))
    except (requests.Timeout, requests.ConnectionError) as error:
        if _danbooru_session.proxies:
            _danbooru_session.proxies = {}
        else:
            _mark_direct_blocked()
            fb = _fallback_proxy()
            if fb:
                _danbooru_session.proxies = dict(fb)
        try:
            resp = _danbooru_session.get(url, headers=extra_headers, timeout=(6, timeout))
        except (requests.Timeout, requests.ConnectionError):
            got = browser(url)
            if got is not None:
                _browser_working = True
                return got
            _apply_danbooru_proxy()
            raise RuntimeError(f"D站 连不上（可能被风控/代理失效）：{error}。请在 Clash Verge 换节点或重启 ComfyUI 后重试") from error
    if not _resp_is_cf(resp):
        resp.raise_for_status()
        return resp.content, resp.headers.get("Content-Type", "application/octet-stream").split(";", 1)[0]
    got = browser(url)
    if got is not None:
        _browser_working = True
        return got
    raise RuntimeError(CF_BLOCKED_MSG)


# ---------- 模糊标签纠错（搜索无结果时把近似词替换成真实标签） ----------
_fuzzy_cache_lock = threading.Lock()
_fuzzy_name_cache: dict[str, list[str]] = {}
_tag_verify_cache_lock = threading.Lock()
_tag_verify_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_TAG_VERIFY_CACHE_TTL = 300.0
_TAG_CATEGORY_NAMES = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
}


def _edit_distance(a: str, b: str) -> int:
    """编辑距离（Levenshtein）：用于挑和输入词最接近的真实标签。"""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        cur = [i]
        for j, char_b in enumerate(b, 1):
            cur.append(min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + (char_a != char_b)))
        prev = cur
    return prev[-1]


def _fuzzy_tag_candidates(token: str, limit: int = 8) -> list[str]:
    """返回 token 最近的候选真实标签（前缀优先、子串兜底），按 编辑距离+热度 排序。

    若 token 本身就是有效标签，第一个候选即它自己（距离 0）。带进程内缓存避免重复请求。
    """
    key = token.lower()
    with _fuzzy_cache_lock:
        cached = _fuzzy_name_cache.get(key)
    if cached is not None:
        return cached
    candidates: list[str] = []
    for pattern in (f"{key}*", f"*{key}*"):
        try:
            data = _danbooru_json(
                "https://danbooru.donmai.us/tags.json",
                {"search[name_matches]": pattern, "search[order]": "count", "limit": 25},
                timeout=20,
            )
            if isinstance(data, list):
                candidates += _positive_count_tag_names(data)
        except Exception:
            break
        if candidates:
            break
    seen: set[str] = set()
    uniq: list[str] = []
    for name in candidates:
        if name not in seen and len(name) <= 64:
            seen.add(name)
            uniq.append(name)
    uniq.sort(key=lambda name: (_edit_distance(key, name),))
    result = uniq[:limit]
    with _fuzzy_cache_lock:
        _fuzzy_name_cache[key] = result
    return result


def _positive_count_tag_records(items: Any) -> list[dict[str, Any]]:
    """返回有帖子记录的标签及其数量，排除 post_count=0 的补全候选。"""
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        try:
            post_count = int(item.get("post_count") or 0)
        except (TypeError, ValueError):
            post_count = 0
        name = str(item["name"])
        if post_count > 0 and name not in seen:
            seen.add(name)
            try:
                category = _TAG_CATEGORY_NAMES.get(int(item.get("category") or 0), "general")
            except (TypeError, ValueError):
                category = "general"
            records.append({"tag": name, "postCount": post_count, "category": category})
    return records


def _positive_count_tag_names(items: Any) -> list[str]:
    """兼容旧调用：只返回有帖子记录的标签名称。"""
    return [record["tag"] for record in _positive_count_tag_records(items)]


def _tag_translation(tag: str) -> str:
    """返回标签对应的中文显示名；反向词典记录不作为中文译文。"""
    value = _load_translations().get(str(tag), "")
    return value if any("\u4e00" <= char <= "\u9fff" for char in value) else ""


def _suggestion_details(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            **record,
            "translation": _tag_translation(record["tag"]),
        }
        for record in records
    ]


# ---------- 本地标签索引快路径（2026-09-26）----------
# 为什么不直接用 _tag_translation：那个走的是 D 站词典的一种取法；本地索引的 zh 字段
# 来自 anima_alias_index（36,480 角色 + 3,702 作品 + 131,913 标签的汉字别名），
# 命中率更高且零网络。两者都拿不到时留空串，前端本来就会退化成只显示英文标签。
def _local_suggest(term: str, limit: int = 20) -> list[dict[str, Any]]:
    """用本地索引出候选；索引不可用/无命中时返回空列表（调用方落回远程路径）。

    只读已建好的索引（`get_index(build=False)`），**绝不在请求路径里建索引**：
    索引未就绪时立刻返回 []，让调用方落回既有远程路径（~300ms），用户不必等；
    建索引由预热线程负责（`__init__.py` 已挂 `anima_tag_index.warm_async()`）。

    返回结构对齐前端契约：tag / translation / postCount / category，
    另带 count_is_snapshot=True 标明帖数是本地快照值（与 D 站实时值有偏差）。
    """
    cleaned = str(term or "").strip()
    if not cleaned:
        return []
    try:
        from .anima_tag_index import get_index
    except ImportError:  # 独立运行（pytest / 探针）时的顶层导入
        try:
            from anima_tag_index import get_index  # type: ignore[no-redef]
        except ImportError:
            return []
    try:
        # ⚠️ 2026-09-27 修：必须 build=False（只读、不构建）。
        # 上一轮已把本函数挪进 run_in_executor（事件循环不再冻结：心跳 2696ms → 186ms），
        # 但**用户仍要等**——实测冷进程首个中文请求 2616ms，线上运行实例更慢
        # （首请求 13.87s；/anima/animadex/status 里 build_ms=20.9s，同一索引本地独立测仅 1143ms）。
        # 「不冻结事件循环」≠「用户不用等」：build=True 是在请求路径里同步建索引。
        # 实测语义（本机）：索引已存在 → 返回对象 0.003ms；未建好 → 返回 None，不触发构建。
        # 故此处取不到就立即返回 []（上方 except 已覆盖异常），调用方落回远程路径 ~300ms。
        index = get_index(build=False)
    except Exception:
        return []
    if index is None:
        return []
    try:
        rows = index.suggest(cleaned, limit=limit)
    except Exception:
        return []

    details: list[dict[str, Any]] = []
    for row in rows:
        tag = str(row.get("tag") or "").strip()
        if not tag:
            continue
        slug = _normalize_tag_slug(tag)
        translation = str(row.get("zh") or "").strip() or _tag_translation(slug) or ""
        detail: dict[str, Any] = {
            "tag": slug,
            "translation": translation,
            "postCount": int(row.get("count") or 0),
            "category": "general",
            "count_is_snapshot": True,
        }
        series = str(row.get("series") or "").strip()
        if series:
            detail["series"] = series
        details.append(detail)
    return details


def _normalize_tag_slug(value: Any) -> str:
    """Danbooru 内部标签格式：小写、空格转下划线。"""
    text = str(value or "").strip().lower()
    return re.sub(r"\s+", "_", text)


def _prompt_tag_text(tag: str) -> str:
    """Anima 提示词格式：Danbooru 的下划线转普通空格。"""
    return re.sub(r"\s+", " ", str(tag or "").replace("_", " ")).strip()


def _normalize_zh_text(value: Any) -> str:
    return re.sub(r"[\s\u3000]+", "", str(value or "").strip().lower())


class _ZhIndex(NamedTuple):
    """中文反查索引：一次遍历建好、整体发布，读者不会看到半成品。"""

    source: dict[str, str]  # 建索引时的词典对象；身份不一致即视为失效需重建
    exact: dict[str, Any]  # 归一化译文 -> tag | [tag, ...]（按词典原始顺序，保留重复项）
    entries: list[tuple[str, str, str]]  # (tag, 归一化译文, 原始译文)，仅英文 tag，供子串扫描
    cjk_entries: list[tuple[str, str, str]]  # 同上，但 tag 与译文都含中文的反向记录


_zh_index_lock = threading.Lock()
_zh_index: _ZhIndex | None = None


def _build_zh_index(translations: dict[str, str]) -> _ZhIndex:
    """遍历一次词典，预建「归一化译文 -> 标签」反向索引与子串扫描列表。

    词典在进程内是只读常量（_load_translations 只加载一次），故索引可常驻。
    归一化结果与原串逐字相同时直接复用原对象，避免为 40 万条目再复制一份字符串。
    """
    exact: dict[str, Any] = {}
    entries: list[tuple[str, str, str]] = []
    cjk_entries: list[tuple[str, str, str]] = []
    for raw_tag, raw_zh in translations.items():
        tag = _normalize_tag_slug(raw_tag)
        if not tag:
            continue
        zh = _normalize_zh_text(raw_zh)
        if not zh:
            continue
        tag_key = raw_tag if tag == raw_tag else tag
        zh_key = raw_zh if zh == raw_zh else zh
        if not any("\u4e00" <= char <= "\u9fff" for char in tag_key):
            # 子串联想只考虑英文标签；tag 含中文的是反向记录，一律不参与。
            entries.append((tag_key, zh, raw_zh))
        elif any("\u4e00" <= char <= "\u9fff" for char in zh):
            # 反向记录通常译文是英文，只有这类条目还可能命中「片段匹配」。
            cjk_entries.append((tag_key, zh, raw_zh))
        bucket = exact.get(zh_key)
        if bucket is None:
            exact[zh_key] = tag_key
        elif isinstance(bucket, list):
            bucket.append(tag_key)
        else:
            exact[zh_key] = [bucket, tag_key]
    return _ZhIndex(translations, exact, entries, cjk_entries)


def _zh_index_snapshot() -> _ZhIndex:
    """惰性取索引：首次用到才构建，之后复用；词典为空时索引同样为空，不抛异常。"""
    global _zh_index
    translations = _load_translations()
    index = _zh_index
    if index is not None and index.source is translations:
        return index
    with _zh_index_lock:
        index = _zh_index
        if index is not None and index.source is translations:
            return index
        built = _build_zh_index(translations)
        _zh_index = built
        return built


def _zh_exact_tags(index: _ZhIndex, query: str) -> tuple[str, ...] | list[str]:
    """取反向索引条目：单个标签存裸串（省一次 list 分配），多个标签存 list。"""
    bucket = index.exact.get(query)
    if bucket is None:
        return ()
    if isinstance(bucket, str):
        return (bucket,)
    return bucket


def _local_zh_tag_candidates(text: str, limit: int = 8) -> list[str]:
    """从本地 Danbooru 中文词典反查标签；优先整句，随后才做较长中文片段匹配。"""
    query = _normalize_zh_text(text)
    if not query:
        return []
    index = _zh_index_snapshot()
    exact: list[str] = []
    fragments: list[tuple[int, str]] = []
    seen: set[str] = set()
    for tag in _zh_exact_tags(index, query):
        if not tag or tag in seen:
            continue
        exact.append(tag)
        seen.add(tag)
    if exact:
        return exact[:limit]
    # 走到这里说明一个整句命中都没有，seen 必然为空、字典序也不影响下面的排序结果，
    # 故直接扫两份列表即可（含中文 tag 且译文也含中文的少数条目在 cjk_entries 里补全）。
    for bucket in (index.entries, index.cjk_entries):
        for tag, zh, _raw_zh in bucket:
            if len(zh) >= 2 and zh in query and any("\u4e00" <= ch <= "\u9fff" for ch in zh):
                fragments.append((len(zh), tag))
    fragments.sort(key=lambda item: (-item[0], item[1]))
    return [tag for _, tag in fragments[:limit]]


def _local_zh_exact_tag_candidates(text: str, limit: int = 8) -> list[str]:
    """只按完整中文译文反查，避免把长句误缩成其中某个中文片段。"""
    query = _normalize_zh_text(text)
    if not query:
        return []
    result: list[str] = []
    seen: set[str] = set()
    for tag in _zh_exact_tags(_zh_index_snapshot(), query):
        if not tag or tag in seen or any("\u4e00" <= char <= "\u9fff" for char in tag):
            continue
        seen.add(tag)
        result.append(tag)
        if len(result) >= limit:
            break
    return result


_zh_suggest_cache_lock = threading.Lock()
_zh_suggest_cache: OrderedDict[str, list[tuple[str, str]]] = OrderedDict()
_ZH_SUGGEST_CACHE_MAX = 64


def _local_zh_tag_search(text: str, limit: int = 24) -> list[tuple[str, str]]:
    """按中文片段查找本地词典，返回（英文标签，中文显示名）候选。"""
    query = _normalize_zh_text(text)
    if not query or not any("\u4e00" <= char <= "\u9fff" for char in query):
        return []
    with _zh_suggest_cache_lock:
        cached = _zh_suggest_cache.get(query)
        if cached is not None:
            return cached[:limit]

    matches: list[tuple[int, int, str, str]] = []
    seen: set[str] = set()
    # 索引里的 entries 已排除 tag 含中文的反向记录，与原循环里那层过滤等价。
    for tag, zh, raw_zh in _zh_index_snapshot().entries:
        if tag in seen or query not in zh or not any("\u4e00" <= char <= "\u9fff" for char in zh):
            continue
        seen.add(tag)
        zh_display = str(raw_zh or "").strip()
        # 以中文前缀优先；长度仅用于稳定排序，最终仍按 D 站帖数排序。
        matches.append((0 if zh.startswith(query) else 1, len(zh), tag, zh_display))
    matches.sort(key=lambda item: (item[0], item[1], item[2]))
    result = [(tag, zh_display) for _, _, tag, zh_display in matches[:limit]]
    with _zh_suggest_cache_lock:
        _zh_suggest_cache[query] = result
        _zh_suggest_cache.move_to_end(query)
        while len(_zh_suggest_cache) > _ZH_SUGGEST_CACHE_MAX:
            _zh_suggest_cache.popitem(last=False)
    return result


def _remote_exact_tag(slug: str, limit: int = 4, *, throttle: bool = True) -> list[dict[str, Any]]:
    """验证标签是否仍存在于 Danbooru，并取类别/帖数等元数据。"""
    key = _normalize_tag_slug(slug)
    if not key:
        return []
    now = time.monotonic()
    with _tag_verify_cache_lock:
        cached = _tag_verify_cache.get(key)
        if cached and cached[0] > now:
            return cached[1]
    result: list[dict[str, Any]] = []
    try:
        if throttle:
            _rate_limiter.wait()
        params = {"search[name_matches]": key, "search[order]": "count", "limit": limit}
        params.update(_account_params())
        data = _danbooru_json("https://danbooru.donmai.us/tags.json", params, timeout=20)
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                name = _normalize_tag_slug(item.get("name"))
                if name != key:
                    continue
                result.append({
                    "tag": name,
                    "postCount": int(item.get("post_count") or 0),
                    "category": _TAG_CATEGORY_NAMES.get(int(item.get("category") or 0), "general"),
                })
    except Exception:
        result = []
    with _tag_verify_cache_lock:
        _tag_verify_cache[key] = (now + _TAG_VERIFY_CACHE_TTL, result)
    return result


def _resolve_danbooru_prompt_items(items: list[Any]) -> list[dict[str, Any]]:
    """把中文/英文片段解析成可写入 Anima 的规范标签候选。"""
    resolved: list[dict[str, Any]] = []
    for index, raw in enumerate(items[:40]):
        item = raw if isinstance(raw, dict) else {"text": raw}
        text = str(item.get("text") or "").strip()[:300]
        translation = str(item.get("translation") or "").strip()[:500]
        if not text and not translation:
            continue
        candidates: list[dict[str, Any]] = []
        seen: set[str] = set()
        # 中文词典能直接命中时优先，适合「白发」「长发」这类短标签。
        local_tags = _local_zh_tag_candidates(text)
        # 翻译若本身带逗号，逐段转成多个标签；最终由前端用英文逗号组装。
        translated_parts = [p.strip() for p in re.split(r"[,，、;；]+", translation) if p.strip()]
        translated_tags = [_normalize_tag_slug(part) for part in translated_parts]
        for source, slugs in (("dictionary", local_tags), ("translation", translated_tags)):
            for slug in slugs[:6]:
                if not slug or slug in seen:
                    continue
                seen.add(slug)
                verified = _remote_exact_tag(slug, limit=4)
                meta = verified[0] if verified else {}
                post_count = int(meta.get("postCount") or 0)
                candidates.append({
                    "tag": slug,
                    "prompt": _prompt_tag_text(slug),
                    "category": meta.get("category", ""),
                    "postCount": post_count,
                    "verified": post_count > 0,
                    "matchType": "dictionary" if source == "dictionary" else "translated_exact",
                    "confidence": 0.98 if source == "dictionary" and post_count > 0 else (0.92 if post_count > 0 else 0.72),
                })
        candidates.sort(key=lambda c: (not c["verified"], -float(c["confidence"]), c["tag"]))
        resolved.append({
            "id": str(item.get("id", index)),
            "text": text,
            "translation": translation,
            "candidates": candidates[:8],
        })
    return resolved


MAX_FUZZY_TOKENS = 8


def _looks_like_video(image_url: str, content_type: str, data: bytes) -> bool:
    """判断下载内容是否是视频（D站 有动画 mp4 帖；PIL 打不开 → 需要 ffmpeg 抽帧）。
    判定：Content-Type video/*、URL 扩展名为 .mp4/.webm/.m4v/.mov/.mkv、或 moov/mp4 魔数 'ftyp'。"""
    ct = (content_type or "").lower()
    if ct.startswith("video/"):
        return True
    if image_url.split("?", 1)[0].lower().endswith((".mp4", ".webm", ".m4v", ".mov", ".mkv")):
        return True
    if data[:16].lower().endswith(b"ftyp"):
        return True
    return False


def _extract_video_frame(video_bytes: bytes) -> bytes:
    """用 ffmpeg 取视频首帧成 PNG 字节；ffmpeg 缺失/抽帧失败抛中文提示。"""
    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp.write(video_bytes)
            path = tmp.name
        try:
            proc = subprocess.run(
                [ffmpeg, "-y", "-i", path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=25,
            )
        except FileNotFoundError:
            raise ValueError("视频帖无法转图片：未检测到 ffmpeg（图生图不支持直接使用视频；可跳过该视频帖，或安装 ffmpeg 后重试）") from None
        except subprocess.TimeoutExpired:
            raise ValueError("视频帖抽帧超时，请跳过该视频帖") from None
        if proc.returncode != 0 or not proc.stdout:
            raise ValueError("视频帖抽帧失败（视频可能损坏或不受支持），请跳过该视频帖")
        return proc.stdout
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def _is_allowed_danbooru_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (host == "donmai.us" or host.endswith(DANBOORU_ALLOWED_SUFFIX))


# ---------- 多源画廊：D站 之外的新图源（C站/P站…）也要能取到字节 ----------
# 背景（PLAN §5.7）：节点下载路径原来只认 donmai.us，于是 C站/P站 的图被一律拒掉，
# 「images 输出端口能直接给出可用于反推的图」这条就断了。这里**只新增**一条分支：
# URL 属于协议层认识的图源时，借道 D站 既有的会话/代理探测/重试机制取字节，
# 并附加该源声明的必需请求头（P站 的 Referer 缺了 i.pximg.net 直接 403）。
# 2026-09-27：原先那把 `_gallery_header_lock` 全局锁已删除 —— 它把第三方图源取图**串行化**，
# 与「一次选多张、并发下载」直接冲突；额外头改走 per-request（见 `_gallery_get_image`）。


def _gallery_image_headers(url: str) -> dict[str, str] | None:
    """问协议层：这个 URL 属于哪个已装配图源、取图要带什么头。

    容错到极致：协议层不存在 / 导入失败 / 抛异常 / 返回怪东西 → `None`，
    调用方就维持加多源之前的行为（D站 URL 照旧、非 D站 URL 照旧拒绝）。
    返回 `{}` 表示「认识这个图源、只是不需要额外请求头」（C站）。
    """
    import importlib

    # 与 D站 闸门同一要求：只取 https（http 有被中间人换图的余地）
    if not str(url or "").strip().lower().startswith("https://"):
        return None
    try:
        if __package__:
            protocol = importlib.import_module(".anima_gallery_sources", __package__)
        else:
            protocol = importlib.import_module("anima_gallery_sources")
    except Exception:  # noqa: BLE001 —— 协议层缺失：回退原行为，绝不打断 D站 下载
        return None
    getter = getattr(protocol, "image_headers_for_url", None)
    if not callable(getter):
        return None
    try:
        headers = getter(url)
    except Exception:  # noqa: BLE001 —— 协议层内部出错也按「不认识」处理
        return None
    if headers is None:
        return None
    if not isinstance(headers, dict):
        return {}
    return {str(key): str(value) for key, value in headers.items() if key and value is not None}


def _gallery_get_image(image_url: str, headers: dict[str, str] | None = None) -> tuple[bytes, str]:
    """取第三方图源图片：代理探测/换路重试/超时**全部沿用 D站那一套**，只是不借浏览器网关。

    2026-09-27 改造（取图性能轮）：原先的做法是「临时改 `_danbooru_session.headers` +
    全局锁 `_gallery_header_lock` 把『改头 → 取图 → 还原』串起来」。那把锁的代价是
    **第三方图源的所有取图被串行化** —— 节点一次选 10 张 P站 图时，并发下载会被它排成一条队，
    改造形同虚设。现在额外头直接交给 `_danbooru_get_image(extra_headers=...)`
    （requests 的 per-request headers 与 session 默认头合并、request 优先），
    **锁与「改头窗口」一并删除**，第三方图源可以真正并发取图。
    """
    extra = {str(key): str(value) for key, value in (headers or {}).items() if key and value is not None}
    # 非 D站 CDN（Cloudflare 系）对非浏览器 UA 不友好；本分支统一用浏览器 UA
    # （D站 自己的 UA 不受影响：它走不带 extra_headers 的另一条路）。
    extra.setdefault(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    )
    # ⚠️ allow_browser=False —— 第三方图源**不得**借道 D站 浏览器网关：
    # 网关页面停在 danbooru.donmai.us，从它 fetch i.pximg.net 是跨域且 Referer 不对，
    # 必然 403；同时还要白付一次 warm（最坏 60s+45s）。详见 _danbooru_get_image 的说明。
    return _danbooru_get_image(image_url, allow_browser=False, extra_headers=extra)


# ---------- 原图落盘缓存（2026-09-27，取图性能轮）------------------------------------
# 为什么做：P站 经代理只有约 312KB/s，且每张还有约 1 秒固定开销（与分辨率无关，见
# HANDOFF-2026-09-25）。反复跑同一批图（调参时最常见的用法）等于把同一批字节重下一遍。
# 设计取舍：
#   * 缓存的是**下载到的原始字节**（不是解码后的张量）—— 解码是纯 CPU、PIL 很快，
#     而字节可以直接复用；视频帖仍每次抽帧（占比极小，不值得再缓存一份 PNG）。
#   * 键 = URL 的 sha256 前缀；扩展名由响应 Content-Type 决定，读盘时反推回 Content-Type。
#   * 单文件 > 64MB 不入缓存（yande.re 有 169MB 的原图，缓存它只会挤爆上限）；
#     总容量超 2GB 时按 mtime 从旧到新淘汰（命中会刷新 mtime ⇒ 天然 LRU）。
#   * 写盘走「临时文件 + os.replace」原子替换 —— 并发读到的永远是完整文件。
#   * `ANIMA_IMAGE_CACHE=0` 可整体关掉；`ANIMA_IMAGE_CACHE_DIR` 可换目录（测试用）。
IMAGE_CACHE_ENV = "ANIMA_IMAGE_CACHE"
IMAGE_CACHE_DIR_ENV = "ANIMA_IMAGE_CACHE_DIR"
IMAGE_CACHE_DIR_NAME = "image_cache"
IMAGE_CACHE_MAX_BYTES = 2 * 1024 ** 3
IMAGE_CACHE_MAX_FILE_BYTES = 64 * 1024 ** 2
IMAGE_CACHE_PRUNE_INTERVAL = 60.0
_IMAGE_EXT_BY_CONTENT_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}
_IMAGE_CONTENT_TYPE_BY_EXT = {ext: ctype for ctype, ext in _IMAGE_EXT_BY_CONTENT_TYPE.items()}
_image_cache_lock = threading.Lock()
_image_cache_last_prune = 0.0


def _image_cache_enabled() -> bool:
    """默认开启；`ANIMA_IMAGE_CACHE=0/false/off/no` 关闭（排查取图问题时用）。"""
    return str(os.environ.get(IMAGE_CACHE_ENV, "") or "").strip().lower() not in {"0", "false", "off", "no"}


def _image_cache_dir() -> Path:
    override = str(os.environ.get(IMAGE_CACHE_DIR_ENV, "") or "").strip()
    if override:
        return Path(override)
    return Path(__file__).with_name("data") / IMAGE_CACHE_DIR_NAME


def _image_cache_key(url: str) -> str:
    return hashlib.sha256(str(url or "").encode("utf-8")).hexdigest()[:40]


def _image_cache_read(url: str) -> tuple[bytes, str] | None:
    """命中则返回 `(bytes, content_type)`；任何 IO 异常都按「未命中」处理（绝不打断取图）。"""
    key = _image_cache_key(url)
    try:
        for path in _image_cache_dir().glob(f"{key}.*"):
            if path.suffix.lower() == ".part":
                continue
            try:
                data = path.read_bytes()
            except OSError:
                continue
            if not data:
                continue
            try:
                os.utime(path, None)  # LRU：命中即刷新 mtime
            except OSError:
                pass
            return data, _IMAGE_CONTENT_TYPE_BY_EXT.get(path.suffix.lower(), "application/octet-stream")
    except OSError:
        return None
    return None


def _image_cache_prune(now: float) -> None:
    """超上限时按 mtime 从旧到新淘汰；60s 节流，避免每次写入都全目录 stat。"""
    global _image_cache_last_prune
    with _image_cache_lock:
        if now - _image_cache_last_prune < IMAGE_CACHE_PRUNE_INTERVAL:
            return
        _image_cache_last_prune = now
    directory = _image_cache_dir()
    try:
        entries: list[tuple[float, int, Path]] = []
        for path in directory.iterdir():
            try:
                if not path.is_file():
                    continue
                stat = path.stat()
            except OSError:
                continue
            entries.append((stat.st_mtime, stat.st_size, path))
    except OSError:
        return
    total = sum(size for _mtime, size, _path in entries)
    if total <= IMAGE_CACHE_MAX_BYTES:
        return
    for _mtime, size, path in sorted(entries):
        try:
            path.unlink()
        except OSError:
            continue
        total -= size
        if total <= IMAGE_CACHE_MAX_BYTES:
            break


def _image_cache_write(url: str, data: bytes, content_type: str) -> None:
    if not data or len(data) > IMAGE_CACHE_MAX_FILE_BYTES:
        return
    ctype = str(content_type or "").split(";", 1)[0].strip().lower()
    ext = _IMAGE_EXT_BY_CONTENT_TYPE.get(ctype)
    if ext is None:
        return  # 类型不认识就不缓存：宁可不缓存，也不写一个扩展名骗人的文件
    key = _image_cache_key(url)
    directory = _image_cache_dir()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        tmp = directory / f"{key}{ext}.part"
        tmp.write_bytes(data)
        os.replace(tmp, directory / f"{key}{ext}")
    except OSError:
        return
    _image_cache_prune(time.monotonic())


def _cached_image_fetch(url: str, fetcher) -> tuple[bytes, str]:
    """落盘缓存包住任意的取图函数：命中即回，未命中则取回并写盘。"""
    if not _image_cache_enabled():
        return fetcher()
    hit = _image_cache_read(url)
    if hit is not None:
        return hit
    data, content_type = fetcher()
    _image_cache_write(url, data, content_type)
    return data, content_type


# ---------- 一次选多张时的下载并发度（2026-09-27）------------------------------------
# 为什么是 6：P站 经代理约 312KB/s，且每张有约 1 秒固定开销。并发太高容易被 CDN/风控盯上、
# 也吃满带宽；6 路足以把「固定开销」重叠掉，是观感改善最明显的一档。
# `ANIMA_SELECT_DOWNLOAD_WORKERS` 可覆盖（夹到 1~16；设 1 = 退回串行，便于对照排查）。
SELECT_DOWNLOAD_WORKERS = 6
SELECT_DOWNLOAD_WORKERS_ENV = "ANIMA_SELECT_DOWNLOAD_WORKERS"


def _select_download_workers() -> int:
    try:
        value = int(str(os.environ.get(SELECT_DOWNLOAD_WORKERS_ENV, "") or "").strip() or 0)
    except ValueError:
        value = 0
    if value <= 0:
        value = SELECT_DOWNLOAD_WORKERS
    return max(1, min(value, 16))


def _load_translations() -> dict[str, str]:
    global _translations
    with _translation_lock:
        if _translations is None:
            try:
                data = json.loads(_translation_path.read_text(encoding="utf-8"))
                _translations = {str(key): str(value) for key, value in data.items() if value}
            except (OSError, ValueError, TypeError):
                _translations = {}
        return _translations


def _clean_cache(now: float) -> None:
    expired = [key for key, (expires_at, _) in _search_cache.items() if expires_at <= now]
    for key in expired:
        _search_cache.pop(key, None)


def _cached_posts(request: SearchRequest) -> list[dict[str, Any]] | None:
    now = time.monotonic()
    with _cache_lock:
        _clean_cache(now)
        cached = _search_cache.get(request.cache_key)
        if cached is None:
            return None
        _search_cache.move_to_end(request.cache_key)
        return cached[1]


def _put_cached_posts(request: SearchRequest, posts: list[dict[str, Any]]) -> None:
    with _cache_lock:
        _clean_cache(time.monotonic())
        _search_cache[request.cache_key] = (time.monotonic() + CACHE_TTL_SECONDS, posts)
        _search_cache.move_to_end(request.cache_key)
        while len(_search_cache) > CACHE_MAX_ENTRIES:
            _search_cache.popitem(last=False)


def _fetch_posts(request: SearchRequest) -> tuple[list[dict[str, Any]], bool, bool]:
    """返回 (posts, cached, slow_window_used)。

    slow_window_used：慢排序无时间窗请求被 D站 拒绝（全库排序数据库超时 500/超时）后，
    自动降级附加时间窗重试了一次并成功——不再是默认限定（见 /anima/danbooru/posts）。
    """
    if not request.force:
        cached = _cached_posts(request)
        if cached is not None:
            return cached, True, False

    _rate_limiter.wait()

    order_value = _order_value(request.tags)
    params_kw = _account_params()  # 登录后：解除匿名 2 标签限制 + 更少限流

    def query(tags: str) -> list[dict[str, Any]]:
        params = {"tags": tags, "page": request.page, "limit": request.limit}
        params.update(params_kw)
        data = _danbooru_json(DANBOORU_POSTS_URL, params)
        if not isinstance(data, list):
            raise ValueError("Danbooru 返回的 posts 不是列表")
        return [post for post in data if isinstance(post, dict)]

    slow_window_used = False
    try:
        posts = query(request.tags)
    except (requests.HTTPError, requests.Timeout):
        # 慢排序（评分/收藏/随机）无时间窗 = 全库排序，D站 数据库会超时（500/超时）。
        # 默认不再附加时间窗（尊重用户想看全部时间范围）；仅当请求确实失败时才降级重试一
        # 次并上报 warning。用户显式设置 age: 的时间窗始终优先（_has_age_tag 拦截）。
        if order_value in SLOW_ORDERS and not _has_age_tag(request.tags):
            posts = query((request.tags + " age:" + DEFAULT_SLOW_ORDER_WINDOW).strip())
            slow_window_used = True
        else:
            raise
    _put_cached_posts(request, posts)
    return posts, False, slow_window_used


@PromptServer.instance.routes.get("/anima/danbooru/posts")
async def anima_danbooru_posts(request: web.Request) -> web.Response:
    tags, search_rewrites = normalize_search_tags_with_rewrites(request.query.get("tags", ""))
    if not tags:
        return web.json_response({"posts": [], "query": "", "cached": False, "searchRewrites": search_rewrites})

    warnings: list[str] = []
    registered = _registered()
    tag_limit = await _account_tag_limit_async()
    if count_restricted_search_tags(tags) > tag_limit:
        hint = (
            f"（已登录 D站，当前等级上限 {tag_limit} 个计数标签；Gold 及以上为 6 个。请减少标签或排序）"
            if registered else
            "（普通标签与排序各占 1 个；Gold 账号上限为 6，Platinum 及以上不限）"
        )
        return web.json_response({"error": f"D站 搜索最多 {tag_limit} 个计数标签{hint}", "registered": registered, "tag_limit": tag_limit, "searchRewrites": search_rewrites}, status=400)

    search_request = SearchRequest(
        tags=tags,
        page=_bounded_int(request.query.get("page"), 1, 1, 100000),
        limit=_bounded_int(request.query.get("limit"), 24, MIN_PAGE_SIZE, MAX_PAGE_SIZE),
        force=request.query.get("force", "").lower() in {"1", "true", "yes"},
    )
    # _fetch_posts 可能在慢排序超时后追加时间窗重试；warning 仍需引用原始排序值。
    # 这里必须在 try 外先解析，避免降级成功后因 NameError 把整个请求变成 500。
    order_value = _order_value(search_request.tags)
    try:
        posts, cached, slow_window_used = await asyncio.get_running_loop().run_in_executor(None, _fetch_posts, search_request)
    except requests.Timeout:
        return web.json_response({"error": "Danbooru 请求超时：已自动尝试直连/代理/浏览器网关多条路径仍失败，请确认 Clash/代理已开启并换节点后重试", "registered": registered, "tag_limit": tag_limit, "searchRewrites": search_rewrites}, status=504)
    except requests.ConnectionError as error:
        return web.json_response({"error": f"连不上 Danbooru：{getattr(error, '__class__', error.__class__).__name__}。请确认 Clash/代理已开启；实在不行重启一次 ComfyUI 让代理配置生效", "registered": registered, "tag_limit": tag_limit, "searchRewrites": search_rewrites}, status=502)
    except requests.RequestException as error:
        return web.json_response({"error": _friendly_danbooru_error(error), "registered": registered, "tag_limit": tag_limit, "searchRewrites": search_rewrites}, status=502)
    except RuntimeError as error:
        return web.json_response({"error": str(error), "registered": registered, "tag_limit": tag_limit, "searchRewrites": search_rewrites}, status=502)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error), "registered": registered, "tag_limit": tag_limit, "searchRewrites": search_rewrites}, status=502)
    if slow_window_used:
        warnings.append(
            f"「{order_value}」全库排序触发 D站 超时，本次已自动降级限定近 1 周（加标签缩小范围或换用其它排序即可看全部时间）"
        )
    return web.json_response({"posts": posts, "query": search_request.tags, "cached": cached, "warnings": warnings, "registered": registered, "tag_limit": tag_limit, "searchRewrites": search_rewrites})


@PromptServer.instance.routes.get("/anima/danbooru/image")
async def anima_danbooru_image(request: web.Request) -> web.Response:
    image_url = request.query.get("url", "").strip()
    if not _is_allowed_danbooru_url(image_url):
        return web.json_response({"error": "只允许代理 donmai.us 的 HTTPS 图片"}, status=400)
    def _get():
        return _danbooru_get_image(image_url)
    try:
        async with _get_image_proxy_semaphore():
            data, content_type = await asyncio.get_running_loop().run_in_executor(None, _get)
    except requests.Timeout:
        return web.json_response({"error": "图片代理超时（已自动重试并尝试浏览器网关）：请确认 Clash/代理已开启"}, status=504)
    except requests.RequestException as error:
        return web.json_response({"error": f"图片代理失败：{error}"}, status=502)
    except RuntimeError as error:
        return web.json_response({"error": str(error)}, status=502)
    return web.Response(
        body=data,
        content_type=content_type.split(";", 1)[0],
        headers={"Cache-Control": "public, max-age=86400"},
    )


@PromptServer.instance.routes.post("/anima/danbooru/account")
async def anima_danbooru_account_save(request: web.Request) -> web.Response:
    """保存 Danbooru 登录凭证（用户名 + API Key）到本机插件目录；清空 = 退出登录。"""
    global _account_cache, _account_level_cache, _account_level_at
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return web.json_response({"error": "body 必须是 JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "body 必须是对象"}, status=400)
    username = str(body.get("username") or "").strip()
    api_key = str(body.get("api_key") or "").strip()
    try:
        _account_path.parent.mkdir(parents=True, exist_ok=True)
        if username and api_key:
            _account_path.write_text(json.dumps({"username": username, "api_key": api_key}, ensure_ascii=False), encoding="utf-8")
        else:
            _account_path.unlink(missing_ok=True)
    except OSError as error:
        return web.json_response({"error": f"写入凭证失败：{error}"}, status=500)
    with _account_lock:
        _account_cache = {"username": username, "api_key": api_key} if (username and api_key) else {}
        # 切换账号/修复失效凭证后，不能继续沿用旧账号（或失效凭证）的等级缓存。
        _account_level_cache = None
        _account_level_at = 0.0
    # 返回刷新后的实际上限，避免前端保存 Gold 账号后仍沿用页面初始的匿名上限 2。
    return web.json_response({
        "logged_in": bool(username and api_key),
        "username": username,
        "tag_limit": await _account_tag_limit_async(),
        "tip": "凭证仅存于本机插件目录，不会上传。遇 429 限流请适当降低使用频率。",
    })


@PromptServer.instance.routes.get("/anima/danbooru/account")
async def anima_danbooru_account_status(request: web.Request) -> web.Response:
    """返回登录状态（不泄露 api_key）+ 当前计数标签上限。"""
    acc = _load_account()
    return web.json_response({
        "logged_in": bool(acc.get("username") and acc.get("api_key")),
        "username": acc.get("username", ""),
        "tag_limit": await _account_tag_limit_async(),
    })


# ---------- D站 收藏（2026-09-27）：读状态 + 写（收藏 / 取消收藏） ----------

@PromptServer.instance.routes.get("/anima/danbooru/favorites")
async def anima_danbooru_favorites_state(request: web.Request) -> web.Response:
    """当前账号的收藏状态：`{logged_in, username, user_id, total, favorite_limit, ids, query_tag}`。

    前端拿它做三件事：① 卡片按 `ids` 显示已收藏态；② 「我的收藏」入口的跳转标签
    （`query_tag = ordfav:<username>`，直接复用既有搜索链路）；③ 收藏上限提示。

    ⚠️ **未登录也返回 200**（`logged_in=false`），让界面能给"去登录"的引导 ——
    把未登录当 4xx 会让前端只能显示一个红错误，体验差且难区分"没登录"与"请求失败"。
    """
    auth = _danbooru_auth()
    if auth is None:
        return web.json_response({
            "logged_in": False, "username": "", "user_id": 0, "level": "",
            "favorite_count": 0, "favorite_limit": 0, "total": 0, "ids": [], "partial": False,
            "query_tag": "",
            "tip": "未登录 D站：在节点设置里填用户名与 API key 后即可收藏",
        })
    username = auth[0]
    try:
        state_limit = max(1, min(int(request.query.get("limit", FAVORITES_STATE_LIMIT)), 1000))
    except (TypeError, ValueError):
        state_limit = FAVORITES_STATE_LIMIT

    def _collect() -> dict[str, Any]:
        # 三个请求都同步，合并到一次 executor 调用里跑，别在事件循环上排队
        return {
            "identity": _danbooru_identity(),
            "ids": _favorite_ids_for_user(username, state_limit),
            "total": _favorite_total(username),
        }

    snapshot = await asyncio.get_running_loop().run_in_executor(None, _collect)
    identity = snapshot.get("identity") or {}
    ids = list(snapshot.get("ids") or [])
    total = int(snapshot.get("total") or -1)
    known_total = total if total >= 0 else len(ids)
    favorite_count = int(identity.get("favorite_count") or 0) or known_total
    return web.json_response({
        "logged_in": True,
        "username": username,
        "user_id": int(identity.get("id") or 0),
        "level": identity.get("level") or "",
        "favorite_count": favorite_count,
        "favorite_limit": int(identity.get("favorite_limit") or 0),
        "total": known_total,
        "ids": ids,
        # ids 是"最近 N 张"的窗口：拉满了就说明可能还有更早的收藏没覆盖到
        "partial": len(ids) >= state_limit,
        "query_tag": f"ordfav:{username}",
    })


@PromptServer.instance.routes.post("/anima/danbooru/favorite")
async def anima_danbooru_favorite_toggle(request: web.Request) -> web.Response:
    """收藏 / 取消收藏一张图，**写回 D站 账号**。

    body: `{"post_id": 123, "action": "add" | "remove"}`（action 缺省 = add）。
    成功返回 `{ok, favorite, post_id}`；失败返回 `{ok:false, error}` + 4xx/5xx。
    """
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return web.json_response({"ok": False, "error": "body 必须是 JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body 必须是对象"}, status=400)
    try:
        post_id = int(body.get("post_id"))
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "post_id 必须是整数"}, status=400)
    action = str(body.get("action") or "add").strip().lower()
    if action not in {"add", "remove"}:
        return web.json_response({"ok": False, "error": "action 只能是 add 或 remove"}, status=400)
    auth = _danbooru_auth()
    if auth is None:
        return web.json_response(
            {"ok": False, "error": "未登录 D站 账号：先在节点设置里填用户名与 API key"}, status=401)

    def _write() -> dict[str, Any]:
        if action == "add":
            resp = _danbooru_request("POST", _DANBOORU_FAVORITES_WRITE,
                                     data={"post_id": str(post_id)}, auth=auth, timeout=20)
            if resp.status_code in (200, 201):
                return {"ok": True, "favorite": True}
            return {"ok": False, "error": _favorite_write_error(resp.status_code, resp.text)}
        # 取消收藏：**DELETE 用的是收藏记录 id（不是 post_id）** ⇒ 先查记录
        user_id = int((_danbooru_identity() or {}).get("id") or 0)
        if not user_id:
            return {"ok": False, "error": "拿不到 D站 账号 id（确认已登录且网络可用）后重试"}
        resp = _danbooru_request(
            "GET", _DANBOORU_FAVORITES_WRITE,
            params={"search[user_id]": str(user_id), "search[post_id]": str(post_id), "limit": "1"},
            auth=auth, timeout=20)
        if resp.status_code != 200:
            return {"ok": False, "error": _favorite_write_error(resp.status_code, resp.text)}
        try:
            rows = resp.json()
        except ValueError:
            rows = []
        record = None
        if isinstance(rows, list):
            for row in rows:
                if isinstance(row, dict) and row.get("id") is not None:
                    record = row
                    break
        if record is None:
            # 本来就没收藏 ⇒ 幂等成功（用户连点两次不该报错）
            return {"ok": True, "favorite": False}
        resp = _danbooru_request("DELETE", f"/favorites/{int(record['id'])}.json", auth=auth, timeout=20)
        if resp.status_code in (200, 204):
            return {"ok": True, "favorite": False}
        return {"ok": False, "error": _favorite_write_error(resp.status_code, resp.text)}

    try:
        result = await asyncio.get_running_loop().run_in_executor(None, _write)
    except RuntimeError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=502)
    if not result.get("ok"):
        return web.json_response({"ok": False, "error": result.get("error") or "收藏失败"}, status=400)
    # 写成功：清掉身份缓存，让下一次 /favorites 拿到刷新后的计数
    _clear_danbooru_identity()
    return web.json_response({"ok": True, "favorite": bool(result.get("favorite")), "post_id": post_id})


@PromptServer.instance.routes.get("/anima/danbooru/diag")
async def anima_danbooru_diag(request: web.Request) -> web.Response:
    """诊断：暴露运行进程的代理解析/环境/requests 状态 + 代理/直连实测（供排查"全部超时"）。"""
    import urllib.request as _urllib

    def _env_snapshot() -> dict[str, str | None]:
        return {
            k: os.environ.get(k)
            for k in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
                      "no_proxy", "DANBOORU_PROXY_CONFIG", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE")
        }

    try:
        sys_proxies = _urllib.getproxies()
    except Exception as error:  # noqa: BLE001
        sys_proxies = f"ERR {type(error).__name__}: {error}"

    def _probe(proxies: dict[str, str] | None, label: str) -> dict[str, object]:
        _danbooru_session.proxies.clear()
        if proxies:
            _danbooru_session.proxies.update(proxies)
        t0 = time.time()
        try:
            resp = _danbooru_session.get(
                "https://danbooru.donmai.us/posts.json",
                params={"tags": "hatsune_miku", "limit": 1}, timeout=8,
            )
            return {"label": label, "ok": True, "status": resp.status_code, "ms": round((time.time() - t0) * 1000)}
        except Exception as error:  # noqa: BLE001
            return {"label": label, "ok": False, "err": f"{type(error).__name__}: {str(error)[:160]}",
                    "ms": round((time.time() - t0) * 1000)}

    result: dict[str, object] = {
        "env": _env_snapshot(),
        "sys_proxies": sys_proxies,
        "resolved_proxies": _resolve_danbooru_proxies(),
        "proxy_candidates": _proxy_candidates(),
        "direct_blocked": _direct_blocked,
        "session_proxies": dict(_danbooru_session.proxies or {}),
        "requests_version": requests.__version__,
        "requests_file": requests.__file__,
        "browser_working": _browser_working,
        "browser_alive": _browser is not None,
        "probes": [
            _probe(None, "direct"),
            _probe({"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"}, "proxy-7890"),
        ],
    }
    _apply_danbooru_proxy()  # 还原现场
    return web.json_response(result)


@PromptServer.instance.routes.get("/anima/danbooru/suggest")
async def anima_danbooru_suggest(request: web.Request) -> web.Response:
    raw_query = request.query.get("q", "")
    raw_tokens = str(raw_query or "").strip().split()
    raw_term = raw_tokens[-1] if raw_tokens else ""
    query = normalize_search_tags(raw_query).split()
    if not query:
        return web.json_response({"suggestions": [], "suggestionDetails": [], "didYouMean": [], "rewrites": []})
    term = query[-1]

    # ★ 2026-09-26 本地索引快路径：命中即返回，不再远程往返。
    # 实测依据（.scratch/gallery-refactor-20260926/probe_local_index_perf.py）：
    #   英文前缀 0.00~0.04ms / 中文前缀 0.01~0.10ms / 中文子串(47万对) 15~19ms；
    #   而远程路径英文实测 326~418ms（代理选路白付已另行修掉 512ms）。
    # 返回结构与原路径**逐字段一致**（suggestions / suggestionDetails / didYouMean / rewrites），
    # 前端无需改动。帖数来自本地快照，故 details 里带 count_is_snapshot=True 供界面如实标注。
    #
    # ⚠️ 2026-09-27 修（冷审查实测）：本快路径原先在事件循环里**同步**执行，冷启动实测
    # **2696ms**（其中建索引 2391ms；另有 _load_translations 首次读 17.11MB 的
    # danbooru_tags_zh.json）。预热线程未跑完时，首个联想请求会把整个 PromptServer
    # 事件循环冻住 ~2.7s（进度推送与其它请求全卡）。同文件旧路径早已用 run_in_executor
    # 保护（见下方 `fetch` 的 await），新快路径绕过了它 —— 现在补回同样的保护。
    local_term = raw_term.lstrip("-~")
    try:
        local = await asyncio.get_running_loop().run_in_executor(
            None, lambda: _local_suggest(local_term, limit=20)
        )
    except Exception:
        local = []
    if local:
        names = [row["tag"] for row in local]
        return web.json_response({
            "suggestions": names,
            "suggestionDetails": local,
            "didYouMean": names[:3],
            "rewrites": names[:3],
            "source": "local_index",
        })

    def fetch():
        # 中文片段先查本地双语词典，再逐个向 D 站取帖数，效果与 D 站搜索框的
        # 「中文 → 英文」候选一致；有缓存时不会重复请求同一标签。
        chinese_term = raw_term.lstrip("-~")
        if any("\u4e00" <= char <= "\u9fff" for char in chinese_term):
            local_details: list[dict[str, Any]] = []
            local_candidates = _local_zh_tag_search(chinese_term, limit=20)

            def verify(candidate: tuple[str, str]) -> dict[str, Any] | None:
                tag, translation = candidate
                verified = _remote_exact_tag(tag, limit=1, throttle=False)
                if not verified:
                    return None
                meta = verified[0]
                post_count = int(meta.get("postCount") or 0)
                if post_count <= 0:
                    return None
                return {
                    "tag": tag,
                    "translation": translation,
                    "postCount": post_count,
                    "category": meta.get("category", "general"),
                }

            # 中文联想需要显示帖数；并发验证候选，避免逐个串行请求让输入框等待十几秒。
            with ThreadPoolExecutor(max_workers=min(20, len(local_candidates) or 1)) as executor:
                for detail in executor.map(verify, local_candidates):
                    if detail:
                        local_details.append(detail)
            local_details.sort(key=lambda item: (-int(item["postCount"]), str(item["tag"])))
            if local_details:
                return [str(item["tag"]) for item in local_details], local_details

        _rate_limiter.wait()
        params = {"search[name_matches]": f"{term}*", "search[order]": "count", "limit": 20}
        params.update(_account_params())
        tags = _danbooru_json("https://danbooru.donmai.us/tags.json", params, timeout=20)
        records = _positive_count_tag_records(tags)
        return [str(record["tag"]) for record in records], _suggestion_details(records)

    try:
        names, details = await asyncio.get_running_loop().run_in_executor(None, fetch)
    except Exception:
        names, details = [], []
    return web.json_response({
        "suggestions": names,
        "suggestionDetails": details,
        "didYouMean": names[:3],
        "rewrites": names[:3],
    })


@PromptServer.instance.routes.post("/anima/danbooru/translate")
async def anima_danbooru_translate(request: web.Request) -> web.Response:
    try:
        tags = (await request.json()).get("tags", [])
    except (ValueError, AttributeError):
        return web.json_response({"error": "tags 必须是数组"}, status=400)
    if not isinstance(tags, list):
        return web.json_response({"error": "tags 必须是数组"}, status=400)
    translations = _load_translations()
    result = {str(tag): translations.get(str(tag)) for tag in tags[:160] if str(tag) in translations}
    return web.json_response({"translations": result})


@PromptServer.instance.routes.post("/anima/danbooru/resolve")
async def anima_danbooru_resolve(request: web.Request) -> web.Response:
    """中文/英文片段 → Danbooru 规范标签候选；前端确认后再写入提示词。"""
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return web.json_response({"error": "请求体必须是 JSON"}, status=400)
    items = body.get("items", []) if isinstance(body, dict) else []
    if not isinstance(items, list):
        return web.json_response({"error": "items 必须是数组"}, status=400)
    try:
        resolved = await asyncio.get_running_loop().run_in_executor(
            None, _resolve_danbooru_prompt_items, items[:40]
        )
    except Exception as error:
        return web.json_response({"error": f"标签校准失败：{error}"}, status=502)
    return web.json_response({"items": resolved})


@PromptServer.instance.routes.get("/anima/danbooru/fuzzy")
async def anima_danbooru_fuzzy(request: web.Request) -> web.Response:
    """搜索无结果时的模糊纠错：把不属于真实标签的词替换为最近的真实标签（元标签原样保留）。"""
    raw_tags = request.query.get("tags", "").strip()
    seen: set[str] = set()
    tokens: list[str] = []
    for token in str(raw_tags or "").split():
        t = token.lower()
        if t and t not in seen:
            seen.add(t)
            tokens.append(t)
    tokens = tokens[:MAX_FUZZY_TOKENS]

    replacements: dict[str, str] = {}
    corrected: list[str] = []
    for token in tokens:
        marker = ""
        body = token
        if body.startswith(("-", "~")):
            marker, body = body[0], body[1:]
        prefix, sep, _ = body.partition(":")
        if sep and prefix in FREE_METATAGS:
            corrected.append(token)  # 元标签（rating:/age:/score:/order:…）原样保留
            continue
        if not body:
            corrected.append(token)
            continue
        candidates = _fuzzy_tag_candidates(body)
        if candidates and candidates[0] == body:
            corrected.append(token)          # 已是有效标签 → 不动
        elif candidates:
            found = marker + candidates[0]
            if found != token:
                replacements[token] = found
            corrected.append(found)
        else:
            corrected.append(token)          # 无近似 → 保留原文
    return web.json_response({
        "tags": raw_tags,
        "corrected": " ".join(corrected),
        "changed": bool(replacements),
        "replacements": replacements,
    })


# ---------- P站 作品 → D站 帖子 反查（2026-09-21） ----------
# 由来：P站 的 tag 是画师自由打的日文/多语言词，模型理解不了，所以 P站 页面原本不输出 prompt。
# 但 D站 收录了大量 P站 作品、且帖子自带 `pixiv_id` —— 于是可以「拿 P站 作品 id 反查 D站 帖子」，
# 直接把 D站 的规范标签当 prompt 用：不必翻译、不必 WD14 反推（反推还会误判污染提示词）。
# 实测（2026-09-21）：`pixiv_id:>0` 可用；多值 `pixiv_id:a,b,c` 一次能查多个；
# 一个 pixiv_id 常对应多个 D站 帖子（原图/差分/重复上传），且 tag 数远多于 P站 自己的标签。
PIXIV_MATCH_MAX_IDS = 60      # 单次最多反查多少个作品（P站 一页 30 张 → 通常 1 批就够）
PIXIV_MATCH_BATCH_IDS = 30    # 每个上游请求塞多少个 pixiv_id（多值查询，实测可行）
PIXIV_MATCH_MAX_POSTS = 200   # 每个 pixiv_id 最多取回多少候选帖子，用于消歧


def _pixiv_match_payload(post: dict[str, Any], pixiv_id: str) -> dict[str, Any]:
    """把命中的 D站 帖子裁成前端要的形状：字段名与 D站 posts 一致，
    于是前端可以直接把它喂进既有的 rawPromptGroups（按 tag_string_<类别> 分组），不必另写一套。"""
    return {
        "pixiv_id": pixiv_id,
        "post_id": post.get("id"),
        "tag_count": post.get("tag_count"),
        "rating": post.get("rating"),
        "score": post.get("score"),
        "fav_count": post.get("fav_count"),
        "file_ext": post.get("file_ext"),
        "source_url": f"https://danbooru.donmai.us/posts/{post.get('id')}",
        "tag_string": post.get("tag_string"),
        "tag_string_general": post.get("tag_string_general"),
        "tag_string_character": post.get("tag_string_character"),
        "tag_string_copyright": post.get("tag_string_copyright"),
        "tag_string_artist": post.get("tag_string_artist"),
        "tag_string_meta": post.get("tag_string_meta"),
    }


# pixiv 的原始图片 URL 形如 `.../79828064_p2.jpg` —— 用它把 D站 帖子对回 pixiv 的页号
_PIXIV_PAGE_RE = re.compile(r"_(p\d+)(?=[._]|$)", re.IGNORECASE)


def _pixiv_source_page(post: dict[str, Any]) -> int | None:
    """从 D站 帖子的 `source` 里解析 pixiv 页号（`.../79828064_p0.jpg` → 0）；拿不到返回 None。

    2026-09-21 实测：多页作品被逐页上传到 D站 时，source 会保留 `_pN` 且与 pixiv 页序一致
    （#3842827→p0、#3842830→p1、#3842833→p2）。有它才能把「页 → 帖子」精确对上。
    """
    for candidate in str(post.get("source") or "").split():
        match = _PIXIV_PAGE_RE.search(candidate)
        if not match:
            continue
        try:
            return int(match.group(1)[1:])
        except ValueError:
            continue
    return None


def _match_pixiv_ids(pixiv_ids: list[str]) -> dict[str, dict[str, Any]]:
    """反查 pixiv 作品 id → D站 帖子，**按页归并**。

    回包：`{pixiv_id: {"pages": {"0": 帖子, "1": 帖子, ...}, "root": 帖子}}`

    ⚠️ 为什么必须按页（2026-09-21 修的真实 bug）：一个 pixiv 多页作品在 D站 常有多个帖子
    （逐页上传并连成父子链），而 `pixiv_id` 本身**不区分页码**。早先的实现是「多命中取 tag 最多」——
    那等于随便挑一页、再把它套到该作品的所有页上：首页于是可能带出后几页的 NSFW 标签（提示词污染）。
    现在：能解析出 `_pN` 就按页各就各位；同一页有多条（真差分）才按 tag 最多消歧；
    解析不出页号的帖子只作为 `root` 兜底（该页在 D站 没有独立帖子时使用）。
    """
    matches: dict[str, dict[str, Any]] = {}
    wanted = set(pixiv_ids)
    for start in range(0, len(pixiv_ids), PIXIV_MATCH_BATCH_IDS):
        chunk = pixiv_ids[start:start + PIXIV_MATCH_BATCH_IDS]
        data = _danbooru_json(DANBOORU_POSTS_URL, {
            "tags": "pixiv_id:" + ",".join(chunk),
            "limit": PIXIV_MATCH_MAX_POSTS,
        })
        if not isinstance(data, list):
            continue
        for post in data:
            if not isinstance(post, dict):
                continue
            pixiv_id = _safe_get(post, "pixiv_id", None)
            pixiv_id = str(pixiv_id).strip() if pixiv_id is not None else ""
            if not pixiv_id or pixiv_id not in wanted:
                continue
            entry = matches.setdefault(pixiv_id, {"pages": {}, "root": None})
            payload = _pixiv_match_payload(post, pixiv_id)
            page = _pixiv_source_page(post)
            if page is not None:
                payload["page"] = page
                current = entry["pages"].get(str(page))
                # 同一页出现多条 = 真差分（同一页的不同版本）——这时"取 tag 最多"才是对的
                if current is None or int(payload.get("tag_count") or 0) > int(current.get("tag_count") or 0):
                    entry["pages"][str(page)] = payload
            # 根帖（parent_id 为空）= 该页在 D站 没有独立帖子时的兜底
            if not _safe_get(post, "parent_id", None):
                root = entry["root"]
                if root is None or int(payload.get("tag_count") or 0) > int(root.get("tag_count") or 0):
                    entry["root"] = payload
    return matches


@PromptServer.instance.routes.get("/anima/danbooru/pixiv_match")
async def anima_danbooru_pixiv_match(request: web.Request) -> web.Response:
    """P站 作品 id → D站 帖子（供 P站 画廊把作品标签升级成 Danbooru 规范标签）。

    参数：`ids=149884381,148075989`（逗号分隔，最多 PIXIV_MATCH_MAX_IDS 个）。
    回包：`{"matches": {"<pixiv_id>": {"pages": {"0": 帖子, ...}, "root": 帖子}}, "requested": N}` ——
    按页归并（见 `_match_pixiv_ids` 的说明）；未收录的作品不出现在 matches 里。
    """
    ids: list[str] = []
    for token in str(request.query.get("ids", "")).replace("，", ",").split(","):
        text = token.strip()
        if text.isdigit() and text not in ids:
            ids.append(text)
    if not ids:
        return web.json_response({"matches": {}, "requested": 0})
    ids = ids[:PIXIV_MATCH_MAX_IDS]
    try:
        matches = await asyncio.get_running_loop().run_in_executor(None, _match_pixiv_ids, ids)
    except requests.Timeout:
        return web.json_response({"error": "D站 反查超时：请确认 Clash/代理已开启后重试"}, status=504)
    except requests.RequestException as error:
        return web.json_response({"error": _friendly_danbooru_error(error)}, status=502)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": f"D站 反查回包异常：{error}"}, status=502)
    return web.json_response({"matches": matches, "requested": len(ids)})


class DanbooruGallery:
    """将画廊的用户选择转换为 ComfyUI 可连接的图像和提示词列表，并输出结构化元数据。"""

    NAME = "DanbooruGallery"
    CATEGORY = "TK/Danbooru"
    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("images", "prompts", "metadata_json")
    OUTPUT_IS_LIST = (True, True, False)
    FUNCTION = "get_selected_data"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "hidden": {
                "selection_data": ("STRING", {"default": "{}", "multiline": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, selection_data="{}"):
        return selection_data

    @staticmethod
    def _empty_image() -> torch.Tensor:
        return torch.zeros(1, 1, 1, 3)

    @staticmethod
    def _download_image(image_url: str) -> torch.Tensor:
        if _is_allowed_danbooru_url(image_url):
            # requests 优先，被风控时自动切内置浏览器网关（见 _danbooru_get_image）
            # 2026-09-27：外层套落盘缓存 —— 同一 URL 重复出图不再重下（见 _cached_image_fetch）
            image_bytes, content_type = _cached_image_fetch(image_url, lambda: _danbooru_get_image(image_url))
        else:
            # 多源画廊（C站/P站…）：协议层认这个 URL 才走新分支；不认识则维持原拒绝语义
            # ⚠️ 校验必须在缓存之前：未知主机一律拒绝，绝不因为"缓存里有"就放行
            gallery_headers = _gallery_image_headers(image_url)
            if gallery_headers is None:
                raise ValueError("不允许的图片 URL：既不是 D站（donmai.us），也不属于任何已装配图源")
            # ⚠️ 必须附加该源的 images_headers()：P站 i.pximg.net 缺 Referer 直接 403
            image_bytes, content_type = _cached_image_fetch(
                image_url, lambda: _gallery_get_image(image_url, gallery_headers)
            )
        # D站 动画帖是 mp4：PIL 打不开 → 用 ffmpeg 抽首帧当图，避免"下载失败/黑图"
        if _looks_like_video(image_url, content_type, image_bytes):
            image_bytes = _extract_video_frame(image_bytes)
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image_array = np.asarray(image).astype(np.float32) / 255.0
        return torch.from_numpy(image_array)[None,]

    @staticmethod
    def _prompt_groups(value: Any) -> dict[str, list[str]] | None:
        """保留前端 Prompt 生成器的类别分组，供下游节点/脚本筛选。"""
        if not isinstance(value, dict):
            return None
        groups: dict[str, list[str]] = {}
        for category in ("artist", "copyright", "character", "general", "meta"):
            tags = value.get(category)
            if not isinstance(tags, list):
                continue
            clean = [str(tag).strip() for tag in tags if str(tag).strip()]
            groups[category] = clean
        return groups or None

    @staticmethod
    def _prompt_settings(value: Any) -> dict[str, Any] | None:
        """规范化 Prompt 输出设置；旧工作流没有此字段时保持 None。"""
        if not isinstance(value, dict):
            return None
        categories = value.get("categories")
        if not isinstance(categories, list):
            categories = []
        categories = [
            str(category)
            for category in categories
            if str(category) in {"artist", "copyright", "character", "general", "meta"}
        ]
        return {
            "categories": list(dict.fromkeys(categories)),
            "replaceUnderscores": value.get("replaceUnderscores") is not False,
            "escapeBrackets": value.get("escapeBrackets") is True,
        }

    @staticmethod
    def _selection_meta(sel: dict, ok: bool, error: str | None = None) -> dict:
        """选择项 → 结构化元数据（下游筛选/复现用；字段缺失置 None）。"""
        def num(v):
            try:
                f = float(v)
                return int(f) if f == int(f) else f
            except (TypeError, ValueError):
                return None
        def s(v):
            return str(v or "") or None
        return {
            "image_url": s(sel.get("image_url")),
            "prompt": s(sel.get("prompt")),
            "prompt_output_enabled": bool(sel.get("prompt_output_enabled", True)),
            "prompt_groups": DanbooruGallery._prompt_groups(sel.get("prompt_groups")),
            "danbooru_id": num(sel.get("post_id")),
            "tags": sel.get("tags") if isinstance(sel.get("tags"), list) else None,
            "rating": s(sel.get("rating")),
            "score": num(sel.get("score")),
            "fav_count": num(sel.get("favcount") if sel.get("favcount") is not None else sel.get("fav_count")),
            "width": num(sel.get("width")),
            "height": num(sel.get("height")),
            "file_ext": s(sel.get("file_ext")),
            "video": bool(sel.get("video")),
            "source_url": s(sel.get("source_url")),
            "ok": ok,
            "error": error or None,
        }

    def get_selected_data(self, selection_data="{}"):
        try:
            payload = json.loads(selection_data or "{}")
            prompt_selection_list = payload.get("selections", []) if isinstance(payload, dict) else []
            image_selection_list = payload.get("image_selections", prompt_selection_list) if isinstance(payload, dict) else []
            prompt_settings = self._prompt_settings(payload.get("prompt_settings")) if isinstance(payload, dict) else None
            prompt_output_enabled = payload.get("prompt_output_enabled", True) is not False if isinstance(payload, dict) else True
            # AnimaDex 角色词（2026-09-26）：浮窗选中的角色，**写进 prompts 输出**而不是搜索框。
            # 这样配合 prompt_settings 关掉原有的「角色/作品」类别，它就成为唯一的角色来源
            # —— 即 YG 要的「换人物」：关掉原角色词、浮窗选新角色，输出直接变成新角色。
            role_prompt = str(payload.get("role_prompt") or "").strip() if isinstance(payload, dict) else ""
        except (TypeError, ValueError, json.JSONDecodeError):
            prompt_selection_list = []
            image_selection_list = []
            prompt_settings = None
            prompt_output_enabled = True
            role_prompt = ""
        if not isinstance(prompt_selection_list, list):
            prompt_selection_list = []
        if not isinstance(image_selection_list, list) or not image_selection_list:
            return ([self._empty_image()], [""], "{}")

        # ── 并发下载（2026-09-27，取图性能轮）─────────────────────────────────────
        # 原先是**串行** `for` 循环逐张下载：选 10 张时，每张约 1 秒的固定开销
        # （代理握手 + DNS/TLS + 首字节，与分辨率无关，见 HANDOFF-2026-09-25 实测）
        # 被完整叠加；改成并发后这些固定开销互相重叠。
        # 保序靠 `pool.map`（按输入顺序返回）+ 下面按 jobs 顺序组装：images / prompts /
        # metadata / failures 的相对顺序与串行版**逐项一致**（下游按 index 对齐的前提）。
        jobs: list[tuple[int, dict, str, str]] = []
        for index, image_selection in enumerate(image_selection_list):
            if not isinstance(image_selection, dict):
                continue
            prompt_selection = prompt_selection_list[index] if index < len(prompt_selection_list) else image_selection
            if not isinstance(prompt_selection, dict):
                prompt_selection = image_selection
            prompt = str(prompt_selection.get("prompt", "")) if prompt_output_enabled else ""
            # AnimaDex 角色词**前置**拼接：它代表「人物」，按 Anima/Danbooru 习惯人物词在最前。
            # 受同一个 prompt_output_enabled 约束（总开关关掉就什么都不输出，语义一致）；
            # 想只保留它，用 prompt_settings 把原图的各类别关掉即可。
            if prompt_output_enabled and role_prompt:
                prompt = f"{role_prompt}, {prompt}" if prompt else role_prompt
            jobs.append((index, prompt_selection, prompt, str(image_selection.get("image_url", ""))))

        def _fetch(job: tuple[int, dict, str, str]):
            _index, _prompt_selection, _prompt, image_url = job
            try:
                return job, self._download_image(image_url), None
            except Exception as error:  # noqa: BLE001 —— 单张失败不影响其余（与原串行版语义一致）
                return job, None, error

        workers = min(_select_download_workers(), len(jobs)) if len(jobs) > 1 else 1
        if workers > 1:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                fetched = list(pool.map(_fetch, jobs))
        else:
            fetched = [_fetch(job) for job in jobs]

        images: list[torch.Tensor] = []
        prompts: list[str] = []
        metadata: list[dict] = []
        failures: list[str] = []
        for (_index, prompt_selection, prompt, image_url), image, error in fetched:
            output_selection = {**prompt_selection, "image_url": image_url, "prompt": prompt, "prompt_output_enabled": prompt_output_enabled}
            if error is None:
                images.append(image)
                prompts.append(prompt)
                metadata.append(self._selection_meta(output_selection, ok=True))
            else:
                failures.append(f"[{prompt[:24] or image_url[:48]}] {error}")
                metadata.append(self._selection_meta(output_selection, ok=False, error=str(error)))
        if not images:
            # 不再静默输出黑图：全部下载失败 → 抛错，ComfyUI 队列停止，杜绝"图生图出黑屏"
            detail = "\n".join(f"  - {f}" for f in failures[:6])
            if len(failures) > 6:
                detail += f"\n  … 另有 {len(failures) - 6} 张失败"
            raise RuntimeError(
                "D站 图片下载全部失败，无法执行（已停止，避免输出黑图）。"
                "可检查网络/代理并重启 ComfyUI，或取消勾选失效图片后重跑。\n" + detail
            )
        if len(failures) > 0:
            print(f"[多重画廊] 跳过 {len(failures)} 张下载失败的图（原图可能已失效），使用剩余 {len(images)} 张继续")
        metadata_payload: dict[str, Any] = {"items": metadata, "failures": failures}
        metadata_payload["prompt_output_enabled"] = prompt_output_enabled
        if prompt_settings is not None:
            metadata_payload["prompt_settings"] = prompt_settings
        return (images, prompts, json.dumps(metadata_payload, ensure_ascii=False))


NODE_CLASS_MAPPINGS = {DanbooruGallery.NAME: DanbooruGallery}
NODE_DISPLAY_NAME_MAPPINGS = {DanbooruGallery.NAME: "TK 多重画廊"}
