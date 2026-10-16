"""A single visual observation call through an existing chat provider."""
from __future__ import annotations

import base64
import io
import json

from ..errors import AgentError
from ..profiles import ProfileRegistry
from ..protocol import object_schema, parse_response
from ..providers import OpenAICompatibleProvider

OBSERVATION_SCHEMA = object_schema({
    "caption": {"type": "string"},
    "tags": {"type": "array", "items": {"type": "string"}},
})

OBSERVATION_INSTRUCTIONS = (
    "Observe the attached image and return exactly one JSON object with caption and tags. "
    "caption is a concise English description of visible subjects, attributes, actions, spatial relationships, "
    "composition, environment, and lighting. tags is a short list of English visual tags grounded in the image. "
    "Describe what is visible; do not invent identities, hidden details, or an original generation prompt. "
    "Return no Markdown, commentary, or reasoning."
)


def _data_uri(image: bytes) -> str:
    from PIL import Image, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(image)) as opened:
            mime = Image.MIME.get(opened.format)
            if mime not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
                raise AgentError("视觉反推接受 PNG、JPEG、WebP 或 GIF 图片。")
            opened.verify()
    except (OSError, ValueError, UnidentifiedImageError):
        raise AgentError("视觉反推无法读取这张图片。") from None
    return f"data:{mime};base64," + base64.b64encode(image).decode("ascii")


async def interrogate_vision(image: bytes, options: dict, config: dict, *, session_id: str = "") -> dict:
    """Observe once; downstream code owns target-profile formatting and editing."""
    if not isinstance(image, bytes) or not image:
        raise AgentError("视觉反推需要图片数据。")
    if not isinstance(options, dict):
        raise AgentError("视觉反推 options 必须是对象。")
    instruction = options.get("instruction") or "Describe this image."
    if not isinstance(instruction, str) or len(instruction) > 4000:
        raise AgentError("视觉反推补充指令最多 4000 个字符。")
    profile = ProfileRegistry().get(options.get("profile") or "anima")
    provider = OpenAICompatibleProvider(dict(config))
    provider.bind_session(session_id or "visual-interrogation")
    messages = [
        {"role": "system", "content": OBSERVATION_INSTRUCTIONS + " JSON schema: " + json.dumps(OBSERVATION_SCHEMA)},
        {"role": "user", "content": [
            {"type": "text", "text": instruction},
            {"type": "image_url", "image_url": {"url": _data_uri(image), "detail": "auto"}},
        ]},
    ]
    result = parse_response(await provider.complete(messages, OBSERVATION_SCHEMA), OBSERVATION_SCHEMA)
    caption = " ".join(result["caption"].split())
    tags = list(dict.fromkeys(tag.strip() for tag in result["tags"] if tag.strip()))
    if not caption and not tags:
        raise AgentError("视觉模型没有返回画面描述。")
    for fragment in ([caption] if caption else []) + tags:
        profile.validate_fragment(fragment)
    return {"source": "workbuddy-vision", "tags": tags, "caption": caption, "scores": {}, "categories": {}}
