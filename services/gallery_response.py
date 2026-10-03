"""Generation-bound gallery JSON encoding; no disk or ComfyUI dependencies."""
from __future__ import annotations

import asyncio
import gzip
import json
from collections.abc import Callable


def accepts_gzip(value: str) -> bool:
    qualities = {}
    for item in str(value or "").split(","):
        parts = [part.strip() for part in item.split(";")]
        coding = parts[0].lower()
        if not coding:
            continue
        quality = 1.0
        for parameter in parts[1:]:
            key, separator, raw = parameter.partition("=")
            if separator and key.strip().lower() == "q":
                try:
                    quality = float(raw.strip())
                    if not 0 <= quality <= 1:
                        quality = 0.0
                except ValueError:
                    quality = 0.0
        qualities[coding] = quality
    return qualities.get("gzip", qualities.get("*", 0.0)) > 0


def _encode(payload: dict) -> tuple[bytes, bytes]:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return raw, gzip.compress(raw, compresslevel=1, mtime=0)


class GalleryResponseCache:
    """One ready generation and one shared pending encoding.

    The payload anchor holds its index entries alive, so an object identity in
    the generation key cannot be recycled while its bytes remain cached.
    """
    def __init__(self) -> None:
        self._generation = None
        self._bytes = None
        self._anchor = None
        self._pending_generation = None
        self._pending = None

    async def encode(self, payload: dict, generation, cacheable: bool,
                     is_current: Callable[[], bool]) -> tuple[bytes, bytes]:
        if not cacheable:
            return await asyncio.to_thread(_encode, payload)
        if self._generation == generation and self._bytes is not None:
            return self._bytes
        if self._pending_generation == generation and self._pending is not None:
            return await asyncio.shield(self._pending)

        async def generate():
            encoded = await asyncio.to_thread(_encode, payload)
            if is_current():
                self._generation = generation
                self._bytes = encoded
                self._anchor = payload
            return encoded

        task = asyncio.create_task(generate())
        self._pending_generation = generation
        self._pending = task
        # Cleanup belongs to the shared task, not a potentially cancelled waiter.
        def finished(done):
            if self._pending is done:
                self._pending_generation = None
                self._pending = None
            if not done.cancelled():
                done.exception()  # retrieve exceptions if every waiter cancelled
        task.add_done_callback(finished)
        return await asyncio.shield(task)
