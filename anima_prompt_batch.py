# Anima Prompt Batch — 批量提示词注入（控制器节点 + 文件 API）
#
# 后端职责：
#   1. 提示词文件分组解析（parse_prompt_groups）：忠实复刻桌面「批生图」的三种标题格式
#      （## 组N markdown 分段 / 【N】标题 / NN 数字序号标题 + 整文件兜底）
#   2. HTTP API：/anima/prompt/list（列文件）、/anima/prompt/parse（解析分组）、
#      /anima/prompt/read（读原文）
#
# 真正的「顺序生成一批多组图片」由前端 widget（anima_prompt_batch_widget.js）
# 在队列时展开完成：读本节点配置 → 逐组逐条注入目标文本节点 → 依次入队。
# 本节点是「配置载体」，其 STRING 输出仅返回第一条提示词供预览/调试（可选接线）。

import os
import json
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
