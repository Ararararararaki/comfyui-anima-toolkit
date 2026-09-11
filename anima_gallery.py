# Anima Toolkit - gallery metadata index (M3)
# Pure-function module (no ComfyUI/server imports): PNG text-chunk parsing,
# ComfyUI UI/API workflow field extraction, LoRA extraction, incremental index.
# 与前端 src/services/outputMetadata.ts 的语义对齐（摘要级：按钮/卡片/筛选所需字段）。
# 完整 workflowJson / raw 不进索引 —— 由 /anima/gallery/meta 按需解析返回。

import io
import json
import os
import re
import struct
import threading
import time
import zlib

from PIL import Image

INDEX_VERSION = 1
PARSER_VERSION = 1
_HEAD_BYTES = 4 * 1024 * 1024  # tEXt 在 IDAT 之前，读头部即可覆盖绝大多数图

# 与前端 isNegativeText 相同的保守负面词表（命中≥2 判负，仅用于 hasPrompt 启发式）
_NEG_WORDS = ["worst quality", "low quality", "score_1", "score_2", "score_3", "bad anatomy",
              "bad proportions", "extra limbs", "extra fingers", "missing fingers", "ugly",
              "blurry", "jpeg artifacts", "lowres", "cropped", "watermark"]
_LORA_TAG_RE = re.compile(r"<lora:([^:>]+):[^:>]*(?::[^:>]*)?>", re.I)
_LORA_EXT_RE = re.compile(r"\.(safetensors|pt|bin)$", re.I)


def _looks_negative(text: str) -> bool:
    lower = (text or "").lower()
    return sum(1 for w in _NEG_WORDS if w in lower) >= 2


# ── PNG chunk 解析（只读文件头部；tEXt 精确 / zTXt zlib / iTXt 近似，与前端行为对齐）──
def read_text_chunks(abs_path: str, head_bytes: int = _HEAD_BYTES) -> dict:
    raw: dict = {}
    try:
        with open(abs_path, "rb") as fh:
            head = fh.read(head_bytes)
    except OSError:
        return raw
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return raw
    offset = 8
    view = memoryview(head)
    total = len(head)
    while offset + 8 <= total:
        length = struct.unpack(">I", view[offset:offset + 4])[0]
        ctype = bytes(view[offset + 4:offset + 8])
        data_start = offset + 8
        data_end = data_start + length
        if ctype in (b"IDAT", b"IEND") or data_end > total:
            break  # 文本 chunk 都在 IDAT 前；缓冲区截断则停
        if ctype in (b"tEXt", b"zTXt", b"iTXt"):
            seg = view[data_start:data_end]
            key_end = data_start
            while key_end < data_end and head[key_end] != 0 and key_end - data_start < 79:
                key_end += 1
            key = head[data_start:key_end].decode("latin-1", "replace")
            try:
                if ctype == b"zTXt":
                    val = zlib.decompress(bytes(view[key_end + 2:data_end])).decode("utf-8", "replace")
                else:
                    val = head[key_end + 1:data_end].decode("utf-8", "replace")
            except Exception:
                val = ""
            raw[key] = val
        offset = data_end + 4
    return raw


def png_dimensions(abs_path: str) -> tuple:
    try:
        with open(abs_path, "rb") as fh:
            head = fh.read(24)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", head[16:24])
        with Image.open(abs_path) as im:
            return im.size
    except Exception:
        return 0, 0


# ── ComfyUI 工作流字段提取（UI format nodes 数组 / API format 键对象，双格式）──
def _iter_nodes(wf):
    if isinstance(wf, dict) and isinstance(wf.get("nodes"), list):
        return wf["nodes"]
    if isinstance(wf, list):
        return wf
    if isinstance(wf, dict):
        return [dict(v, id=k) for k, v in wf.items() if isinstance(v, dict)]
    return []


