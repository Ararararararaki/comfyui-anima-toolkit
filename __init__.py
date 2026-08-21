# ComfyUI-Anima-Batch-LoRA
# Batch LoRA loader node + embedded Anima web app.
# App available at: /extensions/ComfyUI-Anima-Batch-LoRA/app/

import os
import re
import time
import json
import hashlib
import threading
import aiohttp
import asyncio
import folder_paths
from aiohttp import web
from server import PromptServer

from .anima_batch_lora import (
    NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS,
    BRIDGE_DATA, BRIDGE_LOCK, BRIDGE_PATH, _find_lora_path,
)
from .anima_trigger_words import (
    NODE_CLASS_MAPPINGS as TW_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as TW_NODE_DISPLAY_NAME_MAPPINGS,
)
from .anima_camera_control import (
    NODE_CLASS_MAPPINGS as CAM_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as CAM_NODE_DISPLAY_NAME_MAPPINGS,
)
from .anima_prompt_batch import (
    NODE_CLASS_MAPPINGS as BATCH_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as BATCH_NODE_DISPLAY_NAME_MAPPINGS,
)
from .anima_text_join import (
    NODE_CLASS_MAPPINGS as JOIN_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as JOIN_NODE_DISPLAY_NAME_MAPPINGS,
)
from .anima_preset_latent import (
    NODE_CLASS_MAPPINGS as PRESET_LATENT_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as PRESET_LATENT_NODE_DISPLAY_NAME_MAPPINGS,
)
from .anima_danbooru_gallery import (
    NODE_CLASS_MAPPINGS as DANBOORU_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as DANBOORU_NODE_DISPLAY_NAME_MAPPINGS,
)
from .anima_image_select import (
    NODE_CLASS_MAPPINGS as SELECT_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as SELECT_NODE_DISPLAY_NAME_MAPPINGS,
)
from .anima_prompt_cards import (
    NODE_CLASS_MAPPINGS as CARDS_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as CARDS_NODE_DISPLAY_NAME_MAPPINGS,
)

# 合并所有节点的注册表（ComfyUI 通过 __init__.py 顶层这两个变量发现所有节点）
NODE_CLASS_MAPPINGS = {
    **NODE_CLASS_MAPPINGS,
    **TW_NODE_CLASS_MAPPINGS,
    **CAM_NODE_CLASS_MAPPINGS,
    **BATCH_NODE_CLASS_MAPPINGS,
    **JOIN_NODE_CLASS_MAPPINGS,
    **PRESET_LATENT_NODE_CLASS_MAPPINGS,
    **DANBOORU_NODE_CLASS_MAPPINGS,
    **SELECT_NODE_CLASS_MAPPINGS,
    **CARDS_NODE_CLASS_MAPPINGS,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    **NODE_DISPLAY_NAME_MAPPINGS,
    **TW_NODE_DISPLAY_NAME_MAPPINGS,
    **CAM_NODE_DISPLAY_NAME_MAPPINGS,
    **BATCH_NODE_DISPLAY_NAME_MAPPINGS,
    **JOIN_NODE_DISPLAY_NAME_MAPPINGS,
    **PRESET_LATENT_NODE_DISPLAY_NAME_MAPPINGS,
    **DANBOORU_NODE_DISPLAY_NAME_MAPPINGS,
    **SELECT_NODE_DISPLAY_NAME_MAPPINGS,
    **CARDS_NODE_DISPLAY_NAME_MAPPINGS,
}

WEB_DIRECTORY = "./web"

__version__ = "2.3.0"  # 与仓库根 VERSION 文件保持一致，发布更新时同步递增

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(PLUGIN_DIR, "app")
INDEX_HTML = None
_INDEX_MTIME = 0

# ── Reusable aiohttp client session (connection pool) ──
_PROXY_SESSION: aiohttp.ClientSession | None = None
_PROXY_CACHE: dict = {}
_CACHE_TTL = 60
# Civitai 被墙需走代理：优先 ANIMA_PROXY 环境变量，否则自动探测本机 Clash/V2ray 常见端口
_PROXY_OVERRIDE: str | None = None
# 探测结果带 TTL：成功缓存 60s，失败仅 10s——用户中途开/关代理后，图片与查询 ≤10s 自动恢复/切换，无需重启 ComfyUI
_PROXY_OVERRIDE_AT: float = 0.0
_PROXY_OVERRIDE_TTL_OK = 60
_PROXY_OVERRIDE_TTL_FAIL = 10

def _cache_key(url, qs):
    return hashlib.md5(f"{url}?{qs}".encode()).hexdigest()


def _cleanup_cache(cache: dict, ttl: float):
    """清理过期缓存项，防止长期运行内存持续增长。"""
    now = time.time()
    expired = [k for k, v in cache.items() if v[0] < now]
    for k in expired:
        cache.pop(k, None)

