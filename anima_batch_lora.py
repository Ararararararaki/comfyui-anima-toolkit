# Anima Batch LoRA Loader - ComfyUI custom node
# Reads <lora:name:weight> syntax and loads multiple LoRAs in sequence.
# Also supports bridge mode: reads from in-memory bridge data (HTTP API)
# or falls back to anima_bridge.json for backward compatibility.

import re
import json
import os
import hashlib
import threading
import time
import asyncio
import folder_paths
import comfy.sd
import comfy.utils
from aiohttp import web
from server import PromptServer
from . import anima_thumbs
from . import anima_gallery

# ── In-memory bridge data (shared with __init__.py via HTTP API) ──
BRIDGE_DATA: dict = {}
BRIDGE_LOCK = threading.Lock()

BRIDGE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "anima_bridge.json")
_LORA_MODEL_EXTENSIONS = (".safetensors", ".pt", ".pth", ".ckpt", ".bin")


def _normalize_lora_name(value: str) -> str:
    """Normalize a relative LoRA reference without losing its subdirectory."""
    normalized = str(value or "").strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.casefold()


def _lora_stem(value: str) -> str:
    """Remove only a supported model extension from a normalized LoRA name."""
    normalized = _normalize_lora_name(value)
    for extension in _LORA_MODEL_EXTENSIONS:
        if normalized.endswith(extension):
            return normalized[:-len(extension)]
    return normalized


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

    lora_key = _normalize_lora_name(lora_name)
    lora_stem = _lora_stem(lora_key)
    indexed = [(str(filename), _normalize_lora_name(filename)) for filename in all_loras]

    # 0: Full relative path match. Use the original indexed filename when resolving
    # so case and slash differences in the tag cannot break folder_paths lookup.
    for filename, normalized in indexed:
        if normalized == lora_key:
            return folder_paths.get_full_path("loras", filename)

    # 1: Exact base match (basename without extension, keeping subdirectory prefix)
    matches = [filename for filename, normalized in indexed if _lora_stem(normalized) == lora_stem]
    if matches:
        return _best_match(matches)

    # 2: Alphanumeric-only comparison
    clean = re.sub(r"[^a-z0-9/]", "", lora_stem)
    matches = [filename for filename, normalized in indexed if re.sub(r"[^a-z0-9/]", "", _lora_stem(normalized)) == clean]
    if matches:
        return _best_match(matches)

    # 3: Token match — every meaningful token must appear (safe substring)
    tokens = [t for t in re.split(r"[\s_\-./]+", lora_stem) if len(t) > 2]
    if tokens:
        matches = [filename for filename, normalized in indexed if all(t in _lora_stem(normalized) for t in tokens)]
        # Prefer shorter match (fewer extra chars = closer match)
        # 注意：这里原先写的是 len(base(f))，而 base() 从未定义 → 任何走到模糊匹配
        # 分支的名字都会抛 NameError（表现为 /anima/lora/info 500、LoRA 加载报错）。
        if matches:
            matches.sort(key=lambda f: len(os.path.basename(_lora_stem(f))))
            return _best_match(matches)

    return None


def _normalize_lora_list_path(value: str) -> str:
    """Return a portable path relative to the configured loras directory."""
    parts = str(value or "").strip().replace("\\", "/").split("/")
    if ".." in parts:
        return ""
    return "/".join(part for part in parts if part and part != ".")


def _list_lora_entries() -> list[dict]:
    """Build the browser list from ComfyUI's recursive lora index.

    ``folder_paths.get_filename_list`` already walks every registered lora
    root and its subdirectories.  Normalize only the API representation so
    the same workflow works on Windows and POSIX hosts while resolution still
    goes through the original ComfyUI path lookup.
    """
    entries = []
    for raw_filename in folder_paths.get_filename_list("loras"):
        filename = _normalize_lora_list_path(raw_filename)
        if not filename:
            continue
        name_no_ext = os.path.splitext(filename)[0]
        full = folder_paths.get_full_path("loras", raw_filename)
        size, mtime = 0, 0.0
        if full and os.path.isfile(full):
            try:
                stat = os.stat(full)
                size, mtime = stat.st_size, stat.st_mtime
            except OSError:
                pass
        entries.append({
            "filename": filename,
            "relativePath": filename,
            "name": name_no_ext,
            "ext": os.path.splitext(filename)[1],
            "size": size,
            "lastModified": mtime,
        })
    return entries