def _extract_loras(wf) -> list:
    out, seen = [], set()

    def add(name):
        name = _LORA_EXT_RE.sub("", str(name or "")).strip()
        if name and name not in seen:
            seen.add(name)
            out.append(name)

    for node in _iter_nodes(wf):
        if not isinstance(node, dict):
            continue
        is_lora_node = "lora" in str(node.get("class_type") or node.get("type") or "").lower()
        inputs = node.get("inputs")
        if isinstance(inputs, dict):
            ln = inputs.get("lora_name")
            if isinstance(ln, str):
                add(ln)
            for v in inputs.values():
                if isinstance(v, str):
                    for m in _LORA_TAG_RE.finditer(v):
                        add(m.group(1))
        wv = node.get("widgets_values")
        if is_lora_node and isinstance(wv, list):
            for w in wv:
                if isinstance(w, str) and _LORA_EXT_RE.search(w):
                    add(w)
        if isinstance(wv, list):
            for w in wv:
                if isinstance(w, str):
                    for m in _LORA_TAG_RE.finditer(w):
                        add(m.group(1))
    return out


def _extract_text_nodes(wf) -> list:
    """CLIPTextEncode 类节点的文本（正向/负面判定用）。"""
    texts = []
    for node in _iter_nodes(wf):
        if not isinstance(node, dict):
            continue
        ctype = str(node.get("class_type") or node.get("type") or "")
        if "CLIPTextEncode" not in ctype:
            continue
        text = None
        inputs = node.get("inputs")
        if isinstance(inputs, dict) and isinstance(inputs.get("text"), str):
            text = inputs["text"]
        wv = node.get("widgets_values")
        if text is None and isinstance(wv, list) and wv and isinstance(wv[0], str):
            text = wv[0]
        if text:
            texts.append(text)
    return texts


def _ksampler_fields(wf) -> dict:
    """KSampler 类节点的 seed/steps/cfg/sampler/scheduler（取第一个命中）。"""
    fields = {}
    for node in _iter_nodes(wf):
        if not isinstance(node, dict):
            continue
        ctype = str(node.get("class_type") or node.get("type") or "").lower()
        if "sampler" not in ctype:
            continue
        inputs = node.get("inputs")
        if isinstance(inputs, dict):
            for key in ("seed", "steps", "cfg", "sampler_name", "scheduler"):
                if key in inputs and fields.get(key) in (None, ""):
                    fields[key] = inputs[key]
        else:
            wv = node.get("widgets_values")
            if isinstance(wv, list) and len(wv) >= 4:
                fields.setdefault("seed", wv[0])
                fields.setdefault("steps", wv[1])
                fields.setdefault("cfg", wv[2])
                fields.setdefault("sampler_name", wv[3])
        if fields.get("seed") not in (None, ""):
            break
    return fields


def _checkpoint_name(wf) -> str:
    for node in _iter_nodes(wf):
        if not isinstance(node, dict):
            continue
        ctype = str(node.get("class_type") or node.get("type") or "").lower()
        if "checkpointloader" in ctype or "unetloader" in ctype:
            inputs = node.get("inputs")
            if isinstance(inputs, dict) and isinstance(inputs.get("ckpt_name"), str):
                return inputs["ckpt_name"]
            wv = node.get("widgets_values")
            if isinstance(wv, list):
                for w in wv:
                    if isinstance(w, str) and _LORA_EXT_RE.search(w) or (isinstance(w, str) and w.endswith(".safetensors")):
                        return w
    return ""


