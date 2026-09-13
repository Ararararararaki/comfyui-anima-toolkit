"""Harvest the full character index from the AnimaDex public API.

Output: data/_sources/animadex_characters.json  (raw, verbatim)
        data/_sources/animadex_characters.meta.json (fetch metadata)

Usage:
    python tools/harvest_animadex.py [--page-size 200] [--out-dir <dir>]
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

API = "https://animadex.net/api/characters/search"
UA = {
    "User-Agent": "Anima-Toolkit-character-index/1.0 (+https://github.com/Ararararararaki/comfyui-anima-toolkit)",
    "Accept": "application/json",
}
PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fetch(page: int, page_size: int, tries: int = 4, timeout: int = 45) -> dict:
    query = urllib.parse.urlencode({"sort": "count", "page": page, "page_size": page_size})
    url = "%s?%s" % (API, query)
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as exc:
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("page %d failed after %d tries: %s" % (page, tries, last))


def row_key(row: dict) -> str:
    return str(row.get("slug") or row.get("name") or "").strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--page-size", type=int, default=200)
    ap.add_argument("--out-dir", default=os.path.join(PLUGIN_ROOT, "data", "_sources"))
    ap.add_argument("--sleep", type=float, default=0.08)
    ap.add_argument("--max-pages", type=int, default=0)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    out_path = os.path.join(args.out_dir, "animadex_characters.json")
    meta_path = os.path.join(args.out_dir, "animadex_characters.meta.json")

    rows: dict[str, dict] = {}
    started = time.time()
    page = 1
    total_pages = 1
    reported_total = None
    page_size_used = args.page_size

    while page <= total_pages:
        data = fetch(page, args.page_size)
        if page == 1:
            total_pages = int(data.get("pages") or 1)
            reported_total = data.get("total")
            page_size_used = int(data.get("page_size") or args.page_size)
            print("total=%s pages=%s page_size=%s" % (reported_total, total_pages, page_size_used), flush=True)
        batch = data.get("results") or []
        if not batch:
            break
        for row in batch:
            key = row_key(row)
            if key and key not in rows:
                rows[key] = row
        if page % 20 == 0 or page == total_pages:
            print("page=%d/%d rows=%d elapsed=%.1fs" % (page, total_pages, len(rows), time.time() - started), flush=True)
        if args.max_pages and page >= args.max_pages:
            break
        page += 1
        time.sleep(args.sleep)

    # API may cap page_size below what we asked for -> recompute pages if needed
    if reported_total and len(rows) < int(reported_total) * 0.95:
        print("WARN collected %d of reported %s; rerunning at native page size" % (len(rows), reported_total), flush=True)

    ordered = sorted(rows.values(), key=lambda r: -int(r.get("count") or 0))
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(ordered, fh, ensure_ascii=False, indent=0)
    meta = {
        "source": API,
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "reported_total": reported_total,
        "page_size": page_size_used,
        "pages": total_pages,
        "rows": len(ordered),
        "elapsed_sec": round(time.time() - started, 1),
    }
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    print("wrote %s (%d rows, %.1f KB)" % (out_path, len(ordered), os.path.getsize(out_path) / 1024.0), flush=True)
    print(json.dumps(meta, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
