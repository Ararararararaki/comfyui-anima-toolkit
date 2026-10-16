"""Derived WD14 tags for pictures whose saved positive prompt is absent.

No downloads, image mutation, ComfyUI queue submission or Prompt Agent dependency.
Busy admission returns immediately; the caller owns cancellation and persistence.
"""
import asyncio
import hashlib
import json
import re
import threading

from . import background_budget, local_tagger
from . import output_recognition

_RUNNING = globals().get("_RUNNING", threading.Lock())
_DEFAULT_THRESHOLD = 0.35
_DEFAULT_CHARACTER_THRESHOLD = 0.85


def fallback_catalog(options=None):
    models = local_tagger.available_models()
    versions = [(model, local_tagger.model_fingerprint(model)) for model in models]
    version = hashlib.sha256(json.dumps(versions).encode()).hexdigest()[:20]
    return {"models": models, "defaultModel": models[0] if models else "", "modelVersion": version,
            "libraryMatches": output_recognition.library_match_catalog(),
            "threshold": _DEFAULT_THRESHOLD, "characterThreshold": _DEFAULT_CHARACTER_THRESHOLD}


def fallback_defer_reason():
    """Check before any image I/O and retire cached CPU resources under pressure."""
    reason = background_budget.defer_reason()
    if reason == "memory-pressure":
        local_tagger.release_runtime(wait=False)
    return reason


async def lookup_saved_digest(digest, options):
    """Small content-addressed lookup: no image reads, decoder or model runtime."""
    if not isinstance(options, dict) or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('识别缓存需要有效的图片内容 SHA256 与设置')
    if not options.get('library_matching', True):
        return {'status': 'miss'}
    match = await asyncio.to_thread(output_recognition.lookup_library_digest, digest, options)
    return match or {'status': 'miss'}


async def infer_missing_image(image, options=None):
    reason = fallback_defer_reason()
    if reason:
        return {"status": "deferred", "reason": reason}
    if not _RUNNING.acquire(blocking=False):
        return {"status": "deferred", "reason": "tagger-busy"}
    try:
        options = options or {}
        if not isinstance(options, dict):
            return {"status": "error", "error": "WD14 设置必须是对象"}
        if options.get('library_matching', True):
            match = await asyncio.to_thread(output_recognition.lookup_library_match, image, options)
            if match:
                return match
        catalog = fallback_catalog()
        model = options.get("model") or catalog["defaultModel"]
        if not model or model not in catalog["models"]:
            return {"status": "unavailable", "error": "所选本地 WD14 ONNX+CSV 模型未安装；请在 WD14 Tagger 安装或切换模型"}
        effective = {"threshold": _DEFAULT_THRESHOLD, "character_threshold": _DEFAULT_CHARACTER_THRESHOLD, **options, "model": model, "device": "cpu"}
        try:
            result = await local_tagger.interrogate_wd14(image, effective, wait=False)
        except local_tagger.LocalTaggerBusyError:
            return {"status": "deferred", "reason": "tagger-busy"}
        except local_tagger.LocalTaggerError as error:
            return {"status": "error", "error": str(error)}
        version = hashlib.sha256(json.dumps(["wd14-fallback-v1", local_tagger.model_fingerprint(model),
                                             effective["threshold"], effective["character_threshold"]]).encode()).hexdigest()[:20]
        return {"status": "complete", "tags": result["tags"], "model": model, "version": version}
    finally:
        _RUNNING.release()
