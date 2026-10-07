# Anima Prompt Batch — 纯解析模块（零 ComfyUI 依赖，可独立单测）
#
# 只负责把提示词文件解析为分组，不依赖 folder_paths / server / aiohttp。
# anima_prompt_batch.py 通过 `from anima_prompt_parser import parse_prompt_groups` 使用。

import os
import re
import math

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
# 负向行：负向: 负面提示词（随组生效，可多行累加，不计入正向提示词）
_NEG_RE = re.compile(r'^\s*(?:负向|负面|negative)\s*[:：]\s*(.+)$', re.IGNORECASE)


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
    """把提示词文件按标题行解析为多组，返回 [(组名, [提示词...], 区域参数, 背景词, 人物词, 相机词, 负向词)]。

    支持三种标题格式：
    - '## 组1 · 标题'（markdown 分段）：段内多行合并为一条完整提示词
    - '【1】正面 · 深插站立'：段内多行合并为一条完整提示词
    - '01 组A'（数字序号标题）：段内每行一条提示词（保持原行）
    无标题行 → 整文件一组（组名=文件名）。

    组内可写（均不计入正向提示词）：
    - 「区域: x,y,w,h[,强度]」（0~1 比例）作为该组的区域参数
    - 「背景: 场景词」（Anima 区域模式：作为底衬/正向提示词）
    - 「人物: 人物词」（Anima 区域模式：作为区域提示词）
    - 「相机: 机位描述」（自然语言/预设名/px,py,pz,roll）
    - 「负向: 负面提示词」（可多行累加，队列时注入负向目标节点）
    """
    groups = []
    cur_name = None
    cur = []
    cur_region = None
    cur_bg = []
    cur_person = []
    cur_camera = None
    cur_neg = []
    has_heading = False
    md_mode = False  # 文件是否用了 markdown/【N】 分段（段内合并为一条）

    def _flush():
        """结束当前组：组提示词为空但有背景/人物/区域行时，
        用「人物词 + 背景词」合并作为该组提示词（区域控制停用后仍可正常出图）。"""
        nonlocal cur_name, cur, cur_region, cur_bg, cur_person, cur_camera, cur_neg
        if not (cur or cur_region or cur_bg or cur_person or cur_camera or cur_neg):
            return
        prompts = [' '.join(cur)] if md_mode else cur
        if not prompts or all(not str(p).strip() for p in prompts):
            bg = ' '.join(cur_bg).strip()
            person = ' '.join(cur_person).strip()
            merged = ", ".join(x for x in (person, bg) if x)
            prompts = [merged] if merged else []
        bg = ' '.join(cur_bg).strip() or None
        person = ' '.join(cur_person).strip() or None
        neg = ' '.join(cur_neg).strip() or None
        groups.append((cur_name or '组%d' % (len(groups) + 1), prompts, cur_region, bg, person, cur_camera, neg))
        cur = []
        cur_region = None
        cur_bg = []
        cur_person = []
        cur_camera = None
        cur_neg = []

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
                nm = _NEG_RE.match(line)
                if nm:
                    cur_neg.append(nm.group(1).strip())
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
        if cur or cur_region or cur_bg or cur_person or cur_camera or cur_neg:
            if cur:
                prompts = cur
            else:
                bg = ' '.join(cur_bg).strip()
                person = ' '.join(cur_person).strip()
                merged = ", ".join(x for x in (person, bg) if x)
                prompts = [merged] if merged else []
            groups = [(os.path.splitext(os.path.basename(path))[0], [p for p in prompts if p],
                       cur_region, ' '.join(cur_bg).strip() or None, ' '.join(cur_person).strip() or None,
                       cur_camera, ' '.join(cur_neg).strip() or None)]
    else:
        _flush()
    return groups


__all__ = ['parse_prompt_groups', '_parse_region_value', '_is_digit_heading', '_is_skip_line']
