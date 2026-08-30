# ComfyUI-Anima-Batch-LoRA
# Batch LoRA loader node + embedded Anima web app.
# App available at: /extensions/ComfyUI-Anima-Batch-LoRA/app/

import os
import re
import time
import json
import csv
import hashlib
import importlib.util
import socket
import subprocess
import sqlite3
import unicodedata
import threading
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
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
from .anima_string_router import (
    NODE_CLASS_MAPPINGS as STRING_ROUTER_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as STRING_ROUTER_NODE_DISPLAY_NAME_MAPPINGS,
)
from .anima_danbooru_tag_getter import (
    NODE_CLASS_MAPPINGS as DANBOORU_TAG_GETTER_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as DANBOORU_TAG_GETTER_NODE_DISPLAY_NAME_MAPPINGS,
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
from . import anima_local_llm  # 本地 LLM 翻译 provider（手动启用；load/unload/status 路由在模块内注册）

# 合并所有节点的注册表（ComfyUI 通过 __init__.py 顶层这两个变量发现所有节点）
NODE_CLASS_MAPPINGS = {
    **NODE_CLASS_MAPPINGS,
    **TW_NODE_CLASS_MAPPINGS,
    **CAM_NODE_CLASS_MAPPINGS,
    **BATCH_NODE_CLASS_MAPPINGS,
    **JOIN_NODE_CLASS_MAPPINGS,
    **STRING_ROUTER_NODE_CLASS_MAPPINGS,
    **DANBOORU_TAG_GETTER_NODE_CLASS_MAPPINGS,
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
    **STRING_ROUTER_NODE_DISPLAY_NAME_MAPPINGS,
    **DANBOORU_TAG_GETTER_NODE_DISPLAY_NAME_MAPPINGS,
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

_UPDATE_REPO = "Ararararararaki/comfyui-anima-toolkit"
_UPDATE_API_BASE = f"https://api.github.com/repos/{_UPDATE_REPO}"
_UPDATE_ARCHIVE_BASE = f"https://github.com/{_UPDATE_REPO}/archive"
_UPDATE_STATE_PATH = os.path.join(PLUGIN_DIR, "data", "update_state.json")
_UPDATE_CHECK_CACHE: dict = {"expires": 0.0, "value": None}
_UPDATE_CHECK_LOCK = asyncio.Lock()
_UPDATE_APPLY_LOCK = asyncio.Lock()
_UPDATE_EXCLUDED_DIRS = {".git", "data", "input", "outputs", "models", "panel", "tests", "node_modules", "dist", "dist-comfyui", "__pycache__"}

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
_DEEPLX_EXE = r"E:\1gongju\DeepLX\deeplx_windows_amd64.exe"
_DEEPLX_LOG = r"E:\1gongju\DeepLX\deeplx.log"
_DEEPLX_PID_FILE = os.path.join(PLUGIN_DIR, "data", "deeplx.pid")

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


class DeepLXManager:
    """DeepLX 本地进程的唯一管理者；只管理自己启动的进程。"""

    def __init__(self, exe: str, log_path: str, pid_file: str, port: int = 1188):
        self.exe = exe
        self.log_path = log_path
        self.pid_file = pid_file
        self.port = port
        self.process: subprocess.Popen | None = None
        self._start_lock: asyncio.Lock | None = None

    def _listening_sync(self) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=0.4):
                return True
        except OSError:
            return False

    def _existing_pids_sync(self) -> list[int]:
        """发现同名 DeepLX 进程，避免只依赖本实例的 Popen 引用。"""
        if os.name != "nt":
            return []
        image_name = os.path.basename(os.environ.get("DEEPLX_EXE") or self.exe)
        if not image_name:
            return []
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {image_name}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=2,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                check=False,
            )
            pids: list[int] = []
            for row in csv.reader(result.stdout.splitlines()):
                if len(row) < 2 or row[0].casefold() != image_name.casefold():
                    continue
                try:
                    pids.append(int(row[1]))
                except ValueError:
                    continue
            return pids
        except (OSError, subprocess.SubprocessError, ValueError):
            return []

    def _write_pid(self, pid: int | None) -> None:
        try:
            if pid is None:
                if os.path.isfile(self.pid_file):
                    os.unlink(self.pid_file)
                return
            os.makedirs(os.path.dirname(self.pid_file), exist_ok=True)
            with open(self.pid_file, "w", encoding="utf-8") as f:
                f.write(str(pid))
        except OSError:
            pass

    def _start_sync(self) -> bool:
        if self._listening_sync():
            return True
        exe = os.environ.get("DEEPLX_EXE", self.exe).strip()
        if not exe or not os.path.isfile(exe):
            return False
        if self.process is not None and self.process.poll() is None:
            return self._listening_sync()
        existing_pids = self._existing_pids_sync()
        if existing_pids:
            # 同名进程可能仍在启动；等待它接管 1188，绝不再起第二个实例。
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                if self._listening_sync():
                    return True
                time.sleep(0.2)
            return False
        args = [exe]
        proxy = os.environ.get("DEEPLX_PROXY", "").strip() or _detect_proxy()
        if proxy:
            args.extend(["-proxy", proxy])
        log_path = os.environ.get("DEEPLX_LOG", self.log_path).strip() or os.devnull
        try:
            log_dir = os.path.dirname(log_path)
            if log_dir:
                os.makedirs(log_dir, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as log_file:
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                self.process = subprocess.Popen(
                    args,
                    cwd=os.path.dirname(exe),
                    stdin=subprocess.DEVNULL,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    creationflags=flags,
                )
            self._write_pid(self.process.pid)
        except (OSError, ValueError):
            self.process = None
            return False
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if self._listening_sync():
                return True
            time.sleep(0.2)
        return False

    async def ensure_started(self) -> bool:
        if self._listening_sync():
            return True
        if self._start_lock is None:
            self._start_lock = asyncio.Lock()
        async with self._start_lock:
            if self._listening_sync():
                return True
            return await asyncio.get_running_loop().run_in_executor(None, self._start_sync)

    def status_sync(self) -> dict[str, object]:
        listening = self._listening_sync()
        managed_running = self.process is not None and self.process.poll() is None
        existing_pids = self._existing_pids_sync()
        process_running = managed_running or bool(existing_pids)
        return {
            "installed": bool(os.path.isfile(os.environ.get("DEEPLX_EXE") or self.exe)),
            "listening": listening,
            "process_running": process_running,
            "managed": managed_running,
            "pid": self.process.pid if managed_running else (existing_pids[0] if existing_pids else None),
            "port": self.port,
            "exe": os.environ.get("DEEPLX_EXE") or self.exe,
            "log": os.environ.get("DEEPLX_LOG") or self.log_path,
        }

    def _stop_managed_sync(self) -> bool:
        if self.process is None or self.process.poll() is not None:
            return False
        try:
            self.process.terminate()
            self.process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            try:
                self.process.kill()
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass
        finally:
            self.process = None
            self._write_pid(None)
        return True

    async def restart(self) -> dict[str, object]:
        if self._start_lock is None:
            self._start_lock = asyncio.Lock()
        async with self._start_lock:
            stopped = await asyncio.get_running_loop().run_in_executor(None, self._stop_managed_sync)
            started = await asyncio.get_running_loop().run_in_executor(None, self._start_sync)
            return {"stopped": stopped, "started": started, **self.status_sync()}


_DEEPLX_MANAGER = DeepLXManager(_DEEPLX_EXE, _DEEPLX_LOG, _DEEPLX_PID_FILE)


async def _ensure_deeplx_started() -> bool:
    return await _DEEPLX_MANAGER.ensure_started()


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


# 下载进度：progressId -> {done, total, status, filename, ...}（供前端进度条轮询）
_DOWNLOAD_PROGRESS: dict = {}
_DOWNLOAD_PROGRESS_LOCK = threading.Lock()
_DOWNLOAD_TASKS: dict[str, asyncio.Task] = {}
_DOWNLOAD_QUEUE_LOCK = asyncio.Lock()

# 下载目标只允许落到 ComfyUI 已注册的模型目录，避免 URL 下载变成任意路径写入。
_DOWNLOAD_TARGET_TYPES = (
    ("loras", "LoRA"),
    ("checkpoints", "Checkpoint"),
    ("vae", "VAE"),
    ("embeddings", "Embedding"),
    ("controlnet", "ControlNet"),
    ("clip", "Text Encoder"),
    ("clip_vision", "CLIP Vision"),
    ("upscale_models", "Upscale"),
    ("hypernetworks", "Hypernetwork"),
    ("style_models", "Style Model"),
)
_CIVITAI_TYPE_TO_FOLDER = {
    "checkpoint": "checkpoints",
    "lora": "loras",
    "lycoris": "loras",
    "textualinversion": "embeddings",
    "embedding": "embeddings",
    "hypernetwork": "hypernetworks",
    "aestheticgradient": "style_models",
    "controlnet": "controlnet",
    "upscaler": "upscale_models",
    "upscale": "upscale_models",
    "vae": "vae",
}


def _download_target_options() -> list[dict]:
    """Return safe download destinations from ComfyUI's registered model roots."""
    options = [{
        "key": "auto",
        "label": "自动（按 C 站模型类型）",
        "type": "auto",
        "index": None,
        "path": None,
    }]
    for folder_type, label in _DOWNLOAD_TARGET_TYPES:
        try:
            paths = folder_paths.get_folder_paths(folder_type) or []
        except Exception:
            paths = []
        for index, raw_path in enumerate(paths):
            path = os.path.normpath(str(raw_path or "")).strip()
            if not path:
                continue
            options.append({
                "key": f"{folder_type}:{index}",
                "label": f"{label} · {path}",
                "type": folder_type,
                "index": index,
                "path": path,
            })
    return options


def _resolve_download_target(target_key: str, model_type: str) -> tuple[str, str]:
    """Resolve an explicit registered folder or map a Civitai type in auto mode."""
    key = (target_key or "auto").strip() or "auto"
    if key == "auto":
        normalized_type = re.sub(r"[^a-z0-9]", "", str(model_type or "").lower())
        folder_type = _CIVITAI_TYPE_TO_FOLDER.get(normalized_type, "loras")
        key = folder_type
    if ":" in key:
        folder_type, raw_index = key.split(":", 1)
        try:
            index = int(raw_index)
        except ValueError as error:
            raise ValueError("下载目录选择无效") from error
    else:
        folder_type, index = key, 0
    allowed = {folder_type for folder_type, _ in _DOWNLOAD_TARGET_TYPES}
    if folder_type not in allowed or index < 0:
        raise ValueError("下载目录选择无效")
    try:
        paths = folder_paths.get_folder_paths(folder_type) or []
    except Exception as error:
        raise ValueError(f"无法读取 ComfyUI 目录：{folder_type}") from error
    if index >= len(paths) or not str(paths[index] or "").strip():
        raise ValueError("下载目录不存在或未在 ComfyUI 注册")
    return os.path.normpath(str(paths[index])), folder_type


def _cleanup_progress(max_age: float = 600):
    """清理已结束且超过 max_age 秒未更新的下载进度记录。"""
    now = time.time()
    with _DOWNLOAD_PROGRESS_LOCK:
        expired = [
            k for k, v in _DOWNLOAD_PROGRESS.items()
            if v.get("status") not in {"queued", "downloading"} and now - v.get("ts", now) > max_age
        ]
        for k in expired:
            _DOWNLOAD_PROGRESS.pop(k, None)

def _download_progress_update(progress_id: str, **fields):
    if not progress_id:
        return
    with _DOWNLOAD_PROGRESS_LOCK:
        item = _DOWNLOAD_PROGRESS.get(progress_id)
        if item is None:
            return
        item.update(fields)
        item["ts"] = time.time()


def _download_progress_cancelled(progress_id: str) -> bool:
    if not progress_id:
        return False
    with _DOWNLOAD_PROGRESS_LOCK:
        return bool(_DOWNLOAD_PROGRESS.get(progress_id, {}).get("cancel"))


class _LoraDownloadError(RuntimeError):
    """下载响应或断点校验失败；保留 HTTP 状态供上层生成可操作提示。"""

    def __init__(self, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


def _download_part_path(download_dir: str, version_id: str, fallback_name: str) -> str:
    key = version_id.strip() or hashlib.sha256(fallback_name.encode("utf-8", "ignore")).hexdigest()[:20]
    key = re.sub(r"[^A-Za-z0-9._-]+", "_", key)[:80] or "unknown"
    return os.path.join(download_dir, f".anima-download-{key}.part")


def _content_disposition_filename(value: str) -> str:
    match = re.search(r'filename="?([^";]+)"?', str(value or "")) if value else None
    return str(match.group(1)).strip() if match and match.group(1) else ""


def _content_range(value: str) -> tuple[int, int | None, int | None] | None:
    match = re.match(r"^bytes\s+(\d+)-(\d+)/(\d+|\*)$", str(value or "").strip(), re.IGNORECASE)
    if not match:
        return None
    total = None if match.group(3) == "*" else int(match.group(3))
    return int(match.group(1)), int(match.group(2)), total


def _unsatisfied_content_range_total(value: str) -> int | None:
    match = re.match(r"^bytes\s+\*/(\d+)$", str(value or "").strip(), re.IGNORECASE)
    return int(match.group(1)) if match else None


async def _download_lora_part(session, url: str, headers: dict[str, str], params: dict[str, str],
                              part_path: str, progress_id: str, max_attempts: int = 4) -> dict[str, object]:
    """把 C 站响应追加到 .part；断线时从当前文件长度继续，返回完成状态和文件名提示。"""
    last_error: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        existing = os.path.getsize(part_path) if os.path.exists(part_path) else 0
        request_headers = dict(headers)
        if existing:
            request_headers["Range"] = f"bytes={existing}-"
        try:
            timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_connect=30, sock_read=120)
            async with session.get(url, allow_redirects=True, headers=request_headers, params=params, timeout=timeout) as resp:
                if "auth.civitai.com/login" in str(resp.url):
                    raise _LoraDownloadError("该模型需登录 C 站才能下载：请填写有效的 C 站 Cookie 或 API Key 后重试", resp.status, False)
                if resp.status == 416 and existing:
                    total = _unsatisfied_content_range_total(resp.headers.get("Content-Range", ""))
                    if total is not None and total == existing:
                        return {"done": existing, "total": total, "filename": "", "resumed": True, "complete": True}
                    try:
                        os.remove(part_path)
                    except OSError:
                        pass
                    continue
                if resp.status != 200 and resp.status != 206:
                    retryable = resp.status == 429 or resp.status >= 500
                    raise _LoraDownloadError(f"download http_{resp.status}", resp.status, retryable)

                range_info = _content_range(resp.headers.get("Content-Range", ""))
                if existing and resp.status == 206:
                    if not range_info or range_info[0] != existing:
                        raise _LoraDownloadError("服务器返回的断点位置不一致，未追加文件", resp.status, False)
                    mode = "ab"
                    done = existing
                    total = range_info[2]
                elif existing and resp.status == 200:
                    # 服务端忽略 Range：不能把完整响应追加到半截文件，安全地从头重下。
                    mode = "wb"
                    done = 0
                    total = int(resp.headers.get("Content-Length", 0) or 0) or None
                else:
                    if resp.status == 206 and range_info and range_info[0] != 0:
                        raise _LoraDownloadError("服务器返回了无效的起始字节", resp.status, False)
                    mode = "wb"
                    done = 0
                    total = range_info[2] if range_info else None
                    if total is None:
                        total = int(resp.headers.get("Content-Length", 0) or 0) or None

                if total is None and resp.headers.get("Content-Length"):
                    remaining = int(resp.headers.get("Content-Length", 0) or 0)
                    total = done + remaining if mode == "ab" else remaining
                _download_progress_update(progress_id, done=done, total=total or 0, resumable=True,
                                          partial_path=part_path, status="downloading", error="")
                with open(part_path, mode) as handle:
                    async for chunk in resp.content.iter_chunked(64 * 1024):
                        if _download_progress_cancelled(progress_id):
                            _download_progress_update(progress_id, status="cancelled", done=done,
                                                      total=total or 0, resumable=True, partial_path=part_path, error="已取消")
                            return {"done": done, "total": total or 0, "filename": "", "resumed": existing > 0, "cancelled": True}
                        handle.write(chunk)
                        done += len(chunk)
                        if total:
                            _download_progress_update(progress_id, done=done, total=total, resumable=True,
                                                      partial_path=part_path)
                if total and done != total:
                    raise _LoraDownloadError(f"连接提前结束：已接收 {done}/{total} 字节", None, True)
                return {
                    "done": done,
                    "total": total or done,
                    "filename": _content_disposition_filename(resp.headers.get("Content-Disposition", "")),
                    "resumed": existing > 0 and mode == "ab",
                    "complete": True,
                }
        except asyncio.CancelledError:
            raise
        except (_LoraDownloadError, aiohttp.ClientError, asyncio.TimeoutError, OSError) as error:
            last_error = error
            retryable = isinstance(error, _LoraDownloadError) and error.retryable
            retryable = retryable or isinstance(error, (aiohttp.ClientError, asyncio.TimeoutError, OSError))
            if not retryable or attempt >= max_attempts:
                raise
            _download_progress_update(progress_id, status="retrying", resumable=True, partial_path=part_path,
                                      error=f"连接中断，正在从断点重试（{attempt}/{max_attempts - 1}）")
            await asyncio.sleep(min(2 ** (attempt - 1), 8))
    raise last_error or RuntimeError("下载失败")


async def _perform_lora_download(*, version_id: str, model_id: str, fallback_name: str,
                                 progress_id: str, cookie: str, token: str, target_key: str) -> dict:
    """执行单个下载；既供旧同步接口，也供后台任务使用。"""
    model_type = ""
    target = None

    # 只有 modelId 时：查 C 站模型详情，取默认（第一个）版本的 id
    if not version_id and model_id:
        try:
            session = await _get_session()
            u = f"https://civitai.com/api/v1/models/{model_id}"
            async with session.get(u) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    model_type = str(data.get("type") or "")
                    versions = data.get("modelVersions") or []
                    if versions:
                        version_id = str(versions[0].get("id") or "")
        except Exception:
            version_id = ""

    if not version_id:
        result = {"ok": False, "error": "versionId or modelId required", "_http_status": 400}
        _download_progress_update(progress_id, status="error", error=result["error"])
        return result

    # 查 model-version 详情拿正确文件名（files[0].name，如 qingxiao_v1.safetensors）
    api_filename = ""
    try:
        session = await _get_session()
        u = f"https://civitai.com/api/v1/model-versions/{version_id}"
        async with session.get(u) as resp:
            if resp.status == 200:
                d = await resp.json()
                model_type = str((d.get("model") or {}).get("type") or d.get("modelType") or model_type)
                files = d.get("files") or []
                if files:
                    fn = str(files[0].get("name") or "")
                    if fn and fn.lower().endswith((".safetensors", ".pt", ".bin")):
                        api_filename = fn
    except Exception:
        api_filename = ""

    try:
        download_dir, resolved_folder_type = _resolve_download_target(target_key, model_type)
    except ValueError as error:
        result = {"ok": False, "error": str(error), "_http_status": 400}
        _download_progress_update(progress_id, status="error", error=result["error"])
        return result
    os.makedirs(download_dir, exist_ok=True)

    part_path = None
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

        # API 详情通常已给出文件名；part 路径按版本号生成，避免依赖 CDN 的响应头才能续传。
        filename = api_filename or os.path.basename(fallback_name.split("?", 1)[0].replace("\\", "/").rstrip("/"))
        filename = os.path.basename(filename or "lora.safetensors")
        if not os.path.splitext(filename)[1]:
            filename += ".safetensors"
        target = os.path.join(download_dir, filename)
        part_path = _download_part_path(download_dir, version_id, fallback_name or url)

        transfer = await _download_lora_part(session, url, hdrs, params, part_path, progress_id)
        if transfer.get("cancelled"):
            return {"ok": False, "error": "已取消，已保留部分文件，下次提交同一 URL 可继续", "cancelled": True, "resumable": True}

        # 没有 API 文件名时，成功响应的 Content-Disposition 仍优先于 URL fallback。
        if not api_filename and transfer.get("filename"):
            filename = os.path.basename(str(transfer["filename"]))
            if not os.path.splitext(filename)[1]:
                filename += ".safetensors"
            target = os.path.join(download_dir, filename)
        os.replace(part_path, target)
        done = int(transfer.get("done") or 0)
        total = int(transfer.get("total") or done)
        _download_progress_update(progress_id, status="done", done=done, total=total, filename=filename,
                                  resumable=False, partial_path="", error="")
        return {"ok": True, "filename": filename, "path": target, "folderType": resolved_folder_type, "modelType": model_type or None}
    except _LoraDownloadError as error:
        part_size = os.path.getsize(part_path) if part_path and os.path.exists(part_path) else 0
        if error.status in (401, 403):
            message = "该模型需登录 C 站才能下载（HTTP 401/403）：请填写 Cookie 或 API Key 后重试"
            _download_progress_update(progress_id, status="error", done=part_size, resumable=bool(part_size),
                                      partial_path=part_path or "", error=message)
            return {"ok": False, "error": message, "needLogin": True, "resumable": bool(part_size), "_http_status": 502}
        message = str(error)
        _download_progress_update(progress_id, status="error", done=part_size, resumable=bool(part_size),
                                  partial_path=part_path or "", error=message)
        return {"ok": False, "error": message, "resumable": bool(part_size), "_http_status": 502}
    except asyncio.CancelledError:
        raise
    except Exception as error:
        # 异常时保留 .part；它不会被 ComfyUI 当成模型，重新提交同一 URL 会从断点继续。
        part_size = os.path.getsize(part_path) if part_path and os.path.exists(part_path) else 0
        _download_progress_update(progress_id, status="error", done=part_size, resumable=bool(part_size),
                                  partial_path=part_path or "", error=str(error))
        return {"ok": False, "error": str(error), "resumable": bool(part_size), "_http_status": 500}


async def _run_background_lora_download(progress_id: str, item: dict):
    # 串行消费，避免多个前端同时打开时把带宽/磁盘 I/O 打满；任务仍独立于浏览器请求。
    async with _DOWNLOAD_QUEUE_LOCK:
        if _download_progress_cancelled(progress_id):
            _download_progress_update(progress_id, status="cancelled", error="已取消")
            return
        _download_progress_update(progress_id, status="downloading")
        await _perform_lora_download(
            version_id=item.get("versionId", ""),
            model_id=item.get("modelId", ""),
            fallback_name=item.get("name", ""),
            progress_id=progress_id,
            cookie=item.get("cookie", ""),
            token=item.get("token", ""),
            target_key=item.get("target", "auto"),
        )


@PromptServer.instance.routes.get("/anima/lora/download")
async def lora_download(request):
    """兼容旧调用的同步下载接口；新前端使用 /download/queue。"""
    progress_id = request.query.get("progressId", "").strip()
    _cleanup_progress()
    if progress_id:
        with _DOWNLOAD_PROGRESS_LOCK:
            _DOWNLOAD_PROGRESS[progress_id] = {
                "progressId": progress_id, "done": 0, "total": 0, "status": "downloading",
                "filename": "", "label": request.query.get("name", "").strip(), "error": "", "ts": time.time(),
            }
    async with _DOWNLOAD_QUEUE_LOCK:
        result = await _perform_lora_download(
            version_id=request.query.get("versionId", "").strip(),
            model_id=request.query.get("modelId", "").strip(),
            fallback_name=request.query.get("name", "").strip(),
            progress_id=progress_id,
            cookie=request.query.get("cookie", "").strip(),
            token=request.query.get("token", "").strip(),
            target_key=request.query.get("target", "auto").strip() or "auto",
        )
    status = int(result.pop("_http_status", 200 if result.get("ok") else 500))
    return web.json_response(result, status=status)


@PromptServer.instance.routes.post("/anima/lora/download/queue")
async def lora_download_queue(request):
    """提交一个或多个后台下载任务，浏览器关闭后任务仍由 ComfyUI 执行。"""
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体必须是 JSON"}, status=400)
    raw_items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(raw_items, list):
        raw_items = [payload]
    if not raw_items or len(raw_items) > 100:
        return web.json_response({"ok": False, "error": "后台任务数量必须为 1 到 100"}, status=400)

    _cleanup_progress()
    jobs = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        version_id = str(raw.get("versionId") or "").strip()
        model_id = str(raw.get("modelId") or "").strip()
        if not version_id and not model_id:
            continue
        progress_id = str(raw.get("progressId") or "").strip() or f"dl_{int(time.time() * 1000)}_{os.urandom(3).hex()}"
        label = str(raw.get("label") or raw.get("url") or raw.get("name") or version_id or model_id).strip()[:240]
        item = {
            "versionId": version_id,
            "modelId": model_id,
            "name": str(raw.get("name") or "").strip()[:255],
            "target": str(raw.get("target") or "auto").strip() or "auto",
            "cookie": str(raw.get("cookie") or "").strip(),
            "token": str(raw.get("token") or "").strip(),
        }
        with _DOWNLOAD_PROGRESS_LOCK:
            _DOWNLOAD_PROGRESS[progress_id] = {
                "progressId": progress_id, "done": 0, "total": 0, "status": "queued", "filename": "",
                "label": label, "url": str(raw.get("url") or "").strip()[:500], "error": "",
                "createdAt": time.time(), "ts": time.time(),
            }
        task = asyncio.create_task(_run_background_lora_download(progress_id, item))
        _DOWNLOAD_TASKS[progress_id] = task
        task.add_done_callback(lambda _task, pid=progress_id: _DOWNLOAD_TASKS.pop(pid, None))
        jobs.append({"progressId": progress_id, "label": label, "status": "queued"})
    if not jobs:
        return web.json_response({"ok": False, "error": "没有可提交的 versionId 或 modelId"}, status=400)
    return web.json_response({"ok": True, "jobs": jobs})


@PromptServer.instance.routes.get("/anima/lora/download/targets")
async def download_targets(request):
    """Return the registered ComfyUI model roots available to the download dialog."""
    return web.json_response({"ok": True, "targets": _download_target_options()})


@PromptServer.instance.routes.get("/anima/lora/download/status")
async def download_status(request):
    pid = request.query.get("progressId", "").strip()
    with _DOWNLOAD_PROGRESS_LOCK:
        p = dict(_DOWNLOAD_PROGRESS.get(pid, {}))
    if not p:
        return web.json_response({"status": "not_found"})
    return web.json_response(p)


@PromptServer.instance.routes.get("/anima/lora/download/list")
async def download_list(request):
    """返回近期后台任务，供关闭弹窗后重新打开时恢复进度。"""
    _cleanup_progress()
    with _DOWNLOAD_PROGRESS_LOCK:
        jobs = [dict(item) for item in _DOWNLOAD_PROGRESS.values()]
    jobs.sort(key=lambda item: item.get("createdAt", item.get("ts", 0)), reverse=True)
    return web.json_response({"ok": True, "jobs": jobs[:100]})


@PromptServer.instance.routes.get("/anima/lora/download/cancel")
async def download_cancel(request):
    pid = request.query.get("progressId", "").strip()
    with _DOWNLOAD_PROGRESS_LOCK:
        if pid in _DOWNLOAD_PROGRESS:
            _DOWNLOAD_PROGRESS[pid]["cancel"] = True
            if _DOWNLOAD_PROGRESS[pid].get("status") == "queued":
                _DOWNLOAD_PROGRESS[pid]["status"] = "cancelled"
            _DOWNLOAD_PROGRESS[pid]["ts"] = time.time()
    return web.json_response({"ok": True})


def _version_tuple(v: str) -> tuple:
    nums = [int(x) for x in re.split(r"[^0-9]+", v) if x.isdigit()][:3]
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def _is_update_release_path(relative_path: str) -> bool:
    path = relative_path.replace("\\", "/").strip("/")
    if not path or any(part in _UPDATE_EXCLUDED_DIRS for part in path.split("/")):
        return False
    return (
        path in {"__init__.py", "VERSION", "README.md", "CHANGELOG.md", "LICENSE"}
        or path.startswith("anima_")
        or path.startswith("web/")
        or path.startswith("app/")
    )


def _iter_update_files(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in _UPDATE_EXCLUDED_DIRS]
        for filename in filenames:
            absolute = os.path.join(dirpath, filename)
            relative = os.path.relpath(absolute, root).replace(os.sep, "/")
            if _is_update_release_path(relative):
                yield relative, absolute


def _git_blob_sha(path: str) -> str:
    size = os.path.getsize(path)
    digest = hashlib.sha1()
    digest.update(f"blob {size}\0".encode("utf-8"))
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _local_update_commit() -> str:
    try:
        root_result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], cwd=PLUGIN_DIR,
            capture_output=True, text=True, timeout=5, check=False,
        )
        repo_root = os.path.normcase(os.path.abspath(root_result.stdout.strip())) if root_result.returncode == 0 else ""
        plugin_root = os.path.normcase(os.path.abspath(PLUGIN_DIR))
        if not repo_root or repo_root != plugin_root:
            raise RuntimeError("运行目录不是独立 Git 仓库")
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=PLUGIN_DIR,
            capture_output=True, text=True, timeout=5, check=False,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    try:
        with open(_UPDATE_STATE_PATH, "r", encoding="utf-8") as handle:
            value = json.load(handle)
        return str(value.get("commit") or "").strip()
    except Exception:
        return ""


