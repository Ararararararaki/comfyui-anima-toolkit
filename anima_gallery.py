# Tk Toolkit - gallery metadata index (M3)
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
# 解析语义版本：**改动提取逻辑时必须 +1** —— 索引里记着上一轮的 parserVersion，
# 不一致时增量更新会放弃复用旧条目、全量重解析一次（否则老图永远停在旧语义上，
# 而它们的 mtime/size 没变，_entry_unchanged 会一直判定"可复用"）。
# 2（2026-09-17）：正向提示词从「只取最长候选」改为「拼接全部候选 + 标签级保序去重」。
PARSER_VERSION = 2
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


def _looks_negative_strong(text: str, hits: int = 3) -> bool:
    """更严的判负（默认命中 ≥3）：**只用于从正向链上筛候选段**。

    为什么不能沿用 ≥2（2026-09-17）：拼接会让文本变长，而正向段里偶发出现
    `watermark` / `cropped` 之类词（用户自己选的 tag）并不罕见 —— 用 ≥2 会把
    整段正向词条误判成负面而丢掉（表现为"提示词又少了一段"）。
    真正的负面提示词段实测命中 5~10 个（`worst quality, low quality, lowres, jpeg artifacts,
    bad composition, bad anatomy …`），阈值 3 足以把它挡掉，又不会误杀正向段。
    """
    lower = (text or "").lower()
    return sum(1 for w in _NEG_WORDS if w in lower) >= hits


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


