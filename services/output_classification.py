"""Offline identity summaries for Outputs, using the same dictionaries as tag nodes.

Importing this module performs no I/O and imports no ComfyUI, HTTP or GPU code.
``classify_many`` pins one read-only dictionary snapshot for an entire batch.
Only saved positive prompts and supplied tags are accepted as classification evidence.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

try:
    from ..anima_tag_taxonomy import normalise, tag_lookup_keys
except ImportError:  # Offline diagnostics/tests load services as a top-level package.
    from anima_tag_taxonomy import normalise, tag_lookup_keys

ALGORITHM_VERSION = "outputs-identities-v4"
_WORDS = re.compile(r"[a-z0-9]+")
_CJK = re.compile(r"[\u3400-\u9fff]{2,}")
_SEPARATORS = re.compile(r"[,，;；\n]+")


def _tag_module():
    try:
        from .. import anima_tag_index
    except ImportError:
        import anima_tag_index
    return anima_tag_index


def _taxonomy_module():
    try:
        from .. import anima_tag_taxonomy
    except ImportError:
        import anima_tag_taxonomy
    return anima_tag_taxonomy


def _dictionary_revision():
    return (_tag_module().index_fingerprint(), _taxonomy_module().taxonomy_fingerprint())


def _version(revision: Any) -> str:
    encoded = json.dumps(revision, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return ALGORITHM_VERSION + ":" + hashlib.sha256(encoded).hexdigest()[:20]


def _key(value: Any) -> str:
    # A qualified identity may be saved as name\(work\), name_(work), or
    # name (work). Match that punctuation independently of optional whitespace.
    # Keep the qualifier intact: only catalog evidence can establish identity.
    text = normalise(value)
    text = re.sub(r"\(\s*", "(", text)
    text = re.sub(r"\s*\)", ")", text)
    text = re.sub(r"(?<=[\w)])\(", " (", text)
    return " ".join(text.split())


def _keys(value: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(_key(key) for key in tag_lookup_keys(value) if _key(key)))


def _texts(value: Any) -> tuple[str, ...]:
    values = [value] if isinstance(value, str) else value if isinstance(value, (list, tuple)) else ()
    return tuple(dict.fromkeys(text.strip() for text in values if isinstance(text, str) and text.strip()))


@dataclass(frozen=True)
class _Entity:
    kind: str
    id: str
    tag: str
    name: str
    aliases: tuple[str, ...]
    work_ids: tuple[str, ...] = ()

    @property
    def ref(self) -> str:
        return self.kind + ":" + self.id

    def wire(self, source: str | None = None) -> dict[str, Any]:
        result = {"id": self.id, "tag": self.tag, "name": self.name, "aliases": list(self.aliases)}
        if self.kind == "character":
            result["workIds"] = list(self.work_ids)
        elif source is not None:
            result["source"] = source
        return result


class _Snapshot:
    def __init__(self, index: Any, taxonomy: Any, version: str):
        self.version, self.taxonomy = version, taxonomy
        self.entities: dict[str, _Entity] = {}
        self.canonical: dict[str, set[str]] = {}
        self.aliases: dict[str, set[str]] = {}
        self.phrases: dict[str, set[str]] = {}
        self.phrase_heads: dict[str, set[str]] = {}
        self.general_aliases: dict[str, tuple[str, ...]] = {}
        series = getattr(index, "series", {}) or {}
        characters = getattr(index, "characters", {}) or {}
        catalog_available = bool(series or characters or getattr(index, "aliases", {}) or getattr(index, "tags", {}))
        taxonomy_available = taxonomy is not None and (not hasattr(taxonomy, "size") or taxonomy.size > 0)
        self.available = catalog_available or taxonomy_available
        work_keys: dict[str, str] = {}
        for source_key, row in series.items():
            if not isinstance(row, Mapping):
                continue
            tag = str(row.get("n") or source_key).strip()
            entity_id = _key(tag)
            if not entity_id:
                continue
            aliases = _texts(row.get("zh"))
            # Series zh entries contain costume/character labels too: never use the
            # first such alias as the work's authoritative display name.
            display = str(row.get("sn") or tag).strip()
            entity = _Entity("work", entity_id, tag, display, tuple(dict.fromkeys((tag, display, *aliases))))
            if self._add(entity):
                work_keys[_key(source_key)] = entity_id
                work_keys[entity_id] = entity_id
        for source_key, row in characters.items():
            if not isinstance(row, Mapping):
                continue
            tag = str(row.get("t") or "").strip()
            entity_id = _key(tag)
            if not entity_id:
                continue
            aliases = _texts(row.get("zh"))
            supplied_works = _texts(row.get("s"))
            work_ids = tuple(sorted({work_keys[_key(work)] for work in supplied_works if _key(work) in work_keys}))
            ref = "character:" + entity_id
            previous = self.entities.get(ref)
            if previous:
                work_ids = tuple(sorted(set(work_ids) | set(previous.work_ids)))
                aliases = tuple(dict.fromkeys((*previous.aliases, *aliases)))
            display = previous.name if previous else aliases[0] if aliases else tag
            entity = _Entity("character", entity_id, tag, display,
                             tuple(dict.fromkeys((tag, *aliases))), work_ids)
            self._add(entity)
        for tag, values in (getattr(index, "aliases", {}) or {}).items():
            aliases = _texts(values)
            if aliases:
                self.general_aliases[_key(tag)] = aliases
        self._build_phrases()

    def _add(self, entity: _Entity):
        expected = "角色身份词" if entity.kind == "character" else "作品版权词"
        hit = self.taxonomy.lookup(entity.tag) if self.taxonomy is not None else None
        # The identity export contains known collisions (e.g. fang = a tooth).
        # A typed feature/artist tag takes precedence over that export's aliases.
        if hit and hit[0] not in (expected, "未归类词"):
            return False
        self.entities[entity.ref] = entity
        self.canonical.setdefault(entity.id, set()).add(entity.ref)
        for alias in entity.aliases:
            self.aliases.setdefault(_key(alias), set()).add(entity.ref)
        return True

    def _build_phrases(self):
        for entity in self.entities.values():
            # Prose evidence is a complete canonical name, or a unique primary
            # character name. Secondary outfit/variant aliases are exact-tag only.
            names = []
            canonical = _key(entity.tag)
            canonical_hit = self.taxonomy.lookup(entity.tag) if self.taxonomy is not None else None
            if entity.kind == "work" or _CJK.fullmatch(canonical) and len(canonical) >= 3 or (
                len(_WORDS.findall(canonical)) >= 2 and ("(" in canonical or canonical_hit and canonical_hit[0] == "角色身份词")
            ):
                names.append(entity.tag)
            if entity.kind == "character" and entity.name != entity.tag:
                # Short labels such as 世界/恐怖 are ordinary prose too. Atomic
                # alias tags remain usable; substring matching requires a full name.
                if _CJK.fullmatch(_key(entity.name)) and len(_key(entity.name)) >= 3:
                    names.append(entity.name)
            for name in names:
                phrase = _key(name)
                if not phrase or len(self.aliases.get(phrase, ())) != 1:
                    continue
                if entity.kind == "work" and " " not in phrase:
                    continue  # Ordinary prose such as "an original illustration".
                cjk = _CJK.fullmatch(phrase)
                if not cjk and not _WORDS.search(phrase):
                    continue
                self.phrases.setdefault(phrase, set()).add(entity.ref)
                if cjk:
                    head = phrase[:2]
                else:
                    head = _WORDS.search(phrase).group()
                self.phrase_heads.setdefault(head, set()).add(phrase)

    def candidates(self, term: str) -> set[str]:
        keys = _keys(term)
        canonical = set().union(*(self.canonical.get(key, set()) for key in keys)) if keys else set()
        if canonical:
            return canonical
        return set().union(*(self.aliases.get(key, set()) for key in keys)) if keys else set()

    def prose(self, text: str) -> set[str]:
        text = _key(text)
        heads = set(_WORDS.findall(text))
        for block in _CJK.findall(text):
            heads.update(block[i:i + 2] for i in range(len(block) - 1))
        phrases = set().union(*(self.phrase_heads.get(head, set()) for head in heads)) if heads else set()
        hits: list[tuple[int, int, str]] = []
        for phrase in phrases:
            start = text.find(phrase)
            while start >= 0:
                end = start + len(phrase)
                cjk = bool(_CJK.fullmatch(phrase))
                before, after = text[start - 1:start], text[end:end + 1]
                if cjk or ((not before or not before.isalnum()) and (not after or not after.isalnum())):
                    hits.extend((start, end, ref) for ref in self.phrases[phrase])
                start = text.find(phrase, start + 1)
        # A qualified character variant must not also emit its shorter base name.
        accepted: list[tuple[int, int, str]] = []
        for hit in sorted(hits, key=lambda item: (-(item[1] - item[0]), item[0], item[2])):
            kind = hit[2].split(":", 1)[0]
            if not any(previous[2].startswith(kind + ":") and previous[0] <= hit[0] and previous[1] >= hit[1]
                       for previous in accepted):
                accepted.append(hit)
        return {hit[2] for hit in accepted}


class OutputClassifier:
    """Small fixture-injectable, cached projection of shared offline dictionaries."""
    def __init__(self, *, tag_index_getter: Callable[[], Any] | None = None,
                 taxonomy_getter: Callable[[], Any] | None = None,
                 revision_getter: Callable[[], Any] | None = None):
        self._tag_index_getter = tag_index_getter or (lambda: _tag_module().get_index())
        self._taxonomy_getter = taxonomy_getter or (lambda: _taxonomy_module().shared_taxonomy())
        self._revision_getter = revision_getter or _dictionary_revision
        self._lock = threading.RLock()
        self._snapshot: _Snapshot | None = None
        self._query_alias_cache: dict[str, set[str]] = {}

    def version(self) -> str:
        return _version(self._revision_getter())

    def _capture(self) -> _Snapshot:
        version = self.version()
        with self._lock:
            if self._snapshot is None or self._snapshot.version != version:
                self._snapshot = _Snapshot(self._tag_index_getter(), self._taxonomy_getter(), version)
                self._query_alias_cache.clear()
            return self._snapshot

    def classify(self, positive_prompt: str = "", tags: Sequence[str] = ()) -> dict[str, Any]:
        return self._classify(self._capture(), positive_prompt, tags)

    def classify_many(self, items: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        snapshot = self._capture() if items else None
        result = []
        for item in items:
            if not isinstance(item, Mapping):
                raise TypeError("classification items must be objects")
            inferred = item.get("inferredTags", ())
            if not isinstance(inferred, (tuple, list)) or any(not isinstance(tag, str) for tag in inferred):
                raise TypeError("inferredTags must be an array of text")
            prompt, tags = item.get("positivePrompt", ""), item.get("tags", ())
            row = self._classify(snapshot, prompt, tags)
            # Recovered saved identities take priority over earlier visual guesses.
            if inferred and not row['characters'] and not row['ambiguous']:
                row = self._classify(snapshot, prompt, [*tags, *inferred])
            if "id" in item:
                row["id"] = item["id"]
            result.append(row)
        return result

    @staticmethod
    def _classify(snapshot: _Snapshot, positive_prompt: str, tags: Sequence[str]) -> dict[str, Any]:
        if not isinstance(positive_prompt, str) or isinstance(tags, str) or not isinstance(tags, (tuple, list)):
            raise TypeError("positivePrompt must be text and tags must be an array of text")
        if any(not isinstance(tag, str) for tag in tags):
            raise TypeError("tags must be an array of text")
        terms = tuple(dict.fromkeys((*[part.strip() for part in _SEPARATORS.split(positive_prompt) if part.strip()], *tags)))
        tag_keys = set().union(*(_keys(term)[-1:] for term in terms)) if terms else set()
        found: set[str] = set()
        pending: list[tuple[str, set[str]]] = []
        for term in terms:
            candidates = snapshot.candidates(term)
            if len(candidates) == 1:
                found.update(candidates)
            elif candidates:
                pending.append((term, candidates))
            else:
                found.update(snapshot.prose(term))
                if snapshot.taxonomy is not None:
                    hit = snapshot.taxonomy.lookup(term)
                    if hit and hit[0] in ("角色身份词", "作品版权词"):
                        kind = "character" if hit[0] == "角色身份词" else "work"
                        key = _keys(term)[-1]
                        ref = kind + ":" + key
                        found.add(ref)
        explicit_works = {ref.split(":", 1)[1] for ref in found if ref.startswith("work:")}
        ambiguous = []
        for term, candidates in pending:
            filtered = {ref for ref in candidates if ref.startswith("character:") and
                        set(snapshot.entities[ref].work_ids) & explicit_works}
            if len(filtered) == 1:
                found.update(filtered)
            else:
                ambiguous.append({"term": term, "candidates": sorted(candidates)})
        characters, works, search_aliases = [], {}, set()
        for ref in sorted(found):
            kind, entity_id = ref.split(":", 1)
            entity = snapshot.entities.get(ref) or _Entity(kind, entity_id, entity_id, entity_id, (entity_id,))
            tag_keys.add(entity.id)
            search_aliases.update(entity.aliases)
            if kind == "character":
                characters.append(entity.wire())
                # Several character records can share a canonical tag. A work is
                # inferred only when the dictionary association itself is unique.
                if len(entity.work_ids) == 1:
                    work_id = entity.work_ids[0]
                    work = snapshot.entities["work:" + work_id]
                    works.setdefault(work_id, work.wire("character"))
            else:
                works[entity.id] = entity.wire("explicit")
        for work in works.values():
            tag_keys.add(work["id"])
            search_aliases.update(work["aliases"])
        for key in tag_keys:
            search_aliases.update(snapshot.general_aliases.get(key, ()))
        status = "ambiguous" if ambiguous else "identified" if characters or works else "unrecognized"
        if not snapshot.available:
            status = "unavailable"
        return {"characters": characters, "works": [works[key] for key in sorted(works)],
                "tagKeys": sorted(tag_keys), "searchAliases": sorted(search_aliases),
                "status": status, "ambiguous": ambiguous, "version": snapshot.version}

    def resolve_aliases(self, queries: Sequence[str]) -> list[dict[str, Any]]:
        snapshot = self._capture()
        result = []
        for query in queries:
            refs = snapshot.candidates(query)
            query_key = _key(query)
            # Alias expansion is optional; ordinary searches use aliases already
            # saved in each summary. Repeated expansions reuse this snapshot.
            with self._lock:
                general = self._query_alias_cache.get(query_key)
                if general is None:
                    general = {key for key, aliases in snapshot.general_aliases.items()
                               if any(query_key == _key(alias) for alias in aliases)}
                    if self._snapshot is snapshot:
                        if len(self._query_alias_cache) >= 128:
                            self._query_alias_cache.pop(next(iter(self._query_alias_cache)))
                        self._query_alias_cache[query_key] = general
            keys = {ref.split(":", 1)[1] for ref in refs} | general
            result.append({"query": query, "characterIds": sorted(ref.split(":", 1)[1] for ref in refs if ref.startswith("character:")),
                           "workIds": sorted(ref.split(":", 1)[1] for ref in refs if ref.startswith("work:")),
                           "tagKeys": sorted(keys), "status": "identified" if keys else "unrecognized"})
        return result


_CLASSIFIER = OutputClassifier()


def classification_version() -> str:
    """Cheap source fingerprint; retrieving it does not load the dictionaries."""
    return _CLASSIFIER.version()


def classify(positive_prompt: str = "", tags: Sequence[str] = ()) -> dict[str, Any]:
    return _CLASSIFIER.classify(positive_prompt, tags)


def classify_many(items: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return _CLASSIFIER.classify_many(items)


def resolve_aliases(queries: Sequence[str]) -> list[dict[str, Any]]:
    return _CLASSIFIER.resolve_aliases(queries)
