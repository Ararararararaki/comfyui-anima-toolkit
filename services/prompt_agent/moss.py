"""MOSS Caption/Layout boundary, compiled entirely in memory.

Independent implementation of the data contract in the locally selected MOSS
skill's references/layout.md (reviewed 2026-10-20). Its compiler has no declared
license; no compiler source is vendored or executed here. The reviewed compiler
is only an optional test oracle. Ordinary Profile validation stays unchanged.
"""
from __future__ import annotations

import json
import math
import re
import unicodedata

from .errors import AgentError

MOSS_SKILL_ID = "dsh:moss-image-prompt-enhancer"
MAX_PROMPT_CHARS = 12000

MOSS_DRAFT_RULES = (
    "Current application adapter rules override conflicting workflow, format or text-preservation rules in the preceding skill text. "
    "For this MOSS skill choose Caption or Layout according to its rules, not the internal Profile style. "
    "Honor an explicit Caption or Layout request. Ordinary scenes, photographs and illustrations normally use Caption; "
    "detail alone does not require Layout. Use Layout for independently placed text, panels or controlled object relationships. "
    "Caption is a cohesive finished prose prompt, English unless the user requests another language. "
    "Explicit user requests to translate or replace visible text take precedence over copying source wording or language. For requested translation, text items contain the target-language wording and their captions describe target-language lettering; do not keep original English, Japanese or other source-language copy as the intended rendered text. Otherwise preserve exact visible wording, capitalization, punctuation and intended line breaks in its original language. "
    "For Caption put an object with only caption in the prompt field. "
    "For Layout put an editable pixel draft OBJECT in the prompt field, with exactly width, height, "
    "bbox_coord_space=abs, bbox_format=xyxy, summary and items. width/height are positive integers matching the supplied canvas; generation alignment is handled upstream, "
    "honor requested dimensions or choose an appropriate canvas (default 1024x1024). summary requires caption; "
    "optional meta/palette are string arrays, canvas is single/multi_panel/collage. items is a nonempty flat array; "
    "each item requires label (object/character/text), caption and bbox [left,top,right,bottom] in absolute canvas pixels. "
    "Text items also require text with exact visible characters; optional tags/palette are string arrays. "
    "Do not add other fields, child items, IDs, explanatory notes or Markdown. Boxes must have positive area inside the canvas. "
    "Do not calculate centralized coordinates: application code will round and convert the draft into the final "
    "single-line abs_centralized/yxyx JSON string. All compilation happens in memory; do not create files or claim tool execution. "
    "Do not serialize the prompt object as a JSON string. Return one JSON layer; application code compiles the final prompt text. "
)


def _fail(message):
    raise AgentError("MOSS: " + message)


def _object(value, allowed, required, location):
    if not isinstance(value, dict):
        _fail(location + " must be an object")
    if set(value) - set(allowed) or set(required) - set(value):
        _fail(location + " has missing or unrecognized fields")


def _text(value, location):
    if not isinstance(value, str) or not value.strip():
        _fail(location + " must be a nonempty string")
    # Preserve valid Unicode shaping and exact line breaks in visible copy.
    if any(unicodedata.category(c) == "Cs" or
           (unicodedata.category(c) == "Cc" and c not in "\n\r\t") for c in value):
        _fail(location + " contains a control character")


def _strings(value, location):
    if not isinstance(value, list):
        _fail(location + " must be a string array")
    for item in value:
        _text(item, location)


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("duplicate JSON field " + key)
        result[key] = value
    return result


def _reject_constant(value):
    _fail("nonfinite JSON number " + value)


