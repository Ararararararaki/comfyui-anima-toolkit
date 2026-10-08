"""Model downloads: registered destinations, resumable transfers and owned tasks."""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import threading
import time

import aiohttp
from aiohttp import web

__all__ = ["configure", "register_routes", "shutdown"]


class _DownloadState:
    def __init__(self):
        self.progress = {}
        self.progress_lock = threading.Lock()
        self.tasks = {}
        self.active = set()
        self.retiring = set()
        self.queue_lock = asyncio.Lock()
        self.closing = False
        self.session_getter = None
        self.model_paths = None
        self.loop = None


try:
    _STATE
except NameError:
    _STATE = _DownloadState()


def configure(*, session_getter, model_paths):
    """Inject an async shared-session getter and ComfyUI's model-root lookup."""
    if not callable(session_getter) or not callable(model_paths):
        raise TypeError("session_getter and model_paths must be callable")
    if _STATE.closing:
        raise RuntimeError("Download service has shut down")
    _STATE.session_getter = session_getter
    _STATE.model_paths = model_paths


async def _get_session():
    if _STATE.session_getter is None:
        raise RuntimeError("Download service is not configured")
    return await _STATE.session_getter()


def _model_paths(folder_type):
    if _STATE.model_paths is None:
        raise RuntimeError("Download service is not configured")
    return _STATE.model_paths(folder_type)


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
            paths = _model_paths(folder_type) or []
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
        paths = _model_paths(folder_type) or []
    except Exception as error:
        raise ValueError(f"无法读取 ComfyUI 目录：{folder_type}") from error
    if index >= len(paths) or not str(paths[index] or "").strip():
        raise ValueError("下载目录不存在或未在 ComfyUI 注册")
    return os.path.normpath(str(paths[index])), folder_type


def _cleanup_progress(max_age: float = 600):
    """清理已结束且超过 max_age 秒未更新的下载进度记录。"""
    now = time.time()
    with _STATE.progress_lock:
        expired = [
            k for k, v in _STATE.progress.items()
            if v.get("status") not in {"queued", "downloading"} and now - v.get("ts", now) > max_age
        ]
        for k in expired:
            _STATE.progress.pop(k, None)


def _download_progress_update(progress_id: str, **fields):
    if not progress_id:
        return
    with _STATE.progress_lock:
        item = _STATE.progress.get(progress_id)
        if item is None:
            return
        item.update(fields)
        item["ts"] = time.time()


def _download_progress_cancelled(progress_id: str) -> bool:
    if not progress_id:
        return False
    with _STATE.progress_lock:
        return bool(_STATE.progress.get(progress_id, {}).get("cancel"))


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
        part_size = os.path.getsize(part_path) if part_path and os.path.exists(part_path) else 0
        _download_progress_update(progress_id, status="cancelled", done=part_size,
                                  resumable=bool(part_size), partial_path=part_path or "", error="已取消")
        raise
    except Exception as error:
        # 异常时保留 .part；它不会被 ComfyUI 当成模型，重新提交同一 URL 会从断点继续。
        part_size = os.path.getsize(part_path) if part_path and os.path.exists(part_path) else 0
        _download_progress_update(progress_id, status="error", done=part_size, resumable=bool(part_size),
                                  partial_path=part_path or "", error=str(error))
        return {"ok": False, "error": str(error), "resumable": bool(part_size), "_http_status": 500}


async def _run_background_lora_download(progress_id: str, item: dict):
    # 串行消费，避免多个前端同时打开时把带宽/磁盘 I/O 打满；任务仍独立于浏览器请求。
    try:
        async with _STATE.queue_lock:
            if _STATE.closing or _download_progress_cancelled(progress_id):
                _download_progress_update(progress_id, status="cancelled", error="已取消")
                return {"ok": False, "error": "已取消", "cancelled": True}
            _download_progress_update(progress_id, status="downloading")
            return await _perform_lora_download(
                version_id=item.get("versionId", ""),
                model_id=item.get("modelId", ""),
                fallback_name=item.get("name", ""),
                progress_id=progress_id,
                cookie=item.get("cookie", ""),
                token=item.get("token", ""),
                target_key=item.get("target", "auto"),
            )
    except asyncio.CancelledError:
        _download_progress_update(progress_id, status="cancelled", error="已取消")
        raise


def _track_download(progress_id: str, item: dict):
    state = _STATE
    loop = asyncio.get_running_loop()
    if state.active and state.loop is not loop:
        raise RuntimeError("Download tasks must use their owner loop")
    state.loop = loop
    task = asyncio.create_task(_run_background_lora_download(progress_id, item))
    state.tasks[progress_id] = task
    # The progress-ID lookup may be replaced by a later submission. Keep every
    # task owned separately so shutdown never loses an earlier transfer.
    state.active.add(task)

    def finished(done):
        state.active.discard(done)
        if state.tasks.get(progress_id) is done:
            state.tasks.pop(progress_id, None)
        if done.cancelled():
            _download_progress_update(progress_id, status="cancelled", error="已取消")
        else:
            error = done.exception()
            if error is not None:
                _download_progress_update(progress_id, status="error", error=str(error))

    task.add_done_callback(finished)
    return task


def _shutdown_response():
    return web.json_response({"ok": False, "error": "下载服务正在关闭"}, status=503)


