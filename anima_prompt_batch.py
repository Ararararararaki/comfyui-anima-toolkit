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
import re
import json
import math
import folder_paths
from aiohttp import web
from server import PromptServer

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


# ============ 分组解析（忠实复刻 comfy_patch._parse_prompt_groups） ============

_HEADING_RE = re.compile(r'^##\s*(.+)$')
_BRACKET_HEADING_RE = re.compile(r'^【\s*\d{1,3}\s*】')
# 区域参数行：区域: x,y,w,h[,strength]（0~1 比例，随组生效，不计入提示词）
_REGION_RE = re.compile(r'^\s*(?:区域|area)\s*[:：]\s*(.+)$', re.IGNORECASE)
# 背景行：背景: 场景词（Anima 区域模式下作为 KSampler 正向/底衬提示词）
_BG_RE = re.compile(r'^\s*(?:背景|background)\s*[:：]\s*(.+)$', re.IGNORECASE)
# 人物行：人物: 人物词（Anima 区域模式下作为区域提示词）
_PERSON_RE = re.compile(r'^\s*(?:人物|人物词|person|character)\s*[:：]\s*(.+)$', re.IGNORECASE)
# 相机行：相机: 机位描述（自然语言/预设名/px,py,pz,roll，随组生效，不计入提示词）
_CAMERA_RE = re.compile(r'^\s*(?:相机|机位|camera)\s*[:：]\s*(.+)$', re.IGNORECASE)


def _parse_region_value(text: str):
    """'x,y,w,h[,strength]' → (x,y,w,h,strength)。全部为 0~1 比例，strength 默认 1.0。

    非法输入返回 None（该行被忽略，不影响组内容）。
    """
    nums = []
    for part in re.split(r'[,，\s]+', (text or '').strip()):
        if not part:
            continue
        try:
            nums.append(float(part))
        except ValueError:
            return None
    if len(nums) < 4:
        return None
    x, y, w, h = (max(0.0, min(1.0, v)) for v in nums[:4])
    s = nums[4] if len(nums) > 4 else 1.0
    if not math.isfinite(s) or s < 0:
        s = 1.0
    return (x, y, w, h, s)


def _is_digit_heading(line: str) -> bool:
    """数字序号标题判定（收紧版，防内容行误判）。

    1. 标题行不含逗号（内容 tag 行几乎必带逗号）；
    2. 长度 ≤ 24；
    3. 数字+空格后非小写字母开头（防 '3 girls' / '2 people' 内容行）。
    """
    if ',' in line or len(line) > 24:
        return False
    if re.match(r'^\d{1,3}\s*[._、）)]', line):
        return True
    return bool(re.match(r'^\d{1,3}\s+\S', line) and not re.match(r'^\d{1,3}\s+[a-z]', line))


def _is_skip_line(line: str) -> bool:
    return line.startswith(('#', '【', '====', '中文：', 'Anima 底模',
                            '备注：', '说明：', '用法', '优化说明', '-'))


