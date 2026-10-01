# -*- coding: utf-8 -*-
"""Moebooru 系图源适配器：**一套骨架服务 yande.re 与 konachan.net 两家**。

## 为什么合并成一个模块

2026-09-26 实测：两家站点的 `post.json` 返回**键名完全同构**（都是 moebooru 引擎）：

    GET https://yande.re/post.json?limit=N&page=P&tags=TAGS        → 200 JSON 数组
    GET https://konachan.net/post.json?limit=N&page=P&tags=TAGS    → 200 JSON 数组

    字段（实测 44 键，两站完全同构）：id / tags / created_at / updated_at / creator_id /
          approver_id / author / change / source / score / md5 / file_size / file_ext /
          file_url / is_shown_in_index / preview_url / preview_width / preview_height /
          actual_preview_width / actual_preview_height / sample_url / sample_width /
          sample_height / sample_file_size / jpeg_url / jpeg_width / jpeg_height /
          jpeg_file_size / rating / is_rating_locked / has_children / parent_id / status /
          is_pending / width / height / is_held / frames_pending_string / frames_pending /
          frames_string / frames / is_note_locked / last_noted_at / last_commented_at

    ⚠️ **尺寸字段有三套，别混用**（2026-09-27 复核实测，yande.re `width=3497/height=2465`
    与 `jpeg_width/jpeg_height` 逐值相等，而 `sample_width/sample_height=1500/1057`）：
    `width`/`height` 与 `jpeg_*` 是**原图尺寸**（`file_url` 那张），`sample_*` 是中间尺寸，
    `preview_*` 是缩略图 —— 统一 item 的 `width`/`height` 必须取前者。

写两份适配器只会让两处代码各自漂移，故用**一份骨架 + 两个实例**（`YANDERE` / `KONACHAN`）。

## 关键语义（实测钉死）

1. **tags 是空格分隔字符串**（与 D 站 / safebooru 一致）；
2. **分页是 `page`（1 基）**，与 D 站同语义 ⇒ `capabilities.page_numbers = true`；
3. **`limit` 上限实测 1000 可用**（返回 490 KB），默认取 24 与其它源保持一致；
4. **无需 key**；`rating` 为 `s`(safe) / `q`(questionable) / `e`(explicit) ——
   konachan.net 是 yande.re 的**全年龄镜像**（同一套数据、只放 safe 内容），
   `konachan.com` 则是被 Cloudflare 挡的原站（实测 `Just a moment...`，见下）。

## konachan.com 为什么没纳入

实测（2026-09-26，经 Clash 7890 + 真实浏览器引擎）：
`konachan.com` / `anime-pictures.net` / `waifu.im` 三家均返回 Cloudflare 挑战页
（`Just a moment...`），**换请求头与换真实浏览器都无效** —— 挡的是本机出口 IP 的信誉，
不是 TLS 指纹。此环境相关性失败**不是站点不可用**，故这里先接 `konachan.net`；
原站的绕过需要干净出口节点，属环境问题而非代码问题。

## 网络健壮性（2026-09-27 加固）

1. **双超时**：`CONNECT_TIMEOUT`（建连/DNS/握手）与 `READ_TIMEOUT`（响应读取）分开，
   覆盖 `HTTP(S)Connection.connect()` 实现 —— 3.13 把 `_create_connection` 改成实例属性，
   覆盖它无效；
2. **有限重试**：只对**幂等 GET**，最多 2 次重试、退避 0.5s / 1.5s；只重试网络类异常
   （超时 / 连接错误 / 5xx），**4xx 立即失败**（重试无意义且可能加重封禁）；
3. **非预期结构不抛异常**：返回 HTML（Cloudflare 拦截页）/ 空体 / 非 JSON / 非数组 →
   `search()` 仍返回 `([], None)`，原因写进 `source.last_warnings` 由路由层填 `warnings`；
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
        get_source,
        normalize_item,
        register,
        source_for_image_url,
    )
except ImportError:  # 顶层导入（pytest / 独立探针）
    from anima_gallery_sources import (  # type: ignore[no-redef]
        SOURCE_IMAGE_HOSTS,
        get_source,
        normalize_item,
        register,
        source_for_image_url,
    )

DEFAULT_LIMIT = 24
MAX_LIMIT = 100
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
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    return [part for part in str(raw or "").split() if part]


class MoebooruSource:
    """moebooru 引擎图源（yande.re / konachan.net 共用这一类）。"""

    #: 最近一次 `search()` 的可读警告（路由层读它填 `warnings`）——
    #: 这样「失败原因」能传到前端，而 `search()` 的返回契约仍是 `(items, next_cursor)` 不变。
    #: 两个实例（YANDERE / KONACHAN）各自持有，互不污染。
    last_warnings: list[str] = []

    def __init__(self, source_id: str, label: str, host: str) -> None:
        self.source_id = source_id
        self.label = label
        self._host = host
        self._api = f"https://{host}/post.json"

    def capabilities(self) -> dict[str, bool]:
        """实测依据见模块 docstring：标签搜索可用、无 prompt、有分级、免登录、
        支持关键词、**支持页码**（page 1 基）。"""
        return {
            "tags": True,
            "prompt": False,
            "nsfw": True,
            "login": False,
            "query": True,
            "page_numbers": True,
        }

    def images_headers(self) -> dict[str, str]:
        """moebooru 的图片 CDN 不校验 Referer（实测 200）→ 免附加头。"""
        return {}

    def search(
        self,
        query: str = "",
        cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
        **filters: Any,
    ) -> tuple[list[dict[str, Any]], str | None]:
        """返回 `(items, next_cursor)`；cursor 即该站的 `page`（1 基，字符串形式）。"""
        try:
            size = max(1, min(MAX_LIMIT, int(limit)))
        except (TypeError, ValueError):
            size = DEFAULT_LIMIT
        try:
            page = max(1, int(cursor)) if cursor not in (None, "") else 1
        except (TypeError, ValueError):
            page = 1

        tags = str(query or "").strip()
        rating = str(filters.get("rating") or "").strip().lower()
        if rating in {"g", "s", "q", "e"}:
            # 该站只有 s/q/e 三档；统一四档里的 g(全年龄) 走 s，s/q 都落 q
            reverse = {"g": "s", "s": "q", "q": "q", "e": "e"}
            tags = (tags + " rating:" + reverse[rating]).strip()

        params: dict[str, Any] = {"limit": size, "page": page}
        if tags:
            params["tags"] = tags

        host_domain = f"{self._host}"
        warnings: list[str] = []
        self.last_warnings = warnings  # 每次调用重置，路由层据此填 warnings
        try:
            payload = _http_json(self._api, params)
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
            post_id = str(row.get("id") or "").strip()
            if not post_id:
                continue
            try:
                score = int(row.get("score") or 0)
            except (TypeError, ValueError):
                score = 0
            try:
                # width/height = **原图**尺寸（实测与 jpeg_width/jpeg_height 逐值相等，见模块
                # docstring）；`sample_*` 只是中间尺寸兜底 —— 实测两站都必给 width/height，
                # 该回退分支正常情况下取不到值，保留只为容忍旧版 moebooru 缺键。
                width = int(row.get("width") or row.get("sample_width") or 0)
                height = int(row.get("height") or row.get("sample_height") or 0)
            except (TypeError, ValueError):
                width = height = 0
            items.append(normalize_item({
                "source": self.source_id,
                "id": post_id,
                "preview_url": row.get("preview_url") or "",
                "full_url": row.get("file_url") or row.get("jpeg_url") or row.get("sample_url") or "",
                "width": width,
                "height": height,
                "tags": _normalize_tags(row.get("tags")),
                "prompt": None,
                "negative_prompt": None,
                "rating": str(row.get("rating") or "").strip().lower() or None,
                "score": score,
                "source_url": f"https://{host_domain}/post/show/{post_id}",
                "meta": {
                    "md5": row.get("md5") or "",
                    "file_ext": row.get("file_ext") or "",
                    "file_size": row.get("file_size") or 0,
                    "author": row.get("author") or "",
                    "source": row.get("source") or "",
                    "sample_url": row.get("sample_url") or "",
                    "jpeg_url": row.get("jpeg_url") or "",
                },
            }))

        if payload and not items:
            # 结构对但字段缺失（例如上游换了 schema）：不抛异常，给出可读原因
            warnings.append(f"上游 {len(payload)} 条记录均缺少必需字段（id），已全部跳过")

        next_cursor = str(page + 1) if len(payload) >= size else None
        return items, next_cursor


#: 两个实例（同一套骨架，不同主机）
YANDERE = MoebooruSource("yandere", "yande.re", "yande.re")
KONACHAN = MoebooruSource("konachan", "Konachan.net", "konachan.net")

SOURCES = (YANDERE, KONACHAN)
#: 兼容协议层的 `SOURCE` 约定（取第一个作为模块代表）
SOURCE = YANDERE
SOURCE_ID = YANDERE.source_id
SOURCE_LABEL = YANDERE.label

#: 各源允许取图的主机（协议层 `SOURCE_IMAGE_HOSTS` 是白名单的单一 owner）
#: moebooru 的图片 CDN 与页面主机不同域，须一并登记，否则代理取图会 403。
IMAGE_HOSTS_BY_SOURCE: dict[str, tuple[str, ...]] = {
    "yandere": ("yande.re", "files.yande.re", "assets.yande.re"),
    "konachan": ("konachan.net", "konachan.com"),
}

for _source in SOURCES:
    SOURCE_IMAGE_HOSTS.setdefault(
        _source.source_id, IMAGE_HOSTS_BY_SOURCE.get(_source.source_id, ())
    )


def _source_for(source_id: str) -> MoebooruSource | None:
    for source in SOURCES:
        if source.source_id == source_id:
            return source
    return None


# ---------- 路由 ----------

@routes.get("/anima/gallery/yandere/suggest")
async def yandere_suggest(request: web.Request) -> web.Response:
    return await suggest_response(request, "yandere", _http_get)


@routes.get("/anima/gallery/konachan/suggest")
async def konachan_suggest(request: web.Request) -> web.Response:
    return await suggest_response(request, "konachan", _http_get)


@routes.get("/anima/gallery/yandere/search")
async def yandere_search(request: web.Request) -> web.Response:
    return await _moebooru_search(request, YANDERE)


@routes.get("/anima/gallery/konachan/search")
async def konachan_search(request: web.Request) -> web.Response:
    return await _moebooru_search(request, KONACHAN)


async def _moebooru_search(request: web.Request, source: MoebooruSource) -> web.Response:
    query = str(request.query.get("query", "") or "").strip()
    # ⚠️ 2026-09-27 修复：前端在 `pageMode()` 分支发的是 **`page`**（见 gallerySearchParams），
    #    而这里原先只读 `cursor` ⇒ 每次翻页都拿回**第 1 页**（实测 page=1/2/3 返回完全相同的 id），
    #    表现就是「翻页没反应 / 无限滚动加载不到新图片」。
    #    moebooru 的 cursor 语义**就是页码（1 基）**，所以 page 可以直接当 cursor 用。
    cursor = request.query.get("cursor")
    if cursor in (None, ""):
        cursor = request.query.get("page")
    try:
        limit = int(request.query.get("limit", DEFAULT_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    filters = {"rating": request.query.get("rating", "")}
    items, next_cursor, warnings = await search_with_warnings(source, query, cursor, limit, **filters)
    if not items and not warnings:
        warnings = ["该图源无结果或请求失败（网络/标签无效）"]
    return web.json_response({
        "source": source.source_id,
        "items": items,
        # 两个键都发：前端**只读下划线版** `next_cursor`（游标模式的源靠它续页），
        # 驼峰版是历史键名，保留以免其它调用方（含外部脚本）断掉 —— 2026-09-27
        "nextCursor": next_cursor,
        "next_cursor": next_cursor,
        "warnings": warnings,
    })


@routes.get("/anima/gallery/yandere/image")
async def yandere_image(request: web.Request) -> web.Response:
    return await _moebooru_image(request, YANDERE)


@routes.get("/anima/gallery/konachan/image")
async def konachan_image(request: web.Request) -> web.Response:
    return await _moebooru_image(request, KONACHAN)


async def _moebooru_image(request: web.Request, source: MoebooruSource) -> web.StreamResponse:
    """图片代理：只允许该图源登记的主机（防 SSRF）；**流式转发** + 30MB 上限 + 只放 image/*。

    体积判定顺序（`StreamResponse` 一旦 `prepare()` 状态码就固定了，超限必须在 prepare 前判掉）：
    ① `Content-Length` 预检 —— 命中就**一个字节都不读**（yande.re 的 169MB 原图走这里）；
    ② 首块嗅探 —— 上游没给 `Content-Length` 时的唯一机会（顺带定内容类型）；
    ③ 流式过程中累计判定 —— 只对「声明不准」的上游生效，此时只能中断连接（状态码已发出）。
    """
    url = str(request.query.get("url", "") or "")
    if not url:
        return web.json_response({"error": "缺少 url"}, status=400)
    owner = source_for_image_url(url)
    if owner != source.source_id:
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
            print(f"[多源画廊] {source.source_id} 图片流式中断：{type(error).__name__}: {error}")
            stream.force_close()
        return stream


def _self_register() -> None:
    for source in SOURCES:
        try:
            if get_source(source.source_id) is not source:
                register(source, replace=get_source(source.source_id) is not None)
        except Exception as error:  # noqa: BLE001
            print(f"[多源画廊] {source.source_id} 自注册失败（不影响其它图源）：{error}")


_self_register()
