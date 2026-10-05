"""Recover missing runtime strings from a *verified* completed execution.

This is a fallback for older PNGs, not a guess from display widgets. The file's
full output path, save node, execution time and entire API input graph must match
one history entry. Only documented, transparent scalar display receipts can
attest a source output slot. Node titles and stored widget text are never used.
"""
import json
import math
from pathlib import PurePosixPath

try:
    from .output_metadata import parse_output_metadata
except ImportError:
    from services.output_metadata import parse_output_metadata

MAX_HISTORY = 64
MAX_NODES = 4096
MAX_GRAPH_BYTES = 4 * 1024 * 1024
MAX_TEXT_BYTES = 32 * 1024
# Contracts verified against the node implementation: input -> scalar UI output.
# Add a contract only when it preserves the actual value, including output slots.
DISPLAY_CONTRACTS = {'easy showAnything': ('anything', 'text')}


def input_graph(graph):
    """Execution inputs only; _meta/is_changed are presentation/cache state."""
    if not isinstance(graph, dict) or not graph or len(graph) > MAX_NODES:
        return None
    result = {}
    for key, node in graph.items():
        if not isinstance(key, str) or not isinstance(node, dict):
            return None
        kind, inputs = node.get('class_type'), node.get('inputs')
        if not isinstance(kind, str) or not isinstance(inputs, dict):
            return None
        result[key] = {'class_type': kind, 'inputs': inputs}
    try:
        if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_GRAPH_BYTES:
            return None
    except (ValueError, TypeError, RecursionError, UnicodeError):
        return None
    return result


def _path(folder, filename):
    if not isinstance(folder, str) or not isinstance(filename, str):
        return None
    value = folder.rstrip('/\\') + '/' + filename if folder else filename
    value = value.replace('\\', '/')
    parts = PurePosixPath(value)
    if parts.is_absolute() or '..' in parts.parts or ':' in value:
        return None
    return str(parts)


def _time_matches(item, run_id, mtime):
    status = item.get('status', {})
    if not isinstance(status, dict) or status.get('status_str') != 'success' or status.get('completed') is not True:
        return False
    stamps = {}
    messages = status.get('messages', [])
    if not isinstance(messages, list) or len(messages) > MAX_NODES:
        return False
    for message in messages:
        if not isinstance(message, (list, tuple)) or len(message) != 2:
            continue
        kind, event = message
        if kind not in ('execution_start', 'execution_success') or not isinstance(event, dict):
            continue
        stamp = event.get('timestamp')
        if event.get('prompt_id') == run_id and isinstance(stamp, (int, float)) and not isinstance(stamp, bool) and math.isfinite(stamp):
            stamps[kind] = stamp
    start, end = stamps.get('execution_start'), stamps.get('execution_success')
    # Filesystems may round timestamps to seconds; allow one second of precision.
    return start is not None and end is not None and start <= end and start - 1000 <= mtime * 1000 <= end + 1000


def recover_prompt_fields(graph, relative_path, mtime, history):
    """Return the five prompt fields or None; never mutate a PNG/history entry."""
    canonical = input_graph(graph)
    if canonical is None or not isinstance(history, dict) or len(history) > MAX_HISTORY:
        return None
    if not isinstance(mtime, (int, float)) or isinstance(mtime, bool) or not math.isfinite(mtime):
        return None
    target = _path('', relative_path)
    if target is None:
        return None
    matches = []
    for run_id, item in history.items():
        if not isinstance(item, dict) or not _time_matches(item, run_id, mtime):
            continue
        prompt = item.get('prompt')
        if not isinstance(prompt, (list, tuple)) or len(prompt) < 3 or prompt[1] != run_id:
            continue
        outputs = item.get('outputs')
        if not isinstance(outputs, dict) or len(outputs) > MAX_NODES:
            continue
        save_nodes = []
        for node_id, output in outputs.items():
            if not isinstance(output, dict):
                continue
            images = output.get('images', [])
            if not isinstance(images, list) or len(images) > MAX_NODES:
                continue
            if any(isinstance(image, dict) and image.get('type') == 'output'
                   and _path(image.get('subfolder', ''), image.get('filename')) == target for image in images):
                save_nodes.append(str(node_id))
        if len(save_nodes) != 1 or input_graph(prompt[2]) != canonical:
            continue
        matches.append((save_nodes[0], outputs))
    if len(matches) != 1:
        return None
    save_node, outputs = matches[0]
    texts, conflicts = {}, set()
    for node_id, node in canonical.items():
        contract = DISPLAY_CONTRACTS.get(node['class_type'])
        output = outputs.get(node_id)
        if contract is None or not isinstance(output, dict):
            continue
        input_name, output_name = contract
        edge = node['inputs'].get(input_name)
        values = output.get(output_name)
        if (not isinstance(edge, list) or len(edge) != 2 or not isinstance(edge[0], str)
                or not isinstance(edge[1], int) or isinstance(edge[1], bool) or edge[1] < 0
                or not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], str)):
            continue
        text = values[0]
        if not text.strip() or len(text.encode('utf-8')) > MAX_TEXT_BYTES:
            continue
        key = tuple(edge)
        if key in texts and texts[key] != text:
            conflicts.add(key)
        texts[key] = text
    texts = {key: text for key, text in texts.items() if key not in conflicts}
    if not texts:
        return None
    used = set()
    result = parse_output_metadata(graph, save_node, runtime_texts=texts, used_runtime=used)
    if not used or not result['prompt'] or result['promptStatus'] in ('ambiguous', 'missing'):
        return None
    result['promptStatus'] = 'partial'
    result['promptWarnings'].append('正文已由同次执行的文本输出恢复；未记录的运行期转换仍无法完整核验')
    return result