def _collect_positive_texts(wf) -> list:
    """从每个 KSampler 的 positive 输入沿引用可达的所有节点，收集正向文本候选（**按发现顺序**）。

    ⚠️ 返回的是**列表**而不是"最长的一条"（2026-09-17 修）：
    正向提示词在工作流里常由**多路汇聚**而成 —— 触发词段（PrimitiveStringMultiline）+
    词条段（TKPromptCards）+ 反推/图库段（DanbooruGallery 的 selections、WD14 等），
    经 TK String Router / Formatter 合并后喂给 KSampler。此前 `max(good, key=len)`
    只把最长的一条当 prompt ⇒ **其余段整段丢失**（用户实测反馈"复制的正面提示词不完整"）。
    合成交给 `_join_positive_texts()`。

    正向链上常见「条件拼接」节点：一支连负面 CLIPTextEncode、一支连正向文本节点。
    命中顺序不可控（负面可能先出现）→ 收集全部候选、过滤负面。
    UI（links 表）与 API（[节点id, 槽位] 引用）都支持。
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
            continue
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
    return texts


_SPLIT_TAGS_RE = re.compile(r"[,，\n]+")


def _join_positive_texts(texts) -> str:
    """多路正向候选 → 一条完整提示词（段落级 + 标签级两级去重，**保序**）。

    实测（2026-09-17 真机）：
      · 两路汇聚的图：只取最长 = 141 字符（整段漏掉词条段）→ 拼接后 180 字符；
      · 某三路汇聚的图：去重掉 **124 个重复标签**（多段本就大量重叠），长度几乎不变但内容互补。
    规则：① 过滤判负与过短（<3 字符）候选；② 丢掉"是别的候选子串"的段落；
          ③ 按 [,，\\n] 切标签、**大小写不敏感保序去重**（同一标签只保留首次出现）；
          ④ 用 ", " 连接 —— 与 TK String Router / Formatter 的默认分隔符（"逗号 ,"）一致，
             同时把段内空行/换行归一成逗号：复制出来就是可直接用的单行提示词。
    """
    segs: list = []
    for raw in texts:
        t = (raw or "").strip().strip(",").strip()
        if len(t) < 3 or _looks_negative_strong(t):
            continue
        if t in segs or any(t != o and t in o for o in segs):
            continue
        # 后到的更长段若包含先到的短段 → 踢掉短的（保留信息更全的那条）
        segs = [o for o in segs if not (o != t and o in t)]
        segs.append(t)
    if not segs:
        return ""
    seen: set = set()
    out: list = []
    for piece in _SPLIT_TAGS_RE.split(", ".join(segs)):
        tag = piece.strip()
        if not tag:
            continue
        low = tag.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(tag)
    return ", ".join(out)


def _collect_positive_candidates(wf) -> str:
    """（兼容入口）正向候选 → 合成一条完整提示词；调用方不必关心两级去重的细节。"""
    return _join_positive_texts(_collect_positive_texts(wf))


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
    # ⚠️ 这里**不再对拼接结果做判负**（2026-09-17）：拼接体比任何单段都长，
    #    用"命中≥2 个负面词"去判整条，会把只是偶发含 1~2 个负面词的**正向**提示词整条丢掉。
    #    负面链的段已经在 _join_positive_texts 内部按更严的阈值（≥3）逐段挡掉了；
    #    若所有候选段都被挡掉，拼接结果本就是空串，自然落到下面的兜底分支。
    traced = _collect_positive_candidates(wf)
    if traced:
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


# ── 增量更新（供「生成完后台预热」调用，2026-09-15）──
# 动机：面板要在**打开切到 Outputs 之前**就把新图备好。全量 build_index() 实测 3571 张 ≈ 12.9s，
# 每次新图都全量重扫会把机器吃满；这里只解析「新增 + mtime/size 变化」的文件，其余条目原样复用。

_INCREMENTAL_LOCK = threading.RLock()  # 只序列化本函数的读-改-写；不覆盖 build_index（两者并发时靠 _save_index 的原子写兜底）
# 用 RLock 而非 Lock：万一 progress_cb 里又回调了本函数，宁可重入多做一轮，也绝不把
# ComfyUI 的请求/后台线程挂死（锁只保护本函数，重入不会破坏一致性）


def _entry_unchanged(old, mtime: float, size: int) -> bool:
    """索引条目是否与磁盘现状一致（判据与 build_index 逐字一致：mtime 容差 0.001s + size 相等）。"""
    if not isinstance(old, dict):
        return False
    try:
        return abs(float(old.get("mtime") or 0.0) - mtime) < 0.001 and int(old.get("size") or 0) == int(size)
    except (TypeError, ValueError):
        return False


def _resolve_entry(full: str, rel: str, mtime: float, size: int, old) -> dict:
    """解析单张图 → 索引条目；解析失败绝不打断整轮更新（坏图只坏它自己）。"""
    try:
        return build_entry(full, rel)
    except Exception:
        # 回退：沿用旧解析结果（若有）并**打上本次磁盘 mtime/size**。
        # 打新值是为了不让「静态坏图」每轮都被重新解析一遍（否则 updated 恒 >0，预热器会
        # 误判"索引变了"而反复通知前端）；若是写入中的半截文件，其 mtime/size 稍后还会变，
        # 下一轮自然重新解析。
        base = dict(old) if isinstance(old, dict) else {
            "width": 0, "height": 0, "model": "", "seed": "", "steps": "", "cfg": "",
            "sampler": "", "scheduler": "", "prompt": "", "hasPrompt": False,
            "loras": [], "hasWorkflow": False,
        }
        base["path"] = rel.replace("\\", "/")
        base["mtime"] = round(mtime, 3)
        base["size"] = size
        return base


def update_index_incremental(output_root: str, index_path: str, progress_cb=None) -> dict:
    """增量更新已有索引：只解析「新增」与「mtime/size 变化」的文件，移除已消失的条目。

    与 build_index() 的差别（为什么需要它）：
      · 复用判定相同（rel 路径为键，mtime 容差 0.001s + size 相等即原样复用旧解析结果）；
      · 但**多了一道安全护栏**：scan 到 0 个文件而索引非空时视为异常（挂载点掉了/权限问题），
        不清空索引、**不写盘**，返回 skipped 结果；
      · 无任何变化时不重写索引文件（索引 3000+ 张约 16.5MB，白写一次还会让前端 builtAt
        换代 → 整份 manifest 重拉）。

    返回统计字典（键名固定，预热器依赖）：
      {"added": int, "updated": int, "removed": int, "total": int, "scanned": int,
       "builtAt": int, "durationMs": int, "reused": int}
      · builtAt   = **毫秒整数**（`int(time.time() * 1000)`），与索引对象 / `/anima/gallery/manifest`
                    / `/anima/gallery/fresh` 里的 builtAt **同一单位**，调用方可以直接拿它跟
                    已知的 builtAt 比对判断"索引换代了没有"。
                    ⚠️ 语义 = **当前索引对象的 builtAt**，不是"本轮结束时刻"：只有当本轮真的
                    写盘换代时它才是新值；无变化（不写盘）或护栏跳过时它保持旧值不变 —— 否则
                    前端 `builtAt !== knownBuiltAt` 会把每轮轮询都当成换代，反复重拉 16.5MB manifest。
      · durationMs = 本轮耗时（毫秒，时间差，不受上面单位约定影响）。
      · scanned   = 本次扫到的磁盘文件数；reused = 直接复用旧解析结果的条目数。
      · added/updated/removed = 新增 / 重新解析 / 移除的条目数（added+updated+reused == scanned）。

    异常护栏返回（此时**未写盘**，索引原样保留）：
      {"skipped": True, "reason": str, ...} —— 除 skipped/reason 外仍带上上面全部统计键，
      取其保守值：added=updated=removed=reused=0、scanned=0、total=现有索引条目数、
      builtAt=现有索引的 builtAt（未换代）。
      调用方判 `res.get("skipped")` 即可；直接读 res["added"] 也不会 KeyError。

    首建场景：索引文件不存在/为空/损坏时，退化为一次全量 build_index()（reused=0，
    added=scanned=total=全量条目数）。此时不会走 0 文件护栏（没有既有索引可保护）。

    progress_cb(done, total)：可选，按**扫描**进度回调（与 build_index 同约定，
    total 为磁盘文件数）；回调抛异常一律吞掉，绝不影响索引更新。

    向后兼容：build_index() / load_index() / parse_full() 的签名与返回结构未改动；
    本函数写出的索引对象保留原有顶层键（version/parserVersion/builtAt/total/entries），
    与 load_index 期望的格式一致。
    """
    started = time.time()

    with _INCREMENTAL_LOCK:
        existing = load_index(index_path)
        old_entries = existing.get("entries") if isinstance(existing.get("entries"), dict) else {}
        # 索引对象的 builtAt（毫秒）；本轮没换代时原样透传给调用方（见 docstring）
        try:
            existing_built_at = int(existing.get("builtAt", 0) or 0)
        except (TypeError, ValueError):
            existing_built_at = 0

        # ① 首建（索引文件不存在 / 条目为空 / 文件损坏读不出来）→ 一次全量。
        #    注意：build_index 内部自己会 load_index，这里只借用它的全量语义。
        if not os.path.isfile(index_path) or not old_entries:
            index = build_index(output_root, index_path, progress_cb)
            total = int(index.get("total", 0) or 0)
            return {"added": total, "updated": 0, "removed": 0, "total": total, "scanned": total,
                    "builtAt": int(index.get("builtAt", 0) or 0),
                    "durationMs": int((time.time() - started) * 1000), "reused": 0}

        # ② 扫盘（异常不升级为"清空索引"）
        try:
            files = scan_output_files(output_root)
        except Exception as exc:
            return _incremental_skip(f"扫描输出目录失败: {exc}", existing_built_at,
                                     len(old_entries), started)

        # ③ 安全护栏：一个文件都没扫到、而索引里还有条目 —— 多半是 output 目录暂时不可读
        #    （挂载点掉了 / 权限被拒 / 路径传错）。宁可这一轮什么都不做，也不拿空结果覆盖。
        if not files:
            return _incremental_skip(
                "扫描到 0 个文件而现有索引非空（疑似输出目录不可读/挂载点丢失），已保留索引且未写盘",
                existing_built_at, len(old_entries), started)

        # ④ 逐文件复用或重解析（顺序沿用 scan_output_files 的 mtime 倒序，新图在前）
        #    解析器换代（索引里的 parserVersion ≠ 代码里的 PARSER_VERSION）→ 本轮**不复用**
        #    任何旧条目，全部重解析一次：改的是提取语义，而 mtime/size 没变，
        #    只按 _entry_unchanged 判定会让老图永远停在旧结果上。
        try:
            parser_stale = int(existing.get("parserVersion") or 0) != PARSER_VERSION
        except (TypeError, ValueError):
            parser_stale = True
        if parser_stale:
            print(f"[gallery] 解析器版本换代（{existing.get('parserVersion')} → {PARSER_VERSION}）：本轮全量重解析")
        entries: dict = {}
        added = updated = reused = 0
        total_files = len(files)
        for i, (rel, full, mtime, size) in enumerate(files):
            old = old_entries.get(rel)
            if not parser_stale and _entry_unchanged(old, mtime, size):
                entries[rel] = old
                reused += 1
            else:
                entries[rel] = _resolve_entry(full, rel, mtime, size, old)
                if isinstance(old, dict):
                    updated += 1
                else:
                    added += 1
            if progress_cb:
                try:
                    progress_cb(i + 1, total_files)
                except Exception:
                    pass

        # ⑤ 移除已消失文件的条目（磁盘上没有 = 用户删了/被清理了）
        removed = 0
        for rel in old_entries:
            if rel not in entries:
                removed += 1

        changed = bool(added or updated or removed)
        new_built_at = existing_built_at
        if changed:
            new_built_at = int(time.time() * 1000)
            new_index = {"version": INDEX_VERSION, "parserVersion": PARSER_VERSION,
                         "builtAt": new_built_at, "total": len(entries), "entries": entries}
            _save_index(index_path, new_index)

        return {"added": added, "updated": updated, "removed": removed,
                "total": len(entries), "scanned": total_files,
                "builtAt": new_built_at, "durationMs": int((time.time() - started) * 1000),
                "reused": reused}


def _incremental_skip(reason: str, built_at: int, existing_total: int, started: float) -> dict:
    """护栏命中时的保守返回：带全部统计键（取保守值）+ skipped/reason，且**不写盘**。

    builtAt 原样回传现有索引的值（本轮没换代），调用方的「是否换代」判断因此保持正确。
    """
    return {"skipped": True, "reason": reason,
            "added": 0, "updated": 0, "removed": 0, "reused": 0, "scanned": 0,
            "total": int(existing_total or 0), "builtAt": int(built_at or 0),
            "durationMs": int((time.time() - started) * 1000)}


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
    """写索引：**原子写** —— 先写同目录临时文件 `index.json.tmp`，再 `os.replace()` 覆盖。

    保证任何时刻磁盘上的 index.json 要么是旧的完整版、要么是新的完整版，绝无半截 JSON
    （索引 3000+ 张时约 16.5MB，直接覆写期间被读取方读到会整份解析失败）。
    """
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
