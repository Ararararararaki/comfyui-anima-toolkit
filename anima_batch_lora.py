# Anima Batch LoRA Loader - ComfyUI custom node
# Reads <lora:name:weight> syntax and loads multiple LoRAs in sequence.
# Also supports bridge mode: reads from in-memory bridge data (HTTP API)
# or falls back to anima_bridge.json for backward compatibility.

import re
import json
import os
import threading
import asyncio
import folder_paths
import comfy.sd
import comfy.utils
from aiohttp import web
from server import PromptServer

# ── In-memory bridge data (shared with __init__.py via HTTP API) ──
BRIDGE_DATA: dict = {}
BRIDGE_LOCK = threading.Lock()

BRIDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anima_bridge.json")


def _best_match(candidates: list[str]) -> str | None:
    """Pick the best candidate by most recent file modification time."""
    if not candidates:
        return None
    if len(candidates) == 1:
        return folder_paths.get_full_path("loras", candidates[0])

    def mtime(fname):
        try:
            return os.path.getmtime(folder_paths.get_full_path("loras", fname))
        except Exception:
            return 0

    return folder_paths.get_full_path("loras", max(candidates, key=mtime))


def _find_lora_path(lora_name: str) -> str | None:
    """Find lora file by name with graduated strategy (strict → fuzzy).

    Supports subdirectory references (e.g. ``detail/slider``).
    """
    all_loras = folder_paths.get_filename_list("loras")
    if not all_loras:
        return None

    lora_lower = lora_name.lower().replace("\\", "/")

    # Utility: get normalized base name (keep subdirectory prefix)
    def base(f):
        base = os.path.splitext(f)[0]
        return base.replace("\\", "/").lower()

    # 0: Full path match (supports "subdir/name.safetensors", "subdir/name")
    for _suff in (".safetensors", ".pt", ".pth", ".ckpt", ".bin"):
        candidate = lora_lower if lora_lower.endswith(_suff) else lora_lower + _suff
        if candidate in all_loras:
            return folder_paths.get_full_path("loras", candidate)

    # 1: Exact base match (basename without extension)
    matches = [f for f in all_loras if base(f) == lora_lower]
    if matches:
        return _best_match(matches)

    # 2: Alphanumeric-only comparison
    clean = re.sub(r"[^a-z0-9/]", "", lora_lower)
    matches = [f for f in all_loras if re.sub(r"[^a-z0-9/]", "", base(f)) == clean]
    if matches:
        return _best_match(matches)

    # 3: Token match — every meaningful token must appear (safe substring)
    tokens = [t for t in re.split(r"[\s_\-./\\]+", lora_lower) if len(t) > 2]
    if tokens:
        matches = [
            f for f in all_loras
            if all(t in base(f) for t in tokens)
        ]
        # Prefer shorter match (fewer extra chars = closer match)
        if matches:
            matches.sort(key=lambda f: len(base(f)))
            return _best_match(matches)

    return None


def _parse_lora_syntax(text: str) -> list[dict]:
    """Parse <lora:name:strength> or <lora:name:model_strength:clip_strength>."""
    pattern = r"<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>"
    matches = re.findall(pattern, text, re.IGNORECASE)
    loras = []
    for match in matches:
        try:
            ms = float(match[1])
            cs = float(match[2]) if match[2] else ms
        except ValueError:
            print(f"[AnimaBatchLoRA] 跳过非法权重: name={match[0]!r} weight={match[1]!r}")
            continue
        loras.append({
            "name": match[0],
            "model_strength": ms,
            "clip_strength": cs,
        })
    return loras


