"""P站（Pixiv）图源：官方 App API + OAuth 2.0 (PKCE) + 图片防盗链代理。

为什么要 OAuth（而不是 Public API）
-----------------------------------
Pixiv 已于 2022 年废弃 Public API（`api.pixiv.net`），且**官方 App API 没有匿名搜索**——
任何 `search/illust` 都必须带 `Authorization: Bearer <access_token>`。
所以本模块必须先完成一次 PKCE 授权（用户在浏览器里点一次），拿 refresh_token 长期续期。

并行契约（docs/PLAN-2026-09-15-P站C站画廊接入.md §5.2/§5.3/§5.4，三方共同遵守，**不自行改契约**）
--------------------------------------------------------------------------------------
- 统一 item schema（§5.2）：`source / id / preview_url / full_url / width / height / tags /
  prompt / negative_prompt / rating / score / source_url / meta`，缺字段一律 `null` / `[]`，
  **不省略 key**（前端按 key 判断能力）。
- 路由（§5.3）：`/anima/gallery/pixiv/{search,image,auth/url,auth/code,auth/status}`；
  分页统一参数名 `cursor` + 回包字段 `next_cursor`（内部由 `next_url` 的 offset 解析而来）。
- 图片一律走后端代理（§5.4）；P站必须带 `Referer: https://www.pixiv.net/`，否则 `i.pximg.net` 403。
- 协议层 `GallerySource.search(query, cursor, filters) -> (items, next_cursor)` +
  `images_headers()` + `capabilities`：本模块的 `PixivSource` 严格按此形状暴露，
  用 duck typing，**不 import 协议层模块**（那边并行开发中，互相不依赖运行时）。

凭据安全
--------
token 只落盘 `data/pixiv_token.json`（已在 `.gitignore` 内），**不进日志、不进回包、不回显明文**；
错误信息里只给 HTTP 状态码，绝不带上 refresh_token / access_token。
"""

from __future__ import annotations

import asyncio
import base64
import functools
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import socket
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
import urllib.request

from aiohttp import web
import requests
from requests.adapters import HTTPAdapter
from server import PromptServer


# ---------- 常量：Pixiv 官方 App API ----------
PIXIV_SOURCE_ID = "pixiv"
PIXIV_LABEL = "P站"

PIXIV_APP_API = "https://app-api.pixiv.net"
PIXIV_LOGIN_URL = f"{PIXIV_APP_API}/web/v1/login"
PIXIV_TOKEN_URL = "https://oauth.secure.pixiv.net/auth/token"
PIXIV_REDIRECT_URI = f"{PIXIV_APP_API}/web/v1/users/auth/pixiv/callback"
PIXIV_SEARCH_ILLUST_URL = f"{PIXIV_APP_API}/v1/search/illust"
PIXIV_USER_ILLUSTS_URL = f"{PIXIV_APP_API}/v1/user/illusts"
PIXIV_ILLUST_DETAIL_URL = f"{PIXIV_APP_API}/v1/illust/detail"
PIXIV_ILLUST_RANKING_URL = f"{PIXIV_APP_API}/v1/illust/ranking"

# 公开的 pixiv-android 客户端凭据（与 pixivpy 一致：授权 URL 用 client=pixiv-android，
# token 交换用这组 client_id/secret）。这不是"私密密钥"——它是 App 内置的公开值。
PIXIV_CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT"
PIXIV_CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj"
PIXIV_CLIENT_TAG = "pixiv-android"

PIXIV_APP_VERSION = "5.0.234"
PIXIV_USER_AGENT = f"PixivAndroidApp/{PIXIV_APP_VERSION} (Android 11; Pixel 5)"
# ⚠️ 取图铁律：i.pximg.net 校验 Referer，缺了直接 403。
PIXIV_REFERER = "https://www.pixiv.net/"

# pixiv 的 translated_name 语言随 Accept-Language 变（pixivpy 的 set_accept_language 同款机制）。
# 默认给中文用户看中文翻译；需要英文时设 env PIXIV_ACCEPT_LANGUAGE=en-us。
PIXIV_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7"

# 搜索枚举（P站只认这几档，透传前先校验，避免把用户输入原样拼进 URL）
PIXIV_SEARCH_TARGETS = ("partial_match_for_tags", "exact_match_for_tags", "title_and_caption")
# date_desc/date_asc 全账号可用；popular_desc 需要 Pixiv Premium，非会员会拿到错误 → 由调用方看到可读报错。
PIXIV_SEARCH_SORTS = ("date_desc", "date_asc", "popular_desc")
PIXIV_FILTERS = ("for_android", "for_ios")

# 图片/搜索分页上限：与 D 站 MAX_PAGE_SIZE 同值（前端一屏的量级）
MAX_PAGE_SIZE = 48
MIN_PAGE_SIZE = 1
# P站 search/illust 每页固定 30 条（API 无 limit 参数），limit 只能客户端截断。
PIXIV_PAGE_SIZE = 30

# 进程内搜索结果短缓存（与 D 站 CACHE_TTL_SECONDS=30 同约定）
CACHE_TTL_SECONDS = 30
CACHE_MAX_ENTRIES = 64
# 图片代理并发上限：与 D 站 IMAGE_PROXY_CONCURRENCY=3 同约定（一屏卡片同时进视口也不打爆上游）
IMAGE_PROXY_CONCURRENCY = 3

# PKCE verifier 的服务端暂存有效期：用户从点「去授权」到把 code 贴回来，10 分钟足够
PENDING_VERIFIER_TTL = 600.0
# access_token 提前 60s 视为过期（避免"刚好在用的时候失效"）
TOKEN_EXPIRY_SKEW = 60.0


# ---------- 连通性：与 D 站同语义的代理解析（PROXY_CONFIG=auto → env → 系统代理 → 端口探测） ----------
# P站直连在大陆几乎必被阻断（DNS 污染 + SNI 阻断双杀），所以代理与 SNI 绕行两条路都要有。
PIXIV_PROXY_CONFIG = "auto"  # "auto" | "http://127.0.0.1:7890" | ""/None/off = 直连

# 常见本地代理端口（与 anima_danbooru_gallery.FALLBACK_PROXY_PORTS 保持一致）
FALLBACK_PROXY_PORTS = (7890, 7897, 7891, 10809, 2080, 1080)
_fallback_cache: dict[str, tuple[float, str]] = {}

# SNI 绕行开关（大陆网络下 app-api.pixiv.net 的 TLS 握手常被 RST/黑洞）：
#   "auto"（默认）= 直连/代理都失败后自动启用一次；"on"/"1" = 首次请求就用；"off"/"0" = 从不启用。
SNI_BYPASS_CONFIG = "auto"
# 需要绕行的主机（i.pximg.net 一般不受 SNI 阻断，但把它列上不影响正确性：绕行只在失败后触发）
SNI_BYPASS_HOSTS = ("app-api.pixiv.net", "oauth.secure.pixiv.net", "www.pixiv.net", "i.pximg.net")
# DoH 解析端点（与 pixivpy 的 ByPassSniApi 同思路：系统 DNS 可能被污染，DoH 拿真实 IP）
DOH_ENDPOINTS = (
    "https://cloudflare-dns.com/dns-query",
    "https://1.1.1.1/dns-query",
    "https://doh.dns.sb/dns-query",
    "https://1.0.0.1/dns-query",
)
SNI_IP_CACHE_TTL = 1800.0


def _resolve_pixiv_proxies() -> dict[str, str] | None:
    """按与 D 站完全相同的语义解析代理：显式配置 > env > 系统代理(WinINET) > 端口探测。"""
    cfg = os.environ.get("PIXIV_PROXY_CONFIG", PIXIV_PROXY_CONFIG or "").strip()
    if cfg.lower() not in {"", "auto", "none", "direct", "off"}:
        return {"http": cfg, "https": cfg}
    if PIXIV_PROXY_CONFIG.lower() not in {"", "auto", "none", "direct", "off"}:
        return {"http": PIXIV_PROXY_CONFIG, "https": PIXIV_PROXY_CONFIG}
    for env_name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = os.environ.get(env_name, "").strip()
        if value and value.lower() not in {"", "none", "direct", "off"}:
            return {"http": value, "https": value}
    try:
        system = urllib.request.getproxies()
        proxy = system.get("https") or system.get("http")
        if proxy and proxy.lower() not in {"", "none", "direct", "off"}:
            return {"http": proxy, "https": proxy}
    except Exception:
        pass
    return _fallback_proxy()


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


def _proxy_candidates() -> list[dict[str, str]]:
    """按优先级收集代理候选（去重、过滤死值），供活性探测选路。"""
    candidates: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(server: str | None) -> None:
        if not server or server in seen:
            return
        seen.add(server)
        candidates.append({"http": server, "https": server})

    cfg = os.environ.get("PIXIV_PROXY_CONFIG", PIXIV_PROXY_CONFIG or "").strip()
    if cfg.lower() not in {"", "auto", "none", "direct", "off"}:
        add(cfg)
    for env_name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = os.environ.get(env_name, "").strip()
        if value and value.lower() not in {"", "none", "direct", "off"}:
            add(value)
    try:
        system = urllib.request.getproxies()
        add(system.get("https") or system.get("http"))
    except Exception:
        pass
    for port in FALLBACK_PROXY_PORTS:
        add(f"http://127.0.0.1:{port}")
    return candidates