async def lora_download(request):
    """兼容旧调用的同步下载接口；新前端使用 /download/queue。"""
    if _STATE.closing:
        return _shutdown_response()
    progress_id = request.query.get("progressId", "").strip()
    _cleanup_progress()
    if progress_id:
        with _STATE.progress_lock:
            _STATE.progress[progress_id] = {
                "progressId": progress_id, "done": 0, "total": 0, "status": "downloading",
                "filename": "", "label": request.query.get("name", "").strip(), "error": "", "ts": time.time(),
            }
    result = await _track_download(progress_id, {
        "versionId": request.query.get("versionId", "").strip(),
        "modelId": request.query.get("modelId", "").strip(),
        "name": request.query.get("name", "").strip(),
        "cookie": request.query.get("cookie", "").strip(),
        "token": request.query.get("token", "").strip(),
        "target": request.query.get("target", "auto").strip() or "auto",
    })
    status = int(result.pop("_http_status", 200 if result.get("ok") else 500))
    return web.json_response(result, status=status)


async def lora_download_queue(request):
    """提交一个或多个后台下载任务，浏览器关闭后任务仍由 ComfyUI 执行。"""
    if _STATE.closing:
        return _shutdown_response()
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求体必须是 JSON"}, status=400)
    if _STATE.closing:
        return _shutdown_response()
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
        with _STATE.progress_lock:
            _STATE.progress[progress_id] = {
                "progressId": progress_id, "done": 0, "total": 0, "status": "queued", "filename": "",
                "label": label, "url": str(raw.get("url") or "").strip()[:500], "error": "",
                "createdAt": time.time(), "ts": time.time(),
            }
        _track_download(progress_id, item)
        jobs.append({"progressId": progress_id, "label": label, "status": "queued"})
    if not jobs:
        return web.json_response({"ok": False, "error": "没有可提交的 versionId 或 modelId"}, status=400)
    return web.json_response({"ok": True, "jobs": jobs})


async def download_targets(request):
    """Return the registered ComfyUI model roots available to the download dialog."""
    return web.json_response({"ok": True, "targets": _download_target_options()})


async def download_status(request):
    pid = request.query.get("progressId", "").strip()
    with _STATE.progress_lock:
        p = dict(_STATE.progress.get(pid, {}))
    if not p:
        return web.json_response({"status": "not_found"})
    return web.json_response(p)


async def download_list(request):
    """返回近期后台任务，供关闭弹窗后重新打开时恢复进度。"""
    _cleanup_progress()
    with _STATE.progress_lock:
        jobs = [dict(item) for item in _STATE.progress.values()]
    jobs.sort(key=lambda item: item.get("createdAt", item.get("ts", 0)), reverse=True)
    return web.json_response({"ok": True, "jobs": jobs[:100]})


async def download_cancel(request):
    pid = request.query.get("progressId", "").strip()
    with _STATE.progress_lock:
        if pid in _STATE.progress:
            _STATE.progress[pid]["cancel"] = True
            if _STATE.progress[pid].get("status") == "queued":
                _STATE.progress[pid]["status"] = "cancelled"
            _STATE.progress[pid]["ts"] = time.time()
    return web.json_response({"ok": True})


async def _shutdown_state(state):
    if state.loop is not None and state.loop is not asyncio.get_running_loop() and state.loop.is_running():
        closing = asyncio.run_coroutine_threadsafe(_shutdown_state(state), state.loop)
        await asyncio.shield(asyncio.wrap_future(closing))
        return
    state.closing = True
    with state.progress_lock:
        for item in state.progress.values():
            if item.get("status") in {"queued", "downloading", "retrying"}:
                item.update(cancel=True, status="cancelled", error="已取消", ts=time.time())
    tasks = tuple(state.active)
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    if state.retiring:
        await asyncio.gather(*(asyncio.shield(asyncio.wrap_future(item)) for item in tuple(state.retiring)))
    state.active.clear()
    state.retiring.clear()
    state.tasks.clear()


async def shutdown(_app=None):
    """Stop accepting downloads, cancel transfers and await response/file cleanup."""
    await _shutdown_state(_STATE)


def register_routes(routes, *, app):
    """Register the download protocol and attach its owner to app shutdown."""
    definitions = (
        ("GET", "/anima/lora/download", lora_download),
        ("POST", "/anima/lora/download/queue", lora_download_queue),
        ("GET", "/anima/lora/download/targets", download_targets),
        ("GET", "/anima/lora/download/status", download_status),
        ("GET", "/anima/lora/download/list", download_list),
        ("GET", "/anima/lora/download/cancel", download_cancel),
    )
    existing = {(item.method, item.path, item.handler) for item in routes}
    for method, path, handler in definitions:
        if (method, path, handler) not in existing:
            getattr(routes, method.lower())(path)(handler)

    key = "tk.toolkit.downloads"
    slot = app.get(key)
    if slot:
        old_state = slot["state"]
        if old_state is _STATE:
            return
        old_state.closing = True
        if old_state.active or old_state.retiring:
            # A hot import must retire its old owner while retaining a task
            # that app shutdown can await, rather than dropping its dictionary.
            # Never create this task in the temporary module-loader loop: it
            # would cancel transfer cleanup again when asyncio.run() exits.
            loop = old_state.loop
            if loop is None:
                loop = next(iter(old_state.active)).get_loop()
            retirement = asyncio.run_coroutine_threadsafe(_shutdown_state(old_state), loop)
            _STATE.retiring.add(retirement)
            # Keep completed futures until shutdown also observes any failure.
            _STATE.loop = loop
        # aiohttp freezes its signals after startup. Keep the original callback
        # installed and only replace the owner it will shut down.
        slot["state"] = _STATE
        return

    slot = {"state": _STATE}

    async def app_shutdown(_app):
        await _shutdown_state(slot["state"])

    app[key] = slot
    # Shared HTTP resources wait for their leases to drain. Cancel downloads
    # first so a stalled response cannot keep HTTP shutdown waiting forever.
    app.on_shutdown.insert(0, app_shutdown)
