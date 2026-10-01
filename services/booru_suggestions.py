"""Bounded, source-specific tag lookup using the public booru search protocols.

Safebooru: /autocomplete.php?q=prefix (value + label/count).
Moebooru: /tag.json?name=fragment&order=count (current controller uses name,
not the name_pattern parameter in the older API documentation).
Website scripts are references only; no upstream JavaScript is executed here.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from copy import deepcopy
import fnmatch
import json
import re
import threading
import time
import urllib.parse
from typing import Any, Callable

from aiohttp import web

_HOSTS = {"safebooru": "safebooru.org", "yandere": "yande.re", "konachan": "konachan.net"}
_TYPES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "circle", 6: "faults"}
MAX_RESPONSE_BYTES = 256 * 1024
MAX_CHOICES = 20
CACHE_LIMIT = 256
CACHE_SECONDS = 300
_CACHE: OrderedDict[tuple[str, str], tuple[float, dict[str, Any]]] = OrderedDict()
_LOCK = threading.Lock()
_SLOTS = threading.BoundedSemaphore(3)


def _matches(name: str, query: str) -> bool:
    return fnmatch.fnmatchcase(name, query) if "*" in query else query in name


def _parse(source: str, payload: Any, query: str) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError("标签接口返回非列表")
    rows = []
    seen = set()
    for raw in payload[:100]:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("value" if source == "safebooru" else "name") or "").strip()
        if not name or len(name) > 200 or any(c.isspace() for c in name) or name in seen:
            continue
        if not _matches(name.lower(), query):
            continue
        seen.add(name)
        count = raw.get("count")
        if source == "safebooru" and count is None:
            match = re.search(r"\((\d+)\)\s*$", str(raw.get("label") or ""))
            count = match.group(1) if match else None
        try:
            count = max(0, int(count)) if count is not None else None
        except (TypeError, ValueError, OverflowError):
            count = None
        try:
            tag_type = int(raw["type"])
            category = ({5: "style", 6: "circle"}.get(tag_type, _TYPES.get(tag_type, "tag"))
                        if source == "konachan" else _TYPES.get(tag_type, "tag"))
        except (KeyError, TypeError, ValueError, OverflowError):
            category = "tag"
        rows.append({"tag": name, "postCount": count, "category": category})
        if len(rows) == MAX_CHOICES:
            break
    return rows


def lookup(source: str, query: str, http_get: Callable[..., tuple[bytes, str]]) -> dict[str, Any]:
    """Return normalized candidates; failed lookups never poison the cache."""
    if source not in _HOSTS:
        raise ValueError("不支持的标签图源")
    query = str(query or "").strip().lower()
    reply: dict[str, Any] = {"source": source, "suggestions": [], "suggestionDetails": [], "warnings": []}
    if not query or len(query) > 100 or any(c.isspace() or ord(c) < 32 for c in query) or ":" in query:
        return reply
    # Safebooru's official autocomplete is prefix-only. Wildcard expressions
    # remain valid searches, but should not be sent as autocomplete prefixes.
    if source == "safebooru" and "*" in query:
        return reply
    key = (source, query)
    now = time.monotonic()
    with _LOCK:
        cached = _CACHE.get(key)
        if cached and cached[0] > now:
            _CACHE.move_to_end(key)
            return deepcopy(cached[1])
        _CACHE.pop(key, None)
    if not _SLOTS.acquire(blocking=False):
        reply["warnings"] = ["标签联想繁忙，可直接回车搜索或稍后重试"]
        return reply
    try:
        if source == "safebooru":
            endpoint = "https://safebooru.org/autocomplete.php"
            params = {"q": query}
        else:
            endpoint = "https://" + _HOSTS[source] + "/tag.json"
            params = {"name": query, "order": "count", "limit": MAX_CHOICES}
        body, _ = http_get(endpoint + "?" + urllib.parse.urlencode(params), read_timeout=6.0, max_bytes=MAX_RESPONSE_BYTES)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError("标签响应过大")
        rows = _parse(source, json.loads(body.decode("utf-8")), query)
        reply["suggestionDetails"] = rows
        reply["suggestions"] = [row["tag"] for row in rows]
        with _LOCK:
            _CACHE[key] = (time.monotonic() + CACHE_SECONDS, deepcopy(reply))
            _CACHE.move_to_end(key)
            while len(_CACHE) > CACHE_LIMIT:
                _CACHE.popitem(last=False)
    except Exception:
        reply["warnings"] = ["标签联想暂不可用，可直接回车搜索或重试"]
    finally:
        _SLOTS.release()
    return reply


async def suggest_response(request: web.Request, source: str, http_get: Callable[..., tuple[bytes, str]]) -> web.Response:
    result = await asyncio.to_thread(lookup, source, request.query.get("q", ""), http_get)
    return web.json_response(result)