def _detect_proxy():
    """探测本地代理端口（Clash 7890 / 7897 / V2ray 10809）是否可用，返回地址或 None"""
    import socket
    candidates = [
        os.environ.get("ANIMA_PROXY"),
        "http://127.0.0.1:7890",
        "http://127.0.0.1:7897",
        "http://127.0.0.1:10809",
    ]
    for addr in candidates:
        if not addr:
            continue
        m = re.match(r"https?://([^:/]+):(\d+)", addr)
        if not m:
            continue
        host, port = m.group(1), int(m.group(2))
        try:
            s = socket.create_connection((host, port), timeout=0.8)
            s.close()
            return addr
        except Exception:
            continue
    return None

_PROXY_LOCK: asyncio.Lock | None = None


async def _refresh_proxy_override():
    """重新探测代理并更新 TTL（成功缓存 60s，失败仅 10s——用户中途开/关代理后自动恢复）"""
    global _PROXY_OVERRIDE, _PROXY_OVERRIDE_AT
    now = time.time()
    # 同步 socket 探测放线程池执行,避免阻塞 ComfyUI 事件循环(3 端口最坏 ~2.4s)
    _PROXY_OVERRIDE = await asyncio.get_running_loop().run_in_executor(None, _detect_proxy)
    _PROXY_OVERRIDE_AT = now + (_PROXY_OVERRIDE_TTL_OK if _PROXY_OVERRIDE else _PROXY_OVERRIDE_TTL_FAIL)


async def _create_proxy_session():
    """创建可复用的 aiohttp 会话（探测结果带 TTL）"""
    if _PROXY_OVERRIDE is None or time.time() > _PROXY_OVERRIDE_AT:
        await _refresh_proxy_override()
    kwargs = dict(
        # 用浏览器 UA：CivItai/Cloudflare 对非浏览器 UA 的下载请求会返回 401
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"},
        timeout=aiohttp.ClientTimeout(total=30),
        # 尊重 HTTP_PROXY/HTTPS_PROXY 环境变量
        trust_env=True,
    )
    if _PROXY_OVERRIDE:
        kwargs["proxy"] = _PROXY_OVERRIDE
    return aiohttp.ClientSession(**kwargs)


# 延迟关闭任务引用集：防止 create_task 未被持有而提前 GC（"Task was destroyed but pending" 警告）
_PENDING_CLOSE: set = set()


async def _safe_close(session):
    """关闭旧会话。经 create_task 调度：不阻塞 _get_session 锁内路径；
    注意 aiohttp close() 会立即关闭旧会话全部连接（代理切换瞬间若恰有持旧引用的慢请求仍可能 502，
    低频且 10-60s 内自愈）；异常不向上抛。"""
    try:
        await session.close()
    except Exception:
        pass
    finally:
        _PENDING_CLOSE.discard(asyncio.current_task())


async def _get_session():
    """返回可复用会话；探测结果过期时串行化重建（锁防并发竞态），探测无变化则复用 keep-alive"""
    global _PROXY_SESSION, _PROXY_LOCK
    if _PROXY_LOCK is None:
        _PROXY_LOCK = asyncio.Lock()
    async with _PROXY_LOCK:
        if _PROXY_SESSION is None or _PROXY_SESSION.closed:
            _PROXY_SESSION = await _create_proxy_session()
        elif time.time() > _PROXY_OVERRIDE_AT:
            prev = _PROXY_OVERRIDE
            await _refresh_proxy_override()
            if _PROXY_OVERRIDE != prev:
                # 代理状态变化（开/关/换端口）→ 先替换全局引用，再延迟关闭旧会话：
                # 消除竞态重建与旧会话泄漏；in-flight 502 风险降低（切换瞬间持旧引用的慢请求仍可能偶发，低频自愈）
                old = _PROXY_SESSION
                _PROXY_SESSION = await _create_proxy_session()
                if old is not None and not old.closed:
                    t = asyncio.get_running_loop().create_task(_safe_close(old))
                    _PENDING_CLOSE.add(t)
        return _PROXY_SESSION


async def _load_index():
    global INDEX_HTML
    path = os.path.join(APP_DIR, "index.html")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            INDEX_HTML = f.read()


async def _proxy(url, request):
    qs = request.query_string
    full = url + ("?" + qs if qs else "")
    skip = request.method == "GET" and qs.startswith("page=")
    ck = _cache_key(url, qs) if request.method == "GET" and not skip else None
    if ck:
        cached = _PROXY_CACHE.get(ck)
        if cached and cached[0] > time.time():
            return web.Response(body=cached[3], status=cached[1], headers=cached[2])
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


# ── LoRA info cache (SHA256 → Civitai data, 5 min TTL) ──
_LORA_INFO_CACHE: dict[str, tuple[float, dict]] = {}
_LORA_INFO_TTL = 300

# 文件 SHA256 缓存：path -> (mtime, size, sha256)。LoRA 文件不变时避免重复全文件哈希
# （大文件哈希很慢，重复查询 /anima/lora/info 会反复阻塞线程池）。
_SHA256_CACHE: dict[str, tuple[float, int, str]] = {}


