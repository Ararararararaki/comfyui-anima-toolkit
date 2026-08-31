# Anima Prompt Batch — 批量提示词注入（控制器节点 + 文件 API + 批任务控制器）
#
# 后端职责：
#   1. 提示词文件分组解析（parse_prompt_groups）：忠实复刻桌面「批生图」的三种标题格式
#      （## 组N markdown 分段 / 【N】标题 / NN 数字序号标题 + 整文件兜底）
#   2. HTTP API：/anima/prompt/list（列文件）、/anima/prompt/parse（解析分组）、
#      /anima/prompt/read（读原文）
#   3. 批任务控制器（/anima/batch/*，2026-08-24 新增）：
#      - 批次清单持久化（data/batches/<id>.json：模板 + 逐条任务 + 状态），
#        ComfyUI 重启 / 浏览器刷新后可从清单恢复；
#      - 服务端展开入队：模板注入（正向/负向/相机词/输出子目录）→ validate_prompt
#        → PromptQueue.put，逐条链式执行（一组跑完才入队下一组），
#        不依赖浏览器劫持 app.queuePrompt，API/无浏览器模式同样可用；
#      - 稳定的任务状态：每条任务一个自铸造 prompt_id，extra_data 带
#        anima_batch={batch_id,idx} 标记，按 prompt_id/标记从 /queue、/history
#        精确匹配（不再用组名子串反查）；
#      - 暂停 / 继续 / 跳过 / 重试 / 取消（重试支持失败组与重启中断组）。
#
# 本节点是「配置载体」，其 STRING 输出仅返回第一条提示词供预览/调试（可选接线）。

import os
import re
import json
import copy
import time
import uuid
import asyncio
import threading
import folder_paths
from aiohttp import web
from server import PromptServer
from .anima_prompt_parser import parse_prompt_groups

# 输入目录（ComfyUI input 根目录，prompt 文件可放 input/ 或 input/prompts/）
_INPUT_ROOT = None


def _input_root() -> str:
    global _INPUT_ROOT
    if _INPUT_ROOT is None:
        try:
            _INPUT_ROOT = folder_paths.get_input_directory()
        except Exception:
            _INPUT_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "input")
    return _INPUT_ROOT


def _safe_resolve(path: str) -> str | None:
    """把用户输入解析为绝对路径；相对路径以 ComfyUI input/ 为根。

    仅允许落在 input 目录内的路径（相对路径），或任意存在的绝对路径
    （单机单用户工具，允许用户指向桌面等任意 txt；返回 None 表示非法）。
    """
    p = (path or "").strip().strip('"').strip("'")
    if not p:
        return None
    if os.path.isabs(p):
        return os.path.normpath(p)
    # 相对路径：限制在 input 目录内，防 ../ 穿越
    base = os.path.normpath(_input_root())
    full = os.path.normpath(os.path.join(base, p))
    if os.path.commonpath([base, full]) != base:
        return None
    return full


def _safe_group_name(name: str) -> str:
    """组名清洗：防路径分隔符 / Windows 非法字符 / 穿越（'..'）导致输出目录错位。"""
    s = str(name or '').replace('/', '_').replace('\\', '_').replace(':', '_')
    for ch in '*?<>|"':
        s = s.replace(ch, '_')
    s = s.replace('..', '_').strip()
    s = ''.join(c if ord(c) >= 32 else '_' for c in s)
    return s or '组'


class AnimaPromptBatch:
    NAME = "TK Prompt Batch"
    CATEGORY = "TK/batch"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_files": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "每行一个提示词文件路径（相对 input/ 或绝对路径）",
                    "tooltip": "提示词文件列表；支持 ## 组N / 【N】标题 / 01 序号 三种分组格式。",
                }),
                "positive_target": ("STRING", {
                    "default": "",
                    "placeholder": "正向提示词目标节点（下拉选择）",
                    "tooltip": "注入正向提示词的目标文本节点（nodeId.inputKey，前端下拉自动填写）。",
                }),
                "negative_target": ("STRING", {
                    "default": "",
                    "placeholder": "负向提示词目标节点（可选）",
                    "tooltip": "可选：注入负向提示词的目标文本节点。",
                }),
                "camera_target": ("STRING", {
                    "default": "",
                    "placeholder": "TK 相机控制节点 ID（整批统一机位）",
                    "tooltip": "可选：指定一个 TK Camera Control 节点，注入对应机位词。",
                }),
                "output_subfolder": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "按组名覆盖 SaveImage 的 filename_prefix，每组图片存到独立子目录。",
                }),
                "groups_selection": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "勾选的组（JSON，前端维护）",
                    "tooltip": "已勾选组名的 JSON 数组，随工作流持久化；留空=全部。",
                }),
                "region_values": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "每组区域参数（JSON，前端维护）",
                    "tooltip": "每组区域参数 x,y,w,h,强度（0~1 比例），随工作流持久化；队列时自动注入 ConditioningSetAreaPercentage。",
                }),
                "camera_values": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "每组相机参数（JSON，前端维护）",
                    "tooltip": "每组独立机位：{组键: 机位描述}（自然语言/预设名/px,py,pz,roll），随工作流持久化；优先级高于文件「相机:」行。",
                }),
                "extra_dirs": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "每行一个附加提示词目录（绝对路径）；「最新」与文件浏览器会一起搜索",
                    "tooltip": "附加提示词搜索目录（每行一个绝对路径）。AI 写词落盘到 input 之外时填这里，「最新」/自动最新/递归浏览都会覆盖。",
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("preview_prompt",)
    FUNCTION = "execute"
    DESCRIPTION = "批量提示词注入：读取提示词文件分组，队列时展开为多组顺序生成（注入目标任意选择，适配所有工作流）；组内可写「区域: x,y,w,h,强度」自动锁定人物在画面区域"

    def execute(self, prompt_files, positive_target, negative_target,
                camera_target, output_subfolder, groups_selection, region_values,
                camera_values="", extra_dirs=""):
        # 返回第一条选中提示词作为预览（可选接线到文本节点做单张试跑）
        selected = self._selected_group_names(groups_selection)
        cam_overrides = {}
        if camera_values and camera_values.strip():
            try:
                parsed = json.loads(camera_values)
                if isinstance(parsed, dict):
                    cam_overrides = {str(k): str(v) for k, v in parsed.items() if v}
            except Exception:
                cam_overrides = {}
        for line in (prompt_files or "").splitlines():
            path = _safe_resolve(line)
            if not path or not os.path.isfile(path):
                continue
            for gname, prompts, _region, _bg, _person, _camera, _neg in parse_prompt_groups(path):
                if selected and gname not in selected:
                    continue
                if prompts:
                    return (prompts[0],)
        return ("",)

    @staticmethod
    def _selected_group_names(groups_selection: str) -> set:
        sel = set()
        if groups_selection and groups_selection.strip():
            try:
                arr = json.loads(groups_selection)
                if isinstance(arr, list):
                    sel = {str(x) for x in arr}
            except Exception:
                pass
        return sel


