"""Saved image semantics shared by gallery summaries and on-demand details.

Container presence and prompt ownership are independent. Recorded graph settings
are retained even when no output branch can be proved; they never fill an
unknown prompt. No image pixels, node execution or user state are touched here.
"""
from __future__ import annotations

import json
import re

from .generation_formats import normalize_generation_raw, parse_generation_fields
from .output_generation import parse_generation_details
from .output_metadata import parse_output_metadata, graph_identity_prompt, output_node_for_filename
from .prompt_record import decode_record

RECORD_KEY = 'tk_prompt_provenance'
# 摘要素引的 loras 沿历史契约剥离扩展名（与旧 _extract_loras 一致）；
# loraDetails[].name 保留完整文件名，那是新的详情契约。
_LORA_EXT_RE = re.compile(r'\.(safetensors|pt|bin)$', re.I)


def is_comfy_graph(value):
    if isinstance(value, dict) and isinstance(value.get('nodes'), list):
        return any(isinstance(node, dict) and isinstance(node.get('type'), str) for node in value['nodes'])
    rows = value if isinstance(value, list) else value.values() if isinstance(value, dict) else ()
    return any(isinstance(node, dict) and isinstance(node.get('class_type'), str) for node in rows)


def _json(text):
    try:
        return json.loads(text) if isinstance(text, str) and text else None
    except (ValueError, TypeError, RecursionError):
        return None


def _record(record_text):
    public = decode_record(record_text) if record_text else None
    wire = _json(record_text) if public else None
    output = wire.get('outputNodeId') if isinstance(wire, dict) and wire.get('imageAssociation') in ('exact', 'dependency') else None
    return public, output or None


def parse_comfy_fields(graph, record_text='', source_filename=''):
    public, output_id = _record(record_text)
    result = parse_output_metadata(graph, output_id)
    filename_id = output_node_for_filename(graph, source_filename) if not output_id and (
        result['promptStatus'] == 'ambiguous' or public and not public.get('prompt')) else None
    output_id = output_id or filename_id
    if filename_id:
        result = parse_output_metadata(graph, filename_id)
    static_prompt = result['prompt']
    if filename_id:
        result['promptWarnings'].append('按文件名与唯一保存前缀匹配分支；静态文本不代表已核验的运行期全文')
        if result['promptStatus'] == 'complete':
            result['promptStatus'] = 'partial'
    details = parse_generation_details(graph, output_id)
    wire = _json(record_text) if public else None
    if isinstance(wire, dict) and wire.get('imageAssociation') in ('unknown', 'ambiguous'):
        details['generationScope'] = 'recorded'
        details['generationOutputNodeId'] = None
        details['generationStatus'] = 'ambiguous' if wire['imageAssociation'] == 'ambiguous' else 'partial'
        details['generationWarnings'] = list(dict.fromkeys([*details.get('generationWarnings', []),
            '图片归属未核验，以下仅为保存工作流的记录配置']))
        for item in details.get('loraDetails', []):
            item['active'] = None
    result.update(details)
    result.update(model=' / '.join(details['checkpoints']), vae=' / '.join(details['vaes']),
                  clipSkip=0, metadataSource='comfyui', hasWorkflow=True)
    for key in ('seed', 'steps', 'cfg', 'sampler', 'scheduler', 'denoise', 'noiseSeed'):
        result[key] = ''
    if details.get('generationScope') == 'output' and details['generationStages']:
        stage = details['generationStages'][-1]
        # sampler 的历史契约：摘要层永不从 sampler_name 填充（stage 级仍有 sampler），
        # 由既有测试 test_record_keeps_graph_identity_fields_untouched 锁定。
        for key in ('seed', 'steps', 'cfg', 'scheduler', 'denoise', 'noiseSeed'):
            result[key] = stage.get(key, '')
    _apply_record(result, record_text, public)
    if filename_id and public and not result['prompt'] and static_prompt:
        result['identityPrompt'] = static_prompt
    result['loras'] = list(dict.fromkeys(
        stripped for stripped in (_LORA_EXT_RE.sub('', item['name']).strip()
                                  for item in details['loraDetails']) if stripped))
    return result


def _apply_record(result, text, public=None):
    if not text:
        return
    public = public if public is not None else decode_record(text)
    if public:
        result.update(public)
    else:
        if result.get('promptStatus') == 'complete':
            result['promptStatus'] = 'partial'
        result['promptWarnings'] = [*result.get('promptWarnings', []),
            '图片内的提示词记录无法读取（损坏或版本不认识）；静态解析结果仅供参考']


def parse_saved_metadata(raw, *, status='present', image_format='unknown', warnings=(), source_filename=''):
    original = dict(raw)
    normalized = normalize_generation_raw(original)
    record = normalized.get(RECORD_KEY, '')
    prompt_graph = _json(normalized.get('prompt', ''))
    workflow_graph = _json(normalized.get('workflow', ''))
    graph = prompt_graph if is_comfy_graph(prompt_graph) else workflow_graph if is_comfy_graph(workflow_graph) else None
    result = {'model': '', 'seed': '', 'steps': '', 'cfg': '', 'sampler': '', 'scheduler': '',
              'denoise': '', 'noiseSeed': '', 'vae': '', 'clipSkip': 0, 'prompt': '',
              'negativePrompt': '', 'promptStages': [], 'promptStatus': 'missing', 'promptWarnings': [],
              'loras': [], 'hasWorkflow': False, 'checkpoints': [], 'textEncoders': [], 'vaes': [],
              'loraDetails': [], 'generationStages': [], 'generationStatus': 'missing',
              'generationWarnings': [], 'generationScope': 'recorded', 'generationOutputNodeId': None}
    if graph is not None:
        result.update(parse_comfy_fields(graph, record, source_filename))
    else:
        result.update(parse_generation_fields(normalized) or {})
        _apply_record(result, record)
    result['hasPrompt'] = bool(result['prompt'])
    if not record and graph is not None and not result['prompt'] and result['promptStatus'] == 'ambiguous':
        result['identityPrompt'] = graph_identity_prompt(graph)
    result['hasWorkflow'] = bool(graph is not None)
    result['workflowJson'] = normalized.get('workflow', '') if is_comfy_graph(workflow_graph) else normalized.get('prompt', '') if is_comfy_graph(prompt_graph) else ''
    result['rawMetadata'] = original
    result['metadataState'] = status
    result['metadataFormat'] = image_format
    result['metadataWarnings'] = list(warnings)
    # A supplied empty raw map alone cannot prove the image was fully scanned.
    if original and status in ('absent', 'unknown'):
        result['metadataState'] = 'present'
    return result