def _write_update_state(commit: str, version: str) -> bool:
    try:
        os.makedirs(os.path.dirname(_UPDATE_STATE_PATH), exist_ok=True)
        temp_path = _UPDATE_STATE_PATH + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump({"commit": commit, "version": version, "updatedAt": time.time()}, handle, ensure_ascii=False)
        os.replace(temp_path, _UPDATE_STATE_PATH)
        return True
    except Exception:
        try:
            if os.path.exists(_UPDATE_STATE_PATH + ".tmp"):
                os.remove(_UPDATE_STATE_PATH + ".tmp")
        except Exception:
            pass
        return False


async def _github_json(url: str) -> dict:
    session = await _get_session()
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "ComfyUI-Anima-Batch-LoRA"}
    async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
        if resp.status != 200:
            raise RuntimeError(f"GitHub HTTP {resp.status}")
        data = await resp.json()
        return data if isinstance(data, dict) else {}


async def _github_text(url: str) -> str:
    session = await _get_session()
    headers = {"User-Agent": "ComfyUI-Anima-Batch-LoRA"}
    async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
        if resp.status != 200:
            raise RuntimeError(f"GitHub HTTP {resp.status}")
        return (await resp.text()).strip()


async def _get_update_info(force: bool = False) -> dict:
    now = time.time()
    cached = _UPDATE_CHECK_CACHE.get("value")
    if not force and cached and now < _UPDATE_CHECK_CACHE.get("expires", 0):
        return dict(cached)
    async with _UPDATE_CHECK_LOCK:
        now = time.time()
        cached = _UPDATE_CHECK_CACHE.get("value")
        if not force and cached and now < _UPDATE_CHECK_CACHE.get("expires", 0):
            return dict(cached)

        latest = ""
        remote_commit = ""
        remote_tree: dict[str, str] = {}
        remote_error = ""
        try:
            latest = await _github_text(f"https://raw.githubusercontent.com/{_UPDATE_REPO}/main/VERSION")
        except Exception as error:
            remote_error = str(error)
        try:
            commit_data = await _github_json(f"{_UPDATE_API_BASE}/commits/main")
            remote_commit = str(commit_data.get("sha") or "").strip()
        except Exception as error:
            remote_error = remote_error or str(error)
        try:
            tree_data = await _github_json(f"{_UPDATE_API_BASE}/git/trees/main?recursive=1")
            if not tree_data.get("truncated"):
                remote_tree = {
                    str(item.get("path")): str(item.get("sha"))
                    for item in tree_data.get("tree", [])
                    if item.get("type") == "blob" and item.get("path") and item.get("sha")
                    and _is_update_release_path(str(item.get("path")))
                }
        except Exception as error:
            remote_error = remote_error or str(error)

        local_commit = _local_update_commit()
        package_checked = bool(remote_tree)
        package_match = None
        if package_checked:
            package_match = True
            local_files = dict(_iter_update_files(PLUGIN_DIR))
            for relative, remote_sha in remote_tree.items():
                local_path = local_files.get(relative)
                if not local_path or _git_blob_sha(local_path) != remote_sha:
                    package_match = False
                    break
        version_behind = bool(latest and _version_tuple(__version__) < _version_tuple(latest))
        commit_behind = bool(local_commit and remote_commit and local_commit != remote_commit)
        package_behind = package_checked and package_match is False
        update_available = version_behind or commit_behind or package_behind
        value = {
            "version": __version__,
            "latest": latest or None,
            "behind": update_available,
            "versionBehind": version_behind,
            "updateAvailable": update_available,
            "localCommit": local_commit or None,
            "remoteCommit": remote_commit or None,
            "commitChecked": bool(remote_commit),
            "packageChecked": package_checked,
            "packageMatch": package_match,
            "canAutoUpdate": bool(remote_commit and os.access(PLUGIN_DIR, os.W_OK)),
            "error": remote_error or None,
            "checkedAt": time.time(),
            "url": f"https://github.com/{_UPDATE_REPO}",
        }
        _UPDATE_CHECK_CACHE["value"] = value
        _UPDATE_CHECK_CACHE["expires"] = time.time() + 30
        return dict(value)


