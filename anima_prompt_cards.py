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

CARDS_DIR = os.path.join(folder_paths.get_input_directory(), "prompt_cards")
CARDS_PATH = os.path.join(CARDS_DIR, "cards.json")
CARDS_LOCK = threading.Lock()

PRESET_CATEGORIES = ["角色", "服饰", "姿势", "场景", "画风", "质量词", "LoRA 触发词"]


def _blank_cards():
    return {
        "categories": list(PRESET_CATEGORIES),
        "cards": {c: [] for c in PRESET_CATEGORIES},
    }


def _load_cards() -> dict:
    with CARDS_LOCK:
        try:
            if os.path.exists(CARDS_PATH):
                with open(CARDS_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    cats = [str(c) for c in (data.get("categories") or [])]
                    cards = data.get("cards")
                    if not isinstance(cards, dict):
                        cards = {}
                    for c in PRESET_CATEGORIES:
                        if c not in cats:
                            cats.append(c)
                        if c not in cards or not isinstance(cards[c], list):
                            cards[c] = []
                    return {"categories": cats, "cards": cards}
        except Exception as e:
            print(f"[TK Prompt Cards] 卡片库读取失败（按空库继续）: {e}")
    return _blank_cards()


def _save_cards(data: dict):
    with CARDS_LOCK:
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
    return web.json_response(_load_cards())


@PromptServer.instance.routes.post("/anima/cards")
async def cards_save(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "body must be object"}, status=400)
    cats = [str(c).strip() for c in (body.get("categories") or []) if str(c).strip()]
    cards = {}
    raw = body.get("cards")
    if isinstance(raw, dict):
        for cat, items in raw.items():
            cat = str(cat)
            if cat not in cats:
                cats.append(cat)
            if not isinstance(items, list):
                continue
            cards[cat] = []
            for it in items:
                if not isinstance(it, dict):
                    continue
                en = str(it.get("en", "")).strip()
                if not en:
                    continue
                cards[cat].append({
                    "en": en,
                    "zh": str(it.get("zh", "") or ""),
                    "weight": str(it.get("weight", "") or "") or "",
                    "star": bool(it.get("star")),
                    "lora": str(it.get("lora", "") or "") or "",
                    "src": str(it.get("src", "") or "") or "",
                    "ts": int(it.get("ts") or time.time() * 1000),
                })
        # 预置分类兜底
        for c in PRESET_CATEGORIES:
            if c not in cats:
                cats.append(c)
            if c not in cards:
                cards[c] = []
    data = {"categories": cats, "cards": cards}
    _save_cards(data)
    return web.json_response({"ok": True, "count": sum(len(v) for v in cards.values())})


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