def _collect_positive_candidates(wf) -> str:
    """从每个 KSampler 的 positive 输入沿引用可达的所有节点，收集直接文本候选。

    正向链上常见「条件拼接」节点：一支连负面 CLIPTextEncode、一支连正向文本节点。
    命中顺序不可控（负面可能先出现）→ 收集全部候选、过滤负面、取最长（正向全文本
    通常完整写在某个文本节点里）。UI（links 表）与 API（[节点id, 槽位] 引用）都支持。
    """
    node_map = {}
    for n in _iter_nodes(wf):
        if isinstance(n, dict) and n.get("id") is not None:
            node_map[n.get("id")] = n
            try:
                node_map[int(n.get("id"))] = n
            except (TypeError, ValueError):
                pass
    link_map = {}
    links = wf.get("links") if isinstance(wf, dict) else None
    if isinstance(links, list):
        for lnk in links:
            if isinstance(lnk, list) and len(lnk) >= 4:
                link_map[lnk[0]] = (lnk[1], lnk[2])

    def resolve_source(ref):
        if isinstance(ref, list) and ref:
            return node_map.get(ref[0]) or node_map.get(str(ref[0]))
        src = link_map.get(ref)
        if src is not None:
            return node_map.get(src[0])
        return None

    def positive_starts():
        for node in _iter_nodes(wf):
            if not isinstance(node, dict):
                continue
            ctype = str(node.get("class_type") or node.get("type") or "").lower()
            if "sampler" not in ctype:
                continue
            inputs = node.get("inputs")
            if isinstance(inputs, list):
                for slot in inputs:
                    if isinstance(slot, dict) and slot.get("name") == "positive" and slot.get("link") is not None:
                        yield slot.get("link")
            elif isinstance(inputs, dict):
                for key, v in inputs.items():
                    if key in ("positive", "positive_cond"):
                        # API 格式：v = [节点id, 槽位] 引用（必须整体传递，不能只取 id，
                        # 否则 resolve_source 会把节点 id 误当 UI link id 查表导致链路断裂）
                        if isinstance(v, list) and v:
                            yield v
                        elif isinstance(v, (int, str)):
                            yield v

    def input_refs(inputs):
        """收集输入里的「上游节点引用」。API: [节点id, 槽位] 二元组；UI: link id 整数。
        ⚠️ 普通字符串/布尔/配置对象是 widget 值，不是引用（2026-09-11 修：此前把所有
        字符串值都当引用，导致 stack 塞满垃圾、正向文本链路断在拼接节点的 widget 上）。"""
        refs = []
        if isinstance(inputs, list):
            for slot in inputs:
                if isinstance(slot, dict) and slot.get("link") is not None:
                    refs.append(slot.get("link"))
        elif isinstance(inputs, dict):
            for v in inputs.values():
                # ⚠️ API 格式的引用是 [节点id, 槽位] 整个列表 —— 必须整体传递。
                # （2026-09-11 修：此前只 append v[0]，节点 id 字符串在 resolve_source 里
                # 被误当 UI link id 查表 → 查不到 → API 格式工作流的正向链路全部断裂）
                if isinstance(v, list) and len(v) == 2 and isinstance(v[0], (int, str)) and isinstance(v[1], int):
                    refs.append(v)
                elif isinstance(v, int) and not isinstance(v, bool):
                    refs.append(v)
        return refs

    texts: list = []
    seen: set = set()
    stack = list(positive_starts())
    while stack:
        ref = stack.pop(0)
        key = json.dumps(ref) if isinstance(ref, list) else str(ref)
        if key in seen:
            continue
        seen.add(key)
        node = resolve_source(ref)
        if not isinstance(node, dict):
            print('  [collect][断]', key)
            continue
        print('  [collect]', key, '->', str(node.get("class_type") or node.get("type"))[:36])
        node_id = node.get("id")
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else None
        wv = node.get("widgets_values")
        # ① CLIPTextEncode 等节点的直接 text 字段
        if isinstance(inputs, dict) and isinstance(inputs.get("text"), str) and inputs["text"].strip():
            texts.append(inputs["text"])
        # ② 文本拼接/展示类节点：字符串输入与 widgets_values 拼接
        ctype = str(node.get("class_type") or node.get("type") or "").lower()
        is_text_node = any(w in ctype for w in ("concat", "join", "text", "show", "string", "prompt"))
        if is_text_node and isinstance(inputs, dict):
            for k, v in inputs.items():
                if isinstance(v, str) and v.strip() and k != "text" and not v.lstrip().startswith("{"):
                    texts.append(v)
        if isinstance(wv, list) and is_text_node:
            joined = "".join(w for w in wv if isinstance(w, str) and w.strip())
            if joined.strip():
                texts.append(joined)
        # ③ tag 库/配置类节点：正向文本可能藏在嵌套字段里（如 DanbooruGallery.selection_data
        #    的 selections[].prompt —— tag 库节点运行时组装正向，静态值就在配置 JSON 中）
        if isinstance(inputs, dict):
            for v in inputs.values():
                for found in _mine_prompt_field(v, 0):
                    if found.strip():
                        texts.append(found)
        # ④ 沿上游引用继续回溯（引用只有 [节点id, 槽位] 二元组与 int 两种形态）
        for ref2 in input_refs(inputs):
            stack.append(ref2)
    good = [t for t in texts if not _looks_negative(t)]
    return max(good, key=len) if good else ""


