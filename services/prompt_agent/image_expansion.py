"""Image-grounded prompt expansion and short-lived, session-owned observations."""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import io
import json
import re
import time
import uuid

from .errors import AgentError
from .protocol import object_schema, complete_structured
from .providers import OpenAICompatibleProvider
from .interrogators.vision import _data_uri
from .moss import (MOSS_SKILL_ID, MOSS_DRAFT_RULES, compile_expansion_prompt,
                   validate_skill_prompt, retain_moss_names, layout_dimensions, normalize_layout_draft, _requested_canvas, requested_format,
                   requested_lettering_language, validate_lettering_language)

EXPANSION_SCHEMA = object_schema({
    "caption": {"type": "string"},
    "prompt": {"type": "string"},
})


# One JSON layer on the model wire; strings remain readable for saved/older callers.
MOSS_PROMPT_SCHEMA = {"anyOf": [
    {"type": "string"},
    object_schema({"caption": {"type": "string"}}),
    object_schema({"width": {"type": "integer"}, "height": {"type": "integer"},
        "bbox_coord_space": {"type": "string", "enum": ["abs"]},
        "bbox_format": {"type": "string", "enum": ["xyxy"]},
        "summary": object_schema({"caption": {"type": "string"},
            "meta": {"type": "array", "items": {"type": "string"}},
            "canvas": {"type": "string", "enum": ["single", "multi_panel", "collage"]},
            "palette": {"type": "array", "items": {"type": "string"}}}),
        "items": {"type": "array", "items": {"anyOf": [
            object_schema({"label": {"type": "string", "enum": ["object", "character"]},
                "caption": {"type": "string"}, "bbox": {"type": "array", "items": {"type": "number"}}}),
            object_schema({"label": {"type": "string", "enum": ["text"]},
                "caption": {"type": "string"}, "text": {"type": "string"},
                "bbox": {"type": "array", "items": {"type": "number"}}})]}}})]}


def character_references(observation):
    categories = observation.get("categories", {})
    return list(dict.fromkeys(tag for tag in categories.get("character", []) if isinstance(tag, str) and tag.strip()))


def retain_character_names(prompt, names, profile, copyrights=()):
    def normalized(text):
        return re.sub(r"[^\w]+", " ", text.replace("_", " ")).casefold().strip()
    missing = [name.replace("_", " ") for name in [*names, *copyrights] if normalized(name) not in normalized(prompt)]
    if missing:
        if profile.data["style"] == "prose":
            reference = ", ".join(name.replace("_", " ") for name in names)
            if copyrights:
                reference += " from " + ", ".join(name.replace("_", " ") for name in copyrights)
            prompt = "Featuring " + reference + ". " + prompt
        else:
            prompt = ", ".join(missing) + ", " + prompt
    return profile.validate_snapshot(prompt)


@dataclass
class Observation:
    session: str
    image: bytes
    result: dict
    created: float


class ImageObservations:
    """Keep image bytes only in this runtime; no inference-response cache."""
    def __init__(self, *, max_bytes=32 * 1024 * 1024, ttl=1800, clock=time.monotonic):
        self.items = OrderedDict()
        self.max_bytes, self.ttl, self.clock = max_bytes, ttl, clock

    def _prune(self):
        now = self.clock()
        for key, row in list(self.items.items()):
            if now - row.created >= self.ttl:
                del self.items[key]
        while self.items and (len(self.items) > 32 or sum(len(row.image) for row in self.items.values()) > self.max_bytes):
            self.items.popitem(last=False)

    def store(self, session, image, result):
        if len(image) > self.max_bytes:
            raise AgentError("图片超出最近反推图片的内存上限，请缩小图片。")
        self._prune()
        # The latest processed image is the single source for this session.
        for key, row in list(self.items.items()):
            if row.session == session:
                del self.items[key]
        key = uuid.uuid4().hex
        self.items[key] = Observation(session, image, deepcopy(result), self.clock())
        self._prune()
        return key

    def get(self, session, key, image=None):
        self._prune()
        row = self.items.get(key)
        if row is None or row.session != session:
            raise AgentError("最近反推图片已过期或服务已重载，请重新反推一次。")
        if image is not None and hashlib.sha256(image).digest() != hashlib.sha256(row.image).digest():
            raise AgentError("图片已经更换，请先重新反推，再看图扩写。")
        return row