# ---------- SNI 阻断绕行（参考 pixivpy 的 ByPassSniApi：解析 IP + 覆写 Host/SNI） ----------
# 背景：大陆网络对 app-api.pixiv.net 常见两种阻断 —— ①DNS 污染（解析到黑洞 IP）；
# ②SNI 阻断（TCP 能连上，TLS ClientHello 带该域名就被 RST）。
# 对付 ②的通用做法就是 pixivpy 那套：**连解析出来的真实 IP，但 Host 头与 TLS SNI 仍写域名**，
# 证书也按域名校验（assert_hostname）。本模块不引 requests_toolbelt，自己实现等价适配器。
_sni_ip_cache: dict[str, tuple[float, str]] = {}
_sni_lock = threading.Lock()
_sni_active = False  # 已经装过绕行适配器（进程内一次即可）
_sni_installed_hosts: set[str] = set()


def _sni_mode() -> str:
    raw = os.environ.get("PIXIV_SNI_BYPASS", SNI_BYPASS_CONFIG or "").strip().lower()
    if raw in {"off", "0", "false", "no", "disable", "disabled"}:
        return "off"
    if raw in {"on", "1", "true", "yes", "force"}:
        return "on"
    return "auto"


class _SNIHostAdapter(HTTPAdapter):
    """连 IP、但 Host 头 + TLS SNI + 证书校验都用原域名。

    等价于 requests_toolbelt 的 `HostHeaderSSLAdapter`（pixivpy 的 `ByPassSniApi` 用它），
    但改为在 adapter 内直接改写 URL，调用方（我们的 requests 调用点）无需知道 IP：
    上游 urllib3 会把 `server_hostname` / `assert_hostname` 传给 `HTTPSConnection`，
    于是 ClientHello 里的 SNI 是域名，而 TCP 连接落在 IP 上。
    """

    def __init__(self, ip_map: dict[str, str], *args: Any, **kwargs: Any) -> None:
        self._ip_map = dict(ip_map)
        super().__init__(*args, **kwargs)

    def send(self, request: requests.PreparedRequest, **kwargs: Any) -> requests.Response:
        apply_sni_rewrite(self, request)
        return super().send(request, **kwargs)


def apply_sni_rewrite(adapter: "_SNIHostAdapter", request: requests.PreparedRequest) -> bool:
    """把一条请求改写成「TCP 连 IP、Host/SNI/证书校验仍用域名」；返回是否真的改写了。

    单独抽成纯函数是为了能离线验证这条链路（不必真发请求）——SNI 绕行难得有机会实测。
    """
    parsed = urlparse(str(getattr(request, "url", "") or ""))
    host = (parsed.hostname or "").lower()
    ip = adapter._ip_map.get(host)
    if not (ip and parsed.scheme == "https"):
        return False
    netloc = ip if parsed.port is None else f"{ip}:{parsed.port}"
    request.headers["Host"] = parsed.netloc  # 保留原域名（含非默认端口）
    request.url = urlunparse(parsed._replace(netloc=netloc))
    # 连接池默认参数：此后新建的 pool 都带上 server_hostname（SNI）与 assert_hostname（证书校验）
    pool_kwargs = adapter.poolmanager.connection_pool_kw
    pool_kwargs["server_hostname"] = host
    pool_kwargs["assert_hostname"] = host
    return True


def _parse_sni_ip_override() -> dict[str, str]:
    """env 手工指定 IP：`PIXIV_SNI_IPS="app-api.pixiv.net=1.2.3.4,oauth.secure.pixiv.net=5.6.7.8"`。"""
    raw = os.environ.get("PIXIV_SNI_IPS", "").strip()
    mapping: dict[str, str] = {}
    for chunk in raw.split(","):
        host, sep, ip = chunk.partition("=")
        host, ip = host.strip().lower(), ip.strip()
        if sep and host and ip:
            mapping[host] = ip
    return mapping


def _resolve_host_ip(host: str) -> str:
    """解析主机的真实 IP：env 覆写 → DoH → 系统 DNS。全失败返回 ""（由调用方打清晰日志）。"""
    override = _parse_sni_ip_override()
    if override.get(host):
        return override[host]
    now = time.monotonic()
    cached = _sni_ip_cache.get(host)
    if cached and cached[0] > now:
        return cached[1]
    proxies = _resolve_pixiv_proxies()
    for endpoint in DOH_ENDPOINTS:
        try:
            resp = requests.get(
                endpoint,
                params={"name": host, "type": "A"},
                headers={"Accept": "application/dns-json"},
                timeout=4,
                proxies=proxies,
            )
            if resp.status_code != 200:
                continue
            answers = (resp.json() or {}).get("Answer") or []
            for answer in answers:
                data = str((answer or {}).get("data") or "").strip()
                if data and answer.get("type") == 1:
                    _sni_ip_cache[host] = (now + SNI_IP_CACHE_TTL, data)
                    return data
        except Exception:
            continue
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        for info in infos:
            address = info[4][0]
            if address:
                _sni_ip_cache[host] = (now + SNI_IP_CACHE_TTL, address)
                return address
    except Exception:
        pass
    return ""


def _install_sni_bypass(reason: str) -> bool:
    """给 session 装上 SNI 绕行适配器；解析不到任何 IP 时**明确报错**（绝不静默直连）。"""
    global _sni_active
    hosts = [h for h in SNI_BYPASS_HOSTS if h not in _sni_installed_hosts]
    if not hosts:
        return _sni_active
    ip_map: dict[str, str] = {}
    unresolved: list[str] = []
    for host in hosts:
        ip = _resolve_host_ip(host)
        if ip:
            ip_map[host] = ip
        else:
            unresolved.append(host)
    if not ip_map:
        print(
            f"[P站画廊·SNI] 触发原因：{reason}；但 {', '.join(unresolved)} 的真实 IP 解析失败"
            "（DoH 与系统 DNS 都不通）。SNI 绕行不可用 —— 请改用代理"
            "（PIXIV_PROXY_CONFIG=http://127.0.0.1:7890）或设 PIXIV_SNI_IPS 手工指定 IP。",
            flush=True,
        )
        return False
    with _sni_lock:
        _pixiv_session.mount("https://", _SNIHostAdapter(ip_map, max_retries=0))
        _sni_installed_hosts.update(ip_map)
        _sni_active = True
    # 池里可能已有「用域名直连失败」的连接，换适配器后清一次，避免复用旧连接
    try:
        _pixiv_session.adapters["https://"].poolmanager.clear()  # type: ignore[attr-defined]
    except Exception:
        pass
    detail = ", ".join(f"{host}→{ip}" for host, ip in ip_map.items())
    print(f"[P站画廊·SNI] 已启用 SNI 绕行（触发原因：{reason}）｜{detail}", flush=True)
    return True


class PixivError(RuntimeError):
    """P站图源的统一错误类型（消息一律是可读中文，供路由层直接回给前端）。"""


class PixivAuthRequired(PixivError):
    """未登录/授权失效。搜索前必须先完成一次 PKCE 授权。"""


PIXIV_NOT_LOGGED_IN = (
    "P站 未登录：官方 App API 没有匿名搜索，必须先完成一次 OAuth 授权。"
    "步骤：① 打开 GET /anima/gallery/pixiv/auth/url 拿到授权链接并在浏览器打开；"
    "② 登录 Pixiv 后浏览器会跳到 app-api.pixiv.net 的回调地址（页面显示无法访问是正常的）；"
    "③ 复制地址栏里 code= 后面的值，POST /anima/gallery/pixiv/auth/code {\"code\":\"...\"} 即可。"
)


# ---------- token 落盘与自动续期 ----------
_token_lock = threading.Lock()
# 模块级变量（不是常量）：测试里可替换成临时文件，避免写真实 data/
_token_path = Path(__file__).with_name("data") / "pixiv_token.json"
_token_cache: dict[str, Any] | None = None
#: token 文件的 (mtime, size) 指纹。缓存**不能只判 `is None`** —— 那等于"进程活着就只读一次盘"，
#: 于是外部换 token（手工写入 / 另一个进程刷新）永远不会被感知，症状是 `/auth/status`
#: 一直 `logged_in: false` 而文件内容完全正确（2026-09-15 实测踩过，白排查了半天）。
_token_stamp: tuple[float, int] | None = None
_pending_verifiers: "OrderedDict[str, tuple[str, float]]" = OrderedDict()


def _mask_token(value: Any) -> str:
    """只回前 4…后 4 掩码（PLAN §5.5：任何日志/回包都不得出现完整密钥）。"""
    text = str(value or "")
    if not text:
        return ""
    return f"{text[:4]}…{text[-4:]}" if len(text) > 10 else "***"