async def _download_update_archive(remote_commit: str, archive_path: str):
    session = await _get_session()
    url = f"{_UPDATE_ARCHIVE_BASE}/{remote_commit}.zip"
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_connect=30, sock_read=120)
    max_size = 128 * 1024 * 1024
    async with session.get(url, allow_redirects=True, timeout=timeout, headers={"User-Agent": "ComfyUI-Anima-Batch-LoRA"}) as resp:
        if resp.status != 200:
            raise RuntimeError(f"GitHub 更新包 HTTP {resp.status}")
        content_length = int(resp.headers.get("Content-Length", 0) or 0)
        if content_length > max_size:
            raise RuntimeError("GitHub 更新包超过 128MB，已拒绝写入")
        downloaded = 0
        with open(archive_path, "wb") as handle:
            async for chunk in resp.content.iter_chunked(256 * 1024):
                downloaded += len(chunk)
                if downloaded > max_size:
                    raise RuntimeError("GitHub 更新包超过 128MB，已拒绝写入")
                handle.write(chunk)


def _stage_update_archive(archive_path: str, stage_dir: str) -> list[tuple[str, str]]:
    with zipfile.ZipFile(archive_path) as archive:
        members = [item for item in archive.infolist() if not item.is_dir()]
        roots = {
            item.filename.replace("\\", "/").split("/", 1)[0]
            for item in members if "/" in item.filename.replace("\\", "/")
        }
        root = next((candidate for candidate in roots if f"{candidate}/__init__.py" in {m.filename.replace('\\', '/') for m in members}), "")
        if not root or f"{root}/VERSION" not in {m.filename.replace("\\", "/") for m in members}:
            raise RuntimeError("更新包结构无效：缺少插件根目录、__init__.py 或 VERSION")
        staged = []
        stage_root = os.path.abspath(stage_dir)
        for item in members:
            archive_name = item.filename.replace("\\", "/")
            prefix = f"{root}/"
            if not archive_name.startswith(prefix):
                continue
            relative = archive_name[len(prefix):]
            if not _is_update_release_path(relative):
                continue
            normalized = os.path.normpath(relative.replace("/", os.sep))
            if normalized in {"", "."} or normalized.startswith("..") or os.path.isabs(normalized):
                raise RuntimeError("更新包包含非法路径")
            destination = os.path.abspath(os.path.join(stage_root, normalized))
            if os.path.commonpath([stage_root, destination]) != stage_root:
                raise RuntimeError("更新包路径越界")
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with archive.open(item) as source, open(destination, "wb") as target:
                shutil.copyfileobj(source, target)
            staged.append((relative.replace("/", os.sep), destination))
        if not any(relative == "__init__.py" for relative, _ in staged) or not any(relative == "VERSION" for relative, _ in staged):
            raise RuntimeError("更新包校验失败：未找到必要发布文件")
        return staged


