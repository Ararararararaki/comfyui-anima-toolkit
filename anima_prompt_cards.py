# TK Prompt Cards —— 卡片库提示词编辑器节点 + /anima/cards/* 路由
#
# 功能：
#   1. 节点：持有「当前提示词」(positive widget)，可选 clip 输入 → STRING+CONDITIONING 双输出，
#      第三输出 lora_syntax（<lora:name:weight> 语法文本，直连 TK Batch LoRA Loader）
#   2. 卡片库：input/prompt_cards/cards.json（一级分类 → 卡片数组），预置分类开箱即用
#      卡片字段：en(必填) / zh / weight / star / lora(所属 LoRA 名) / src / ts / multi(组合卡)
#   3. 路由：
#      GET  /anima/cards              → 全库读取（含预置分类合并）
#      POST /anima/cards              → 全量保存
#      POST /anima/cards/export       → 导出选中卡片为批文件（input/prompts/<name>.txt）
#      POST /anima/cards/image        → PNG 元数据解析（提取正片/全部文本候选）
#      GET  /anima/cards/lora-triggers→ LoRA 触发词（bridge 优先 → Civitai trainedWords → 文件名兜底）
#   4. 翻译直接复用现有 /api/translate（local/deeplx/mymemory/google/dashscope 自动回退）
#
# 2026-08-17 新建。

import os
import re
import json
import time
import threading
import asyncio

import aiohttp
import folder_paths
from aiohttp import web
from server import PromptServer

from .anima_batch_lora import (
    BRIDGE_DATA,
    BRIDGE_LOCK,
    _find_lora_path,
)
from .anima_prompt_batch import (
    _input_root,
    _safe_resolve,
)
from .anima_prompt_parser import (
    parse_prompt_groups,
)

# ── 卡片库存储（input/prompt_cards/cards.json）──
# 2026-08-24 起升级为 v2 信封（节点卡片库的单一数据源，替代浏览器 IndexedDB）：
#   {
#     "version": 2,
#     "updated": <ms>,
#     "categories": [{"id","name","icon","sortOrder"}],   // 卡片分类（tag 级词组分类）
#     "cards": [{"id","en","zh","weight","star","lora","src","ts","multi","categories":[...]}]
#   }
# 旧格式（categories=字符串列表 + cards={分类名: [无 id 卡片]}）读取时自动迁移并落盘。

CARDS_DIR = os.path.join(folder_paths.get_input_directory(), "prompt_cards")
CARDS_PATH = os.path.join(CARDS_DIR, "cards.json")
CARDS_LOCK = threading.Lock()

# 旧版预置分类（字符串格式）在 _migrate_legacy 中由 DEFAULT_CARD_CATS 对应迁移

# 卡片分类默认集（与前端 CARD_DEFAULT_CATS 保持一致）
DEFAULT_CARD_CATS = [
    {"id": "card_all", "name": "通用", "icon": "", "sortOrder": 0},
    {"id": "card_char", "name": "角色", "icon": "", "sortOrder": 1},
    {"id": "card_style", "name": "画风", "icon": "", "sortOrder": 2},
    {"id": "card_pose", "name": "姿势", "icon": "", "sortOrder": 3},
    {"id": "card_scene", "name": "场景", "icon": "", "sortOrder": 4},
    {"id": "card_quality", "name": "质量词", "icon": "", "sortOrder": 5},
    {"id": "card_lora", "name": "LoRA 触发词", "icon": "", "sortOrder": 6},
]


def _blank_cards():
    return {"version": 2, "updated": int(time.time() * 1000),
            "categories": list(DEFAULT_CARD_CATS), "cards": []}


