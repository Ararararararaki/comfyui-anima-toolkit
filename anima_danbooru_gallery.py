"""D站画廊节点：受控 Danbooru 搜索、图片代理与工作流输出。"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import asyncio
import io
import json
from pathlib import Path
import threading
import time
from typing import Any
from urllib.parse import urlparse
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
DEFAULT_SLOW_ORDER_WINDOW = "1week"
FREE_METATAGS = frozenset({
    "rating", "status", "is", "age", "date", "id", "limit", "score", "downvotes",
    "favcount", "width", "height", "ratio", "mpixels", "filesize", "filetype",
    "duration", "md5", "pixiv_id", "pixiv", "parent", "child", "upvote", "embedded",
    "tagcount",
})


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


def _fetch_posts(request: SearchRequest) -> tuple[list[dict[str, Any]], bool]:
    if not request.force:
        cached = _cached_posts(request)
        if cached is not None:
            return cached, True

    _rate_limiter.wait()
    response = requests.get(
        DANBOORU_POSTS_URL,
        params={"tags": request.tags, "page": request.page, "limit": request.limit},
        headers=DANBOORU_HEADERS,
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list):
        raise ValueError("Danbooru 返回的 posts 不是列表")
    posts = [post for post in data if isinstance(post, dict)]
    _put_cached_posts(request, posts)
    return posts, False


@PromptServer.instance.routes.get("/anima/danbooru/posts")
async def anima_danbooru_posts(request: web.Request) -> web.Response:
    tags = normalize_search_tags(request.query.get("tags", ""))
    if not tags:
        return web.json_response({"posts": [], "query": "", "cached": False})

    warnings: list[str] = []
    order_value = _order_value(tags)
    if order_value in SLOW_ORDERS and not _has_age_tag(tags):
        # 排序唯一 owner（order:*）；评分/收藏/随机无时间窗查询会让 Danbooru 数据库超时 500，
        # 自动附带一个免费 metatag 时间窗（前端的 currentQuery() 同样会预加，这里是权威兜底）。
        tags = (tags + " age:" + DEFAULT_SLOW_ORDER_WINDOW).strip()
        warnings.append(f"「{order_value}」排序已自动附加近 1 周时间窗（否则 Danbooru 会数据库超时）")

    if count_restricted_search_tags(tags) > 2:
        return web.json_response(
            {"error": "D站 匿名搜索最多 2 个计数标签（普通标签与排序各占 1 个）；请减少普通标签或改用默认最新排序"},
            status=400,
        )

    search_request = SearchRequest(
        tags=tags,
        page=_bounded_int(request.query.get("page"), 1, 1, 100000),
        limit=_bounded_int(request.query.get("limit"), 24, MIN_PAGE_SIZE, MAX_PAGE_SIZE),
        force=request.query.get("force", "").lower() in {"1", "true", "yes"},
    )
    try:
        posts, cached = await asyncio.get_running_loop().run_in_executor(None, _fetch_posts, search_request)
    except requests.Timeout:
        return web.json_response({"error": "Danbooru 请求超时，请稍后重试"}, status=504)
    except requests.RequestException as error:
        return web.json_response({"error": _friendly_danbooru_error(error)}, status=502)
    except (TypeError, ValueError) as error:
        return web.json_response({"error": str(error)}, status=502)
    return web.json_response({"posts": posts, "query": search_request.tags, "cached": cached, "warnings": warnings})


@PromptServer.instance.routes.get("/anima/danbooru/image")
async def anima_danbooru_image(request: web.Request) -> web.Response:
    image_url = request.query.get("url", "").strip()
    if not _is_allowed_danbooru_url(image_url):
        return web.json_response({"error": "只允许代理 donmai.us 的 HTTPS 图片"}, status=400)
    try:
        response = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: requests.get(image_url, headers={"User-Agent": DANBOORU_HEADERS["User-Agent"]}, timeout=25),
        )
        response.raise_for_status()
    except requests.Timeout:
        return web.json_response({"error": "图片代理超时"}, status=504)
    except requests.RequestException as error:
        return web.json_response({"error": f"图片代理失败：{error}"}, status=502)
    return web.Response(
        body=response.content,
        content_type=response.headers.get("Content-Type", "image/jpeg").split(";", 1)[0],
        headers={"Cache-Control": "public, max-age=3600"},
    )


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


@PromptServer.instance.routes.get("/anima/danbooru/suggest")
async def anima_danbooru_suggest(request: web.Request) -> web.Response:
    query = normalize_search_tags(request.query.get("q", "")).split(" ")[-1:]
    if not query:
        return web.json_response({"suggestions": [], "didYouMean": [], "rewrites": []})
    term = query[0]
    def fetch():
        _rate_limiter.wait()
        response = requests.get(f"https://danbooru.donmai.us/tags.json", params={"search[name_matches]": f"{term}*", "search[order]": "count", "limit": 8}, headers=DANBOORU_HEADERS, timeout=12)
        response.raise_for_status(); return response.json()
    try:
        tags = await asyncio.get_running_loop().run_in_executor(None, fetch)
        names = [x.get("name") for x in tags if isinstance(x, dict) and x.get("name")]
    except Exception:
        names = []
    return web.json_response({"suggestions": names, "didYouMean": names[:3], "rewrites": names[:3]})


class DanbooruGallery:
    """将画廊的用户选择转换为 ComfyUI 可连接的图像和提示词列表。"""

    NAME = "DanbooruGallery"
    CATEGORY = "TK/Danbooru"
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "prompts")
    OUTPUT_IS_LIST = (True, True)
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
        request = urllib.request.Request(image_url, headers={"User-Agent": DANBOORU_HEADERS["User-Agent"]})
        with urllib.request.urlopen(request, timeout=25) as response:
            image_bytes = response.read()
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        image_array = np.asarray(image).astype(np.float32) / 255.0
        return torch.from_numpy(image_array)[None,]

    def get_selected_data(self, selection_data="{}"):
        try:
            selection_list = json.loads(selection_data or "{}").get("selections", [])
        except (TypeError, ValueError, json.JSONDecodeError):
            selection_list = []
        if not isinstance(selection_list, list) or not selection_list:
            return ([self._empty_image()], [""])

        images: list[torch.Tensor] = []
        prompts: list[str] = []
        for selection in selection_list:
            if not isinstance(selection, dict):
                continue
            prompts.append(str(selection.get("prompt", "")))
            image_url = str(selection.get("image_url", ""))
            try:
                images.append(self._download_image(image_url))
            except Exception:
                images.append(self._empty_image())
        return (images or [self._empty_image()], prompts or [""])


NODE_CLASS_MAPPINGS = {DanbooruGallery.NAME: DanbooruGallery}
NODE_DISPLAY_NAME_MAPPINGS = {DanbooruGallery.NAME: "TK D站画廊"}
