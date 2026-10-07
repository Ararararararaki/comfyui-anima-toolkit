# Anima Text Join — 文本合并节点
# 把多个 STRING 输入按顺序拼接（逗号分隔），用于把相机词 + 触发词 + 底 prompt
# 合并成一条喂给 CLIPTextEncode，不依赖 Impact Pack 等第三方 String 节点。

class AnimaTextJoin:
    NAME = "TK Text Join"
    CATEGORY = "TK/text"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text_a": ("STRING", {"default": "", "multiline": True, "placeholder": "文本 A"}),
                "separator": (["逗号 ,", "空格", "换行", "无"], {"default": "逗号 ,"}),
            },
            "optional": {
                "text_b": ("STRING", {"default": "", "multiline": True, "placeholder": "文本 B（可选）"}),
                "text_c": ("STRING", {"default": "", "multiline": True, "placeholder": "文本 C（可选）"}),
                "text_d": ("STRING", {"default": "", "multiline": True, "placeholder": "文本 D（可选）"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "join"
    DESCRIPTION = "合并多条文本（逗号/空格/换行分隔），供 CLIPTextEncode 使用"

    _SEPS = {"逗号 ,": ", ", "空格": " ", "换行": "\n", "无": ""}

    def join(self, text_a, separator, text_b="", text_c="", text_d=""):
        sep = self._SEPS.get(separator, ", ")
        parts = []
        for t in (text_a, text_b, text_c, text_d):
            t = (t or "").strip()
            if t:
                parts.append(t)
        # 逗号模式下：清理连续逗号与首尾逗号，保证拼接后 prompt 干净
        result = sep.join(parts)
        if separator == "逗号 ,":
            import re
            result = re.sub(r'\s*,\s*,+', ',', result).strip(' ,')
        return (result,)


NODE_CLASS_MAPPINGS = {
    AnimaTextJoin.NAME: AnimaTextJoin,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    AnimaTextJoin.NAME: "TK 文本合并",
}
