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
    BRIDGE_DATA, BRIDGE_LOCK, _find_lora_path,
)

WEB_DIRECTORY = "./web"

__version__ = "2.0.0"  # 与仓库根 VERSION 文件保持一致，发布更新时同步递增

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(PLUGIN_DIR, "app")
INDEX_HTML = None
_INDEX_MTIME = 0

# ── Reusable aiohttp client session (connection pool) ──
_PROXY_SESSION: aiohttp.ClientSession | None = None
_PROXY_CACHE: dict = {}
_CACHE_TTL = 60

def _cache_key(url, qs):
    return hashlib.md5(f"{url}?{qs}".encode()).hexdigest()

async def _get_session():
    global _PROXY_SESSION
    if _PROXY_SESSION is None or _PROXY_SESSION.closed:
        _PROXY_SESSION = aiohttp.ClientSession(
            # 用浏览器 UA：CivItai/Cloudflare 对非浏览器 UA 的下载请求会返回 401
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"},
            timeout=aiohttp.ClientTimeout(total=30),
            # 尊重 HTTP_PROXY/HTTPS_PROXY 环境变量（Civitai 需走代理）
            trust_env=True,
        )
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
            return web.Response(body=body, status=resp.status, headers=headers)
    except asyncio.TimeoutError:
        return web.json_response({"error": "proxy timeout"}, status=504)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


# ── LoRA info cache (SHA256 → Civitai data, 5 min TTL) ──
_LORA_INFO_CACHE: dict[str, tuple[float, dict]] = {}
_LORA_INFO_TTL = 300


def _sha256_file(filepath: str) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


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
    return web.json_response(result)


# 下载进度：progressId -> {done, total, status, filename}（供前端进度条轮询）
_DOWNLOAD_PROGRESS: dict = {}
_DOWNLOAD_PROGRESS_LOCK = threading.Lock()

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

    if progress_id:
        with _DOWNLOAD_PROGRESS_LOCK:
            _DOWNLOAD_PROGRESS[progress_id] = {"done": 0, "total": 0, "status": "downloading", "filename": ""}

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
    """Receive bridge data from the frontend via POST."""
    try:
        data = await request.json()
        data["_receivedAt"] = time.time()
        with BRIDGE_LOCK:
            BRIDGE_DATA.clear()
            BRIDGE_DATA.update(data)
        return web.json_response({"ok": True, "receivedAt": data["_receivedAt"]})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)


@PromptServer.instance.routes.delete("/anima/bridge/update")
async def bridge_clear(request):
    """Clear the in-memory bridge data."""
    with BRIDGE_LOCK:
        BRIDGE_DATA.clear()
    return web.json_response({"ok": True})


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
    filepath = os.path.normpath(os.path.join(APP_DIR, path))
    if not filepath.startswith(os.path.normpath(APP_DIR)):
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


@PromptServer.instance.routes.get("/api/translate")
async def proxy_translate(request):
    return await _proxy("https://api.mymemory.translated.net/get", request)


# ─── LoRA metadata persistence (categories / favorite / pinned) ───

META_PATH = os.path.join(PLUGIN_DIR, "anima_meta.json")
META_LOCK = threading.Lock()


def _load_meta() -> dict:
    with META_LOCK:
        try:
            if os.path.exists(META_PATH):
                with open(META_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
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
    """Persist LoRA metadata (categories / favorite / pinned)."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("body must be an object")
        meta = {
            "categories": list(body.get("categories", []) or []),
            "loraMeta": body.get("loraMeta", {}) or {},
            "loraGroups": body.get("loraGroups", []) or [],
        }
        _save_meta(meta)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
