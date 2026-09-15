"""C站（Civitai）图源适配器：多源画廊的第二个图源（PLAN §5 契约；D站老路由一个字节都不改）。

路由（本模块自注册，与 D站 `anima_danbooru_gallery.py` 同写法）：
    GET  /anima/gallery/sources                 图源清单 + capabilities
    GET  /anima/gallery/civitai/search          ?query=&cursor=&limit=&nsfw=&sort=&period=&username=
    GET  /anima/gallery/civitai/image           ?url=<encoded>  图片字节流（后端代理）
    GET  /anima/gallery/secrets                 {"civitai":{"configured","masked"},"pixiv":{"logged_in"}}
    POST /anima/gallery/secrets                 {"source":"civitai","key":"..."}（key="" = 清除）
    POST /anima/gallery/secrets/test            用已保存的 key 打一次轻量请求，回 {"ok","message"}

═══ 2026-09-15 联网实测钉死的 C站语义（照抄别再试错）═══
1. **必须带 `withMeta=true`**：不带时 `items[].meta` 恒为 `null`（实测 nsfw/sort/认证方式全都不影响），
   而 `meta.prompt` 正是这个图源存在的理由（PLAN §1）。meta 实际字段：
   `prompt / negativePrompt / sampler / steps / cfgScale / seed / clipSkip / Size / resources / civitaiResources`。
   ⚠️ `/api/v1/images` **没有** `meta.Model`（那是模型版本端点的字段）——模型信息用条目级
   `baseModel` + `civitaiResources`（只给 modelVersionId 与权重，不带名字）。
2. **`query` 关键词参数被忽略**：实测 query/q/search/text/prompt/tag/keyword 七个参数名给不同关键词，
   返回 id 集合完全相同，且返回的 prompt 里搜不到关键词（`tags=` 直接 400：它要的是数字）。
   同一台机器上 `/api/v1/models?query=` 是**有效**的 —— 所以「C站不能按关键词搜图」是图片端点自身的限制。
   本适配器仍把 query 转发给上游（上游哪天支持就自动生效），另外在**本页内**做一次本地过滤并在
   `warnings` 里如实说明（避免「输入关键词却返回不相干结果」这种静默错误）。
3. **分页是真 cursor**：`metadata.nextCursor`（形如 `"5|1719470081918"`）透传回 `cursor=` 即得下一页
   （实测两页 id 无重叠）；`nextPage` 里还带 cursor，但我们只用 `nextCursor`，**不自造页码**。
4. `sort` 合法值只有 `Most Reactions / Most Comments / Most Collected / Newest / Oldest / Random`
   （非法值上游回 400 ZodError，列出全集）；`limit` 上限 200；`nsfw` 合法值 `None/Soft/Mature/X`。
5. **key 对 `/api/v1/images` 没有可见影响**（无 key / 正确 key / 32 个 0 的假 key，回包逐字节相同，
   连 nsfw=X 都能匿名读）——所以「测试 key」不能打 images 端点，改用 `GET /api/v1/me`：
   有效 key → 200，假 key / 无 key → 401 `{"error":"Unauthorized"}`（实测）。
6. 图片：列表里的 `url` 已是 `original=true` 变体；把它换成 `/width=450/` 即缩略图（实测 200）。
   `image.civitai.com` **不需要 Referer**（带与不带都 200，都是 203950 字节）→ `images_headers()` 回 `{}`。
"""

from __future__ import annotations

import asyncio
import os
import socket
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urlparse

from aiohttp import web
import requests

try:  # 包内导入（ComfyUI 运行时）
    from .anima_gallery_sources import (
        ADAPTER_IMPORTING,
        GallerySource,
        SOURCE_IMAGE_HOSTS,
        adapter_status,
        civitai_key_configured,
        clear_civitai_key,
        effective_civitai_key,
        ensure_adapters_loaded,
        get_source,
        masked_civitai_key,
        normalize_item,
        register,
        save_civitai_key,
        source_for_image_url,
        sources_payload,
    )
except ImportError:  # 顶层导入（pytest / 独立探针：没有包上下文）
    from anima_gallery_sources import (  # type: ignore[no-redef]
        ADAPTER_IMPORTING,
        GallerySource,
        SOURCE_IMAGE_HOSTS,
        adapter_status,
        civitai_key_configured,
        clear_civitai_key,
        effective_civitai_key,
        ensure_adapters_loaded,
        get_source,
        masked_civitai_key,
        normalize_item,
        register,
        save_civitai_key,
        source_for_image_url,
        sources_payload,
    )


# ---------- 路由注册（沿用插件既有写法；独立运行时退化成空装饰器，handler 仍可直接调用） ----------
try:
    from server import PromptServer

    _ROUTES: Any = PromptServer.instance.routes
except Exception:  # noqa: BLE001 —— 离线测试/独立探针没有 ComfyUI 运行时
    _ROUTES = None