def _sha256_file(filepath: str) -> str:
    # 命中缓存（mtime + size 均未变）则直接返回
    try:
        st = os.stat(filepath)
        key = os.path.normcase(os.path.abspath(filepath))
        cached = _SHA256_CACHE.get(key)
        if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
            return cached[2]
    except OSError:
        pass
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    digest = h.hexdigest()
    try:
        st = os.stat(filepath)
        _SHA256_CACHE[os.path.normcase(os.path.abspath(filepath))] = (st.st_mtime, st.st_size, digest)
    except OSError:
        pass
    return digest


def _creator_name(model: dict) -> str:
    """Extract creator username from a Civitai model object (may be str or dict)."""
    if not isinstance(model, dict):
        return ""
    c = model.get("creator")
    if isinstance(c, dict):
        return c.get("username") or ""
    return c or ""


# ── Civitai 图片代理 ──
# 浏览器（无代理）无法直连 image.civitai.com；改由后端 session（trust_env 走代理）下载后转发。
_IMAGE_CACHE: dict[str, tuple[bytes, str]] = {}
_IMAGE_CACHE_MAX = 200
_IMAGE_ALLOW_PREFIX = "https://image.civitai.com/"
_IMAGE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://civitai.com/",
}


@PromptServer.instance.routes.get("/anima/image")
async def anima_image(request):
    """Proxy Civitai preview images (browser cannot reach image.civitai.com without proxy)."""
    url = request.query.get("url", "").strip()
    if not url.startswith(_IMAGE_ALLOW_PREFIX):
        return web.Response(status=403, text="forbidden: only image.civitai.com allowed")

    cached = _IMAGE_CACHE.get(url)
    if cached is not None:
        body, ctype = cached
        return web.Response(body=body, content_type=ctype, headers={"Cache-Control": "public, max-age=86400"})

    try:
        session = await _get_session()
        async with session.get(url, headers=_IMAGE_HEADERS) as resp:
            if resp.status != 200:
                return web.Response(status=502, text=f"upstream http_{resp.status}")
            body = await resp.read()
            ctype = resp.headers.get("Content-Type", "image/jpeg")
    except Exception as e:
        return web.Response(status=502, text=f"proxy error: {e}")

    if len(_IMAGE_CACHE) >= _IMAGE_CACHE_MAX:
        _IMAGE_CACHE.pop(next(iter(_IMAGE_CACHE)))
    _IMAGE_CACHE[url] = (body, ctype)
    return web.Response(body=body, content_type=ctype, headers={"Cache-Control": "public, max-age=86400"})


@PromptServer.instance.routes.get("/anima/lora/info")
async def lora_info(request):
    """Get LoRA info from Civitai by file name (cached 5 min)."""
    name = request.query.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)

    # Check cache
    now = time.time()
    cached = _LORA_INFO_CACHE.get(name)
    if cached and cached[0] > now:
        return web.json_response(cached[1])

    # Find file
    lora_path = _find_lora_path(name)
    if lora_path is None:
        return web.json_response({"name": name, "trainedWords": [], "modelName": None, "previewUrl": None, "source": "not_found"})

    # Compute SHA256 (run in thread pool so large files don't block the event loop)
    try:
        loop = asyncio.get_event_loop()
        sha256 = await loop.run_in_executor(None, _sha256_file, lora_path)
    except Exception as e:
        return web.json_response({"error": f"SHA256 failed: {e}"}, status=500)

    # Query Civitai API
    try:
        session = await _get_session()
        url = f"https://civitai.com/api/v1/model-versions/by-hash/{sha256}"
        async with session.get(url) as resp:
            if resp.status == 200:
                data = await resp.json()
                result = {
                    "name": name,
                    "trainedWords": data.get("trainedWords", []) or [],
                    "modelName": data.get("model", {}).get("name") or data.get("modelName") or "",
                    "versionName": data.get("name") or "",
                    "creator": _creator_name(data.get("model", {})),
                    "modelId": (data.get("model", {}) or {}).get("id") or data.get("modelId"),
                    "previewUrl": (data.get("images") or [{}])[0].get("url") if data.get("images") else None,
                    "source": "civitai",
                }
            elif resp.status == 404:
                result = {"name": name, "trainedWords": [], "modelName": None, "previewUrl": None, "source": "not_on_civitai"}
            else:
                result = {"name": name, "trainedWords": [], "modelName": None, "previewUrl": None, "source": f"http_{resp.status}"}
    except Exception as e:
        result = {"name": name, "trainedWords": [], "modelName": None, "previewUrl": None, "source": f"error_{e}"}

    _LORA_INFO_CACHE[name] = (now + _LORA_INFO_TTL, result)
    _cleanup_cache(_LORA_INFO_CACHE, _LORA_INFO_TTL)
    return web.json_response(result)


# 下载进度：progressId -> {done, total, status, filename}（供前端进度条轮询）
_DOWNLOAD_PROGRESS: dict = {}
_DOWNLOAD_PROGRESS_LOCK = threading.Lock()


