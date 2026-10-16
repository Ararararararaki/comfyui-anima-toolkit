# Tk Toolkit - gallery metadata index (M3)
# Pure-function module (no ComfyUI/server imports): PNG text-chunk parsing,
# ComfyUI UI/API workflow field extraction, LoRA extraction, incremental index.
# 与前端 src/services/outputMetadata.ts 的语义对齐（摘要级：按钮/卡片/筛选所需字段）。
# 完整 workflowJson / raw 不进索引 —— 由 /anima/gallery/meta 按需解析返回。

import json
import os
import re
import struct
import time

from PIL import Image

try:
    from .services.output_metadata import PARSER_VERSION, parse_output_metadata
    from .services.image_metadata_container import read_image_metadata
    from .services.saved_image_metadata import parse_comfy_fields, parse_saved_metadata
    from .services.prompt_record import decode_record
    from .services.gallery_catalog import catalog_for
except ImportError:  # standalone pure-module tests / development tools
    from services.output_metadata import PARSER_VERSION, parse_output_metadata
    from services.image_metadata_container import read_image_metadata
    from services.saved_image_metadata import parse_comfy_fields, parse_saved_metadata
    from services.prompt_record import decode_record
    from services.gallery_catalog import catalog_for

INDEX_VERSION = 1
# 解析语义版本：**改动提取逻辑时必须 +1** —— 索引里记着上一轮的 parserVersion，
# 不一致时增量更新会放弃复用旧条目、全量重解析一次（否则老图永远停在旧语义上，
# 而它们的 mtime/size 没变，_entry_unchanged 会一直判定"可复用"）。
# 2（2026-09-17）：正向提示词从「只取最长候选」改为「拼接全部候选 + 标签级保序去重」。
# 4：build_entry 优先消费图片内的提示词溯源记录（tk_prompt_provenance），静态图字段
#    退为兜底 —— 提取语义再次变化，升级后增量更新会全量重解析一次。
# Version ownership stays in output_metadata so cache migration cannot drift.
_HEAD_BYTES = 4 * 1024 * 1024  # Legacy argument default; complete container reads use seek.

# 图片内的提示词溯源记录（wire schema v1，由 services/prompt_record.py 的编解码器定义）。
# 记录是 SaveImage 侧写进 PNG 文本块的一行 ASCII JSON；缺失时本模块行为与历史版本一致。
_PROMPT_RECORD_KEY = "tk_prompt_provenance"

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


def read_text_chunks(abs_path: str, head_bytes: int = _HEAD_BYTES) -> dict:
    """Compatibility raw-map API. Container reads now visit metadata to the end.

    ``head_bytes`` remains accepted for existing callers; pixel blocks are sought
    past rather than read into a fixed head buffer or decoded.
    """
    return read_image_metadata(abs_path)['raw']


def _parse_container(container, source_filename=''):
    return parse_saved_metadata(container['raw'], status=container['status'],
                                image_format=container['format'], warnings=container['warnings'], source_filename=source_filename)


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


# ── 提示词溯源记录消费（PNG 文本块 tk_prompt_provenance）──
# 记录是**运行期已核验的观测**：SaveImage 落盘时把「这一张图由哪次采样、哪些已核验文本产生」
# 写进图片本身。它比从工作流静态反推更接近真相，所以有记录时以记录为准，静态图字段退为兜底。
# 记录的编解码语义完全在 services/prompt_record.py 里（本模块不重新实现、不改写它）。

_PROMPT_FIELDS = ("prompt", "negativePrompt", "promptStages", "promptStatus", "promptWarnings")

def _read_prompt_record(raw) -> str:
    """取出图片内记录原文；没有该文本块时返回空串（= 历史行为路径）。"""
    if not isinstance(raw, dict):
        return ""
    value = raw.get(_PROMPT_RECORD_KEY)
    return value if isinstance(value, str) else ""


