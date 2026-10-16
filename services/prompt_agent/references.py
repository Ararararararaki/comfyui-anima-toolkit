"""Creation references: resident local indexes, with optional public API verification.

Missing records are evidence about this catalog, never a verdict on model vocabulary.
Indexes and HTTP ownership are injected; this service neither opens a database nor
owns a network session. Successful online results expire, failures are not cached.
"""
from __future__ import annotations

import asyncio
import copy
import time
from collections import Counter

from .errors import AgentError

ONLINE_LIMIT = 8


def _key(value: str) -> str:
    return value.strip().casefold().replace("\\(", "(").replace("\\)", ")").replace(" ", "_")


class References:
    def __init__(self, tags, characters, get_json, mode=lambda: "local", *,
                 tag_query=lambda value: value.strip(), clock=time.monotonic):
        self._tags, self._characters, self._get_json = tags, characters, get_json
        self._mode, self._tag_query, self._clock = mode, tag_query, clock
        self._cache = {}

    async def _online(self, queries: list[str]) -> dict:
        """Two batch requests at most; an empty successful response is unlisted."""
        result, pending = {}, []
        for query in queries:
            key = _key(query)
            cached = self._cache.get(key)
            if cached and cached[0] > self._clock():
                result[key] = copy.deepcopy(cached[1])
            else:
                pending.append(key)
        pending = list(dict.fromkeys(pending))[:ONLINE_LIMIT]
        if not pending:
            return result
        found = {}
        try:
            async with asyncio.timeout(20):
                rows = await self._get_json("https://danbooru.donmai.us/tags.json", {
                    "search[name_comma]": ",".join(pending), "limit": "100"})
                if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("name"), str) for row in rows):
                    raise ValueError("unexpected tag response")
                found = {_key(row["name"]): row for row in rows}
                missing = [key for key in pending if key not in found]
                aliases = {}
                if missing:
                    rows = await self._get_json("https://danbooru.donmai.us/tag_aliases.json", {
                        "search[antecedent_name_comma]": ",".join(missing),
                        "search[status]": "active", "limit": "100"})
                    if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("antecedent_name"), str)
                                                         or not isinstance(row.get("consequent_name"), str) for row in rows):
                        raise ValueError("unexpected alias response")
                    aliases = {_key(row["antecedent_name"]): row["consequent_name"] for row in rows if row.get("status") == "active"}
                for key in pending:
                    row = found.get(key)
                    value = {"status": "found" if row else "alias" if key in aliases else "unlisted",
                             "tag": row["name"] if row else aliases.get(key, ""),
                             "source": "danbooru_online", "count": row.get("post_count") if row else None,
                             "category": row.get("category") if row else None,
                             "deprecated": bool(row.get("is_deprecated")) if row else False,
                             "checked_at": time.time()}
                    result[key] = value
                    self._cache[key] = (self._clock() + (300 if value["status"] == "unlisted" else 86400), value)
                # Bound process memory without persisting old failures on disk.
                if len(self._cache) > 1024:
                    self._cache = dict(list(self._cache.items())[-512:])
        except (TimeoutError, OSError, RuntimeError, ValueError, AgentError) as error:
            for key in pending:
                # A failed alias lookup must not discard already verified canonical tags.
                row = found.get(key)
                result[key] = ({"status": "found", "tag": row["name"], "source": "danbooru_online",
                                "count": row.get("post_count"), "category": row.get("category"),
                                "deprecated": bool(row.get("is_deprecated")), "checked_at": time.time()}
                               if row else {"status": "unavailable", "tag": "", "source": "danbooru_online",
                                            "checked_at": time.time(), "error": str(error) if isinstance(error, AgentError)
                                            else f"资料接口查询失败：{type(error).__name__}"})
        return result

    async def tags(self, queries: list[str], *, online: bool) -> list[dict]:
        normalized = [self._tag_query(query) for query in queries]
        try:
            local = await asyncio.to_thread(self._tags, normalized)
        except (OSError, RuntimeError, ValueError):
            local = [{"status": "unavailable", "tag": "", "source": "local_catalog"} for _ in queries]
        missing = [query for query, row in zip(normalized, local) if row["status"] not in ("found", "alias")]
        remote = await self._online(missing) if online else {}
        result = []
        for query, key, row in zip(queries, normalized, local):
            item = {**row, "query": query}
            if row["status"] == "missing":
                item["status"] = "unlisted"
                item["source"] = "local_catalog"
            if _key(key) in remote:
                item.update(remote[_key(key)])
            result.append(item)
        return result

    async def lookup(self, requests: dict) -> dict:
        online = self._mode() == "online"
        tags = await self.tags(requests["tags"], online=online)
        characters = []
        for query in requests["characters"]:
            try:
                candidates = await asyncio.to_thread(self._characters, query)
                characters.append({"query": query, "status": "candidates" if candidates else "unlisted",
                                   "source": "animadex_local", "candidates": candidates})
            except (OSError, RuntimeError, ValueError):
                characters.append({"query": query, "status": "unavailable", "source": "animadex_local", "candidates": []})
        return {"mode": "online" if online else "local", "tags": tags, "characters": characters}

    async def audit(self, fragments: list[str], evidence: dict) -> dict:
        return {"tags": await self.tags(fragments, online=evidence["mode"] == "online")}


