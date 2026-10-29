"""Verified character metadata overlay. No model downloads, inferred aliases or image fetching.

An opt-in daily check is triggered by catalog use, never by importing this module.
The immutable shipped snapshot remains the offline base. One owner serializes
network refreshes and atomically persists validated additions with provenance.
"""
from __future__ import annotations

from copy import deepcopy
import atexit
import json
import math
from pathlib import Path
import re
import shutil
import sys
import threading
import time
import urllib.parse
import urllib.request

ANIMADEX = "https://animadex.net/api/characters/search"
DANBOORU = "https://danbooru.donmai.us/tags.json"
DAY = 86400


def error_label(error):
    return type(error).__name__ + (" HTTP " + str(error.code) if getattr(error, "code", None) else "")


def fetch_json(url, params):
    # Explicit proxy, including when no environment variables exist. No direct fallback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({
        "http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"}))
    request = urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers={
        "User-Agent": "ComfyUI-Anima-Toolkit/catalog-maintenance", "Accept": "application/json"})
    with opener.open(request, timeout=8) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("Catalog response exceeds metadata budget")
    return json.loads(data)


def records(payload, source, now):
    rows = payload.get("results") if isinstance(payload, dict) and source == "animadex" else payload
    if not isinstance(rows, list) or len(rows) > 200:
        raise ValueError("Unexpected character catalog response")
    result = []
    for item in rows:
        if not isinstance(item, dict):
            raise ValueError("Invalid character catalog row")
        slug = item.get("slug") if source == "animadex" else item.get("name")
        if not isinstance(slug, str) or not slug.strip() or len(slug) > 240:
            raise ValueError("Invalid character catalog identity")
        if source == "danbooru" and (item.get("category") != 4 or item.get("is_deprecated")):
            continue
        tags = item.get("tags", []) if source == "animadex" else []
        if not isinstance(tags, list) or any(not isinstance(tag, str) or len(tag) > 240 for tag in tags):
            raise ValueError("Invalid character traits")
        count = item.get("count", 0) if source == "animadex" else item.get("post_count", 0)
        if type(count) is not int or count < 0:
            raise ValueError("Invalid character popularity")
        row = {"slug": slug.strip(), "name": str(item.get("name") or slug)[:240],
               "trigger": str(item.get("trigger") or slug)[:1000] if source == "animadex" else slug,
               "copyright_name": str(item.get("copyright_name") or "")[:240],
               "tags": tags[:200], "count": count,
               "thumb_url": str(item.get("thumb_url") or "")[:2000] if source == "animadex" else "",
               "source": source, "source_url": ANIMADEX if source == "animadex" else DANBOORU,
               "fetched_at": now}
        result.append(row)
    return result