def _cleanup_progress(max_age: float = 600):
    """清理超过 max_age 秒未更新的下载进度记录，防止长期运行内存增长。"""
    now = time.time()
    with _DOWNLOAD_PROGRESS_LOCK:
        expired = [k for k, v in _DOWNLOAD_PROGRESS.items() if now - v.get("ts", now) > max_age]
        for k in expired:
            _DOWNLOAD_PROGRESS.pop(k, None)

@PromptServer.instance.routes.get("/anima/lora/download")
async def lora_download(request):
    """Download a Civitai LoRA by modelVersion id into the local loras folder.

    Civitai download endpoint (/api/download/models/{id}) returns a 307 redirect;
    aiohttp 默认不跟随重定向，需显式 allow_redirects=True（session 走系统代理）。
    """
    version_id = request.query.get("versionId", "").strip()
    model_id = request.query.get("modelId", "").strip()
    fallback_name = request.query.get("name", "").strip()
    progress_id = request.query.get("progressId", "").strip()
    cookie = request.query.get("cookie", "").strip()
    token = request.query.get("token", "").strip()  # C 站 API Key（设置页生成），比 cookie 持久省事

    _cleanup_progress()

    if progress_id:
        with _DOWNLOAD_PROGRESS_LOCK:
            _DOWNLOAD_PROGRESS[progress_id] = {"done": 0, "total": 0, "status": "downloading", "filename": "", "ts": time.time()}

    # 只有 modelId 时：查 C 站模型详情，取默认（第一个）版本的 id
    if not version_id and model_id:
        try:
            session = await _get_session()
            u = f"https://civitai.com/api/v1/models/{model_id}"
            async with session.get(u) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    versions = data.get("modelVersions") or []
                    if versions:
                        version_id = str(versions[0].get("id") or "")
        except Exception:
            version_id = ""

    if not version_id:
        return web.json_response({"ok": False, "error": "versionId or modelId required"}, status=400)

    # 查 model-version 详情拿正确文件名（files[0].name，如 qingxiao_v1.safetensors）
    # 重定向响应的 Content-Disposition 常缺失/格式不同，导致下载名变成 lora.safetensors
    api_filename = ""
    try:
        session = await _get_session()
        u = f"https://civitai.com/api/v1/model-versions/{version_id}"
        async with session.get(u) as resp:
            if resp.status == 200:
                d = await resp.json()
                files = d.get("files") or []
                if files:
                    fn = str(files[0].get("name") or "")
                    if fn and fn.lower().endswith((".safetensors", ".pt", ".bin")):
                        api_filename = fn
    except Exception:
        api_filename = ""

    lora_dirs = folder_paths.get_folder_paths("loras")
    if not lora_dirs:
        return web.json_response({"ok": False, "error": "loras folder not found"}, status=500)
    lora_dir = lora_dirs[0]
    os.makedirs(lora_dir, exist_ok=True)

    try:
        session = await _get_session()
        url = f"https://civitai.com/api/download/models/{version_id}"
        hdrs = {}
        if cookie:
            # 容错：用户可能只填了 __Secure-civ-token 的值（JWT 长串，不含 =）
            if "=" not in cookie and not cookie.lower().startswith("__secure-"):
                hdrs["Cookie"] = "__Secure-civ-token=" + cookie
            else:
                hdrs["Cookie"] = cookie
        params = {}
        if token:
            params["token"] = token  # C 站下载接口认 ?token=<api-key>
        async with session.get(url, allow_redirects=True, headers=hdrs, params=params) as resp:
            # 检测重定向到 C 站登录页（需登录的模型，未带有效 Cookie 时）
            if "auth.civitai.com/login" in str(resp.url):
                return web.json_response({"ok": False, "error": "该模型需登录 C 站才能下载：请在下载弹窗的 Cookie 栏填写浏览器里 civitai.com 的 Cookie 后重试，或在浏览器手动下载", "needLogin": True}, status=502)
            if resp.status != 200:
                if resp.status in (401, 403):
                    return web.json_response({"ok": False, "error": "该模型需登录 C 站才能下载（HTTP 401/403）：请在下载弹窗填 Cookie 或浏览器手动下载", "needLogin": True}, status=502)
                return web.json_response({"ok": False, "error": f"download http_{resp.status}"}, status=502)

            # 文件名：C 站 API 的 files[0].name 优先，其次 Content-Disposition，最后 fallback
            target = None
            filename = api_filename or fallback_name
            if not api_filename:
                cd = resp.headers.get("Content-Disposition", "")
                m = __import__("re").search(r'filename="?([^";]+)"?', cd) if "filename=" in cd else None
                if m and m.group(1):
                    filename = m.group(1)
            filename = os.path.basename(filename or "lora.safetensors")
            if not os.path.splitext(filename)[1]:
                filename += ".safetensors"
            target = os.path.join(lora_dir, filename)

            total = int(resp.headers.get("Content-Length", 0) or 0)
            done = 0
            cancelled = False
            with open(target, "wb") as f:
                async for chunk in resp.content.iter_chunked(64 * 1024):
                    # 支持取消：下载中前端调 cancel 端点，置 cancel 标记
                    if progress_id and _DOWNLOAD_PROGRESS.get(progress_id, {}).get("cancel"):
                        cancelled = True
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if progress_id and total:
                        with _DOWNLOAD_PROGRESS_LOCK:
                            _DOWNLOAD_PROGRESS[progress_id]["done"] = done
                            _DOWNLOAD_PROGRESS[progress_id]["total"] = total

            if cancelled:
                # 取消：删除部分下载的文件
                try:
                    os.remove(target)
                except Exception:
                    pass
                return web.json_response({"ok": False, "error": "已取消", "cancelled": True})

            if progress_id:
                with _DOWNLOAD_PROGRESS_LOCK:
                    _DOWNLOAD_PROGRESS[progress_id]["status"] = "done"
                    _DOWNLOAD_PROGRESS[progress_id]["filename"] = filename

            return web.json_response({"ok": True, "filename": filename, "path": target})
    except Exception as e:
        # 异常中断：删除残留的半截文件，避免出现在 /anima/loras 列表中被误用
        if target and os.path.exists(target):
            try:
                os.remove(target)
            except Exception:
                pass
        if progress_id:
            with _DOWNLOAD_PROGRESS_LOCK:
                _DOWNLOAD_PROGRESS[progress_id]["status"] = "error"
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@PromptServer.instance.routes.get("/anima/lora/download/status")
async def download_status(request):
    pid = request.query.get("progressId", "").strip()
    with _DOWNLOAD_PROGRESS_LOCK:
        p = dict(_DOWNLOAD_PROGRESS.get(pid, {}))
    if not p:
        return web.json_response({"status": "not_found"})
    return web.json_response(p)


