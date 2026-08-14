# Anima Trigger Words — 触发词管理节点（与 Anima Batch LoRA Loader 联动）
#
# 输入 lora_syntax（可连线接收 LoRA 节点的输出或手动粘贴 <lora:name:weight>），
# 输出 trigger_words（STRING），供 CLIPTextEncode 等文本节点使用。
# 触发词来源优先级：bridge 里 lora_list 的 trigger_words > 文件名兜底。
# 独立成节点避免 LoRA 节点臃肿。

import os
import json

from .anima_batch_lora import _parse_lora_syntax, BRIDGE_DATA, BRIDGE_LOCK, BRIDGE_PATH


class AnimaTriggerWords:
    NAME = "TK Trigger Words"
    CATEGORY = "TK/loaders"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_syntax": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "<lora:name:weight> <lora:name:weight> ...（可连线接收 LoRA 节点输出）",
                    "tooltip": "LoRA 标签；触发词从这些 LoRA 提取。",
                }),
                "trigger_words": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "手动补充的触发词（可选，会追加到末尾）",
                    "tooltip": "可选：手动追加触发词，与自动提取的合并。",
                }),
                "tw_map": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "卡片触发词 JSON（前端维护，持久化用）",
                    "tooltip": "卡片编辑的触发词 JSON，随工作流保存；刷新/重载后恢复卡片内容。",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("trigger_words",)
    FUNCTION = "collect_trigger_words"
    OUTPUT_NODE = False

    def collect_trigger_words(self, lora_syntax, trigger_words="", tw_map=""):
        entries = _parse_lora_syntax(lora_syntax or "")

        # 从 bridge 数据构建 name -> trigger_words 查找表（面板「发送到 ComfyUI」会带 trigger_words）
        with BRIDGE_LOCK:
            tw_lookup = {
                l.get("name", ""): l.get("trigger_words", [])
                for l in BRIDGE_DATA.get("lora_list", [])
            } if BRIDGE_DATA else {}

        words = []
        for entry in entries:
            tws = tw_lookup.get(entry["name"], [])
            if tws:
                words.extend(tws)
            else:
                words.append(entry["name"])  # 无触发词记录时用文件名兜底

        # 追加手动补充的触发词
        if trigger_words and trigger_words.strip():
            # 支持逗号/空格分隔
            for w in trigger_words.replace("\n", ",").split(","):
                w = w.strip()
                if w:
                    words.append(w)

        # 去重保序
        seen = set()
        unique = []
        for w in words:
            wl = w.strip().lower()
            if wl and wl not in seen:
                seen.add(wl)
                unique.append(w.strip())

        return (", ".join(unique),)


NODE_CLASS_MAPPINGS = {
    AnimaTriggerWords.NAME: AnimaTriggerWords,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TK Trigger Words": "TK 触发词",
}