def _route_get(path: str):
    if _ROUTES is None:
        return lambda fn: fn
    return _ROUTES.get(path)


def _route_post(path: str):
    if _ROUTES is None:
        return lambda fn: fn
    return _ROUTES.post(path)


# ---------- 常量 ----------
CIVITAI_SOURCE_ID = "civitai"
CIVITAI_LABEL = "C站（Civitai）"
CIVITAI_HOST = "https://civitai.com"
CIVITAI_API_IMAGES_URL = CIVITAI_HOST + "/api/v1/images"
CIVITAI_API_ME_URL = CIVITAI_HOST + "/api/v1/me"
# 图片只允许代理 civitai 自家的 CDN（SSRF 闸门：别的域一律 403）。
# 主机表是协议层的**单一 owner**（`SOURCE_IMAGE_HOSTS`）：图片路由白名单与节点下载路径共用一张表，
# 免得两处各写一份、改一处漏一处。
CIVITAI_IMAGE_ALLOWED_HOSTS = tuple(SOURCE_IMAGE_HOSTS[CIVITAI_SOURCE_ID])
CIVITAI_HEADERS = {
    # C站（Cloudflare）对非浏览器 UA 不友好；沿用 __init__.py 图片代理同款浏览器 UA。
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/json",
}
CIVITAI_SORTS = ("Most Reactions", "Most Comments", "Most Collected", "Newest", "Oldest", "Random")
CIVITAI_DEFAULT_SORT = "Most Reactions"
CIVITAI_NSFW_LEVELS = ("None", "Soft", "Mature", "X")
CIVITAI_PERIODS = ("AllTime", "Year", "Month", "Week", "Day")
DEFAULT_LIMIT = 24
MIN_LIMIT = 1
MAX_LIMIT = 200  # 实测 201 → 400 ZodError（maximum: 200）
PREVIEW_WIDTH = 450  # 列表 url 是 original=true，换成 width=450 作缩略图（实测可取）
CACHE_TTL_SECONDS = 30
CACHE_MAX_ENTRIES = 64
# 与 D站 /anima/image 同一约定：一屏卡片会同时进入视口，代理并发必须收敛，
# 否则单个画廊会打出几十个 CDN 请求，把搜索请求一起饿死。
IMAGE_PROXY_CONCURRENCY = 3
IMAGE_TIMEOUT_SECONDS = 30
# 上游过载/限流的重试（实测 /api/v1/images 会偶发 503 "Image search is temporarily overloaded"）
CIVITAI_MAX_ATTEMPTS = 3
CITIVAI_RETRY_STATUS = frozenset({429, 503})
CIVITAI_RETRY_DELAY_SECONDS = 1.5


# ---------- 代理（与 D站 `_resolve_danbooru_proxies` / FALLBACK_PROXY_PORTS 同约定） ----------
# 直连 civitai.com 在本机时通时断，且大陆网络普遍需要代理；requests 只读 env 代理、不读系统代理，
# 因此这里按同一套语义解析：显式 CIVITAI_PROXY_CONFIG > env HTTPS/HTTP_PROXY > 系统代理(WinINET) > 端口探测。
PROXY_CONFIG = "auto"  # "auto" | "http://127.0.0.1:7890" | ""/None/off = 直连
FALLBACK_PROXY_PORTS = (7890, 7897, 7891, 10809, 2080, 1080)
_proxy_cache: dict[str, tuple[float, str]] = {}


def _probe_proxy_alive(server: str, timeout: float = 0.5) -> bool:
    """TCP 快速探测代理端口是否活着（死代理不白等 20s）。"""
    try:
        parsed = urlparse(server)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 7890
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:  # noqa: BLE001
        return False


def _fallback_proxy() -> dict[str, str] | None:
    """并行探测常见本地代理端口；命中的代理 30s 内复用（避免每次请求重复探测）。"""
    now = time.monotonic()
    cached = _proxy_cache.get("last")
    if cached is not None and now - cached[0] < 30:
        server = cached[1]
        return {"http": server, "https": server} if server else None
    servers = [f"http://127.0.0.1:{port}" for port in FALLBACK_PROXY_PORTS]
    try:
        with ThreadPoolExecutor(max_workers=len(servers)) as pool:
            alive = list(pool.map(_probe_proxy_alive, servers))
    except Exception:  # noqa: BLE001
        alive = [False] * len(servers)
    server = next((s for s, ok in zip(servers, alive) if ok), "")
    _proxy_cache["last"] = (now, server)
    return {"http": server, "https": server} if server else None