@PromptServer.instance.routes.get("/anima/lora/download/cancel")
async def download_cancel(request):
    pid = request.query.get("progressId", "").strip()
    with _DOWNLOAD_PROGRESS_LOCK:
        if pid in _DOWNLOAD_PROGRESS:
            _DOWNLOAD_PROGRESS[pid]["cancel"] = True
            _DOWNLOAD_PROGRESS[pid]["status"] = "cancelled"
    return web.json_response({"ok": True})


def _version_tuple(v: str) -> tuple:
    nums = [int(x) for x in re.split(r"[^0-9]+", v) if x.isdigit()][:3]
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


@PromptServer.instance.routes.get("/anima/version")
async def anima_version(request):
    """Compare local plugin version against GitHub VERSION file."""
    latest = ""
    try:
        session = await _get_session()
        url = "https://raw.githubusercontent.com/Ararararararaki/comfyui-anima-toolkit/main/VERSION"
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
            if resp.status == 200:
                latest = (await resp.text()).strip()
    except Exception:
        latest = ""

    behind = False
    if latest:
        try:
            behind = _version_tuple(__version__) < _version_tuple(latest)
        except Exception:
            behind = False

    return web.json_response({
        "version": __version__,
        "latest": latest or None,
        "behind": behind,
        "url": "https://github.com/Ararararararaki/comfyui-anima-toolkit",
    })


# ── Bridge HTTP API (replaces file-based bridge) ──

