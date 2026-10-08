"""Built panel assets and clothing index HTTP adapters."""
import os
import re
import asyncio
from aiohttp import web
PLUGIN_DIR = os.path.dirname(os.path.dirname(__file__))
APP_DIR = os.path.join(PLUGIN_DIR, "app")


INDEX_HTML = None


_INDEX_MTIME = 0


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
    if os.path.relpath(filepath, APP_DIR).replace("\\", "/").startswith("assets/") and re.search(r"-[A-Za-z0-9_-]{8}\.(?:js|css|png|jpg|svg|ico)$", os.path.basename(filepath)) and ext in (".js", ".css", ".png", ".jpg", ".svg", ".ico"):
        cache = "public, max-age=31536000, immutable"
    else:
        cache = "no-cache"

    return web.Response(
        body=body,
        content_type=mime.get(ext, "application/octet-stream"),
        headers={"Cache-Control": cache},
    )


def configure(plugin_dir):
    global PLUGIN_DIR, APP_DIR, INDEX_HTML, _INDEX_MTIME
    PLUGIN_DIR = os.path.abspath(plugin_dir)
    APP_DIR = os.path.join(PLUGIN_DIR, "app")
    INDEX_HTML, _INDEX_MTIME = None, 0


def register_routes(routes):
    routes.post('/anima/clothing/index')(clothing_index_save)
    routes.get('/extensions/ComfyUI-Anima-Batch-LoRA/app/')(serve_index)
    routes.get('/extensions/ComfyUI-Anima-Batch-LoRA/app/{path:.+}')(serve_asset)
