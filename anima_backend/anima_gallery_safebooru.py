# -*- coding: utf-8 -*-
"""Safebooru 图源适配器（多源画廊的第四个图源）。

## 站点实测（2026-09-26，经 Clash 7890）

    GET https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=N&pid=P&tags=TAGS
    → 200，JSON 数组（无需 key、无需登录）

实测返回字段（逐字照抄，供映射依据）：
    preview_url / sample_url / file_url / directory / hash / width / height / id / image /
    change / owner / parent_id / rating / sample / sample_height / sample_width / score / tags
响应样例：
    {"preview_url":"https://safebooru.org/thumbnails/593/thumbnail_<hash>.jpg",
     "sample_url":"https://safebooru.org/samples/593/sample_<hash>.jpg",
     "file_url":"https://safebooru.org/images/593/<hash>.jpg",
     "width":3000,"height":4093,"id":7178160,"rating":"general",
     "score":null,"tags":"absurdres animal_ears ..."}

## 关键语义（实测钉死，别再试错）

1. **`score` 常为 `null`**（该站不像 D 站那样统计评分）——统一 item 的 `score` 必须容错成 0；
2. **`tags` 是空格分隔的字符串**，不是数组（与 D 站一致，直接 split 即可）；
3. **无关键词搜索**：`tags` 参数只接受标签；中文必须**先经本地索引翻成英文 tag**
   （实测中文查询返回空数组），这是 `capabilities.tags=true / query=true` 但前端仍需
   走"中文→英文"转换的原因；
4. **分页是 `pid`（0 基）**，不是 page —— 换算 `cursor = pid`；
5. **rating 是字符串**（`general` / `questionable` / `explicit`），没有数字分级；
6. `file_url` 是原图，`preview_url` 是缩略图（约 150px），`sample_url` 是中间尺寸。

## 与 D站 的关系

D站 老路由（`anima_danbooru_gallery.py`）一个字节都不改；本适配器只走统一协议
（`/anima/gallery/safebooru/search` + `/anima/gallery/{source}/image`）。

## 网络健壮性（2026-09-27 加固）

1. **双超时**：`CONNECT_TIMEOUT`（建连/DNS/握手）与 `READ_TIMEOUT`（响应读取）分开，
   覆盖 `HTTP(S)Connection.connect()` 实现 —— 3.13 把 `_create_connection` 改成实例属性，
   覆盖它无效；
2. **有限重试**：只对**幂等 GET**，最多 2 次重试、退避 0.5s / 1.5s；只重试网络类异常
   （超时 / 连接错误 / 5xx），**4xx 立即失败**（重试无意义且可能加重封禁）；
3. **非预期结构不抛异常**：返回 HTML（Cloudflare 拦截页）/ 空体 / 非 JSON / 非数组 →
   `search()` 仍返回 `([], None)`，原因写进 `SOURCE.last_warnings` 由路由层填 `warnings`；
4. **图片代理流式转发**：`web.StreamResponse` 分块读 + 分块写，**绝不把整张图读进内存**；
   单张上限 30MB 在**流式过程中**判定 —— `Content-Length` 预检命中时一个字节都不读
   （实测 yande.re 169MB 原图直接 502「超过 30MB 上限」），Content-Type 缺失时按文件魔数嗅探，
   只放 `image/*`；
5. **图片读取超时 60s**（大图 + 代理链路），与 connect 超时（6s）分开。
"""
from __future__ import annotations

import errno
import http.client
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from aiohttp import web

try:
    from .services.gallery_stream import open_image_stream, search_with_warnings
    from .services.booru_suggestions import suggest_response
except ImportError:
    from services.gallery_stream import open_image_stream, search_with_warnings
    from services.booru_suggestions import suggest_response

try:  # 包内导入（ComfyUI 运行时）
    from .anima_gallery_sources import (
        SOURCE_IMAGE_HOSTS,
        ensure_adapters_loaded,
        get_source,
        normalize_item,
        register,
        source_for_image_url,
        sources_payload,
    )
except ImportError:  # 顶层导入（pytest / 独立探针）
    from anima_gallery_sources import (  # type: ignore[no-redef]
        SOURCE_IMAGE_HOSTS,
        ensure_adapters_loaded,
        get_source,
        normalize_item,
        register,
        source_for_image_url,
        sources_payload,
    )