def _migrate_legacy(data: dict) -> dict:
    """旧格式（v1：字符串分类 + {分类名: [卡片]}）→ v2 信封。卡片补 id、多分类。"""
    cats = []
    for i, name in enumerate(data.get("categories") or []):
        cats.append({"id": f"legacy_{i}", "name": str(name), "icon": "", "sortOrder": i})
    if not cats:
        cats = list(DEFAULT_CARD_CATS)
    cards = []
    raw = data.get("cards")
    if isinstance(raw, dict):
        for cat_name, items in raw.items():
            cat = next((c for c in cats if c["name"] == str(cat_name)), None)
            if cat is None:
                cat = {"id": f"legacy_{len(cats)}", "name": str(cat_name), "icon": "", "sortOrder": len(cats)}
                cats.append(cat)
            for it in items or []:
                if not isinstance(it, dict):
                    continue
                en = str(it.get("en", "")).strip()
                if not en:
                    continue
                cards.append({
                    "id": it.get("id") or f"c_{int(time.time()*1000)}_{len(cards)}_{abs(hash(en)) % 100000}",
                    "en": en,
                    "zh": str(it.get("zh", "") or ""),
                    "weight": str(it.get("weight", "") or ""),
                    "star": bool(it.get("star")),
                    "lora": str(it.get("lora", "") or ""),
                    "src": str(it.get("src", "") or ""),
                    "ts": int(it.get("ts") or time.time() * 1000),
                    "multi": bool(it.get("multi")),
                    "categories": [cat["id"]],
                })
    # 预置分类兜底
    for c in DEFAULT_CARD_CATS:
        if not any(x["id"] == c["id"] for x in cats):
            cats.append(c)
    return {"version": 2, "updated": int(time.time() * 1000), "categories": cats, "cards": cards}


def _load_cards() -> dict:
    with CARDS_LOCK:
        try:
            if os.path.exists(CARDS_PATH):
                with open(CARDS_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    if data.get("version") == 2 and isinstance(data.get("categories"), list) \
                            and isinstance(data.get("cards"), list):
                        # 分类被清空时兜底默认分类（避免前端分类栏空白）
                        if not data["categories"]:
                            data["categories"] = list(DEFAULT_CARD_CATS)
                        return data
                    # 旧格式 → 迁移并落盘（幂等）
                    migrated = _migrate_legacy(data)
                    try:
                        _save_cards_locked(migrated)
                    except Exception:
                        pass
                    return migrated
        except Exception as e:
            print(f"[TK Prompt Cards] 卡片库读取失败（按空库继续）: {e}")
    return _blank_cards()


def _save_cards(data: dict):
    with CARDS_LOCK:
        _save_cards_locked(data)


def _save_cards_locked(data: dict):
    os.makedirs(CARDS_DIR, exist_ok=True)
    tmp = CARDS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, CARDS_PATH)


# ── PNG 元数据解析 ──

_TEXT_KEYS = {"text", "positive", "negative", "prompt", "input_str"}
_CLIP_LIKE = re.compile(r"CLIPTextEncode|PromptUI|TextEncode|PromptEditor", re.I)


def _parse_png_meta(filepath: str) -> dict:
    """读取 PNG 的 tEXt 块（ComfyUI 保存的 prompt/workflow JSON），提取文本类输入。"""
    from PIL import Image
    texts = []
    try:
        with Image.open(filepath) as im:
            info = dict(im.text or {})
    except Exception as e:
        return {"ok": False, "error": f"图片读取失败: {e}"}

    prompt_json = info.get("prompt", "")
    workflow_json = info.get("workflow", "")
    try:
        prompt_data = json.loads(prompt_json) if prompt_json else None
    except Exception:
        prompt_data = None

    if isinstance(prompt_data, dict):
        out = prompt_data.get("output")
        if not isinstance(out, dict):
            out = prompt_data
        for nid, node in out.items():
            if not isinstance(node, dict):
                continue
            cls = str(node.get("class_type") or "")
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for k, v in inputs.items():
                if isinstance(v, str) and k in _TEXT_KEYS and len(v.strip()) > 1:
                    texts.append({
                        "node": str(nid), "class": cls, "key": k, "text": v,
                    })

    # 正片挑选：CLIP 类节点的 positive/text 优先，取最长；否则所有候选中取最长
    positive = ""
    negative = ""
    best_clip = None
    for t in texts:
        if t["key"] == "positive":
            if positive is None or t["key"] == "positive" and (not positive or len(t["text"]) > len(positive)):
                positive = t["text"]
        elif t["key"] == "negative":
            if not negative or len(t["text"]) > len(negative):
                negative = t["text"]
        elif t["key"] == "text" and _CLIP_LIKE.search(t["class"]):
            if best_clip is None or len(t["text"]) > len(best_clip):
                best_clip = t["text"]
    if not positive and best_clip:
        positive = best_clip
    if not positive and texts:
        positive = max((t["text"] for t in texts if t["key"] != "negative"), key=len, default="")

    return {
        "ok": True,
        "positive": positive,
        "negative": negative,
        "texts": texts,
        "hasWorkflow": bool(workflow_json),
        "filename": os.path.basename(filepath),
    }


