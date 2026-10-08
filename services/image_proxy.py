"""Image and API proxy routes share explicit HTTP and cache owners."""
import asyncio
import time
import hashlib
from aiohttp import web
from .image_cache import image_cache
_session_getter = None
async def _get_session():
    return await _session_getter()
def configure(session_getter):
    global _session_getter
    _session_getter = session_getter
_PROXY_CACHE: dict = {}


_CACHE_TTL = 60


def _cache_key(url, qs):
    return hashlib.md5(f"{url}?{qs}".encode()).hexdigest()


def _cleanup_cache(cache: dict, ttl: float):
    """清理过期缓存项，防止长期运行内存持续增长。"""
    now = time.time()
    expired = [k for k, v in cache.items() if v[0] < now]
    for k in expired:
        cache.pop(k, None)


async def _proxy(url, request):
    qs = request.query_string
    full = url + ("?" + qs if qs else "")
    skip = request.method == "GET" and qs.startswith("page=")
    ck = _cache_key(url, qs) if request.method == "GET" and not skip else None
    if ck:
        cached = _PROXY_CACHE.get(ck)
        if cached and cached[0] > time.time():
            return web.Response(body=cached[3], status=cached[1], headers=cached[2])
    target = None
    try:
        session = await _get_session()
        async with session.request(request.method, full) as resp:
            body = await resp.read()
            headers = {"Content-Type": resp.content_type}
            if ck and resp.status == 200:
                _PROXY_CACHE[ck] = (time.time() + _CACHE_TTL, resp.status, headers, body)
                _cleanup_cache(_PROXY_CACHE, _CACHE_TTL)
            return web.Response(body=body, status=resp.status, headers=headers)
    except asyncio.TimeoutError:
        return web.json_response({"error": "proxy timeout"}, status=504)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


_IMAGE_MAX_ATTEMPTS = 3


_IMAGE_RETRY_DELAY = 0.25  # 秒；第 n 次重试前等待 n * delay


_IMAGE_ALLOW_PREFIX = "https://image.civitai.com/"


_IMAGE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://civitai.com/",
}


async def anima_image(request):
    """Proxy Civitai preview images (browser cannot reach image.civitai.com without proxy)."""
    url = request.query.get("url", "").strip()
    if not url.startswith(_IMAGE_ALLOW_PREFIX):
        return web.Response(status=403, text="forbidden: only image.civitai.com allowed")

    cached = image_cache.get(url)
    if cached is not None:
        body, ctype = cached
        return web.Response(body=body, content_type=ctype, headers={"Cache-Control": "public, max-age=86400"})

    # 重试策略：上游 4xx（403/404/451 = 图已失效/需要登录）是确定性失败，重试无意义；
    # 5xx 与连接层异常（代理节点抖动）才重试。
    last_reason = "unknown"
    for attempt in range(_IMAGE_MAX_ATTEMPTS):
        try:
            session = await _get_session()
            async with session.get(url, headers=_IMAGE_HEADERS) as resp:
                if resp.status == 200:
                    body = await resp.read()
                    ctype = resp.headers.get("Content-Type", "image/jpeg")
                    image_cache.store(url, body, ctype)
                    return web.Response(body=body, content_type=ctype, headers={"Cache-Control": "public, max-age=86400"})
                last_reason = f"upstream http_{resp.status}"
                if 400 <= resp.status < 500:
                    break
        except Exception as e:
            last_reason = f"{type(e).__name__}: {e}"
        if attempt < _IMAGE_MAX_ATTEMPTS - 1:
            await asyncio.sleep(_IMAGE_RETRY_DELAY * (attempt + 1))

    # 只在最终失败时落日志：给出「原因 + 是否走了代理」，下次复发可直接判定是我方代理未生效
    # 还是上游/代理节点自身异常，而不必再靠猜。
    print(
        f"[anima/image] 502 后重试 {_IMAGE_MAX_ATTEMPTS} 次仍失败 | reason={last_reason} | "
        f"url={url}",
        flush=True,
    )
    return web.Response(status=502, text=f"{last_reason}")


async def proxy_civitai(request):
    return await _proxy("https://civitai.com/api/v1/" + request.match_info["path"], request)


async def proxy_danbooru(request):
    return await _proxy("https://danbooru.donmai.us/" + request.match_info["path"], request)


def register_routes(routes):
    routes.get('/anima/image')(anima_image)
    routes.get('/api/civitai/{path:.+}')(proxy_civitai)
    routes.get('/api/danbooru/{path:.+}')(proxy_danbooru)
