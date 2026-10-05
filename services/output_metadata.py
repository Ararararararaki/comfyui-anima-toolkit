"""Pure Outputs prompt reconstruction; never executes nodes or reads user state.

Edges retain output slots. Only text/conditioning inputs with known semantics
are interpreted; unknown transforms keep confirmed inputs and report partial.
"""
from __future__ import annotations

import json
import re

# 4: the same prompt-provenance record consumer landed in anima_gallery.build_entry, so the
#    index semantics changed again (record-first prompt, static graph as fallback).
PARSER_VERSION = 5
_SEPARATORS = {"逗号 ,": ", ", "空格": " ", "换行": "\n", "无": ""}
_CONTENT_KEYS = ("text", "prompt", "value", "positive", "negative", "text_g", "text_l", "clip_l", "t5xxl", "natural_language")
_IMAGE_KEYS = {"images", "image", "samples", "latent", "latent_image", "pixels", "input_image", "image_a", "image_b", "image1", "image2", "image_1", "image_2", "latents"}


def image_dependency_nodes(graph, output_node_id):
    """Conservative IMAGE/LATENT dependency spine, not pixel identity proof.

    Stop at multi-input routing whose selected branch is unknown. Runtime
    receipts, not node names, decide which visited nodes actually sampled.
    """
    nodes = normalize_graph(graph)
    root = nodes.get(output_node_id)
    if not root or not any(key in root['refs'] for key in ('images', 'image')):
        return set(), ['保存节点未提供可核验的图像输入']
    visited, active, warnings = set(), set(), []
    def visit(node_id):
        if node_id in active:
            warnings.append('图像依赖包含循环')
            return
        if node_id in visited:
            return
        if len(visited) >= 4096 or len(active) >= 256:
            warnings.append('图像依赖超过解析上限')
            return
        node = nodes.get(node_id)
        if node is None:
            warnings.append('图像依赖引用缺失节点')
            return
        visited.add(node_id)
        edges = [edge for key, edge in node['refs'].items()
                 if key in _IMAGE_KEYS or node['inputTypes'].get(key) in ('IMAGE', 'LATENT')]
        if len(edges) > 1:
            warnings.append('未记录图像分流的实际选择；更早阶段未补猜')
            return
        active.add(node_id)
        for edge in edges:
            visit(edge[0])
        active.remove(node_id)
    visit(output_node_id)
    return visited, list(dict.fromkeys(warnings))[:64]


def _segments(values):
    out = []
    for value in values:
        if not isinstance(value, str):
            continue
        value = value.strip()
        if value and value not in out:
            out.append(value)
    return out


def _join(values, separator=", "):
    return separator.join(_segments(values))


def _ref(value):
    if isinstance(value, (list, tuple)) and len(value) == 2 and isinstance(value[0], (str, int)) and isinstance(value[1], int) and not isinstance(value[1], bool):
        return str(value[0]), value[1]
    return None


def _widget_names(ctype):
    lower = ctype.lower()
    if lower == "cliptextencodesdxl":
        return ("width", "height", "crop_w", "crop_h", "target_width", "target_height", "text_g", "text_l")
    if lower == "cliptextencodesdxlrefiner":
        return ("ascore", "width", "height", "text")
    if lower == "cliptextencodeflux":
        return ("clip_l", "t5xxl", "guidance")
    if "cliptextencode" in lower:
        return ("text",)
    if lower in ("tkpromptcards", "tk prompt cards"):
        return ("positive", "opt_text", "lora_syntax", "prompt_pieces")
    if "primitive" in lower or lower in ("string", "string constant", "stringconstant", "text", "textconstant", "string literal"):
        return ("value",)
    if "weilinpromptui" in lower:
        return ("positive", "auto_random", "lora_str", "temp_str", "temp_lora_str", "random_template")
    if lower in ("tk text join", "animatextjoin"):
        return ("text_a", "separator", "text_b", "text_c", "text_d")
    if lower in ("tk string router", "animastringrouter"):
        return ("separator", "router_settings")
    if "danboorugallery" in lower:
        return ("selection_data",)
    return ()