def _resolve_civitai_proxies() -> dict[str, str] | None:
    """按优先级解析代理（同 D站语义）。"""
    cfg = os.environ.get("CIVITAI_PROXY_CONFIG", PROXY_CONFIG or "").strip()
    if cfg.lower() not in {"", "auto", "none", "direct", "off"}:
        return {"http": cfg, "https": cfg}
    if str(PROXY_CONFIG).lower() not in {"", "auto", "none", "direct", "off"}:
        return {"http": PROXY_CONFIG, "https": PROXY_CONFIG}
    for env_name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = os.environ.get(env_name, "").strip()
        if value and value.lower() not in {"", "none", "direct", "off"}:
            return {"http": value, "https": value}
    # requests 不读系统代理；落地用 urllib 的 getproxies()（Windows 下 = 读注册表 WinINET 系统代理）
    try:
        system = urllib.request.getproxies()
        proxy = system.get("https") or system.get("http")
        if proxy and proxy.lower() not in {"", "none", "direct", "off"}:
            return {"http": proxy, "https": proxy}
    except Exception:  # noqa: BLE001
        pass
    return _fallback_proxy()


_civitai_session = requests.Session()
_civitai_session.headers.update(CIVITAI_HEADERS)


def _apply_civitai_proxy() -> None:
    """每次请求前实时解析代理（用户中途开/关 Clash 不需要重启 ComfyUI）。"""
    proxies = _resolve_civitai_proxies()
    _civitai_session.proxies.clear()
    if proxies:
        _civitai_session.proxies.update(proxies)


def _friendly_civitai_error(error: requests.RequestException) -> str:
    """把上游的 ZodError / 限流 / 鉴权失败翻成中文，而不是把原始串透传给用户。"""
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", 0)
    message = ""
    if response is not None:
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict):
            raw = payload.get("error") or payload.get("message")
            if isinstance(raw, dict):
                raw = raw.get("message") or raw.get("name")
            message = str(raw or "").strip().replace("\n", " ")
    if status == 401:
        return "C站 拒绝了这个 API key（401 Unauthorized）：请在设置里重新填写。"
    if status == 403:
        return "C站 拒绝了本次请求（403）：该内容可能需要登录或已下架。"
    if status == 429:
        return "C站 限流（429）：请稍后再试，或降低连续翻页频率。"
    if status == 400 and message:
        return f"C站 参数被拒绝（400）：{message[:200]}"
    if status and 400 <= status < 500:
        return f"C站 返回错误（HTTP {status}）：{message[:200] or '参数或内容不可用'}"
    return f"C站 请求失败：{error}"


def _civitai_get_once(url: str, headers: dict[str, str], timeout: int,
                      params: dict[str, Any] | None = None) -> requests.Response:
    """单次 GET（含「代理 ↔ 直连」换路重试一次）—— 请求层唯一 owner，JSON 与图片共用。

    路径策略与 D站一致：先走解析到的代理；连接层失败（代理空窗/节点抖动）就换另一条路重试一次
    （当前走代理 → 试直连；当前直连 → 试探测到的兜底代理），再失败才抛出。
    connect 6s 快速失败，避免「一次请求白等 20s」。
    """
    _apply_civitai_proxy()
    try:
        return _civitai_session.get(url, params=params, headers=headers, timeout=(6, timeout))
    except (requests.Timeout, requests.ConnectionError):
        if _civitai_session.proxies:
            _civitai_session.proxies.clear()  # 当前走代理 → 换直连
        else:
            fallback = _fallback_proxy()
            if fallback:
                _civitai_session.proxies.update(fallback)
        try:
            return _civitai_session.get(url, params=params, headers=headers, timeout=(6, timeout))
        except (requests.Timeout, requests.ConnectionError):
            _apply_civitai_proxy()  # 还原现场
            raise


def _civitai_request_json(url: str, params: dict[str, Any], timeout: int = 20, *,
                          with_key: bool = True) -> Any:
    """GET 一个 C站 JSON 端点（含 429/503 重试）。

    C站 搜索服务会偶发过载，实测 `/api/v1/images` 直接回
    `503 {"error":"Image search is temporarily overloaded — please retry."}`;
    面板侧 `panel/src/api/civitai.ts` 对 429/503 也是「等几秒重试」的同一套处理，这里保持一致。
    连接层失败（代理空窗/节点抖动）则由 `_civitai_get_once` 换路重试一次。
    """
    headers = dict(CIVITAI_HEADERS)
    key = effective_civitai_key() if with_key else ""
    if key:
        # 鉴权只走请求头；key 绝不进 URL（URL 会进日志/错误信息）
        headers["Authorization"] = f"Bearer {key}"
    for attempt in range(CIVITAI_MAX_ATTEMPTS):
        resp = _civitai_get_once(url, headers, timeout, params=params)
        if resp.status_code in CITIVAI_RETRY_STATUS and attempt + 1 < CIVITAI_MAX_ATTEMPTS:
            time.sleep(CIVITAI_RETRY_DELAY_SECONDS * (attempt + 1))
            continue
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError("C站 请求重试后仍未成功")  # pragma: no cover - 上面的分支已覆盖所有出口


