"""Local manual trigger words, kept separate from automatically collected metadata."""
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import uuid


def clean_trigger_words(value):
    """One line is one prompt fragment; preserve commas, brackets and weights."""
    if isinstance(value, str):
        if len(value) > 20000:
            raise ValueError("触发词最多 20000 个字符")
        value = value.splitlines()
    if not isinstance(value, list) or any(not isinstance(word, str) for word in value):
        raise ValueError("触发词必须是文本或文本数组")
    if len(value) > 200 or sum(map(len, value)) > 20000:
        raise ValueError("触发词最多 200 行、20000 个字符")
    return [word.strip() for word in value if word.strip()]


class TriggerOverrideStore:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()
        self._stamp = None
        self._data = {"revision": "empty", "entries": {}}

    def _read(self):
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            self._stamp = None
            self._data = {"revision": "empty", "entries": {}}
            return self._data
        stamp = (stat.st_mtime_ns, stat.st_size)
        if stamp == self._stamp:
            return self._data
        data = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("entries"), dict):
            raise ValueError("自定义触发词文件格式无效，已保留原文件")
        for key, entry in data["entries"].items():
            if not isinstance(key, str) or not isinstance(entry, dict) or not isinstance(entry.get("words"), list):
                raise ValueError("自定义触发词条目格式无效，已保留原文件")
            clean_trigger_words(entry["words"])
        self._stamp, self._data = stamp, data
        return data

    def read(self):
        with self.lock:
            return copy.deepcopy(self._read())

    def update(self, key, identity, words=None, *, reset=False):
        with self.lock:
            data = copy.deepcopy(self._read())
            entries = data["entries"]
            if reset:
                if key not in entries:
                    return data
                del entries[key]
            else:
                entry = {"filename": identity["filename"], "words": clean_trigger_words(words)}
                if entries.get(key) == entry:
                    return data
                entries[key] = entry
            data["revision"] = uuid.uuid4().hex
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent,
                                                 prefix=self.path.name + ".", suffix=".tmp", delete=False) as output:
                    temp_path = output.name
                    json.dump(data, output, ensure_ascii=False, indent=2)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temp_path, self.path)
            finally:
                if temp_path and os.path.exists(temp_path):
                    os.unlink(temp_path)
            stat = self.path.stat()
            self._stamp, self._data = (stat.st_mtime_ns, stat.st_size), data
            return copy.deepcopy(data)