def _merge_warnings(existing, extra) -> list:
    """合并告警：保留原有告警，只追加新的、非空且不重复的字符串（顺序稳定）。"""
    out = [item for item in (existing or []) if isinstance(item, str) and item]
    for item in extra or []:
        if isinstance(item, str) and item and item not in out:
            out.append(item)
    return out


def _downgrade_static_status(status: str) -> str:
    """静态结果**不得**因为一份读不出来的记录而被当成完整答案。

    只有 complete 需要降级：partial / ambiguous / missing 本身已经表达了不确定性。
    """
    return "partial" if status == "complete" else status


def _apply_record_to_summary(summary: dict, record_text: str) -> None:
    """把图片内记录覆盖到摘要的提示词字段上（原地改 summary）。

    判定与后果（与 codec 的公共状态协议一致，本函数**不发明**第五种状态）：
      · 无记录原文           → 一字不动：保留历史解析器行为（老图不受影响）。
      · 记录无效/未来版本     → 保留静态可靠结果，静态为 complete 时降级为 partial，并说明原因。
      · 记录有效 + exact      → 提示词/负面/阶段/状态/告警全部取自记录；模型、seed、loras 等不受影响。
      · 记录有效 + ambiguous  → 不导出任何提示词（记录侧已清空文本），状态 ambiguous。
      · 记录有效 + unknown    → 不导出任何提示词，状态 missing。

    为什么 ambiguous / unknown 不落回静态图文本：那时**无法证明这张图属于这条提示词**，
    静态反推的文本可能来自工作流里与本图无关的分支；拿它填 prompt 会把不确定伪装成确定。
    """
    if not isinstance(summary, dict) or not record_text:
        return
    static_status = summary.get("promptStatus") or "missing"
    static_prompt = summary.get("prompt") or ""
    public = decode_record(record_text)
    if not isinstance(public, dict):
        # 记录存在但读不出来（损坏 / 字段非法 / 超出上限 / schemaVersion 不认识 /
        # imageAssociation 不是合法值）。
        summary["promptStatus"] = _downgrade_static_status(static_status)
        summary["promptWarnings"] = _merge_warnings(
            summary.get("promptWarnings"),
            ["图片内的提示词记录无法读取（损坏或版本不认识）；以下提示词来自工作流静态解析"
             if static_prompt
             else "图片内的提示词记录无法读取（损坏或版本不认识）"],
        )
        return

    # Ownership and status are authoritative codec decisions; never decode them twice.
    for field in _PROMPT_FIELDS:
        summary[field] = public[field]


def parse_comfy_summary(wf, record: str = "") -> dict:
    result = parse_comfy_fields(wf, record)
    result['hasPrompt'] = bool(result['prompt'])
    return result


def parse_a1111_summary(parameters: str) -> dict:
    return parse_saved_metadata({'parameters': parameters})


def build_entry(abs_path: str, rel_path: str, *, raw=None, stat=None, container=None, parsed=None) -> dict:
    """Small index entry. Full raw fields and configuration stay on demand."""
    stat = stat if stat is not None else os.stat(abs_path)
    if parsed is None:
        if container is None:
            container = read_image_metadata(abs_path) if raw is None else {
                'raw': raw, 'status': 'present' if raw else 'unknown', 'format': 'unknown', 'warnings': []}
        parsed = _parse_container(container, abs_path)
    fields = ('model', 'seed', 'steps', 'cfg', 'sampler', 'scheduler', 'prompt', 'identityPrompt', 'hasPrompt',
              'negativePrompt', 'promptStages', 'promptStatus', 'promptWarnings', 'loras', 'hasWorkflow',
              'metadataState', 'metadataFormat', 'metadataWarnings')
    entry = {key: parsed.get(key) for key in fields}
    entry.update(path=rel_path.replace('\\', '/'), mtime=round(stat.st_mtime, 3), size=stat.st_size,
                 summaryStatus='error' if parsed['metadataState'] == 'error' else 'ready')
    entry['width'], entry['height'] = png_dimensions(abs_path)
    return entry


# ── 增量索引构建 ──