# ── 触发词持久表 ──
# 节点侧 widget 把「LoRA → 触发词」推送到这里落盘（data/lora_trigger_words.json），
# 执行时即可离线解析：不依赖面板是否推送过 bridge、也不依赖 C 站在线。
TRIGGER_WORDS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "lora_trigger_words.json")
_TRIGGER_WORDS_LOCK = threading.Lock()
_TRIGGER_WORDS_CACHE: dict = {"mtime": -1.0, "map": {}}


def _load_trigger_words() -> dict:
    """读取触发词持久表（按 mtime 缓存，避免每次执行都读盘）。"""
    try:
        mtime = os.path.getmtime(TRIGGER_WORDS_PATH)
    except OSError:
        return {}
    with _TRIGGER_WORDS_LOCK:
        if _TRIGGER_WORDS_CACHE["mtime"] == mtime:
            return dict(_TRIGGER_WORDS_CACHE["map"])
    store = {}
    try:
        with open(TRIGGER_WORDS_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        raw = data.get("loras") if isinstance(data, dict) else None
        if isinstance(raw, dict):
            for name, words in raw.items():
                if not isinstance(words, list):
                    continue
                clean = [str(w).strip() for w in words if str(w).strip()]
                if clean and str(name).strip():
                    store[str(name)] = clean
    except Exception as exc:  # noqa: BLE001
        print(f"[AnimaBatchLoRA] 触发词表读取失败: {exc}")
        store = {}
    with _TRIGGER_WORDS_LOCK:
        _TRIGGER_WORDS_CACHE["mtime"] = mtime
        _TRIGGER_WORDS_CACHE["map"] = store
    return dict(store)


def _merge_trigger_words(incoming: dict) -> int:
    """合并写入触发词表（临时文件 + os.replace 原子替换），返回表内总条目数。"""
    current = _load_trigger_words()
    changed = False
    for name, words in (incoming or {}).items():
        key = str(name or "").strip()
        if not key or not isinstance(words, (list, tuple)):
            continue
        clean = [str(w).strip() for w in words if str(w).strip()]
        if not clean:
            continue
        if current.get(key) != clean:
            current[key] = clean
            changed = True
    if not changed:
        return len(current)
    try:
        os.makedirs(os.path.dirname(TRIGGER_WORDS_PATH), exist_ok=True)
        tmp_path = TRIGGER_WORDS_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump({"loras": current, "updatedAt": int(time.time())}, fh, ensure_ascii=False, indent=0)
        os.replace(tmp_path, TRIGGER_WORDS_PATH)
    except Exception as exc:  # noqa: BLE001
        print(f"[AnimaBatchLoRA] 触发词表写入失败: {exc}")
    return len(current)


def _trigger_word_keys(name: str) -> list:
    """一个 LoRA 名可能被写成多种形态（带扩展名/子目录/纯文件名），统一生成候选键。"""
    normalized = _normalize_lora_name(name)
    if not normalized:
        return []
    stem = _lora_stem(normalized)
    raw_keys = [normalized, stem]
    for base in (os.path.basename(normalized), os.path.basename(stem)):
        raw_keys.append(base)
        for extension in _LORA_MODEL_EXTENSIONS:
            if base.endswith(extension):
                raw_keys.append(base[:-len(extension)])
    keys = []
    for key in raw_keys:
        if key and key not in keys:
            keys.append(key)
    return keys


def _build_trigger_index() -> dict:
    """合并三个来源的触发词（优先级由低到高）：bridge 文件 → 内存 bridge → 节点推送的持久表。"""
    pairs = []
    try:
        if os.path.exists(BRIDGE_PATH):
            with open(BRIDGE_PATH, "r", encoding="utf-8") as fh:
                file_data = json.load(fh)
            for item in (file_data.get("lora_list") or []):
                pairs.append((item.get("name", ""), item.get("trigger_words") or []))
    except Exception:  # noqa: BLE001
        pass
    with BRIDGE_LOCK:
        if BRIDGE_DATA:
            for item in (BRIDGE_DATA.get("lora_list") or []):
                pairs.append((item.get("name", ""), item.get("trigger_words") or []))
    for name, words in _load_trigger_words().items():
        pairs.append((name, words))
    index = {}
    for name, words in pairs:
        clean = [str(w).strip() for w in (words or []) if str(w).strip()]
        if not clean:
            continue
        for key in _trigger_word_keys(name):
            index[key] = clean  # 后写入的覆盖先写入的 = 高优先级生效
    return index


def _lookup_trigger_words(index: dict, name: str) -> list:
    for key in _trigger_word_keys(name):
        words = index.get(key)
        if words:
            return words
    return []


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
    NAME = "TK Batch LoRA Loader"
    CATEGORY = "TK/loaders"

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
                "output_trigger_words": ("BOOLEAN", {
                    "default": True,
                    "label": "输出触发词",
                    "tooltip": "总开关：关闭后 trigger_words 输出空字符串（不再输出任何触发词，LoRA 加载不受影响）",
                }),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "trigger_words")
    FUNCTION = "load_loras"

    def load_loras(self, model, lora_syntax, clip=None, output_trigger_words=True):
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
        # 激活 = 权重非 0 的条目：禁用项由前端以 <lora:name:0.00> 写入，0 权重项不加载也不取触发词
        activated = [e for e in entries if not (e["model_strength"] == 0 and e["clip_strength"] == 0)]

        # 触发词输出：只覆盖本节点「激活」的 LoRA，且与加载成功与否无关
        # （文件缺失/加载失败但被激活的 LoRA，其触发词同样应带出去）。
        trigger_words = []
        if output_trigger_words:
            tw_index = _build_trigger_index()
            for entry in activated:
                trigger_words.extend(_lookup_trigger_words(tw_index, entry["name"]))

        for entry in activated:
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
    "TK Batch LoRA Loader": "TK 批量 LoRA 加载器",
}


