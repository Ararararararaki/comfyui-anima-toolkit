"""Serializable visual MOSS layout; no external Formatter or MCP dependency."""
import json

from .services.prompt_agent.errors import AgentError
from .services.prompt_agent.layout import prepare_layout
from .services.prompt_agent.moss import compile_expansion_prompt, normalize_layout_draft


class TkMossLayoutEditor:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "layout_state": ("STRING", {"default": json.dumps({"version": 1, "width": 1024, "height": 1024,
                "summary": "", "items": [], "strict_validation": True}), "dynamicPrompts": False}),
            "llm_expand": ("BOOLEAN", {"default": True, "label_on": "Agent 扩写描述", "label_off": "直接编译，不调用模型"}),
        }, "hidden": {"unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ("MOSS_LAYOUT", "INT", "INT", "STRING")
    RETURN_NAMES = ("layout", "width", "height", "prompt")
    FUNCTION = "build_layout"
    CATEGORY = "TK/prompt"
    DESCRIPTION = "绘制人物、物体与文字区域；layout 接 TK Prompt Agent，宽高接生图尺寸。prompt 为不经 LLM 的直接编译结果。"

    def build_layout(self, layout_state, llm_expand=True, unique_id=None):
        try:
            state = json.loads(layout_state)
        except (TypeError, ValueError) as error:
            raise AgentError("布局状态不是有效 JSON；原始状态仍保留。") from error
        if not isinstance(state, dict) or type(state.get("version")) is not int or state["version"] != 1:
            raise AgentError("不支持的布局状态版本。")
        if isinstance(state.get("draft"), dict):
            source = state["draft"]
        else:
            source = {"width": state.get("width"), "height": state.get("height"),
            "summary": {"caption": state.get("summary")}, "items": state.get("items"),
            "bbox_coord_space": "abs", "bbox_format": "xyxy"}
        draft = prepare_layout({"draft": source})
        prompt = compile_expansion_prompt(normalize_layout_draft(draft), "Layout")
        return ({"draft": draft, "llm_expand": bool(llm_expand), "strict_validation": True,
                 "overlay": state.get("studio", {}).get("overlay", {}),
                 "box_colors": [row.get("boxColor", "") for row in state.get("studio", {}).get("elements", [])],
                 "editor_node": str(unique_id) if unique_id is not None else ""}, draft["width"], draft["height"], prompt)


class TkMossLayoutPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "layout": ("MOSS_LAYOUT",)}}

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "MASK", "INT", "INT", "BOUNDING_BOX")
    RETURN_NAMES = ("images", "region_mask", "overlay", "overlay_alpha", "width", "height", "bboxes")
    FUNCTION = "preview"
    CATEGORY = "TK/prompt"
    OUTPUT_NODE = True
    DESCRIPTION = "原图直通；预览仅叠加显示区域框。layout 接原布局节点，图像接 VAE Decode。MASK 为所有矩形区域的并集。"

    def preview(self, images, layout):
        import numpy as np
        import torch
        from nodes import PreviewImage
        from server import PromptServer
        from .services.prompt_agent.layout_overlay import items_from_draft, render_overlay, bboxes_from_items, hex_to_rgb, BOX_PALETTE
        draft = prepare_layout(layout)
        # PreviewImage writes temporary thumbnails without changing the IMAGE output.
        result = PreviewImage().save_images(images)
        descriptors = result.get("ui", {}).get("images", [])
        PromptServer.instance.send_sync("tk-moss-layout-preview", {
            "editor_node": layout.get("editor_node", ""), "draft": draft, "images": descriptors})
        height, width = images.shape[1:3]
        mask = np.zeros((height, width), dtype=np.float32)
        for item in draft["items"]:
            x1, y1, x2, y2 = item["bbox"]
            a, b = int(x1 * width / draft["width"]), int(y1 * height / draft["height"])
            c, d = int(np.ceil(x2 * width / draft["width"])), int(np.ceil(y2 * height / draft["height"]))
            mask[b:d, a:c] = 1
        colors = {i: hex_to_rgb(value, BOX_PALETTE[i % len(BOX_PALETTE)]) for i, value in enumerate(layout.get("box_colors", []))}
        items = items_from_draft(draft, box_colors=colors)
        settings = layout.get("overlay") or {}
        def number(name, fallback, low, high, integer=False):
            value = settings.get(name, fallback)
            if not isinstance(value, (int, float)) or not np.isfinite(value):
                value = fallback
            return int(max(low, min(high, value))) if integer else max(low, min(high, value))
        overlay, alpha = render_overlay(items, width, height,
            line_width=number("lineWidth", 3, 1, 40, True),
            fill_alpha=number("fillAlpha", .18, 0, 1),
            label_size=number("labelSize", 16, 6, 96, True),
            show_index=settings.get("showIndex", True) is not False,
            show_text=settings.get("showText", True) is not False)
        return {"ui": {"images": descriptors}, "result": (images, torch.from_numpy(mask).unsqueeze(0),
            overlay, alpha, width, height, bboxes_from_items(items, width, height))}


NODE_CLASS_MAPPINGS = {"TkMossLayoutEditor": TkMossLayoutEditor, "TkMossLayoutPreview": TkMossLayoutPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"TkMossLayoutEditor": "TK MOSS Layout Editor", "TkMossLayoutPreview": "TK MOSS Layout Preview"}
