# -*- coding: utf-8 -*-
"""TK Toolkit — 采集 Danbooru 官方标签别名表（离线一次性工具）。

产出：``data/_sources/danbooru_aliases.jsonl``，每行 ``{"a": 别名, "c": 规范名}``。

用途：把别名解析到规范 tag，从而复用规范 tag 的分类与语义组。
例如 WD14 会输出 `silver_hair`，而 Danbooru 的规范 tag 是 `grey_hair`
（`silver_hair` 是它的 active alias）—— 不解析别名，这类词就会掉进「未归类词」。

依据：实测 active alias 约 40,997 条，`search[status]=active` 可用。

用法：
    python -X utf8 tools/harvest_danbooru_aliases.py
"""

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "data", "_sources", "danbooru_aliases.jsonl")

API = "https://danbooru.donmai.us/tag_aliases.json"
USER_AGENT = ("TK-Toolkit/2.13.0 (+https://github.com/Ararararararaki/comfyui-anima-toolkit) "
              "offline alias table builder")
PAGE_SIZE = 1000


def build_url(page):
    return f"{API}?" + urllib.parse.urlencode({
        "limit": PAGE_SIZE,
        "page": page,
        "search[status]": "active",
    })


def fetch_page(page, retries=5):
    """返回 (page, rows) 或 (page, None)。限流时会返回 JSON 对象而非数组，必须校验。"""
    last_error = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(build_url(page), headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise ValueError(f"HTTP {response.status}")
                body = response.read().decode("utf-8")
            if not body.lstrip().startswith("["):
                raise ValueError(f"not a list: {body[:120]}")
            payload = json.loads(body)
            if not isinstance(payload, list):
                raise ValueError(f"unexpected type {type(payload).__name__}")
            rows = []
            for item in payload:
                antecedent = str(item.get("antecedent_name") or "").strip()
                consequent = str(item.get("consequent_name") or "").strip()
                if antecedent and consequent and antecedent.lower() != consequent.lower():
                    rows.append({"a": antecedent, "c": consequent})
            return page, rows
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as error:
            last_error = error
            time.sleep((1.5 ** attempt) + random.uniform(0, 0.6))
    print(f"  [X] page {page} failed: {type(last_error).__name__}: {last_error}")
    return page, None


def main():
    parser = argparse.ArgumentParser(description="采集 Danbooru 官方标签别名表")
    parser.add_argument("--max-pages", type=int, default=60)
    args = parser.parse_args()

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    existing_pages = set()
    if os.path.isfile(OUT_PATH):
        with open(OUT_PATH, "r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if record.get("_page"):
                    existing_pages.add(int(record["_page"]))
    start_page = (max(existing_pages) + 1) if existing_pages else 1

    print("=" * 70)
    print(f"Danbooru 别名表采集 → {OUT_PATH}")
    print(f"  已有页: {sorted(existing_pages)[:3]}{'...' if len(existing_pages) > 3 else ''} 起始页: {start_page}")
    print("=" * 70)

    total = 0
    started = time.time()
    with open(OUT_PATH, "a", encoding="utf-8") as handle:
        for page in range(start_page, args.max_pages + 1):
            _, rows = fetch_page(page)
            if rows is None:
                continue
            if not rows:
                print(f"  page {page}: 空页 → 结束")
                break
            for row in rows:
                record = dict(row)
                record["_page"] = page
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            total += len(rows)
            print(f"  page {page:>3}: +{len(rows):>4}  累计 {total}  用时 {time.time() - started:.0f}s")
            time.sleep(0.15)

    print("=" * 70)
    print(f"完成：新增 {total} 条别名，用时 {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