def _civitai_get_image(url: str, timeout: int = IMAGE_TIMEOUT_SECONDS) -> tuple[bytes, str]:
    """下载 C站 CDN 图片字节（结构与 D站 `_danbooru_get_image` 一致：换路重试 + 中文错误）。"""
    headers = dict(CIVITAI_HEADERS)
    headers.pop("Accept", None)
    headers.update(SOURCE.images_headers())
    try:
        resp = _civitai_get_once(url, headers, timeout)
    except (requests.Timeout, requests.ConnectionError) as error:
        raise RuntimeError(f"C站 图片下载连不上：{error}。请确认 Clash/代理已开启") from error
    resp.raise_for_status()
    content_type = (resp.headers.get("Content-Type") or "image/jpeg").split(";", 1)[0]
    return resp.content, content_type


# ---------- 统一 item 映射 ----------
def _url_with_transform(url: str, segment: str) -> str:
    """把 C站 CDN URL 里的变换段（`original=true` / `width=450`）换成指定值。"""
    text = str(url or "").strip()
    if not text:
        return ""
    parts = text.split("/")
    for index, part in enumerate(parts):
        if part.startswith("width=") or part.startswith("original=") or part.startswith("height="):
            parts[index] = segment
            return "/".join(parts)
    return text


def _reaction_score(stats: Any) -> int | None:
    """score = 总反应数（like+heart+laugh+cry）；C站没有 D站 那种单一 score。"""
    if not isinstance(stats, dict):
        return None
    total = 0
    seen = False
    for name in ("likeCount", "heartCount", "laughCount", "cryCount"):
        value = stats.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            total += int(value)
            seen = True
    return total if seen else None


def _civitai_to_item(raw: Any) -> dict[str, Any]:
    """C站回包条目 → 统一 item（PLAN §5.2）。字段缺失一律 null/[]，绝不省略 key。"""
    data = raw if isinstance(raw, dict) else {}
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    image_id = data.get("id")
    full_url = str(data.get("url") or "").strip()
    item_meta: dict[str, Any] = {
        # 采样参数（PLAN 指定要收进 meta 的那几项）
        "sampler": meta.get("sampler"),
        "steps": meta.get("steps"),
        "cfgScale": meta.get("cfgScale"),
        "seed": meta.get("seed"),
        "clipSkip": meta.get("clipSkip"),
        "size": meta.get("Size"),
        # `/api/v1/images` 不返回 meta.Model；有就带上，没有留给 baseModel/civitaiResources
        "model": meta.get("Model") or meta.get("model"),
        "resources": meta.get("resources") or [],
        "civitaiResources": meta.get("civitaiResources") or [],
        # 条目级信息（列表页展示与「按模型/作者筛选」都要用）
        "username": data.get("username"),
        "baseModel": data.get("baseModel"),
        "modelVersionIds": data.get("modelVersionIds") or [],
        "postId": data.get("postId"),
        "createdAt": data.get("createdAt"),
        "nsfwLevel": data.get("nsfwLevel"),
        "nsfw": data.get("nsfw"),
        "browsingLevel": data.get("browsingLevel"),
        "type": data.get("type"),
        "hash": data.get("hash"),
        "stats": data.get("stats") if isinstance(data.get("stats"), dict) else {},
    }
    return normalize_item(
        data,
        CIVITAI_SOURCE_ID,
        id=image_id,
        preview_url=_url_with_transform(full_url, f"width={PREVIEW_WIDTH}") or None,
        full_url=full_url or None,
        tags=[],  # C站没有标签体系（PLAN §5.3：capabilities.tags=false）
        prompt=meta.get("prompt"),
        negative_prompt=meta.get("negativePrompt"),
        rating=data.get("nsfwLevel"),  # 评级直接用回包档位（None/Soft/Mature/X）
        score=_reaction_score(data.get("stats")),
        source_url=f"{CIVITAI_HOST}/images/{image_id}" if image_id is not None else None,
        meta=item_meta,
    )


# ---------- 查询参数校验 ----------
def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(str(value).strip())))
    except (TypeError, ValueError):
        return default


def _normalize_sort(value: Any) -> str:
    """排序：认 C站 的官方四种 + Oldest/Random；也认前端常见的下划线/小写写法。"""
    text = str(value or "").strip()
    if not text:
        return CIVITAI_DEFAULT_SORT
    folded = text.lower().replace("_", " ").replace("-", " ")
    folded = " ".join(folded.split())
    for known in CIVITAI_SORTS:
        if folded == known.lower():
            return known
    raise ValueError(f"不支持的排序 {text!r}；可选：{' / '.join(CIVITAI_SORTS)}")