def scan_output_files(output_root: str) -> list:
    """Enumerate images with cached DirEntry stat data; preserve walk order/ties."""
    out = []
    stack = [(output_root, "")]
    while stack:
        directory, prefix = stack.pop()
        subdirs = []
        try:
            with os.scandir(directory) as iterator:
                for entry in iterator:
                    name = entry.name
                    if name.startswith("."):
                        continue
                    try:
                        if entry.is_dir():
                            if not entry.is_symlink():
                                subdirs.append((entry.path, prefix + name + "/"))
                            continue
                        if not name.lower().endswith((".png", ".webp", ".jpg", ".jpeg")):
                            continue
                        stat = entry.stat()
                    except OSError:
                        continue
                    out.append((prefix + name, entry.path, stat.st_mtime, stat.st_size))
        except OSError:
            continue
        stack.extend(reversed(subdirs))
    out.sort(key=lambda item: item[2], reverse=True)
    return out


def build_index(output_root: str, index_path: str, progress_cb=None) -> dict:
    """Compatibility return shape: a complete committed index snapshot."""
    return refresh(output_root, index_path, "full", progress_cb=progress_cb)["index"]


# ── 增量更新（供「生成完后台预热」调用，2026-09-15）──
# 动机：面板要在**打开切到 Outputs 之前**就把新图备好。全量 build_index() 实测 3571 张 ≈ 12.9s，
# 每次新图都全量重扫会把机器吃满；这里只解析「新增 + mtime/size 变化」的文件，其余条目原样复用。

def _index_lock(index_path: str):
    """One transaction lock per index, shared by every writer for that path."""
    return catalog_for(index_path).lock


def _entry_unchanged(old, mtime: float, size: int) -> bool:
    """索引条目是否与磁盘现状一致（判据与 build_index 逐字一致：mtime 容差 0.001s + size 相等）。"""
    if not isinstance(old, dict):
        return False
    try:
        return abs(float(old.get("mtime") or 0.0) - mtime) < 0.001 and int(old.get("size") or 0) == int(size)
    except (TypeError, ValueError):
        return False


def _resolve_entry(full: str, rel: str, mtime: float, size: int, old, *, stamp_failure: bool = True) -> dict:
    """解析单张图 → 索引条目；解析失败绝不打断整轮更新（坏图只坏它自己）。"""
    try:
        return build_entry(full, rel)
    except Exception:
        if not stamp_failure and old:
            return old  # Keep the full-build fallback compatible with existing indexes.
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
        base.update(metadataState="error", metadataWarnings=["metadata-read-failed"], summaryStatus="error")
        return base


def refresh(output_root: str, index_path: str, mode: str = "incremental", *,
            progress_cb=None, removed_paths=()) -> dict:
    """Prepare scans without holding the writer lock; merge concurrent changes."""
    if mode not in ("full", "incremental", "delete"):
        raise ValueError(f"Unknown gallery index refresh mode: {mode}")
    started = time.time()
    owner = catalog_for(index_path)
    existing = owner.snapshot(load_index)
    old_entries = existing["entries"]
    existing_built_at = int(existing.get("builtAt", 0) or 0)
    if mode == "delete":
        # Delete has no preparation IO. Capture and commit under one short lock.
        with owner.lock:
            existing = owner.snapshot(load_index)
            entries = dict(existing["entries"])
            for rel in removed_paths:
                entries.pop(rel, None)
            committed, changed, deleted = owner.commit(existing, {**existing, "entries": entries}, load_index)
        return {"index": committed, "stats": {
            "added": 0, "updated": 0, "removed": len(deleted), "reused": 0,
            "total": committed["total"], "scanned": 0,
            "builtAt": committed.get("builtAt", 0),
            "durationMs": int((time.time() - started) * 1000)}}

    with owner.prepare(load_index) as preparation:
        return _refresh_prepared(output_root, owner, mode, preparation, progress_cb, started)