# ── LoRA 触发词（bridge 优先 → Civitai trainedWords → 文件名兜底）──

_TRIGGER_CACHE: dict = {}
_TRIGGER_TTL = 600


def _lora_trigger_words_sync(name: str) -> list[str]:
    """同步部分：bridge 触发词（面板「发送到 ComfyUI」带 lora_list[].trigger_words）。"""
    with BRIDGE_LOCK:
        for l in BRIDGE_DATA.get("lora_list", []) or []:
            if str(l.get("name", "")).replace(".safetensors", "") == name.replace(".safetensors", ""):
                return [str(w) for w in (l.get("trigger_words", []) or []) if w]
    return []


async def _lora_trigger_words_civitai(name: str) -> list[str]:
    """异步部分：Civitai trainedWords（复用现有 /anima/lora/info 的查询路径）。"""
    lora_path = _find_lora_path(name)
    if lora_path is None:
        return []
    try:
        from . import _sha256_file, _get_session
        loop = asyncio.get_event_loop()
        sha = await loop.run_in_executor(None, _sha256_file, lora_path)
        session = await _get_session()
        url = f"https://civitai.com/api/v1/model-versions/by-hash/{sha}"
        async with session.get(url, timeout=10) as resp:
            if resp.status == 200:
                data = await resp.json()
                return [str(w) for w in (data.get("trainedWords", []) or []) if w]
    except Exception:
        pass
    return []


# ── 路由 ──

@PromptServer.instance.routes.get("/anima/cards")
async def cards_get(request):
    """全库读取（v2 信封：{version, categories:[{id,name,icon,sortOrder}], cards:[...]}）。"""
    return web.json_response(_load_cards())