@PromptServer.instance.routes.post("/anima/bridge/update")
async def bridge_update(request):
    """Receive bridge data from the frontend via POST.

    同时持久化到 anima_bridge.json：面板「发送到 ComfyUI」后，
    即使 ComfyUI 重启，节点 load_loras 也能从文件兜底读取列表，
    不再因内存 BRIDGE_DATA 丢失而丢 LoRA 组合。
    """
    try:
        data = await request.json()
        data["_receivedAt"] = time.time()
        with BRIDGE_LOCK:
            BRIDGE_DATA.clear()
            BRIDGE_DATA.update(data)
        # 落盘（失败不阻断内存桥接，仅告警）
        try:
            with open(BRIDGE_PATH, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
        except Exception as e:
            print(f"[Anima] bridge 持久化失败（不影响内存桥接）: {e}")
        return web.json_response({"ok": True, "receivedAt": data["_receivedAt"]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)


@PromptServer.instance.routes.delete("/anima/bridge/update")
async def bridge_clear(request):
    """Clear the in-memory bridge data (and its persisted file so it stays cleared after restart)."""
    with BRIDGE_LOCK:
        BRIDGE_DATA.clear()
        # 同步删除持久化文件，否则重启后文件兜底会恢复旧数据（“清除”语义失效）
        try:
            if os.path.exists(BRIDGE_PATH):
                os.remove(BRIDGE_PATH)
        except Exception as e:
            print(f"[Anima] bridge 持久化文件删除失败: {e}")
    return web.json_response({"ok": True})


# ── 服装库 AI 索引同步（面板数据变更后自动调用；anima-prompt skill 直接读此文件）──

@PromptServer.instance.routes.post("/anima/clothing/index")
async def clothing_index_save(request):
    """写入服装库索引文本 → <插件目录>/data/clothing-index.txt（AI skill 引用路径）。
    body: {"text": "..."}；超限/坏 JSON 拒绝，不影响面板主流程。
    """
    try:
        payload = await request.json()
        text = str(payload.get("text") or "")
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    if len(text) > 2 * 1024 * 1024:
        return web.json_response({"ok": False, "error": "too large"}, status=413)
    try:
        data_dir = os.path.join(PLUGIN_DIR, "data")
        os.makedirs(data_dir, exist_ok=True)
        with open(os.path.join(data_dir, "clothing-index.txt"), "w", encoding="utf-8") as f:
            f.write(text)
    except OSError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)
    return web.json_response({"ok": True, "bytes": len(text)})


# ── Serve the built web app ───

@PromptServer.instance.routes.get("/extensions/ComfyUI-Anima-Batch-LoRA/app/")
async def serve_index(request):
    global INDEX_HTML, _INDEX_MTIME
    path = os.path.join(APP_DIR, "index.html")
    mtime = os.path.getmtime(path) if os.path.exists(path) else 0
    # 检测文件变化自动重载，避免修改 app/ 后需重启 ComfyUI
    if INDEX_HTML is None or mtime != _INDEX_MTIME:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                INDEX_HTML = f.read()
            _INDEX_MTIME = mtime
    if INDEX_HTML is None:
        return web.Response(
            text="App not built yet. Run: cd anima-lora-explorer && npm run build:comfyui",
            content_type="text/plain", status=404,
        )
    return web.Response(
        text=INDEX_HTML, content_type="text/html",
        headers={"Cache-Control": "no-cache"},  # revalidate on reload
    )


@PromptServer.instance.routes.get("/extensions/ComfyUI-Anima-Batch-LoRA/app/{path:.+}")
async def serve_asset(request):
    path = request.match_info["path"]
    base = os.path.normpath(APP_DIR)
    filepath = os.path.normpath(os.path.join(APP_DIR, path))
    # commonpath 严格比较，防 app2/ 等同前缀兄弟目录绕过（startswith 前缀检查有缺陷）
    if os.path.commonpath([base, filepath]) != base:
        return web.Response(status=403)
    if not os.path.isfile(filepath):
        return web.Response(status=404)
    ext = os.path.splitext(filepath)[1]
    mime = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".json": "application/json",
        ".ico": "image/x-icon",
        ".svg": "image/svg+xml",
    }
    # Asynchronous file read to avoid blocking the event loop
    try:
        loop = asyncio.get_event_loop()
        with open(filepath, "rb") as f:
            body = await loop.run_in_executor(None, f.read)
    except OSError:
        return web.Response(status=404)

    # Cache control: JS/CSS assets get long TTL, HTML/no-ext gets no-cache
    if ext in (".js", ".css", ".png", ".jpg", ".svg", ".ico"):
        cache = "public, max-age=31536000, immutable"
    else:
        cache = "no-cache"

    return web.Response(
        body=body,
        content_type=mime.get(ext, "application/octet-stream"),
        headers={"Cache-Control": cache},
    )


# ─── API Proxy (same paths as Vite dev proxy, so frontend code works unmodified) ───

@PromptServer.instance.routes.get("/api/civitai/{path:.+}")
async def proxy_civitai(request):
    return await _proxy("https://civitai.com/api/v1/" + request.match_info["path"], request)


@PromptServer.instance.routes.get("/api/danbooru/{path:.+}")
async def proxy_danbooru(request):
    return await _proxy("https://danbooru.donmai.us/" + request.match_info["path"], request)


# ─── 翻译（多源：本地词典 / DeepLX / MyMemory / Google / DashScope 通义）───
# 面板「图片解析」的翻译全部走这里：source=auto 时按顺序回退，任何单源失败都不影响整体。

_TRANSLATE_CACHE: dict = {}
_TRANSLATE_CACHE_TTL = 3600 * 24  # 翻译结果缓存 1 天（内容稳定，省配额）
_TRANSLATE_DICT: dict | None = None
_TRANSLATE_DICT_MTIME = 0.0
_TRANSLATE_ORDER = ("local", "deeplx", "mymemory", "google", "dashscope")


def _get_env(name: str) -> str | None:
    """读环境变量；进程启动早于 setx 时从用户级注册表兜底（Windows）。"""
    v = os.environ.get(name)
    if v:
        return v
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            v, _ = winreg.QueryValueEx(k, name)
        return str(v) if v else None
    except Exception:
        return None


def _load_translate_dict() -> dict:
    """本地 Danbooru 标签中文字典（data/danbooru_tags_zh.json，mtime 指纹热重载）。"""
    global _TRANSLATE_DICT, _TRANSLATE_DICT_MTIME
    if _TRANSLATE_DICT is not None:
        return _TRANSLATE_DICT
    for p in (
        os.path.join(PLUGIN_DIR, "data", "danbooru_tags_zh.json"),
        os.path.join(PLUGIN_DIR, "danbooru_tags_zh.json"),
    ):
        try:
            mtime = os.path.getmtime(p)
            if _TRANSLATE_DICT is not None and mtime == _TRANSLATE_DICT_MTIME:
                return _TRANSLATE_DICT
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            d = {str(k).strip().lower(): str(v) for k, v in data.items() if v}
            _TRANSLATE_DICT, _TRANSLATE_DICT_MTIME = d, mtime
            return d
        except OSError:
            continue
        except Exception as e:
            print(f"[Anima] 翻译词典加载失败 {p}: {e}")
            continue
    _TRANSLATE_DICT = {}
    return _TRANSLATE_DICT


