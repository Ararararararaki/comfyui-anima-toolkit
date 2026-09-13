"""Build data/danbooru_alias_index.json from harvested evidence.

Pure/offline: reads only local source files, writes one compact index. No network,
so it is safe to run in tests.

Inputs (all optional except the danbooru CSV):
  data/danbooru_tags_with_description_v3_modified.csv   base tag list + zh keywords
  data/danbooru_tags_zh.json                            community en->zh dictionary
  data/_sources/animadex_characters.json                character list (series, popularity)
  data/_sources/civitai_loras.jsonl                     Chinese-name evidence from LoRAs

Output:
  data/danbooru_alias_index.json

The Chinese aliases are *derived*, never invented. Every alias carries the source
that produced it and, for civitai, the support/purity that justified it:
  civitai  a Chinese LoRA title paired with the danbooru tag in trainedWords
  csv      the 关键词 field of the shipped dictionary
  zhjson   the community en->zh dictionary

Usage:
    python tools/build_tag_alias_index.py [--report]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(PLUGIN_ROOT, "data")
SOURCES = os.path.join(DATA, "_sources")

CSV_PATH = os.path.join(DATA, "danbooru_tags_with_description_v3_modified.csv")
ZH_PATH = os.path.join(DATA, "danbooru_tags_zh.json")
ANIMADEX_PATH = os.path.join(SOURCES, "animadex_characters.json")
CIVITAI_PATH = os.path.join(SOURCES, "civitai_loras.jsonl")
# 产物放**插件根目录**：更新链的发布白名单是 anima_*/services_/web_/app_ + 几个根文件，
# `data/` 被整个排除（保护用户状态），放 data/ 里老用户点更新拿不到新词典。
OUT_PATH = os.path.join(PLUGIN_ROOT, "anima_alias_index.json")

CJK_RE = re.compile(r"[\u3400-\u9fff]+")
# Runs that also swallow kana: "竜華キサキ" must be seen as ONE token so it can be
# rejected as a Japanese name, instead of leaving the bare surname "竜華" behind.
NAME_RUN_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]{2,12}")
KANA_RE = re.compile(r"[\u3040-\u30ff]")
TAG_OK_RE = re.compile(r"^[a-z0-9_()'\-.,!&+ ]+$")

# Tokens that are never a character name: format/art words Chinese authors put in titles.
STOPWORDS = {
    "风格", "画风", "模型", "角色", "人物", "合集", "全角色", "服装", "衣服", "泳装", "睡衣",
    "系列", "高清", "整合", "包", "合集包", "动作", "表情", "姿势", "场景", "背景", "道具",
    "头像", "壁纸", "插画", "立绘", "可爱", "精致", "优化", "加强", "升级", "重置", "重制",
    "测试", "预览", "免费", "付费", "会员", "独家", "推荐", "教程", "教程包", "工作流",
    "动漫", "二次元", "日系", "国风", "古风", "写实", "真实", "摄影", "摄影风格", "线稿",
    "多角色", "单人", "双人", "全身", "半身", "特写", "表情包", "多种", "版", "版v",
    "萝莉", "御姐", "少女", "男孩", "女孩", "男性", "女性", "人物角色", "最新", "新版",
    "融合", "混合", "风格化", "赛璐璐", "厚涂", "平涂", "手绘", "水彩", "油画", "素描",
    "官方", "原作", "原画", "同人", "自训练", "自训", "练", "训练", "数据集",
    "衣装", "制服", "私服", "水着", "体操服", "部活", "限定", "全身图", "立绘版",
    "一番", "通常", "基本", "完全", "再现", "还原", "修正", "改良", "特化", "强化",
}
# Japanese-only kanji forms that show up in LoRA titles; never a Chinese alias.
# Deliberately conservative: only characters that are not used in Chinese.
JP_FORM_HINT = ("竜", "沢", "絵", "嬢", "獣", "剣", "鉄", "駅")
# Latin fragments that are not tags.
TAG_NOISE = {
    "1girl", "1boy", "solo", "highres", "absurdres", "best quality", "masterpiece",
    "lora", "v1", "v2", "v3", "style", "anime", "realistic", "nsfw", "sfw", "safetensors",
}


def key(value: str) -> str:
    """Same normalization the runtime uses: casefold, drop backslashes, keep alnum."""
    text = str(value or "").casefold().replace("\\", "")
    return "".join(ch for ch in text if ch.isalnum())


def display_tag(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("_", " ")).strip()


def clean_tag(raw: str) -> str:
    """Trained-word -> plain danbooru tag (drop weights, unescape, unwrap)."""
    text = str(raw or "")
    text = re.sub(r":\s*[0-9]*\.?[0-9]+\s*\)", ")", text)   # (tag:1.2) -> (tag)
    text = text.replace("\\(", "(").replace("\\)", ")")
    text = text.replace("[", "").replace("]", "").replace("{", "").replace("}", "")
    text = text.split(",")[0]
    text = re.sub(r"\s+", " ", text.replace("_", " ")).strip(" .")
    return text.casefold()


def load_danbooru(csv_path: str):
    """tag_key -> {tag, count, category, zh_from_csv}"""
    entries = {}
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 4:
                continue
            tag = str(row[0] or "").strip()
            if not tag:
                continue
            k = key(tag)
            if not k or k in entries:
                continue
            try:
                count = max(0, int(str(row[2] or "0").strip()))
            except (TypeError, ValueError):
                count = 0
            entries[k] = {
                "tag": tag,
                "count": count,
                "category": str(row[1] or "0").strip(),
                "description": str(row[3] or "").strip(),
            }
    return entries


def csv_keywords(description: str):
    """Pull the Chinese keyword list out of a description, dropping categorisation words."""
    text = re.sub(r"\s+", " ", str(description or "")).strip()
    if not text:
        return []
    match = re.search(r"关键词\s*[:：]\s*(.+)$", text)
    source = match.group(1) if match else ""
    out = []
    for part in re.split(r"[、，,；;|/]+", source):
        item = re.sub(r"[<>《》【】\[\]()（）]", "", part).strip()
        item = re.sub(r"^[（(]?\s*(角色|人物|作品|版权|画师|艺术家|对象|人数|物种)\s*[）)]?\s*$", "", item)
        if not item or not CJK_RE.search(item) or len(item) > 24:
            continue
        if item in STOPWORDS:
            continue
        if item not in out:
            out.append(item)
    return out[:8]


def load_zh_dict(path: str):
    out = {}
    if not os.path.exists(path):
        return out
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return out
    if isinstance(raw, dict):
        for k, v in raw.items():
            ks, vs = str(k or "").strip(), str(v or "").strip()
            if ks and vs and not CJK_RE.search(ks) and CJK_RE.search(vs):
                out[key(ks)] = vs
    return out


# Substrings that mark a keyword as a translation artifact of the tag's *category*
# rather than a real alternate name (e.g. "木崎蓝色档案" = surname + series name).
ARTIFACT_SUBSTRINGS = ("角色", "人物", "版权", "画师", "艺术家", "人数", "物种", "对象",
                       "作品", "全角色", "合集", "表情", "头像", "壁纸")
LATIN_RE = re.compile(r"[A-Za-z]")


def alias_quality(text: str, series_zh_names) -> bool:
    """Reject alias candidates that are structurally not a name a user would type."""
    item = str(text or "").strip()
    if not item or len(item) > 10:
        return False
    if not CJK_RE.search(item):
        return False
    # mixed CJK+Latin is always a translation artifact ("Blueaka角色")
    if LATIN_RE.search(item):
        return False
    if any(bad in item for bad in ARTIFACT_SUBSTRINGS):
        # ...unless the whole alias *is* the series name being described
        if item not in series_zh_names:
            return False
    if any(h in item for h in JP_FORM_HINT):
        return False
    # "木崎蓝色档案" / "橘望 (蔚蓝档案)": surname glued onto a known series name
    for sname in series_zh_names:
        if len(sname) >= 3 and item != sname and item.endswith(sname):
            return False
    return True


def split_parenthetical(value: str):
    """'橘望 (蔚蓝档案)' -> ['橘望 (蔚蓝档案)', '橘望']"""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    out = [text] if text else []
    bare = re.sub(r"\s*[（(][^（()）]*[)）]\s*$", "", text).strip()
    if bare and bare != text:
        out.append(bare)
    return out


def load_animadex(path: str):
    """tag_key -> {tag, series, series_name, count}"""
    out = {}
    if not os.path.exists(path):
        return out
    try:
        with open(path, "r", encoding="utf-8") as fh:
            rows = json.load(fh)
    except (OSError, ValueError):
        return out
    for row in rows if isinstance(rows, list) else []:
        slug = str(row.get("slug") or "").strip()
        if not slug:
            continue
        tag = display_tag(slug)
        k = key(tag)
        if not k:
            continue
        copyright_slug = str(row.get("copyright") or "").strip()
        out[k] = {
            "tag": tag,
            "series": display_tag(copyright_slug),
            "series_name": str(row.get("copyright_name") or display_tag(copyright_slug)).strip(),
            "count": int(row.get("count") or 0),
            "name": str(row.get("name") or "").strip(),
        }
    return out


def iter_civitai(path: str):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def mine_civitai(path: str, character_tags: set, exclude_tokens=()):
    """token -> Counter(character tag), plus token -> Counter(series key).

    Only *character* tags may pair with a token. A LoRA's trainedWords also carry
    attribute tags ("black hair", "double bun", ...); counting those made the
    distinct-tag check reject every real pairing.

    Tokens containing kana are dropped: they are Japanese names, and keeping them
    would also leave bare surname fragments behind.
    """
    exclude = set(exclude_tokens or ())
    token_tags = defaultdict(Counter)
    token_series = defaultdict(Counter)
    token_models = Counter()
    for rec in iter_civitai(path):
        title = str(rec.get("title") or "")
        vname = str(rec.get("version_name") or "")
        blob = title + " | " + vname
        tokens = [
            t for t in NAME_RUN_RE.findall(blob)
            if not KANA_RE.search(t) and t not in STOPWORDS and t not in exclude
        ]
        if not tokens:
            continue
        tags = []
        for word in rec.get("trained") or []:
            for chunk in re.split(r"[,\n]", str(word)):
                tag = clean_tag(chunk)
                if not tag or tag in TAG_NOISE or len(tag) > 60:
                    continue
                if not TAG_OK_RE.match(tag):
                    continue
                k = key(tag)
                if k not in character_tags:
                    continue
                tags.append(tag)
        if not tags:
            continue
        tags = list(dict.fromkeys(tags))[:12]
        # Cap tokens per record so "全角色" style dumps do not dominate.
        for token in dict.fromkeys(tokens[:6]):
            token_models[token] += 1
            for tag in tags:
                token_tags[token][tag] += 1
                m = re.search(r"\(([^()]+)\)\s*$", tag)
                if m:
                    token_series[token][key(m.group(1))] += 1
    return token_tags, token_series, token_models


def build(min_support=2, min_purity=0.6, max_distinct=6, report=False):
    if not os.path.exists(CSV_PATH):
        raise SystemExit("missing base dictionary: %s" % CSV_PATH)
    entries = load_danbooru(CSV_PATH)
    zh_dict = load_zh_dict(ZH_PATH)
    animadex = load_animadex(ANIMADEX_PATH)
    known = set(entries) | set(animadex)

    characters = {}
    for k, meta in animadex.items():
        base = entries.get(k, {})
        tag = base.get("tag") or meta["tag"]
        characters[k] = {
            "t": tag,
            "c": max(meta["count"], base.get("count", 0)),
            "s": meta["series"],
            "sn": meta["series_name"],
        }

    aliases = defaultdict(lambda: {"civitai": [], "csv": [], "zhjson": []})
    evidence = defaultdict(list)

    # --- series table first: alias filters need to know the series names ---
    series = {}
    for k, meta in animadex.items():
        s = meta["series"]
        sk = key(s)
        if not sk:
            continue
        row = series.setdefault(sk, {"n": s, "sn": meta["series_name"], "c": 0, "chars": 0, "zh": []})
        row["c"] += meta["count"]
        row["chars"] += 1
    for k, meta in entries.items():
        if meta.get("category") != "3":
            continue
        if k in series:
            continue
        series[k] = {"n": meta["tag"], "sn": meta["tag"], "c": meta.get("count", 0), "chars": 0, "zh": []}
    series_zh_names = set()

    # --- source 1: civitai (verified pairings) ---
    character_tags = {k for k, meta in entries.items() if meta.get("category") == "4"}
    character_tags |= set(animadex)
    t_tags, t_series, t_models = mine_civitai(CIVITAI_PATH, character_tags, series_zh_names)
    series_zh = defaultdict(Counter)
    kept_pairs = 0
    for token, counter in t_tags.items():
        total = sum(counter.values())
        distinct = len(counter)
        best_tag, best_n = counter.most_common(1)[0]
        purity = best_n / float(total) if total else 0.0
        # series evidence: this token co-occurs with many characters of one series
        ser = t_series.get(token) or Counter()
        if ser:
            s_best, s_n = ser.most_common(1)[0]
            if distinct >= 3 and s_n >= 3:
                series_zh[s_best][token] += s_n
        if token in series_zh_names:
            continue
        if distinct > max_distinct:
            continue
        if best_n < min_support:
            # A single piece of evidence is still usable, but only when the token
            # actually looks like a name: 2-4 CJK chars. Descriptors that share a
            # title with the tag ("铁道学院双子") are 5+ chars and get dropped here.
            if best_n != 1 or not (2 <= len(token) <= 4):
                continue
        elif purity < min_purity:
            continue
        if not alias_quality(token, series_zh_names):
            continue
        k = key(best_tag)
        if not k:
            continue
        aliases[k]["civitai"].append(token)
        kept_pairs += 1
        if report and len(evidence[k]) < 6:
            evidence[k].append("%s x%d/%d purity=%.2f" % (token, best_n, total, purity))

    # series Chinese names also come from the community dictionary (highest trust)    for sk, row in series.items():
        zh = zh_dict.get(sk)
        if zh:
            for item in split_parenthetical(zh):
                if item and item not in row["zh"]:
                    row["zh"].append(item)
    for sk, row in series.items():
        meta = entries.get(sk)
        if meta:
            for item in csv_keywords(meta.get("description", "")):
                if item not in row["zh"]:
                    row["zh"].append(item)
    # civitai-derived series names go last: they are the least trustworthy
    for sk, counter in series_zh.items():
        row = series.get(sk)
        if row is None:
            continue
        for token, n in counter.most_common(4):
            if token not in row["zh"] and n >= 4 and not any(h in token for h in JP_FORM_HINT):
                row["zh"].append(token)
    for row in series.values():
        row["zh"] = [z for z in row["zh"] if alias_quality(z, set())][:5]
        series_zh_names.update(row["zh"])

    # --- source 2: community en->zh dictionary (more reliable than the CSV glosses) ---
    zhjson_n = 0
    for k, zh in zh_dict.items():
        if k not in entries and k not in characters:
            continue
        for item in split_parenthetical(zh):
            if alias_quality(item, series_zh_names) and item not in aliases[k]["zhjson"]:
                aliases[k]["zhjson"].append(item)
                zhjson_n += 1

    # --- source 3: shipped CSV keywords (machine-translated; kept last on purpose) ---
    csv_kw = 0
    for k, meta in entries.items():
        for item in csv_keywords(meta.get("description", "")):
            if alias_quality(item, series_zh_names) and item not in aliases[k]["csv"]:
                aliases[k]["csv"].append(item)
                csv_kw += 1

    # --- assemble ---
    # Aliases are built once, here, and everything else derives from this map
    # (it is also what ships to the runtime).
    #
    # Order matters only for *display* (the runtime shows aliases[0] as the
    # subtitle): the community dictionary leads because it carries full names
    # ("小鸟游星野"), while the CSV glosses are machine translations and the
    # civitai tokens can be surname fragments ("空崎").
    # Search itself indexes every alias equally, so a fragment never hides a name.
    out_aliases = {}
    for k, al in aliases.items():
        merged = []
        for src in ("zhjson", "civitai", "csv"):
            for item in al[src]:
                if item not in merged:
                    merged.append(item)
        if merged:
            out_aliases[k] = merged[:8]

    payload_chars = {}
    for k, meta in characters.items():
        sk = key(meta["s"])
        row = {"t": meta["t"], "c": meta["c"], "s": meta["s"]}
        zh = out_aliases.get(k)
        if zh:
            row["zh"] = zh[:8]
        payload_chars[k] = row

    payload = {
        "version": 1,
        "built": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "stats": {
            "base_tags": len(entries),
            "characters": len(payload_chars),
            "series": len(series),
            "aliases": len(out_aliases),
            "civitai_pairs": kept_pairs,
            "csv_keywords": csv_kw,
            "zhjson_entries": zhjson_n,
        },
        "series": series,
        "characters": payload_chars,
        "aliases": out_aliases,
    }
    return payload, evidence


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--min-support", type=int, default=2)
    ap.add_argument("--min-purity", type=float, default=0.6)
    args = ap.parse_args()

    payload, evidence = build(min_support=args.min_support, min_purity=args.min_purity, report=args.report)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, args.out)
    print(json.dumps(payload["stats"], ensure_ascii=False, indent=2))
    print("wrote %s (%.1f MB)" % (args.out, os.path.getsize(args.out) / 1048576.0))

    if args.report:
        print()
        print("=== spot check ===")
        for probe in ("nozomi (blue archive)", "kisaki (blue archive)", "hina (blue archive)",
                      "shiroko (blue archive)", "hoshino (blue archive)", "mika (blue archive)"):
            k = key(probe)
            print("  %-28s zh=%s" % (probe, payload["aliases"].get(k, "-")))
            if k in evidence:
                for e in evidence[k][:3]:
                    print("        evidence: %s" % e)
        print()
        print("=== blue archive series zh ===")
        print("  ", payload["series"].get("bluearchive", {}).get("zh"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
