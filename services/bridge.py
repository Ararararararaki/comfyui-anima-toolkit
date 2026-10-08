"""One bridge owner: copied snapshots and durable updates of the existing asset."""
from __future__ import annotations

from copy import deepcopy
import asyncio
import json
import os
from pathlib import Path
import tempfile
import threading
import time

from aiohttp import web

__all__ = ["BridgeStore", "store", "register_routes"]


class BridgeStore:
    def __init__(self, path, *, clock=time.time):
        self.path = Path(path)
        self._clock = clock
        self._lock = threading.RLock()
        self._memory = {}

    def _file_snapshot(self):
        try:
            with self.path.open(encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def snapshot(self, source="auto"):
        """Copy memory/file state; auto retains the legacy empty-syntax fallback."""
        if source not in {"memory", "file", "auto"}:
            raise ValueError("Bridge snapshot source must be memory, file or auto")
        with self._lock:
            if source == "memory":
                return deepcopy(self._memory)
            if source == "file":
                return self._file_snapshot()
            if self._memory.get("loras"):
                return deepcopy(self._memory)
            return self._file_snapshot() or deepcopy(self._memory)

    def update(self, data):
        """Publish memory only after an atomic replace succeeds, under one lock."""
        if not isinstance(data, dict):
            raise ValueError("Bridge data must be a JSON object")
        candidate = deepcopy(data)
        with self._lock:
            candidate["_receivedAt"] = self._clock()
            # Serialize before opening a file so invalid data cannot disturb
            # the existing asset, and use a unique name for concurrent writers.
            encoded = json.dumps(candidate, ensure_ascii=False)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                                 prefix=self.path.name + ".", suffix=".tmp", delete=False) as handle:
                    temp_path = handle.name
                    handle.write(encoded)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_path, self.path)
                temp_path = None
                self._memory = candidate
            finally:
                if temp_path is not None:
                    try:
                        os.unlink(temp_path)
                    except OSError:
                        pass
            return deepcopy(candidate)

    def clear(self):
        """Delete the persisted fallback before clearing memory, under one lock."""
        with self._lock:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
            self._memory = {}


# Importing the service does not read user data. Retain the public owner when
# this service itself is reloaded; a whole package purge starts a fresh owner.
try:
    store
except NameError:
    store = BridgeStore(Path(__file__).resolve().parent.parent / "anima_bridge.json")


def register_routes(routes):
    """Keep the existing bridge update/clear protocol on the shared owner."""
    async def update(request):
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("Bridge data must be a JSON object")
        except Exception as error:
            return web.json_response({"ok": False, "error": str(error)}, status=400)
        try:
            data = await asyncio.to_thread(store.update, payload)
        except (OSError, TypeError, ValueError) as error:
            return web.json_response({"ok": False, "error": str(error)}, status=500)
        return web.json_response({"ok": True, "receivedAt": data["_receivedAt"]})

    async def clear(_request):
        try:
            await asyncio.to_thread(store.clear)
        except OSError as error:
            return web.json_response({"ok": False, "error": str(error)}, status=500)
        return web.json_response({"ok": True})

    routes.post("/anima/bridge/update")(update)
    routes.delete("/anima/bridge/update")(clear)