def _decode(text, *, recover_line_breaks=False):
    try:
        try:
            return json.loads(text, object_pairs_hook=_unique, parse_constant=_reject_constant)
        except json.JSONDecodeError as error:
            # Only recover double-serialization mistakes in the editable draft.
            # No truncation, quote repair, duplicate fields or control-byte removal.
            if (not recover_line_breaks or not error.msg.startswith("Invalid control character") or
                    any(ord(c) < 32 and c not in "\n\r\t" for c in text)):
                raise
            return json.loads(text, strict=False, object_pairs_hook=_unique, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as error:
        raise AgentError("MOSS: invalid complete JSON document") from error


def _encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _prompt_text(text):
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_PROMPT_CHARS:
        _fail("Final Prompt must contain 1-12000 characters")
    return text.strip()


def _caption(text):
    text = _prompt_text(text)
    _text(text, "caption")
    if chr(96) * 3 in text or text.casefold().startswith(("here is", "here's", "sure,", "prompt:", "final prompt:")):
        _fail("caption must contain only the image prompt, without a wrapper")
    return text


def _layout(value, *, draft=False):
    root = {"summary", "items", "bbox_coord_space", "bbox_format"}
    if draft:
        root |= {"width", "height"}
    _object(value, root, root, "Layout")
    expected_space, expected_format = ("abs", "xyxy") if draft else ("abs_centralized", "yxyx")
    if value["bbox_coord_space"] != expected_space or value["bbox_format"] != expected_format:
        _fail("Layout requires " + expected_space + "/" + expected_format + " coordinates")
    if draft and any(type(value[key]) is not int or value[key] <= 0 for key in ("width", "height")):
        _fail("canvas width and height must be positive integers")
    summary = value["summary"]
    _object(summary, {"caption", "meta", "canvas", "palette"}, {"caption"}, "summary")
    _text(summary["caption"], "summary.caption")
    if "canvas" in summary and summary["canvas"] not in ("single", "multi_panel", "collage"):
        _fail("summary.canvas is invalid")
    for name in ("meta", "palette"):
        if name in summary:
            _strings(summary[name], "summary." + name)
    items = value["items"]
    if not isinstance(items, list) or not items:
        _fail("items must be a nonempty flat array")
    for index, item in enumerate(items):
        location = "items[" + str(index) + "]"
        _object(item, {"label", "caption", "bbox", "text", "tags", "palette"}, {"label", "caption", "bbox"}, location)
        if item["label"] not in ("object", "character", "text"):
            _fail(location + ".label is invalid")
        _text(item["caption"], location + ".caption")
        if item["label"] == "text" or "text" in item:
            _text(item.get("text"), location + ".text")
        for name in ("tags", "palette"):
            if name in item:
                _strings(item[name], location + "." + name)
        box = item["bbox"]
        if (not isinstance(box, list) or len(box) != 4 or
                any(type(n) not in ((int, float) if draft else (int,)) or
                    (isinstance(n, float) and not math.isfinite(n)) for n in box)):
            _fail(location + ".bbox requires four " + ("finite numbers" if draft else "integers"))
        a, b, c, d = box
        if a >= c or b >= d:
            _fail(location + ".bbox must have positive area")
        if draft and not (0 <= a < c <= value["width"] and 0 <= b < d <= value["height"]):
            _fail(location + ".bbox lies outside the canvas")
    return value


def requested_format(instruction):
    """Recognize explicitly named modes; scene-based automatic choice stays with MOSS."""
    choice = ""
    for match in re.finditer(r"(?<![A-Za-z])(layout|caption)(?![A-Za-z])", instruction, re.I):
        before = instruction[max(0, match.start() - 24):match.start()]
        after = instruction[match.end():match.end() + 20]
        clause_before = re.split(r"[。！？;；,，\n]", before)[-1]
        conditional = (re.search(r"是否|要不要|需不需要|(?:whether|decide\s+if)\b", clause_before, re.I) or
                       re.match(r"\s+(?:if\s+(?:needed|necessary|appropriate)|as\s+needed)\b", after, re.I))
        if conditional:
            continue
        negative = (re.search(r"(?:\b(?:no|not|without|avoid|don't)(?:\s+use)?|(?:不要|不用|无需|不需要)(?:使用|用)?)\s*$", before, re.I)
                    or re.match(r"\s+(?:is\s+)?(?:not\s+(?:needed|required)|unnecessary)\b", after, re.I))
        # Lowercase descriptive phrases such as "a spacious layout" are not
        # explicit mode selectors; let the skill make its scene-based choice.
        directive = (match.group(1)[:1].isupper() or negative or not before.strip() or
                     re.search(r"(?:\b(?:use|choose|prefer|output|return|generate)(?:\s+in)?|使用|采用|输出|返回|生成|要求|用)\s*$", before, re.I) or
                     re.match(r"(?:\s+(?:json|mode|format)\b|模式|格式|输出)", after, re.I))
        if not directive:
            continue
        named = match.group(1).casefold()
        choice = ("caption" if named == "layout" else "layout") if negative else named
    return choice


def _requested_canvas(instruction):
    values = set(re.findall(r"\b(\d{2,5})\s*[x×]\s*(\d{2,5})\b", instruction, re.I))
    return tuple(int(n) for n in next(iter(values))) if len(values) == 1 else None


def normalize_layout_draft(text, canvas=None):
    """Use the supplied canvas exactly; scale boxes only when canvases differ."""
    if isinstance(text, dict):
        text = _encode(text)
    if not isinstance(text, str) or not text.lstrip().startswith("{"):
        return text
    value = _decode(text, recover_line_breaks=True)
    if not isinstance(value, dict) or set(value) == {"caption"}:
        return _encode(value)
    width, height = value.get("width"), value.get("height")
    if any(type(n) is not int or n <= 0 for n in (width, height)):
        _fail("canvas dimensions must be positive integers")
    # Validate geometry; malformed/outside boxes still fail.
    if canvas is not None and any(type(n) is not int or n <= 0 for n in canvas):
        _fail("source canvas dimensions are invalid")
    aligned = list(canvas or (width, height))
    if (width, height) == tuple(aligned):
        _layout(value, draft=True)
        return _encode(value)
    if isinstance(value.get("items"), list):
        for item in value["items"]:
            if not isinstance(item, dict):
                _fail("Layout item must be an object")
            box = item.get("bbox")
            if not isinstance(box, list) or len(box) != 4 or any(type(n) not in (int, float) or not math.isfinite(n) for n in box):
                _fail("bbox requires four finite numbers")
            item["bbox"] = [n * aligned[i % 2] / (width if i % 2 == 0 else height) for i, n in enumerate(box)]
    value["width"], value["height"] = aligned
    _layout(value, draft=True)
    return _encode(value)


def compile_expansion_prompt(text, instruction=""):
    """Compile a model's absolute draft; never trust model-computed centered boxes."""
    text = _prompt_text(text)
    choice = requested_format(instruction)
    if not text.startswith(("{", "[")):
        if choice == "layout":
            _fail("explicit Layout request requires a pixel Layout draft, not Caption prose")
        return _caption(text)
    value = _decode(text)
    if isinstance(value, dict) and set(value) == {"caption"}:
        if choice == "layout":
            _fail("explicit Layout request requires a pixel Layout draft")
        return _caption(value["caption"])
    if choice == "caption":
        _fail("explicit Caption request must not return Layout")
    _layout(value, draft=True)
    canvas = _requested_canvas(instruction)
    if canvas and (value["width"], value["height"]) != canvas:
        _fail("Layout canvas differs from the requested dimensions")
    width, height = value["width"], value["height"]
    compiled = []
    for item in value["items"]:
        left, top, right, bottom = item["bbox"]
        row = dict(item)
        # Outward rounding in pixel space precedes center subtraction and y/x reorder.
        row["bbox"] = [math.floor(round(top, 9)) - height // 2,
                       math.floor(round(left, 9)) - width // 2,
                       math.ceil(round(bottom, 9)) - height // 2,
                       math.ceil(round(right, 9)) - width // 2]
        compiled.append(row)
    result = {"summary": value["summary"], "items": compiled,
              "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
    _layout(result)
    return _encode(result)


def layout_dimensions(draft_text):
    """Canvas guidance belongs outside the compiled Final Prompt string."""
    text = _prompt_text(draft_text)
    if not text.startswith(("{", "[")):
        return {}
    value = _decode(text)
    if isinstance(value, dict) and set(value) == {"caption"}:
        return {}
    _layout(value, draft=True)
    return {"layout_width": value["width"], "layout_height": value["height"]}


def validate_skill_prompt(profile, text, skill_id=""):
    """Final gate for expansion, confirmation and snapshot; ordinary profiles stay strict."""
    if skill_id != MOSS_SKILL_ID:
        return profile.validate_snapshot(text)
    text = _prompt_text(text)
    if text.startswith(("{", "[")):
        return _encode(_layout(_decode(text)))
    return _caption(text)


def is_layout_prompt(text, skill_id=""):
    return skill_id == MOSS_SKILL_ID and isinstance(text, str) and text.lstrip().startswith(("{", "["))


def retain_moss_names(prompt, names, copyrights=()):
    """Retain tagger identity in global prose, never mutate exact text items or boxes."""
    def normalized(text):
        return re.sub(r"[^\w]+", " ", text.replace("_", " ")).casefold().strip()
    missing = [name.replace("_", " ") for name in [*names, *copyrights]
               if normalized(name) not in normalized(prompt)]
    if not missing:
        return prompt
    prefix = "Featuring " + ", ".join(missing) + ". "
    if prompt.startswith("{"):
        value = _layout(_decode(prompt))
        value["summary"]["caption"] = prefix + value["summary"]["caption"]
        return _encode(value)
    return prefix + prompt


def requested_lettering_language(instruction):
    """Recognize explicit target-Chinese lettering edits, not prompt prose language."""
    pattern = (r"(?:翻译|转换|转写|改写|替换|改|换|转|译|写)(?:成|为|到)?\s*"
               r"(?:成|为|到)?\s*(?:简体|繁体)?中文|汉化|"
               r"(?:台词|对白|对话|文字|字幕)[^。；;\n]{0,12}?(?:用|使用|写成)(?:简体|繁体)?中文|"
               r"\b(?:translate|convert|rewrite)[^.;\n]{0,60}?\b(?:into|to|in)\s+(?:simplified\s+|traditional\s+)?Chinese\b")
    target = ""
    for match in re.finditer(pattern, instruction, re.I):
        before = instruction[max(0, match.start() - 12):match.start()]
        if re.search(r"(?:不要|无需|不用|不必|禁止|不需要|别)\s*$|\b(?:not|never|don't)\s*$", before, re.I):
            continue
        target = "zh"
    return target


def validate_lettering_language(prompt, instruction, *, expect_text=False):
    """Reject detectable source-language leftovers; not a semantic translation grader."""
    if requested_lettering_language(instruction) != "zh":
        return
    if prompt.startswith("{"):
        value = _decode(prompt)
        texts = [(i, row) for i, row in enumerate(value.get("items", [])) if row.get("label") == "text"]
        if expect_text and not texts:
            _fail("要求中文台词，但 Layout 遗漏文字区域；请保留各气泡和归属并翻译，不得删除台词")
        fields = [(f"items[{i}].text", row.get("text", "")) for i, row in texts]
        descriptions = [value.get("summary", {}).get("caption", ""), *[row.get("caption", "") for _, row in texts]]
    else:
        fields = [("Caption", prompt)]
        descriptions = []
    for location, text in fields:
        foreign = re.search(r"[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f\uac00-\ud7af]", text)
        han = re.search(r"[\u3400-\u9fff]", text)
        if foreign or (re.search(r"[A-Za-z]", text) and not han and (expect_text or location != "Caption")):
            _fail(f"{location} 未落实中文翻译：请把该区域的原文翻译为中文，保留说话人、气泡位置和含义")
        if location != "Caption" and re.search(r"[A-Za-z]{2,}(?:[ \t\n]+[A-Za-z]{2,})+", text):
            _fail(f"{location} 仍包含英文台词；目标是中文，仅专名或必要缩写可保留")
    if any(re.search(r"\b(?:Japanese|English|Korean)\s+(?:dialogue|speech|lettering|text|words)\b", caption, re.I) for caption in descriptions):
        _fail("台词已要求中文，但文字区域描述仍指定源语言；请改成 Chinese dialogue/lettering，保留原气泡归属与坐标")
