"""Persistent server-side mirror for the browser Prompt library.

The UI still uses IndexedDB for fast local reads, but this module keeps a
merge-only copy under ``data/``.  The update mechanism deliberately excludes
that directory, so plugin updates cannot replace the user's prompt data.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
from typing import Any

from aiohttp import web
from server import PromptServer


PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PLUGIN_DIR, "data")
PROMPT_LIBRARY_PATH = os.path.join(DATA_DIR, "prompt_library.json")
PROMPT_LIBRARY_BACKUP_PATH = PROMPT_LIBRARY_PATH + ".bak"
PROMPT_LIBRARY_LOCK = threading.RLock()
PROMPT_LIBRARY_SCHEMA_VERSION = 1
MAX_PROMPT_LIBRARY_BYTES = 64 * 1024 * 1024


def _empty_snapshot() -> dict[str, Any]:
    return {
        "schemaVersion": PROMPT_LIBRARY_SCHEMA_VERSION,
        "updatedAt": 0,
        "categories": [],
        "prompts": [],
    }


def _record_id(record: Any) -> str:
    if not isinstance(record, dict):
        return ""
    return str(record.get("id") or "").strip()


def _updated_at(record: Any) -> int:
    if not isinstance(record, dict):
        return 0
    try:
        return int(record.get("updatedAt") or record.get("createdAt") or 0)
    except (TypeError, ValueError):
        return 0


def normalize_snapshot(payload: Any) -> dict[str, Any]:
    """Return a bounded, JSON-safe snapshot without changing user fields."""
    source = payload.get("snapshot") if isinstance(payload, dict) and isinstance(payload.get("snapshot"), dict) else payload
    if not isinstance(source, dict):
        return _empty_snapshot()

    categories = [item for item in source.get("categories", []) if isinstance(item, dict) and _record_id(item)]
    prompts = [item for item in source.get("prompts", []) if isinstance(item, dict) and _record_id(item)]
    snapshot = {
        "schemaVersion": PROMPT_LIBRARY_SCHEMA_VERSION,
        "updatedAt": int(source.get("updatedAt") or 0) if str(source.get("updatedAt") or "").isdigit() else 0,
        "categories": categories,
        "prompts": prompts,
    }
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_PROMPT_LIBRARY_BYTES:
        raise ValueError("Prompt 库备份超过 64MB 限制")
    return snapshot


def _merge_records(existing: list[dict[str, Any]], incoming: list[dict[str, Any]], *, prefer_newer: bool) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {_record_id(item): item for item in existing if _record_id(item)}
    for item in incoming:
        key = _record_id(item)
        if not key:
            continue
        previous = merged.get(key)
        if previous is None or not prefer_newer or _updated_at(item) >= _updated_at(previous):
            merged[key] = item
    return list(merged.values())


def merge_snapshots(existing: Any, incoming: Any) -> dict[str, Any]:
    """Merge by stable IDs; missing local records never erase the mirror."""
    old = normalize_snapshot(existing)
    new = normalize_snapshot(incoming)
    categories = _merge_records(old["categories"], new["categories"], prefer_newer=False)
    prompts = _merge_records(old["prompts"], new["prompts"], prefer_newer=True)
    return {
        "schemaVersion": PROMPT_LIBRARY_SCHEMA_VERSION,
        "updatedAt": max(int(old.get("updatedAt") or 0), int(new.get("updatedAt") or 0), int(time.time() * 1000)),
        "categories": categories,
        "prompts": prompts,
    }


def _read_file(path: str) -> dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return normalize_snapshot(json.load(handle))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def load_snapshot() -> tuple[dict[str, Any] | None, bool]:
    """Read the primary file, falling back to the previous atomic copy."""
    with PROMPT_LIBRARY_LOCK:
        primary = _read_file(PROMPT_LIBRARY_PATH)
        if primary is not None:
            return primary, False
        backup = _read_file(PROMPT_LIBRARY_BACKUP_PATH)
        return backup, backup is not None


def save_snapshot(snapshot: Any) -> dict[str, Any]:
    """Atomically write the mirror and retain one last-known-good backup."""
    normalized = normalize_snapshot(snapshot)
    normalized["updatedAt"] = int(time.time() * 1000)
    os.makedirs(DATA_DIR, exist_ok=True)
    encoded = json.dumps(normalized, ensure_ascii=False, indent=2) + "\n"
    with PROMPT_LIBRARY_LOCK:
        # 损坏的主文件不能覆盖仍然可用的 .bak；否则一次写入失败会同时
        # 消灭最后一份可回滚副本。
        if os.path.isfile(PROMPT_LIBRARY_PATH) and _read_file(PROMPT_LIBRARY_PATH) is not None:
            try:
                shutil.copy2(PROMPT_LIBRARY_PATH, PROMPT_LIBRARY_BACKUP_PATH)
            except OSError:
                pass
        fd, temporary = tempfile.mkstemp(prefix="prompt-library-", suffix=".json", dir=DATA_DIR)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, PROMPT_LIBRARY_PATH)
        finally:
            if os.path.exists(temporary):
                try:
                    os.remove(temporary)
                except OSError:
                    pass
    return normalized


@PromptServer.instance.routes.get("/anima/prompt-library")
async def prompt_library_get(request: web.Request) -> web.Response:
    """Return the durable Prompt mirror shared by localhost/127.0.0.1 users."""
    snapshot, recovered = load_snapshot()
    return web.json_response({"ok": True, "snapshot": snapshot, "recoveredFromBackup": recovered})


@PromptServer.instance.routes.post("/anima/prompt-library")
async def prompt_library_save(request: web.Request) -> web.Response:
    """Merge a browser snapshot into the durable mirror and write atomically."""
    try:
        raw = await request.read()
        if len(raw) > MAX_PROMPT_LIBRARY_BYTES:
            return web.json_response({"ok": False, "error": "Prompt 库备份超过 64MB 限制"}, status=413)
        payload = json.loads(raw.decode("utf-8"))
        incoming = normalize_snapshot(payload)
        existing, _ = load_snapshot()
        merged = merge_snapshots(existing or _empty_snapshot(), incoming)
        saved = save_snapshot(merged)
        return web.json_response({
            "ok": True,
            "updatedAt": saved["updatedAt"],
            "categories": len(saved["categories"]),
            "prompts": len(saved["prompts"]),
        })
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except OSError as error:
        return web.json_response({"ok": False, "error": f"Prompt 库落盘失败：{error}"}, status=500)