SAFEEBOORU_SOURCE_ID = "safebooru"
SAFEEBOORU_LABEL = "Safebooru"
SAFEEBOORU_API = "https://safebooru.org/index.php"
DEFAULT_LIMIT = 24
MAX_LIMIT = 100
#: 该站图片主机（ing 白名单由协议层 SOURCE_IMAGE_HOSTS 派生）
IMAGE_HOSTS = ("safebooru.org",)

#: rating 字符串 → 统一 item 的 rating 值（前端按 D站 的四档理解：g/s/q/e）
_RATING_MAP = {
    "general": "g",
    "safe": "g",
    "sensitive": "s",
    "questionable": "q",
    "explicit": "e",
}

USER_AGENT = "ComfyUI-Anima-Batch-LoRA/1.0 (+gallery adapter)"

# ---------- 网络健壮性参数（超时 / 重试 / 体积与类型白名单）----------

#: 连接超时（建连 + TLS 握手）与读取超时（响应体）**分开**：合成一个 timeout 时
#: 无法在 warnings 里说清是「连不上」还是「连上了但慢」。
CONNECT_TIMEOUT = 6.0
READ_TIMEOUT = 25.0
#: 图片代理的读取超时（大图 + 代理链路，比 API 宽得多：169MB 级原图实测必须放宽）
IMAGE_READ_TIMEOUT = 60.0
#: 幂等 GET 的有限重试：最多 2 次重试，指数退避 0.5s / 1.5s
RETRY_BACKOFFS: tuple[float, ...] = (0.5, 1.5)
#: 图片代理：单张体积上限 30MB（防超大文件打爆内存）
MAX_IMAGE_BYTES = 30 * 1024 * 1024
#: 图片代理：内容类型白名单前缀（只放 image/*）
IMAGE_CONTENT_TYPE_PREFIX = "image/"


class UpstreamError(Exception):
    """上游不可用 / 返回非预期结构；`reason` 是给用户看的可读原因（进 warnings）。"""

    def __init__(self, reason: str, *, retryable: bool = False, status: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.retryable = retryable
        self.status = status


def _connect_split_timeout(conn: http.client.HTTPConnection) -> None:
    """建连用 `connect_timeout`，建连后把 socket 超时切成 `read_timeout`。

    ⚠️ Python 3.13 的 `HTTPConnection.__init__` 把 `_create_connection` 设成**实例属性**
    （类上 `hasattr` 为 False），覆盖类方法无效 —— 故直接覆盖 `connect()` 本体，
    并保留父类的 TCP_NODELAY 与 HTTP 隧道（代理 CONNECT）逻辑。
    """
    conn.sock = socket.create_connection(
        (conn.host, conn.port), conn.connect_timeout, conn.source_address)
    conn.sock.settimeout(conn.read_timeout)
    try:
        conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except OSError as error:  # 有些系统不实现 TCP_NODELAY
        if error.errno != errno.ENOPROTOOPT:
            raise
    if conn._tunnel_host:
        conn._tunnel()


class _SplitTimeoutHTTPConnection(http.client.HTTPConnection):
    connect_timeout = CONNECT_TIMEOUT
    read_timeout = READ_TIMEOUT

    def connect(self) -> None:
        _connect_split_timeout(self)


class _SplitTimeoutHTTPSConnection(http.client.HTTPSConnection):
    connect_timeout = CONNECT_TIMEOUT
    read_timeout = READ_TIMEOUT

    def connect(self) -> None:
        _connect_split_timeout(self)
        server_hostname = self._tunnel_host or self.host
        self.sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname)


class _SplitTimeoutHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req: Any) -> Any:
        return self.do_open(_SplitTimeoutHTTPConnection, req)


class _SplitTimeoutHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req: Any) -> Any:
        return self.do_open(_SplitTimeoutHTTPSConnection, req, context=self._context)


def _open(request: urllib.request.Request, read_timeout: float) -> Any:
    """用双超时 opener 发请求（保留 urllib 的代理 / 重定向 / 证书校验能力）。"""
    opener = urllib.request.build_opener(_SplitTimeoutHTTPHandler(), _SplitTimeoutHTTPSHandler())
    return opener.open(request, timeout=read_timeout)


