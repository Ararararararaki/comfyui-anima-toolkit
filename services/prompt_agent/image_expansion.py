"""Image-grounded prompt expansion and short-lived, session-owned observations."""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import re
import time
import uuid

from .errors import AgentError
from .protocol import object_schema, complete_structured
from .providers import OpenAICompatibleProvider
from .interrogators.vision import _data_uri

EXPANSION_SCHEMA = object_schema({
    "caption": {"type": "string"},
    "prompt": {"type": "string"},
})


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


async def expand_image(image, observation, profile, options, config, *, session_id=""):
    mode = options.get("expansion_mode", "faithful")
    instruction = options.get("expansion_instruction", "")
    preserve_identity = options.get("preserve_identity", True)
    if not isinstance(preserve_identity, bool):
        raise AgentError("保留角色身份必须是布尔值。")
    if mode not in ("faithful", "creative"):
        raise AgentError("看图扩写方式必须是忠实描述或创作扩写。")
    if not isinstance(instruction, str) or len(instruction) > 4000:
        raise AgentError("看图扩写指令最多 4000 个字符。")
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
    context = {"tagger_tags": observation.get("tags", []), "tagger_caption": observation.get("caption", ""),
               "character_references": character_references(observation),
               "copyright_references": observation.get("categories", {}).get("copyright", []),
               "user_instruction": instruction, "target_profile": profile.data["label"]}
    provider = OpenAICompatibleProvider(dict(config))
    provider.bind_session(session_id or "image-expansion")
    messages = [
        {"role": "system", "content": "Read the attached image, then use the supplied tagger observations as fallible hints. "
         + identity_rules +
         "Correct non-identity tags that contradict the pixels. Pay attention to subjects, pose, interaction, viewpoint, composition, lighting, environment and materials. "
         + behavior + style + " caption is an English description of what you actually see; prompt is the final usable prompt. "
         'Return exactly two string fields: {"caption":"visible image description","prompt":"usable generation prompt"}. '
         "No other fields, Markdown or explanation. JSON schema: " + json.dumps(EXPANSION_SCHEMA)},
        {"role": "user", "content": [{"type": "text", "text": json.dumps(context, ensure_ascii=False)},
                                      {"type": "image_url", "image_url": {"url": _data_uri(image), "detail": "auto"}}]},
    ]
    def validate(result):
        if not result["caption"].strip() or not result["prompt"].strip():
            raise AgentError("看图模型必须返回非空 caption 和 prompt，原始标签仍保留。")
        profile.validate_snapshot(result["prompt"].strip())
    try:
        result = await complete_structured(provider, messages, EXPANSION_SCHEMA, validate,
                                           unwrap_json_string=True)
    except AgentError as error:
        raise AgentError(f"所选看图模型未完成图片扩写：{error} 原始标签仍保留。") from error
    prompt = profile.validate_snapshot(result["prompt"].strip())
    if not prompt:
        raise AgentError("看图模型未返回有效 Prompt，原始标签仍保留。")
    retained_names = character_references(observation) if preserve_identity else []
    if retained_names:
        # Prose conversion must not erase the tagger's named character.
        copyrights = observation.get("categories", {}).get("copyright", [])
        prompt = retain_character_names(prompt, retained_names, profile,
                                        [name for name in copyrights if isinstance(name, str) and name != "original"])
    return {"expanded": True, "expansion_caption": result["caption"].strip(), "formatted_prompt": prompt,
            "expansion_error": "",
            "retained_characters": retained_names,
            "expansion_mode": mode, "message": "看图扩写完成，确认后更新 Final Prompt；原始标签仍保留。"}