def _apply_staged_update(staged: list[tuple[str, str]]) -> int:
    backup_dir = tempfile.mkdtemp(prefix="anima-update-backup-", dir=os.path.dirname(PLUGIN_DIR))
    applied: list[tuple[str, str, bool]] = []
    try:
        for relative, source in staged:
            destination = os.path.abspath(os.path.join(PLUGIN_DIR, relative))
            if os.path.commonpath([PLUGIN_DIR, destination]) != os.path.abspath(PLUGIN_DIR):
                raise RuntimeError("更新目标路径越界")
            backup = os.path.join(backup_dir, relative)
            had_old = os.path.isfile(destination)
            if had_old:
                os.makedirs(os.path.dirname(backup), exist_ok=True)
                shutil.copy2(destination, backup)
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            try:
                shutil.copy2(source, destination)
            except Exception:
                if had_old:
                    shutil.copy2(backup, destination)
                elif os.path.exists(destination):
                    os.remove(destination)
                raise
            applied.append((destination, backup, had_old))
        return len(applied)
    except Exception:
        for destination, backup, had_old in reversed(applied):
            try:
                if had_old:
                    shutil.copy2(backup, destination)
                elif os.path.exists(destination):
                    os.remove(destination)
            except Exception:
                pass
        raise
    finally:
        shutil.rmtree(backup_dir, ignore_errors=True)


@PromptServer.instance.routes.get("/anima/version")
async def anima_version(request):
    force = request.query.get("force", "").strip().lower() in {"1", "true", "yes"}
    return web.json_response(await _get_update_info(force=force))