def _mine_prompt_field(value, depth: int):
    """在任意值里挖 prompt 文本：dict/list 递归找 'prompt' 键；JSON 字符串先解析。深度限 4。"""
    if depth > 4:
        return
    if isinstance(value, str):
        s = value.strip()
        if s.startswith("{") or s.startswith("["):
            try:
                parsed = json.loads(s)
            except Exception:
                return
            yield from _mine_prompt_field(parsed, depth + 1)
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if isinstance(k, str) and "prompt" in k.lower() and isinstance(v, str) and v.strip():
                yield v
            elif isinstance(v, (dict, list)):
                yield from _mine_prompt_field(v, depth + 1)
    elif isinstance(value, list):
        for v in value:
            yield from _mine_prompt_field(v, depth + 1)


def parse_comfy_summary(wf) -> dict:
    """从 ComfyUI 工作流（UI/API 双格式）提取摘要字段。"""
    out = {"model": "", "seed": "", "steps": "", "cfg": "", "sampler": "", "scheduler": "",
           "prompt": "", "hasPrompt": False, "loras": [], "hasWorkflow": True}
    out["loras"] = _extract_loras(wf)
    fields = _ksampler_fields(wf)
    out["model"] = _checkpoint_name(wf)
    for key in ("seed", "steps", "cfg", "sampler", "scheduler"):
        val = fields.get(key)
        out[key] = "" if val is None else str(val)
    texts = [t for t in _extract_text_nodes(wf) if not _looks_negative(t)]
    traced = _collect_positive_candidates(wf)
    if traced and not _looks_negative(traced):
        out["prompt"] = traced
        out["hasPrompt"] = True
    elif texts:
        out["prompt"] = texts[0]
        out["hasPrompt"] = True
    return out


_A1111_LINE_RE = re.compile(r"^([A-Za-z ]+?):\s*(.*)$")


def parse_a1111_summary(parameters: str) -> dict:
    """A1111 文本格式（parameters chunk）的摘要提取。"""
    out = {"model": "", "seed": "", "steps": "", "cfg": "", "sampler": "", "scheduler": "",
           "prompt": "", "hasPrompt": False, "loras": [], "hasWorkflow": False}
    if not parameters:
        return out
    prompt_part, negative_part, params_part = parameters, "", ""
    lines = parameters.replace("\r\n", "\n").split("\n")
    for i, line in enumerate(lines):
        if line.startswith("Negative prompt:"):
            prompt_part = "\n".join(lines[:i])
            rest = "\n".join(lines[i:])
            nl = rest.split("\n", 1)
            negative_part = nl[0][len("Negative prompt:"):].strip()
            params_part = nl[1] if len(nl) > 1 else ""
            break
    else:
        parts = parameters.rsplit("\nSteps:", 1)
        prompt_part = parts[0]
        params_part = ("Steps:" + parts[1]) if len(parts) > 1 else ""
    out["prompt"] = prompt_part.strip()
    out["hasPrompt"] = bool(out["prompt"])
    for m in _A1111_LINE_RE.finditer(params_part.replace("\n", ", ")):
        key, val = m.group(1).strip().lower(), m.group(2).strip()
        if key == "seed":
            out["seed"] = val
        elif key == "steps":
            out["steps"] = val
        elif key == "cfg scale":
            out["cfg"] = val
        elif key == "sampler":
            out["sampler"] = val
        elif key == "model":
            out["model"] = val
    out["loras"] = [m.group(1) for m in _LORA_TAG_RE.finditer(prompt_part)]
    return out


def build_entry(abs_path: str, rel_path: str) -> dict:
    """单张图的摘要条目（按钮/卡片/筛选所需 + 布局宽高）。"""
    stat = os.stat(abs_path)
    raw = read_text_chunks(abs_path)
    prompt_data = raw.get("prompt", "")
    workflow_data = raw.get("workflow", "")
    parameters = raw.get("parameters", "")

    entry = {
        "path": rel_path.replace("\\", "/"),
        "mtime": round(stat.st_mtime, 3),
        "size": stat.st_size,
        "width": 0,
        "height": 0,
        "model": "", "seed": "", "steps": "", "cfg": "", "sampler": "", "scheduler": "",
        "prompt": "", "hasPrompt": False,
        "loras": [], "hasWorkflow": False,
    }

    src = None
    if prompt_data:
        try:
            src = json.loads(prompt_data)
        except Exception:
            src = None
    if src is None and workflow_data:
        try:
            src = json.loads(workflow_data)
        except Exception:
            src = None

    if src is not None:
        summary = parse_comfy_summary(src)
        entry["hasWorkflow"] = bool(workflow_data or prompt_data)
        entry.update({k: summary[k] for k in ("model", "seed", "steps", "cfg", "sampler", "scheduler", "prompt", "loras")})
        entry["hasPrompt"] = bool(entry["prompt"])
        if not summary["hasWorkflow"] and not workflow_data and prompt_data:
            entry["hasWorkflow"] = True
    elif parameters:
        summary = parse_a1111_summary(parameters)
        entry.update({k: summary[k] for k in ("model", "seed", "steps", "cfg", "sampler", "scheduler", "prompt", "loras", "hasWorkflow")})
    else:
        entry["hasWorkflow"] = bool(workflow_data or prompt_data)
        entry["loras"] = _extract_loras({}) or []

    # 兜底：A1111/无工作流但 prompt 里有 <lora:> 标签
    if not entry["loras"]:
        for m in _LORA_TAG_RE.finditer(entry.get("prompt", "")):
            entry["loras"].append(m.group(1))

    w, h = png_dimensions(abs_path)
    entry["width"], entry["height"] = w, h
    return entry


