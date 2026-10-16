"""Pure, evidence-based adapters for saved non-ComfyUI generation fields.

Container keys and generator signatures are based on official A1111 infotext,
Fooocus 2.5.5 meta_parser, NovelAI's MIT metadata verifier (3428907a), and
InvokeAI CoreMetadataInvocation/ModelIdentifierField. No generator code is
executed or imported. Raw metadata remains the caller's lossless record.
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from decimal import Decimal

_NODE_ID = "saved-parameters"
_LABELS = {"a1111": "A1111", "fooocus": "Fooocus", "novelai": "NovelAI", "invokeai": "InvokeAI"}
_A1111_FIELDS = {"Model": "model", "VAE": "vae", "Seed": "seed", "Steps": "steps",
                 "CFG scale": "cfg", "Sampler": "sampler", "Schedule type": "scheduler",
                 "Scheduler": "scheduler", "Denoising strength": "denoise", "Noise seed": "noiseSeed"}
_LORA_TAG = re.compile(r"<lora:([^:>]+)(?::([^>]*))?>", re.IGNORECASE)
_MAX_SAFE_INTEGER = 9007199254740991
_A1111_ROW_KEYS = set(_A1111_FIELDS) | {
    "Size", "Clip skip", "Model hash", "VAE hash", "Lora hashes", "Lora weights", "Version",
    "Hires steps", "Hires upscale steps", "Hires sampler", "Hires schedule type", "Hires CFG Scale",
    "Hires CFG scale", "Hires prompt", "Hires negative prompt", "Hires upscale", "Hires upscaler",
    "Hires resize", "Refiner", "Refiner switch at", "RNG", "ENSD", "Eta", "Variation seed",
    "Variation seed strength", "Seed resize from", "Face restoration",
}


def _json_number(token):
    number = float(token)
    return token if not math.isfinite(number) or number.is_integer() and abs(number) > _MAX_SAFE_INTEGER else number


def _json_integer(token):
    digits = token.lstrip("-")
    return token if len(digits) > 16 or len(digits) == 16 and digits > str(_MAX_SAFE_INTEGER) else int(token)


def _reject_constant(_):
    raise ValueError("non-finite JSON requires an explicit caller policy")


def _json(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        decoded = json.loads(value, parse_constant=_reject_constant, parse_int=_json_integer, parse_float=_json_number)
        return decoded if isinstance(decoded, dict) else None
    except (ValueError, TypeError, RecursionError):
        return None


def _scalar(value):
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float):
            if not math.isfinite(value):
                return ""
            if value.is_integer():
                return str(int(value))
            rendered = str(value)
            if "e" in rendered:
                mantissa, exponent_text = rendered.split("e")
                exponent = int(exponent_text)
                # Match Number#toString's decimal/exponent display boundary.
                return format(Decimal(rendered), "f") if -6 <= exponent < 21 else f"{mantissa}e{exponent:+d}"
            return rendered
        return str(value)
    return ""


def _text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(part, str) for part in value):
        return "\n".join(value)
    return ""


def _name(value):
    if isinstance(value, dict):
        for key in ("name", "model_name", "filename"):
            if isinstance(value.get(key), str) and value[key]:
                return value[key]
        return ""
    return _scalar(value)


def _weight(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str) and not re.fullmatch(r"\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*", value):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _pick(data, *keys):
    for key in keys:
        if key in data and data[key] is not None:
            return data[key]
    return None


def _is_fooocus(data):
    if not isinstance(data, dict):
        return False
    has_prompt = any(isinstance(data.get(key), (str, list)) for key in ("prompt", "full_prompt", "Prompt"))
    product = _scalar(_pick(data, "version", "Version", "Software")).lower()
    return has_prompt and ("base_model" in data or "Base Model" in data or "fooocus" in product)


def _legacy_fooocus(value):
    """Retain this project's existing explicit fooocus_params text contract.

    This is not a guess about arbitrary captions or official Fooocus JSON.
    Only known labels in this exact envelope are fields; other lines can be
    continuations of its explicitly labeled positive/negative prompt.
    """
    if not isinstance(value, str):
        return None
    labels = {"Prompt": "prompt", "Negative": "negative_prompt", "Negative prompt": "negative_prompt",
              "Model": "base_model", "Seed": "seed", "Steps": "steps", "CFG": "guidance_scale",
              "Sampler": "sampler", "Scheduler": "scheduler", "VAE": "vae", "Clip skip": "clip_skip",
              "Denoising strength": "denoise", "Noise seed": "noise_seed"}
    data, current = {}, None
    for line in value.replace("\r\n", "\n").split("\n"):
        label, separator, body = line.partition(":")
        target = labels.get(label) if separator else None
        if target:
            data[target] = body.strip()
            current = target if target in ("prompt", "negative_prompt") else None
        elif current:
            data[current] += "\n" + line
    if "prompt" not in data or not any(key in data for key in ("base_model", "seed", "steps", "guidance_scale", "sampler", "vae")):
        return None
    data["version"] = "legacy-fooocus"
    return data


def _nai_comment(data):
    for _ in range(4):
        if not isinstance(data, dict):
            return None
        if "Comment" not in data:
            return data
        data = _json(data["Comment"])
    return None


def _is_nai(data, raw):
    if not isinstance(data, dict):
        return False
    product = " ".join(_scalar(raw.get(key)) for key in ("Software", "Source")).lower()
    has_config = "sampler" in data and any(key in data for key in ("steps", "scale", "seed"))
    signature = all(key in data for key in ("uc", "sampler", "scale", "seed"))
    return has_config and ("novelai" in product or signature)


def _is_invoke(data):
    return isinstance(data, dict) and any(key in data for key in (
        "positive_prompt", "negative_prompt", "positive_conditioning", "negative_conditioning",
        "generation_mode", "cfg_scale", "model", "scheduler"))


def _is_comfy(value):
    if not isinstance(value, dict):
        return False
    if isinstance(value.get("nodes"), list):
        return True
    return bool(value) and all(isinstance(node, dict) and isinstance(node.get("class_type"), str)
                               and isinstance(node.get("inputs"), dict) for node in value.values())


def _parameter_pairs(line, strict=False):
    """Split an infotext parameter row at unquoted key boundaries."""
    pairs, start, quoted, escaped = [], 0, False, False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
        elif char == "\\" and quoted:
            escaped = True
        elif char == '"':
            quoted = not quoted
        elif char == "," and not quoted:
            pairs.append(line[start:index])
            start = index + 1
    if quoted:
        return None
    pairs.append(line[start:])
    result = {}
    for part in pairs:
        key, separator, value = part.partition(":")
        if not separator:
            if strict and part.strip():
                return None
            continue
        key, value = key.strip(), value.strip()
        if value.startswith('"'):
            try:
                value = json.loads(value)
            except ValueError:
                return None
            if not isinstance(value, str):
                return None
        result[key] = value
    return result


def _a1111(value):
    if not isinstance(value, str):
        return None
    lines = value.replace("\r\n", "\n").strip().split("\n")
    parameters = _parameter_pairs(lines[-1])
    parameter_start = len(lines) - 1
    def confirmed(pairs):
        return pairs and re.fullmatch(r"\d+", pairs.get("Steps", "")) and any(
            key in pairs for key in ("Sampler", "CFG scale", "Seed", "Size"))
    if not confirmed(parameters):
        # Legacy exports sometimes put each saved setting on its own line.
        # Only a contiguous known-key suffix beginning at numeric Steps is a
        # parameter block; a Steps-like line inside prompt prose stays text.
        parameters, suffix = None, []
        for index in range(len(lines) - 1, -1, -1):
            row = _parameter_pairs(lines[index].strip(), strict=True)
            if not row or not set(row).issubset(_A1111_ROW_KEYS):
                break
            suffix.insert(0, row)
            if "Steps" in row:
                candidate = {key: item for part in suffix for key, item in part.items()}
                if confirmed(candidate):
                    parameters, parameter_start = candidate, index
                break
        if parameters is None:
            return None
    positive, negative, in_negative = [], [], False
    for index, line in enumerate(lines[:parameter_start]):
        if index == 0 and line.startswith("Prompt:"):
            line = line[len("Prompt:"):].lstrip()
        if not in_negative and line.startswith("Negative prompt:"):
            in_negative = True
            line = line[len("Negative prompt:"):].lstrip()
        (negative if in_negative else positive).append(line)
    return "\n".join(positive).strip(), "\n".join(negative).strip(), parameters


def normalize_generation_raw(raw):
    """Expose only confirmed EXIF generator/ComfyUI envelopes without overwrite."""
    if not isinstance(raw, Mapping):
        return {}
    normalized = dict(raw)
    wrapper = _json(raw.get("UserComment"))
    if not wrapper:
        return normalized
    additions = {}
    for key in ("prompt", "workflow"):
        graph = _json(wrapper.get(key))
        if _is_comfy(graph):
            additions[key] = wrapper[key]
    parameters = wrapper.get("parameters")
    if _is_fooocus(_json(parameters)) or _a1111(parameters):
        additions["parameters"] = parameters
    elif _is_fooocus(wrapper):
        additions["parameters"] = wrapper
    if _legacy_fooocus(wrapper.get("fooocus_params")):
        additions["fooocus_params"] = wrapper["fooocus_params"]
    for key in ("invokeai_metadata", "invokeai", "sd-metadata"):
        invoke = _json(wrapper.get(key))
        if _is_invoke(invoke) or key == "sd-metadata" and isinstance(invoke, dict) and isinstance(invoke.get("image"), dict):
            additions[key] = wrapper[key]
    # Workflow and execution graph are separate records; neither is a prompt.
    for key in ("invokeai_workflow", "invokeai_graph"):
        if _json(wrapper.get(key)) is not None:
            additions[key] = wrapper[key]
    nai = _nai_comment(wrapper)
    context = {**wrapper, **raw}
    if _is_nai(nai, context):
        additions["Comment"] = wrapper.get("Comment", wrapper)
        for key in ("Description", "Software", "Source"):
            if isinstance(wrapper.get(key), str):
                additions[key] = wrapper[key]
    for key, value in additions.items():
        if key not in normalized:
            normalized[key] = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return normalized


def _base(source):
    return {"model": "", "vae": "", "seed": "", "steps": "", "cfg": "", "sampler": "",
            "scheduler": "", "denoise": "", "noiseSeed": "", "clipSkip": 0,
            "prompt": "", "negativePrompt": "", "promptStages": [], "promptStatus": "missing",
            "promptWarnings": [], "loras": [], "hasWorkflow": False, "hasPrompt": False,
            "metadataSource": source, "checkpoints": [], "textEncoders": [], "vaes": [],
            "loraDetails": [], "generationStages": [], "generationStatus": "missing", "generationWarnings": [],
            "generationScope": "recorded", "generationOutputNodeId": None}


def _add_lora(result, name, weight=None, *, clip_weight=None, enabled=True, deduplicate=False):
    if not isinstance(name, str) or not name or name == "None":
        return
    model_weight = _weight(weight)
    clip_weight = _weight(clip_weight)
    active = False if not enabled or model_weight == clip_weight == 0 else (
        True if model_weight is not None and model_weight != 0 or clip_weight is not None and clip_weight != 0 else None)
    detail = {"name": name, "strengthModel": model_weight, "strengthClip": clip_weight,
              "enabled": enabled, "nodeId": _NODE_ID, "active": active}
    if not deduplicate or detail not in result["loraDetails"]:
        result["loraDetails"].append(detail)
    if name not in result["loras"]:
        result["loras"].append(name)
    if (model_weight is None or clip_weight is None) and "lora-weight-not-recorded" not in result["generationWarnings"]:
        result["generationWarnings"].append("lora-weight-not-recorded")


def _fooocus_loras(data, result):
    for key, value in data.items():
        if not re.match(r"^(?:lora_combined_\d+|LoRA \d+)$", key) or not isinstance(value, str):
            continue
        parts = value.split(" : ")
        enabled = True
        if len(parts) == 3 and parts[0].lower() in ("true", "false"):
            enabled, parts = parts[0].lower() == "true", parts[1:]
        if len(parts) == 2:
            _add_lora(result, parts[0], parts[1], clip_weight=parts[1], enabled=enabled)
    if isinstance(data.get("loras"), list):
        for item in data["loras"]:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                _add_lora(result, item[0], item[1], clip_weight=item[1], deduplicate=True)


def _finish(result):
    result["hasPrompt"] = bool(result["prompt"])
    result["promptStatus"] = ("partial" if result["promptWarnings"] else "complete") if result["prompt"] else "missing"
    if result["prompt"] or result["negativePrompt"]:
        result["promptStages"].insert(0, {"nodeId": _NODE_ID, "label": _LABELS[result["metadataSource"]],
                                         "prompt": result["prompt"], "negativePrompt": result["negativePrompt"]})
    if result["model"] and result["model"] not in result["checkpoints"]:
        result["checkpoints"].insert(0, result["model"])
    if result["vae"]:
        result["vaes"] = [result["vae"]]
    config = {key: result[key] for key in ("steps", "cfg", "seed", "noiseSeed", "sampler", "scheduler", "denoise")}
    if result["metadataSource"] == "a1111" and any(stage["nodeId"] == "saved-hires" for stage in result["generationStages"]):
        # In txt2img high-resolution records this value belongs to the second
        # pass. Keep the saved scalar, without assigning it to the base pass.
        config["denoise"] = ""
    if any(config.values()):
        result["generationStages"].insert(0, {"nodeId": _NODE_ID, "label": _LABELS[result["metadataSource"]], **config})
    if result["metadataSource"] == "a1111":
        # A1111's extra_networks_lora uses TE first, UNet second; named
        # te=/unet= override those positions. Other generators do not prove
        # that a literal <lora:...> in text loaded a LoRA.
        for match in _LORA_TAG.finditer(result["prompt"]):
            tokens = match[2].split(":") if match[2] is not None else []
            positional = [part for part in tokens if "=" not in part]
            named = dict(part.split("=", 1) for part in tokens if "=" in part)
            clip = named.get("te", positional[0] if positional else None)
            model = named.get("unet", positional[1] if len(positional) > 1 else clip)
            _add_lora(result, match[1], model, clip_weight=clip)
    if result["generationStages"] or result["checkpoints"] or result["loraDetails"]:
        complete = all(result[key] != "" for key in ("steps", "cfg", "seed")) and bool(result["sampler"] or result["scheduler"])
        result["generationStatus"] = "complete" if complete and not result["generationWarnings"] else "partial"
    return result


def _apply(result, data, mapping):
    for key, aliases in mapping.items():
        result[key] = _scalar(_pick(data, *aliases))
    clip_skip = _pick(data, "clip_skip", "Clip skip", "CLIP Skip")
    if isinstance(clip_skip, (str, int)) and not isinstance(clip_skip, bool):
        try:
            parsed = int(clip_skip)
            if abs(parsed) <= _MAX_SAFE_INTEGER:
                result["clipSkip"] = parsed
        except (ValueError, OverflowError):
            pass


def _stage(result, node_id, label, data, mapping):
    config = {key: "" for key in ("steps", "cfg", "seed", "noiseSeed", "sampler", "scheduler", "denoise")}
    for key, aliases in mapping.items():
        config[key] = _scalar(_pick(data, *aliases))
    if any(config.values()):
        result["generationStages"].append({"nodeId": node_id, "label": label, **config})


def _legacy_invoke(data):
    legacy = _json(data.get("invokeai"))
    if _is_invoke(legacy):
        return {**legacy, "positive_prompt": legacy.get("positive_conditioning"),
                "negative_prompt": legacy.get("negative_conditioning")}, []
    legacy = _json(data.get("sd-metadata"))
    image = legacy.get("image") if legacy else None
    if not isinstance(image, dict) or not any(key in image for key in ("prompt", "seed", "steps")):
        return None, []
    positive, negative, warnings = [], [], []
    prompts = image.get("prompt")
    if isinstance(prompts, str):
        prompts = [{"prompt": prompts}]
    if isinstance(prompts, list):
        for part in prompts:
            text = part.get("prompt") if isinstance(part, dict) else None
            if not isinstance(text, str):
                warnings.append("legacy-weighted-prompts-not-fully-expanded")
                continue
            # InvokeAI < 3 explicitly used [...] blocks for negative prompts.
            blocks = re.findall(r"\[([^\[\]]+)\]", text)
            positive.append(re.sub(r"\[[^\[\]]+\]", "", text).strip())
            negative.extend(block.strip().strip(",") for block in blocks)
            if part.get("weight", 1) != 1 or len(prompts) > 1:
                if "legacy-weighted-prompts-not-fully-expanded" not in warnings:
                    warnings.append("legacy-weighted-prompts-not-fully-expanded")
    return {**image, "positive_prompt": "\n".join(positive), "negative_prompt": "\n".join(negative),
            "model": legacy.get("model_weights"), "strength": _pick(image, "strength", "strength_steps")}, warnings


def parse_generation_fields(raw):
    """Return recognized saved generator fields, or None for unrelated metadata."""
    if not isinstance(raw, Mapping):
        return None
    data = normalize_generation_raw(raw)
    invoke = _json(data.get("invokeai_metadata"))
    prompt_warnings = []
    if not _is_invoke(invoke):
        invoke, prompt_warnings = _legacy_invoke(data)
    if _is_invoke(invoke):
        result = _base("invokeai")
        result["promptWarnings"].extend(prompt_warnings)
        result.update(prompt=_text(invoke.get("positive_prompt")), negativePrompt=_text(invoke.get("negative_prompt")),
                      model=_name(invoke.get("model")), vae=_name(invoke.get("vae")))
        _apply(result, invoke, {"steps": ("steps",), "seed": ("seed",), "cfg": ("cfg_scale",),
                               "sampler": ("sampler",), "scheduler": ("scheduler",), "denoise": ("strength",), "noiseSeed": ("noise_seed",)})
        for key in ("qwen3_encoder", "mistral_encoder"):
            name = _name(invoke.get(key))
            if name and name not in result["textEncoders"]:
                result["textEncoders"].append(name)
        if isinstance(invoke.get("loras"), list):
            for item in invoke["loras"]:
                if isinstance(item, dict):
                    _add_lora(result, _name(item.get("model")), item.get("weight"), clip_weight=item.get("weight"))
        refiner = _name(invoke.get("refiner_model"))
        if refiner:
            result["checkpoints"].append(refiner)
            _stage(result, "saved-refiner", "InvokeAI refiner", invoke, {
                "steps": ("refiner_steps",), "cfg": ("refiner_cfg_scale",), "scheduler": ("refiner_scheduler",)})
            result["generationWarnings"].append("refiner-stage-fields-incomplete")
        if invoke.get("hrf_enabled") is True:
            _stage(result, "saved-hires", "InvokeAI high resolution", invoke, {"denoise": ("hrf_strength",)})
            result["generationWarnings"].append("hires-stage-fields-incomplete")
        style, negative_style = _text(invoke.get("positive_style_prompt")), _text(invoke.get("negative_style_prompt"))
        if style or negative_style:
            result["promptStages"].append({"nodeId": "saved-style", "label": "InvokeAI style",
                                           "prompt": style, "negativePrompt": negative_style})
        return _finish(result)
    fooocus = _json(data.get("parameters"))
    if not _is_fooocus(fooocus) and not _a1111(data.get("parameters")):
        fooocus = _legacy_fooocus(data.get("fooocus_params"))
    if _is_fooocus(fooocus):
        result = _base("fooocus")
        result.update(prompt=_text(_pick(fooocus, "full_prompt", "prompt", "Prompt")),
                      negativePrompt=_text(_pick(fooocus, "full_negative_prompt", "negative_prompt", "Negative Prompt")))
        _apply(result, fooocus, {"model": ("base_model", "Base Model"), "vae": ("vae", "VAE"),
                                "steps": ("steps", "Steps"), "seed": ("seed", "Seed"),
                                "cfg": ("guidance_scale", "Guidance Scale", "CFG scale"), "sampler": ("sampler", "Sampler"),
                                "scheduler": ("scheduler", "Scheduler"), "denoise": ("denoise",), "noiseSeed": ("noise_seed",)})
        refiner = _name(_pick(fooocus, "refiner_model", "Refiner Model"))
        if refiner and refiner != "None":
            result["checkpoints"].append(refiner)
            result["generationWarnings"].append("refiner-stage-not-recorded")
        _fooocus_loras(fooocus, result)
        return _finish(result)
    nai = _nai_comment(_json(_pick(data, "Comment", "UserComment")))
    if _is_nai(nai, data):
        result = _base("novelai")
        result.update(prompt=_text(nai.get("prompt")) or _text(_pick(data, "Description", "ImageDescription")),
                      negativePrompt=_text(nai.get("uc")), model=_scalar(_pick(data, "Source", "Software")))
        _apply(result, nai, {"steps": ("steps",), "seed": ("seed",), "cfg": ("scale",),
                            "sampler": ("sampler",), "scheduler": ("scheduler",), "denoise": ("strength",),
                            "noiseSeed": ("noise_seed",)})
        if "v4_prompt" in nai or "v4_negative_prompt" in nai:
            result["promptWarnings"].append("structured-character-prompts-not-expanded")
            _finish(result)
            result["promptStatus"] = "partial" if result["prompt"] else "missing"
            return result
        return _finish(result)
    for key in ("parameters", "UserComment"):
        parsed = _a1111(data.get(key))
        if not parsed:
            continue
        positive, negative, settings = parsed
        result = _base("a1111")
        result.update(prompt=positive, negativePrompt=negative)
        for original, normalized in _A1111_FIELDS.items():
            if original in settings:
                result[normalized] = settings[original]
        _apply(result, settings, {})
        refiner = settings.get("Refiner", "")
        if refiner and refiner != "None":
            result["checkpoints"].append(refiner)
            result["generationWarnings"].append("refiner-stage-not-recorded")
        for item in settings.get("Lora weights", "").split(","):
            name, separator, weight = item.rpartition(":")
            if separator:
                _add_lora(result, name.strip(), weight.strip(), clip_weight=weight.strip())
        # A hash proves the saved LoRA name, not its weight.
        for item in settings.get("Lora hashes", "").split(","):
            name, separator, _ = item.rpartition(":")
            if separator and name.strip() not in result["loras"] and not any(
                    tag[1] == name.strip() for tag in _LORA_TAG.finditer(positive)):
                _add_lora(result, name.strip())
        if any(key.startswith("Hires ") for key in settings):
            result["generationWarnings"].append("additional-stage-parameters-present")
            _stage(result, "saved-hires", "A1111 high resolution", settings, {
                "steps": ("Hires steps", "Hires upscale steps"), "cfg": ("Hires CFG Scale", "Hires CFG scale"),
                "sampler": ("Hires sampler",), "scheduler": ("Hires schedule type",),
                "denoise": ("Denoising strength",)})
            if settings.get("Hires prompt") or settings.get("Hires negative prompt"):
                result["promptStages"].append({"nodeId": "saved-hires", "label": "A1111 high resolution",
                    "prompt": settings.get("Hires prompt", ""), "negativePrompt": settings.get("Hires negative prompt", "")})
        return _finish(result)
    return None