def normalize_graph(graph):
    """UI links / API references -> ordered values and (nodeId, slot) edges."""
    if isinstance(graph, dict) and isinstance(graph.get("nodes"), list):
        nodes = graph["nodes"]
        links = graph.get("links", [])
    elif isinstance(graph, list):
        nodes, links = graph, []
    elif isinstance(graph, dict):
        nodes = [dict(value, id=key) for key, value in graph.items() if isinstance(value, dict)]
        links = []
    else:
        return {}
    link_map = {}
    for link in links if isinstance(links, list) else []:
        if isinstance(link, list) and len(link) >= 4:
            link_map[str(link[0])] = (str(link[1]), link[2])
        elif isinstance(link, dict):
            origin = link.get("origin_id")
            if origin is not None:
                link_map[str(link.get("id"))] = (str(origin), link.get("origin_slot", 0))
    result = {}
    for raw in nodes:
        if not isinstance(raw, dict) or raw.get("id") is None:
            continue
        node_id = str(raw["id"])
        ctype = str(raw.get("class_type") or raw.get("type") or "")
        inputs = raw.get("inputs")
        values, refs, types = {}, {}, {}
        widgets = raw.get("widgets_values")
        widgets = widgets if isinstance(widgets, list) else []
        schema = _widget_names(ctype)
        if "weilinpromptui" in ctype.lower() and len(widgets) > 1 and isinstance(widgets[1], str):
            schema = ("positive", "negative")
        if isinstance(inputs, list):
            for index, name in enumerate(schema):
                if index < len(widgets):
                    values[name] = widgets[index]
        if isinstance(inputs, dict):
            for key, value in inputs.items():
                edge = _ref(value)
                if edge:
                    refs[key] = edge
                else:
                    values[key] = value
        elif isinstance(inputs, list):
            widget_index = 0
            for slot in inputs:
                if not isinstance(slot, dict):
                    continue
                name = str(slot.get("name") or "")
                types[name] = str(slot.get("type") or "")
                edge = link_map.get(str(slot.get("link"))) if slot.get("link") is not None else None
                if edge:
                    refs[name] = edge
                widget = slot.get("widget")
                if isinstance(widget, dict):
                    widget_name = str(widget.get("name") or name)
                    if "value" in widget:
                        values[widget_name] = widget["value"]
                    elif widget_name not in values and widget_index < len(widgets):
                        values[widget_name] = widgets[widget_index]
                    widget_index += 1
                elif "value" in slot:
                    values[name] = slot["value"]
        for index, name in enumerate(schema):
            if name not in values and name not in refs and index < len(widgets):
                values[name] = widgets[index]
        props = raw.get("properties")
        if ctype.lower() in ("tk string router", "animastringrouter"):
            # Hidden router state is serialized differently by older frontends.
            if isinstance(props, dict):
                for name in ("router_settings", "routerSettings"):
                    if name in props:
                        values["router_settings"] = props[name]
            for value in widgets:
                if isinstance(value, str):
                    try:
                        parsed = json.loads(value)
                    except (TypeError, ValueError):
                        continue
                    if isinstance(parsed, dict) and any(key in parsed for key in ("enabled", "selected", "order")):
                        values["router_settings"] = value
        result[node_id] = {"id": node_id, "type": ctype, "values": values, "refs": refs, "inputTypes": types,
                           "label": str(raw.get("title") or ctype), "outputs": raw.get("outputs", []), "mode": raw.get("mode", 0)}
    return result


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() not in {"", "0", "false", "off", "no", "none"}


def _router_settings(raw):
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        parsed = {}
    parsed = parsed if isinstance(parsed, dict) else {}
    enabled = parsed.get("enabled")
    enabled = [_as_bool(enabled[i]) if i < len(enabled) else False for i in range(6)] if isinstance(enabled, list) else [True, False, False, False, False, False]
    try:
        selected = int(parsed.get("selected", 0))
    except (ValueError, TypeError):
        selected = 0
    selected = selected if 0 <= selected < 6 else 0
    order = []
    for value in parsed.get("order", parsed.get("output_order", [])) if isinstance(parsed.get("order", parsed.get("output_order", [])), list) else []:
        try:
            value = int(value)
        except (ValueError, TypeError):
            continue
        if 0 <= value < 6 and value not in order:
            order.append(value)
    order += [i for i in range(6) if i not in order]
    return enabled, [selected] if parsed.get("mode", "single") != "multi" else order