class AnimaBatchLoRALoader:
    NAME = "Anima Batch LoRA Loader"
    CATEGORY = "Anima/loaders"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_syntax": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "<lora:name:weight> <lora:name:weight> ...",
                    "tooltip": "LoRA tags synced with the visual editor below.",
                }),
            },
            "optional": {
                "clip": ("CLIP",),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "trigger_words")
    FUNCTION = "load_loras"

    def load_loras(self, model, lora_syntax, clip=None):
        # Priority: input lora_syntax > in-memory bridge > bridge file (backward compat)
        text = lora_syntax.strip()
        if not text:
            with BRIDGE_LOCK:
                if BRIDGE_DATA:
                    text = BRIDGE_DATA.get("loras", "")
            if not text:
                try:
                    if os.path.exists(BRIDGE_PATH):
                        with open(BRIDGE_PATH, "r", encoding="utf-8") as f:
                            text = json.load(f).get("loras", "")
                except Exception:
                    pass

        entries = _parse_lora_syntax(text)

        # Build trigger word lookup from bridge data
        with BRIDGE_LOCK:
            tw_lookup = {
                l.get("name", ""): l.get("trigger_words", [])
                for l in BRIDGE_DATA.get("lora_list", [])
            } if BRIDGE_DATA else {}

        trigger_words = []
        for entry in entries:
            lora_path = _find_lora_path(entry["name"])
            if lora_path is None:
                print(f"[Anima] LoRA not found: {entry['name']}")
                continue

            try:
                lora_data = comfy.utils.load_torch_file(lora_path, safe_load=True)
                model, clip = comfy.sd.load_lora_for_models(
                    model, clip, lora_data,
                    entry["model_strength"],
                    entry["clip_strength"],
                )
                # Use real trigger words from bridge data when available
                tws = tw_lookup.get(entry["name"], [])
                if tws:
                    trigger_words.extend(tws)
                else:
                    trigger_words.append(entry["name"])
            except Exception as e:
                print(f"[Anima] Failed to load {entry['name']}: {e}")

        # Deduplicate trigger words preserving order
        seen = set()
        unique_tw = []
        for w in trigger_words:
            wl = w.strip().lower()
            if wl and wl not in seen:
                seen.add(wl)
                unique_tw.append(w.strip())
        trigger_text = ", ".join(unique_tw)
        return (model, clip if clip is not None else model, trigger_text)


NODE_CLASS_MAPPINGS = {
    AnimaBatchLoRALoader.NAME: AnimaBatchLoRALoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Anima Batch LoRA Loader": "Anima Batch LoRA Loader",
}


# ── Bridge status endpoint ──

