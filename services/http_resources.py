"""Async HTTP ownership: proxy generations retire after their last response closes."""
from __future__ import annotations

import asyncio
import os
import re
import socket
import time
from contextlib import asynccontextmanager

import aiohttp


def detect_proxy(setting=lambda *_: None):
    for address in (setting("proxy"), os.environ.get("ANIMA_PROXY"),
                    "http://127.0.0.1:7890", "http://127.0.0.1:7897", "http://127.0.0.1:10809"):
        match = re.match(r"https?://([^:/]+):(\d+)", address or "")
        if not match:
            continue
        try:
            with socket.create_connection((match[1], int(match[2])), timeout=0.8):
                return address
        except OSError:
            continue
    return None


class HttpResources:
    def __init__(self, resolve_proxy, session_factory=aiohttp.ClientSession, clock=time.monotonic):
        self._resolve_proxy = resolve_proxy
        self._factory = session_factory
        self._clock = clock
        self._lock = None
        self._current = None
        self._generations = []
        self._probe_at = 0
        self._closing = False
        self._drained = None
        self._loop = None

    @property
    def closed(self):
        return self._closing

    async def _acquire(self):
        loop = asyncio.get_running_loop()
        if self._loop is None:
            # Bind when the first response is created, never during an import
            # running in tk-hotreload's short-lived loader loop.
            self._loop = loop
        elif self._loop is not loop:
            raise RuntimeError("Toolkit HTTP requests must use their owner loop")
        if self._lock is None:
            self._lock = asyncio.Lock()
            self._drained = asyncio.Event()
            self._drained.set()
        async with self._lock:
            if self._closing:
                raise RuntimeError("Toolkit HTTP resources are closed")
            now = self._clock()
            current = self._current
            if current is None or now >= self._probe_at:
                proxy = await asyncio.to_thread(self._resolve_proxy)
                self._probe_at = now + (60 if proxy else 10)
                if current is None or proxy != current["proxy"]:
                    kwargs = {"headers": {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"},
                              "timeout": aiohttp.ClientTimeout(total=30), "trust_env": True}
                    generation = {"session": self._factory(**kwargs), "proxy": proxy,
                                  "users": 0, "retired": False}
                    self._generations.append(generation)
                    self._current = generation
                    if current is not None:
                        current["retired"] = True
                        if not current["users"]:
                            await current["session"].close()
                            self._generations.remove(current)
                    current = generation
            current["users"] += 1
            self._drained.clear()
            return current

    @asynccontextmanager
    async def request(self, method, url, **kwargs):
        generation = await self._acquire()
        try:
            # aiohttp 3.9 supports proxy on requests, while the session-level
            # default was added later. Preserve an explicit caller override.
            kwargs.setdefault("proxy", generation["proxy"])
            async with generation["session"].request(method, url, **kwargs) as response:
                yield response
        finally:
            async with self._lock:
                generation["users"] -= 1
                if not generation["users"] and generation["retired"]:
                    await generation["session"].close()
                    self._generations.remove(generation)
                if not any(item["users"] for item in self._generations):
                    self._drained.set()

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    async def close(self):
        if self._loop is not None and self._loop is not asyncio.get_running_loop() and self._loop.is_running():
            closing = asyncio.run_coroutine_threadsafe(self._close_on_owner_loop(), self._loop)
            await asyncio.shield(asyncio.wrap_future(closing))
            return
        await self._close_on_owner_loop()

    async def _close_on_owner_loop(self):
        if self._lock is not None:
            async with self._lock:
                self._closing = True
        else:
            self._closing = True
        if self._drained is not None:
            await self._drained.wait()
        for item in self._generations:
            await item["session"].close()
        self._generations.clear()
        self._current = None


def install(app, resources):
    """Keep one app hook; replaced owners drain even after signals are frozen."""
    key = "tk.toolkit.http-resources"
    slot = app.get(key)
    if slot is not None:
        owner = slot["owner"]
        if owner is resources:
            return
        if owner is not None and not owner.closed:
            owner._closing = True
            loop = owner._loop
            if loop is None or not loop.is_running():
                slot["pending"].append(owner)
            else:
                # The import loop may close as soon as registration returns.
                # A concurrent future retains retirement on the response loop.
                slot["retiring"].append(asyncio.run_coroutine_threadsafe(owner.close(), loop))
        slot["owner"] = resources
        return

    slot = {"owner": resources, "retiring": [], "pending": []}

    async def shutdown(_app):
        owner = slot["owner"]
        if owner is not None:
            await owner.close()
        for pending in slot["pending"]:
            await pending.close()
        if slot["retiring"]:
            await asyncio.gather(*(asyncio.shield(asyncio.wrap_future(item)) for item in slot["retiring"]))
        slot["pending"].clear()
        slot["retiring"].clear()
        slot["owner"] = None

    app[key] = slot
    app.on_shutdown.append(shutdown)
