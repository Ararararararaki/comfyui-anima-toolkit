"""One immutable JSON snapshot and a bounded change journal per output index.

Scanners prepare outside this owner's commit lock. Their commit preserves any
entry changed since preparation began, including deletions and known new files.
Only committed snapshots are published; readers never consume a partial file.
"""
from collections import deque
from contextlib import contextmanager
import json
import os
import tempfile
import threading
import time


JOURNAL_LIMIT = 256
_OWNERS = globals().get("_OWNERS", {})
_OWNERS_LOCK = globals().get("_OWNERS_LOCK", threading.Lock())
_MISSING = object()


class GalleryCatalog:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.lock = threading.RLock()
        self.index = None
        self.signature = None
        self.journal = deque(maxlen=JOURNAL_LIMIT)
        self.floor = 0
        self.pending = 0
        self.listeners = {}
        self.preparations = []
        self.read_view = None

    def _signature(self):
        try:
            stat = os.stat(self.path)
            return stat.st_mtime_ns, stat.st_size
        except OSError:
            return None

    @staticmethod
    def revision(index):
        try:
            return int(index.get("revision") or index.get("builtAt") or 0)
        except (ValueError, TypeError):
            return 0

    def snapshot(self, loader):
        # A committing writer owns a complete previous immutable snapshot. Readers
        # can consume it without waiting for JSON encoding and disk replacement.
        if not self.lock.acquire(blocking=self.index is None):
            return self.index
        try:
            signature = self._signature()
            if self.index is None or self.signature != signature:
                self.index = loader(self.path)
                self.signature = signature
                self.journal.clear()
                self.floor = self.revision(self.index)
                self.pending = sum(item.get("summaryStatus") == "pending" for item in self.index["entries"].values())
                self.read_view = {"index": self.index, "revision": self.revision(self.index), "pending": self.pending}
            return self.index
        finally:
            self.lock.release()

    def write(self, index):
        """Caller holds lock. Replace once, then publish the same complete object."""
        directory = os.path.dirname(self.path)
        os.makedirs(directory, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                             prefix=".gallery-index-", suffix=".tmp", delete=False) as handle:
                temporary = handle.name
                json.dump(index, handle, ensure_ascii=False, separators=(",", ":"))
            os.replace(temporary, self.path)
            temporary = None
        finally:
            if temporary is not None:
                os.unlink(temporary)
        previous_revision = self.revision(self.index or {})
        self.index = index
        self.signature = self._signature()
        self.pending = sum(item.get("summaryStatus") == "pending" for item in index["entries"].values())
        self.read_view = {"index": index, "revision": self.revision(index), "pending": self.pending}
        if self.revision(index) != previous_revision:
            for listener in tuple(self.listeners.values()):
                try:
                    listener(index)
                except Exception:
                    # Delivery is a notification; the committed index remains authoritative.
                    pass

    def subscribe(self, listener):
        token = object()
        with self.lock:
            self.listeners[token] = listener
        def unsubscribe():
            with self.lock:
                self.listeners.pop(token, None)
        return unsubscribe

    @contextmanager
    def prepare(self, loader):
        """Track concurrent path changes only for the lifetime of an active scan."""
        changed = set()
        with self.lock:
            baseline = self.snapshot(loader)
            self.preparations.append(changed)
        try:
            yield baseline, changed
        finally:
            with self.lock:
                self.preparations = [item for item in self.preparations if item is not changed]

    def commit(self, baseline, prepared, loader, *, force=False, concurrent=()):
        """Merge a prepared scan with concurrent commits; return snapshot + delta."""
        with self.lock:
            current = self.snapshot(loader)
            old_entries, entries = current["entries"], dict(prepared["entries"])
            baseline_entries = baseline["entries"]
            for path in baseline_entries.keys() | old_entries.keys() | set(concurrent):
                old = old_entries.get(path, _MISSING)
                if path in concurrent or old != baseline_entries.get(path, _MISSING):
                    if old is _MISSING:
                        entries.pop(path, None)
                    else:
                        entries[path] = old
            upserts = {path: entry for path, entry in entries.items() if entry != old_entries.get(path, _MISSING)}
            removed = sorted(path for path in old_entries if path not in entries)
            if not force and not upserts and not removed:
                return current, {}, []
            revision = max(1, self.revision(current) + 1)
            committed = {**prepared, "entries": entries, "total": len(entries),
                         "revision": revision,
                         "builtAt": max(int(time.time() * 1000), int(current.get("builtAt") or 0) + 1)}
            self.write(committed)
            for preparation in self.preparations:
                preparation.update(upserts)
                preparation.update(removed)
            self.journal.append((revision, upserts, removed))
            self.floor = max(self.floor, self.journal[0][0] - 1)
            return committed, upserts, removed

    def changes(self, since, loader):
        with self.lock:
            index = self.snapshot(loader)
            revision = self.revision(index)
            reset = since <= 0 or since > revision or since < self.floor
            entries, removed = {}, set()
            if reset:
                entries = index["entries"]
            else:
                for change_revision, upserts, deletes in self.journal:
                    if change_revision <= since:
                        continue
                    for path in deletes:
                        entries.pop(path, None)
                        removed.add(path)
                    for path, entry in upserts.items():
                        removed.discard(path)
                        entries[path] = entry
            return {"revision": revision, "reset": reset, "entries": entries,
                    "removed": sorted(removed), "total": index.get("total", 0),
                    "builtAt": index.get("builtAt", 0),
                    "indexParserVersion": index.get("parserVersion", 0),
                    "pending": self.pending}


def catalog_for(path):
    key = os.path.normcase(os.path.abspath(path))
    with _OWNERS_LOCK:
        owner = _OWNERS.get(key)
        if owner is None:
            owner = _OWNERS[key] = GalleryCatalog(path)
        return owner
