"""Persistent server-side mirror for the browser Prompt library.

The UI still uses IndexedDB for fast local reads, but this module keeps a
merge-only copy under ``data/``.  The update mechanism deliberately excludes
that directory, so plugin updates cannot replace the user's prompt data.

删除走墓碑机制：前端删除的记录 id 追加进镜像顶层的 ``deletedIds``，
merge-only 同步据此丢弃对应记录，避免"本地删除、同步复活"。
落盘前会把上一版主文件轮换备份到 ``.bak.1`` ~ ``.bak.5``。
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
PROMPT_LIBRARY_BACKUP_COUNT = 5
# ⚠️ 这些**派生**路径必须是「按当前 PROMPT_LIBRARY_PATH 现算」的，不能在导入时固化成常量：
#   固化后一旦 DATA_DIR / PROMPT_LIBRARY_PATH 被改（测试隔离必做），主文件写去新位置、
#   备份却仍写在**导入时**的旧位置 —— 实测会把测试数据写进仓库/安装目录的 data/，
#   而 load_snapshot 又去新位置找备份，等于备份链整体失效。
# 下面两个常量保留只为兼容旧引用（值是导入时快照），内部逻辑一律走函数。
def _backup_paths(primary_path: str | None = None) -> list[str]:
    base = primary_path or PROMPT_LIBRARY_PATH
    return [f"{base}.bak.{index}" for index in range(1, PROMPT_LIBRARY_BACKUP_COUNT + 1)]


def _legacy_backup_path(primary_path: str | None = None) -> str:
    return (primary_path or PROMPT_LIBRARY_PATH) + ".bak"


PROMPT_LIBRARY_BACKUP_PATHS = _backup_paths()
PROMPT_LIBRARY_LEGACY_BACKUP_PATH = _legacy_backup_path()
PROMPT_LIBRARY_LOCK = threading.RLock()
PROMPT_LIBRARY_SCHEMA_VERSION = 1
MAX_PROMPT_LIBRARY_BYTES = 64 * 1024 * 1024
SNAPSHOT_TOO_LARGE_ERROR = "镜像超过 64MB 上限，无法保存"


class SnapshotTooLargeError(ValueError):
    """镜像序列化后超过 64MB 上限。"""


def _empty_snapshot() -> dict[str, Any]:
    return {
        "schemaVersion": PROMPT_LIBRARY_SCHEMA_VERSION,
        "updatedAt": 0,
        "categories": [],
        "prompts": [],
        "deletedIds": [],
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


def _deleted_id_key(value: Any) -> str:
    """墓碑 id 与记录 id 一律按字符串形式比对。"""
    return str(value).strip()


def _normalize_deleted_ids(values: Any) -> list[Any]:
    """只保留数字/字符串 id，去重时保留每个 id 原有的 JSON 类型。"""
    if not isinstance(values, list):
        return []
    normalized: list[Any] = []
    seen: set[str] = set()
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            continue
        key = _deleted_id_key(value)
        if not key or key in seen:
            continue
        seen.add(key)
        normalized.append(value)
    return normalized


def _append_deleted_ids(base: Any, extra: Any) -> list[Any]:
    """合并两份墓碑列表，冲突时保留先出现的那个。"""
    return _normalize_deleted_ids([*_normalize_deleted_ids(base), *_normalize_deleted_ids(extra)])


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
        "deletedIds": _normalize_deleted_ids(source.get("deletedIds")),
    }
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_PROMPT_LIBRARY_BYTES:
        raise SnapshotTooLargeError(SNAPSHOT_TOO_LARGE_ERROR)
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
    """Merge by stable IDs; missing local records never erase the mirror.

    墓碑 id 只增不减：即使本地把已删除的记录重新推上来，也会被丢弃。
    """
    old = normalize_snapshot(existing)
    new = normalize_snapshot(incoming)
    deleted_ids = _append_deleted_ids(old["deletedIds"], new["deletedIds"])
    tombstones = {_deleted_id_key(item) for item in deleted_ids}
    categories = [item for item in _merge_records(old["categories"], new["categories"], prefer_newer=False) if _record_id(item) not in tombstones]
    prompts = [item for item in _merge_records(old["prompts"], new["prompts"], prefer_newer=True) if _record_id(item) not in tombstones]
    return {
        "schemaVersion": PROMPT_LIBRARY_SCHEMA_VERSION,
        "updatedAt": max(int(old.get("updatedAt") or 0), int(new.get("updatedAt") or 0), int(time.time() * 1000)),
        "categories": categories,
        "prompts": prompts,
        "deletedIds": deleted_ids,
    }


def _read_file(path: str) -> dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return normalize_snapshot(json.load(handle))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def load_snapshot() -> tuple[dict[str, Any] | None, bool]:
    """Read the primary file, falling back to the newest available backup."""
    with PROMPT_LIBRARY_LOCK:
        primary = _read_file(PROMPT_LIBRARY_PATH)
        if primary is not None:
            return primary, False
        # .bak.1 是最近一代备份，依次回退；最后再试旧版单文件 .bak。
        for path in (*_backup_paths(), _legacy_backup_path()):
            backup = _read_file(path)
            if backup is not None:
                return backup, True
        return None, False


def _rotate_backups() -> None:
    """Shift .bak.1~.bak.5 by one generation and drop the oldest copy."""
    paths = _backup_paths()
    oldest = paths[-1]
    if os.path.exists(oldest):
        try:
            os.remove(oldest)
        except OSError:
            pass
    for index in range(PROMPT_LIBRARY_BACKUP_COUNT - 1, 0, -1):
        if os.path.exists(paths[index - 1]):
            try:
                os.replace(paths[index - 1], paths[index])
            except OSError:
                pass
    try:
        shutil.copy2(PROMPT_LIBRARY_PATH, paths[0])
    except OSError:
        pass


def save_snapshot(snapshot: Any) -> dict[str, Any]:
    """Atomically write the mirror and rotate the last five known-good backups."""
    normalized = normalize_snapshot(snapshot)
    normalized["updatedAt"] = int(time.time() * 1000)
    os.makedirs(DATA_DIR, exist_ok=True)
    encoded = json.dumps(normalized, ensure_ascii=False, indent=2) + "\n"
    with PROMPT_LIBRARY_LOCK:
        # 损坏的主文件不能进入备份轮换；否则一次写入失败会同时
        # 消灭所有可回滚副本。
        if os.path.isfile(PROMPT_LIBRARY_PATH) and _read_file(PROMPT_LIBRARY_PATH) is not None:
            _rotate_backups()
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
            return web.json_response({"ok": False, "error": SNAPSHOT_TOO_LARGE_ERROR}, status=413)
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
    except SnapshotTooLargeError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=413)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except OSError as error:
        return web.json_response({"ok": False, "error": f"Prompt 库落盘失败：{error}"}, status=500)


@PromptServer.instance.routes.post("/anima/prompt-library/delete")
async def prompt_library_delete(request: web.Request) -> web.Response:
    """Append tombstones for the given ids and drop them from the mirror."""
    try:
        raw = await request.read()
        if len(raw) > MAX_PROMPT_LIBRARY_BYTES:
            return web.json_response({"ok": False, "error": SNAPSHOT_TOO_LARGE_ERROR}, status=413)
        payload = json.loads(raw.decode("utf-8"))
        ids = payload.get("ids") if isinstance(payload, dict) else None
        if not isinstance(ids, list):
            raise ValueError("ids 必须是数组")
        requested = _normalize_deleted_ids(ids)
        if not requested:
            raise ValueError("ids 不能为空")
        with PROMPT_LIBRARY_LOCK:
            current, _ = load_snapshot()
            snapshot = current or _empty_snapshot()
            deleted_ids = _append_deleted_ids(snapshot.get("deletedIds"), requested)
            tombstones = {_deleted_id_key(item) for item in deleted_ids}
            categories = [item for item in snapshot["categories"] if _record_id(item) not in tombstones]
            prompts = [item for item in snapshot["prompts"] if _record_id(item) not in tombstones]
            deleted_count = (len(snapshot["categories"]) - len(categories)) + (len(snapshot["prompts"]) - len(prompts))
            snapshot["categories"] = categories
            snapshot["prompts"] = prompts
            snapshot["deletedIds"] = deleted_ids
            save_snapshot(snapshot)
        return web.json_response({"ok": True, "deletedCount": deleted_count})
    except SnapshotTooLargeError as error:
        return web.json_response({"ok": False, "error": str(error)}, status=413)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
    except OSError as error:
        return web.json_response({"ok": False, "error": f"Prompt 库落盘失败：{error}"}, status=500)


@PromptServer.instance.routes.get("/anima/prompt-library/deleted")
async def prompt_library_deleted(request: web.Request) -> web.Response:
    """Return the tombstone list so clients can prune their local copies."""
    snapshot, _ = load_snapshot()
    deleted_ids = (snapshot or _empty_snapshot()).get("deletedIds", [])
    return web.json_response({"ok": True, "deletedIds": deleted_ids})