def _normalize_nsfw(value: Any) -> str | None:
    """nsfw 档位：None/Soft/Mature/X；也接受前端面板沿用的 true/false 布尔写法。"""
    text = str(value or "").strip()
    if not text:
        return None
    low = text.lower()
    if low in {"true", "1", "yes", "all", "x"}:
        return "X"
    if low in {"false", "0", "no", "sfw"}:
        return "None"
    for known in CIVITAI_NSFW_LEVELS:
        if low == known.lower():
            return known
    raise ValueError(f"不支持的 nsfw 档位 {text!r}；可选：{' / '.join(CIVITAI_NSFW_LEVELS)}")


def _normalize_period(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    for known in CIVITAI_PERIODS:
        if text.lower() == known.lower():
            return known
    raise ValueError(f"不支持的时间范围 {text!r}；可选：{' / '.join(CIVITAI_PERIODS)}")


def build_search_params(*, query: str = "", cursor: str | None = None, limit: int = DEFAULT_LIMIT,
                        nsfw: str | None = None, sort: str | None = None,
                        period: str | None = None, username: str | None = None) -> dict[str, Any]:
    """拼上游查询参数（**不透传任意参数**：只认契约里列出的这几个，避免把前端脏参数打到 C站）。"""
    params: dict[str, Any] = {
        "limit": _bounded_int(limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT),
        "sort": _normalize_sort(sort),
        # ⚠️ 实测：不带 withMeta 时 items[].meta 恒为 null（prompt 就拿不到了）
        "withMeta": "true",
    }
    level = _normalize_nsfw(nsfw)
    if level:
        params["nsfw"] = level
    period_value = _normalize_period(period)
    if period_value:
        params["period"] = period_value
    if username and str(username).strip():
        params["username"] = str(username).strip()[:64]
    if cursor and str(cursor).strip():
        # 真 cursor 透传（形如 "5|1719470081918"）；**不自造页码**
        params["cursor"] = str(cursor).strip()
    if query and str(query).strip():
        # 上游会忽略它（见模块头实测 2），但仍原样转发：上游哪天支持就自动生效。
        params["query"] = str(query).strip()[:200]
    return params


def _civitai_images_page(params: dict[str, Any]) -> dict[str, Any]:
    """上游 `/api/v1/images` 单页请求（**唯一的网络入口**，测试直接替换它即可离线跑）。"""
    data = _civitai_request_json(CIVITAI_API_IMAGES_URL, params)
    if not isinstance(data, dict):
        raise ValueError("C站 回包不是对象")
    return data


def _query_terms(query: str) -> list[str]:
    return [term for term in str(query or "").lower().replace("，", " ").split() if term]


def _item_matches(item: dict[str, Any], terms: list[str]) -> bool:
    """本地关键词过滤：prompt / negative_prompt / 作者 三处做「全词命中」（AND）。"""
    if not terms:
        return True
    meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    haystack = " ".join(str(part or "") for part in (
        item.get("prompt"), item.get("negative_prompt"), meta.get("username"),
    )).lower()
    return all(term in haystack for term in terms)


# ---------- 图源实现 ----------
class CivitaiGallerySource(GallerySource):
    """C站图源（PLAN §5.3：`{source}` 段 = `civitai`）。"""

    source_id = CIVITAI_SOURCE_ID
    label = CIVITAI_LABEL

    def capabilities(self) -> dict[str, bool]:
        # C站没有标签体系；有 prompt（meta.prompt）；NSFW 档位齐全；匿名可读（无需登录）；
        # **`query=False`**：图片端点实测忽略关键词（PLAN §6）→ 前端据此禁用/标注搜索框，
        # 只保留「本页内本地过滤」的说明（搜索照旧可用，只是不是服务端检索）。
        return {"tags": False, "prompt": True, "nsfw": True, "login": False, "query": False}

    def images_headers(self) -> dict[str, str]:
        # 实测 image.civitai.com 带不带 Referer 都是 200 → 无需防盗链头
        return {}

    def search_page(self, query: str = "", cursor: str | None = None, limit: int = DEFAULT_LIMIT,
                    nsfw: str | None = None, sort: str | None = None, period: str | None = None,
                    username: str | None = None, **filters: Any) -> dict[str, Any]:
        """返回 `{"items", "next_cursor", "warnings"}`（路由用；`search()` 是它的契约包装）。"""
        params = build_search_params(query=query, cursor=cursor, limit=limit, nsfw=nsfw,
                                     sort=sort, period=period, username=username)
        data = _civitai_images_page(params)
        raw_items = data.get("items")
        items = [_civitai_to_item(raw) for raw in raw_items] if isinstance(raw_items, list) else []
        metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
        next_cursor = metadata.get("nextCursor")
        next_cursor = str(next_cursor).strip() if isinstance(next_cursor, (str, int)) and str(next_cursor).strip() else None

        warnings: list[str] = []
        terms = _query_terms(query)
        if terms:
            matched = [item for item in items if _item_matches(item, terms)]
            warnings.append(
                f"C站 /api/v1/images 不支持关键词搜索（实测 query 参数被上游忽略）："
                f"本次是在已取回的 {len(items)} 条里按『{' '.join(terms)}』本地过滤出 {len(matched)} 条，"
                f"数量可能偏少，可继续翻页或改用排序/NSFW 档位浏览。"
            )
            items = matched
        if not civitai_key_configured():
            warnings.append("未配置 C站 API key：当前按匿名身份请求（实测图片端点匿名可读）。")
        return {"items": items, "next_cursor": next_cursor, "warnings": warnings}

    def search(self, query: str = "", cursor: str | None = None, limit: int = DEFAULT_LIMIT,
               **filters: Any) -> tuple[list[dict[str, Any]], str | None]:
        """协议形状：`(items, next_cursor)`（PLAN §5.3 的 `search` 回包由路由组装）。"""
        page = self.search_page(query=query, cursor=cursor, limit=limit, **filters)
        return page["items"], page["next_cursor"]


SOURCE = CivitaiGallerySource()
SOURCE_ID = CIVITAI_SOURCE_ID
SOURCE_LABEL = CIVITAI_LABEL

# 图源解析：`anima_gallery_sources.load_builtin_sources()` 会认这个 `SOURCE` 实例。
# 若本模块是被单独导入的（例如离线测试），协议层的注册表里可能还没有它 —— 这里补一次自注册，
# 保证 `/anima/gallery/sources` 在两种加载路径下都列出 C站。
def _ensure_registered() -> None:
    if get_source(CIVITAI_SOURCE_ID) is not SOURCE:
        register(SOURCE, replace=get_source(CIVITAI_SOURCE_ID) is not None)


try:  # 自注册失败不影响模块可用性（协议层加载时还会再注册一次）
    _ensure_registered()
except Exception as _register_error:  # noqa: BLE001
    print(f"[C站画廊] 图源自注册失败（协议层加载时会重试）：{_register_error}")


# ---------- 图片代理（复用 /anima/image 的并发与缓存约定） ----------
_image_proxy_semaphore: asyncio.Semaphore | None = None


def _get_image_proxy_semaphore() -> asyncio.Semaphore:
    global _image_proxy_semaphore
    if _image_proxy_semaphore is None:
        _image_proxy_semaphore = asyncio.Semaphore(IMAGE_PROXY_CONCURRENCY)
    return _image_proxy_semaphore


def _is_allowed_civitai_image_url(url: str) -> bool:
    """只允许 https + civitai 自家域（图片一律经后端代理，别让前端把任意 URL 塞进来当跳板）。

    主机判定委托协议层的 `source_for_image_url()`（主机表单一 owner），
    这样图片路由与节点下载路径对「哪些域算 C站」永远不会各说各话；协议本身仍**必须 https**。
    """
    if not str(url or "").strip().lower().startswith("https://"):
        return False
    return source_for_image_url(url) == CIVITAI_SOURCE_ID


def _host_plugin_module() -> Any | None:
    """惰性取插件入口模块（`__init__.py`）——用于复用它的图片字节缓存（条数+总字节双上限）。

    独立运行（pytest / 探针）时没有这个模块，返回 None（此时不缓存，功能不受影响）。
    """
    package = __package__ or ""
    for name in (package, "__init__"):
        if not name:
            continue
        module = sys.modules.get(name)
        if module is not None and hasattr(module, "_image_cache_store"):
            return module
    return None


def _host_cached_image(url: str) -> tuple[bytes, str] | None:
    module = _host_plugin_module()
    if module is None:
        return None
    cache = getattr(module, "_IMAGE_CACHE", None)
    if not isinstance(cache, dict):
        return None
    return cache.get(url)


def _host_store_image(url: str, body: bytes, content_type: str) -> None:
    module = _host_plugin_module()
    if module is None:
        return
    store = getattr(module, "_image_cache_store", None)
    if callable(store):
        store(url, body, content_type)


# ---------- 路由 ----------
@_route_get("/anima/gallery/sources")
async def anima_gallery_sources(request: web.Request) -> web.Response:
    """图源清单 + capabilities（前端隐藏/禁用控件的唯一依据）。"""
    return web.json_response({"sources": sources_payload()})


@_route_get("/anima/gallery/civitai/search")
async def anima_gallery_civitai_search(request: web.Request) -> web.Response:
    """C站图片搜索：**cursor 分页**（透传 `metadata.nextCursor`），参数 query/cursor/limit/nsfw/sort。"""
    raw = {key: request.query.get(key, "") for key in
           ("query", "cursor", "limit", "nsfw", "sort", "period", "username")}
    try:
        limit = _bounded_int(raw["limit"], DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT)
        # 参数校验放在路由里：非法值要回 400 + 中文提示，而不是把 ZodError 透传给前端
        _normalize_sort(raw["sort"])
        _normalize_nsfw(raw["nsfw"])
        _normalize_period(raw["period"])
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)

    try:
        page = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: SOURCE.search_page(
                query=raw["query"], cursor=raw["cursor"] or None, limit=limit,
                nsfw=raw["nsfw"], sort=raw["sort"], period=raw["period"],
                username=raw["username"] or None,
            ),
        )
    except requests.Timeout:
        return web.json_response(
            {"error": "C站 请求超时：已自动尝试直连/代理两条路径仍失败，请确认 Clash/代理已开启后重试"}, status=504)
    except requests.ConnectionError as error:
        return web.json_response(
            {"error": f"连不上 C站：{type(error).__name__}。请确认 Clash/代理已开启；实在不行重启一次 ComfyUI"}, status=502)
    except requests.HTTPError as error:
        status = getattr(getattr(error, "response", None), "status_code", 502)
        return web.json_response({"error": _friendly_civitai_error(error)}, status=401 if status == 401 else 502)
    except requests.RequestException as error:
        return web.json_response({"error": _friendly_civitai_error(error)}, status=502)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": f"C站 回包异常：{error}"}, status=502)

    return web.json_response({
        "source": CIVITAI_SOURCE_ID,
        "items": page["items"],
        "next_cursor": page["next_cursor"],
        "total": None,  # C站 images 端点不返回总数（契约字段照样保留）
        "warnings": page["warnings"],
    })