def summary(evidence: dict, audit: dict) -> str:
    counts = Counter(row["status"] for row in audit["tags"])
    verified = counts["found"] + counts["alias"]
    characters = sum(bool(row["candidates"]) for row in evidence["characters"])
    online = any(row.get("source") == "danbooru_online" for row in evidence["tags"] + audit["tags"])
    lines = [f"已核对 {len(audit['tags'])} 个声明的标签：收录 {verified} 个，未收录 {counts['unlisted']} 个，查询失败 {counts['unavailable']} 个。",
             f"人物检索 {len(evidence['characters'])} 项，{characters} 项取得候选资料。",
             "使用 Danbooru 在线核验结果（含未过期缓存）。" if online else "使用本地词库和人物库；未执行联网检索。"]
    flagged = [row["query"] + (f" → {row['tag']}" if row["status"] == "alias" else "")
               for row in audit["tags"] if row["status"] != "found"]
    if flagged:
        lines.append("需留意：" + "、".join(flagged[:12]))
    failures = [row for row in evidence["tags"] + audit["tags"] if row["status"] == "unavailable"]
    if failures:
        reasons = list(dict.fromkeys(row.get("error", "本地资料暂不可用") for row in failures))
        lines.append("资料查询失败（不是未收录）：" + "；".join(reasons[:3]))
    lines.append("未收录不代表不能生成；自然语言与自定义词不按标签删除。")
    return "\n".join(lines)


def host_references(mode) -> References:
    """Lazy host adapters. Logical module identities and app-owned HTTP survive reload."""
    def tags(queries):
        from ...anima_tag_index import get_index
        return get_index().lookup_many(queries)

    def characters(query):
        from ...anima_animadex import get_index
        index = get_index()
        if index is None:
            raise RuntimeError("Character catalog is not ready")
        rows = index.search(query, limit=3)["results"]
        return [{**{key: row.get(key) for key in ("slug", "name", "series", "zh", "trigger")},
                 **{key: row.get(key, [])[:12] for key in ("features", "outfit")}} for row in rows]

    def tag_query(value):
        from ...anima_tag_taxonomy import WEIGHT_RE
        weighted = WEIGHT_RE.match(value.strip())
        return weighted.group(1).strip() if weighted else value.strip()

    async def get_json(url, params):
        import aiohttp
        from server import PromptServer
        from ..http_resources import current
        try:
            async with current(PromptServer.instance.app).get(url, params=params,
                    headers={"User-Agent": "ComfyUI-Anima-Toolkit/PromptAgent", "Accept": "application/json"},
                    timeout=aiohttp.ClientTimeout(total=12)) as response:
                if response.status != 200:
                    raise AgentError(f"参考接口 HTTP {response.status}" + ("（站方拒绝或验证；可继续使用本地核验）" if response.status == 403 else ""))
                return await response.json(content_type=None)
        except aiohttp.ClientError as error:
            raise AgentError("参考接口网络查询失败") from error

    return References(tags, characters, get_json, mode, tag_query=tag_query)