def _refresh_prepared(output_root, owner, mode, preparation, progress_cb, started):
    existing, concurrent = preparation
    old_entries = existing["entries"]
    existing_built_at = int(existing.get("builtAt", 0) or 0)
    first_build = not existing_built_at
    full_build = mode == "full" or first_build
    try:
        files = scan_output_files(output_root)
    except Exception as exc:
        if full_build:
            raise
        return {"index": existing, "stats": _incremental_skip(
            f"扫描输出目录失败: {exc}", existing_built_at, len(old_entries), started)}
    if not full_build and not files and old_entries:
        return {"index": existing, "stats": _incremental_skip(
            "扫描到 0 个文件而现有索引非空（疑似输出目录不可读/挂载点丢失），已保留索引且未写盘",
            existing_built_at, len(old_entries), started)}
    parser_stale = existing.get("parserVersion") != PARSER_VERSION
    entries, reused = {}, 0
    for i, (rel, full, mtime, size) in enumerate(files):
        old = old_entries.get(rel)
        if not parser_stale and _entry_unchanged(old, mtime, size) and old.get("summaryStatus") != "pending":
            entries[rel] = old
            reused += 1
        else:
            entry = _resolve_entry(full, rel, mtime, size, old, stamp_failure=not full_build)
            entry = {**entry, "summaryStatus": "ready"}
            entries[rel] = entry
        if progress_cb:
            if full_build:
                progress_cb(i + 1, len(files))
            else:
                try:
                    progress_cb(i + 1, len(files))
                except Exception:
                    pass
    prepared = {"version": INDEX_VERSION, "parserVersion": PARSER_VERSION,
                "builtAt": existing_built_at, "total": len(entries), "entries": entries}
    committed, changes, deleted = owner.commit(existing, prepared, load_index,
                                              force=full_build or parser_stale, concurrent=concurrent)
    added = sum(path not in old_entries for path in changes)
    stats = {"added": added, "updated": len(changes) - added, "removed": len(deleted),
             "total": committed["total"], "scanned": len(files), "reused": reused,
             "builtAt": committed.get("builtAt", existing_built_at),
             "durationMs": int((time.time() - started) * 1000)}
    return {"index": committed, "stats": stats}


def index_snapshot(index_path: str) -> dict:
    """Read the owner's complete immutable snapshot (do not mutate entries)."""
    return catalog_for(index_path).snapshot(load_index)


def catalog_view(index_path: str) -> dict:
    """One coherent index reference and summary captured in a short read lock."""
    owner = catalog_for(index_path)
    index = owner.snapshot(load_index)
    view = owner.read_view
    if view is not None and view["index"] is index:
        return dict(view)
    return {"index": index, "revision": owner.revision(index),
            "pending": sum(entry.get("summaryStatus") == "pending" for entry in index["entries"].values())}


def index_changes(index_path: str, since: int = 0) -> dict:
    return {**catalog_for(index_path).changes(since, load_index), "parserVersion": PARSER_VERSION}


def _read_bounded_prompt_record(path):
    """Read only an uncompressed provenance text chunk; skip all workflow bytes."""
    maximum = 256 * 1024
    with open(path, "rb") as handle:
        if handle.read(8) != b"\x89PNG\r\n\x1a\n":
            return ""
        for _ in range(64):
            header = handle.read(8)
            if len(header) != 8:
                return ""
            size, kind = struct.unpack(">I4s", header)
            if kind in (b"IDAT", b"IEND"):
                return ""  # PNG encoders place text before the pixel stream.
            if kind == b"tEXt" and size <= maximum:
                prefix = handle.read(min(size, 80))
                key, separator, rest = prefix.partition(b"\x00")
                if key == _PROMPT_RECORD_KEY.encode("ascii") and separator:
                    value = rest + handle.read(size - len(prefix))
                    return value.decode("utf-8", "replace")
                handle.seek(size - len(prefix) + 4, os.SEEK_CUR)
            else:
                handle.seek(size + 4, os.SEEK_CUR)
    return ""


