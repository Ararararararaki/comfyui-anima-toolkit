"""CPU-first WD14 inference using installed models, without model downloads.

Image preprocessing follows ComfyUI-WD14-Tagger by pythongosssss:
https://github.com/pythongosssss/ComfyUI-WD14-Tagger

MIT License
Copyright (c) 2024 pythongosssss
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
from __future__ import annotations

import asyncio
import csv
import io
import math
import os
import sys
import threading
from pathlib import Path

from contextlib import contextmanager
import hashlib
import json

class LocalTaggerError(ValueError):
    """Local installed tagger failed; safe to display to its caller."""

class LocalTaggerBusyError(LocalTaggerError):
    """A speculative caller must defer without waiting for an in-flight inference."""


_DEFAULT_MODEL = "wd-v1-4-moat-tagger-v2"
_INFERENCE_LOCK = globals().get("_INFERENCE_LOCK", threading.Lock())
_CACHE: tuple | None = globals().get("_CACHE")


def _model_directories() -> list[Path]:
    """Find the same cache as an installed tagger, without importing its plugin."""
    directories = []
    try:
        import folder_paths
        if "wd14_tagger" in folder_paths.folder_names_and_paths:
            directories.extend(Path(value) for value in folder_paths.get_folder_paths("wd14_tagger"))
        directories.append(Path(folder_paths.models_dir) / "wd14_tagger")
        directories.extend(Path(value) / "ComfyUI-WD14-Tagger" / "models"
                           for value in folder_paths.get_folder_paths("custom_nodes"))
    except (ImportError, AttributeError, KeyError, TypeError):
        pass
    for module in tuple(sys.modules.values()):
        values = getattr(module, "__dict__", {})
        filename = values.get("__file__", "")
        if isinstance(filename, str) and Path(filename).name == "wd14tagger.py":
            value = values.get("models_dir")
            if isinstance(value, (str, os.PathLike)):
                directories.append(Path(value))
    return list(dict.fromkeys(directories))


def _model_files() -> dict[str, tuple[Path, Path]]:
    result = {}
    for directory in _model_directories():
        for model in sorted(directory.glob("*.onnx")):
            tags = model.with_suffix(".csv")
            if tags.is_file():
                result.setdefault(model.stem, (model, tags))
    return result


def available_models() -> list[str]:
    """Only complete, installed ONNX/CSV pairs are selectable."""
    models = sorted(_model_files())
    if _DEFAULT_MODEL in models:
        models.remove(_DEFAULT_MODEL)
        models.insert(0, _DEFAULT_MODEL)
    return models


def _threshold(value: object, name: str, default: float) -> float:
    if value in (None, ""):
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise LocalTaggerError(f"WD14 {name} 必须是 0 到 1 之间的数值。")
    return float(value)


def _load_runtime(model: Path, tags: Path, device: str):
    global _CACHE
    key = (str(model), model.stat().st_mtime_ns, tags.stat().st_mtime_ns, device)
    if _CACHE is not None and _CACHE[0] == key:
        return _CACHE[1], _CACHE[2]
    try:
        import onnxruntime as ort
    except ImportError:
        raise LocalTaggerError("本地 WD14 需要已安装的 onnxruntime；可使用现有 WD14 Tagger 的运行环境。") from None
    if device == "cuda" and "CUDAExecutionProvider" not in ort.get_available_providers():
        raise LocalTaggerError("当前 onnxruntime 没有 CUDA provider；请使用 CPU。")
    options = ort.SessionOptions()
    options.intra_op_num_threads = min(4, os.cpu_count() or 1)
    options.inter_op_num_threads = 1
    providers = ["CPUExecutionProvider"] if device == "cpu" else ["CUDAExecutionProvider", "CPUExecutionProvider"]
    session = ort.InferenceSession(str(model), sess_options=options, providers=providers)
    with tags.open("r", encoding="utf-8-sig", newline="") as file:
        rows = [(row["name"], row["category"]) for row in csv.DictReader(file)]
    if not rows:
        raise LocalTaggerError("WD14 标签 CSV 为空。")
    # Keep only the current model; selecting a different model releases the old session.
    _CACHE = (key, session, rows)
    return session, rows


def _prepare_image(image: bytes, height: int, dtype):
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(image)) as opened:
            opened = ImageOps.exif_transpose(opened).convert("RGBA")
            background = Image.new("RGBA", opened.size, "white")
            background.alpha_composite(opened)
            picture = background.convert("RGB")
    except (OSError, ValueError, UnidentifiedImageError):
        raise LocalTaggerError("WD14 无法读取这张图片。") from None
    ratio = height / max(picture.size)
    size = tuple(max(1, round(value * ratio)) for value in picture.size)
    picture = picture.resize(size, Image.Resampling.LANCZOS)
    square = Image.new("RGB", (height, height), "white")
    square.paste(picture, ((height - size[0]) // 2, (height - size[1]) // 2))
    array = np.asarray(square, dtype=dtype)[:, :, ::-1]  # ONNX taggers expect BGR, 0..255.
    return np.expand_dims(array, 0)


def _interrogate(image: bytes, options: dict, wait=True) -> dict:
    import numpy as np
    models = _model_files()
    if not models:
        raise LocalTaggerError("没有已安装的 WD14 ONNX+CSV 模型；请先在 WD14 Tagger 中安装一个模型。")
    selected = options.get("model") or (_DEFAULT_MODEL if _DEFAULT_MODEL in models else sorted(models)[0])
    if not isinstance(selected, str):
        raise LocalTaggerError("WD14 model 必须是已安装的模型名称。")
    selected = selected.removesuffix(".onnx")
    if selected not in models:
        raise LocalTaggerError("所选 WD14 模型尚未安装；本节点不会自动下载。")
    device = options.get("device") or "cpu"
    if device not in ("cpu", "cuda"):
        raise LocalTaggerError("WD14 device 请选择 cpu 或 cuda。")
    threshold = _threshold(options.get("threshold"), "threshold", 0.35)
    character_threshold = _threshold(options.get("character_threshold"), "character_threshold", 0.85)
    exclude = options.get("exclude_tags") or []
    if isinstance(exclude, str):
        exclude = exclude.split(",")
    if not isinstance(exclude, list) or any(not isinstance(tag, str) for tag in exclude):
        raise LocalTaggerError("WD14 exclude_tags 必须是标签列表或逗号分隔字符串。")
    excluded = {tag.strip().lower().replace(" ", "_") for tag in exclude}
    with _admission(wait):
        try:
            session, rows = _load_runtime(*models[selected], device)
            input_info = session.get_inputs()[0]
            height = input_info.shape[1]
            if not isinstance(height, int) or height <= 0:
                raise LocalTaggerError("WD14 模型的图片输入尺寸不受支持。")
            tensor = _prepare_image(image, height, np.float16 if input_info.type == "tensor(float16)" else np.float32)
            probabilities = session.run([session.get_outputs()[0].name], {input_info.name: tensor})[0][0]
            if len(probabilities) != len(rows):
                raise LocalTaggerError("WD14 ONNX 与标签 CSV 不匹配。")
        except LocalTaggerError:
            raise
        except (ImportError, OSError, KeyError, ValueError, RuntimeError) as error:
            raise LocalTaggerError(f"WD14 本地推理失败：{str(error)[:180]}") from None
    general, characters, rating = [], [], {}
    scores = {}
    for (name, category), probability in zip(rows, probabilities):
        score = float(probability)
        if category == "9":
            rating[name] = score
        elif category in {"0", "4"} and name.lower() not in excluded:
            cutoff = character_threshold if category == "4" else threshold
            if score > cutoff:
                (characters if category == "4" else general).append(name)
                scores[name] = score
    return {"source": "local-wd14", "tags": characters + general, "caption": "", "scores": scores,
            "categories": {"general": general, "character": characters, "rating": rating}}


async def interrogate_wd14(image: bytes, options: dict, *, wait=True) -> dict:
    """Run a single CPU-first inference away from ComfyUI's event loop."""
    if not isinstance(image, bytes) or not image:
        raise LocalTaggerError("WD14 需要图片数据。")
    if not isinstance(options, dict):
        raise LocalTaggerError("WD14 options 必须是对象。")
    return await asyncio.to_thread(_interrogate, image, options, wait)