NODE_CLASS_MAPPINGS = {
    AnimaPromptBatch.NAME: AnimaPromptBatch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaPromptBatch.NAME: "TK 批量提示词注入",
}


# ============ HTTP API ============

# 提示词文件扩展名
_PROMPT_EXTS = (".txt", ".md", ".prompt")


def _scan_prompt_files(root: str, max_depth: int = 4, limit: int = 500):
    """递归扫描 root 下的提示词文件，返回 [(相对路径, mtime, 绝对路径)]（按 mtime 降序）。

    跳过隐藏目录（.开头）；depth 限制防失控；文件数上限保护。
    """
    hits: list[tuple[str, float, str]] = []

    def walk(cur: str, rel: str, depth: int):
        if depth > max_depth or len(hits) >= limit:
            return
        try:
            entries = os.listdir(cur)
        except OSError:
            return
        for name in entries:
            if name.startswith("."):
                continue
            full = os.path.join(cur, name)
            try:
                if os.path.isdir(full):
                    walk(full, os.path.join(rel, name) if rel else name, depth + 1)
                elif os.path.isfile(full) and name.lower().endswith(_PROMPT_EXTS):
                    hits.append((os.path.join(rel, name) if rel else name, os.path.getmtime(full), full))
            except OSError:
                continue
            if len(hits) >= limit:
                return

    walk(root, "", 0)
    hits.sort(key=lambda e: e[1], reverse=True)
    return hits


def _extra_dirs_from_query(request) -> list[str]:
    """解析附加搜索目录参数（extra=<json 数组>，每个为绝对路径）。"""
    raw = (request.query.get("extra") or "").strip()
    if not raw:
        return []
    try:
        arr = json.loads(raw)
    except Exception:
        arr = []
    out = []
    for p in arr or []:
        s = str(p).strip().strip('"').strip("'")
        if s and os.path.isabs(s) and os.path.isdir(s):
            out.append(os.path.normpath(s))
    return out


@PromptServer.instance.routes.get("/anima/prompt/list")
async def prompt_list(request):
    """列出指定目录下的 .txt 提示词文件与子目录（可导航浏览器）。

    参数：dir=<相对 input/ 的目录，或任意绝对路径>。默认空=input/ 根。
    recursive=1 时：忽略 dir，递归扫描 input 全树（+ extra 附加目录），
    返回扁平文件列表 {path, mtime}（path=相对 input/ 或绝对路径），供「全树最新/最近文件」使用。
    普通模式返回 {dir, abs_dir, parent, dirs:[], files:[{name, mtime}]}。
    """
    recursive = (request.query.get("recursive") or "").strip() == "1"
    base = os.path.normpath(_input_root())
    if recursive:
        # input 树内返回相对路径（parse/list 可直接用）；附加目录返回绝对路径
        all_hits = [(p, m) for p, m, _a in _scan_prompt_files(base)]
        for d in _extra_dirs_from_query(request):
            for rel, mtime, _abs in _scan_prompt_files(d):
                all_hits.append((os.path.join(d, rel), mtime))
        all_hits.sort(key=lambda e: e[1], reverse=True)
        return web.json_response({
            "recursive": True,
            "files": [{"path": p, "mtime": int(m * 1000)} for p, m in all_hits],
        })

    raw = (request.query.get("dir") or "").strip()
    if not raw:
        cur = base
    elif os.path.isabs(raw):
        cur = os.path.normpath(raw)
    else:
        cur = os.path.normpath(os.path.join(base, raw))
    if not os.path.isdir(cur):
        cur = base

    dirs, files = [], []
    try:
        entries = []
        for name in os.listdir(cur):
            full = os.path.join(cur, name)
            if os.path.isdir(full):
                dirs.append(name)
            elif os.path.isfile(full) and name.lower().endswith(_PROMPT_EXTS):
                entries.append((name, os.path.getmtime(full)))
        # 文件按修改时间降序（最新在前）——前端「最新」按钮直接取 files[0]
        entries.sort(key=lambda e: e[1], reverse=True)
        files = [{"name": n, "mtime": int(m * 1000)} for n, m in entries]
        dirs.sort()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

    # 上级目录：input/ 内返回相对路径（"" = input 根 = 无上级）；绝对路径返回父目录绝对路径
    pdir = os.path.dirname(cur)
    if os.path.commonpath([base, cur]) == base:
        disp = os.path.relpath(cur, base)
        parent = "" if (cur == base or pdir == base) else os.path.relpath(pdir, base)
    else:
        disp = cur
        parent = pdir if pdir != cur else ""
    return web.json_response({
        "dir": disp,
        "abs_dir": cur,
        "parent": parent,
        "dirs": dirs,
        "files": files,
    })