@PromptServer.instance.routes.post("/anima/cards")
async def cards_save(request):
    """全量保存（v2 信封为唯一持久化格式；兼容旧格式 body 输入）。

    也承担卡库 JSON 导入：前端把备份/导出文件的内容原样 POST 即恢复。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body must be object"}, status=400)

    if body.get("version") == 2:
        cats = []
        for i, c in enumerate(body.get("categories") or []):
            if not isinstance(c, dict):
                continue
            cid = str(c.get("id") or f"cat_{int(time.time()*1000)}_{i}").strip()
            if not cid:
                cid = f"cat_{int(time.time()*1000)}_{i}"
            cats.append({"id": cid, "name": str(c.get("name") or "未命名").strip() or "未命名",
                         "icon": str(c.get("icon") or ""), "sortOrder": int(c.get("sortOrder") if c.get("sortOrder") is not None else i)})
        cards = []
        seen_ids = set()
        for it in body.get("cards") or []:
            if not isinstance(it, dict):
                continue
            en = str(it.get("en", "")).strip()
            if not en:
                continue
            cid = str(it.get("id") or "").strip() or f"c_{int(time.time()*1000)}_{len(cards)}"
            if cid in seen_ids:
                cid = cid + f"_{len(cards)}"
            seen_ids.add(cid)
            cats_of = [str(x) for x in (it.get("categories") or []) if str(x)]
            if not cats_of and it.get("categoryId"):
                cats_of = [str(it["categoryId"])]
            cards.append({
                "id": cid,
                "en": en,
                "zh": str(it.get("zh", "") or ""),
                "weight": str(it.get("weight", "") or ""),
                "star": bool(it.get("star")),
                "lora": str(it.get("lora", "") or ""),
                "src": str(it.get("src", "") or ""),
                "ts": int(it.get("ts") or time.time() * 1000),
                "multi": bool(it.get("multi")),
                "categories": cats_of[:8],
            })
        data = {"version": 2, "updated": int(time.time() * 1000), "categories": cats, "cards": cards}
        _save_cards(data)
        return web.json_response({"ok": True, "count": len(cards), "version": 2})

    # 旧格式 body（分类名字符串列表 + {分类名: [卡片]}）→ 迁移后保存
    migrated = _migrate_legacy(body)
    _save_cards(migrated)
    return web.json_response({"ok": True, "count": len(migrated["cards"]), "version": 2})


@PromptServer.instance.routes.post("/anima/cards/export")
async def cards_export(request):
    """导出选中卡片为批文件：分类 → 组，组内一行 = 该分类全部卡片逗号拼接（合并成一条提示词）。

    body: {"name": "文件名", "groups": [{"name": "组名", "cards": [{"en": ..., "weight": ...}]}]}
    写入 input/prompts/<name>.txt；返回 ok + 路径。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    name = str(body.get("name", "") or "prompt_cards_export").strip()
    safe = re.sub(r'[\\/:*?"<>|]', "_", name).strip() or "prompt_cards_export"
    groups = body.get("groups")
    if not isinstance(groups, list) or not groups:
        return web.json_response({"ok": False, "error": "groups 不能为空"}, status=400)

    def fmt_card(c):
        en = str(c.get("en", "")).strip()
        w = str(c.get("weight", "") or "").strip()
        return f"({en}:{w})" if w else en

    lines = [f"# {safe} · TK Prompt Cards 导出 · {time.strftime('%Y-%m-%d %H:%M')}"]
    for g in groups:
        gname = str(g.get("name") or "未命名组").strip() or "未命名组"
        cards = [c for c in (g.get("cards") or []) if isinstance(c, dict) and str(c.get("en") or "").strip()]
        if not cards:
            continue
        lines.append("")
        lines.append(f"## {gname}")
        lines.append(", ".join(fmt_card(c) for c in cards))
        # 每张卡一行中文注释（批文件可读性）
        zhs = [str(c.get("zh", "") or "").strip() for c in cards if str(c.get("zh", "") or "").strip()]
        if zhs:
            lines.append("# " + " / ".join(zhs))
    if len(lines) <= 1:
        return web.json_response({"ok": False, "error": "没有可导出的卡片"}, status=400)

    root = _input_root()
    prompts_dir = os.path.join(root, "prompts")
    os.makedirs(prompts_dir, exist_ok=True)
    path = os.path.join(prompts_dir, safe + ".txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return web.json_response({"ok": True, "path": os.path.relpath(path, root),
                              "absolute": path, "groups": len(groups)})