@_route_get("/anima/gallery/civitai/image")
async def anima_gallery_civitai_image(request: web.Request) -> web.Response:
    """图片代理：复用 `/anima/image` 的并发（3）与缓存（日缓存 + 宿主字节缓存）约定。"""
    image_url = request.query.get("url", "").strip()
    if not _is_allowed_civitai_image_url(image_url):
        return web.json_response({"error": "只允许代理 civitai.com 域名的 HTTPS 图片"}, status=403)

    cached = _host_cached_image(image_url)
    if cached is not None:
        body, content_type = cached
        return web.Response(body=body, content_type=content_type,
                            headers={"Cache-Control": "public, max-age=86400"})
    try:
        async with _get_image_proxy_semaphore():
            data, content_type = await asyncio.get_running_loop().run_in_executor(
                None, _civitai_get_image, image_url)
    except requests.Timeout:
        return web.json_response({"error": "C站 图片代理超时：请确认 Clash/代理已开启"}, status=504)
    except requests.RequestException as error:
        return web.json_response({"error": f"C站 图片代理失败：{error}"}, status=502)
    except RuntimeError as error:
        return web.json_response({"error": str(error)}, status=502)
    _host_store_image(image_url, data, content_type)
    return web.Response(body=data, content_type=content_type,
                        headers={"Cache-Control": "public, max-age=86400"})