class _Parser:
    def __init__(self, nodes, runtime_texts=None, used_runtime=None):
        self.nodes = nodes
        self.runtime_texts = runtime_texts or {}
        self.used_runtime = used_runtime if used_runtime is not None else set()
        self.warnings = []
        self.active = set()
        self.memo = {}
        self.steps = 0
        self.ambiguous = False

    def warn(self, message):
        if message not in self.warnings:
            self.warnings.append(message)

    def field(self, node, key, role):
        if key in node["refs"]:
            return self.text(node["refs"][key], role)
        value = node["values"].get(key)
        return [value] if isinstance(value, str) and value.strip() else []

    def fields(self, node, keys, role):
        return _segments(part for key in keys for part in self.field(node, key, role))

    def text(self, edge, role):
        node_id, slot = edge
        runtime = self.runtime_texts.get((node_id, slot))
        if isinstance(runtime, str) and runtime.strip():
            self.used_runtime.add((node_id, slot))
            return [runtime]
        key = (node_id, slot, role)
        if key in self.memo:
            return self.memo[key]
        if key in self.active or len(self.active) > 128 or self.steps > 4096:
            self.warn("提示词连线包含循环或超过解析上限")
            return []
        node = self.nodes.get(node_id)
        if node is None:
            self.warn("提示词连线引用不存在的节点 " + node_id)
            return []
        self.active.add(key)
        self.steps += 1
        try:
            result = self.node_text(node, slot, role)
        finally:
            self.active.remove(key)
        self.memo[key] = _segments(result)
        return self.memo[key]

    def node_text(self, node, slot, role):
        ct, values = node["type"].lower(), node["values"]
        if "cliptextencode" in ct:
            return self.fields(node, ("text", "text_g", "text_l", "clip_l", "t5xxl"), role)
        if ct == "conditioningcombine":
            return self.fields(node, ("conditioning_1", "conditioning_2"), role)
        if ct in ("conditioningconcat", "conditioningaverage"):
            strength = values.get("conditioning_to_strength", 0.5)
            if ct == "conditioningaverage":
                try:
                    strength = float(strength)
                except (ValueError, TypeError):
                    self.warn("ConditioningAverage 权重未记录")
                    strength = 0.5
                if strength >= 1:
                    return self.field(node, "conditioning_to", role)
            source_edge = node["refs"].get("conditioning_from")
            source_node = self.nodes.get(source_edge[0]) if source_edge else None
            source_type = source_node["type"].lower() if source_node else ""
            if source_type == "conditioningcombine":
                # ComfyUI consumes conditioning_from[0]. A single SDXL
                # conditioning still has both text encoders, not two groups.
                self.warn("ConditioningConcat/Average 仅使用来源条件的首项")
                source = self.field(source_node, "conditioning_1", role)
            else:
                source = self.field(node, "conditioning_from", role)
                if len(source) > 1 and not ("cliptextencode" in source_type or source_type in ("tkpromptcards", "tk prompt cards") or "weilinpromptui" in source_type):
                    self.warn("来源条件的分组未完整记录，无法确认首项全部文本")
            if ct == "conditioningaverage" and strength <= 0:
                return source
            return _segments(self.field(node, "conditioning_to", role) + source)
        if ct == "conditioningzeroout":
            self.warn("ConditioningZeroOut 已清零文本条件")
            return []
        if "controlnet" in ct and ("apply" in ct):
            if "negative" in node["refs"] or "negative" in values:
                return self.field(node, "positive" if slot == 0 else "negative", "positive" if slot == 0 else "negative")
            return self.field(node, "conditioning", role)
        if ct in ("tkpromptcards", "tk prompt cards"):
            if slot == 2:
                self.warn("LoRA 语法输出不属于提示词")
                return []
            return [_join(self.fields(node, ("positive", "opt_text"), role))]
        if "weilinpromptui" in ct:
            if values.get("auto_random"):
                self.warn("魏林节点的随机文本未完整写入图片")
            if "negative" in values or "negative" in node["refs"]:
                return self.field(node, "negative" if slot == 1 else "positive", "negative" if slot == 1 else "positive")
            if slot not in (0, 1):
                self.warn("魏林节点非文本输出")
                return []
            positive = self.field(node, "positive", role)
            decoded, has_lora = [], False
            for part in positive:
                try:
                    data = json.loads(part)
                except (ValueError, TypeError):
                    data = None
                if isinstance(data, dict):
                    decoded += [data.get("prompt", "")] if isinstance(data.get("prompt"), str) else []
                    has_lora = has_lora or bool(data.get("lora"))
                else:
                    decoded.append(part)
            text = _join(self.field(node, "opt_text", role) + decoded)
            if "<wlr:" in text or ((values.get("lora_str") or has_lora) and "opt_model" in node["refs"]):
                self.warn("魏林 LoRA 触发词是运行期文本，图片未完整记录")
                text = re.sub(r"<wlr:[^>]+>", "", text)
                text = re.sub(r",\s*,", ",", text).strip(" ,")
            return [text]
        if ct in ("tk string router", "animastringrouter"):
            enabled, order = _router_settings(values.get("router_settings", ""))
            parts = [part for index in order if enabled[index] for part in self.field(node, "string_" + str(index + 1), role)]
            separator = values.get("separator", "逗号 ,")
            joined = _join(parts, _SEPARATORS.get(separator, ", "))
            if separator == "逗号 ,":
                joined = re.sub(r"\s*,\s*,+", ",", joined).strip(" ,")
            return [joined]
        if ct in ("tk text join", "animatextjoin", "textconcatenate", "text concatenate", "stringconcatenate", "string concatenate", "joinstrings", "join strings"):
            keys = [key for key in ("text_a", "text_b", "text_c", "text_d", "text1", "text2", "text_1", "text_2", "string_a", "string_b", "string_1", "string_2") if key in values or key in node["refs"]]
            sep = values.get("separator", values.get("delimiter", ", "))
            return [_join(self.fields(node, keys, role), _SEPARATORS.get(sep, sep if isinstance(sep, str) else ", "))]
        if "primitive" in ct or ct in ("string", "stringconstant", "string constant", "string literal", "text", "textconstant"):
            return self.fields(node, ("value", "text", "string"), role)
        if "danboorugallery" in ct:
            if slot != 1:
                self.warn("图库非提示词输出无法还原为文本")
                return []
            try:
                data = json.loads(values.get("selection_data", "{}"))
            except (ValueError, TypeError):
                data = {}
            if not isinstance(data, dict):
                data = {}
            if data.get("prompt_output_enabled") is False:
                return []
            selections = data.get("selections", [])
            if not isinstance(selections, list) or len(selections) != 1:
                self.warn("图库批量文本缺少本图的运行期选择索引")
                return []
            item = selections[0] if isinstance(selections[0], dict) else {}
            return [_join((data.get("role_prompt", ""), item.get("prompt", "")))]
        if ct in ("reroute", "conditioningreroute"):
            return self.fields(node, list(node["refs"]), role)
        if ct in ("conditioningsetarea", "conditioningsetareapercentage", "conditioningsettimesteprange", "conditioningsetmask"):
            return self.field(node, "conditioning", role)
        # Recover confirmed text inputs only. Arbitrary widget/configuration
        # strings and MODEL/CLIP/IMAGE references must never become prompts.
        self.warn("无法完整还原节点 " + node["id"] + "（" + node["type"] + "）的运行期文本")
        keys = [key for key in _CONTENT_KEYS if key in values or key in node["refs"]]
        keys = [key for key in keys if key not in ("positive", "negative") or key == role]
        return self.fields(node, keys, role)

    def stage_inputs(self, node):
        if "positive" in node["refs"] or "positive" in node["values"]:
            return node, "positive", "negative"
        if "positive_cond" in node["refs"]:
            return node, "positive_cond", "negative_cond"
        guider = node["refs"].get("guider")
        if guider:
            source = self.nodes.get(guider[0])
            if source:
                return source, "positive" if "positive" in source["refs"] else "conditioning", "negative"
        return None

    def is_sampler(self, node):
        ct = node["type"].lower()
        # The public USDU contract disables both sampling passes in this mode.
        # Merely having positive/negative inputs does not make resize a stage.
        if ct == "ultimatesdupscale" and node["values"].get("mode_type") == "None" and node["values"].get("seam_fix_mode") == "None":
            return False
        return ("sampler" in ct or "upscal" in ct) and self.stage_inputs(node) is not None

    def stages(self, root):
        stages, seen, active = [], set(), set()
        def visit(node_id):
            if node_id in seen:
                return
            if node_id in active or len(active) > 256:
                self.warn("图片生成链包含循环或超过解析上限")
                return
            node = self.nodes.get(node_id)
            if not node:
                self.warn("图片生成链引用不存在的节点 " + node_id)
                return
            active.add(node_id)
            # Multiple unknown image inputs may be a switch, not a blend.
            edges = [edge for key, edge in node["refs"].items()
                     if key in _IMAGE_KEYS or node["inputTypes"].get(key) in ("IMAGE", "LATENT")]
            ct = node["type"].lower()
            known = self.is_sampler(node) or "saveimage" in ct or ct in {
                "vaedecode", "vaedecodetiled", "vaeencode", "vaeencodetiled", "vaeencodeforinpaint",
                "latentupscale", "latentupscaleby", "imagescale", "imagescaleby", "reroute",
                "imageblend", "imagecompositemasked", "latentcomposite", "latentcompositemasked", "ultimatesdupscale"}
            if not known and len(edges) > 1:
                self.ambiguous = True
                self.warn("无法确定图像分流节点 " + node_id + " 的实际输入分支")
                active.remove(node_id)
                seen.add(node_id)
                return
            if not known and edges:
                self.warn("图像转换节点 " + node_id + " 的运行期来源未完整记录")
            for edge in edges:
                visit(edge[0])
            active.remove(node_id)
            seen.add(node_id)
            if self.is_sampler(node):
                source, positive, negative = self.stage_inputs(node)
                prompt = _join(self.field(source, positive, "positive"))
                if not prompt:
                    self.warn("采样阶段 " + node_id + " 的正面文本未完整记录")
                stages.append({"nodeId": node_id, "label": node["label"],
                               "prompt": prompt,
                               "negativePrompt": _join(self.field(source, negative, "negative"))})
        visit(root)
        return stages