# ── 增量索引构建 ──

def scan_output_files(output_root: str) -> list:
    """遍历 output 目录（跳过隐藏文件/目录），返回 (rel, abs, mtime, size) 列表。"""
    out = []
    for dirpath, dirnames, filenames in os.walk(output_root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith(".") or not name.lower().endswith((".png", ".webp", ".jpg", ".jpeg")):
                continue
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(full, output_root).replace("\\", "/")
            out.append((rel, full, st.st_mtime, st.st_size))
    out.sort(key=lambda x: x[2], reverse=True)  # 新图在前，建库先处理它们
    return out


def build_index(output_root: str, index_path: str, progress_cb=None) -> dict:
    """增量构建索引：mtime+size 未变的条目直接复用，新增/变更才解析。返回索引 dict。"""
    index = load_index(index_path)
    old_entries = index.get("entries", {}) if isinstance(index.get("entries"), dict) else {}
    files = scan_output_files(output_root)
    entries: dict = {}
    for i, (rel, full, mtime, size) in enumerate(files):
        old = old_entries.get(rel)
        if old and abs(old.get("mtime", -1) - mtime) < 0.001 and old.get("size") == size:
            entries[rel] = old
        else:
            try:
                entry = build_entry(full, rel)
                entries[rel] = entry
            except Exception:
                old_fallback = old or {"path": rel, "mtime": round(mtime, 3), "size": size,
                                       "width": 0, "height": 0, "model": "", "seed": "", "steps": "",
                                       "cfg": "", "sampler": "", "scheduler": "", "prompt": "",
                                       "hasPrompt": False, "loras": [], "hasWorkflow": False}
                entries[rel] = old_fallback
        if progress_cb:
            progress_cb(i + 1, len(files))
    new_index = {"version": INDEX_VERSION, "parserVersion": PARSER_VERSION,
                 "builtAt": int(time.time() * 1000), "total": len(entries), "entries": entries}
    _save_index(index_path, new_index)
    return new_index


def load_index(index_path: str) -> dict:
    try:
        with open(index_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("entries"), dict):
            return data
    except Exception:
        pass
    return {"version": INDEX_VERSION, "parserVersion": PARSER_VERSION, "builtAt": 0, "total": 0, "entries": {}}


def _save_index(index_path: str, index: dict) -> None:
    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    tmp = index_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, index_path)


def parse_full(abs_path: str, rel_path: str) -> dict:
    """单张完整元数据（/anima/gallery/meta 按需）：含 workflowJson 与 raw。"""
    raw = read_text_chunks(abs_path)
    prompt_data = raw.get("prompt", "")
    workflow_data = raw.get("workflow", "")
    parameters = raw.get("parameters", "")
    entry = build_entry(abs_path, rel_path)
    return {
        "imageId": rel_path.replace("\\", "/"),
        "model": entry["model"], "seed": entry["seed"], "steps": entry["steps"],
        "cfg": entry["cfg"], "sampler": entry["sampler"], "scheduler": entry.get("scheduler", ""),
        "vae": "", "clipSkip": 0,
        "prompt": entry["prompt"], "negativePrompt": "",
        "workflowJson": workflow_data or prompt_data or "",
        "rawMetadata": raw,
        "loras": entry["loras"], "hasWorkflow": entry["hasWorkflow"], "lorasExtracted": True,
    }