class CharacterCatalog:
    def __init__(self, directory, *, fetch=fetch_json, clock=time.time, idle=lambda: True, poll_seconds=900):
        self.path = Path(directory) / "characters.json"
        self.fetch, self.clock, self.idle = fetch, clock, idle
        self.lock = threading.RLock()
        self.running = False
        self.closed = False
        self.worker = None
        self.poll_seconds = poll_seconds
        self.scheduler = None
        self.scheduler_stop = threading.Event()
        self.pending = set()
        self.misses = {}
        self.load_error = ""
        self.data = {"version": 1, "enabled": False, "lookup_missing": True,
                     "last_attempt": 0, "last_success": 0, "cursor": 1, "revision": 0, "records": {}, "errors": {}}
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if loaded.get("version") != 1 or not isinstance(loaded.get("records"), dict):
                    raise ValueError("Unsupported catalog overlay")
                if type(loaded.get("enabled")) is not bool or type(loaded.get("lookup_missing")) is not bool:
                    raise ValueError("Invalid maintenance settings")
                for key, row in loaded["records"].items():
                    if row.get("source") not in ("animadex", "danbooru") or key != row.get("slug"):
                        raise ValueError("Invalid persisted row")
                    records({"results": [row]}, "animadex", row.get("fetched_at"))
                    if not isinstance(row.get("fetched_at"), (int, float)) or not math.isfinite(row["fetched_at"]):
                        raise ValueError("Invalid catalog timestamp")
                if (type(loaded.get("cursor")) is not int or loaded["cursor"] < 1 or
                        type(loaded.get("revision", 0)) is not int or
                        any(not isinstance(loaded.get(key), (int, float)) or not math.isfinite(loaded[key]) for key in ("last_attempt", "last_success"))):
                    raise ValueError("Invalid maintenance cursor/timestamps")
                self.data.update(loaded)
            except (OSError, ValueError, TypeError, AttributeError) as error:
                self.load_error = type(error).__name__ + ": invalid catalog file; original preserved"

    def status(self):
        with self.lock:
            return {key: deepcopy(value) for key, value in self.data.items() if key != "records"} | {
                "running": self.running, "characters": len(self.data["records"]),
                "load_error": self.load_error, "interval_hours": 24,
                "policy": "daily-while-used; missing-character lookup; no model-vocabulary guarantee"}

    def _commit(self, update):
        # Caller holds lock. Never overwrite an unreadable overlay.
        if self.load_error:
            raise ValueError(self.load_error)
        update = {**update, "revision": self.data["revision"] + 1}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        pending = self.path.with_suffix(".pending")
        try:
            pending.write_text(json.dumps(update, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            if self.path.exists():
                shutil.copy2(self.path, self.path.with_suffix(".previous.json"))
            pending.replace(self.path)
        finally:
            pending.unlink(missing_ok=True)
        self.data = update

    def configure(self, update):
        if set(update) - {"enabled", "lookup_missing"} or any(type(v) is not bool for v in update.values()):
            raise ValueError("Maintenance settings must be booleans")
        with self.lock:
            self._commit({**self.data, **update})
            if not self.data["enabled"]:
                self.scheduler_stop.set()
        return self.status()

    def touch(self):
        """Start one host-local waiter on first use; retry deferred work when idle."""
        with self.lock:
            if not self.closed and self.data["enabled"] and not self.load_error and not (
                    self.scheduler and self.scheduler.is_alive() and not self.scheduler_stop.is_set()):
                stop = threading.Event()
                self.scheduler_stop = stop
                def scheduler():
                    while not stop.wait(self.poll_seconds):
                        self.request_refresh()
                self.scheduler = threading.Thread(target=scheduler, name="tk-character-catalog-clock", daemon=True)
                self.scheduler.start()
        return self.request_refresh()

    def close(self):
        with self.lock:
            self.closed = True
            self.scheduler_stop.set()

    def overlay(self):
        with self.lock:
            return deepcopy(list(self.data["records"].values()))

    def fingerprint(self):
        with self.lock:
            return self.data["revision"]

    def _merge(self, batches, *, status=None):
        with self.lock:
            if self.closed:
                return
            update = deepcopy(self.data)
            for batch in batches:
                for row in batch:
                    old = update["records"].get(row["slug"], {})
                    # A canonical tag alone must not erase AnimaDex traits/series.
                    if row["source"] == "danbooru" and old.get("source") == "animadex":
                        continue
                    update["records"][row["slug"]] = {**old, **row}
            update.update(status or {})
            self._commit(update)

    def refresh(self):
        """One bounded batch: popular page + rotating page + newest canonical roles."""
        now = self.clock()
        with self.lock:
            cursor = self.data["cursor"]
        batches, errors = [], {}
        next_cursor = cursor
        try:
            for page in sorted({1, cursor}):
                payload = self.fetch(ANIMADEX, {"sort": "count", "page": page, "page_size": 100})
                batch = records(payload, "animadex", now)
                if type(payload.get("pages")) is not int or payload["pages"] < 1 or not batch:
                    raise ValueError("Missing AnimaDex pagination")
                batches.append(batch)
                if page == cursor:
                    next_cursor = cursor + 1 if cursor < payload["pages"] else 1
        except (OSError, ValueError, TypeError) as error:
            errors["animadex"] = error_label(error)
        try:
            batches.append(records(self.fetch(DANBOORU, {"search[category]": 4,
                "search[order]": "date", "search[hide_empty]": "yes", "limit": 200}), "danbooru", now))
        except (OSError, ValueError, TypeError) as error:
            errors["danbooru"] = error_label(error)
        self._merge(batches, status={"last_attempt": now, "errors": errors,
            "last_success": now if not errors else self.data["last_success"], "cursor": next_cursor})
        return self.status()

    def request_refresh(self, *, force=False):
        with self.lock:
            now = self.clock()
            if self.closed or self.running or self.load_error or (not force and (not self.data["enabled"] or
                    now - self.data["last_success"] < DAY or now - self.data["last_attempt"] < 3600)):
                return {"started": False, **self.status()}
            if not self.idle():
                return {"started": False, "deferred": "generation-active-or-memory-pressure", **self.status()}
            self.running = True
        def worker():
            try:
                self.refresh()
            except (OSError, ValueError, TypeError) as error:
                with self.lock:
                    self.data["errors"] = {"storage": type(error).__name__}
                    self.data["last_attempt"] = self.clock()
            finally:
                with self.lock:
                    self.running = False
        thread = threading.Thread(target=worker, name="tk-character-catalog-update", daemon=True)
        self.worker = thread
        thread.start()
        return {"started": True, **self.status()}

    def lookup(self, query):
        """Foreground miss only. Return source records; never assert a spatial match."""
        query = str(query).strip()
        with self.lock:
            if (not self.data["enabled"] or not self.data["lookup_missing"] or self.load_error or
                    not query or len(query) > 240 or query in self.pending or self.misses.get(query, 0) > self.clock()):
                return []
            self.pending.add(query)
        try:
            rows = records(self.fetch(ANIMADEX, {"q": query, "page": 1, "page_size": 3}), "animadex", self.clock())
            if not rows:
                canonical = re.sub(r"\s+", "_", query).lower()
                rows = records(self.fetch(DANBOORU, {"search[name]": canonical,
                    "search[category]": 4, "limit": 3}), "danbooru", self.clock())
                rows = [row for row in rows if row["slug"].casefold() == canonical.casefold()]
            if rows:
                self._merge([rows])
            with self.lock:
                if len(self.misses) >= 256:
                    self.misses.pop(next(iter(self.misses)))
                self.misses[query] = self.clock() + 3600
            return rows
        finally:
            with self.lock:
                self.pending.discard(query)


_OWNER = globals().get("_OWNER")
_OWNER_LOCK = globals().get("_OWNER_LOCK", threading.Lock())


def current():
    global _OWNER
    with _OWNER_LOCK:
        try:
            from ..anima_paths import plugin_root
        except ImportError:
            from anima_backend.anima_paths import plugin_root
        from .background_budget import defer_reason
        root = Path(plugin_root()).resolve()
        server = sys.modules.get("server")
        app = getattr(getattr(getattr(server, "PromptServer", None), "instance", None), "app", None)
        key = "tk.character_catalog:" + str(root)
        if app is not None:
            owner = app.get(key)
            if owner is None:
                owner = CharacterCatalog(root / "data" / "catalog-updates", idle=lambda: not defer_reason())
                app[key] = owner
                async def cleanup(_app):
                    owner.close()
                signal = getattr(app, "on_cleanup", None)
                if signal is not None and not getattr(signal, "frozen", False):
                    signal.append(cleanup)
                else:
                    # Late/hot-loaded plugins cannot mutate aiohttp's frozen signals.
                    atexit.register(owner.close)
            _OWNER = owner
        elif _OWNER is None:
            _OWNER = CharacterCatalog(root / "data" / "catalog-updates", idle=lambda: not defer_reason())
    return _OWNER