def _deepl_langs(langpair: str) -> tuple[str, str]:
    """en|zh-CN → ("EN","ZH")；DeepLX/DeepL 用大写双字母码。"""
    src, _, dst = (langpair or "en|zh-CN").partition("|")
    m = {"en": "EN", "auto": "AUTO", "zh": "ZH", "zh-cn": "ZH", "zh-tw": "ZH",
         "ja": "JA", "ko": "KO", "fr": "FR", "de": "DE", "es": "ES", "ru": "RU"}
    return m.get(src.strip().lower(), src.strip().upper() or "AUTO"), \
        m.get(dst.strip().lower(), dst.strip().upper() or "ZH")


async def _translate_via(source: str, text: str, src_lang: str, dst_lang: str) -> str:
    """单源翻译；失败抛异常（自动链路靠异常切源）。"""
    if source == "local":
        hit = _load_translate_dict().get(text.strip().lower())
        if not hit:
            raise LookupError("本地词典未收录该词")
        return hit

    if source == "deeplx":
        sl, tl = _deepl_langs(f"{src_lang}|{dst_lang}")
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as s:
                async with s.post("http://127.0.0.1:1188/translate",
                                  json={"text": text[:2000], "source_lang": sl, "target_lang": tl}) as r:
                    body = await r.json()
        except Exception as e:
            raise RuntimeError(f"DeepLX 连接失败: {e}") from e
        if body.get("code") == 200 and body.get("data"):
            return str(body["data"])
        raise RuntimeError(f"DeepLX 返回 {body.get('code', '?')}")

    if source == "mymemory":
        import urllib.parse
        url = ("https://api.mymemory.translated.net/get?q="
               + urllib.parse.quote(text[:500])
               + "&langpair=" + urllib.parse.quote(f"{src_lang}|{dst_lang}"))
        session = await _get_session()
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as r:
            body = await r.json()
        if body.get("responseStatus") == 200 and body.get("responseData", {}).get("translatedText"):
            return str(body["responseData"]["translatedText"])
        raise RuntimeError(body.get("responseDetails") or f"MyMemory 状态 {body.get('responseStatus')}")

    if source == "google":
        import urllib.parse
        url = ("https://translate.googleapis.com/translate_a/single?client=gtx"
               f"&sl={src_lang}&tl={dst_lang}&dt=t&q=" + urllib.parse.quote(text[:2000]))
        session = await _get_session()
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as r:
            data = await r.json()
        parts = []
        if isinstance(data, list) and data and isinstance(data[0], list):
            for row in data[0]:
                if isinstance(row, list) and row and row[0]:
                    parts.append(str(row[0]))
        if parts:
            return "".join(parts)
        raise RuntimeError("Google 返回空")

    if source == "dashscope":
        key = _get_env("DASHSCOPE_API_KEY")
        if not key:
            raise RuntimeError("未配置 DASHSCOPE_API_KEY")
        base = (_get_env("DASHSCOPE_BASE_URL") or
                "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
        model = _get_env("DASHSCOPE_MODEL") or "qwen-turbo"
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content":
                 "你是翻译助手。把用户给出的英文图片标签/提示词翻译成简体中文，"
                 "保持原有结构（逗号分隔、括号、下划线等），只输出译文，不要解释。"},
                {"role": "user", "content": text[:4000]},
            ],
            "temperature": 0.1,
            "max_tokens": 2048,
        }
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as s:
                async with s.post(base + "/chat/completions", json=payload,
                                  headers={"Authorization": "Bearer " + key,
                                           "Content-Type": "application/json"}) as r:
                    body = await r.json()
        except Exception as e:
            raise RuntimeError(f"DashScope 连接失败: {e}") from e
        content = ((body.get("choices") or [{}])[0].get("message") or {}).get("content")
        if content:
            return str(content).strip()
        raise RuntimeError("DashScope 返回空")

    raise RuntimeError(f"未知翻译源: {source}")