async def expand_image(image, observation, profile, options, config, *, session_id="", skill=None, detect_operations=False):
    mode = options.get("expansion_mode", "faithful")
    instruction = options.get("expansion_instruction", "")
    preserve_identity = options.get("preserve_identity", True)
    if not isinstance(preserve_identity, bool):
        raise AgentError("保留角色身份必须是布尔值。")
    if mode not in ("faithful", "creative"):
        raise AgentError("看图扩写方式必须是忠实描述或创作扩写。")
    if not isinstance(instruction, str):
        raise AgentError("看图扩写指令必须是文字。")
    output_char_limit = options.get("output_char_limit", 4000)
    if type(output_char_limit) is not int or output_char_limit < 0:
        raise AgentError("输出提示词长度提醒须为非负整数，0 表示不提醒。")
    behavior = ("Faithfully describe the actual image. Add visible details, not invented scenery or identities. "
                if mode == "faithful" else
                "Use the image as the starting composition and follow requested creative changes. "
                "Without requested changes, elaborate the visible image rather than inventing a new scene. ")
    style = ("Write a coherent English prose image-generation prompt." if profile.data["style"] == "prose" else
             "Write concise English visual tags followed by a blank line and useful English prose about spatial relationships and composition.")
    identity_rules = ("Character and copyright references are supplied by the dedicated tagger: preserve those exact identities and names, "
                      "rather than guessing or replacing them with generic people. Preserve identity-defining appearance (hair, eyes, distinctive accessories and clothing) "
                      "from the source image and tagger hints, including for prose target profiles. Creative changes apply to the requested scene details; keep the character identity. "
                      if preserve_identity else
                      "Character identity is editable: follow the user's requested character and appearance changes. ")
    skill_id = skill.id if skill is not None else ""
    moss = skill_id == MOSS_SKILL_ID
    if moss:
        style = ""
    skill_rules = ""
    if skill is not None and skill.instructions:
        # The selected skill controls the draft; application owns final compilation.
        skill_rules = (" Additionally follow this expansion skill's rules when writing the prompt field "
                       "(it does not change the required return shape): " + skill.instructions + " ")
    from PIL import Image
    with Image.open(io.BytesIO(image)) as opened:
        image_dimensions = {"width": opened.width, "height": opened.height}
    source_dimensions = observation.get("source_dimensions") or image_dimensions
    canvas = _requested_canvas(instruction)
    if not canvas and observation.get("source_dimensions"):
        canvas = (source_dimensions["width"], source_dimensions["height"])
    context = {"source_dimensions": source_dimensions, "image_dimensions": image_dimensions,
               "requested_output_mode": (requested_format(instruction) or "auto") if moss else "profile",
               "layout_canvas": ({"width": canvas[0], "height": canvas[1]} if canvas else None),
               "tagger_tags": observation.get("tags", []), "tagger_caption": observation.get("caption", ""),
               "character_references": options.get("source_identities", character_references(observation)),
               "copyright_references": observation.get("categories", {}).get("copyright", []),
               "user_instruction": instruction,
               "output_character_target": output_char_limit or None,
               "rendered_text_target_language": requested_lettering_language(instruction) or "source_unless_requested",
               "reference_evidence": options.get("reference_evidence", {}),
               "replacement_characters": options.get("replacement_characters", []),
               "requested_characters": options.get("requested_characters", []),
               "character_operations": options.get("character_operations", []),
               "tag_filter_report": options.get("filter_report", {}),
               # 选了 skill 就不再向模型暴露 profile 名（用户要求不分模型）；
               # 字段本身保留，旧调用方和模板不必改。
               "target_profile": skill.label if skill is not None else profile.data["label"],
               "target_skill": skill.label if skill is not None else ""}
    schema = object_schema({"caption": {"type": "string"},
                            "prompt": MOSS_PROMPT_SCHEMA if moss else {"type": "string"}})
    if detect_operations:
        from .image_options import CHARACTER_OPERATIONS_SCHEMA, CHARACTER_OPERATION_RULES
        schema = object_schema({**schema["properties"], **CHARACTER_OPERATIONS_SCHEMA["properties"]})
    provider = OpenAICompatibleProvider(dict(config))
    from .interrogation_progress import reporter
    provider.on_progress = reporter(session_id)
    provider.require_model_match = bool(options.get("vision_model", "").strip())
    provider.bind_session(session_id or "image-expansion")
    messages = [
        {"role": "system", "content": "Read the attached image, then use the supplied tagger observations as fallible hints. "
         + identity_rules +
         "Correct non-identity tags that contradict the pixels. Pay attention to subjects, pose, interaction, viewpoint, composition, lighting, environment and materials. "
         + "Use verified character reference evidence for requested identity changes. Apply character_operations to each specified source only; "
         "preserve other subjects and attach each appearance, expression and pose to the correct subject. "
         "Unresolved catalog queries remain natural-language names, not verified tags. Do not restore replaced source identities. "
         "Follow tag_filter_report.settings: when watermarks is true omit watermarks, signatures and usernames; "
         "when text is true omit scene lettering; otherwise follow explicit text translation or replacement requests, and preserve visible wording only when no such change is requested. "
         "Do not reintroduce filtered artist or quality tags. "
         "When rendered_text_target_language is zh, translate EVERY visible dialogue/narration into Chinese in each text item; "
         "source-image caption metadata may describe the original, but the prompt describes the target. "
         "Keep each speaker, panel, bubble, bbox and emotion attached to the same region. "
         "Describe target text items as Chinese lettering, never Japanese/English dialogue after translation. "
         + behavior + style + " caption is an English description of what you actually see; prompt is the final usable prompt. "
         + skill_rules + (MOSS_DRAFT_RULES if moss else "") +
         "When output_character_target is set, aim to keep the final generation prompt within that character count. "
         "This is a soft target: prioritize complete requested content and valid Layout geometry and JSON. Never truncate text or JSON to fit. " +
         "Use the supplied source_dimensions and image_dimensions, never guess pixel dimensions. If layout_canvas is supplied it is authoritative; place absolute boxes on that canvas. " +
         ("Return caption describing the source image and prompt as a Caption object or a pixel Layout draft object. " if moss else
          "Return caption describing the source image and prompt as the usable generation prompt string. ") +
         (CHARACTER_OPERATION_RULES if detect_operations else "") +
         "No other fields, Markdown or explanation. JSON schema: " + json.dumps(schema)},
        {"role": "user", "content": [{"type": "text", "text": json.dumps(context, ensure_ascii=False)},
                                      {"type": "image_url", "image_url": {"url": _data_uri(image), "detail": "auto"}}]},
    ]
    def validate(result):
        if detect_operations:
            from .image_options import validate_character_operations
            validate_character_operations(result["operations"], options.get("source_identities", character_references(observation)))
        # caption is auxiliary UI metadata, never the generation input.
        # Keep a valid prompt even when the model leaves that description blank.
        if not result["prompt"] or (isinstance(result["prompt"], str) and not result["prompt"].strip()):
            lengths = {name: len(result[name].strip()) for name in ("caption", "prompt")}
            requested = re.sub(r"[^a-zA-Z0-9._:/-]", "?", str(config.get("model", "")))[:120]
            raise AgentError("看图模型返回的 prompt 为空，未生成可用提示词"
                             f"（caption_chars={lengths['caption']}, prompt_chars={lengths['prompt']}, model={requested}）。")
        if moss:
            compiled = compile_expansion_prompt(normalize_layout_draft(result["prompt"], canvas), instruction)
            validate_skill_prompt(profile, compiled, skill_id)
        else:
            profile.validate_snapshot(result["prompt"].strip())
    try:
        result = await complete_structured(provider, messages, schema, validate,
                                           unwrap_json_string=True)
    except AgentError as error:
        raise AgentError(f"所选看图模型未完成图片扩写：{error} 原始标签仍保留。") from error
    prompt = (compile_expansion_prompt(normalize_layout_draft(result["prompt"], canvas), instruction) if moss else
              profile.validate_snapshot(result["prompt"].strip()))
    if not prompt:
        raise AgentError("看图模型未返回有效 Prompt，原始标签仍保留。")
    retained_names = list(dict.fromkeys([*options.get("requested_characters", []),
        *(options.get("replacement_characters", []) or (character_references(observation) if preserve_identity else []))]))
    if retained_names:
        # Prose conversion must not erase the tagger's named character.
        copyrights = [] if (options.get("replacement_characters") or any(op.get("action") == "replace" for op in options.get("character_operations", []))) else observation.get("categories", {}).get("copyright", [])
        copyrights = [name for name in copyrights if isinstance(name, str) and name != "original"]
        prompt = (retain_moss_names(prompt, retained_names, copyrights) if moss else
                  retain_character_names(prompt, retained_names, profile, copyrights))
    prompt = validate_skill_prompt(profile, prompt, skill_id)
    # Language heuristics assess quality, not structural usability. Never regenerate
    # the whole scene or discard valid geometry for an untranslated text region.
    quality_warnings = []
    if output_char_limit and len(prompt) > output_char_limit:
        quality_warnings.append(f"输出提示词为 {len(prompt)} 个字符，超过设置的 {output_char_limit} 字符提醒值；已保留完整提示词，未截断。")
    if moss and not options.get("tag_filters", {}).get("text", False):
        expect_text = any(tag in {"text", "speech_bubble", "english_text", "japanese_text", "korean_text", "subtitles"}
                          for tag in observation.get("tags", []))
        try:
            validate_lettering_language(prompt, instruction, expect_text=expect_text)
        except AgentError as error:
            quality_warnings.append("中文翻译可能未完成（自动检查）："+str(error)+"。已保留本轮有效 Prompt，请检查文字区域。")
    return {**({"character_operations": result["operations"]} if detect_operations else {}), "expanded": True, "model_usage": {"source": options.get("vision_provider", "current"),
                "requested": config.get("model", ""), "reported": getattr(provider, "last_model", {}).get("reported", ""),
                "completed_at": time.time(), "protocol": getattr(provider, "protocol", "chat_completions"),
                "reasoning_effort": getattr(provider, "reasoning_effort", "")},
            "expansion_caption": result["caption"].strip(), "formatted_prompt": prompt,
            "expansion_error": "", "quality_warnings": quality_warnings,
            **(layout_dimensions(normalize_layout_draft(result["prompt"], canvas)) if moss else {}),
            "retained_characters": retained_names,
            "expansion_mode": mode, "message": "看图扩写完成，确认后更新 Final Prompt；原始标签仍保留。" + " ".join(quality_warnings)}