@PromptServer.instance.routes.post("/anima/cards/image")
async def cards_image(request):
    """PNG 元数据解析。body: {"path": 相对 input/ 或绝对路径}。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    p = str(body.get("path", "") or "").strip()
    if not p:
        return web.json_response({"ok": False, "error": "缺少 path"}, status=400)
    filepath = _safe_resolve(p)
    if not filepath or not os.path.isfile(filepath):
        return web.json_response({"ok": False, "error": f"图片不存在: {p}"}, status=404)
    if not filepath.lower().endswith(".png"):
        return web.json_response({"ok": False, "error": "目前仅支持 PNG（含工作流元数据）"}, status=400)
    return web.json_response(_parse_png_meta(filepath))


@PromptServer.instance.routes.get("/anima/cards/lora-triggers")
async def cards_lora_triggers(request):
    name = request.query.get("name", "").strip()
    if not name:
        return web.json_response({"error": "name required"}, status=400)
    now = time.time()
    cached = _TRIGGER_CACHE.get(name)
    if cached and cached[0] > now:
        return web.json_response({"name": name, "triggerWords": cached[1]})
    words = _lora_trigger_words_sync(name)
    if not words:
        words = await _lora_trigger_words_civitai(name)
    if words:
        _TRIGGER_CACHE[name] = (now + _TRIGGER_TTL, words)
    return web.json_response({"name": name, "triggerWords": words})


# ── LLM 自动分类（卡片库；Ollama 本地优先，其次 OpenAI 兼容反代）──

LLM_CONF_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
LLM_CONF_PATH = os.path.join(LLM_CONF_DIR, "llm_config.json")
LLM_CONF_LOCK = threading.Lock()
OLLAMA_BASE = "http://127.0.0.1:11434"

_LLM_CONFIG_DEFAULT = {"mode": "auto", "base_url": "", "api_key": "", "model": ""}


def _load_llm_conf() -> dict:
    with LLM_CONF_LOCK:
        try:
            if os.path.exists(LLM_CONF_PATH):
                with open(LLM_CONF_PATH, "r", encoding="utf-8") as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    return {**_LLM_CONFIG_DEFAULT, **d}
        except Exception as e:
            print(f"[TK Prompt Cards] LLM 配置读取失败: {e}")
    return dict(_LLM_CONFIG_DEFAULT)


def _save_llm_conf(conf: dict):
    with LLM_CONF_LOCK:
        os.makedirs(LLM_CONF_DIR, exist_ok=True)
        with open(LLM_CONF_PATH, "w", encoding="utf-8") as f:
            json.dump(conf, f, ensure_ascii=False, indent=2)


async def _ollama_available() -> tuple[bool, str]:
    """探测本地 Ollama；返回 (可用, 建议模型名)。"""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as s:
            async with s.get(OLLAMA_BASE + "/api/tags") as r:
                if r.status == 200:
                    data = await r.json()
                    models = [m.get("name", "") for m in (data.get("models") or [])]
                    for prefer in ("qwen2.5", "qwen2", "llama3.1", "llama3", "gemma2", "mistral"):
                        for m in models:
                            if m.startswith(prefer):
                                return True, m
                    if models:
                        return True, models[0]
    except Exception:
        pass
    return False, ""


async def _llm_chat(messages: list, conf: dict, timeout: int = 90) -> str:
    """调用 LLM（Ollama 或 OpenAI 兼容反代），返回文本。"""
    mode = conf.get("mode", "auto")
    base = (conf.get("base_url") or "").strip().rstrip("/")
    key = (conf.get("api_key") or "").strip()
    model = (conf.get("model") or "").strip()
    ok, ollama_model = await _ollama_available()
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as s:
        if mode == "ollama" or (mode == "auto" and ok):
            async with s.post(OLLAMA_BASE + "/api/chat",
                              json={"model": model or ollama_model, "messages": messages,
                                    "stream": False, "options": {"temperature": 0.1}}) as r:
                if r.status == 200:
                    data = await r.json()
                    return str(data.get("message", {}).get("content", "") or "")
                raise RuntimeError(f"Ollama http_{r.status}")
        if mode == "api" or (mode == "auto" and base and model):
            if not (base and model):
                raise RuntimeError("LLM API 配置不完整（需 base_url + model）")
            url = base + "/chat/completions"
            hdrs = {"Content-Type": "application/json"}
            if key:
                hdrs["Authorization"] = "Bearer " + key
            async with s.post(url, json={"model": model, "messages": messages, "temperature": 0.1}, headers=hdrs) as r:
                if r.status == 200:
                    data = await r.json()
                    return str((data.get("choices") or [{}])[0].get("message", {}).get("content", "") or "")
                raise RuntimeError(f"API http_{r.status}")
    raise RuntimeError("未配置可用的 LLM：请开启 Ollama，或在设置中配置 API 反代（base_url/model/api_key）")


@PromptServer.instance.routes.get("/anima/llm/config")
async def llm_config_get(request):
    conf = _load_llm_conf()
    ok, ollama_model = await _ollama_available()
    return web.json_response({
        "mode": conf.get("mode", "auto"),
        "base_url": conf.get("base_url", ""),
        "model": conf.get("model", ""),
        "hasApiKey": bool(conf.get("api_key")),
        "ollama": {"available": ok, "model": ollama_model},
    })


@PromptServer.instance.routes.post("/anima/llm/config")
async def llm_config_set(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    conf = _load_llm_conf()
    if "mode" in body:
        conf["mode"] = str(body["mode"]) if str(body["mode"]) in ("auto", "ollama", "api") else "auto"
    if "base_url" in body:
        conf["base_url"] = str(body["base_url"] or "").strip()
    if "api_key" in body:
        new_key = str(body["api_key"] or "").strip()
        if new_key:
            conf["api_key"] = new_key
        # 留空 = 保留已有 key（防止 UI 保存时误清空导致 502）
        # 显式清除用 "api_key_clear": true
        if body.get("api_key_clear"):
            conf["api_key"] = ""
    if "model" in body:
        conf["model"] = str(body["model"] or "").strip()
    _save_llm_conf(conf)
    return web.json_response({"ok": True})


def _extract_json_array(text: str) -> list:
    """从容错文本提取 JSON 数组（LLM 常带 ```json 或前后废话）。"""
    if not text:
        return []
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
        if isinstance(data, list):
            return [str(x).strip() for x in data]
    except Exception:
        pass
    out = []
    for line in text.splitlines():
        s = line.strip().strip('",[]').strip()
        if s and s != "```" and not s.startswith("json"):
            out.append(s)
    return out


