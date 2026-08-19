"""Anima/Cosmos empty image latent with a preset-friendly ComfyUI widget."""

import torch
import nodes
import comfy.model_management


class AnimaPresetEmptyLatent:
    """Create a one-frame Cosmos latent for Anima image workflows.

    The output layout intentionally follows ComfyUI's EmptyCosmosLatentVideo:
    ``[batch, channels, frames, height, width]``.  A single frame keeps the
    node focused on image generation while remaining compatible with Anima's
    5D Cosmos latent consumers.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "width": ("INT", {
                    "default": 1024,
                    "min": 16,
                    "max": nodes.MAX_RESOLUTION,
                    "step": 16,
                    "tooltip": "输出图像宽度（像素），必须是 16 的倍数。",
                }),
                "height": ("INT", {
                    "default": 1024,
                    "min": 16,
                    "max": nodes.MAX_RESOLUTION,
                    "step": 16,
                    "tooltip": "输出图像高度（像素），必须是 16 的倍数。",
                }),
                "batch_size": ("INT", {
                    "default": 1,
                    "min": 1,
                    "max": 4096,
                    "tooltip": "一次创建的空 latent 数量。",
                }),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "generate"
    CATEGORY = "TK/latent"
    DESCRIPTION = "为 Anima/Cosmos 图像工作流创建带常用尺寸预设的单帧空 latent。"
    SEARCH_ALIASES = ["anima empty", "empty latent", "blank latent", "preset resolution"]

    def generate(self, width, height, batch_size=1):
        if width % 16 or height % 16:
            raise ValueError("Anima 预设空 Latent 的宽高必须是 16 的倍数。")

        latent = torch.zeros(
            [batch_size, 16, 1, height // 8, width // 8],
            device=comfy.model_management.intermediate_device(),
        )
        return ({"samples": latent},)


NODE_CLASS_MAPPINGS = {
    "AnimaPresetEmptyLatent": AnimaPresetEmptyLatent,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AnimaPresetEmptyLatent": "TK 空Latent 图像",
}