def _classify_error(error: BaseException, read_timeout: float) -> tuple[str, bool]:
    """→ `(可读原因, 是否可重试)`。只有网络类异常可重试；4xx 一律不可重试。

    `URLError` 包住的多是**连接/握手阶段**的失败，裸 `TimeoutError` 多来自**响应读取阶段**
    （`getresponse()` / `read()`），故两者文案不同 —— 这就是「区分 connect / read 超时」。
    """
    if isinstance(error, urllib.error.HTTPError):
        code = int(getattr(error, "code", 0) or 0)
        return f"上游返回 HTTP {code}（{error.reason}）", 500 <= code < 600
    if isinstance(error, urllib.error.URLError):
        reason = error.reason
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return f"上游连接超时（>{CONNECT_TIMEOUT:g}s）", True
        return f"上游连接失败：{reason}", True
    if isinstance(error, (socket.timeout, TimeoutError)):
        return f"上游读取超时（>{read_timeout:g}s）", True
    if isinstance(error, (http.client.HTTPException, ConnectionError)):
        return f"上游响应异常：{type(error).__name__}", True
    return f"上游请求失败：{type(error).__name__}: {error}", False


def _read_limited(response: Any, max_bytes: int | None) -> bytes:
    """读响应体；给了 `max_bytes` 就**边读边判**，超限立即抛（不把超大文件读进内存）。"""
    if max_bytes is None:
        return response.read()
    declared = str(response.headers.get("Content-Length") or "").strip()
    if declared.isdigit() and int(declared) > max_bytes:
        raise UpstreamError(
            f"上游文件过大（{int(declared) // (1024 * 1024)}MB > 上限 {max_bytes // (1024 * 1024)}MB）",
            status=502)
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(65536, max_bytes - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise UpstreamError(
                f"上游文件过大（超过 {max_bytes // (1024 * 1024)}MB 上限）", status=502)
        chunks.append(chunk)
    return b"".join(chunks)


def _open_once(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    read_timeout: float = READ_TIMEOUT,
) -> Any:
    """发**一次** GET → 尚未读取的上游响应（调用方负责 `close()`）；失败抛 `UpstreamError`。

    单独抽出它，是因为**流式取图**必须拿到「未读的响应对象」自己分块读（不能一次 `read()`）。
    """
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        return _open(request, read_timeout)
    except Exception as error:  # noqa: BLE001 —— 连接 / 状态码阶段
        reason, retryable = _classify_error(error, read_timeout)
        raise UpstreamError(reason, retryable=retryable) from error


def _open_for_stream(url: str, *, read_timeout: float = READ_TIMEOUT) -> Any:
    """流式取图用：连接/状态码阶段有限重试 → 返回**未读取**的上游响应。"""
    attempts = len(RETRY_BACKOFFS) + 1
    reason, retryable = "上游请求失败", False
    for attempt in range(attempts):
        if attempt:
            time.sleep(RETRY_BACKOFFS[attempt - 1])
        try:
            return _open_once(url, read_timeout=read_timeout)
        except UpstreamError as error:
            reason, retryable = error.reason, error.retryable
        if not (retryable and attempt < attempts - 1):
            raise UpstreamError(reason, retryable=retryable)
    raise UpstreamError(reason, retryable=retryable)


def _http_get(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    read_timeout: float = READ_TIMEOUT,
    max_bytes: int | None = None,
) -> tuple[bytes, str]:
    """发一次**幂等 GET**（含有限重试）→ `(body, content_type)`；失败抛 `UpstreamError`。

    重试只对网络类异常（连接/读取超时、连接错误、5xx）生效，4xx 立即失败。
    """
    attempts = len(RETRY_BACKOFFS) + 1
    reason, retryable = "上游请求失败", False
    for attempt in range(attempts):
        if attempt:
            time.sleep(RETRY_BACKOFFS[attempt - 1])
        try:
            response = _open_once(url, headers=headers, read_timeout=read_timeout)
        except UpstreamError as error:
            reason, retryable = error.reason, error.retryable
        else:
            try:
                with response:
                    content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                    body = _read_limited(response, max_bytes)
                return body, content_type
            except UpstreamError:
                raise  # 体积超限等业务判定：不重试，原样上抛
            except Exception as error:  # noqa: BLE001 —— 读取阶段
                reason, retryable = _classify_error(error, read_timeout)
        if not (retryable and attempt < attempts - 1):
            raise UpstreamError(reason, retryable=retryable)
    raise UpstreamError(reason, retryable=retryable)


def _register_routes() -> Any:
    """路由注册（独立运行时退化成空装饰器，handler 仍可直接调用）。"""
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


def _http_json(url: str, params: dict[str, Any], timeout: float = READ_TIMEOUT) -> Any:
    """GET 取 JSON。上游被拦（返回 HTML）/ 空体 / 非 JSON → 抛 `UpstreamError`（带可读原因）。"""
    query = urllib.parse.urlencode(params)
    body, content_type = _http_get(f"{url}?{query}", read_timeout=timeout)
    text = body.decode("utf-8", "replace").strip()
    if not text:
        raise UpstreamError("上游返回空响应体")
    if text.lstrip()[:1] == "<":
        raise UpstreamError(
            f"上游返回 HTML 而非 JSON（疑似被 Cloudflare / 防火墙拦截，Content-Type={content_type or '未知'}）")
    try:
        return json.loads(text)
    except ValueError as error:
        raise UpstreamError(f"上游返回无法解析的 JSON（{type(error).__name__}）") from error


#: 图片魔数（Content-Type 缺失/不可信时的兜底嗅探；只认图片）
_IMAGE_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def _sniff_image_type(body: bytes) -> str:
    """按文件头认图片类型（WebP 单独判 `RIFF....WEBP`）；认不出返回空串。"""
    for magic, mime in _IMAGE_MAGIC:
        if body.startswith(magic):
            return mime
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "image/webp"
    return ""


def _normalize_tags(raw: Any) -> list[str]:
    """该站 tags 是空格分隔字符串；统一 item 要求数组。"""
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    return [part for part in str(raw or "").split() if part]


class SafebooruSource:
    """Safebooru 图源（无需 key）。"""

    source_id = SAFEEBOORU_SOURCE_ID
    label = SAFEEBOORU_LABEL
    #: 最近一次 `search()` 的可读警告（路由层读它填 `warnings`）——
    #: 这样「失败原因」能传到前端，而 `search()` 的返回契约仍是 `(items, next_cursor)` 不变。
    last_warnings: list[str] = []

    def capabilities(self) -> dict[str, bool]:
        """实测依据（见模块 docstring）：标签搜索可用、无 prompt 元数据、有 NSFW 分级、
        无需登录、支持关键词（英文标签）、**支持页码**（pid 换算）。"""
        return {
            "tags": True,
            "prompt": False,
            "nsfw": True,
            "login": False,
            "query": True,
            "page_numbers": True,
        }

    def images_headers(self) -> dict[str, str]:
        """该站图片 CDN 不校验 Referer（实测带与不带均 200）→ 免附加头。"""
        return {}

    def search(
        self,
        query: str = "",
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
        **filters: Any,
    ) -> tuple[list[dict[str, Any]], str | None]:
        """返回 `(items, next_cursor)`；cursor 即该站的 `pid`（0 基页码）。"""
        try:
            size = max(1, min(MAX_LIMIT, int(limit)))
        except (TypeError, ValueError):
            size = DEFAULT_LIMIT
        try:
            pid = max(0, int(cursor)) if cursor not in (None, "") else 0
        except (TypeError, ValueError):
            pid = 0

        tags = str(query or "").strip()
        rating = str(filters.get("rating") or "").strip().lower()
        if rating in {"g", "s", "q", "e"}:
            # 统一四档 → 该站字符串（e→explicit；s 该站没有对应档，用 questionable 近似）
            reverse = {"g": "general", "s": "questionable", "q": "questionable", "e": "explicit"}
            tags = (tags + " rating:" + reverse[rating]).strip()

        params: dict[str, Any] = {
            "page": "dapi",
            "s": "post",
            "q": "index",
            "json": "1",
            "limit": size,
            "pid": pid,
        }
        if tags:
            params["tags"] = tags

        warnings: list[str] = []
        self.last_warnings = warnings  # 每次调用重置，路由层据此填 warnings
        try:
            payload = _http_json(SAFEEBOORU_API, params)
        except UpstreamError as error:
            warnings.append(error.reason)
            return [], None
        except Exception as error:  # noqa: BLE001 —— 兜底：任何意外都不许拖崩画廊
            warnings.append(f"上游请求异常：{type(error).__name__}: {error}")
            return [], None
        if not isinstance(payload, list):
            warnings.append(
                f"上游返回结构非预期（期望 JSON 数组，实得 {type(payload).__name__}）")
            return [], None

        items: list[dict[str, Any]] = []
        for row in payload:
            if not isinstance(row, dict):
                continue
            try:
                post_id = str(row.get("id") or "").strip()
            except Exception:
                post_id = ""
            if not post_id:
                continue
            try:
                score = int(row.get("score") or 0)
            except (TypeError, ValueError):
                score = 0  # 实测该站 score 常为 null
            try:
                width = int(row.get("width") or 0)
                height = int(row.get("height") or 0)
            except (TypeError, ValueError):
                width = height = 0
            rating_raw = str(row.get("rating") or "").strip().lower()
            items.append(normalize_item({
                "source": SAFEEBOORU_SOURCE_ID,
                "id": post_id,
                "preview_url": row.get("preview_url") or "",
                "full_url": row.get("file_url") or row.get("sample_url") or "",
                "width": width,
                "height": height,
                "tags": _normalize_tags(row.get("tags")),
                "prompt": None,
                "negative_prompt": None,
                "rating": _RATING_MAP.get(rating_raw, rating_raw or None),
                "score": score,
                "source_url": f"https://safebooru.org/index.php?page=post&s=view&id={post_id}",
                "meta": {
                    "sample_url": row.get("sample_url") or "",
                    "hash": row.get("hash") or "",
                    "owner": row.get("owner") or "",
                },
            }))

        if payload and not items:
            # 结构对但字段缺失（例如上游换了 schema）：不抛异常，给出可读原因
            warnings.append(f"上游 {len(payload)} 条记录均缺少必需字段（id），已全部跳过")

        # 该站满页即认为还有下一页（无 total 字段可用于精确判断）。
        # ⚠️ **前端根本不读这个 cursor，也不存在「末页多一次空请求」**（2026-09-27 复核）：
        # 本适配器声明 `capabilities.page_numbers = true` ⇒ 前端 `pageMode()` 为真 ⇒
        # `gallerySearchParams()` 只发 `page`、从不把 cursor 发回来（游标 UI 整块被
        # `if (!this.pageMode())` 跳过，见 web/js/anima_danbooru_gallery_widget.js）。
        # 故这里满页返回 cursor 只是**契约合规**的保守标志，不会诱使任何人再打一次请求；
        # 翻页正确性完全由前端 `page` 与路由层 `pid` 换算保证。
        next_cursor = str(pid + 1) if len(payload) >= size else None
        return items, next_cursor


SOURCE = SafebooruSource()
SOURCE_ID = SAFEEBOORU_SOURCE_ID
SOURCE_LABEL = SAFEEBOORU_LABEL

# 图片主机登记（协议层白名单的单一 owner）
SOURCE_IMAGE_HOSTS.setdefault(SAFEEBOORU_SOURCE_ID, IMAGE_HOSTS)


# ---------- 路由（与 C站 / P站 适配器同写法）----------

@routes.get("/anima/gallery/safebooru/suggest")
async def safebooru_suggest(request: web.Request) -> web.Response:
    return await suggest_response(request, "safebooru", _http_get)


@routes.get("/anima/gallery/safebooru/search")
async def safebooru_search(request: web.Request) -> web.Response:
    """统一画廊协议：`?query=&cursor=&limit=&rating=`。"""
    query = str(request.query.get("query", "") or "").strip()
    # ⚠️ 2026-09-27 修复：前端在 `pageMode()` 分支发 **`page`**（1 基），而这里原先只读 `cursor`。
    #    safebooru 的 cursor 是 **pid（0 基）**，与 page 差 1 ⇒ 回退时必须减 1，否则整体错一页。
    cursor = request.query.get("cursor")
    if cursor in (None, ""):
        page_value = request.query.get("page")
        if page_value not in (None, ""):
            try:
                cursor = str(max(0, int(page_value) - 1))
            except (TypeError, ValueError):
                cursor = None
    try:
        limit = int(request.query.get("limit", DEFAULT_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    filters = {"rating": request.query.get("rating", "")}
    items, next_cursor, warnings = await search_with_warnings(SOURCE, query, cursor, limit, **filters)
    if not items and not warnings:
        warnings = ["该图源无结果或请求失败（网络/标签无效）"]
    return web.json_response({
        "source": SAFEEBOORU_SOURCE_ID,
        "items": items,
        # 两个键都发：前端**只读下划线版** `next_cursor`，驼峰版是历史键名（2026-09-27）
        "nextCursor": next_cursor,
        "next_cursor": next_cursor,
        "warnings": warnings,
    })


@routes.get("/anima/gallery/safebooru/image")
async def safebooru_image(request: web.Request) -> web.StreamResponse:
    """图片代理：只允许本图源登记的主机（防 SSRF）；**流式转发** + 30MB 上限 + 只放 image/*。

    体积判定顺序（`StreamResponse` 一旦 `prepare()` 状态码就固定了，超限必须在 prepare 前判掉）：
    ① `Content-Length` 预检 —— 命中就**一个字节都不读**（yande.re 的 169MB 原图走这里）；
    ② 首块嗅探 —— 上游没给 `Content-Length` 时的唯一机会（顺带定内容类型）；
    ③ 流式过程中累计判定 —— 只对「声明不准」的上游生效，此时只能中断连接（状态码已发出）。
    """
    url = str(request.query.get("url", "") or "")
    if not url:
        return web.json_response({"error": "缺少 url"}, status=400)
    owner = source_for_image_url(url)
    if owner != SAFEEBOORU_SOURCE_ID:
        return web.json_response({"error": "该主机不属于本图源"}, status=403)
    limit_mb = MAX_IMAGE_BYTES // (1024 * 1024)
    try:
        upstream = await open_image_stream(_open_for_stream, url, read_timeout=IMAGE_READ_TIMEOUT)
    except UpstreamError as error:
        return web.json_response({"error": f"取图失败：{error.reason}"}, status=error.status or 502)
    except Exception as error:  # noqa: BLE001
        return web.json_response({"error": f"取图失败：{type(error).__name__}: {error}"}, status=502)

    async with upstream:
        content_type = (upstream.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        declared = str(upstream.headers.get("Content-Length") or "").strip()
        if declared.isdigit() and int(declared) > MAX_IMAGE_BYTES:
            return web.json_response(
                {"error": f"取图失败：该图 {int(declared) / (1024 * 1024):.1f}MB 超过 {limit_mb}MB 上限"},
                status=502)
        try:
            first = await upstream.read(min(65536, MAX_IMAGE_BYTES + 1))
        except Exception as error:  # noqa: BLE001 —— 首块读取失败（可读原因照常给）
            reason, _ = _classify_error(error, IMAGE_READ_TIMEOUT)
            return web.json_response({"error": f"取图失败：{reason}"}, status=502)
        if not first:
            return web.json_response({"error": "取图失败：上游返回空响应体"}, status=502)
        if len(first) > MAX_IMAGE_BYTES:
            return web.json_response(
                {"error": f"取图失败：该图超过 {limit_mb}MB 上限"}, status=502)
        if not content_type.startswith(IMAGE_CONTENT_TYPE_PREFIX):
            sniffed = _sniff_image_type(first)  # 上游漏给/给错 Content-Type 时按文件头兜底
            if not sniffed:
                return web.json_response(
                    {"error": f"取图失败：内容类型不在白名单（{content_type or '未知'}，只放 image/*）"},
                    status=502)
            content_type = sniffed

        stream = web.StreamResponse(status=200, headers={
            "Content-Type": content_type,
            "Cache-Control": "public, max-age=86400",
        })
        await stream.prepare(request)
        total = len(first)
        try:
            await stream.write(first)
            while True:
                chunk = await upstream.read(65536)  # 后台读一块 → 前台写一块，保留背压和恒定内存
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_IMAGE_BYTES:
                    raise UpstreamError(
                        f"该图超过 {limit_mb}MB 上限（已传输 {total / (1024 * 1024):.1f}MB，连接中断）")
                await stream.write(chunk)
            await stream.write_eof()
        except Exception as error:  # noqa: BLE001 —— 已 prepare，改不了状态码，只能中断连接
            print(f"[多源画廊] {SAFEEBOORU_SOURCE_ID} 图片流式中断：{type(error).__name__}: {error}")
            stream.force_close()
        return stream


def _self_register() -> None:
    """自注册（协议层加载适配器时的推荐写法）。"""
    try:
        if get_source(SAFEEBOORU_SOURCE_ID) is not SOURCE:
            register(SOURCE, replace=get_source(SAFEEBOORU_SOURCE_ID) is not None)
    except Exception as error:  # noqa: BLE001
        print(f"[多源画廊] {SAFEEBOORU_SOURCE_ID} 自注册失败（不影响其它图源）：{error}")


_self_register()