@PromptServer.instance.routes.get("/api/translate")
async def proxy_translate(request):
    """多源翻译。参数：q 文本；langpair 如 en|zh-CN；source=auto|local|deeplx|mymemory|google|dashscope
    （缺省 auto=按序回退直到成功）；strict=1 时只用指定源不回退（调试用）。
    返回 {ok, translatedText, source, attempts}。"""
    q = (request.query.get("q") or "").strip()
    if not q:
        return web.json_response({"ok": False, "error": "缺少 q 参数"}, status=400)
    langpair = request.query.get("langpair") or "en|zh-CN"
    want = (request.query.get("source") or "auto").strip().lower() or "auto"
    strict = request.query.get("strict") == "1"
    if want != "auto" and want not in _TRANSLATE_ORDER:
        return web.json_response({"ok": False, "error": f"未知翻译源: {want}"}, status=400)
    src_lang, dst_lang = langpair.split("|", 1) if "|" in langpair else ("en", "zh-CN")
    order = (want,) if want != "auto" else _TRANSLATE_ORDER

    attempts: dict = {}
    for source in order:
        ck = f"{source}|{q}"
        cached = _TRANSLATE_CACHE.get(ck)
        if cached and cached[0] > time.time():
            return web.json_response({"ok": True, "translatedText": cached[1], "source": source,
                                      "fromCache": True, "attempts": attempts})
        try:
            out = await _translate_via(source, q, src_lang, dst_lang)
            if out and out.strip():
                _TRANSLATE_CACHE[ck] = (time.time() + _TRANSLATE_CACHE_TTL, out.strip())
                _cleanup_cache(_TRANSLATE_CACHE, _TRANSLATE_CACHE_TTL)
                return web.json_response({"ok": True, "translatedText": out.strip(), "source": source,
                                          "fromCache": False, "attempts": attempts})
        except Exception as e:
            attempts[source] = str(e)
            continue
    if strict:
        return web.json_response({"ok": False, "error": attempts.get(want, "翻译失败"),
                                  "attempts": attempts}, status=502)
    return web.json_response({"ok": False,
                              "error": "所有翻译源均失败: " + "; ".join(f"{k}: {v}" for k, v in attempts.items()),
                              "attempts": attempts}, status=502)


# ─── LoRA metadata persistence (categories / favorite / pinned) ───

META_PATH = os.path.join(PLUGIN_DIR, "anima_meta.json")
META_LOCK = threading.Lock()


def _normalize_meta_keys(data: dict):
    """把 loraMeta 中带扩展名的 key 合并到无扩展名（分类取并集），删除带扩展名条目。

    面板旧数据用完整文件名（sigrika_v1.safetensors），节点用去扩展名（sigrika_v1），
    两边 key 不一致导致分类互不可见。此函数读时归一化，幂等，下次保存时落盘清理。
    """
    lm = data.get("loraMeta")
    if not isinstance(lm, dict):
        return
    merged = {}

    def _merge(dst: dict, src: dict):
        for k, v in src.items():
            if k == "categories" and isinstance(v, list):
                cats = list(dst.get("categories", []) or [])
                for c in v:
                    if c not in cats:
                        cats.append(c)
                dst["categories"] = cats
            else:
                dst[k] = v

    for name, entry in lm.items():
        if not isinstance(entry, dict):
            continue
        base = _strip_model_ext(name)
        if base in merged:
            _merge(merged[base], entry)
        else:
            merged[base] = entry
    data["loraMeta"] = merged


def _strip_model_ext(name: str) -> str:
    """只去掉模型文件扩展名（避免把 chen-bin_v4.0 这类文件名误拆）"""
    low = name.lower()
    for ext in (".safetensors", ".pt", ".ckpt", ".pth", ".sft", ".bin"):
        if low.endswith(ext):
            return name[: -len(ext)]
    return name


def _load_meta() -> dict:
    with META_LOCK:
        try:
            if os.path.exists(META_PATH):
                with open(META_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        _normalize_meta_keys(data)
                        return data
        except Exception:
            pass
    return {"categories": [], "loraMeta": {}, "loraGroups": []}


def _save_meta(data: dict):
    with META_LOCK:
        with open(META_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


@PromptServer.instance.routes.get("/anima/meta")
async def get_meta(request):
    """Get LoRA metadata (categories / favorite / pinned)."""
    return web.json_response(_load_meta())


@PromptServer.instance.routes.post("/anima/meta")
async def set_meta(request):
    """Persist LoRA metadata (categories / favorite / pinned).

    合并式写入（面板与节点双向同步枢纽）：
    - categories：以 body 为准（面板/节点都维护全量列表，增删分类可靠）
    - loraMeta：按文件字段级合并——body 中文件的字段覆盖旧值，
      不在 body 中的后端文件保留；避免面板写 categories 时冲掉节点的
      favorite/pinned/count/disabled，反之亦然
    - loraGroups：body 有该键则用 body（节点可能清空组），否则保留旧值
    """
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("body must be an object")
        old = _load_meta()
        # categories：以 body 为准（全量列表）
        cats = list(body.get("categories", old.get("categories", []) or []))
        # loraMeta：按文件字段级合并
        old_meta = old.get("loraMeta", {}) or {}
        new_meta = {}
        for name, entry in (body.get("loraMeta", {}) or {}).items():
            if not isinstance(entry, dict):
                continue
            merged = dict(old_meta.get(name, {}) or {})
            merged.update(entry)
            new_meta[name] = merged
        # body 未涉及的后端文件记录保留原样
        for name, entry in old_meta.items():
            if name not in new_meta:
                new_meta[name] = entry
        # loraGroups：body 有键则用 body（允许清空），否则保留旧值
        old_groups = old.get("loraGroups", []) or []
        groups = body.get("loraGroups", old_groups) if "loraGroups" in body else old_groups
        meta = {
            "categories": cats,
            "loraMeta": new_meta,
            "loraGroups": groups,
        }
        _save_meta(meta)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