# ── 触发词持久表端点（节点侧 widget 推送，执行时离线可解析）──

@PromptServer.instance.routes.post("/anima/lora_trigger_words")
async def save_lora_trigger_words(request):
    """节点面板把「LoRA → 触发词」推到这里落盘（只增改，不清空）。

    body: {"loras": {"<name>": ["w1", "w2"], ...}}
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    loras = (body or {}).get("loras")
    if not isinstance(loras, dict):
        return web.json_response({"error": "缺少 loras 字段"}, status=400)
    sanitized = {}
    for name, words in loras.items():
        key = str(name or "").strip()
        if not key or not isinstance(words, (list, tuple)):
            continue
        clean = [str(w).strip() for w in words if str(w).strip()]
        if clean:
            sanitized[key] = clean
    if not sanitized:
        return web.json_response({"saved": 0, "total": len(_load_trigger_words())})
    total = await asyncio.to_thread(_merge_trigger_words, sanitized)
    return web.json_response({"saved": len(sanitized), "total": total})


@PromptServer.instance.routes.get("/anima/lora_trigger_words")
async def get_lora_trigger_words(request):
    """读取触发词持久表（排查用：确认执行端能拿到哪些 LoRA 的触发词）。"""
    store = await asyncio.to_thread(_load_trigger_words)
    return web.json_response(
        {"total": len(store), "loras": store, "path": TRIGGER_WORDS_PATH},
        dumps=lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":")),
    )


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
            tw_map[_normalize_lora_name(l.get("name", ""))] = l.get("trigger_words", [])

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
                    "trigger_words": tw_map.get(_normalize_lora_name(entry["name"]), []),
            })
    except Exception as e:
        result["error"] = str(e)
    return web.json_response(result)


# ── LoRA list endpoint ──

@PromptServer.instance.routes.get("/anima/loras")
async def list_loras(request):
    """List all available LoRA files, including every registered subdirectory."""
    loras = _list_lora_entries()
    return web.json_response({"loras": loras, "total": len(loras)})


# ── Panel silent scan endpoints ──
# 面板「LoRA 管理」的自动扫描走后端文件系统：浏览器 File System Access 的目录授权
# 在页面刷新后必然失效（重新 requestPermission 必须用户手势），纯前端永远做不到
# 全静默。ComfyUI 后端与本机文件系统天然同权，这里提供三个只读端点，让面板
# 启动/激活时按「预设路径（设置项）→ 上次使用路径 → 默认 loras 目录」静默扫描。
# 与 /anima/prompt/* 同为单机工具的既定安全策略（本地信任任意绝对路径）。

def _panel_scan_from_comfy_roots() -> list[dict]:
    """List every ComfyUI-registered loras file, resolving absolute paths for hashing."""
    out = []
    for raw_filename in folder_paths.get_filename_list("loras"):
        filename = _normalize_lora_list_path(raw_filename)
        if not filename:
            continue
        full = folder_paths.get_full_path("loras", raw_filename)
        size, mtime = 0, 0.0
        if full and os.path.isfile(full):
            try:
                st = os.stat(full)
                size, mtime = st.st_size, st.st_mtime
            except OSError:
                pass
        out.append({
            "name": filename,
            "size": size,
            "lastModified": int(mtime * 1000),
            "path": full or "",
        })
    return out


def _panel_scan_from_dir(root: str) -> list[dict]:
    """Recursively list LoRA files under an arbitrary absolute directory."""
    out = []
    root_abs = os.path.abspath(root)
    if not os.path.isdir(root_abs):
        return out
    for dirpath, dirnames, filenames in os.walk(root_abs):
        dirnames.sort()
        for fn in sorted(filenames):
            if not fn.lower().endswith(_LORA_MODEL_EXTENSIONS):
                continue
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            out.append({
                "name": os.path.relpath(full, root_abs).replace("\\", "/"),
                "size": st.st_size,
                "lastModified": int(st.st_mtime * 1000),
                "path": full,
            })
    return out


@PromptServer.instance.routes.get("/anima/panel_scan/dirs")
async def panel_scan_dirs(request):
    """Preset scan roots: every ComfyUI-registered loras directory."""
    try:
        roots = [r for r in folder_paths.get_folder_paths("loras") if r and os.path.isdir(r)]
    except Exception:
        roots = []
    return web.json_response({"roots": roots})


@PromptServer.instance.routes.get("/anima/panel_scan/list")
async def panel_scan_list(request):
    """List LoRA files for the panel scanner.

    无 dir 参数 → 扫描全部 ComfyUI 注册 loras 目录（预设路径）；
    带 dir 参数 → 递归扫描该绝对目录（上次使用路径 / 设置项）。
    lastModified 单位为毫秒，与浏览器 File.lastModified 对齐。
    """
    root = str(request.query.get("dir") or "").strip()
    if root:
        if not os.path.isdir(root):
            return web.json_response({"error": f"目录不存在: {root}"}, status=400)
        entries = await asyncio.to_thread(_panel_scan_from_dir, root)
    else:
        entries = await asyncio.to_thread(_panel_scan_from_comfy_roots)
    return web.json_response({"dir": root, "files": entries, "total": len(entries)})


def _hash_file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


@PromptServer.instance.routes.get("/anima/panel_scan/hash")
async def panel_scan_hash(request):
    """Streaming sha256 of a local file (Civitai matching needs it)."""
    path = str(request.query.get("path") or "")
    if not path or not os.path.isfile(path):
        return web.json_response({"error": "文件不存在"}, status=400)
    try:
        sha = await asyncio.to_thread(_hash_file_sha256, path)
    except OSError as exc:
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response({"sha256": sha, "path": path})


# ── On-disk thumbnail service (M1, docs/后端图片管线可行性评估-2026-09-11.md) ──
# 512（列表）/ 768（详情）两档 WebP 落盘缓存；浏览器侧配强缓存头。
# Pillow 缺失/生成失败返回 5xx，前端回退旧 IndexedDB 管线（双轨设计）。
_THUMB_SEMAPHORE = asyncio.Semaphore(2)


@PromptServer.instance.routes.get("/anima/thumb")
async def anima_thumb(request):
    """Outputs 缩略图直出：path 为相对 ComfyUI output 目录的路径。

    缓存键含源文件 mtime/size，文件一变自动换新键；缓存目录 data/thumbs/<w>/。
    """
    rel = str(request.query.get("path") or "").strip()
    try:
        width = int(request.query.get("w") or 512)
    except ValueError:
        width = 512
    if width not in anima_thumbs.SUPPORTED_WIDTHS:
        return web.json_response({"error": f"不支持的尺寸: {width}"}, status=400)
    if not rel:
        return web.json_response({"error": "缺少 path 参数"}, status=400)
    try:
        root = folder_paths.get_output_directory()
    except Exception as exc:
        return web.json_response({"error": f"无法定位 output 目录: {exc}"}, status=500)

    abs_path = await asyncio.to_thread(anima_thumbs.resolve_within_root, root, rel)
    if not abs_path:
        return web.json_response({"error": "文件不存在或不在 output 目录内"}, status=404)

    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    cache_root = anima_thumbs.plugin_cache_root(plugin_dir, width)
    async with _THUMB_SEMAPHORE:
        try:
            out_path, created = await asyncio.to_thread(
                anima_thumbs.ensure_thumbnail, abs_path, width, cache_root
            )
        except Exception as exc:
            return web.json_response({"error": f"缩略图生成失败: {exc}"}, status=500)

    etag = f'"{os.path.basename(out_path)}"'
    headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": etag,
        "X-Anima-Thumb": "1" if created else "0",
    }
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=headers)
    response = web.FileResponse(out_path)
    response.headers.update(headers)
    return response


# ── Gallery 元数据索引（M3，docs/后端图片管线可行性评估-2026-09-11.md）──
# 按钮所需摘要（prompt/model/seed/loras/hasWorkflow）在后台建索引，前端一次拉取；
# 完整 workflowJson/raw 仍按需（/anima/gallery/meta），与「点击触发解析」的原则一致。

_GALLERY_STATE = {"building": False, "progress": 0, "total": 0, "index": None, "loaded": False}
_GALLERY_LOCK = threading.Lock()


def _gallery_index_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "gallery", "index.json")


def _gallery_build_worker(output_root: str) -> None:
    try:
        def progress(done, total):
            with _GALLERY_LOCK:
                _GALLERY_STATE["progress"] = done
                _GALLERY_STATE["total"] = total
        index = anima_gallery.build_index(output_root, _gallery_index_path(), progress)
        with _GALLERY_LOCK:
            _GALLERY_STATE["index"] = index
            _GALLERY_STATE["loaded"] = True
            _GALLERY_STATE["building"] = False
    except Exception as exc:
        print(f"[anima_gallery] 索引构建失败: {exc}")
        with _GALLERY_LOCK:
            _GALLERY_STATE["building"] = False


@PromptServer.instance.routes.get("/anima/gallery/manifest")
async def gallery_manifest(request):
    """全库元数据摘要（按钮/卡片/筛选所需）+ 构建状态。前端一次拉取。"""
    with _GALLERY_LOCK:
        if not _GALLERY_STATE["loaded"] and not _GALLERY_STATE["building"]:
            index = anima_gallery.load_index(_gallery_index_path())
            _GALLERY_STATE["index"] = index
            _GALLERY_STATE["loaded"] = index.get("builtAt", 0) > 0
        index = _GALLERY_STATE["index"]
        payload = {
            "building": _GALLERY_STATE["building"],
            "progress": _GALLERY_STATE["progress"],
            "total": _GALLERY_STATE["total"],
            "builtAt": (index or {}).get("builtAt", 0),
            "total": (index or {}).get("total", 0),
        }
        if _GALLERY_STATE["loaded"] and index:
            payload["entries"] = index.get("entries", {})
    return web.json_response(payload, dumps=lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":")))


@PromptServer.instance.routes.get("/anima/gallery/fresh")
async def gallery_fresh(request):
    """轻量「有没有新图」探测：只遍历输出目录文件名并 stat，不解析任何 PNG、不返回 16.5MB 索引。

    动机（2026-09-13 用户反馈）：面板 outputs 不进页面就不会自动更新 —— 老实现只在窗口获焦/
    切页时扫描，隐藏时直接 return。要让「生成完就自动更新」成立，需要一个**便宜**的轮询信号：
    这里只返回文件总数（与索引里的 total 比对），前端据此决定要不要拉全量 manifest。
    发现新文件且当前没在建索引时，顺手触发一次后台增量建索引（幂等）。
    """
    try:
        root = folder_paths.get_output_directory()
    except Exception as exc:
        return web.json_response({"error": f"取输出目录失败: {exc}"}, status=500)

    def _probe():
        latest, count = 0.0, 0
        for _rel, _full, mtime, _size in anima_gallery.scan_output_files(root):
            count += 1
            if mtime > latest:
                latest = mtime
        return latest, count

    try:
        latest, count = await asyncio.to_thread(_probe)
    except Exception as exc:
        return web.json_response({"error": f"扫描输出目录失败: {exc}"}, status=500)

    # 用 total 而不是 len(entries)：索引对象有 16.5MB，别为了数个数把它整个读进来。
    index = _GALLERY_STATE["index"]
    known = int((index or {}).get("total", 0) or 0)
    with _GALLERY_LOCK:
        changed = count > known
        building = bool(_GALLERY_STATE["building"])
        if changed and not building:
            _GALLERY_STATE["building"] = True
            _GALLERY_STATE["progress"] = 0
            _GALLERY_STATE["total"] = count
            threading.Thread(target=_gallery_build_worker, args=(root,), daemon=True).start()
            building = True
    return web.json_response({
        "latest": round(latest, 3),
        "count": count,
        "known": known,
        "changed": changed,
        "building": building,
    })


@PromptServer.instance.routes.get("/anima/gallery/rebuild")
async def gallery_rebuild(request):
    """启动/重启后台索引构建（幂等）。前端轮询 manifest 观察 building/progress。"""
    try:
        root = folder_paths.get_output_directory()
    except Exception as exc:
        return web.json_response({"error": f"无法定位 output 目录: {exc}"}, status=500)
    with _GALLERY_LOCK:
        if _GALLERY_STATE["building"]:
            return web.json_response({"started": False, "reason": "构建进行中", "progress": _GALLERY_STATE["progress"], "total": _GALLERY_STATE["total"]})
        _GALLERY_STATE["building"] = True
        _GALLERY_STATE["progress"] = 0
        _GALLERY_STATE["total"] = 0
    threading.Thread(target=_gallery_build_worker, args=(root,), daemon=True, name="anima-gallery-index").start()
    return web.json_response({"started": True})


@PromptServer.instance.routes.get("/anima/gallery/meta")
async def gallery_meta(request):
    """单张完整元数据（含 workflowJson/raw）：复制 Prompt/下载工作流/元数据面板按需取。"""
    rel = str(request.query.get("path") or "").strip()
    if not rel:
        return web.json_response({"error": "缺少 path 参数"}, status=400)
    try:
        root = folder_paths.get_output_directory()
    except Exception as exc:
        return web.json_response({"error": f"无法定位 output 目录: {exc}"}, status=500)
    abs_path = await asyncio.to_thread(anima_thumbs.resolve_within_root, root, rel)
    if not abs_path:
        return web.json_response({"error": "文件不存在或不在 output 目录内"}, status=404)
    try:
        meta = await asyncio.to_thread(anima_gallery.parse_full, abs_path, rel)
    except Exception as exc:
        return web.json_response({"error": f"解析失败: {exc}"}, status=500)
    return web.json_response(meta, dumps=lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":")))


@PromptServer.instance.routes.post("/anima/panel_scan/delete")
async def panel_scan_delete(request):
    """Delete a scanned LoRA file. dir 为空时按 ComfyUI loras 根解析 name。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    dir_ = str((body or {}).get("dir") or "").strip()
    name = str((body or {}).get("name") or "").strip()
    if not name:
        return web.json_response({"error": "缺少文件名"}, status=400)
    target = None
    if dir_:
        root_abs = os.path.abspath(dir_)
        cand = os.path.abspath(os.path.join(root_abs, name))
        # commonpath 严格比较防目录逃逸（ ../ 等）
        if os.path.isdir(root_abs) and os.path.commonpath([root_abs, cand]) == root_abs and os.path.isfile(cand):
            target = cand
    else:
        try:
            target = folder_paths.get_full_path("loras", name)
        except Exception:
            target = None
    if not target or not os.path.isfile(target):
        return web.json_response({"error": "文件不存在"}, status=404)
    try:
        await asyncio.to_thread(os.remove, target)
    except OSError as exc:
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response({"deleted": target})


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