@PromptServer.instance.routes.post("/anima/cards/classify")
async def cards_classify(request):
    """LLM 自动分类（质量版提示词：准则 + few-shot + 分类释义）。

    body: {cards: [{id, text}], cats: [分类名...], cats_info: [{name, hint}]}
    → [{id, categoryName}]。批次上限 30（小批提升分类质量）。
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    cards = body.get("cards")
    cats = body.get("cats")
    if not isinstance(cards, list) or not cards:
        return web.json_response({"ok": False, "error": "cards 不能为空"}, status=400)
    if not isinstance(cats, list) or not cats:
        return web.json_response({"ok": False, "error": "cats 不能为空"}, status=400)
    cats = [str(c) for c in cats if str(c).strip()]
    # 分类释义（可选）：cats_info 提供 name→hint，帮助模型理解自定义分类
    cats_info = body.get("cats_info") or []
    hints = {}
    if isinstance(cats_info, list):
        for ci in cats_info:
            if isinstance(ci, dict) and ci.get("name"):
                hints[str(ci["name"])] = str(ci.get("hint") or "").strip()
    cat_labels = [f"{c}" + (f"（{hints[c]}）" if hints.get(c) else "") for c in cats]
    conf = _load_llm_conf()

    batch = cards[:30]
    lines = []
    for c in batch:
        text = str(c.get("text") or "").strip()[:120]
        lines.append(f"{c.get('id')}: {text}")

    system = (
        "你是提示词标签分类助手。把每个提示词标签（卡片）归入最合适的分类。\n"
        "分类准则：\n"
        "1. 角色名/动漫角色/人名 → 角色类\n"
        "2. 画风/风格/画师/渲染方式 → 画风类\n"
        "3. 服装/服饰/穿着 → 服饰类（如有）\n"
        "4. 动作/姿势/姿态/体位 → 姿势类\n"
        "5. 场景/环境/背景/地点/道具 → 场景类\n"
        "6. 品质/评分词（masterpiece、best quality、highres 等）→ 质量词类\n"
        "7. LoRA/模型触发词 → LoRA 触发词类（如有）\n"
        "8. 无法明确归类或列表中没有合适项 → 通用类\n"
        "歧义标签选择最可能的分类；宁选「通用」也不硬塞错误分类。\n"
        "只输出 JSON 数组：每个元素是「分类列表」中的名称之一，与输入行一一对应。"
        "不要输出任何解释、编号或多余文本。"
    )
    user = (
        f"分类列表：{json.dumps(cat_labels, ensure_ascii=False)}\n\n"
        "示例（演示归类逻辑，分类名可能与你的列表不同）：\n"
        '输入卡片：\n1: skadi (arknights)\n2: masterpiece, best quality\n3: sitting on a chair, legs crossed\n'
        '输出：["角色", "质量词", "姿势"]\n\n'
        "待分类卡片（行号: 内容）：\n" + "\n".join(lines)
    )

    try:
        out = await _llm_chat([{"role": "system", "content": system},
                               {"role": "user", "content": user}], conf)
    except Exception as e:
        return web.json_response({"ok": False, "error": f"LLM 调用失败：{e}"}, status=502)

    parsed = _extract_json_array(out)
    result = []
    for i, c in enumerate(batch):
        name = parsed[i] if i < len(parsed) else ""
        # 归一容错：模型可能原样复制「名称（释义）」或带引号/空格
        if name not in cats:
            base = str(name).split("（")[0].strip()
            if base in cats:
                name = base
            else:
                name = ""
        result.append({"id": str(c.get("id")), "categoryName": name})
    return web.json_response({"ok": True, "result": result})


# ── 节点 ──

class TKPromptCards:
    NAME = "TK Prompt Cards"
    CATEGORY = "TK/prompt"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "当前提示词（卡片库/批文件一键填充，也可直接编辑）",
                    "tooltip": "当前提示词文本：可由批文件组/卡片库点击填充，逗号分隔 tag。随工作流持久化。",
                }),
            },
            "optional": {
                "clip": ("CLIP",),
                "opt_text": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "外部并入文本（可选）",
                    "tooltip": "外部文本并入（接其他节点输出）：与 positive 逗号拼接。",
                }),
                "lora_syntax": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "<lora:name:weight>",
                    "tooltip": "当前 LoRA 语法文本（前端点击触发词卡片时自动维护），输出端口直连 TK Batch LoRA Loader。",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "CONDITIONING", "STRING")
    RETURN_NAMES = ("STRING", "CONDITIONING", "lora_syntax")
    FUNCTION = "execute"
    DESCRIPTION = ("提示词卡片库编辑器：本地批文件一键切换、卡片库（英中对照 tag）拼接当前提示词；"
                   "可选 clip 输入直接编码出 CONDITIONING；lora_syntax 输出直连 TK Batch LoRA Loader 加载触发词对应 LoRA")

    def execute(self, positive="", clip=None, opt_text="", lora_syntax=""):
        text = str(positive or "").strip()
        extra = str(opt_text or "").strip()
        if extra:
            text = (text + ", " + extra).strip(", ").strip()

        conditioning = None
        if clip is not None:
            try:
                tokens = clip.tokenize(text)
                out = clip.encode_from_tokens(tokens, return_pooled=True, return_dict=True)
                cond = out.pop("cond")
                conditioning = [[cond, out]]
            except Exception as e:
                print(f"[TK Prompt Cards] CLIP 编码失败（退化为纯 STRING）: {e}")
                conditioning = None

        return (text, conditioning, str(lora_syntax or "").strip())


NODE_CLASS_MAPPINGS = {"TKPromptCards": TKPromptCards}
NODE_DISPLAY_NAME_MAPPINGS = {"TKPromptCards": "TK Prompt Cards"}