@PromptServer.instance.routes.get("/anima/prompt/latest")
async def prompt_latest(request):
    """返回最新修改的提示词文件（递归扫描 input 全树 + 可选附加目录）。

    参数：extra=<json 数组，绝对路径目录>。
    返回 {ok, path, mtime, abs}；无文件时 {ok: false}。
    """
    base = os.path.normpath(_input_root())
    all_hits = [(p, m, a) for p, m, a in _scan_prompt_files(base)]
    for d in _extra_dirs_from_query(request):
        for rel, mtime, _abs in _scan_prompt_files(d):
            all_hits.append((os.path.join(d, rel), mtime, _abs))
    if not all_hits:
        return web.json_response({"ok": False, "error": "input 目录下没有提示词文件"})
    all_hits.sort(key=lambda e: e[1], reverse=True)
    path, mtime, abs_path = all_hits[0]
    return web.json_response({"ok": True, "path": path, "mtime": int(mtime * 1000), "abs": abs_path})


@PromptServer.instance.routes.get("/anima/prompt/parse")
async def prompt_parse(request):
    """解析一个提示词文件为分组。参数：path=<相对 input 或绝对路径>。

    返回 {ok, path, groups:[{name, count, prompts:[...]}]}。
    """
    path = _safe_resolve(request.query.get("path", ""))
    if not path or not os.path.isfile(path):
        return web.json_response({"ok": False, "error": "文件不存在或路径非法"}, status=404)
    groups = parse_prompt_groups(path)
    return web.json_response({
        "ok": True,
        "path": path,
        "groups": [{"name": n, "count": len(p), "prompts": p,
                    "region": list(r) if r else None,
                    "background": bg, "person": person,
                    "camera": cam, "neg": neg}
                   for n, p, r, bg, person, cam, neg in groups],
    })


@PromptServer.instance.routes.get("/anima/prompt/read")
async def prompt_read(request):
    """读取提示词文件原文。参数：path=<相对 input 或绝对路径>。"""
    path = _safe_resolve(request.query.get("path", ""))
    if not path or not os.path.isfile(path):
        return web.json_response({"ok": False, "error": "文件不存在或路径非法"}, status=404)
    try:
        with open(path, encoding="utf-8-sig") as f:
            content = f.read()
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)
    return web.json_response({"ok": True, "path": path, "content": content})


# ============ 批任务控制器（/anima/batch/*） ============
#
# 批次 = 一次批量任务。清单持久化到 data/batches/<id>.json，内含：
#   - template：API prompt 模板（前端 graphToPrompt().output，含全部节点 inputs）
#   - jobs：逐条任务（组/文本/负向/相机/子目录/状态/prompt_id）
# 执行模型：链式——每次只入队一条（validate → PromptQueue.put），该条跑完
# （history 出现终态）才入队下一条；暂停 = 停止推进；重试/恢复 = 重置状态后推进。
# 每条任务自铸造 uuid 作 prompt_id，入队时在 extra_data 打 anima_batch 标记，
# 状态对账按 prompt_id 精确匹配 /queue 与 /history，无需字符串反查。

BATCH_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "batches")
_BATCH_LOCK = threading.Lock()
_BATCH_NUMBER_LOCK = threading.Lock()
_BATCH_FILE_LOCKS: dict[str, threading.Lock] = {}
_BATCH_FILES_LOCK = threading.Lock()
_BATCH_NUMBER = int(time.time() * 1000) % 100000
_BATCH_WORKERS: dict[str, asyncio.Task] = {}
_BATCH_WORKER_INTERVAL = 0.8
_BATCH_MISSING_GRACE_SECONDS = 6.0
_BATCH_SETTLE_SECONDS = 3.0

# 任务状态
ST_PENDING = "pending"      # 未入队（含重启中断后待重跑）
ST_QUEUED = "queued"        # 已在 ComfyUI 排队
ST_RUNNING = "running"      # 正在执行
ST_DONE = "done"            # 成功（history success）
ST_FAILED = "failed"        # 失败（history error 或入队失败）
ST_SKIPPED = "skipped"      # 被跳过
ST_INTERRUPTED = "interrupted"  # 曾入队但队列被清/重启，无终态
ST_RETRY = "retry"          # 已请求重试，等待重新入队
ST_TERMINAL = {ST_DONE, ST_FAILED, ST_SKIPPED, ST_INTERRUPTED}