@PromptServer.instance.routes.post("/anima/update/apply")
async def anima_update_apply(request):
    """安全应用 GitHub ZIP 更新；仅覆盖发布文件，保留用户数据。"""
    if _UPDATE_APPLY_LOCK.locked():
        return web.json_response({"ok": False, "error": "更新正在进行中"}, status=409)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    expected_commit = str(payload.get("expectedCommit") or "").strip() if isinstance(payload, dict) else ""
    async with _UPDATE_APPLY_LOCK:
        info = await _get_update_info(force=True)
        remote_commit = str(info.get("remoteCommit") or "").strip()
        if not remote_commit:
            return web.json_response({"ok": False, "error": "无法获取 GitHub 最新提交，请稍后重试或手动更新"}, status=503)
        if expected_commit and expected_commit != remote_commit:
            return web.json_response({"ok": False, "error": "远端在检查后又有新提交，请重新检查更新", "remoteCommit": remote_commit}, status=409)
        if not info.get("updateAvailable"):
            return web.json_response({"ok": True, "alreadyLatest": True, "restartRequired": False, **info})
        temp_dir = tempfile.mkdtemp(prefix="anima-update-")
        archive_path = os.path.join(temp_dir, "update.zip")
        stage_dir = os.path.join(temp_dir, "stage")
        try:
            os.makedirs(stage_dir, exist_ok=True)
            await _download_update_archive(remote_commit, archive_path)
            staged = _stage_update_archive(archive_path, stage_dir)
            count = _apply_staged_update(staged)
            version_path = os.path.join(stage_dir, "VERSION")
            with open(version_path, "r", encoding="utf-8") as handle:
                applied_version = handle.read().strip()
            state_saved = _write_update_state(remote_commit, applied_version)
            _UPDATE_CHECK_CACHE["value"] = None
            return web.json_response({
                "ok": True, "updatedFiles": count, "version": applied_version,
                "commit": remote_commit, "stateSaved": state_saved,
                "restartRequired": True,
                "restartHint": "请通过绘世启动器重启 ComfyUI，然后刷新浏览器页面",
            })
        except Exception as error:
            return web.json_response({"ok": False, "error": str(error), "unchangedOnValidationFailure": True}, status=500)
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


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


# ─── 翻译（多源：本地词典 / 本地 LLM(Qwen/Gemma 手动启用) / DeepLX / 百度 / MyMemory / Google / DashScope 通义）───
# 面板「图片解析」的翻译全部走这里：source=auto 时按顺序回退，任何单源失败都不影响整体。
# local_llm 默认不加载；Prompt Cards 显式选择该源时按需加载本地模型，翻译会话结束后释放。
# 2026-08-26：Argos 已按用户要求移除（语义保留基准 5/20 不合格，由本地 LLM 取代）。

_TRANSLATION_CACHE_TTL = 3600 * 24  # SQLite provider 缓存 1 天（内容稳定，省配额）
_TRANSLATE_DICT: dict | None = None
_TRANSLATE_DICT_MTIME = 0.0
_TRANSLATE_ORDER = ("local", "local_llm", "deeplx", "baidu", "mymemory", "google", "dashscope")
_TRANSLATION_DB_PATH = os.path.join(PLUGIN_DIR, "data", "translation_cache.sqlite3")
_TRANSLATOR_VERSION = "tk-translation-router-v1"
_BAIDU_TRANSLATE_ENDPOINT = "https://fanyi-api.baidu.com/ait/api/aiTextTranslate"
_BAIDU_TRANSLATE_CONFIG_PATH = os.path.join(PLUGIN_DIR, "data", "translation_providers.json")
_BAIDU_CONFIG_LOCK = threading.Lock()


class TranslationProviderError(RuntimeError):
    """可分类的 provider 错误；保留旧调用方可理解的字符串。"""

    def __init__(self, message: str, code: str = "provider_error"):
        super().__init__(message)
        self.code = code


@dataclass
class ProviderState:
    health: str = "unknown"
    last_success: float = 0.0
    last_error: str = ""
    error_code: str = ""
    success_count: int = 0
    failure_count: int = 0
    consecutive_failures: int = 0
    cooldown_until: float = 0.0
    latency_ms: float | None = None


_PROVIDER_STATES = {name: ProviderState() for name in _TRANSLATE_ORDER}
_PROVIDER_STATE_LOCK = threading.Lock()
_PROVIDER_COOLDOWN_SECONDS = {
    "not_found": 0,
    "unsupported": 0,
    "upstream_rate_limit": 480,
    "quota_exhausted": 3600,
    "account_arrears": 3600,
    "authentication_error": 1800,
    "model_permission_error": 3600,
    "service_unavailable": 45,
    "network_error": 60,
    "quality_rejected": 120,
    "provider_error": 60,
}
_LAST_TRANSLATION_PROVIDER = ""

_TRANSLATION_DB_READY = False
_TRANSLATION_DB_LOCK = threading.Lock()


def _normalize_translation_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    return re.sub(r"\s+", " ", text)


