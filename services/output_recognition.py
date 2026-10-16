"""Read locally validated, derived recognition by exact image SHA-256.

No model execution, downloads, image mutation or user directory scanning. A
separate explicit analysis owns producing this cache; inference never becomes a
reference seed automatically. Missing/corrupt data simply falls back to WD14.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from pathlib import Path

MAX_BYTES = 16 * 1024 * 1024
MAX_MATCHES = 50000
PIXAI_MODEL = 'pixai-labs/pixai-tagger-v1.0'


class LibraryMatches:
    def __init__(self, path):
        self.path = Path(path)
        self._signature = None
        self._matches = {}
        self._version = ''
        self._lock = threading.RLock()

    def _load(self):
        with self._lock:
            try:
                stat = self.path.stat()
                signature = (stat.st_mtime_ns, stat.st_size)
                if signature == self._signature:
                    return
                self._signature = signature
                self._matches, self._version = {}, ''
                if stat.st_size > MAX_BYTES:
                    return
                data = self.path.read_bytes()
                value = json.loads(data)
                matches = value.get('matches') if isinstance(value, dict) and value.get('schemaVersion') == 1 else None
                if not isinstance(matches, dict) or len(matches) > MAX_MATCHES:
                    return
                valid = {}
                for key, row in matches.items():
                    if not re.fullmatch(r'[0-9a-f]{64}', key) or not isinstance(row, dict):
                        continue
                    if row.get('kind') == 'pixai':
                        scores, categories = row.get('scores'), row.get('categories')
                        thresholds, revision = row.get('thresholds'), row.get('revision')
                        if row.get('model') != PIXAI_MODEL or not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}', revision):
                            continue
                        if not isinstance(scores, dict) or not 1 <= len(scores) <= 32 or any(not isinstance(tag, str) or not tag or len(tag) > 256 or isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 < score <= 1 for tag, score in scores.items()):
                            continue
                        if not isinstance(thresholds, dict) or any(isinstance(thresholds.get(category), bool) or not isinstance(thresholds.get(category), (int, float)) or not math.isfinite(thresholds[category]) or not minimum <= thresholds[category] <= 1 for category, minimum in (('character', .27), ('copyright', .24))):
                            continue
                        if not isinstance(categories, dict) or any(not isinstance(categories.get(category), list) or any(not isinstance(tag, str) or tag not in scores or scores[tag] <= thresholds[category] for tag in categories[category]) for category in ('character', 'copyright')):
                            continue
                        characters, copyrights = set(categories['character']), set(categories['copyright'])
                        if characters & copyrights or characters | copyrights != set(scores):
                            continue
                        valid[key] = {'kind': 'pixai', 'model': PIXAI_MODEL, 'revision': revision,
                                      'scores': scores, 'categories': categories, 'thresholds': thresholds}
                        continue
                    if row.get('kind') == 'wd14':
                        scores, categories = row.get('scores'), row.get('categories')
                        model, fingerprint = row.get('model'), row.get('modelFingerprint')
                        if not isinstance(model, str) or not model or len(model) > 128 or not isinstance(fingerprint, str) or not re.fullmatch(r'[0-9a-f]{20}', fingerprint):
                            continue
                        if not isinstance(scores, dict) or len(scores) > 512 or any(not isinstance(tag, str) or not tag or len(tag) > 256 or isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not .05 < score <= 1 for tag, score in scores.items()):
                            continue
                        if not isinstance(categories, dict) or any(not isinstance(categories.get(category), list) or any(not isinstance(tag, str) or tag not in scores for tag in categories[category]) for category in ('character', 'general')):
                            continue
                        characters, general = set(categories['character']), set(categories['general'])
                        if characters & general or characters | general != set(scores):
                            continue
                        valid[key] = {'kind': 'wd14', 'model': model, 'modelFingerprint': fingerprint,
                                      'scores': scores, 'categories': categories}
                        continue
                    if row.get('kind', 'ccip') != 'ccip':
                        continue
                    tags = row.get('tags')
                    distances = [row.get('distance'), row.get('runnerUpDistance')]
                    if not isinstance(tags, list) or not 1 <= len(tags) <= 8 or any(not isinstance(tag, str) or not tag.strip() or len(tag) > 256 for tag in tags):
                        continue
                    if any(isinstance(d, bool) or not isinstance(d, (float, int)) or not math.isfinite(d) or d < 0 for d in distances):
                        continue
                    if distances[0] >= distances[1]:
                        continue
                    valid[key] = {'tags': list(dict.fromkeys(tags)), 'distance': distances[0], 'runnerUpDistance': distances[1]}
                self._matches = valid
                self._version = hashlib.sha256(data).hexdigest()[:20]
            except (OSError, ValueError, TypeError):
                self._signature = None
                self._matches, self._version = {}, ''

    def catalog(self):
        self._load()
        with self._lock:
            return {'count': len(self._matches), 'version': self._version}

    def match(self, image, options=None):
        return self.match_digest(hashlib.sha256(image).hexdigest(), options)

    def match_digest(self, key, options=None):
        if not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{64}', key):
            return None
        self._load()
        with self._lock:
            row = self._matches.get(key)
            if row and row.get('kind') == 'pixai':
                excluded = (options or {}).get('exclude_tags') or []
                if isinstance(excluded, str):
                    excluded = excluded.split(',')
                if not isinstance(excluded, list) or any(not isinstance(v, str) for v in excluded):
                    return None
                excluded = {v.strip().lower().replace(' ', '_') for v in excluded}
                # Reviewed library evidence uses its own category calibration,
                # independently of the selected WD14 model's numeric scale.
                tags = [tag for category in ('character', 'copyright')
                        for tag in row['categories'][category] if tag.lower() not in excluded]
                return {'status': 'complete', 'tags': tags, 'model': 'PixAI Tagger v1.0',
                        'source': 'local-pixai-library', 'revision': row['revision'],
                        'thresholds': dict(row['thresholds']), 'version': self._version}
            if row and row.get('kind') == 'wd14':
                options = options or {}
                if options.get('model') != row['model']:
                    return None
                thresholds = [options.get('threshold', .35), options.get('character_threshold', .85)]
                if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not .05 <= v <= 1 for v in thresholds):
                    return None
                excluded = options.get('exclude_tags') or []
                if isinstance(excluded, str):
                    excluded = excluded.split(',')
                if not isinstance(excluded, list) or any(not isinstance(v, str) for v in excluded):
                    return None
                excluded = {v.strip().lower().replace(' ', '_') for v in excluded}
                from . import local_tagger
                if local_tagger.model_fingerprint(row['model']) != row['modelFingerprint']:
                    return None
                tags = [tag for category, cutoff in (('character', thresholds[1]), ('general', thresholds[0]))
                        for tag in row['categories'][category] if row['scores'][tag] > cutoff and tag.lower() not in excluded]
                return {'status': 'complete', 'tags': tags, 'model': row['model'],
                        'source': 'local-wd14-library', 'version': self._version}
            return ({'status': 'complete', 'tags': list(row['tags']), 'model': 'CCIP 图库相似匹配',
                     'source': 'local-ccip-library', 'distance': row['distance'],
                     'runnerUpDistance': row['runnerUpDistance'], 'version': self._version} if row else None)


_STORES = {}
_LOCK = threading.Lock()


def _store():
    try:
        import folder_paths
        path = str(Path(folder_paths.get_user_directory()) / 'toolkit' / 'output-recognition' / 'library-matches.json')
    except (ImportError, AttributeError, TypeError):
        return None
    with _LOCK:
        if path not in _STORES:
            _STORES[path] = LibraryMatches(path)
        return _STORES[path]


def library_match_catalog():
    store = _store()
    return store.catalog() if store else {'count': 0, 'version': ''}


def lookup_library_match(image, options=None):
    store = _store()
    return store.match(image, options) if store else None


def lookup_library_digest(digest, options=None):
    store = _store()
    return store.match_digest(digest, options) if store else None
