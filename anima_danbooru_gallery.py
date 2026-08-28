"""D站画廊节点：受控 Danbooru 搜索、图片代理与工作流输出。"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import asyncio
import atexit
import base64
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
from concurrent.futures import ThreadPoolExecutor
from typing import Any
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


def _apply_danbooru_proxy() -> None:
    """每次请求前按当前环境实时解析代理（不再重启时一次性固化）。

    策略：在所有候选代理里挑「活着」的第一个（TCP 活性探测，0.4s×并行），
    全部探测失败才直连。这样即使 Clash 系统代理开关被关/指向死端口/重启瞬间，
    也能自动落到可用的本地代理；探测结果 30s 缓存避免每次请求重复探测。
    """
    global _direct_blocked
    if _direct_blocked:
        # 直连曾失败：只用探测到的活代理，绝不直连
        fb = _fallback_proxy()
        if fb:
            _danbooru_session.proxies.clear()
            _danbooru_session.proxies.update(fb)
            return
    candidates = _proxy_candidates()
    if candidates:
        servers = [c["https"] for c in candidates]
        try:
            with ThreadPoolExecutor(max_workers=min(len(servers), 8)) as pool:
                alive = list(pool.map(_probe_proxy_alive, servers))
        except Exception:
            alive = [False] * len(servers)
        for proxies, ok in zip(candidates, alive):
            if ok:
                _danbooru_session.proxies.clear()
                _danbooru_session.proxies.update(proxies)
                return
    _danbooru_session.proxies.clear()  # 全部不可达 → 直连（可能被墙，重试链会兜底）


# ---------- Danbooru 账号（登录后解除匿名 2 标签限制、更少限流） ----------
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


def normalize_search_tags(raw_tags: str) -> str:
    """规范化标签，保留搜索语义但避免重复和无意义请求。"""
    seen: set[str] = set()
    normalized: list[str] = []
    for raw_token in str(raw_tags or "").strip().split():
        token = raw_token.strip().lower().replace(" ", "_")
        if not token or token in seen:
            continue
        seen.add(token)
        normalized.append(token)
        if len(normalized) >= MAX_SEARCH_TAGS:
            break
    return " ".join(normalized)


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
            print(f"[D站画廊·风控网关] 未安装 playwright（需 pip install playwright 才能自动过风控）：{error}")
            return False
        try:
            self._playwright = sync_playwright().start()
        except Exception as error:
            print(f"[D站画廊·风控网关] playwright 驱动启动失败：{error}")
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
            print("[D站画廊·风控网关] 本机未找到可用的 Edge/Chrome，无法自动过风控")
            self.shutdown()
            return False
        self._context = context
        self._page = context.new_page()
        try:
            self._warm()
        except Exception as error:
            print(f"[D站画廊·风控网关] 预热 Danbooru 失败：{error}；网关不可用")
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
        page.goto("https://danbooru.donmai.us/", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_function(
                "() => (document.title || '').includes('Danbooru') && document.readyState === 'complete'",
                timeout=45000,
            )
        except Exception:
            print("[D站画廊·风控网关] 浏览器校验未完全就绪，继续尝试")
        self._last_warm = time.time()

    def _run(self, script: str, argument: Any) -> Any:
        with self._lock:
            if time.time() - self._last_warm > self._WARM_INTERVAL_SECONDS:
                self._warm()
            # evaluate 显式 25s 超时：网关页面内 fetch 挂起时不至于让整条请求链无限等待
            return self._page.evaluate(script, argument, timeout=25000)

    def json(self, url: str, params: dict[str, Any]) -> Any:
        full = url + "?" + urlencode(params)
        result = self._run(
            "async (u) => { const r = await fetch(u, {headers: {'Accept':'application/json'}}); "
            "const t = await r.text(); return {s: r.status, t}; }",
            full,
        )
        status = _safe_get(result, "s", 0)
        text = str(_safe_get(result, "t", "") or "")
        if status == 200:
            return json.loads(text)
        raise RuntimeError(f"D站 搜索失败（HTTP {status}）：{text[:240]}")

    def bytes(self, url: str) -> tuple[bytes, str]:
        result = self._run(
            "async (u) => { const r = await fetch(u); "
            "const b = await r.arrayBuffer(); const d = new Uint8Array(b); "
            "const CH = 65536; const parts = []; "
            "for (let i = 0; i < d.length; i += CH) { parts.push(String.fromCharCode.apply(null, d.subarray(i, i + CH))); } "
            "return {s: r.status, ct: r.headers.get('content-type') || '', b64: btoa(parts.join(''))}; }",
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
        print(f"[D站画廊] 浏览器网关搜索失败：{error}")
        return None


def _browser_bytes_or_none(url: str) -> tuple[bytes, str] | None:
    browser = _get_browser()
    if browser is None:
        return None
    try:
        return browser.bytes(url)
    except Exception as error:
        print(f"[D站画廊] 浏览器网关图片失败：{error}")
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


def _danbooru_get_image(url: str, timeout: int = 30) -> tuple[bytes, str]:
    """下载 Danbooru 图片/视频字节（requests 优先，连接 6s 快速失败 + 换路重试 + 浏览器网关兜底）。"""
    global _browser_working
    if _browser_working:
        got = _browser_bytes_or_none(url)
        if got is not None:
            return got
        _browser_working = False
    _apply_danbooru_proxy()
    try:
        resp = _danbooru_session.get(url, timeout=(6, timeout))
    except (requests.Timeout, requests.ConnectionError) as error:
        if _danbooru_session.proxies:
            _danbooru_session.proxies.clear()
        else:
            _mark_direct_blocked()
            fb = _fallback_proxy()
            if fb:
                _danbooru_session.proxies.update(fb)
        try:
            resp = _danbooru_session.get(url, timeout=(6, timeout))
        except (requests.Timeout, requests.ConnectionError):
            got = _browser_bytes_or_none(url)
            if got is not None:
                _browser_working = True
                return got
            _apply_danbooru_proxy()
            raise RuntimeError(f"D站 连不上（可能被风控/代理失效）：{error}。请在 Clash Verge 换节点或重启 ComfyUI 后重试") from error
    if not _resp_is_cf(resp):
        resp.raise_for_status()
        return resp.content, resp.headers.get("Content-Type", "application/octet-stream").split(";", 1)[0]
    got = _browser_bytes_or_none(url)
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


def _positive_count_tag_names(items: Any) -> list[str]:
    """只返回 D 站存在帖子记录的标签名称，排除 post_count=0 的补全候选。"""
    names: list[str] = []
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
            names.append(name)
    return names


def _normalize_tag_slug(value: Any) -> str:
    """Danbooru 内部标签格式：小写、空格转下划线。"""
    text = str(value or "").strip().lower()
    return re.sub(r"\s+", "_", text)


def _prompt_tag_text(tag: str) -> str:
    """Anima 提示词格式：Danbooru 的下划线转普通空格。"""
    return re.sub(r"\s+", " ", str(tag or "").replace("_", " ")).strip()


def _normalize_zh_text(value: Any) -> str:
    return re.sub(r"[\s\u3000]+", "", str(value or "").strip().lower())


def _local_zh_tag_candidates(text: str, limit: int = 8) -> list[str]:
    """从本地 Danbooru 中文词典反查标签；优先整句，随后才做较长中文片段匹配。"""
    query = _normalize_zh_text(text)
    if not query:
        return []
    translations = _load_translations()
    exact: list[str] = []
    fragments: list[tuple[int, str]] = []
    seen: set[str] = set()
    for raw_tag, raw_zh in translations.items():
        tag = _normalize_tag_slug(raw_tag)
        zh = _normalize_zh_text(raw_zh)
        if not tag or not zh or tag in seen:
            continue
        if zh == query:
            exact.append(tag)
            seen.add(tag)
        elif len(zh) >= 2 and zh in query and any("\u4e00" <= ch <= "\u9fff" for ch in zh):
            fragments.append((len(zh), tag))
    if exact:
        return exact[:limit]
    fragments.sort(key=lambda item: (-item[0], item[1]))
    return [tag for _, tag in fragments[:limit]]


def _remote_exact_tag(slug: str, limit: int = 4) -> list[dict[str, Any]]:
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
    tags = normalize_search_tags(request.query.get("tags", ""))
    if not tags:
        return web.json_response({"posts": [], "query": "", "cached": False})

    warnings: list[str] = []
    registered = _registered()
    tag_limit = _account_tag_limit()
    if count_restricted_search_tags(tags) > tag_limit:
        hint = (
            f"（已登录 D站，当前等级上限 {tag_limit} 个计数标签；Gold 及以上为 6 个。请减少标签或排序）"
            if registered else
            "（普通标签与排序各占 1 个；登录 Danbooru 账号可解除限制 或 减少标签/改用默认最新排序）"
        )
        return web.json_response({"error": f"D站 搜索最多 {tag_limit} 个计数标签{hint}", "registered": registered, "tag_limit": tag_limit}, status=400)

    search_request = SearchRequest(
        tags=tags,
        page=_bounded_int(request.query.get("page"), 1, 1, 100000),
        limit=_bounded_int(request.query.get("limit"), 24, MIN_PAGE_SIZE, MAX_PAGE_SIZE),
        force=request.query.get("force", "").lower() in {"1", "true", "yes"},
    )
    try:
        posts, cached, slow_window_used = await asyncio.get_running_loop().run_in_executor(None, _fetch_posts, search_request)
    except requests.Timeout:
        return web.json_response({"error": "Danbooru 请求超时：已自动尝试直连/代理/浏览器网关多条路径仍失败，请确认 Clash/代理已开启并换节点后重试", "registered": registered, "tag_limit": tag_limit}, status=504)
    except requests.ConnectionError as error:
        return web.json_response({"error": f"连不上 Danbooru：{getattr(error, '__class__', error.__class__).__name__}。请确认 Clash/代理已开启；实在不行重启一次 ComfyUI 让代理配置生效", "registered": registered, "tag_limit": tag_limit}, status=502)
    except requests.RequestException as error:
        return web.json_response({"error": _friendly_danbooru_error(error), "registered": registered, "tag_limit": tag_limit}, status=502)
    except RuntimeError as error:
        return web.json_response({"error": str(error), "registered": registered, "tag_limit": tag_limit}, status=502)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error), "registered": registered, "tag_limit": tag_limit}, status=502)
    if slow_window_used:
        warnings.append(
            f"「{order_value}」全库排序触发 D站 超时，本次已自动降级限定近 1 周（加标签缩小范围或换用其它排序即可看全部时间）"
        )
    return web.json_response({"posts": posts, "query": search_request.tags, "cached": cached, "warnings": warnings, "registered": registered, "tag_limit": tag_limit})


@PromptServer.instance.routes.get("/anima/danbooru/image")
async def anima_danbooru_image(request: web.Request) -> web.Response:
    image_url = request.query.get("url", "").strip()
    if not _is_allowed_danbooru_url(image_url):
        return web.json_response({"error": "只允许代理 donmai.us 的 HTTPS 图片"}, status=400)
    def _get():
        return _danbooru_get_image(image_url)
    try:
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
        headers={"Cache-Control": "public, max-age=3600"},
    )


@PromptServer.instance.routes.post("/anima/danbooru/account")
async def anima_danbooru_account_save(request: web.Request) -> web.Response:
    """保存 Danbooru 登录凭证（用户名 + API Key）到本机插件目录；清空 = 退出登录。"""
    global _account_cache
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
    return web.json_response({"logged_in": bool(username and api_key), "username": username, "tip": "凭证仅存于本机插件目录，不会上传。遇 429 限流请适当降低使用频率。"})


@PromptServer.instance.routes.get("/anima/danbooru/account")
async def anima_danbooru_account_status(request: web.Request) -> web.Response:
    """返回登录状态（不泄露 api_key）+ 当前计数标签上限。"""
    acc = _load_account()
    return web.json_response({
        "logged_in": bool(acc.get("username") and acc.get("api_key")),
        "username": acc.get("username", ""),
        "tag_limit": _account_tag_limit(),
    })


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
    query = normalize_search_tags(request.query.get("q", "")).split(" ")[-1:]
    if not query:
        return web.json_response({"suggestions": [], "didYouMean": [], "rewrites": []})
    term = query[0]
    def fetch():
        _rate_limiter.wait()
        params = {"search[name_matches]": f"{term}*", "search[order]": "count", "limit": 8}
        params.update(_account_params())
        return _danbooru_json("https://danbooru.donmai.us/tags.json", params, timeout=20)
    try:
        tags = await asyncio.get_running_loop().run_in_executor(None, fetch)
        names = _positive_count_tag_names(tags)
    except Exception:
        names = []
    return web.json_response({"suggestions": names, "didYouMean": names[:3], "rewrites": names[:3]})


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
        if not _is_allowed_danbooru_url(image_url):
            raise ValueError("不允许的 Danbooru 图片 URL")
        # requests 优先，被风控时自动切内置浏览器网关（见 _danbooru_get_image）
        image_bytes, content_type = _danbooru_get_image(image_url)
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
            selection_list = payload.get("selections", []) if isinstance(payload, dict) else []
            prompt_settings = self._prompt_settings(payload.get("prompt_settings")) if isinstance(payload, dict) else None
            prompt_output_enabled = payload.get("prompt_output_enabled", True) is not False if isinstance(payload, dict) else True
        except (TypeError, ValueError, json.JSONDecodeError):
            selection_list = []
            prompt_settings = None
            prompt_output_enabled = True
        if not isinstance(selection_list, list) or not selection_list:
            return ([self._empty_image()], [""], "{}")

        images: list[torch.Tensor] = []
        prompts: list[str] = []
        metadata: list[dict] = []
        failures: list[str] = []
        for selection in selection_list:
            if not isinstance(selection, dict):
                continue
            prompt = str(selection.get("prompt", "")) if prompt_output_enabled else ""
            image_url = str(selection.get("image_url", ""))
            try:
                images.append(self._download_image(image_url))
                prompts.append(prompt)
                output_selection = {**selection, "prompt": prompt, "prompt_output_enabled": prompt_output_enabled}
                metadata.append(self._selection_meta(output_selection, ok=True))
            except Exception as error:
                failures.append(f"[{prompt[:24] or image_url[:48]}] {error}")
                output_selection = {**selection, "prompt": prompt, "prompt_output_enabled": prompt_output_enabled}
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
            print(f"[D站画廊] 跳过 {len(failures)} 张下载失败的图（原图可能已失效），使用剩余 {len(images)} 张继续")
        metadata_payload: dict[str, Any] = {"items": metadata, "failures": failures}
        metadata_payload["prompt_output_enabled"] = prompt_output_enabled
        if prompt_settings is not None:
            metadata_payload["prompt_settings"] = prompt_settings
        return (images, prompts, json.dumps(metadata_payload, ensure_ascii=False))


NODE_CLASS_MAPPINGS = {DanbooruGallery.NAME: DanbooruGallery}
NODE_DISPLAY_NAME_MAPPINGS = {DanbooruGallery.NAME: "TK D站画廊"}