# ---------- 密钥路由（PLAN §5.5：GET/POST/test 只管 civitai；P站状态由 B 的 auth/status 提供） ----------
def _pixiv_login_state() -> dict[str, Any]:
    """**尽力而为**读 P站登录态（B 的模块在就顺便带上，不在就 available=False）。

    契约要求 `/anima/gallery/secrets` 里带 `pixiv.logged_in`，但 PLAN §5.5 同时说
    「前端两处分别读、不要互相依赖」——所以这里既不 import 对方的模块，也不因它失败而报错：
    只从注册表里按鸭子类型取，取不到就是 False。
    """
    ensure_adapters_loaded()  # 幂等补加载（启动期导入顺序问题不应让 P站永远缺席）
    source = get_source("pixiv")
    if source is None:
        return {"logged_in": False, "available": False}
    for attr in ("logged_in", "is_logged_in", "login_status", "auth_status"):
        value = getattr(source, attr, None)
        try:
            value = value() if callable(value) else value
        except Exception:  # noqa: BLE001
            continue
        if isinstance(value, bool):
            return {"logged_in": value, "available": True}
        if isinstance(value, dict) and "logged_in" in value:
            return {"logged_in": bool(value.get("logged_in")), "available": True}
    return {"logged_in": False, "available": True}


@_route_get("/anima/gallery/secrets")
async def anima_gallery_secrets_status(request: web.Request) -> web.Response:
    """密钥状态：**只回掩码**（`前4…后4`），绝不回明文。"""
    key = effective_civitai_key()
    return web.json_response({
        "civitai": {
            "configured": bool(key),
            "masked": masked_civitai_key(key),
        },
        "pixiv": _pixiv_login_state(),
    })