def parse_prompt_groups(path: str) -> list:
    """把提示词文件按标题行解析为多组，返回 [(组名, [提示词...], 区域参数, 背景词, 人物词)]。

    支持三种标题格式：
    - '## 组1 · 标题'（markdown 分段）：段内多行合并为一条完整提示词
    - '【1】正面 · 深插站立'：段内多行合并为一条完整提示词
    - '01 组A'（数字序号标题）：段内每行一条提示词（保持原行）
    无标题行 → 整文件一组（组名=文件名）。

    组内可写（均不计入提示词）：
    - 「区域: x,y,w,h[,强度]」（0~1 比例）作为该组的区域参数
    - 「背景: 场景词」（Anima 区域模式：作为底衬/正向提示词）
    - 「人物: 人物词」（Anima 区域模式：作为区域提示词）
    """
    groups = []
    cur_name = None
    cur = []
    cur_region = None
    cur_bg = []
    cur_person = []
    cur_camera = None
    has_heading = False
    md_mode = False  # 文件是否用了 markdown/【N】 分段（段内合并为一条）

    def _flush():
        """结束当前组：组提示词为空但有背景/人物/区域行时，
        用「人物词 + 背景词」合并作为该组提示词（区域控制停用后仍可正常出图）。"""
        nonlocal cur_name, cur, cur_region, cur_bg, cur_person, cur_camera
        if not (cur or cur_region or cur_bg or cur_person or cur_camera):
            return
        prompts = [' '.join(cur)] if md_mode else cur
        if not prompts or all(not str(p).strip() for p in prompts):
            bg = ' '.join(cur_bg).strip()
            person = ' '.join(cur_person).strip()
            merged = ", ".join(x for x in (person, bg) if x)
            prompts = [merged] if merged else []
        bg = ' '.join(cur_bg).strip() or None
        person = ' '.join(cur_person).strip() or None
        groups.append((cur_name or '组%d' % (len(groups) + 1), prompts, cur_region, bg, person, cur_camera))
        cur = []
        cur_region = None
        cur_bg = []
        cur_person = []
        cur_camera = None

    try:
        with open(path, encoding='utf-8-sig') as f:
            for raw in f:
                line = raw.strip()
                if not line:
                    continue
                rm = _REGION_RE.match(line)
                if rm:
                    rv = _parse_region_value(rm.group(1))
                    if rv is not None:
                        cur_region = rv
                    continue
                bm = _BG_RE.match(line)
                if bm:
                    cur_bg.append(bm.group(1).strip())
                    continue
                pm = _PERSON_RE.match(line)
                if pm:
                    cur_person.append(pm.group(1).strip())
                    continue
                cm = _CAMERA_RE.match(line)
                if cm:
                    cur_camera = cm.group(1).strip()
                    continue
                m = _HEADING_RE.match(line)
                if m:
                    has_heading = True
                    md_mode = True
                    _flush()
                    cur_name = m.group(1).strip() or ('组%d' % (len(groups) + 1))
                    continue
                if _is_digit_heading(line):
                    has_heading = True
                    _flush()
                    cur_name = line
                    continue
                if _BRACKET_HEADING_RE.match(line):
                    has_heading = True
                    md_mode = True
                    _flush()
                    cur_name = line
                    continue
                if _is_skip_line(line):
                    continue
                cur.append(line)
    except Exception:
        return []
    if not has_heading:
        if cur or cur_region or cur_bg or cur_person or cur_camera:
            if cur:
                prompts = cur
            else:
                bg = ' '.join(cur_bg).strip()
                person = ' '.join(cur_person).strip()
                merged = ", ".join(x for x in (person, bg) if x)
                prompts = [merged] if merged else []
            groups = [(os.path.splitext(os.path.basename(path))[0], [p for p in prompts if p],
                       cur_region, ' '.join(cur_bg).strip() or None, ' '.join(cur_person).strip() or None,
                       cur_camera)]
    else:
        _flush()
    return groups


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
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("preview_prompt",)
    FUNCTION = "execute"
    DESCRIPTION = "批量提示词注入：读取提示词文件分组，队列时展开为多组顺序生成（注入目标任意选择，适配所有工作流）；组内可写「区域: x,y,w,h,强度」自动锁定人物在画面区域"

    def execute(self, prompt_files, positive_target, negative_target,
                camera_target, output_subfolder, groups_selection, region_values,
                camera_values=""):
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
            for gname, prompts, _region, _bg, _person, _camera in parse_prompt_groups(path):
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

@PromptServer.instance.routes.get("/anima/prompt/list")
async def prompt_list(request):
    """列出指定目录下的 .txt 提示词文件与子目录（可导航浏览器）。

    参数：dir=<相对 input/ 的目录，或任意绝对路径>。默认空=input/ 根。
    返回 {dir, abs_dir, parent, dirs:[], files:[]}：dir=展示用相对路径，abs_dir=绝对路径，
    parent=上级目录（相对路径或绝对路径，根时为 "."）。
    """
    raw = (request.query.get("dir") or "").strip()
    base = os.path.normpath(_input_root())
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
            elif os.path.isfile(full) and name.lower().endswith((".txt", ".md", ".prompt")):
                entries.append((name, os.path.getmtime(full)))
        # 文件按修改时间降序（最新在前）——前端「最新」按钮直接取 files[0]
        entries.sort(key=lambda e: e[1], reverse=True)
        files = [n for n, _ in entries]
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
                    "camera": cam}
                   for n, p, r, bg, person, cam in groups],
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
