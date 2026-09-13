"""Harvest Civitai LoRA metadata to learn Chinese character/alias names.

Why: no public dataset pairs *official Chinese character names* with danbooru
tags. Chinese LoRA authors do it implicitly -- the model title carries the
Chinese name while `trainedWords` carries the danbooru tag. That pairing is
verifiable evidence, not a guess.

Two modes:
  broad    walk `types=LORA&tag=character` by cursor (resumable)
  queries  hit `query=<chinese term>` for a curated list of series names

Output (append-only, resumable):
  data/_sources/civitai_loras.jsonl   one JSON record per model version
  data/_sources/civitai_state.json    cursor + counters

Usage:
    python tools/harvest_civitai_zh_aliases.py --mode both --max-pages 400
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://civitai.com/api/v1/models"
PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {
    "User-Agent": "Anima-Toolkit-zh-alias-harvester/1.0 (+https://github.com/Ararararararaki/comfyui-anima-toolkit)",
    "Accept": "application/json",
}

# Chinese (and common CN-community) series names worth asking for directly.
QUERY_TERMS = [
    "碧蓝档案", "蔚蓝档案", "ブルーアーカイブ", "原神", "崩坏星穹铁道", "崩坏3", "星穹铁道",
    "明日方舟", "蔚蓝航线", "碧蓝航线", "少女前线", "公主连结", "赛马娘", "偶像大师",
    "东方project", "初音未来", "绝区零", "鸣潮", "战双帕弥什", "无期迷途", "重返未来1999",
    "胜利女神", "nikke", "蔚蓝档案角色", "学园偶像大师", "莉可丽丝", "孤独摇滚",
    "葬送的芙莉莲", "咒术回战", "鬼灭之刃", "间谍过家家", "电锯人", "我推的孩子",
    "链锯人", "五等分的新娘", "约会大作战", "埃罗芒阿老师", "魔卡少女樱", "美少女战士",
    "fate", "saber", "凛", "樱", "型月", "碧蓝幻想", "公主链接", "舰队collection",
    "舰娘", "战车少女", "少女与战车", "轻音少女", "魔法少女小圆", "进击的巨人",
    "刀剑神域", "re从零开始", "为美好的世界献上祝福", "overlord", "无职转生",
    "乱马", "犬夜叉", "柯南", "海贼王", "火影", "死神", "龙珠", "宝可梦",
    "蔚蓝档案 全角色", "原神全角色", "角色合集", "动漫角色",
]


def fetch(url: str, tries: int = 5, timeout: int = 60) -> dict:
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code == 429:
                wait = 8 * (attempt + 1)
                print("      429 rate-limited, sleeping %ds" % wait, flush=True)
                time.sleep(wait)
                continue
            if 400 <= exc.code < 500:
                raise
            time.sleep(2 * (attempt + 1))
        except (urllib.error.URLError, ValueError, TimeoutError) as exc:
            last = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("fetch failed: %s (%s)" % (url[:120], last))


def records_from(payload: dict, origin: str):
    for model in payload.get("items") or []:
        model_id = model.get("id")
        name = model.get("name") or ""
        for version in model.get("modelVersions") or []:
            words = version.get("trainedWords") or []
            if not isinstance(words, list):
                words = [str(words)]
            words = [str(w)[:4000] for w in words if str(w).strip()]
            yield {
                "model_id": model_id,
                "version_id": version.get("id"),
                "title": name,
                "version_name": version.get("name") or "",
                "trained": words,
                "base": version.get("baseModel") or "",
                "nsfw": bool(model.get("nsfw")),
                "origin": origin,
            }


def load_state(path: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            pass
    return {"seen_models": [], "query_done": [], "cursor": None, "broad_pages": 0}


def save_state(path: str, state: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False)
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("broad", "queries", "both"), default="both")
    ap.add_argument("--max-pages", type=int, default=300)
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--sleep", type=float, default=1.6)
    ap.add_argument("--out-dir", default=os.path.join(PLUGIN_ROOT, "data", "_sources"))
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    jsonl_path = os.path.join(args.out_dir, "civitai_loras.jsonl")
    state_path = os.path.join(args.out_dir, "civitai_state.json")
    state = {"seen_models": [], "query_done": [], "cursor": None, "broad_pages": 0} if args.reset else load_state(state_path)
    seen = set(state.get("seen_models") or [])
    started = time.time()
    written = 0

    fh = open(jsonl_path, "a", encoding="utf-8")
    try:
        if args.mode in ("broad", "both"):
            cursor = state.get("cursor")
            for page in range(args.max_pages):
                url = "%s?limit=%d&types=LORA&tag=character" % (API, args.limit)
                if cursor:
                    url += "&cursor=" + urllib.parse.quote(str(cursor))
                payload = fetch(url)
                batch = 0
                for rec in records_from(payload, "broad"):
                    if rec["model_id"] in seen:
                        continue
                    seen.add(rec["model_id"])
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    written += 1
                    batch += 1
                meta = payload.get("metadata") or {}
                cursor = meta.get("nextCursor")
                state["cursor"] = cursor
                state["broad_pages"] = int(state.get("broad_pages") or 0) + 1
                print("broad page=%d new=%d total_new=%d cursor=%s elapsed=%.0fs"
                      % (page + 1, batch, written, str(cursor)[:28], time.time() - started), flush=True)
                if not cursor:
                    print("broad: no further cursor, stopping", flush=True)
                    break
                if page % 10 == 0:
                    state["seen_models"] = sorted(seen)
                    save_state(state_path, state)
                    fh.flush()
                time.sleep(args.sleep)

        if args.mode in ("queries", "both"):
            done = set(state.get("query_done") or [])
            for term in QUERY_TERMS:
                if term in done:
                    continue
                url = "%s?limit=%d&types=LORA&query=%s" % (API, args.limit, urllib.parse.quote(term))
                try:
                    payload = fetch(url)
                except RuntimeError as exc:
                    print("query=%s FAILED %s" % (term, exc), flush=True)
                    time.sleep(5)
                    continue
                batch = 0
                for rec in records_from(payload, "query:" + term):
                    if rec["model_id"] in seen:
                        continue
                    seen.add(rec["model_id"])
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    written += 1
                    batch += 1
                done.add(term)
                state["query_done"] = sorted(done)
                print("query=%-16s new=%d total_new=%d elapsed=%.0fs" % (term, batch, written, time.time() - started), flush=True)
                save_state(state_path, state)
                fh.flush()
                time.sleep(args.sleep)
    finally:
        fh.close()
        state["seen_models"] = sorted(seen)
        save_state(state_path, state)

    size = os.path.getsize(jsonl_path) if os.path.exists(jsonl_path) else 0
    print("done: new_records=%d jsonl=%.1f MB elapsed=%.0fs" % (written, size / 1048576.0, time.time() - started), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