def register_outputs(output_root: str, index_path: str, paths) -> dict:
    """Register only known saved paths, reading stat and PNG IHDR, never decoding."""
    root = os.path.realpath(output_root)
    known = {}
    for value in paths:
        if not isinstance(value, str) or not value or os.path.isabs(value):
            continue
        full = os.path.realpath(os.path.join(root, value))
        try:
            if os.path.commonpath([root, full]) != root or not full.lower().endswith((".png", ".webp", ".jpg", ".jpeg")):
                continue
            stat = os.stat(full)
            rel = os.path.relpath(full, root).replace("\\", "/")
            width = height = 0
            if full.lower().endswith(".png"):
                with open(full, "rb") as handle:
                    header = handle.read(24)
                if header[:8] == b"\x89PNG\r\n\x1a\n" and len(header) == 24:
                    width, height = struct.unpack(">II", header[16:24])
            known[rel] = {"path": rel, "mtime": round(stat.st_mtime, 3), "size": stat.st_size,
                          "width": width, "height": height, "model": "", "seed": "", "steps": "", "cfg": "",
                          "sampler": "", "scheduler": "", "prompt": "", "hasPrompt": False,
                          "loras": [], "hasWorkflow": False, "metadataState": "unknown", "metadataWarnings": [], "summaryStatus": "pending"}
            if full.lower().endswith(".png"):
                record_text = _read_bounded_prompt_record(full)
                if record_text:
                    _apply_record_to_summary(known[rel], record_text)
                    known[rel]["hasPrompt"] = bool(known[rel]["prompt"])
                    known[rel]["metadataState"] = "present"
        except (OSError, ValueError):
            continue
    owner = catalog_for(index_path)
    with owner.lock:
        old = owner.snapshot(load_index)
        entries = dict(old["entries"])
        for rel, entry in known.items():
            if not _entry_unchanged(entries.get(rel), entry["mtime"], entry["size"]):
                entries[rel] = entry
        committed, changes, removed = owner.commit(old, {**old, "entries": entries}, load_index)
    return {"index": committed, "stats": {"added": sum(path not in old["entries"] for path in changes),
            "updated": sum(path in old["entries"] for path in changes), "removed": 0,
            "total": committed["total"], "builtAt": committed.get("builtAt", 0), "paths": list(changes)}}


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
    return refresh(output_root, index_path, "incremental", progress_cb=progress_cb)["stats"]


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
        # Windows readers must not hold a non-delete-sharing file handle while
        # another writer replaces it. The lock covers IO, never scan preparation.
        with _index_lock(index_path):
            with open(index_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("entries"), dict):
            return data
    except Exception:
        pass
    return {"version": INDEX_VERSION, "parserVersion": PARSER_VERSION, "builtAt": 0, "total": 0, "entries": {}}


def _save_index(index_path: str, index: dict) -> None:
    """Commit a complete generation through an exclusive same-directory file."""
    owner = catalog_for(index_path)
    with owner.lock:
        owner.write(index)
        owner.journal.clear()
        owner.floor = owner.revision(index)


def parse_full(abs_path: str, rel_path: str, *, history=None) -> dict:
    """Read the container once; preserve raw data, provenance and configuration."""
    container = read_image_metadata(abs_path)
    parsed = _parse_container(container, abs_path)
    raw = container['raw']
    stat = os.stat(abs_path)
    entry = build_entry(abs_path, rel_path, stat=stat, parsed=parsed)
    if history and raw.get('prompt') and not _read_prompt_record(raw):
        try:
            try:
                from .services.output_execution_history import recover_prompt_fields
            except ImportError:
                from services.output_execution_history import recover_prompt_fields
            recovered = recover_prompt_fields(json.loads(raw['prompt']), rel_path, stat.st_mtime, history)
            if recovered:
                parsed.update(recovered)
        except Exception:
            pass  # Optional history does not replace reliable saved fragments.
    return {**parsed, 'imageId': rel_path.replace('\\', '/'), 'mtime': entry['mtime'],
            'size': entry['size'], 'parserVersion': PARSER_VERSION, 'lorasExtracted': True}
