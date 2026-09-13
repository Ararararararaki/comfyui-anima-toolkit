# -*- coding: utf-8 -*-
"""qwen-plus vs qwen-turbo 分类质量对比（新准则+few-shot 提示词，含困难样本）。"""
import json, urllib.request

def get_env(name):
    import os, winreg
    v = os.environ.get(name)
    if v: return v
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            v, _ = winreg.QueryValueEx(k, name)
        return str(v) if v else None
    except Exception:
        return None

KEY = get_env("DASHSCOPE_API_KEY")
BASE = (get_env("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")

cats = ["通用", "角色", "画风", "姿势", "场景", "质量词", "LoRA 触发词", "服饰"]
cat_labels = ['通用', '角色（动漫角色名/人名/角色昵称）', '画风（风格/画师/渲染方式/画质风格）',
              '姿势（动作/姿态/体位/肢体）', '场景（环境/背景/地点/道具）', '质量词（品质评分词：masterpiece、best quality、highres、score 等）',
              'LoRA 触发词（LoRA/模型的触发词）', '服饰（服装/穿着/配饰）']
cards = [
    ("1", "white dress, frills"),
    ("2", "masterpiece, best quality, highres"),
    ("3", "skadi (arknights)"),
    ("4", "standing, looking at viewer"),
    ("5", "classroom, window, rain"),
    ("6", "1girl"),
    ("7", "aqua eyes"),
    ("8", "cinematic lighting"),
    ("9", "pranara"),
    ("10", "legs crossed, sitting on chair"),
]
lines = [f"{i}: {t}" for i, t in cards]

system = (
    "你是提示词标签分类助手。把每个提示词标签（卡片）归入最合适的分类。\n"
    "分类准则：\n"
    "1. 角色名/动漫角色/人名 → 角色类\n"
    "2. 画风/风格/画师/渲染方式 → 画风类\n"
    "3. 服装/服饰/穿着 → 服饰类（如有）\n"
    "4. 动作/姿势/姿态/体位 → 姿势类\n"
    "5. 场景/环境/背景/地点/道具 → 场景类\n"
    "6. 品质/评分词（masterpiece、best quality、highres 等）→ 质量词类\n"
    "7. LoRA/模型触发词 → LoRA 触发词类（如有）\n"
    "8. 无法明确归类或列表中没有合适项 → 通用类\n"
    "歧义标签选择最可能的分类；宁选「通用」也不硬塞错误分类。\n"
    "只输出 JSON 数组：每个元素是「分类列表」中的名称之一，与输入行一一对应。不要输出任何解释、编号或多余文本。"
)
user = (
    f"分类列表：{json.dumps(cat_labels, ensure_ascii=False)}\n\n"
    "示例（演示归类逻辑，分类名可能与你的列表不同）：\n"
    '输入卡片：\n1: skadi (arknights)\n2: masterpiece, best quality\n3: sitting on a chair, legs crossed\n'
    '输出：["角色", "质量词", "姿势"]\n\n'
    "待分类卡片（行号: 内容）：\n" + "\n".join(lines)
)

for model in ("qwen-turbo", "qwen-plus"):
    payload = {"model": model, "messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ], "temperature": 0.1, "max_tokens": 200}
    req = urllib.request.Request(BASE + "/chat/completions",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read())
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        print(f"=== {model} ===")
        print(content.strip())
    except Exception as e:
        print(f"{model} FAIL: {e}")
    print()