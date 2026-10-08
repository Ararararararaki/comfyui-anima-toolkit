"""One owner for local LoRA hashes, upstream metadata and archive fallback."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import threading
import time

import aiohttp
from aiohttp import web

IMAGE_PREFIX = "https://image.civitai.com/"
NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)
ARCHIVE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
}


class LoraMetadata:
    def __init__(self, find_file, session_getter, *, hash_file=None, ttl=300):
        self._find_file = find_file
        self._session_getter = session_getter
        self._hash_file = hash_file or self.sha256
        self._ttl = ttl
        self._cache = {}
        self._inflight = {}
        self._hashes = {}
        self._hash_lock = threading.Lock()

    def sha256(self, path):
        key = os.path.normcase(os.path.abspath(path))
        before = os.stat(path)
        fingerprint = (before.st_mtime_ns, before.st_size)
        with self._hash_lock:
            cached = self._hashes.get(key)
            if cached and cached[:2] == fingerprint:
                return cached[2]
        digest = hashlib.sha256()
        with open(path, "rb") as stream:
            for chunk in iter(lambda: stream.read(65536), b""):
                digest.update(chunk)
        value = digest.hexdigest()
        after = os.stat(path)
        if fingerprint == (after.st_mtime_ns, after.st_size):
            with self._hash_lock:
                self._hashes[key] = (*fingerprint, value)
        return value

    async def get_info(self, name):
        cached = self._cache.get(name)
        if cached and cached[0] > time.time():
            return dict(cached[1])
        task = self._inflight.get(name)
        if task is None:
            async def lookup():
                try:
                    result = await self._resolve(name)
                    # Transport failures should be retried when the user reopens the panel.
                    if result.get("source") in {"civitai", "civitaiarchive", "not_on_civitai"}:
                        now = time.time()
                        self._cache = {key: item for key, item in self._cache.items() if item[0] > now}
                        self._cache[name] = (now + self._ttl, result)
                    return result
                finally:
                    self._inflight.pop(name, None)
            task = asyncio.create_task(lookup())
            self._inflight[name] = task
        return dict(await asyncio.shield(task))

    async def archive_info(self, sha256, name=""):
        try:
            session = await self._session_getter()
            async with session.get(f"https://civitaiarchive.com/sha256/{sha256}",
                                   headers=ARCHIVE_HEADERS,
                                   timeout=aiohttp.ClientTimeout(total=15)) as response:
                if response.status != 200:
                    return None
                html = await response.text()
            match = NEXT_DATA.search(html or "")
            props = (json.loads(match.group(1)).get("props") or {}).get("pageProps") if match else None
            if not isinstance(props, dict):
                return None
            model = next((item for item in props.get("models") or [] if isinstance(item, dict)
                          and item.get("platform", "civitai") == "civitai" and item.get("name")), None)
            if model is None:
                return None
            version = model.get("version") if isinstance(model.get("version"), dict) else {}
            images = [image["url"] for image in version.get("images") or []
                      if isinstance(image, dict) and str(image.get("url") or "").startswith(IMAGE_PREFIX)]
            return {
                "name": name, "trainedWords": [w for w in version.get("trigger") or [] if isinstance(w, str) and w.strip()],
                "tags": [tag for tag in model.get("tags") or [] if isinstance(tag, str)],
                "modelName": model.get("name") or "", "versionName": version.get("name") or "",
                "versionId": version.get("id"), "modelId": model.get("id"),
                "creator": model.get("creator_name") or model.get("username") or "",
                "previewUrl": images[0] if images else None, "images": images,
                "baseModel": version.get("base_model") or "", "description": model.get("description") or "",
                "downloadCount": model.get("download_count") or 0, "thumbsUpCount": model.get("favorite_count") or 0,
                "nsfw": bool(model.get("is_nsfw") or version.get("is_nsfw")),
                "deletedAt": version.get("deleted_at"), "source": "civitaiarchive",
            }
        except Exception as error:
            print(f"[anima/archive] 取数失败 {type(error).__name__}: {error}", flush=True)
            return None

    async def _resolve(self, name):
        path = self._find_file(name)
        if path is None:
            return {"name": name, "trainedWords": [], "modelName": None, "previewUrl": None, "source": "not_found"}
        try:
            sha256 = await asyncio.to_thread(self._hash_file, path)
        except Exception as error:
            return {"error": f"SHA256 failed: {error}"}
        empty = {"name": name, "trainedWords": [], "modelName": None, "previewUrl": None}
        try:
            session = await self._session_getter()
            async with session.get(f"https://civitai.com/api/v1/model-versions/by-hash/{sha256}",
                                   timeout=aiohttp.ClientTimeout(total=10)) as response:
                if response.status == 200:
                    data = await response.json()
                    model = data.get("model") or {}
                    creator = model.get("creator") or ""
                    images = data.get("images") or []
                    result = {
                        **empty, "trainedWords": data.get("trainedWords") or [], "tags": model.get("tags") or [],
                        "modelName": model.get("name") or data.get("modelName") or "",
                        "versionName": data.get("name") or "", "versionId": data.get("id"),
                        "modelId": model.get("id") or data.get("modelId"),
                        "creator": (creator.get("username") or "") if isinstance(creator, dict) else creator,
                        "previewUrl": images[0].get("url") if images else None,
                        "images": [image.get("url") for image in images if isinstance(image, dict) and image.get("url")],
                        "baseModel": data.get("baseModel") or "", "description": data.get("description") or "",
                        "source": "civitai",
                    }
                else:
                    result = {**empty, "source": "not_on_civitai" if response.status == 404 else f"http_{response.status}"}
        except Exception as error:
            result = {**empty, "source": f"error_{error}"}
        if not result.get("modelName"):
            result = await self.archive_info(sha256, name) or result
        return result


_service = None


def configure(find_file, session_getter):
    global _service
    _service = LoraMetadata(find_file, session_getter)
    return _service


async def get_info(name):
    return await _service.get_info(name)


async def lora_info(request):
    name = request.query.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    result = await get_info(name)
    return web.json_response(result, status=500 if "error" in result else 200)


async def archive_lora_info(request):
    sha256 = request.query.get("sha256", "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        return web.json_response({"error": "valid SHA256 required"}, status=400)
    return web.json_response(await _service.archive_info(sha256))


def register_routes(routes):
    routes.get("/anima/lora/info")(lora_info)
    routes.get("/anima/lora/archive")(archive_lora_info)