@PromptServer.instance.routes.get("/anima/bridge/status")
async def verify_bridge(request):
    """Verify LoRA tags against available files.

    Three modes:
      1. ``?text=<lora_tags>`` — parse and verify the inline tags directly
      2. In-memory ``BRIDGE_DATA`` (from HTTP API)
      3. ``anima_bridge.json`` file (backward compat)
    """
    result = {"bridge_found": False, "source": None, "loras": []}
    try:
        all_loras = folder_paths.get_filename_list("loras")
        result["total_loras_available"] = len(all_loras)

        text = ""
        lora_list = []
        source = None

        # Mode 1: inline ?text= parameter
        text_param = request.query.get("text", "").strip()
        if text_param:
            text = text_param
            source = "inline"
            result["bridge_found"] = bool(_parse_lora_syntax(text))
            result["source"] = source

            entries = _parse_lora_syntax(text)
            for entry in entries:
                lora_path = _find_lora_path(entry["name"])
                status = "found" if lora_path else "not_found"
                result["loras"].append({
                    "name": entry["name"],
                    "model_strength": entry["model_strength"],
                    "clip_strength": entry["clip_strength"],
                    "status": status,
                    "path": str(lora_path) if lora_path else None,
                    "trigger_words": [],
                })
            return web.json_response(result)

        # Mode 2: in-memory bridge data
        with BRIDGE_LOCK:
            if BRIDGE_DATA:
                text = BRIDGE_DATA.get("loras", "")
                lora_list = BRIDGE_DATA.get("lora_list", [])
                source = "memory"
                result["updated_at"] = BRIDGE_DATA.get("_receivedAt", 0)

        # Mode 3: bridge file (backward compat)
        if not text and os.path.exists(BRIDGE_PATH):
            try:
                with open(BRIDGE_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                text = data.get("loras", "")
                lora_list = data.get("lora_list", [])
                source = "file"
                result["updated_at"] = data.get("updatedAt", 0)
            except Exception:
                pass

        if not text and not lora_list:
            result["bridge_found"] = False
            result["source"] = source
            return web.json_response(result)

        result["bridge_found"] = True
        result["source"] = source

        tw_map = {}
        for l in lora_list:
            tw_map[l.get("name", "")] = l.get("trigger_words", [])

        entries = _parse_lora_syntax(text)
        for entry in entries:
            lora_path = _find_lora_path(entry["name"])
            status = "found" if lora_path else "not_found"
            result["loras"].append({
                "name": entry["name"],
                "model_strength": entry["model_strength"],
                "clip_strength": entry["clip_strength"],
                "status": status,
                "path": str(lora_path) if lora_path else None,
                "trigger_words": tw_map.get(entry["name"], []),
            })
    except Exception as e:
        result["error"] = str(e)
    return web.json_response(result)


# ── LoRA list endpoint ──

@PromptServer.instance.routes.get("/anima/loras")
async def list_loras(request):
    """List all available LoRA files for the widget browser."""
    all_loras = folder_paths.get_filename_list("loras")
    loras = []
    for f in all_loras:
        name_no_ext = os.path.splitext(f)[0]
        # 补 size/lastModified：widget 前端「按大小/按日期」排序依赖这两个字段
        size, mtime = 0, 0.0
        full = folder_paths.get_full_path("loras", f)
        if full and os.path.isfile(full):
            try:
                st = os.stat(full)
                size, mtime = st.st_size, st.st_mtime
            except OSError:
                pass
        loras.append({
            "filename": f,
            "name": name_no_ext,
            "ext": os.path.splitext(f)[1],
            "size": size,
            "lastModified": mtime,
        })
    return web.json_response({"loras": loras, "total": len(loras)})


# ComfyUI 支持的模型文件夹类型（面板「模型管理」用它列出 checkpoint/VAE/embedding 等）
_MODEL_FOLDER_TYPES = [
    ("checkpoints", "Checkpoint"),
    ("vae", "VAE"),
    ("embeddings", "Embedding"),
    ("clip", "Text Encoder"),
    ("clip_vision", "CLIP Vision"),
    ("controlnet", "ControlNet"),
    ("upscale_models", "Upscale"),
    ("hypernetworks", "Hypernetwork"),
    ("style_models", "Style Model"),
    ("loras", "LoRA"),
]


@PromptServer.instance.routes.get("/anima/models")
async def list_models(request):
    """List all model files grouped by folder type (checkpoint/VAE/embedding/...).

    面板「模型管理」用：一次请求拿全部分类，避免前端逐个类型请求。
    每项含 filename/name/size/lastModified，便于排序与展示。
    """
    groups = []
    total = 0
    for folder_type, label in _MODEL_FOLDER_TYPES:
        try:
            files = folder_paths.get_filename_list(folder_type)
        except Exception:
            files = []
        items = []
        for f in files:
            size, mtime = 0, 0.0
            full = folder_paths.get_full_path(folder_type, f)
            if full and os.path.isfile(full):
                try:
                    st = os.stat(full)
                    size, mtime = st.st_size, st.st_mtime
                except OSError:
                    pass
            items.append({
                "filename": f,
                "name": os.path.splitext(f)[0],
                "ext": os.path.splitext(f)[1],
                "size": size,
                "lastModified": mtime,
            })
        groups.append({"type": folder_type, "label": label, "items": items, "count": len(items)})
        total += len(items)
    return web.json_response({"groups": groups, "total": total})