@contextmanager
def _admission(wait=True):
    if not _INFERENCE_LOCK.acquire(blocking=wait):
        raise LocalTaggerBusyError("WD14 正在处理其他图片")
    try:
        yield
    finally:
        _INFERENCE_LOCK.release()


def release_runtime(wait=True):
    """Drain a borrowed inference before releasing the current cached session."""
    global _CACHE
    if not _INFERENCE_LOCK.acquire(blocking=wait):
        return False
    try:
        _CACHE = None
        return True
    finally:
        _INFERENCE_LOCK.release()


def model_fingerprint(name):
    pair = _model_files().get(name)
    if pair is None:
        return ""
    values = [(path.name, path.stat().st_mtime_ns, path.stat().st_size) for path in pair]
    return hashlib.sha256(json.dumps(["wd14-local-v1", values], separators=(",", ":")).encode()).hexdigest()[:20]


def install_resources(app):
    """One cleanup hook; whole-package replacement drains the previous session."""
    key = "tk.toolkit.local-tagger"
    slot = app.get(key)
    if slot is not None:
        previous = slot["owner"]
        if previous is not None and previous.__globals__ is not globals():
            loop = slot.get("loop") or getattr(app, "_loop", None)
            if loop is not None and loop.is_running():
                slot["retiring"].append(asyncio.run_coroutine_threadsafe(asyncio.to_thread(previous), loop))
            else:
                slot["pending"].append(previous)
        slot["owner"] = release_runtime
        return
    slot = {"owner": release_runtime, "loop": None, "pending": [], "retiring": []}
    async def startup(_app):
        slot["loop"] = asyncio.get_running_loop()
    async def cleanup(_app):
        if slot["owner"] is not None:
            await asyncio.to_thread(slot["owner"])
        for pending in slot["pending"]:
            await asyncio.to_thread(pending)
        if slot["retiring"]:
            await asyncio.gather(*(asyncio.shield(asyncio.wrap_future(item)) for item in slot["retiring"]))
        slot["owner"] = None
        slot["pending"].clear(); slot["retiring"].clear()
    app[key] = slot
    if not getattr(app.on_startup, "frozen", False):
        app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
