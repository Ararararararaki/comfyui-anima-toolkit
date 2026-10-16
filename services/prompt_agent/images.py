"""Convert ComfyUI images to a single RGB upload without embedded metadata."""
from __future__ import annotations

import io
from pathlib import Path

from .errors import AgentError


def uploaded_image_path(descriptor: dict) -> Path:
    if not isinstance(descriptor, dict):
        raise AgentError("请选择或上传图片")
    import folder_paths
    kind = descriptor.get("type", "input")
    getters = {"input": folder_paths.get_input_directory, "output": folder_paths.get_output_directory,
               "temp": folder_paths.get_temp_directory}
    if kind not in getters:
        raise AgentError("图片目录类型无效")
    filename, subfolder = descriptor.get("filename", ""), descriptor.get("subfolder", "")
    if not isinstance(filename, str) or not filename or not isinstance(subfolder, str):
        raise AgentError("图片路径无效")
    root = Path(getters[kind]()).resolve()
    path = (root / subfolder / filename).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise AgentError("图片不存在或不在 ComfyUI 图片目录中")
    return path


def prepare_image(descriptor: dict | None = None, tensor=None) -> bytes:
    from PIL import Image, ImageOps
    if tensor is not None:
        import numpy as np
        values = tensor.detach().cpu().numpy() if hasattr(tensor, "detach") else np.asarray(tensor)
        if values.ndim != 4 or values.shape[0] != 1 or values.shape[-1] not in (3, 4):
            raise AgentError("反推每次接收一张 IMAGE，请先从批次中选出单张")
        image = Image.fromarray(np.clip(values[0] * 255, 0, 255).astype(np.uint8))
    else:
        path = uploaded_image_path(descriptor)
        if path.stat().st_size > 20 * 1024 * 1024:
            raise AgentError("请使用小于 20MB 的图片")
        try:
            with Image.open(path) as source:
                image = ImageOps.exif_transpose(source).copy()
        except (OSError, ValueError) as error:
            raise AgentError("无法读取图片") from error
    # All four first-party adapters accept a modest RGB image; no source metadata leaves the host.
    if image.mode in ("RGBA", "LA", "P"):
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, "white")
        background.alpha_composite(rgba)
        image = background.convert("RGB")
    else:
        image = image.convert("RGB")
    image.thumbnail((1024, 1024))
    image.info.clear()
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