@_route_post("/anima/gallery/secrets")
async def anima_gallery_secrets_save(request: web.Request) -> web.Response:
    """保存/清除 C站 API key（`key=""` = 清除）。落盘 data/civitai_key.json（已在 .gitignore 内）。"""
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return web.json_response({"error": "body 必须是 JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "body 必须是对象"}, status=400)
    source_id = str(body.get("source") or CIVITAI_SOURCE_ID).strip().lower()
    if source_id != CIVITAI_SOURCE_ID:
        return web.json_response(
            {"error": f"本接口只管 {CIVITAI_SOURCE_ID} 密钥（P站请走 /anima/gallery/pixiv/auth/*）"}, status=400)
    raw_key = body.get("key")
    if raw_key is None:
        raw_key = body.get("api_key")
    try:
        if raw_key is None or str(raw_key).strip() == "":
            clear_civitai_key()
        else:
            save_civitai_key(raw_key)
    except OSError as error:
        return web.json_response({"error": f"写入密钥失败：{error}"}, status=500)
    key = effective_civitai_key()
    return web.json_response({
        "ok": True,
        "source": CIVITAI_SOURCE_ID,
        "configured": bool(key),
        "masked": masked_civitai_key(key),
        "message": "已保存" if key else "已清除",
    })


@_route_post("/anima/gallery/secrets/test")
async def anima_gallery_secrets_test(request: web.Request) -> web.Response:
    """用已保存的 key 打一次轻量请求验证有效性。

    ⚠️ 为什么不用 images 端点：实测 `/api/v1/images` 对无 key / 正确 key / 32 个 0 的假 key
    返回**逐字节相同**的 200 回包（连 nsfw=X 都匿名可读），拿它测 key 等于没测。
    改用 `GET /api/v1/me`：有效 key → 200，假 key / 无 key → 401（实测）。
    回包只提取账号名用于提示，**不回显任何账号资料详情**（更不回显 key）。
    """
    key = effective_civitai_key()
    if not key:
        return web.json_response({"ok": False, "message": "尚未保存 C站 API key（可先用匿名浏览）"})
    try:
        data = await asyncio.get_running_loop().run_in_executor(
            None, lambda: _civitai_request_json(CIVITAI_API_ME_URL, {}, timeout=15))
    except requests.HTTPError as error:
        status = getattr(getattr(error, "response", None), "status_code", 0)
        if status in (401, 403):
            return web.json_response({"ok": False, "message": "C站 拒绝了该 key（401 Unauthorized）：请重新填写或到 C站账号设置里生成新的只读 key"})
        return web.json_response({"ok": False, "message": _friendly_civitai_error(error)})
    except requests.Timeout:
        return web.json_response({"ok": False, "message": "测试超时：已尝试直连与代理两条路径，请确认 Clash/代理已开启后重试"})
    except Exception as error:  # noqa: BLE001 —— 测试按钮不该把异常抛成 500
        return web.json_response({"ok": False, "message": f"测试失败：{type(error).__name__}: {str(error)[:160]}"})
    username = ""
    if isinstance(data, dict):
        username = str(data.get("username") or "").strip()
    suffix = f"（账号 {username}）" if username else ""
    return web.json_response({
        "ok": True,
        "message": f"C站 API key 有效{suffix}（掩码 {masked_civitai_key(key)}）",
    })


def _mask_proxy_url(value: Any) -> Any:
    """把代理 URL 的 userinfo 段掩码掉：`http://user:pass@host:port` → `http://***:***@host:port`。

    为什么必须有（评审发现的安全问题）：`/diag` 会把代理解析结果回给前端，而 `HTTP_PROXY` 允许写成
    `http://user:pass@127.0.0.1:7890` —— 前端只按键名过滤，挡不住 URL 里的 userinfo，
    凭据会直达浏览器。所以在**回显之前**就抹掉，不依赖前端自觉（与 P站 侧同做法）。
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


# 诊断入口（只读、不含任何密钥；代理 URL 的 userinfo 也必须掩码后回显）
@_route_get("/anima/gallery/civitai/diag")
async def anima_gallery_civitai_diag(request: web.Request) -> web.Response:
    """排障用：暴露图源注册与代理解析结果，便于判断「搜索没结果」是注册问题还是网络问题。

    ⚠️ 回显的代理解析结果**已经过 userinfo 掩码**（`_mask_proxies`）：`HTTP_PROXY` 里可能带账号密码。
    """
    return web.json_response({
        "source": CIVITAI_SOURCE_ID,
        "registered": get_source(CIVITAI_SOURCE_ID) is SOURCE,
        "adapters": {name: ("正在导入中（等待自注册/补加载）" if reason == ADAPTER_IMPORTING else reason)
                     for name, reason in adapter_status().items()},
        "key": {"configured": civitai_key_configured(), "masked": masked_civitai_key()},
        "resolved_proxies": _mask_proxies(_resolve_civitai_proxies()),
        "session_proxies": _mask_proxies(dict(_civitai_session.proxies or {})),
        "fallback_ports": list(FALLBACK_PROXY_PORTS),
        "sorts": list(CIVITAI_SORTS),
        "nsfw_levels": list(CIVITAI_NSFW_LEVELS),
        "limits": {"min": MIN_LIMIT, "max": MAX_LIMIT, "default": DEFAULT_LIMIT},
        "image_proxy_concurrency": IMAGE_PROXY_CONCURRENCY,
    })
