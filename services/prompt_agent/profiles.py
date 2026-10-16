"""Data-driven model rules and the final, independent output gate."""
from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .errors import AgentError

SECTIONS = (
    "subject", "character_identity", "appearance", "clothing", "expression",
    "pose", "interaction", "camera", "composition", "environment", "lighting",
    "effects", "special_constraints",
)
SECTION_LABELS = dict(zip(SECTIONS, (
    "主体", "角色身份", "人物特征", "服装", "表情", "动作", "互动",
    "镜头", "构图", "环境", "光照", "效果", "特殊约束",
)))


def split_fragments(text: str) -> list[str]:
    """Split top-level commas, preserving weights and escaped parentheses."""
    parts, current, depth, escaped = [], [], 0, False
    for char in text.replace("，", ","):
        if char == "," and depth == 0 and not escaped:
            if "".join(current).strip():
                parts.append("".join(current).strip())
            current = []
            continue
        current.append(char)
        if not escaped:
            if char in "([{":
                depth += 1
            elif char in ")]}":
                depth = max(0, depth - 1)
        escaped = char == "\\" and not escaped
    if "".join(current).strip():
        parts.append("".join(current).strip())
    return parts


@dataclass(frozen=True)
class Profile:
    data: dict

    @property
    def id(self) -> str:
        return self.data["id"]

    def normalize(self, value: str) -> str:
        rules = self.data["normalization"]
        value = " ".join(value.split())
        if rules["underscores_to_spaces"]:
            value = value.replace("_", " ")
        if rules["lowercase"]:
            value = value.lower()
        return value.strip(" ,")

    def validate_fragment(self, value: str) -> None:
        if not value:
            raise AgentError("Prompt 片段不能为空")
        if any(unicodedata.category(char) in ("Cc", "Cf") for char in value):
            raise AgentError("Final Prompt 含控制字符")
        if any(any(part in unicodedata.name(char, "") for part in
                   ("CJK", "HIRAGANA", "KATAKANA", "HANGUL")) for char in value):
            raise AgentError("Final Prompt 必须为英文；中文说明只能出现在 Agent Response")
        lower = value.lower()
        banned = ("```", "`", "**", "<think>", "</think>", "[", "]", "# ", "http://", "https://")
        if any(pattern in lower for pattern in banned + tuple(self.data["prohibited_patterns"])):
            raise AgentError("Final Prompt 含 Markdown、解释或协议污染")
        if lower.startswith(("here is", "here's", "sure", "okay", "note:", "prompt:",
                             "final prompt:", "warning:", "i have", "i changed")):
            raise AgentError("模型解释不能进入 Final Prompt")
        if lower.startswith(("do not add", "do not output", "return json", "return only", "output only",
                             "no quality words", "no quality tags", "no score tags")) or lower in ("json only", "english only", "no markdown"):
            raise AgentError("提示词写作指令不能进入 Final Prompt；请只保留画面描述")

    def clean(self, sections: dict[str, list[str]], *, validate: bool = True) -> dict[str, list[str]]:
        cleaned: dict[str, list[str]] = {}
        seen: set[str] = set()
        for section in self.data["preferred_order"]:
            values = []
            for raw in sections.get(section, []):
                for part in (split_fragments(raw) if self.data["style"] == "tags" else [raw]):
                    value = self.normalize(part)
                    if not value:
                        continue
                    if validate:
                        self.validate_fragment(value)
                    key = value.casefold()
                    if self.data["normalization"]["dedupe"] and key in seen:
                        continue
                    seen.add(key)
                    values.append(value)
            cleaned[section] = values
        return cleaned

    def render(self, sections: dict[str, list[str]]) -> str:
        normalized = self.clean(sections)
        rules = self.data["normalization"]
        values = [part for name in self.data["preferred_order"] for part in normalized[name]]
        if not values:
            raise AgentError("Final Prompt 为空")
        if len(values) > rules["max_items"] or len(normalized["lighting"]) > rules["max_lighting"]:
            raise AgentError("Prompt 或光照描述过量，请精简后重试")
        result = rules["separator"].join(values)
        if len(result) > rules["max_chars"]:
            raise AgentError("Final Prompt 超出 Profile 长度限制")
        return result

    def validate_snapshot(self, text: str, *, dedupe: bool = False) -> str:
        """Validate a whole prompt without applying semantic editing budgets.

        A confirmed tag/prose draft has no reliable section counts. Preserve its
        paragraphs rather than re-splitting and reordering it at generation time.
        """
        if not isinstance(text, str) or not text.strip():
            raise AgentError("Final Prompt 为空")
        paragraphs = []
        seen = set()
        for paragraph in text.replace("\r\n", "\n").split("\n\n"):
            parts = split_fragments(paragraph) if self.data["style"] == "tags" else [paragraph]
            values = []
            for part in parts:
                value = self.normalize(part)
                if not value:
                    continue
                self.validate_fragment(value)
                if dedupe and value.casefold() in seen:
                    continue
                seen.add(value.casefold())
                values.append(value)
            if values:
                paragraphs.append(self.data["normalization"]["separator"].join(values))
        result = "\n\n".join(paragraphs)
        if not result:
            raise AgentError("Final Prompt 为空")
        if len(result) > self.data["normalization"]["max_chars"]:
            raise AgentError("Final Prompt 超出 Profile 长度限制")
        return result


class ProfileRegistry:
    def __init__(self, directory: Path | None = None):
        self.directory = directory or Path(__file__).parent / "profiles"

    def all(self) -> list[Profile]:
        result = []
        for path in sorted(self.directory.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(data, dict) or data["id"] != path.stem or data["style"] not in ("tags", "prose"):
                    raise ValueError("invalid identity or style")
                if set(data["preferred_order"]) != set(SECTIONS) or len(data["preferred_order"]) != len(SECTIONS):
                    raise ValueError("invalid section order")
                for key in ("label", "system_instructions", "base_agent_prompt"):
                    if not isinstance(data[key], str) or not data[key].strip():
                        raise ValueError(key)
                rules = data["normalization"]
                for key in ("lowercase", "underscores_to_spaces", "dedupe"):
                    if type(rules[key]) is not bool:
                        raise ValueError(key)
                for key in ("max_items", "max_chars", "max_lighting"):
                    if type(rules[key]) is not int or rules[key] < 1:
                        raise ValueError(key)
                if not isinstance(rules["separator"], str) or not isinstance(data["prohibited_patterns"], list):
                    raise ValueError("invalid normalization")
                result.append(Profile(data))
            except (OSError, KeyError, TypeError, ValueError) as error:
                raise AgentError(f"Profile {path.name} 无效") from error
        if not result:
            raise AgentError("没有可用的 Model Profile")
        return result

    def get(self, profile_id: str) -> Profile:
        for profile in self.all():
            if profile.id == profile_id:
                return profile
        raise AgentError("未知 Model Profile")