# 批次状态
BS_RUNNING = "running"
BS_PAUSED = "paused"
BS_FINISHED = "finished"
BS_CANCELLED = "cancelled"


def _batch_lock(batch_id: str) -> threading.Lock:
    with _BATCH_FILES_LOCK:
        lk = _BATCH_FILE_LOCKS.get(batch_id)
        if lk is None:
            lk = threading.Lock()
            _BATCH_FILE_LOCKS[batch_id] = lk
        return lk


def _batch_path(batch_id: str) -> str:
    return os.path.join(BATCH_DIR, batch_id + ".json")


def _load_batch(batch_id: str) -> dict | None:
    try:
        with open(_batch_path(batch_id), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("jobs"), list):
            return data
    except Exception:
        return None
    return None


def _save_batch(batch: dict):
    os.makedirs(BATCH_DIR, exist_ok=True)
    batch["updated"] = time.time()
    tmp = _batch_path(batch["id"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(batch, f, ensure_ascii=False)
    os.replace(tmp, _batch_path(batch["id"]))


def _next_batch_number() -> float:
    global _BATCH_NUMBER
    with _BATCH_NUMBER_LOCK:
        _BATCH_NUMBER += 1
        return float(_BATCH_NUMBER)


def _job_summary(job: dict) -> dict:
    return {
        "idx": job.get("idx", 0),
        "group": job.get("group", ""),
        "status": job.get("status", ST_PENDING),
        "error": job.get("error") or None,
        "prompt_id": (job.get("prompt_id") or "")[:8],
        "camera": job.get("camera") or None,
        "neg": bool(job.get("neg")),
        "outputs": job.get("outputs") or [],
    }


def _batch_summary(batch: dict) -> dict:
    counts = {s: 0 for s in (ST_PENDING, ST_QUEUED, ST_RUNNING, ST_DONE,
                             ST_FAILED, ST_SKIPPED, ST_INTERRUPTED, ST_RETRY)}
    for j in batch.get("jobs", []):
        counts[j.get("status", ST_PENDING)] = counts.get(j.get("status", ST_PENDING), 0) + 1
    return {
        "id": batch["id"],
        "created": batch.get("created", 0),
        "updated": batch.get("updated", 0),
        "state": batch.get("state", BS_FINISHED),
        "node_ref": batch.get("node_ref") or "",
        "total": len(batch.get("jobs", [])),
        "counts": counts,
    }


def _inject_into_template(template: dict, job: dict) -> tuple[dict, str | None]:
    """深拷贝模板并注入文本、输入补丁、负向/相机/输出子目录。返回 (prompt, error)。"""
    prompt = copy.deepcopy(template)

    pos_id = str(job.get("posId") or "")
    pos_key = job.get("posKey") or ""
    text = str(job.get("text") or "")
    patches = job.get("patches") or []
    if not isinstance(patches, list):
        return None, "批次输入补丁必须是数组"

    # 旧文本批次路径保持原语义；补丁任务可以不提供 text/posId/posKey。
    if text.strip() or pos_id or pos_key:
        node = prompt.get(pos_id)
        if node is None:
            return None, f"注入目标节点 {pos_id} 不在当前工作流中（画布已改动？请重新选择目标）"
        if not isinstance(node.get("inputs"), dict) or pos_key not in node.get("inputs", {}):
            return None, f"注入目标 {pos_id}.{pos_key} 不存在（可用输入：{', '.join(list((node.get('inputs') or {}).keys())[:8])}）"
        node["inputs"][pos_key] = text

    for patch_index, patch in enumerate(patches):
        if not isinstance(patch, dict):
            return None, f"输入补丁 patches[{patch_index}] 必须是对象"
        patch_node_id = str(patch.get("nodeId") or patch.get("node_id") or "")
        patch_key = str(patch.get("input") or patch.get("key") or patch.get("nodeKey") or "")
        if not patch_node_id or not patch_key:
            return None, f"输入补丁 patches[{patch_index}] 缺少 nodeId 或 input"
        if "value" not in patch:
            return None, f"输入补丁 patches[{patch_index}] 缺少 value"
        patch_node = prompt.get(patch_node_id)
        if patch_node is None:
            return None, f"补丁目标节点 {patch_node_id} 不在当前工作流中（画布已改动？）"
        patch_inputs = patch_node.get("inputs") if isinstance(patch_node, dict) else None
        if not isinstance(patch_inputs, dict) or patch_key not in patch_inputs:
            available = ", ".join(list(patch_inputs or {})[:8]) if isinstance(patch_inputs, dict) else "无"
            return None, f"补丁目标 {patch_node_id}.{patch_key} 不存在（可用输入：{available}）"
        try:
            json.dumps(patch["value"], ensure_ascii=False)
        except (TypeError, ValueError):
            return None, f"输入补丁 patches[{patch_index}].value 不是可序列化 JSON"
        patch_inputs[patch_key] = copy.deepcopy(patch["value"])

    if not text.strip() and not patches:
        return None, "批次任务缺少文本注入或输入补丁"

    # 负向：仅当本任务有负向文本且指定了目标节点
    neg_id = str(job.get("negId") or "")
    neg_key = job.get("negKey") or ""
    neg_text = job.get("neg")
    if neg_id and neg_key and neg_text:
        nnode = prompt.get(neg_id)
        if nnode is None:
            return None, f"负向目标节点 {neg_id} 不在当前工作流中"
        if not isinstance(nnode.get("inputs"), dict) or neg_key not in nnode.get("inputs", {}):
            return None, f"负向目标 {neg_id}.{neg_key} 不存在"
        nnode["inputs"][neg_key] = str(neg_text)

    # 输出子目录：覆盖所有 SaveImage / PreviewImage / imageSave 的 filename_prefix
    if job.get("subfolder"):
        safe = _safe_group_name(job.get("group") or "")
        now = time.localtime()
        date_dir = time.strftime("%Y-%m-%d", now)
        stamp = time.strftime("%Y%m%d_%H%M", now)
        prefix = f"{date_dir}/{stamp}_{safe}_anima"
        changed = 0
        for nid, nd in prompt.items():
            if not isinstance(nd, dict):
                continue
            cls = str(nd.get("class_type") or "")
            if not re.search(r"SaveImage|PreviewImage|imageSave", cls, re.I):
                continue
            ins = nd.get("inputs")
            if isinstance(ins, dict) and "filename_prefix" in ins:
                ins["filename_prefix"] = prefix
                changed += 1
        if changed == 0:
            return None, f"工作流中没有 SaveImage/PreviewImage 节点（子目录输出需要保存节点）"
    return prompt, None


async def _queue_prompt_inner(
    prompt: dict,
    extra_data: dict,
    batch_id: str,
    idx: int,
    number: float,
    client_id: str = "",
) -> tuple[str | None, str | None]:
    """按 ComfyUI 标准队列语义入队，并保留发起浏览器的客户端关联。"""
    import execution
    from server import PromptServer
    prompt_id = str(uuid.uuid4())
    try:
        valid = await execution.validate_prompt(prompt_id, prompt, None)
    except Exception as e:
        return None, f"工作流校验异常：{e}"
    if not valid[0]:
        return None, f"工作流校验失败：{valid[1]}"
    outputs_to_execute = valid[2]
    ed = dict(extra_data or {})
    ed["anima_batch"] = {"batch": batch_id, "idx": idx}
    client_id = str(client_id or "").strip()
    if client_id:
        # ComfyUI execution.py 从这里读取客户端 ID，并将 executing/executed/
        # execution_* 与 PreviewImage 结果发送回对应 websocket。
        ed["client_id"] = client_id
    ed["create_time"] = int(time.time() * 1000)
    sensitive = {}
    try:
        for k in execution.SENSITIVE_EXTRA_DATA_KEYS:
            if k in ed:
                sensitive[k] = ed.pop(k)
    except Exception:
        sensitive = {}
    PromptServer.instance.prompt_queue.put(
        (number, prompt_id, prompt, ed, outputs_to_execute, sensitive))
    return prompt_id, None


async def _enqueue_job(batch: dict, job: dict) -> None:
    """把单条任务入队（含模板注入 + validate + put）。失败 → 任务 failed。"""
    prompt, err = _inject_into_template(batch.get("template") or {}, job)
    if err:
        job["status"] = ST_FAILED
        job["error"] = err
        return
    pid, perr = await _queue_prompt_inner(
        prompt,
        {},
        batch["id"],
        job.get("idx", 0),
        _next_batch_number(),
        client_id=batch.get("client_id") or "",
    )
    if perr:
        job["status"] = ST_FAILED
        job["error"] = perr
        return
    job["prompt_id"] = pid
    job["status"] = ST_QUEUED
    job["error"] = None


def _sync_job_status(batch: dict) -> bool:
    """按 prompt_id 对账 /queue 与 /history，更新任务状态。返回是否有变化。"""
    from server import PromptServer
    q = PromptServer.instance.prompt_queue
    try:
        running, pending = q.get_current_queue_volatile()
    except Exception:
        # 队列状态暂时不可读时不能把所有在途任务误判为中断。
        # 这类短暂失败正是浏览器看到 Failed to fetch 时最容易同时发生的窗口。
        return False
    running_ids = {item[1] for item in running}
    pending_ids = {item[1] for item in pending}

    changed = False
    for job in batch.get("jobs", []):
        pid = job.get("prompt_id")
        st = job.get("status", ST_PENDING)
        if not pid:
            continue
        if st in (ST_QUEUED, ST_RUNNING):
            if pid in running_ids:
                if job.pop("_missing_since", None) is not None:
                    changed = True
                if st != ST_RUNNING:
                    job["status"] = ST_RUNNING
                    changed = True
                continue
            if pid in pending_ids:
                if job.pop("_missing_since", None) is not None:
                    changed = True
                if st != ST_QUEUED:
                    job["status"] = ST_QUEUED
                    changed = True
                continue
            try:
                h = q.get_history(prompt_id=pid)
            except Exception:
                # 历史查询失败也不能制造“中断”状态，下一轮再对账。
                continue
            if pid in h:
                entry = h[pid]
                status = entry.get("status") or {}
                ok = status.get("status_str") == "success" or status.get("completed") is True
                job["status"] = ST_DONE if ok else ST_FAILED
                job["error"] = None if ok else _history_error(entry)
                if ok:
                    job["_next_enqueue_after"] = time.time() + _BATCH_SETTLE_SECONDS
                job.pop("_missing_since", None)
                outputs = _history_outputs(entry)
                if json.dumps(outputs, ensure_ascii=False) != json.dumps(job.get("outputs") or [], ensure_ascii=False):
                    job["outputs"] = outputs
                changed = True
            else:
                # 队列和历史的读取存在短暂竞态；连续缺失一段时间后才认定
                # 队列被清空 / ComfyUI 重启，避免过早标记 interrupted。
                now = time.time()
                missing_since = job.get("_missing_since")
                if not missing_since:
                    job["_missing_since"] = now
                    changed = True
                    continue
                try:
                    missing_age = now - float(missing_since)
                except (TypeError, ValueError):
                    missing_age = _BATCH_MISSING_GRACE_SECONDS
                if missing_age < _BATCH_MISSING_GRACE_SECONDS:
                    continue
                job["status"] = ST_INTERRUPTED
                job["error"] = "任务已入队但未产生结果（队列清空或 ComfyUI 重启），可重试"
                job.pop("_missing_since", None)
                changed = True
    return changed


def _history_error(entry: dict) -> str:
    status = entry.get("status") or {}
    msgs = status.get("messages") or []
    for m in msgs:
        if not isinstance(m, (list, tuple)) or len(m) < 2:
            continue
        kind = str(m[0])
        if re.search(r"EXECUTION_ERROR|EXECUTION_INTERRUPTED|execution_error|execution_interrupted", kind, re.I):
            data = m[1]
            if isinstance(data, str):
                return data[:400]
            try:
                return json.dumps(data, ensure_ascii=False)[:400]
            except Exception:
                return str(data)[:400]
    s = status.get("status_str") or ""
    return s if s and s != "success" else "执行失败"


def _history_outputs(entry: dict) -> list:
    out = []
    outputs = entry.get("outputs") or {}
    for nid, nd in outputs.items():
        if not isinstance(nd, dict):
            continue
        for img in nd.get("images") or []:
            if isinstance(img, dict):
                out.append({
                    "node": str(nid),
                    "filename": img.get("filename"),
                    "subfolder": img.get("subfolder") or "",
                    "type": img.get("type") or "",
                })
    return out[:20]


async def _advance_batch(batch: dict) -> bool:
    """链式推进：无在途任务且未暂停时，把下一个待执行任务入队。

    返回是否有变化（入队 / 状态流转到 finished），供上层决定是否落盘。
    """
    if batch.get("state") != BS_RUNNING:
        return False
    inflight = any(j.get("status") in (ST_QUEUED, ST_RUNNING) for j in batch.get("jobs", []))
    if inflight:
        return False
    if all(j.get("status") in ST_TERMINAL for j in batch.get("jobs", [])):
        batch["state"] = BS_FINISHED
        return True
    now = time.time()
    for completed in batch.get("jobs", []):
        settle_until = completed.get("_next_enqueue_after")
        if settle_until:
            try:
                if now < float(settle_until):
                    return False
            except (TypeError, ValueError):
                pass
            completed.pop("_next_enqueue_after", None)
    if any(j.get("status") == ST_DONE for j in batch.get("jobs", [])):
        _trim_batch_runtime_cache()
    for job in batch.get("jobs", []):
        if job.get("status") in (ST_PENDING, ST_RETRY):
            await _enqueue_job(batch, job)
            return True
    return False


async def _refresh_batch(batch: dict, save: bool = True) -> dict:
    """对账状态 + 推进 + 写盘。"""
    changed = _sync_job_status(batch)
    if await _advance_batch(batch):
        changed = True
    if changed:
        if save:
            _save_batch(batch)
    return _batch_summary(batch)


def _trim_batch_runtime_cache() -> None:
    """在链式任务之间释放 Python/GPU 的闲置缓存，降低连续换图时的显存峰值。"""
    try:
        import gc
        gc.collect()
    except Exception:
        pass
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


async def _batch_worker_tick(batch_id: str) -> bool:
    """执行一次服务端批次心跳；不依赖浏览器是否正在请求 status。"""
    batch = _load_batch(batch_id)
    if batch is None:
        return False
    with _batch_lock(batch_id):
        try:
            await _refresh_batch(batch)
        except Exception as exc:
            # 心跳异常不能杀掉 ComfyUI 主进程，也不能把任务伪装成失败。
            print(f"[TK Batch] 批次 {batch_id} 心跳暂时失败：{exc}")
            return True
        return batch.get("state") == BS_RUNNING


async def _batch_worker(batch_id: str) -> None:
    """批次后台推进器：页面关闭、刷新或一次请求断线后仍继续执行。"""
    try:
        while await _batch_worker_tick(batch_id):
            await asyncio.sleep(_BATCH_WORKER_INTERVAL)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        print(f"[TK Batch] 批次 {batch_id} 后台推进器退出：{exc}")
    finally:
        current = _BATCH_WORKERS.get(batch_id)
        if current is asyncio.current_task():
            _BATCH_WORKERS.pop(batch_id, None)


def _ensure_batch_worker(batch_id: str) -> None:
    """为运行中的批次建立唯一后台推进器。"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    current = _BATCH_WORKERS.get(batch_id)
    if current is not None and not current.done():
        return
    _BATCH_WORKERS[batch_id] = loop.create_task(_batch_worker(batch_id))


@PromptServer.instance.routes.post("/anima/batch/run")
async def batch_run(request):
    """创建并启动批次（服务端展开执行）。

    body: {
      template: {nodeId: {class_type, inputs}}   // 当前工作流 API prompt（前端 graphToPrompt().output）
      jobs: [{group, text?, posId?, posKey?, patches?, neg?, negId?, negKey?, camera?, subfolder?}]
        patches: [{nodeId, input, value}]  // 逐项替换工作流节点输入；可用于画廊单卡任务
      node_ref?: string                          // 发起节点画布 id（刷新后恢复匹配）
    }
    → {ok, batchId, summary}
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    template = body.get("template")
    jobs = body.get("jobs")
    client_id = str(body.get("client_id") or "").strip()
    if not isinstance(template, dict) or not template:
        return web.json_response({"ok": False, "error": "缺少 template（当前工作流 API prompt）"}, status=400)
    if not isinstance(jobs, list) or not jobs:
        return web.json_response({"ok": False, "error": "jobs 不能为空（请至少勾选一组）"}, status=400)
    payload = []
    for i, j in enumerate(jobs):
        if not isinstance(j, dict):
            return web.json_response({"ok": False, "error": f"jobs[{i}] 必须是对象"}, status=400)
        text = str(j.get("text") or "")
        patches = j.get("patches") or []
        if not isinstance(patches, list):
            return web.json_response({"ok": False, "error": f"jobs[{i}]（{j.get('group') or '?'}）的 patches 必须是数组"}, status=400)
        if not text.strip() and not patches:
            return web.json_response({"ok": False, "error": f"jobs[{i}]（{j.get('group') or '?'}）缺少提示词或输入补丁"}, status=400)
        for patch_index, patch in enumerate(patches):
            if not isinstance(patch, dict):
                return web.json_response({"ok": False, "error": f"jobs[{i}].patches[{patch_index}] 必须是对象"}, status=400)
            if not (patch.get("nodeId") or patch.get("node_id")) or not (patch.get("input") or patch.get("key") or patch.get("nodeKey")):
                return web.json_response({"ok": False, "error": f"jobs[{i}].patches[{patch_index}] 缺少 nodeId 或 input"}, status=400)
            if "value" not in patch:
                return web.json_response({"ok": False, "error": f"jobs[{i}].patches[{patch_index}] 缺少 value"}, status=400)
            try:
                json.dumps(patch["value"], ensure_ascii=False)
            except (TypeError, ValueError):
                return web.json_response({"ok": False, "error": f"jobs[{i}].patches[{patch_index}].value 不是可序列化 JSON"}, status=400)
        payload.append({
            "idx": i,
            "group": str(j.get("group") or f"组{i+1}"),
            "text": text,
            "posId": str(j.get("posId") or ""),
            "posKey": str(j.get("posKey") or ""),
            "negId": str(j.get("negId") or ""),
            "negKey": str(j.get("negKey") or ""),
            "neg": str(j.get("neg") or "") if j.get("neg") else None,
            "camera": str(j.get("camera") or "") if j.get("camera") else None,
            "subfolder": bool(j.get("subfolder")),
            "patches": copy.deepcopy(patches),
            "status": ST_PENDING,
            "prompt_id": None,
            "error": None,
            "outputs": [],
        })
    batch_id = f"b{int(time.time()*1000)}{uuid.uuid4().hex[:6]}"
    batch = {
        "id": batch_id,
        "created": time.time(),
        "updated": time.time(),
        "state": BS_RUNNING,
        "node_ref": str(body.get("node_ref") or ""),
        "client_id": client_id,
        "template": template,
        "jobs": payload,
    }
    with _batch_lock(batch_id):
        _save_batch(batch)
        summary = await _refresh_batch(batch)
    _ensure_batch_worker(batch_id)
    return web.json_response({"ok": True, "batchId": batch_id, "summary": summary})


async def _load_and_lock(batch_id: str):
    """按 id 加载批次；返回 (batch, lock) 或 (None, None)。"""
    batch = _load_batch(batch_id)
    if batch is None:
        return None, None
    return batch, _batch_lock(batch_id)


@PromptServer.instance.routes.post("/anima/batch/{batch_id}/pause")
async def batch_pause(request):
    bid = request.match_info["batch_id"]
    batch, lk = await _load_and_lock(bid)
    if batch is None:
        return web.json_response({"ok": False, "error": "批次不存在"}, status=404)
    with lk:
        if batch.get("state") == BS_RUNNING:
            batch["state"] = BS_PAUSED
            _save_batch(batch)
        summary = _batch_summary(batch)
    return web.json_response({"ok": True, "summary": summary})


@PromptServer.instance.routes.post("/anima/batch/{batch_id}/resume")
async def batch_resume(request):
    bid = request.match_info["batch_id"]
    batch, lk = await _load_and_lock(bid)
    if batch is None:
        return web.json_response({"ok": False, "error": "批次不存在"}, status=404)
    with lk:
        if batch.get("state") in (BS_PAUSED, BS_FINISHED, BS_CANCELLED):
            batch["state"] = BS_RUNNING
        await _refresh_batch(batch)
        summary = _batch_summary(batch)
    if batch.get("state") == BS_RUNNING:
        _ensure_batch_worker(bid)
    return web.json_response({"ok": True, "summary": summary})


@PromptServer.instance.routes.post("/anima/batch/{batch_id}/cancel")
async def batch_cancel(request):
    """取消：删除本批次尚未运行的排队项；正在运行的让其自然完成。"""
    from server import PromptServer
    bid = request.match_info["batch_id"]
    batch, lk = await _load_and_lock(bid)
    if batch is None:
        return web.json_response({"ok": False, "error": "批次不存在"}, status=404)
    with lk:
        for job in batch.get("jobs", []):
            pid = job.get("prompt_id")
            if pid and job.get("status") in (ST_QUEUED,):
                try:
                    PromptServer.instance.prompt_queue.delete_queue_item(lambda a: a[1] == pid)
                except Exception:
                    pass
                job["status"] = ST_SKIPPED
                job["error"] = "批次已取消（排队中该任务被移除）"
        batch["state"] = BS_CANCELLED
        _save_batch(batch)
        summary = _batch_summary(batch)
    return web.json_response({"ok": True, "summary": summary})


@PromptServer.instance.routes.post("/anima/batch/{batch_id}/skip")
async def batch_skip(request):
    """跳过一条任务：未入队的直接跳过；排队中的从队列删除；运行中的拒绝。"""
    from server import PromptServer
    bid = request.match_info["batch_id"]
    try:
        body = await request.json()
        idx = int(body.get("idx", -1))
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    batch, lk = await _load_and_lock(bid)
    if batch is None:
        return web.json_response({"ok": False, "error": "批次不存在"}, status=404)
    with lk:
        jobs = batch.get("jobs", [])
        if idx < 0 or idx >= len(jobs):
            return web.json_response({"ok": False, "error": f"idx {idx} 越界"}, status=400)
        job = jobs[idx]
        if job.get("status") == ST_RUNNING:
            return web.json_response({"ok": False, "error": "该任务正在执行，无法跳过（可稍后再试）"}, status=409)
        pid = job.get("prompt_id")
        if pid and job.get("status") == ST_QUEUED:
            try:
                PromptServer.instance.prompt_queue.delete_queue_item(lambda a: a[1] == pid)
            except Exception:
                pass
        job["status"] = ST_SKIPPED
        job["error"] = "已跳过"
        await _refresh_batch(batch)
        summary = _batch_summary(batch)
    if batch.get("state") == BS_RUNNING:
        _ensure_batch_worker(bid)
    return web.json_response({"ok": True, "summary": summary})


@PromptServer.instance.routes.post("/anima/batch/{batch_id}/retry")
async def batch_retry(request):
    """重试一条任务（失败/跳过/中断/未执行均可）。"""
    bid = request.match_info["batch_id"]
    try:
        body = await request.json()
        idx = int(body.get("idx", -1))
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    batch, lk = await _load_and_lock(bid)
    if batch is None:
        return web.json_response({"ok": False, "error": "批次不存在"}, status=404)
    with lk:
        jobs = batch.get("jobs", [])
        if idx < 0 or idx >= len(jobs):
            return web.json_response({"ok": False, "error": f"idx {idx} 越界"}, status=400)
        job = jobs[idx]
        if job.get("status") in (ST_QUEUED, ST_RUNNING):
            return web.json_response({"ok": False, "error": "该任务尚在队列/执行中，无需重试"}, status=409)
        job["status"] = ST_RETRY
        job["prompt_id"] = None
        job["error"] = None
        job["outputs"] = []
        if batch.get("state") in (BS_PAUSED, BS_FINISHED, BS_CANCELLED):
            batch["state"] = BS_RUNNING
        await _refresh_batch(batch)
        summary = _batch_summary(batch)
    if batch.get("state") == BS_RUNNING:
        _ensure_batch_worker(bid)
    return web.json_response({"ok": True, "summary": summary})


@PromptServer.instance.routes.get("/anima/batch/{batch_id}/status")
async def batch_status(request):
    bid = request.match_info["batch_id"]
    batch = _load_batch(bid)
    if batch is None:
        return web.json_response({"ok": False, "error": "批次不存在"}, status=404)
    with _batch_lock(bid):
        await _refresh_batch(batch)
        summary = _batch_summary(batch)
        jobs = [_job_summary(j) for j in batch.get("jobs", [])]
    if batch.get("state") == BS_RUNNING:
        _ensure_batch_worker(bid)
    return web.json_response({
        "ok": True,
        "batch": {k: summary[k] for k in ("id", "created", "updated", "state", "node_ref", "total")},
        "summary": summary,
        "jobs": jobs,
    })


@PromptServer.instance.routes.get("/anima/batch/list")
async def batch_list(request):
    """列出批次（按创建时间倒序）。node=<画布节点id> 可选过滤。limit 默认 20。"""
    node_ref = request.query.get("node", "").strip()
    try:
        limit = min(int(request.query.get("limit", "20")), 100)
    except Exception:
        limit = 20
    os.makedirs(BATCH_DIR, exist_ok=True)
    out = []
    try:
        names = [n for n in os.listdir(BATCH_DIR) if n.endswith(".json") and not n.endswith(".tmp.json")]
    except OSError:
        names = []
    for n in sorted(names, reverse=True):
        try:
            with open(os.path.join(BATCH_DIR, n), "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
            continue
        if node_ref and str(data.get("node_ref") or "") != node_ref:
            continue
        out.append(_batch_summary(data))
        if len(out) >= limit:
            break
    return web.json_response({"ok": True, "batches": out})