def _read_token_file() -> dict[str, Any]:
    try:
        data = json.loads(_token_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _load_token() -> dict[str, Any]:
    """读 token（进程内缓存 + **文件指纹失效**，避免每张图都读盘）。

    ⚠️ 缓存判据不能只写 `_token_cache is None`：那等于"进程活着就只读一次盘"。
    外部换 token（手工写入、或另一个进程刷新过）永远不会被感知 —— 实测症状是
    `/auth/status` 一直 `logged_in:false`、搜索回 401，而 token 文件内容完全正确。
    这里用 (mtime, size) 指纹做失效判据，进程内外都能感知变化。
    """
    global _token_cache, _token_stamp
    with _token_lock:
        try:
            stat = _token_path.stat()
            stamp: tuple[float, int] | None = (stat.st_mtime, stat.st_size)
        except OSError:
            stamp = None
        if _token_cache is None or stamp != _token_stamp:
            data = _read_token_file()
            _token_cache = {
                "access_token": str(data.get("access_token") or ""),
                "refresh_token": str(data.get("refresh_token") or ""),
                "expires_at": float(data.get("expires_at") or 0.0),
                "user_id": str(data.get("user_id") or ""),
                "user_name": str(data.get("user_name") or ""),
            }
            _token_stamp = stamp
        return dict(_token_cache)


def _save_token(payload: dict[str, Any]) -> None:
    """落盘 token（不打印任何 token 内容）。"""
    global _token_cache
    record = {
        "version": 1,
        "access_token": str(payload.get("access_token") or ""),
        "refresh_token": str(payload.get("refresh_token") or ""),
        "expires_at": float(payload.get("expires_at") or 0.0),
        "user_id": str(payload.get("user_id") or ""),
        "user_name": str(payload.get("user_name") or ""),
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    with _token_lock:
        _token_path.parent.mkdir(parents=True, exist_ok=True)
        _token_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        _token_cache = dict(record)


def _clear_token() -> None:
    """退出登录：删文件 + 清缓存。"""
    global _token_cache
    with _token_lock:
        try:
            _token_path.unlink(missing_ok=True)
        except OSError as error:
            print(f"[P站画廊] 删除 token 文件失败：{error}", flush=True)
        _token_cache = {}
        _pending_verifiers.clear()


def _token_expired(token: dict[str, Any] | None = None, *, now: float | None = None) -> bool:
    """access_token 是否已过期（提前 TOKEN_EXPIRY_SKEW 秒判定）。无 token 也算过期。"""
    record = _load_token() if token is None else token
    access = str(record.get("access_token") or "")
    if not access:
        return True
    try:
        expires_at = float(record.get("expires_at") or 0.0)
    except (TypeError, ValueError):
        return True
    if expires_at <= 0:
        return True
    return (time.time() if now is None else now) >= (expires_at - TOKEN_EXPIRY_SKEW)


def logged_in() -> bool:
    """有 refresh_token 就认为"登录过"（access_token 可以随时续期）。"""
    token = _load_token()
    return bool(token.get("refresh_token") or token.get("access_token"))


def auth_status() -> dict[str, Any]:
    """给 /auth/status 与协议层用的状态快照（**绝不含 token 明文**）。"""
    token = _load_token()
    expires_at = float(token.get("expires_at") or 0.0)
    return {
        "logged_in": bool(token.get("refresh_token") or token.get("access_token")),
        "expires_at": expires_at or None,
        "expired": _token_expired(token),
        "user_id": token.get("user_id") or None,
        "user_name": token.get("user_name") or None,
        "access_token_masked": _mask_token(token.get("access_token")),
    }


# ---------- PKCE ----------
def generate_code_verifier(length: int = 64) -> str:
    """生成 RFC 7636 §4.1 的 code_verifier（unreserved 字符，43~128 位）。"""
    size = max(43, min(128, int(length)))
    return secrets.token_urlsafe(size)[:size]


def code_challenge_for(verifier: str) -> str:
    """RFC 7636 §4.2：code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))，无 padding。"""
    digest = hashlib.sha256(str(verifier or "").encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def build_auth_url(challenge: str) -> str:
    """Pixiv 的 App 授权页（客户端标识固定为公开的 pixiv-android）。"""
    query = urlencode({
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "client": PIXIV_CLIENT_TAG,
    })
    return f"{PIXIV_LOGIN_URL}?{query}"


def _remember_verifier(verifier: str) -> None:
    """服务端暂存 verifier（跨请求保留）；同一浏览器的多次「去授权」只留最近 8 个。"""
    now = time.time()
    with _token_lock:
        _pending_verifiers[verifier] = (verifier, now)
        while len(_pending_verifiers) > 8:
            _pending_verifiers.popitem(last=False)
        expired = [key for key, (_, at) in _pending_verifiers.items() if now - at > PENDING_VERIFIER_TTL]
        for key in expired:
            _pending_verifiers.pop(key, None)


def _take_pending_verifier() -> str:
    """取最近一次 `/auth/url` 生成的 verifier —— **只作兜底**。

    ⚠️ 别把它当主路径（2026-09-15 真机 bug 的根因就在这里）：
    暂存里可能同时存在多次「去授权」的 verifier，而"取最近一个"在
    「用户拿着**较早**那条链接的 code 回来、期间又点过「去授权」」时必然配错
    → Pixiv 回 `HTTP 400 invalid_request`（用户看到的现象就是"code 是新鲜的但一直失败"）。
    配对正确性由 `/auth/url` 回包里的 `verifier` + `/auth/code` 原样回传保证；
    这里只在调用方没带 verifier 时兜底。
    """
    now = time.time()
    with _token_lock:
        expired = [key for key, (_v, at) in _pending_verifiers.items() if now - at > PENDING_VERIFIER_TTL]
        for key in expired:
            _pending_verifiers.pop(key, None)
        if not _pending_verifiers:
            return ""
        return _pending_verifiers[next(reversed(_pending_verifiers))][0]


def _pending_verifier_count() -> int:
    """暂存候选数（只用于日志诊断）。"""
    with _token_lock:
        return len(_pending_verifiers)


def _verifier_fingerprint(secret: str) -> str:
    """密钥的指纹（S256 前 8 位）—— 日志里用它比对配对关系，**不打印明文**。"""
    return code_challenge_for(secret)[:8] if secret else "-"


def _accept_language() -> str:
    """`translated_name` 的语言由 Accept-Language 决定（pixivpy 的 set_accept_language 同款机制）。"""
    return os.environ.get("PIXIV_ACCEPT_LANGUAGE", "").strip() or PIXIV_ACCEPT_LANGUAGE


# ---------- 会话与请求 ----------
_pixiv_session = requests.Session()
_pixiv_session.headers.update({
    "User-Agent": PIXIV_USER_AGENT,
    "App-OS": "android",
    "App-OS-Version": "11",
    "App-Version": PIXIV_APP_VERSION,
    "Accept-Language": _accept_language(),
    "Referer": PIXIV_REFERER,
})

_image_proxy_semaphore: asyncio.Semaphore | None = None


def _get_image_proxy_semaphore() -> asyncio.Semaphore:
    """图片代理由 asyncio.Semaphore 限流（与 D 站同约定：一屏卡片同时进视口也不打爆上游）。"""
    global _image_proxy_semaphore
    if _image_proxy_semaphore is None:
        _image_proxy_semaphore = asyncio.Semaphore(IMAGE_PROXY_CONCURRENCY)
    return _image_proxy_semaphore


def _apply_pixiv_proxy() -> None:
    """每次请求前按当前环境实时解析代理（Clash 开关/换端口都能热跟随）。"""
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
                _pixiv_session.proxies.clear()
                _pixiv_session.proxies.update(proxies)
                return
    _pixiv_session.proxies.clear()


def _api_headers(*, token: str = "", json_body: bool = False) -> dict[str, str]:
    headers = {
        "User-Agent": PIXIV_USER_AGENT,
        "App-OS": "android",
        "App-OS-Version": "11",
        "App-Version": PIXIV_APP_VERSION,
        "Accept-Language": _accept_language(),
        "Referer": PIXIV_REFERER,
    }
    if json_body:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _pixiv_request(
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: tuple[int, int] = (8, 25),
) -> requests.Response:
    """带「代理 ↔ 直连 ↔ SNI 绕行」三路兜底的请求。

    失败路径必须**显式抛错**（绝不因为网络问题静默返回空结果）：调用方据此回可读错误。
    """
    _apply_pixiv_proxy()
    try:
        return _pixiv_session.request(method, url, params=params, data=data, headers=headers, timeout=timeout)
    except (requests.Timeout, requests.ConnectionError) as first_error:
        host = (urlparse(url).hostname or "").lower()
        # 路径 ①：代理 ↔ 直连互切重试一次（与 D 站同策略）
        if _pixiv_session.proxies:
            _pixiv_session.proxies.clear()
        else:
            fallback = _fallback_proxy()
            if fallback:
                _pixiv_session.proxies.update(fallback)
        try:
            return _pixiv_session.request(method, url, params=params, data=data, headers=headers, timeout=timeout)
        except (requests.Timeout, requests.ConnectionError) as second_error:
            # 路径 ②：SNI 绕行（解析 IP + 覆写 Host/SNI）。auto 模式下只在这里启用。
            mode = _sni_mode()
            if mode != "off" and host in SNI_BYPASS_HOSTS:
                reason = f"{type(second_error).__name__}: {str(second_error)[:120]}"
                if _install_sni_bypass(reason):
                    try:
                        return _pixiv_session.request(
                            method, url, params=params, data=data, headers=headers, timeout=timeout
                        )
                    except (requests.Timeout, requests.ConnectionError) as sni_error:
                        raise PixivError(
                            f"P站 连不上（已尝试系统代理 / 直连 / SNI 绕行三条路径）："
                            f"{type(sni_error).__name__}。请在 Clash Verge 换节点后重试，"
                            f"或设 PIXIV_SNI_BYPASS=on 强制走 IP 直连。"
                        ) from sni_error
                raise PixivError(
                    f"P站 连不上（已尝试系统代理与直连，SNI 绕行也不可用）：{type(second_error).__name__}。"
                    f"请确认 Clash/代理已开启并换节点后重试。"
                ) from second_error
            raise PixivError(
                f"P站 连不上（已尝试系统代理与直连）：{type(first_error).__name__}。请确认 Clash/代理已开启。"
            ) from second_error
    except requests.RequestException as error:
        raise PixivError(f"P站 请求失败：{type(error).__name__}: {str(error)[:200]}") from error


def _token_request(payload: dict[str, Any]) -> dict[str, Any]:
    """调 /auth/token 换 token（授权码或 refresh_token）。

    失败时的错误信息只带 HTTP 状态码与上游 error 字段 —— **绝不回显请求体**（里面有 refresh_token）。
    """
    headers = {
        "User-Agent": PIXIV_USER_AGENT,
        "App-OS": "android",
        "App-OS-Version": "11",
        "App-Version": PIXIV_APP_VERSION,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": PIXIV_REFERER,
    }
    try:
        resp = _pixiv_request("POST", PIXIV_TOKEN_URL, data=payload, headers=headers, timeout=(8, 25))
    except PixivError:
        raise
    if resp.status_code != 200:
        detail = ""
        try:
            detail = _error_detail(resp.json() or {})
        except ValueError:
            detail = ""
        hint = ""
        if "invalid_grant" in detail:
            hint = "（授权码已用过或已过期：code 只能用一次且有效期约 1 分钟，请重新走一次「去授权」）"
        raise PixivError(f"P站 换取 token 失败（HTTP {resp.status_code}）{hint}{('：' + detail) if detail else ''}")
    try:
        body = resp.json() or {}
    except ValueError as error:
        raise PixivError("P站 token 端点返回的不是 JSON") from error
    response = body.get("response") if isinstance(body, dict) else None
    if not isinstance(response, dict) or not response.get("access_token"):
        raise PixivError("P站 token 端点回包里没有 access_token")
    return response


def _store_token_response(response: dict[str, Any]) -> dict[str, Any]:
    """把 token 端点回包转成本地记录（expires_in 秒 → 绝对时间戳）。"""
    try:
        expires_in = float(response.get("expires_in") or 3600)
    except (TypeError, ValueError):
        expires_in = 3600.0
    user = response.get("user") if isinstance(response.get("user"), dict) else {}
    old = _load_token()
    payload = {
        "access_token": str(response.get("access_token") or ""),
        # refresh_token 是长期凭证：Pixiv 每次刷新都会下发新的，旧的随即失效 → 必须覆盖存
        "refresh_token": str(response.get("refresh_token") or old.get("refresh_token") or ""),
        "expires_at": time.time() + expires_in,
        "user_id": str(user.get("id") or old.get("user_id") or ""),
        "user_name": str(user.get("name") or user.get("account") or old.get("user_name") or ""),
    }
    _save_token(payload)
    return payload


def refresh_access_token() -> dict[str, Any]:
    """用 refresh_token 换新的 access_token（失败即抛可读错误，不静默降级）。"""
    token = _load_token()
    refresh_token = str(token.get("refresh_token") or "")
    if not refresh_token:
        raise PixivAuthRequired(PIXIV_NOT_LOGGED_IN)
    response = _token_request({
        "client_id": PIXIV_CLIENT_ID,
        "client_secret": PIXIV_CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "include_policy": "true",
    })
    return _store_token_response(response)


def exchange_auth_code(code: str, verifier: str) -> dict[str, Any]:
    """用授权码 + PKCE verifier 换取 access_token / refresh_token。"""
    code = str(code or "").strip()
    if not code:
        raise PixivError("缺少授权码 code（从回调地址的 code= 参数里复制）")
    verifier = str(verifier or "").strip() or _take_pending_verifier()
    if not verifier:
        raise PixivError(
            "缺少 code_verifier：请先调用 GET /anima/gallery/pixiv/auth/url 生成授权链接，"
            "或在 body 里显式传 verifier（与服务端生成授权 URL 时用的那个必须一致）"
        )
    if "code=" in code:  # 用户整段地址栏粘进来也认（含 code=xxx&... 或整个 URL）
        code = parse_qs(urlparse(code).query).get("code", [code])[0] or code
    response = _token_request({
        "client_id": PIXIV_CLIENT_ID,
        "client_secret": PIXIV_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": PIXIV_REDIRECT_URI,
        "include_policy": "true",
    })
    return _store_token_response(response)


_refresh_lock = threading.Lock()


def access_token(*, allow_refresh: bool = True) -> str:
    """拿可用的 access_token；过期则自动用 refresh_token 续期。

    ⚠️ 加锁 + double-check：Pixiv 的 refresh_token 是**一次性**的（每次刷新下发新的、旧的立即失效），
    并发刷新会让后来者拿到 `invalid_grant`。所以同一进程内串行化，且抢到锁后重新判一次是否已被别人刷新。
    """
    token = _load_token()
    if not _token_expired(token):
        return str(token.get("access_token") or "")
    if not allow_refresh:
        raise PixivAuthRequired(PIXIV_NOT_LOGGED_IN)
    with _refresh_lock:
        token = _load_token()  # double-check：可能已被其它线程刷新
        if not _token_expired(token):
            return str(token.get("access_token") or "")
        if not token.get("refresh_token"):
            raise PixivAuthRequired(PIXIV_NOT_LOGGED_IN)
        refreshed = refresh_access_token()
        return str(refreshed.get("access_token") or "")


# ---------- 搜索结果 → 统一 item ----------
def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(value)))
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rating_from_x_restrict(value: Any) -> str:
    """x_restrict：0=全年龄、1=R-18、2=R-18G（前端只做展示，不改语义）。"""
    try:
        restrict = int(value)
    except (TypeError, ValueError):
        restrict = 0
    return {1: "r18", 2: "r18g"}.get(restrict, "all")


def _best_original_url(illust: dict[str, Any]) -> str:
    """优先拿原图 URL（§5.7：下载原图要走得通）。

    `search/illust` 一般只回 medium/large；带了 `meta_single_page.original_image_url`
    或 `meta_pages[].image_urls.original` 时才是真原图。拿不到由调用方退回 large。
    """
    single = illust.get("meta_single_page")
    if isinstance(single, dict):
        url = str(single.get("original_image_url") or "").strip()
        if url:
            return url
    pages = illust.get("meta_pages")
    if isinstance(pages, list) and pages:
        first = pages[0]
        if isinstance(first, dict):
            urls = first.get("image_urls") if isinstance(first.get("image_urls"), dict) else {}
            url = str(urls.get("original") or "").strip()
            if url:
                return url
    return ""


def illust_to_item(illust: dict[str, Any]) -> dict[str, Any]:
    """P站 illust → PLAN §5.2 统一 item（缺字段一律 null / []，**不省略 key**）。"""
    if not isinstance(illust, dict):
        illust = {}
    image_urls = illust.get("image_urls") if isinstance(illust.get("image_urls"), dict) else {}
    medium = str(image_urls.get("medium") or image_urls.get("square_medium") or "").strip()
    large = str(image_urls.get("large") or "").strip()
    original = _best_original_url(illust)

    tags: list[str] = []
    tag_details: list[dict[str, Any]] = []
    for raw_tag in illust.get("tags") or []:
        if not isinstance(raw_tag, dict):
            continue
        name = str(raw_tag.get("name") or "").strip()
        translated = str(raw_tag.get("translated_name") or "").strip()
        tag_details.append({"name": name, "translated_name": translated or None})
        for value in (name, translated):
            if value and value not in tags:
                tags.append(value)

    user = illust.get("user") if isinstance(illust.get("user"), dict) else {}
    illust_id = str(illust.get("id") or "").strip()
    bookmarks = _bounded_int(illust.get("total_bookmarks"), 0, 0, 2**31 - 1)

    return {
        "source": PIXIV_SOURCE_ID,
        "id": illust_id,
        "preview_url": medium or large or None,
        # §5.7：优先原图，退回 large（拿不到原图时 meta.full_is_original=false，前端可提示）
        "full_url": original or large or medium or None,
        "width": _bounded_int(illust.get("width"), 0, 0, 200000) or None,
        "height": _bounded_int(illust.get("height"), 0, 0, 200000) or None,
        "tags": tags,
        # P站不公开生成参数（PLAN §1）：这两个字段恒为 null，前端据此隐藏 prompt 相关 UI
        "prompt": None,
        "negative_prompt": None,
        "rating": _rating_from_x_restrict(illust.get("x_restrict")),
        "score": bookmarks if illust.get("total_bookmarks") is not None else None,
        "source_url": f"https://www.pixiv.net/artworks/{illust_id}" if illust_id else None,
        "meta": {
            "author": str(user.get("name") or "") or None,
            "author_id": str(user.get("id") or "") or None,
            "author_account": str(user.get("account") or "") or None,
            "bookmarks": bookmarks,
            "page_count": _bounded_int(illust.get("page_count"), 0, 0, 1000) or None,
            "illust_type": str(illust.get("type") or "") or None,
            "create_date": str(illust.get("create_date") or "") or None,
            "x_restrict": illust.get("x_restrict"),
            "sanity_level": illust.get("sanity_level"),
            "caption": str(illust.get("caption") or "") or None,
            "tag_details": tag_details,
            "full_is_original": bool(original),
            "is_manga": bool(illust.get("is_manga")),
            "total_view": _bounded_int(illust.get("total_view"), 0, 0, 2**31 - 1) or None,
        },
    }


def _page_url(url: Any, page: int) -> Any:
    """把 P站图片 URL 里的 `_p0` 换成 `_p{page}`（多页作品用）。

    同一作品各页的 URL **只差 `_pN` 这一段**（`…/123456_p0_master1200.jpg`），所以不必为每页
    各发一次 `/v1/illust/detail` —— 直接替换即可（社区通行做法，省掉 N 倍请求）。
    """
    if not url or int(page or 0) <= 0:
        return url
    text = str(url)
    replaced = re.sub(r"_p0(?=[_.])", f"_p{int(page)}", text, count=1)
    return replaced if replaced != text else url


def illust_to_items(illust: Any) -> list[dict]:
    """一个作品 → **每页一条 item**。

    用户 2026-09-20 实报："P站画廊似乎只会显示页面第一张图片，如果一个页面有多张图片，
    后续的图片不会显示"。根因就在这里：原实现是
    ``items = [illust_to_item(illust) for illust in raw_items]`` —— **一个作品只产出一条**，
    而 P站 的多页作品（漫画 / 图集）``page_count`` 常是 2~100+，其余页被整批丢掉。

    ⚠️ 单页作品**保持原样**（id 不带页码后缀）：改变 id 会让既有工作流里已保存的
    选中状态与本地分类键（``<source>:<id>``）一起失配。
    """
    base = illust_to_item(illust)
    meta = base.get("meta") if isinstance(base.get("meta"), dict) else {}
    try:
        count = int(meta.get("page_count") or 1)
    except (TypeError, ValueError):
        count = 1
    base_id = str(base.get("id") or "")
    if count <= 1 or not base_id:
        return [base]
    items: list[dict] = []
    for page in range(count):
        item = dict(base)
        # ⚠️ id **必须带页码**：画廊的去重 / 选中 / 分类键都吃 id，同一 id 的多条会互相覆盖
        item["id"] = f"{base_id}_p{page}"
        item["preview_url"] = _page_url(base.get("preview_url"), page)
        item["full_url"] = _page_url(base.get("full_url"), page)
        item["meta"] = {**meta, "page": page, "page_count": count, "illust_id": base_id}
        items.append(item)
    return items


def next_cursor_from_url(next_url: Any) -> str | None:
    """`next_url` → 契约的 `next_cursor`（取其中的 offset；P站没有不透明 cursor）。"""
    if not next_url:
        return None
    try:
        query = parse_qs(urlparse(str(next_url)).query)
    except ValueError:
        return None
    offset = query.get("offset", [None])[0]
    if offset is None or str(offset) == "":
        return None
    try:
        return str(int(offset))
    except (TypeError, ValueError):
        return str(offset)


def cursor_to_offset(cursor: Any) -> int:
    """把契约的 cursor 参数还原成 offset。

    容忍：`"30"` / `30` / 完整 `next_url` / 页码（`page` 由调用方换算）。
    """
    if cursor is None or cursor == "":
        return 0
    if isinstance(cursor, bool):
        return 0
    if isinstance(cursor, int):
        return max(0, cursor)
    text = str(cursor).strip()
    if not text:
        return 0
    if text.startswith("http://") or text.startswith("https://"):
        resolved = next_cursor_from_url(text)
        text = resolved if resolved is not None else "0"
    if text.isdigit():
        return int(text)
    # 不是数字（协议层可能透传了别家的不透明 cursor）→ 明确报错，不静默当成第一页
    raise PixivError(f"P站 无法识别的 cursor：{text[:64]}（应为 offset 数字或 next_url）")


def normalize_word(query: Any, word: Any = "") -> str:
    """关键词归一：`word` 优先（§5.3 的 P站查询参数名），否则用 `query`。"""
    for candidate in (word, query):
        text = str(candidate or "").strip()
        if text:
            return text[:160]
    return ""


def _search_params(word: str, offset: int, target: str, sort: str, filter_value: str) -> dict[str, Any]:
    """按 P站 API 的固定形状组装参数（只放官方认的键）。"""
    params: dict[str, Any] = {
        "filter": filter_value,
        "offset": max(0, int(offset)),
    }
    if word:
        params["word"] = word
        params["search_target"] = target
        params["sort"] = sort
    return params


def _error_detail(payload: Any) -> str:
    """从 P站错误体里取人话。

    实测（2026-09-15 真实探针）P站有两种错误体形状，**必须都认**：
      - `{"error": "invalid_grant"}`（token 端点常见）
      - `{"error": {"user_message": "", "message": "Error occurred at the OAuth process...",
                    "reason": "", "user_message_details": {}}}`（API 端点 OAuth 错误用这个）
    直接 `str(payload["error"])` 会把整个 dict 打出来，既难读又可能漏掉真正的错误原因。
    """
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if isinstance(error, dict):
        for key in ("user_message", "message", "reason"):
            text = str(error.get(key) or "").strip()
            if text:
                return text
        return ""
    text = str(error or "").strip()
    if text:
        return text
    return str(payload.get("error_description") or payload.get("message") or "").strip()


# P站把"token 失效"塞在 HTTP 400 里（不是 401）——靠错误文案里的这些锚点识别。
_AUTH_ERROR_ANCHORS = ("oauth", "access token", "invalid_grant", "invalid_token", "unauthorized")


def _looks_like_auth_error(status: int, detail: str) -> bool:
    if status in (401, 403):
        return True
    return any(anchor in (detail or "").lower() for anchor in _AUTH_ERROR_ANCHORS)


def _fetch_illust_json(
    *,
    word: str,
    offset: int,
    target: str,
    sort: str,
    filter_value: str,
    user_id: str,
    illust_id: str,
    token: str,
) -> dict[str, Any]:
    """真正打 P站 API 的那一层（可被测试直接 monkeypatch）。"""
    if user_id:
        url = PIXIV_USER_ILLUSTS_URL
        params: dict[str, Any] = {"user_id": user_id, "filter": filter_value, "offset": max(0, offset)}
    elif illust_id:
        url = PIXIV_ILLUST_DETAIL_URL
        params = {"illust_id": illust_id, "filter": filter_value}
    elif word:
        url = PIXIV_SEARCH_ILLUST_URL
        params = _search_params(word, offset, target, sort, filter_value)
    else:
        raise PixivError("P站 搜索需要一个关键词 word（或 user_id / illust_id）")

    resp = _pixiv_request(
        "GET",
        url,
        params=params,
        headers=_api_headers(token=token),
        timeout=(8, 25),
    )
    if resp.status_code in (400, 401, 403):
        # 401/403 = 明确未授权；**400 也可能是 token 失效**（P站把 OAuth 错误塞在 400 里，
        # 已由真实探针证实）——所以先按错误文案判断，别急着说"参数被拒绝"。
        detail = ""
        try:
            body = resp.json() or {}
            detail = _error_detail(body)
        except ValueError:
            detail = ""
        if _looks_like_auth_error(resp.status_code, detail):
            raise PixivAuthRequired(
                f"P站 拒绝了本次请求（HTTP {resp.status_code}）：access_token 失效或未授权。"
                f"请重新走一次 OAuth 授权（GET /anima/gallery/pixiv/auth/url）。"
                f"{('上游说明：' + detail) if detail else ''}"
            )
        hint = "（popular_desc 排序需要 Pixiv Premium 会员）" if sort == "popular_desc" else ""
        raise PixivError(f"P站 搜索参数被拒绝（HTTP 400）{hint}{('：' + detail) if detail else ''}")
    if resp.status_code != 200:
        raise PixivError(f"P站 搜索失败（HTTP {resp.status_code}）")
    try:
        payload = resp.json() or {}
    except ValueError as error:
        raise PixivError(f"P站 搜索返回的不是 JSON（HTTP {resp.status_code}）") from error
    if not isinstance(payload, dict):
        raise PixivError("P站 搜索回包不是对象")
    return payload


# 搜索结果短缓存（键 = 查询参数指纹）
_cache_lock = threading.Lock()
_search_cache: "OrderedDict[tuple, tuple[float, list[dict[str, Any]], str | None]]" = OrderedDict()


def _cache_get(key: tuple) -> tuple[list[dict[str, Any]], str | None] | None:
    now = time.monotonic()
    with _cache_lock:
        expired = [k for k, (expires_at, _i, _c) in _search_cache.items() if expires_at <= now]
        for k in expired:
            _search_cache.pop(k, None)
        hit = _search_cache.get(key)
        if hit is None:
            return None
        _search_cache.move_to_end(key)
        return hit[1], hit[2]


def _cache_put(key: tuple, items: list[dict[str, Any]], cursor: str | None) -> None:
    with _cache_lock:
        _search_cache[key] = (time.monotonic() + CACHE_TTL_SECONDS, items, cursor)
        _search_cache.move_to_end(key)
        while len(_search_cache) > CACHE_MAX_ENTRIES:
            _search_cache.popitem(last=False)


def _filter_items(
    items: list[dict[str, Any]],
    *,
    min_bookmark: int,
    nsfw: str,
) -> list[dict[str, Any]]:
    """客户端过滤（P站 API 没有收藏数/NSFW 过滤参数，只能在本页做）。"""
    result = items
    if min_bookmark > 0:
        result = [item for item in result if int((item.get("meta") or {}).get("bookmarks") or 0) >= min_bookmark]
    if nsfw == "safe":
        result = [item for item in result if item.get("rating") == "all"]
    elif nsfw == "r18":
        result = [item for item in result if item.get("rating") in {"r18", "r18g"}]
    return result


def search_illusts(
    *,
    word: str = "",
    query: str = "",
    cursor: Any = None,
    page: Any = None,
    limit: int = 30,
    target: str = "partial_match_for_tags",
    sort: str = "date_desc",
    filter_value: str = "for_android",
    user_id: str = "",
    illust_id: str = "",
    min_bookmark: int = 0,
    nsfw: str = "all",
    token: str = "",
    force: bool = False,
) -> tuple[list[dict[str, Any]], str | None]:
    """P站搜索主干：返回 `(items, next_cursor)`（契约 §5.3）。

    分页语义：P站每页 30 条且只给 `next_url`；`cursor` 参数统一承载 `next_url` 里的 offset。
    `page`（页码）是**另一条等价入口**，只为 `capabilities.page_numbers=true` 服务：
    `cursor` 非空时优先走 cursor，`page` 只在没给 cursor 时生效（offset 换算见下方）。
    """
    keyword = normalize_word(query, word)
    size = _bounded_int(limit, 30, MIN_PAGE_SIZE, MAX_PAGE_SIZE)
    target = target if target in PIXIV_SEARCH_TARGETS else "partial_match_for_tags"
    sort = sort if sort in PIXIV_SEARCH_SORTS else "date_desc"
    filter_value = filter_value if filter_value in PIXIV_FILTERS else "for_android"
    nsfw = nsfw if nsfw in {"all", "safe", "r18"} else "all"
    min_bookmark = _bounded_int(min_bookmark, 0, 0, 10**9)
    user_id = str(user_id or "").strip()
    illust_id = str(illust_id or "").strip()

    if cursor is not None and str(cursor) != "":
        offset = cursor_to_offset(cursor)
    elif page is not None:
        # 兼容「页码」写法（capabilities.page_numbers=true 的依据）：协议层/前端传 page=2 → offset=30。
        #
        # ⚠️ 换算分母是 **PIXIV_PAGE_SIZE（写死 30）**，与 `limit` **无关** —— 真机实测：P站 上游
        # `search/illust` 固定每页 30 条，`limit`（offset 之后本地截取的条数，≤ MAX_PAGE_SIZE=48）
        # 只决定「这一批回给前端几条」，改不动上游的分页栅格。所以：
        #   · page=2 → offset=30 是**上游语义**，不是「第 2 屏 48 条」；
        #   · **不要**擅自改成 `(page - 1) * size`：那会让同一个 page 在不同 limit 下指向不同数据，
        #     与上游栅格错位（翻页出现空洞/重复），且语义变更需用户另行确认。
        offset = max(0, (_bounded_int(page, 1, 1, 100000) - 1) * PIXIV_PAGE_SIZE)
    else:
        offset = 0

    if not (keyword or user_id or illust_id):
        return [], None
    cache_key = (keyword, offset, target, sort, filter_value, user_id, illust_id, size, min_bookmark, nsfw)
    if not force:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    access = token or access_token()
    try:
        payload = _fetch_illust_json(
            word=keyword,
            offset=offset,
            target=target,
            sort=sort,
            filter_value=filter_value,
            user_id=user_id,
            illust_id=illust_id,
            token=access,
        )
    except PixivAuthRequired:
        if token:
            raise  # 调用方显式带了自己的 token（协议层透传）→ 不擅自刷新别人的凭据
        # 本地记录说没过期、服务端却拒绝（时钟偏移 / 服务端侧提前失效）→ 强制续期一次再试。
        # 只重试一次：refresh 本身失败会抛可读错误，不会变成无脑重试。
        refreshed = refresh_access_token()
        access = str(refreshed.get("access_token") or "")
        if not access:
            raise
        payload = _fetch_illust_json(
            word=keyword,
            offset=offset,
            target=target,
            sort=sort,
            filter_value=filter_value,
            user_id=user_id,
            illust_id=illust_id,
            token=access,
        )

    if illust_id:
        # /v1/illust/detail 的回包是 {"illust": {...}}，不是列表
        detail = payload.get("illust")
        raw_items = [detail] if isinstance(detail, dict) else []
        next_cursor = None
    else:
        raw_items = payload.get("illusts") if isinstance(payload.get("illusts"), list) else []
        next_cursor = next_cursor_from_url(payload.get("next_url"))

    # ⚠️ 分页语义按**作品**算：先把作品截到 size，再展开成"每页一条"。
    # 反过来的话（先展开再 [:size]）同一个作品的后续页会把后面的作品挤出这一页，
    # 用户表现为"翻一页只剩几个作品"。
    raw_items = raw_items[:size]
    items = [item for illust in raw_items if isinstance(illust, dict)
             for item in illust_to_items(illust)]
    items = _filter_items(items, min_bookmark=min_bookmark, nsfw=nsfw)
    if not force:
        _cache_put(cache_key, items, next_cursor)
    return items, next_cursor


# ---------- GallerySource 协议实现（duck typing：不 import 协议层模块） ----------
class _Capabilities(dict):
    """capabilities 的兼容载体：既能当属性读（`source.capabilities["tags"]`），
    也能当方法调（`source.capabilities()`）。

    PLAN §5.3 只钉死了 capabilities 的**字段内容**，没钉死它是属性还是方法；协议层并行开发，
    两种写法都可能出现。用一个「可调用的 dict」把两边都接住 —— 比改契约安全（改契约会崩掉另两方）。
    """

    def __call__(self) -> dict[str, bool]:
        return dict(self)


class PixivSource:
    """P站图源适配器（PLAN §5.1 的 B 侧交付物）。

    契约（不可改）：
      - `search(query, cursor, filters) -> (items, next_cursor)`
      - `images_headers()` → 取图代理必须附加的请求头（P站是 Referer，缺则 403）
      - `capabilities` → `{"tags":true,"prompt":false,"nsfw":true,"login":true,"page_numbers":true}`
        （`query` 不写，走协议层缺省 True）；`page_numbers=true` = 支持按页码跳转（上游固定每页 30 条）
      - id / label → 路由与源下拉用
    """

    SOURCE_ID = PIXIV_SOURCE_ID
    id = PIXIV_SOURCE_ID
    label = PIXIV_LABEL
    capabilities = _Capabilities(tags=True, prompt=False, nsfw=True, login=True, page_numbers=True)
    # `query` 没显式写：走 CAPABILITY_DEFAULTS 的缺省 True（P站 search/illust 是服务端关键词检索）。
    # `page_numbers=True`：上游 search/illust 收 `page`，且**固定每页 30 条**（见 search_illusts 的换算注释）。
    # 协议层若需要「这个源要不要先登录」，直接读这个
    requires_login = True

    # 参数容错：query 与 word 都可以；cursor 可省；filters 与散装 kwargs 都接受。
    def search(
        self,
        query: Any = "",
        cursor: Any = None,
        filters: Any = None,
        **kwargs: Any,
    ) -> tuple[list[dict[str, Any]], str | None]:
        options = dict(filters) if isinstance(filters, dict) else {}
        # 散装 kwargs 覆盖 filters（显式关键字优先）；同时容忍协议层用 position 传 page
        for key, value in kwargs.items():
            if value is not None:
                options[key] = value
        if cursor is None:
            cursor = options.pop("cursor", None)
        else:
            options.pop("cursor", None)

        limit = options.pop("limit", options.pop("per_page", 30))
        return search_illusts(
            word=str(options.pop("word", "") or ""),
            query=query,
            cursor=cursor,
            page=options.pop("page", None),
            limit=_bounded_int(limit, 30, MIN_PAGE_SIZE, MAX_PAGE_SIZE),
            target=str(options.pop("target", options.pop("search_target", "partial_match_for_tags")) or ""),
            sort=str(options.pop("sort", "date_desc") or ""),
            filter_value=str(options.pop("filter", options.pop("filter_value", "for_android")) or ""),
            user_id=str(options.pop("user_id", options.pop("artist_id", "")) or ""),
            illust_id=str(options.pop("illust_id", "") or ""),
            min_bookmark=_bounded_int(options.pop("min_bookmark", options.pop("min_bookmark_count", 0)), 0, 0, 10**9),
            nsfw=str(options.pop("nsfw", "all") or "all"),
            force=bool(options.pop("force", False)),
        )

    # `self=None` 的写法让三种调用形式都成立：实例调、类调（PixivSource.images_headers()）、
    # 显式传实例（PixivSource.images_headers(src)）。协议层怎么调都不会炸。
    def images_headers(self=None) -> dict[str, str]:
        """取图必需请求头 —— ⚠️ 缺了 Referer，i.pximg.net 直接 403（PLAN §5.4）。"""
        return {"Referer": PIXIV_REFERER}

    def image_headers(self=None) -> dict[str, str]:
        """`images_headers` 的别名（防协议层用了单数写法）。"""
        return {"Referer": PIXIV_REFERER}

    def is_logged_in(self) -> bool:
        return logged_in()

    def auth_status(self) -> dict[str, Any]:
        return auth_status()


# 模块级单例与标识（协议层按任意一种方式取用都能拿到）
SOURCE = PixivSource()
SOURCE_ID = PIXIV_SOURCE_ID
SOURCE_LABEL = PIXIV_LABEL
CAPABILITIES = PixivSource.capabilities


def get_source() -> PixivSource:
    """协议层取源实例的入口（容错 import 时按需调用）。"""
    return SOURCE


def available() -> bool:
    """当前是否可用（有 token 即视为可用；SNI/代理状态不拦这里，失败时由 search 明确报错）。"""
    return logged_in()


# ---------- 图片取图（后端代理，§5.4：前端不许直连第三方 CDN） ----------
def is_allowed_pixiv_image_url(url: str) -> bool:
    """只允许 P站官方图床的 HTTPS 图片（`i.pximg.net` 及其它 `*.pximg.net`）。"""
    try:
        parsed = urlparse(str(url or ""))
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (host == "pximg.net" or host.endswith(".pximg.net"))


def fetch_image_bytes(url: str, timeout: tuple[int, int] = (8, 30)) -> tuple[bytes, str]:
    """下载 P站图片字节：**必带 Referer**（否则 403），失败走代理↔直连↔SNI 三路兜底。"""
    if not is_allowed_pixiv_image_url(url):
        raise PixivError("只允许代理 pximg.net 的 HTTPS 图片")
    headers = {
        "User-Agent": PIXIV_USER_AGENT,
        "Referer": PIXIV_REFERER,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    resp = _pixiv_request("GET", url, headers=headers, timeout=timeout)
    if resp.status_code != 200:
        if resp.status_code in (403, 404):
            raise PixivError(
                f"P站 图片不可取（HTTP {resp.status_code}）：原图可能已删除，或 Referer 缺失被防盗链拦下"
            )
        raise PixivError(f"P站 图片获取失败（HTTP {resp.status_code}）")
    content_type = (resp.headers.get("Content-Type") or "image/jpeg").split(";", 1)[0]
    return resp.content, content_type


# ---------- HTTP 路由 ----------
def _json_error(message: str, status: int = 502, **extra: Any) -> web.Response:
    payload: dict[str, Any] = {"source": PIXIV_SOURCE_ID, "error": message}
    payload.update(extra)
    return web.json_response(payload, status=status)


def _route_already_registered(routes: Any, method: str, path: str) -> bool:
    """路由表里是否已有同 method + path 的条目。

    为什么必须查（这是真实环境才会暴露的坑，别删）：
    ComfyUI 的 `PromptServer.routes` 是 `aiohttp.web.RouteTableDef`（**list 子类**），
    装饰器阶段只是往列表里 append —— 不去重、也不报错。重复条目要等到启动时
    `app.add_routes(routes)` 才抛
    `RuntimeError: Added route will never be executed, method GET is already registered`，
    而那一刻插件模块早已加载完，**我们没有任何地方能兜住 → ComfyUI 启动直接崩**。
    所以这里在注册前主动让路：路由表里若已有同一条 method + path，本模块就跳过。

    ⚠️ 事实澄清（评审 2026-09-15 核实）：多源协议层 `anima_gallery_sources.py` **不注册任何路由**，
    各源的路由**全部是具体路径注册**（实测 13 条全是具体路径，没有 `{source}` 通配）。
    所以本模块的具体路由是**正常注册路径、不是兜底**——别照着"反正协议层会通配注册"去删它，删了就是 404。
    """
    try:
        entries = list(routes)
    except TypeError:  # 不是可迭代的路由表（被替换成别的实现）→ 交给装饰器自己判断
        return False
    wanted = method.upper()
    for entry in entries:
        entry_method = str(getattr(entry, "method", "") or "").upper()
        entry_path = str(getattr(entry, "path", "") or "")
        if entry_path == path and entry_method in {wanted, "*", "ANY"}:
            return True
    return False


def _register_route(method: str, path: str, handler: Any) -> bool:
    """注册 aiohttp 路由（幂等 + 全兜底）。

    本模块按 §5.3 的契约**自己注册具体路径**（协议层不注册路由，见 `_route_already_registered`）。
    幂等保护是为了防"同一路径被注册两次"：aiohttp 的 `RouteTableDef` 装饰器阶段不去重，
    重复条目会在启动 `app.add_routes()` 时抛错、直接崩掉 ComfyUI（详见上面的 docstring）。
    """
    try:
        routes = PromptServer.instance.routes
    except Exception as error:  # noqa: BLE001 —— 注册失败绝不能让插件加载失败
        print(f"[P站画廊] 拿不到 PromptServer.routes，跳过 {method.upper()} {path}：{error}", flush=True)
        return False
    if _route_already_registered(routes, method, path):
        print(
            f"[P站画廊] 路由 {method.upper()} {path} 已存在（同一路径已注册过），跳过重复注册"
            f"（重复条目会在 ComfyUI 启动 add_routes 时直接崩）",
            flush=True,
        )
        return False
    try:
        getattr(routes, method)(path)(handler)
        return True
    except RuntimeError as error:
        print(f"[P站画廊] 路由 {method.upper()} {path} 未注册（同路径已存在）：{error}", flush=True)
        return False
    except Exception as error:  # noqa: BLE001
        print(f"[P站画廊] 路由 {method.upper()} {path} 注册异常：{type(error).__name__}: {error}", flush=True)
        return False


async def anima_gallery_pixiv_auth_url(request: web.Request) -> web.Response:
    """生成 PKCE 授权链接。

    ⚠️ 回包里**同时**给 `verifier`（真值）和 `verifier_hint`（契约 §5.3 钉死的 null）：
    前端读的是 `data?.verifier || data?.verifier_hint`（widget 4263 / 4271），并会在
    `/auth/code` 把它原样回传 —— **只有这样"这次链接"才与"这次兑换"精确配对**。

    为什么必须这样（2026-09-15 真机 bug，用户复现三次）：只靠服务端暂存"取最近一个"时，
    只要期间又点过一次「去授权」（暂存被覆盖），用户手里那条较早链接的 code 就会被拿去
    配最新的 verifier → Pixiv 回 `HTTP 400 invalid_request`，而 code 本身是新鲜的、参数也全对，
    排查方向会被彻底带偏。verifier 本来就属于发起授权的客户端（PKCE 的标准做法），
    回给自己 localhost 前端不增加暴露面。
    """
    verifier = generate_code_verifier()
    challenge = code_challenge_for(verifier)
    _remember_verifier(verifier)
    return web.json_response({
        "url": build_auth_url(challenge),
        "verifier": verifier,  # 前端存下并在 /auth/code 回传（契约未钉死此键，属新增）
        "verifier_hint": None,  # 契约 §5.3 的字面值保持不变
    })


def _auth_error(message: str, status: int = 400) -> web.Response:
    """授权失败回包：`error` 与 `message` **同值都给**（评审发现，别删任何一个）。

    为什么两个键都要：前端（`web/js/anima_danbooru_gallery_widget.js`）只读 `data.error`，
    若只回 `message`，界面上只剩「HTTP 400 / 502」，我们写的中文原因（例如"缺少 code_verifier：
    请先调用 GET /anima/gallery/pixiv/auth/url"）全部丢失 → 用户完全不知道下一步该做什么。
    `message` 保留是因为其它调用方可能已经在读它。
    """
    return web.json_response({"ok": False, "error": message, "message": message}, status=status)


async def anima_gallery_pixiv_auth_code(request: web.Request) -> web.Response:
    """用授权码换 token：body {"code","verifier"}（verifier 可省，省了用服务端暂存的）。"""
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return _auth_error("body 必须是 JSON：{\"code\":\"...\"}")
    if not isinstance(body, dict):
        return _auth_error("body 必须是对象")
    code = str(body.get("code") or "").strip()
    verifier = str(body.get("verifier") or "").strip()
    if not code:
        return _auth_error("缺少 code（从回调地址的 code= 参数里复制）")
    # 优先用前端回传的 verifier（它配上的是本次链接）；没有才回落到服务端暂存。
    used_verifier = verifier or _take_pending_verifier()
    if not used_verifier:
        return _auth_error(
            "缺少 code_verifier：请先调用 GET /anima/gallery/pixiv/auth/url 生成授权链接，"
            "或在 body 里显式传 verifier（必须与生成授权 URL 时用的那个一致）"
        )
    try:
        await _run_in_thread(exchange_auth_code, code, used_verifier)
    except PixivError as error:
        # 失败时打印配对指纹（不打印明文）：下次复发可直接判定是不是 verifier 配错，
        # 而不是又去怀疑 client_id / 参数 / code 新鲜度。
        print(
            f"[P站画廊] 授权码兑换失败｜verifier 来源={'请求自带' if verifier else '服务端暂存'}"
            f"｜verifier 指纹={_verifier_fingerprint(used_verifier)}"
            f"｜code 指纹={_verifier_fingerprint(code)}"
            f"｜暂存候选={_pending_verifier_count()} 个｜{error}",
            flush=True,
        )
        return _auth_error(str(error))
    except Exception as error:  # noqa: BLE001
        return _auth_error(f"授权失败：{type(error).__name__}: {error}", status=502)
    status = auth_status()
    return web.json_response({
        "ok": True,
        "message": f"授权成功，已登录 P站（{status.get('user_name') or status.get('user_id') or '已保存 token'}）",
    })


async def anima_gallery_pixiv_auth_status(request: web.Request) -> web.Response:
    """登录状态（**只回状态与掩码，绝不回 token 明文**）。"""
    status = auth_status()
    return web.json_response({
        "logged_in": bool(status["logged_in"]),
        "expires_at": status["expires_at"],
        "expired": bool(status["expired"]),
        "user_name": status["user_name"],
    })


async def anima_gallery_pixiv_logout(request: web.Request) -> web.Response:
    """退出登录（清 token 文件），便于换号重新授权。"""
    _clear_token()
    return web.json_response({"ok": True, "logged_in": False, "message": "已清除 P站 token"})


async def anima_gallery_pixiv_search(request: web.Request) -> web.Response:
    """`GET /anima/gallery/pixiv/search?word=&target=&sort=&cursor=&page=` → 统一 item 列表。

    `page`（页码跳转）早已接收，`capabilities.page_numbers=true` 就是给它的声明；
    与 `cursor` 二选一，给了 cursor 就以 cursor 为准（见 search_illusts 的分页优先级）。
    """
    query = request.query
    cursor = query.get("cursor", "")
    try:
        items, next_cursor = await _run_in_thread(
            search_illusts,
            word=query.get("word", "") or query.get("query", ""),
            query=query.get("query", ""),
            cursor=cursor if cursor != "" else None,
            # 页码跳转：上游固定每页 30 条，换算写死 PIXIV_PAGE_SIZE（与 limit 无关）
            page=query.get("page"),
            limit=query.get("limit", 30),
            target=query.get("target", query.get("search_target", "partial_match_for_tags")),
            sort=query.get("sort", "date_desc"),
            filter_value=query.get("filter", "for_android"),
            user_id=query.get("user_id", ""),
            illust_id=query.get("illust_id", ""),
            min_bookmark=query.get("min_bookmark", 0),
            nsfw=query.get("nsfw", "all"),
            force=query.get("force", "").lower() in {"1", "true", "yes"},
        )
    except PixivAuthRequired as error:
        return _json_error(str(error), status=401, logged_in=False, next_cursor=None)
    except PixivError as error:
        return _json_error(str(error), status=502, logged_in=logged_in(), next_cursor=None)
    except Exception as error:  # noqa: BLE001
        return _json_error(f"P站 搜索异常：{type(error).__name__}: {error}", status=502, next_cursor=None)
    return web.json_response({
        "source": PIXIV_SOURCE_ID,
        "items": items,
        "next_cursor": next_cursor,
        "total": None,
        "logged_in": True,
    })


async def anima_gallery_pixiv_image(request: web.Request) -> web.Response:
    """图片代理：必须带 Referer，否则 i.pximg.net 403（§5.4）。"""
    image_url = request.query.get("url", "").strip()
    if not is_allowed_pixiv_image_url(image_url):
        return _json_error("只允许代理 pximg.net 的 HTTPS 图片", status=400)
    try:
        async with _get_image_proxy_semaphore():
            data, content_type = await _run_in_thread(fetch_image_bytes, image_url)
    except PixivError as error:
        return _json_error(str(error), status=502)
    except Exception as error:  # noqa: BLE001
        return _json_error(f"图片代理失败：{type(error).__name__}: {error}", status=502)
    return web.Response(
        body=data,
        content_type=content_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


def _mask_proxy_url(value: Any) -> Any:
    """把代理 URL 里的 userinfo 段掩码掉：`http://user:pass@host:port` → `http://***:***@host:port`。

    为什么必须有（评审发现的安全问题）：`/diag` 会把代理解析结果回给前端，而 `HTTP_PROXY` 允许
    形如 `http://user:pass@127.0.0.1:7890` 的写法 —— 前端只按 key 名过滤，挡不住 URL 里的 userinfo，
    凭据会直达浏览器。这里在**回显之前**就抹掉，不依赖前端自觉。
    """
    if value is None:
        return value
    text = str(value).strip()
    if not text or "@" not in text:
        return value
    _, _, tail = text.rpartition("@")
    head, sep, _ = text.partition("://")
    scheme = f"{head}{sep}" if sep and "@" not in head else ""
    return f"{scheme}***:***@{tail}" if tail else "***"


def _mask_proxies(proxies: Any) -> Any:
    """代理 dict 的值逐个掩码（保持 key 与结构不变）。"""
    if not isinstance(proxies, dict):
        return proxies
    return {str(key): _mask_proxy_url(value) for key, value in proxies.items()}


def _mask_proxy_candidates(candidates: Any) -> Any:
    """代理候选列表逐个掩码。"""
    if not isinstance(candidates, list):
        return candidates
    return [_mask_proxies(item) for item in candidates]


async def anima_gallery_pixiv_diag(request: web.Request) -> web.Response:
    """诊断入口：代理/SNI/token 状态一次看全（供排查"全部超时/403"）。

    ⚠️ 不含任何 token 明文；代理 URL 的 userinfo 也**必须掩码**后再回显（前端挡不住）。
    """
    status = auth_status()
    return web.json_response({
        "source": PIXIV_SOURCE_ID,
        "logged_in": bool(status["logged_in"]),
        "expires_at": status["expires_at"],
        "access_token_masked": status["access_token_masked"],
        "token_file": str(_token_path),
        "token_file_exists": _token_path.exists(),
        "proxy_config": _mask_proxy_url(PIXIV_PROXY_CONFIG),
        "resolved_proxies": _mask_proxies(_resolve_pixiv_proxies()),
        "proxy_candidates": _mask_proxy_candidates(_proxy_candidates()),
        "session_proxies": _mask_proxies(dict(_pixiv_session.proxies or {})),
        "sni_mode": _sni_mode(),
        "sni_active": _sni_active,
        "sni_hosts": sorted(_sni_installed_hosts),
        "sni_ip_cache": {host: ip for host, (_at, ip) in _sni_ip_cache.items()},
        "capabilities": dict(PixivSource.capabilities),
        "endpoints": {
            "search": PIXIV_SEARCH_ILLUST_URL,
            "user_illusts": PIXIV_USER_ILLUSTS_URL,
            "illust_detail": PIXIV_ILLUST_DETAIL_URL,
            "token": PIXIV_TOKEN_URL,
        },
    })


async def _run_in_thread(func: Any, *args: Any, **kwargs: Any) -> Any:
    """在工作线程跑同步 requests（aiohttp 事件循环不能被网络 IO 阻塞）。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(func, *args, **kwargs))


def register_routes() -> list[str]:
    """注册全部 P站路由；返回成功注册的路径（供启动日志/测试断言）。"""
    routes = (
        ("get", "/anima/gallery/pixiv/auth/url", anima_gallery_pixiv_auth_url),
        ("post", "/anima/gallery/pixiv/auth/code", anima_gallery_pixiv_auth_code),
        ("get", "/anima/gallery/pixiv/auth/status", anima_gallery_pixiv_auth_status),
        ("post", "/anima/gallery/pixiv/logout", anima_gallery_pixiv_logout),
        ("get", "/anima/gallery/pixiv/search", anima_gallery_pixiv_search),
        ("get", "/anima/gallery/pixiv/image", anima_gallery_pixiv_image),
        ("get", "/anima/gallery/pixiv/diag", anima_gallery_pixiv_diag),
    )
    registered: list[str] = []
    for method, path, handler in routes:
        if _register_route(method, path, handler):
            registered.append(path)
    return registered


register_routes()