def parse_output_metadata(graph, output_node_id=None, *, runtime_texts=None, used_runtime=None):
    """Return exact known text with stage provenance and honest partial status."""
    nodes = normalize_graph(graph)
    parser = _Parser(nodes, runtime_texts, used_runtime)
    result = {"prompt": "", "negativePrompt": "", "promptStages": [], "promptStatus": "missing", "promptWarnings": []}
    saves = [node["id"] for node in nodes.values() if "saveimage" in node["type"].lower()
             and node["mode"] not in (2, 4) and any(key in node["refs"] for key in ("images", "image"))]
    if output_node_id is not None:
        root = str(output_node_id)
        if root not in saves:
            result.update(promptStatus="missing", promptWarnings=["图片的保存节点标识不存在"])
            return result
    elif len(saves) > 1:
        result.update(promptStatus="ambiguous", promptWarnings=["图片包含多个保存分支且未记录对应保存节点"])
        return result
    elif saves:
        root = saves[0]
    else:
        samplers = [node["id"] for node in nodes.values() if parser.is_sampler(node)]
        if len(samplers) > 1:
            result.update(promptStatus="ambiguous", promptWarnings=["缺少保存节点，无法确定本图的采样分支"])
            return result
        if not samplers:
            return result
        root = samplers[0]
        parser.warn("缺少保存节点，按唯一采样分支恢复文本")
    stages = parser.stages(root)
    if parser.ambiguous:
        result.update(promptStatus="ambiguous", promptWarnings=parser.warnings)
        return result
    result["promptStages"] = stages
    result["prompt"] = _join(stage["prompt"] for stage in stages)
    result["negativePrompt"] = _join(stage["negativePrompt"] for stage in stages)
    result["promptWarnings"] = parser.warnings
    result["promptStatus"] = "partial" if parser.warnings else "complete" if stages and result["prompt"] else "missing"
    return result
