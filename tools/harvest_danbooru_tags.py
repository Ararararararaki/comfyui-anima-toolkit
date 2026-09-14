# -*- coding: utf-8 -*-
"""TK Toolkit — 从 Danbooru 官方 API 采集全量标签元数据（离线一次性工具）。

产出：``data/_sources/danbooru_tags_api.jsonl``（每行一个 tag）
字段：name / category / post_count / is_deprecated / is_deleted

为什么用官方 API 而不是第三方 CSV/xlsx：
  * 官方 category（0=general 1=artist 3=copyright 4=character 5=meta）是唯一权威来源；
  * post_count 可用于阈值过滤与排序；
  * 换机器 / 换用户 / 别人没装 Packer 都不会退化（这是当前实现最大的架构脆弱性）。

设计要点：
  * **断点续传**：已存在的 jsonl 会按页数推断起点，重跑不会重复拉取；
  * **低频截断**：默认按 post_count 降序拉取，低于 ``--min-count`` 即停止；
  * **限速**：Danbooru 匿名限速约 10 req/s，默认 4 并发 + 抖动，避免被封；
  * **可重入**：单页失败重试 5 次，仍失败则该页跳过并记录（不整体中断）。

用法（在发布仓库根目录）：
    python -X utf8 tools/harvest_danbooru_tags.py --min-count 10
    python -X utf8 tools/harvest_danbooru_tags.py --min-count 5 --max-pages 700
"""

import argparse
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "data", "_sources", "danbooru_tags_api.jsonl")

API = "https://danbooru.donmai.us/tags.json"
USER_AGENT = (
    "TK-Toolkit/2.13.0 (+https://github.com/Ararararararaki/comfyui-anima-toolkit) "
    "offline tag taxonomy builder"
)
PAGE_SIZE = 1000

_print_lock = threading.Lock()


def log(message):
    with _print_lock:
        sys.stdout.write(message + "\n")
        sys.stdout.flush()


def build_url(page, category=None):
    params = {
        "limit": PAGE_SIZE,
        "page": page,
        "search[hide_empty]": "yes",
        "search[order]": "count",
    }
    if category is not None:
        params["search[category]"] = str(category)
    return f"{API}?{urllib.parse.urlencode(params)}"


def fetch_page(page, retries=5, category=None):
    """拉取单页；返回 (page, rows) 或 (page, None) 表示彻底失败。

    注意：Danbooru 触发限流时返回的是 JSON **对象**（{"success":false,...}）
    而不是数组。必须显式校验类型，否则错误响应会被当成 1 条记录混入结果。
    """
    last_error = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(build_url(page, category),
                                             headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise ValueError(f"HTTP {response.status}")
                body = response.read().decode("utf-8")
            if not body.lstrip().startswith("["):
                raise ValueError(f"unexpected payload (not a list): {body[:120]}")
            payload = json.loads(body)
            if not isinstance(payload, list):
                raise ValueError(f"unexpected payload type: {type(payload).__name__}")
            rows = []
            for item in payload:
                name = str(item.get("name") or "").strip()
                if not name:
                    continue
                rows.append({
                    "name": name,
                    "category": int(item.get("category") or 0),
                    "post_count": int(item.get("post_count") or 0),
                    "deprecated": bool(item.get("is_deprecated")),
                    "deleted": bool(item.get("is_deleted")),
                })
            return page, rows
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as error:
            last_error = error
            backoff = (1.5 ** attempt) + random.uniform(0, 0.6)
            time.sleep(backoff)
    log(f"  [X] page {page} failed after {retries} attempts: {type(last_error).__name__}: {last_error}")
    return page, None


def load_existing(path):
    """读取已采集结果，返回 (max_page, tag_count)。"""
    if not os.path.isfile(path):
        return 0, 0
    by_page = {}
    count = 0
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            page = int(record.get("_page") or 0)
            if page <= 0:
                continue
            by_page.setdefault(page, 0)
            count += 1
    return (max(by_page) if by_page else 0), count


def append_rows(handle, page, rows):
    for row in rows:
        record = dict(row)
        record["_page"] = page
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def main():
    parser = argparse.ArgumentParser(description="从 Danbooru 官方 API 采集全量标签元数据")
    parser.add_argument("--min-count", type=int, default=10,
                        help="post_count 低于该值即停止（默认 10；按 category 补全时用 1）")
    parser.add_argument("--max-pages", type=int, default=800,
                        help="最多拉取页数（默认 800）。Danbooru 硬上限是 page 1000")
    parser.add_argument("--workers", type=int, default=4,
                        help="并发数（默认 4，Danbooru 匿名限速约 10 req/s）")
    parser.add_argument("--start-page", type=int, default=0,
                        help="强制指定起始页（默认从已有结果续传）")
    parser.add_argument("--category", type=int, default=None,
                        help="只采集某个官方 category（0 general / 1 artist / 3 copyright "
                             "4 character / 5 meta）。全量 182 万条超过单查询 page 1000 上限，"
                             "必须分 category 拉取")
    parser.add_argument("--out", type=str, default="",
                        help="输出文件（默认 data/_sources/danbooru_tags_api.jsonl）")
    args = parser.parse_args()

    out_path = args.out or OUT_PATH
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    max_page, existing_count = load_existing(out_path)
    start_page = args.start_page or (max_page + 1)

    log("=" * 74)
    log("Danbooru 官方标签采集")
    log(f"  输出      : {out_path}")
    log(f"  已有      : {existing_count} 条 / 最大页 {max_page}")
    log(f"  起始页    : {start_page}")
    log(f"  category  : {args.category if args.category is not None else '全部'}")
    log(f"  停止条件  : post_count < {args.min_count} 或 页数 > {args.max_pages}")
    log(f"  并发      : {args.workers}")
    log("=" * 74)

    started = time.time()
    total_new = 0
    stop = False

    with open(out_path, "a", encoding="utf-8") as handle:
        for batch_start in range(start_page, args.max_pages + 1, args.workers * 4):
            if stop:
                break
            batch_pages = list(range(batch_start, min(batch_start + args.workers * 4, args.max_pages + 1)))
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                futures = {pool.submit(fetch_page, page, 5, args.category): page for page in batch_pages}
                results = {}
                for future in as_completed(futures):
                    page, rows = future.result()
                    results[page] = rows
            for page in sorted(results):
                rows = results[page]
                if rows is None:
                    continue
                if not rows:
                    log(f"  page {page}: 空页 → 结束")
                    stop = True
                    break
                lowest = min(row["post_count"] for row in rows)
                append_rows(handle, page, rows)
                handle.flush()
                total_new += len(rows)
                log(f"  page {page:>4}: +{len(rows):>4} 条  min_count={lowest:<8} 累计新增={total_new}")
                if lowest < args.min_count:
                    log(f"  → 已达 post_count < {args.min_count}，停止")
                    stop = True
                    break
            elapsed = time.time() - started
            log(f"  --- 批次完成，用时 {elapsed:.0f}s，累计新增 {total_new} ---")

    log("=" * 74)
    log(f"采集结束：本次新增 {total_new} 条，用时 {time.time() - started:.0f}s")
    log(f"总计文件行数：{sum(1 for _ in open(out_path, encoding='utf-8'))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