def _ensure_translation_db() -> None:
    global _TRANSLATION_DB_READY
    if _TRANSLATION_DB_READY:
        return
    with _TRANSLATION_DB_LOCK:
        if _TRANSLATION_DB_READY:
            return
        os.makedirs(os.path.dirname(_TRANSLATION_DB_PATH), exist_ok=True)
        with sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS translation_cache (
                    cache_key TEXT PRIMARY KEY,
                    source_text TEXT NOT NULL,
                    normalized_source_text TEXT NOT NULL,
                    source_language TEXT NOT NULL,
                    target_language TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    translated_text TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    translator_version TEXT NOT NULL,
                    user_confirmed INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_translation_cache_lookup
                ON translation_cache(normalized_source_text, source_language, target_language, provider);
                CREATE TABLE IF NOT EXISTS prompt_glossary (
                    glossary_key TEXT PRIMARY KEY,
                    source_text TEXT NOT NULL,
                    normalized_source_text TEXT NOT NULL,
                    source_language TEXT NOT NULL,
                    target_language TEXT NOT NULL,
                    translated_text TEXT NOT NULL,
                    tag_text TEXT NOT NULL DEFAULT '',
                    timestamp REAL NOT NULL,
                    translator_version TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_prompt_glossary_lookup
                ON prompt_glossary(normalized_source_text, source_language, target_language);
            """)
        _TRANSLATION_DB_READY = True


def _translation_key(text: str, source_language: str, target_language: str, provider: str) -> str:
    raw = "|".join((_normalize_translation_text(text), source_language.lower(), target_language.lower(), provider.lower()))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _glossary_key(text: str, source_language: str, target_language: str) -> str:
    raw = "|".join((_normalize_translation_text(text), source_language.lower(), target_language.lower()))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _get_glossary(text: str, source_language: str, target_language: str) -> dict[str, str] | None:
    _ensure_translation_db()
    key = _glossary_key(text, source_language, target_language)
    with sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5) as db:
        row = db.execute(
            "SELECT translated_text, tag_text, translator_version FROM prompt_glossary WHERE glossary_key = ?",
            (key,),
        ).fetchone()
    if not row:
        return None
    return {"translated_text": str(row[0]), "tag_text": str(row[1] or ""), "translator_version": str(row[2] or "")}


def _put_glossary(text: str, source_language: str, target_language: str, translated: str, tag_text: str = "") -> None:
    _ensure_translation_db()
    now = time.time()
    with sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5) as db:
        db.execute(
            """INSERT INTO prompt_glossary
               (glossary_key, source_text, normalized_source_text, source_language, target_language,
                translated_text, tag_text, timestamp, translator_version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(glossary_key) DO UPDATE SET
                 source_text=excluded.source_text, translated_text=excluded.translated_text,
                 tag_text=excluded.tag_text, timestamp=excluded.timestamp,
                 translator_version=excluded.translator_version""",
            (_glossary_key(text, source_language, target_language), text, _normalize_translation_text(text),
             source_language, target_language, translated, tag_text, now, _TRANSLATOR_VERSION),
        )


def _get_provider_cache(text: str, source_language: str, target_language: str, provider: str) -> str | None:
    _ensure_translation_db()
    key = _translation_key(text, source_language, target_language, provider)
    with sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5) as db:
        row = db.execute(
            "SELECT translated_text, timestamp FROM translation_cache WHERE cache_key = ?",
            (key,),
        ).fetchone()
    if not row or float(row[1] or 0) + _TRANSLATION_CACHE_TTL <= time.time():
        return None
    return str(row[0])


def _put_provider_cache(text: str, source_language: str, target_language: str, provider: str, translated: str) -> None:
    _ensure_translation_db()
    now = time.time()
    with sqlite3.connect(_TRANSLATION_DB_PATH, timeout=5) as db:
        db.execute(
            """INSERT INTO translation_cache
               (cache_key, source_text, normalized_source_text, source_language, target_language,
                provider, translated_text, timestamp, translator_version, user_confirmed)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
               ON CONFLICT(cache_key) DO UPDATE SET translated_text=excluded.translated_text,
                 timestamp=excluded.timestamp, translator_version=excluded.translator_version""",
            (_translation_key(text, source_language, target_language, provider), text,
             _normalize_translation_text(text), source_language, target_language, provider,
             translated, now, _TRANSLATOR_VERSION),
        )


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


def _load_baidu_config() -> dict[str, object]:
    """读取百度翻译本机配置；密钥只在后端使用，不回传给前端。"""
    config: dict[str, object] = {}
    try:
        with open(_BAIDU_TRANSLATE_CONFIG_PATH, "r", encoding="utf-8") as file:
            raw = json.load(file)
        if isinstance(raw, dict):
            config = raw
    except (OSError, ValueError, TypeError):
        pass
    appid = str(config.get("appid") or _get_env("BAIDU_TRANSLATE_APPID") or "").strip()
    api_key = str(config.get("api_key") or _get_env("BAIDU_TRANSLATE_API_KEY") or "").strip()
    model_type = str(config.get("model_type") or "llm").strip().lower()
    if model_type not in {"llm", "nmt"}:
        model_type = "llm"
    return {
        "appid": appid[:200],
        "api_key": api_key[:500],
        "model_type": model_type,
        "need_intervene": bool(config.get("need_intervene", False)),
    }


def _save_baidu_config(config: dict[str, object]) -> None:
    with _BAIDU_CONFIG_LOCK:
        os.makedirs(os.path.dirname(_BAIDU_TRANSLATE_CONFIG_PATH), exist_ok=True)
        temp_path = _BAIDU_TRANSLATE_CONFIG_PATH + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as file:
            json.dump(config, file, ensure_ascii=False, indent=2)
        os.replace(temp_path, _BAIDU_TRANSLATE_CONFIG_PATH)


def _baidu_config_snapshot() -> dict[str, object]:
    config = _load_baidu_config()
    return {
        "configured": bool(config["appid"] and config["api_key"]),
        "has_appid": bool(config["appid"]),
        "has_api_key": bool(config["api_key"]),
        "model_type": config["model_type"],
        "need_intervene": config["need_intervene"],
        "endpoint": _BAIDU_TRANSLATE_ENDPOINT,
    }


def _baidu_language(value: str, default: str) -> str:
    language = str(value or default).strip().lower().replace("_", "-")
    if language in {"zh-cn", "zh-sg", "zh-hans"}:
        return "zh"
    if language in {"zh-tw", "zh-hk", "zh-hant"}:
        return "zh"
    if language in {"auto", "en", "zh", "ja", "ko", "fr", "de", "es", "ru"}:
        return language
    return language.split("-", 1)[0] or default


def _baidu_error_code(code: object) -> str:
    mapping = {
        "52001": "network_error",
        "52002": "service_unavailable",
        "52003": "authentication_error",
        "54000": "provider_error",
        "54001": "authentication_error",
        "54003": "upstream_rate_limit",
        "54004": "quota_exhausted",
        "54005": "upstream_rate_limit",
        "58000": "authentication_error",
        "58001": "unsupported",
        "58002": "service_unavailable",
        "58003": "authentication_error",
        "58004": "provider_error",
        "59002": "provider_error",
        "59003": "provider_error",
        "59004": "upstream_rate_limit",
        "59005": "provider_error",
        "59006": "provider_error",
        "59007": "provider_error",
        "90107": "authentication_error",
    }
    text = str(code)
    if text in {"401", "403"}:
        return "authentication_error"
    if text == "429":
        return "upstream_rate_limit"
    if text.isdigit() and 500 <= int(text) <= 599:
        return "network_error"
    return mapping.get(text, "provider_error")


def _provider_configured(provider: str) -> bool:
    if provider == "local":
        return bool(_load_translate_dict())
    if provider == "local_llm":
        from .anima_local_llm import is_ready as _llm_ready
        return _llm_ready()
    if provider == "deeplx":
        exe = os.environ.get("DEEPLX_EXE") or _DEEPLX_MANAGER.exe
        return os.path.isfile(exe)
    if provider == "dashscope":
        return bool(_get_env("DASHSCOPE_API_KEY"))
    if provider == "baidu":
        config = _load_baidu_config()
        return bool(config["appid"] and config["api_key"])
    # MyMemory/Google are keyless adapters; their health is learned on request.
    return True


def _classify_provider_error(error: BaseException) -> str:
    message = str(error).lower()
    if "arrearage" in message or "overdue" in message or "欠费" in message:
        return "account_arrears"
    if "unpurchased" in message or "accessdenied" in message or "model permission" in message or "无权限" in message:
        return "model_permission_error"
    if "quota" in message or "额度" in message or "all available free" in message:
        return "quota_exhausted"
    if "429" in message or "too many requests" in message or "rate limit" in message or "限流" in message:
        return "upstream_rate_limit"
    if "401" in message or "unauthorized" in message or "api key" in message or "鉴权" in message:
        return "authentication_error"
    if "未收录" in message or "not installed" in message or "unsupported" in message or "不支持" in message:
        return "not_found" if "未收录" in message or "not installed" in message else "unsupported"
    if "未启动" in message or "not found" in message or "cannot connect" in message or "connection refused" in message:
        return "service_unavailable"
    if "timeout" in message or "timed out" in message or "network" in message or "连接失败" in message:
        return "network_error"
    if "quality" in message or "译文质量" in message:
        return "quality_rejected"
    code = getattr(error, "code", "")
    if code:
        if str(code).endswith("_429"):
            return "upstream_rate_limit"
        if str(code).endswith("_401"):
            return "authentication_error"
        if str(code).endswith("_403"):
            return "model_permission_error"
        if str(code).endswith("_408") or re.search(r"_5\d\d$", str(code)):
            return "network_error"
        return str(code)
    return "provider_error"


def _provider_record_success(provider: str, latency_ms: float) -> None:
    global _LAST_TRANSLATION_PROVIDER
    now = time.time()
    with _PROVIDER_STATE_LOCK:
        state = _PROVIDER_STATES.setdefault(provider, ProviderState())
        state.health = "healthy"
        state.last_success = now
        state.last_error = ""
        state.error_code = ""
        state.success_count += 1
        state.consecutive_failures = 0
        state.cooldown_until = 0.0
        state.latency_ms = round(latency_ms, 1)
        _LAST_TRANSLATION_PROVIDER = provider


def _provider_record_failure(provider: str, error: BaseException, latency_ms: float) -> str:
    code = _classify_provider_error(error)
    cooldown = _PROVIDER_COOLDOWN_SECONDS.get(code, 60)
    now = time.time()
    with _PROVIDER_STATE_LOCK:
        state = _PROVIDER_STATES.setdefault(provider, ProviderState())
        state.health = "cooldown" if cooldown > 0 else "unhealthy"
        state.last_error = str(error)[:400]
        state.error_code = code
        state.failure_count += 1
        state.consecutive_failures += 1
        state.cooldown_until = now + cooldown
        state.latency_ms = round(latency_ms, 1)
    return code


def _provider_is_cooling(provider: str) -> bool:
    with _PROVIDER_STATE_LOCK:
        state = _PROVIDER_STATES.setdefault(provider, ProviderState())
        return state.cooldown_until > time.time()


def _provider_snapshot(provider: str) -> dict[str, object]:
    with _PROVIDER_STATE_LOCK:
        state = _PROVIDER_STATES.setdefault(provider, ProviderState())
        snapshot = {
            "health": state.health,
            "configured": _provider_configured(provider),
            "last_success": state.last_success or None,
            "last_error": state.last_error,
            "error_code": state.error_code,
            "success_count": state.success_count,
            "failure_count": state.failure_count,
            "success_rate": round(state.success_count / max(1, state.success_count + state.failure_count), 3),
            "consecutive_failures": state.consecutive_failures,
            "cooldown_until": state.cooldown_until or None,
            "cooldown_seconds": max(0, int(state.cooldown_until - time.time())),
            "latency_ms": state.latency_ms,
        }
    if provider == "deeplx":
        manager = _DEEPLX_MANAGER.status_sync()
        snapshot["manager"] = manager
        if manager["listening"] and snapshot["health"] == "unknown":
            snapshot["health"] = "healthy"
        elif not manager["listening"] and snapshot["error_code"] == "":
            snapshot["health"] = "service_unavailable"
            snapshot["error_code"] = "service_unavailable"
            snapshot["last_error"] = "DeepLX 未监听"
    return snapshot


def _provider_order_for(source: str) -> list[str]:
    if source != "auto":
        return [source]
    now = time.time()
    def sort_key(provider: str) -> tuple:
        with _PROVIDER_STATE_LOCK:
            state = _PROVIDER_STATES.setdefault(provider, ProviderState())
            cooling = state.cooldown_until > now
            health_rank = {"healthy": 0, "unknown": 1, "service_unavailable": 3, "cooldown": 4}.get(state.health, 2)
            latency = state.latency_ms if state.latency_ms is not None else 99999
            failures = state.consecutive_failures
            total = state.success_count + state.failure_count
            success_rate = state.success_count / max(1, total)
        # 本地词典与手动启用模型优先（命中即权威且质量可控）：
        # 词典 > 本地 LLM（已加载）> 网络源；health 只在其内部比较。
        local_rank = 0 if provider == "local" else (1 if provider == "local_llm" else 2)
        return (cooling, local_rank, health_rank, -success_rate, failures, latency, _TRANSLATE_ORDER.index(provider))
    return sorted((p for p in _TRANSLATE_ORDER if _provider_configured(p)), key=sort_key)


def _translation_quality(source_text: str, translated_text: str, source_lang: str, target_lang: str) -> dict[str, object]:
    source = str(source_text or "").strip()
    output = str(translated_text or "").strip()
    compact_source = re.sub(r"[\s\W_]+", "", unicodedata.normalize("NFKC", source).casefold())
    compact_output = re.sub(r"[\s\W_]+", "", unicodedata.normalize("NFKC", output).casefold())
    cjk = sum(1 for char in output if "\u4e00" <= char <= "\u9fff")
    latin = sum(1 for char in output if ("a" <= char.lower() <= "z"))
    letters = cjk + latin
    cjk_ratio = cjk / max(1, len(output.replace(" ", "")))
    latin_ratio = latin / max(1, letters)
    length_ratio = len(output) / max(1, len(source))
    fatal: list[str] = []
    warnings: list[str] = []
    low = output.casefold()
    if not output:
        fatal.append("empty_output")
    if re.match(r"^\s*(?:<!doctype|<html|<head|\{\s*[\"']?(?:error|message|status)|http\s*[/]?\d|502\b|429\b)", low):
        fatal.append("error_page_or_http_text")
    if compact_source and compact_source == compact_output and source_lang.casefold() != target_lang.casefold():
        fatal.append("same_as_input")
    target_is_en = target_lang.casefold().startswith("en")
    target_is_zh = target_lang.casefold().startswith("zh")
    if target_is_en and cjk_ratio > 0.20:
        fatal.append("cjk_residue")
    if target_is_en and output and latin_ratio < 0.18:
        warnings.append("low_english_ratio")
    if target_is_zh and output and cjk_ratio < 0.12:
        warnings.append("low_chinese_ratio")
    if len(source) >= 4 and (length_ratio < 0.05 or length_ratio > 12):
        warnings.append("length_anomaly")
    score = 1.0
    score -= 0.55 * len(fatal)
    score -= 0.12 * len(warnings)
    return {
        "status": "rejected" if fatal else ("warning" if warnings else "ok"),
        "score": round(max(0.0, min(1.0, score)), 3),
        "issues": fatal,
        "warnings": warnings,
        "cjk_ratio": round(cjk_ratio, 3),
        "latin_ratio": round(latin_ratio, 3),
        "length_ratio": round(length_ratio, 3),
    }


def _quality_error(quality: dict[str, object]) -> TranslationProviderError:
    issues = ", ".join(str(item) for item in quality.get("issues", [])) or "quality_check"
    return TranslationProviderError(f"译文质量检查未通过: {issues}", "quality_rejected")


def _load_translate_dict() -> dict:
    """本地 Danbooru 标签中文字典（data/danbooru_tags_zh.json，mtime+size 指纹热重载）。"""
    global _TRANSLATE_DICT, _TRANSLATE_DICT_MTIME
    for p in (
        os.path.join(PLUGIN_DIR, "data", "danbooru_tags_zh.json"),
        os.path.join(PLUGIN_DIR, "danbooru_tags_zh.json"),
    ):
        try:
            mtime = os.path.getmtime(p)
            size = os.path.getsize(p)
            if _TRANSLATE_DICT is not None and (mtime, size) == _TRANSLATE_DICT_MTIME:
                return _TRANSLATE_DICT
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            d = {str(k).strip().lower(): str(v) for k, v in data.items() if v}
            _TRANSLATE_DICT, _TRANSLATE_DICT_MTIME = d, (mtime, size)
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


async def _translate_baidu(text: str, src_lang: str, dst_lang: str, config: dict[str, object] | None = None) -> str:
    """调用百度大模型文本翻译 API；使用 Bearer API Key，不把密钥暴露给前端。"""
    settings = config or _load_baidu_config()
    appid = str(settings.get("appid") or "").strip()
    api_key = str(settings.get("api_key") or "").strip()
    if not appid or not api_key:
        raise TranslationProviderError("百度翻译未配置 APPID 或 API Key", "not_configured")
    payload: dict[str, object] = {
        "appid": appid,
        "from": _baidu_language(src_lang, "auto"),
        "to": _baidu_language(dst_lang, "en"),
        "q": str(text or "")[:2000],
        "model_type": str(settings.get("model_type") or "llm"),
    }
    if bool(settings.get("need_intervene")):
        payload["needIntervene"] = 1
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.post(
                _BAIDU_TRANSLATE_ENDPOINT,
                json=payload,
                headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
            ) as response:
                status = response.status
                raw = await response.text()
    except Exception as error:
        raise TranslationProviderError(f"百度翻译连接失败: {error}", "network_error") from error
    try:
        body = json.loads(raw)
    except (TypeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    error_code = body.get("error_code")
    if status != 200 or error_code:
        code = str(error_code or status)
        message = str(body.get("error_msg") or body.get("message") or raw[:200]).strip()
        raise TranslationProviderError(f"百度翻译 {code}: {message}", _baidu_error_code(error_code or status))
    rows = body.get("trans_result")
    if not isinstance(rows, list):
        rows = (body.get("data") or {}).get("trans_result") if isinstance(body.get("data"), dict) else []
    translated = "".join(str(row.get("dst") or "") for row in rows if isinstance(row, dict)).strip()
    if translated:
        return translated
    raise TranslationProviderError("百度翻译返回空译文", "empty_output")


async def _translate_via(source: str, text: str, src_lang: str, dst_lang: str) -> str:
    """单源翻译；失败抛异常（自动链路靠异常切源）。"""
    if source == "local":
        hit = _load_translate_dict().get(text.strip().lower())
        if not hit:
            raise TranslationProviderError("本地词典未收录该词", "not_found")
        return hit

    if source == "local_llm":
        # 手动启用的本地翻译模型（TranslateGemma / NLLB，anima_local_llm.py）。
        # 推理放线程池，避免阻塞 ComfyUI 事件循环。
        from .anima_local_llm import translate as _llm_translate
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, lambda: _llm_translate(text[:2000], src_lang, dst_lang)
            )
        except Exception as error:
            raise TranslationProviderError(f"本地 LLM 失败: {error}", "provider_error") from error
        if result and str(result).strip():
            return str(result).strip()
        raise RuntimeError("本地 LLM 返回空")

    if source == "deeplx":
        if not await _ensure_deeplx_started():
            raise RuntimeError("DeepLX 未启动且未找到可用的本地程序")
        sl, tl = _deepl_langs(f"{src_lang}|{dst_lang}")
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as s:
                async with s.post("http://127.0.0.1:1188/translate",
                                  json={"text": text[:2000], "source_lang": sl, "target_lang": tl}) as r:
                    raw = await r.text()
                    try:
                        body = json.loads(raw)
                    except (TypeError, ValueError):
                        body = {}
        except Exception as e:
            raise TranslationProviderError(f"DeepLX 连接失败: {e}", "service_unavailable") from e
        if r.status != 200:
            raise TranslationProviderError(f"DeepLX 上游 HTTP {r.status}: {raw[:160]}", f"upstream_http_{r.status}")
        if body.get("code") == 200 and body.get("data"):
            return str(body["data"])
        code = body.get("code", "?")
        raise TranslationProviderError(f"DeepLX 上游返回 {code}: {raw[:160]}", f"upstream_http_{code}")

    if source == "baidu":
        return await _translate_baidu(text, src_lang, dst_lang)

    if source == "mymemory":
        import urllib.parse
        url = ("https://api.mymemory.translated.net/get?q="
               + urllib.parse.quote(text[:500])
               + "&langpair=" + urllib.parse.quote(f"{src_lang}|{dst_lang}"))
        email = _get_env("MYMEMORY_EMAIL")
        if email:
            # 匿名池经常被耗尽；de= 邮箱参数走该邮箱独立免费额度（上限更高）
            url += "&de=" + urllib.parse.quote(email)
        session = await _get_session()
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as r:
            raw = await r.text()
            try:
                body = json.loads(raw)
            except (TypeError, ValueError):
                body = {}
        if r.status != 200:
            raise TranslationProviderError(f"MyMemory HTTP {r.status}: {raw[:160]}", f"upstream_http_{r.status}")
        if body.get("responseStatus") == 200 and body.get("responseData", {}).get("translatedText"):
            return str(body["responseData"]["translatedText"])
        raise TranslationProviderError(body.get("responseDetails") or f"MyMemory 状态 {body.get('responseStatus')}: {raw[:160]}", f"upstream_http_{body.get('responseStatus', '?')}")

    if source == "google":
        import urllib.parse
        url = ("https://translate.googleapis.com/translate_a/single?client=gtx"
               f"&sl={src_lang}&tl={dst_lang}&dt=t&q=" + urllib.parse.quote(text[:2000]))
        session = await _get_session()
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=12)) as r:
            raw = await r.text()
            try:
                data = json.loads(raw)
            except (TypeError, ValueError):
                data = []
        if r.status != 200:
            raise TranslationProviderError(f"Google HTTP {r.status}: {raw[:160]}", f"upstream_http_{r.status}")
        parts = []
        if isinstance(data, list) and data and isinstance(data[0], list):
            for row in data[0]:
                if isinstance(row, list) and row and row[0]:
                    parts.append(str(row[0]))
        if parts:
            return "".join(parts)
        raise TranslationProviderError("Google 返回空", "empty_output")

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
                 ("你是翻译助手。把用户给出的中文自然语言或图片标签翻译成英文，"
                  "保持原有结构，只输出译文，不要解释。" if dst_lang.lower().startswith("en") else
                  "你是翻译助手。把用户给出的英文图片标签/提示词翻译成简体中文，"
                  "保持原有结构（逗号分隔、括号、下划线等），只输出译文，不要解释。")},
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
                    raw = await r.text()
                    try:
                        body = json.loads(raw)
                    except (TypeError, ValueError):
                        body = {}
        except Exception as e:
            raise TranslationProviderError(f"DashScope 连接失败: {e}", "network_error") from e
        if r.status != 200:
            detail = body.get("error") if isinstance(body, dict) else raw[:160]
            if isinstance(detail, dict):
                detail = detail.get("message") or detail.get("code") or detail
            raise TranslationProviderError(f"DashScope HTTP {r.status}: {detail}", f"upstream_http_{r.status}")
        content = ((body.get("choices") or [{}])[0].get("message") or {}).get("content")
        if content:
            return str(content).strip()
        raise TranslationProviderError("DashScope 返回空", "empty_output")

    raise RuntimeError(f"未知翻译源: {source}")


_TAG_TRANSLATION_TRAILING = " \t.,;:!?，。；：、…·"


def _normalize_tag_translation(translated: str) -> str:
    """译文输出规范化（Prompt Cards 标签风格）：全小写、首字母不大写、末尾统一英文逗号。"""
    text = (translated or "").strip()
    if not text:
        return translated or ""
    text = text.lower().rstrip(_TAG_TRANSLATION_TRAILING)
    return text + ","


class TranslationRouter:
    """统一翻译入口：缓存、provider 选择、QA、熔断和可解释错误都在此处。"""

    @staticmethod
    def _effective_languages(source_text: str, source_language: str, target_language: str) -> tuple[str, str]:
        src = source_language.strip().lower() or "auto"
        dst = target_language.strip().lower() or "en"
        if src == "auto":
            src = "zh" if any("\u4e00" <= char <= "\u9fff" for char in source_text) else "en"
        return src, dst.split("-", 1)[0]

    @staticmethod
    def _success(source_text: str, translated: str, source_language: str, target_language: str,
                 provider: str, cache_type: str, attempts: dict[str, object] | None = None) -> dict[str, object]:
        translated = _normalize_tag_translation(translated)
        quality = _translation_quality(source_text, translated, source_language, target_language)
        return {
            "ok": True,
            "translatedText": translated,
            "source": provider,  # 兼容旧前端字段
            "provider": provider,
            "cacheType": cache_type,
            "fromCache": cache_type != "provider_call",
            "quality": quality,
            "attempts": attempts or {},
        }

    async def translate(self, text: str, langpair: str, want: str = "auto") -> dict[str, object]:
        source_text = str(text or "").strip()
        raw_src, _, raw_dst = (langpair or "en|zh-CN").partition("|")
        source_language, target_language = self._effective_languages(source_text, raw_src or "auto", raw_dst or "en")
        glossary = _get_glossary(source_text, source_language, target_language)
        if glossary:
            result = self._success(source_text, glossary["translated_text"], source_language, target_language, "user_glossary", "glossary")
            result["tagText"] = glossary["tag_text"]
            return result

        attempts: dict[str, object] = {}
        order = _provider_order_for(want)
        if not order:
            return {"ok": False, "error": f"翻译源 {want} 未配置或不可用", "error_code": "not_configured", "provider": want,
                    "attempts": attempts, "provider_status": _provider_snapshot(want) if want in _PROVIDER_STATES else None, "canUseAuto": want != "auto"}
        for provider in order:
            if _provider_is_cooling(provider):
                snapshot = _provider_snapshot(provider)
                attempts[provider] = {
                    "status": "skipped",
                    "error_code": "cooldown",
                    "cooldown_seconds": snapshot.get("cooldown_seconds", 0),
                }
                continue
            if not _provider_configured(provider):
                attempts[provider] = {"status": "skipped", "error_code": "not_configured"}
                if want != "auto":
                    break
                continue
            # local（本地词典）零成本且词典热重载后应立即生效，不读不写 provider cache，
            # 否则旧词典时代的缓存译文会永久锁死新词条。
            # local_llm（本地模型）同样不读不写：模型延迟 ~5ms，缓存零收益；且 NLLB 时代
            # 曾以同名 provider 写入劣质译文（"he was tied to his legs,"），会毒化 gemma/qwen 实时输出。
            cached = _get_provider_cache(source_text, source_language, target_language, provider) if provider not in ("local", "local_llm") else None
            if cached:
                quality = _translation_quality(source_text, cached, source_language, target_language)
                if quality["status"] != "rejected":
                    _provider_record_success(provider, 0.0)
                    return self._success(source_text, cached, source_language, target_language, provider, "provider_cache", attempts)
            started = time.perf_counter()
            try:
                translated = await _translate_via(provider, source_text, source_language, target_language)
                quality = _translation_quality(source_text, translated, source_language, target_language)
                if quality["status"] == "rejected":
                    raise _quality_error(quality)
                latency = (time.perf_counter() - started) * 1000
                if provider not in ("local", "local_llm"):
                    _put_provider_cache(source_text, source_language, target_language, provider, translated.strip())
                _provider_record_success(provider, latency)
                return self._success(source_text, translated.strip(), source_language, target_language, provider, "provider_call", attempts)
            except Exception as error:
                latency = (time.perf_counter() - started) * 1000
                error_code = _provider_record_failure(provider, error, latency)
                attempts[provider] = {
                    "status": "failed",
                    "error_code": error_code,
                    "error": str(error)[:400],
                    "latency_ms": round(latency, 1),
                }
                if want != "auto":
                    break
        return {
            "ok": False,
            "error": "所有翻译源均失败" if want == "auto" else f"翻译源 {want} 失败",
            "error_code": next((v.get("error_code") for v in attempts.values() if isinstance(v, dict) and v.get("error_code")), "provider_error"),
            "provider": want,
            "attempts": attempts,
            "provider_status": _provider_snapshot(want) if want != "auto" else None,
            "canUseAuto": want != "auto",
        }


_TRANSLATION_ROUTER = TranslationRouter()


@PromptServer.instance.routes.get("/anima/translate/baidu/config")
async def anima_baidu_translate_config_get(request):
    return web.json_response({"ok": True, **_baidu_config_snapshot()})


@PromptServer.instance.routes.post("/anima/translate/baidu/config")
async def anima_baidu_translate_config_save(request):
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return web.json_response({"ok": False, "error": "body 必须是 JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body 必须是对象"}, status=400)
    current = _load_baidu_config()
    appid = str(body.get("appid") or "").strip()
    api_key = str(body.get("api_key") or "").strip()
    if appid:
        current["appid"] = appid[:200]
    elif body.get("clear_appid") is True:
        current["appid"] = ""
    if api_key:
        current["api_key"] = api_key[:500]
    elif body.get("clear_api_key") is True:
        current["api_key"] = ""
    model_type = str(body.get("model_type") or current.get("model_type") or "llm").strip().lower()
    if model_type not in {"llm", "nmt"}:
        return web.json_response({"ok": False, "error": "model_type 只能是 llm 或 nmt"}, status=400)
    current["model_type"] = model_type
    current["need_intervene"] = bool(body.get("need_intervene", current.get("need_intervene", False)))
    try:
        _save_baidu_config(current)
    except OSError as error:
        return web.json_response({"ok": False, "error": f"百度配置保存失败: {error}"}, status=500)
    return web.json_response({"ok": True, **_baidu_config_snapshot()})


@PromptServer.instance.routes.post("/anima/translate/baidu/test")
async def anima_baidu_translate_test(request):
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    config = _load_baidu_config()
    for key in ("appid", "api_key"):
        value = str(body.get(key) or "").strip()
        if value:
            config[key] = value[:500 if key == "api_key" else 200]
    if body.get("model_type") in {"llm", "nmt"}:
        config["model_type"] = body["model_type"]
    if "need_intervene" in body:
        config["need_intervene"] = bool(body["need_intervene"])
    text = str(body.get("q") or "你好，世界").strip()[:2000]
    started = time.perf_counter()
    try:
        translated = await _translate_baidu(text, "auto", "en", config)
    except TranslationProviderError as error:
        _provider_record_failure("baidu", error, (time.perf_counter() - started) * 1000)
        return web.json_response({"ok": False, "error": str(error), "error_code": error.code}, status=502)
    except Exception as error:
        _provider_record_failure("baidu", error, (time.perf_counter() - started) * 1000)
        return web.json_response({"ok": False, "error": f"百度翻译测试失败: {error}", "error_code": "provider_error"}, status=502)
    _provider_record_success("baidu", (time.perf_counter() - started) * 1000)
    return web.json_response({"ok": True, "provider": "baidu", "translatedText": translated})


@PromptServer.instance.routes.get("/anima/translate/status")
async def anima_translate_status(request):
    result = {
        "providers": {provider: _provider_snapshot(provider) for provider in _TRANSLATE_ORDER},
        "actual_provider": _LAST_TRANSLATION_PROVIDER or None,
        "auto_order": _provider_order_for("auto"),
        "deeplx": _DEEPLX_MANAGER.status_sync(),
        "baidu": _baidu_config_snapshot(),
    }
    try:
        from .anima_local_llm import state_snapshot as _llm_state
        result["local_llm"] = _llm_state()
    except Exception:
        pass
    return web.json_response(result)


@PromptServer.instance.routes.post("/anima/translate/glossary")
async def anima_translate_glossary_save(request):
    try:
        body = await request.json()
    except (ValueError, AttributeError):
        return web.json_response({"ok": False, "error": "请求体必须是 JSON"}, status=400)
    source_text = str(body.get("source_text") or "").strip() if isinstance(body, dict) else ""
    translated_text = str(body.get("translated_text") or "").strip() if isinstance(body, dict) else ""
    tag_text = str(body.get("tag_text") or "").strip() if isinstance(body, dict) else ""
    if not source_text or not translated_text:
        return web.json_response({"ok": False, "error": "source_text 和 translated_text 不能为空"}, status=400)
    source_language = str(body.get("source_language") or ("zh" if any("\u4e00" <= c <= "\u9fff" for c in source_text) else "en")).strip().lower()
    target_language = str(body.get("target_language") or "en").strip().lower().split("-", 1)[0]
    if len(source_text) > 1000 or len(translated_text) > 2000 or len(tag_text) > 2000:
        return web.json_response({"ok": False, "error": "词典内容过长"}, status=400)
    _put_glossary(source_text, source_language, target_language, translated_text, tag_text)
    return web.json_response({"ok": True, "source_text": source_text, "translated_text": translated_text, "tag_text": tag_text})


@PromptServer.instance.routes.get("/anima/translate/glossary")
async def anima_translate_glossary_get(request):
    source_text = str(request.query.get("q") or "").strip()
    if not source_text:
        return web.json_response({"ok": True, "entry": None})
    source_language = str(request.query.get("source_language") or ("zh" if any("\u4e00" <= c <= "\u9fff" for c in source_text) else "en")).strip().lower()
    target_language = str(request.query.get("target_language") or "en").strip().lower().split("-", 1)[0]
    return web.json_response({"ok": True, "entry": _get_glossary(source_text, source_language, target_language)})


@PromptServer.instance.routes.post("/anima/translate/deeplx/restart")
async def anima_translate_deeplx_restart(request):
    return web.json_response(await _DEEPLX_MANAGER.restart())


@PromptServer.instance.routes.get("/api/translate")
async def proxy_translate(request):
    """多源翻译。参数：q 文本；langpair 如 en|zh-CN；source=auto|local|local_llm|deeplx|mymemory|google|dashscope
    （缺省 auto=按健康度/延迟动态回退；指定 source 始终只用该源）。
    返回 {ok, translatedText, source, attempts}。"""
    q = (request.query.get("q") or "").strip()
    if not q:
        return web.json_response({"ok": False, "error": "缺少 q 参数"}, status=400)
    langpair = request.query.get("langpair") or "en|zh-CN"
    want = (request.query.get("source") or "auto").strip().lower() or "auto"
    if want != "auto" and want not in _TRANSLATE_ORDER:
        return web.json_response({"ok": False, "error": f"未知翻译源: {want}"}, status=400)
    src_lang, dst_lang = langpair.split("|", 1) if "|" in langpair else ("en", "zh-CN")
    result = await _TRANSLATION_ROUTER.translate(q, langpair, want)
    return web.json_response(result, status=200 if result.get("ok") else 502)


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
