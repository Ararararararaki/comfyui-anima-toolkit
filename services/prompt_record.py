"""Pure JSON-safe codec for a bounded v1 prompt-provenance record.

Scope: convert an owner-supplied, already-verified newest-first stage chain plus
a *proven* output image ownership into a wire record, and decode that record
back into the public fields a consumer already reads. No runtime observation, no
tensor, no host import, and no dependency on the prototype parent modules: the
only input format accepted is the one documented below.

Contract highlights
-------------------
* ``build_record`` requires ``image_association`` as an explicit argument. It is
  never inferred from the chain. ``exact`` exports verified image text;
  ``dependency`` exports current-execution branch receipts as explicitly partial.
* Text enters the record only from receipts the caller already marked observed
  and verified. Nothing is inferred from node class names, node titles, prompt
  words, channel names, batch indexes, or text similarity.
* A channel that was replaced or cannot be verified never causes the original
  ``text`` of its receipt to be repeated as if it were the encoded prompt.
* Every cap in :data:`POLICY` is a product limit on this document. None of them
  is a claim about a model, a tokenizer, or a workflow.

Documented input format (mappings may be ``MappingProxyType``, sequences may be
tuples; anything else is treated as unreadable rather than copied)::

    stage_chain: newest-first iterable of stage mappings
    stage:   {node_id?, label?, source_state?, evicted?, cycle?,
              positive?: slot|None, negative?: slot|None, ...}
    slot:    {role?, source_state?, entries?: iterable of entry}
    entry:   {index?, role?, status: observed|unobserved|unverifiable,
              source_state?, stage?: receipt}
    receipt: {source_state, text?, truncated?, sources?, channel_sources?,
              channel_state?, replacement_text?, role?, ...}

Any other key is ignored, never copied: a stage mapping is free to carry
``class_name``, ``title`` or similar metadata, and none of it reaches the record.
"""

from __future__ import annotations

import collections.abc
import itertools
import json

# ---------------------------------------------------------------------------
# wire schema
# ---------------------------------------------------------------------------
SCHEMA_VERSION = 1

IMAGE_ASSOCIATION_EXACT = "exact"
IMAGE_ASSOCIATION_DEPENDENCY = "dependency"
IMAGE_ASSOCIATION_AMBIGUOUS = "ambiguous"
IMAGE_ASSOCIATION_UNKNOWN = "unknown"
IMAGE_ASSOCIATIONS = (
    IMAGE_ASSOCIATION_EXACT,
    IMAGE_ASSOCIATION_DEPENDENCY,
    IMAGE_ASSOCIATION_AMBIGUOUS,
    IMAGE_ASSOCIATION_UNKNOWN,
)

# Public status protocol. Four values, and a caller may not invent a fifth.
STATUS_COMPLETE = "complete"
STATUS_PARTIAL = "partial"
STATUS_AMBIGUOUS = "ambiguous"
STATUS_MISSING = "missing"
PUBLIC_STATUSES = (STATUS_COMPLETE, STATUS_PARTIAL, STATUS_AMBIGUOUS, STATUS_MISSING)

# Source states published by the observer protocol.
SOURCE_STATE_COMPLETE = "complete"
SOURCE_STATE_PARTIAL = "partial"
SOURCE_STATE_AMBIGUOUS = "ambiguous"
SOURCE_STATE_UNVERIFIED = "unverified"

# ---------------------------------------------------------------------------
# policy caps
#
# Named product limits on the document this module writes and accepts. They are
# not model facts: nothing here says how long a real prompt may be.
# ---------------------------------------------------------------------------
MAX_RECORD_BYTES = 256 * 1024
MAX_STAGES = 128
MAX_TEXT_BYTES = 32 * 1024
MAX_WARNINGS = 64

# Work bound, not a document limit: how many entries of one slot are inspected
# before the rest are reported as unread. Keeps a pathological slot from costing
# unbounded time while still announcing that something was not read.
MAX_SLOT_ENTRIES = 1024

# Bounds on inspecting an incoming document. A wire record is at most five
# levels deep (record, stages, stage, text list, text), so anything deeper is
# not a record this codec documents; and every measurement stops as soon as the
# byte budget is spent, so a hostile document cannot cost unbounded time.
MAX_VALIDATION_DEPTH = 32
MAX_VALIDATION_NODES = 65536

DEFAULT_STAGE_LABEL = "Sampling"
DEFAULT_NODE_ID = ""

POLICY = {
    "schemaVersion": SCHEMA_VERSION,
    "maxRecordBytes": MAX_RECORD_BYTES,
    "maxStages": MAX_STAGES,
    "maxTextBytes": MAX_TEXT_BYTES,
    "maxWarnings": MAX_WARNINGS,
    "maxSlotEntries": MAX_SLOT_ENTRIES,
    "defaultStageLabel": DEFAULT_STAGE_LABEL,
    "defaultNodeId": DEFAULT_NODE_ID,
}


# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------
def _is_mapping(value):
    return isinstance(value, collections.abc.Mapping)


def _is_sequence(value):
    """A readable non-mapping iterable, or None.

    Strings and bytes are excluded because iterating one yields characters, not
    entries, and reporting that as a chain would invent structure.
    """
    if value is None or isinstance(value, (str, bytes, bytearray)):
        return None
    if _is_mapping(value):
        return None
    if isinstance(value, collections.abc.Iterable):
        return value
    return None


def utf8_len(text):
    """UTF-8 byte length of ``text``, counting a lone surrogate as 6 bytes.

    A lone surrogate has no UTF-8 form at all; the JSON text that carries it
    spells it as ``\\udXXX``, so six bytes is what it costs a document that will
    be parsed. Measuring it as one byte (the length of a replacement character)
    would understate a serialised payload and let it slip past the byte cap.
    """
    if not isinstance(text, str):
        return 0
    try:
        return len(text.encode("utf-8"))
    except UnicodeEncodeError:
        total = 0
        for character in text:
            code = ord(character)
            if 0xD800 <= code <= 0xDFFF:
                total += 6
            else:
                total += len(character.encode("utf-8"))
        return total


def truncate_utf8(text, limit=MAX_TEXT_BYTES):
    """Cut ``text`` to ``limit`` UTF-8 bytes at a valid code point boundary.

    Returns ``(text, truncated)``. A cut is always announced by the caller; it
    is never presented as the whole value.
    """
    if not isinstance(text, str):
        return None, False
    if limit < 1:
        limit = 1
    try:
        raw = text.encode("utf-8")
    except UnicodeEncodeError:
        # A lone surrogate cannot be encoded; replacing it keeps the document
        # JSON-safe instead of failing the whole record.
        raw = text.encode("utf-8", "replace")
        text = raw.decode("utf-8")
    if len(raw) <= limit:
        return text, False
    cut = raw[:limit]
    while cut:
        try:
            return cut.decode("utf-8"), True
        except UnicodeDecodeError:
            cut = cut[:-1]
    return "", True


def _serialized(record):
    return json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def _bounded_measure(value, budget=MAX_RECORD_BYTES):
    """Lower bound of the JSON byte size of ``value``, or None.

    Iterative, so no input can exhaust the interpreter stack, and bounded by
    depth, node count and budget, so a hostile document cannot cost unbounded
    time or memory. ``None`` means the value cannot be measured at all: it is
    nested past :data:`MAX_VALIDATION_DEPTH`, cyclic, or holds something with no
    JSON form. Callers treat that as a rejection, never as a small value.

    A budget overrun returns ``budget + 1`` rather than ``None``, because the
    document is then merely too large — a different answer from unmeasurable.
    """
    total = 0
    nodes = 0
    seen = set()
    stack = [(value, 0)]
    while stack:
        item, depth = stack.pop()
        nodes += 1
        if nodes > MAX_VALIDATION_NODES or depth > MAX_VALIDATION_DEPTH:
            return None
        if item is None or item is True or item is False:
            total += 5
        elif isinstance(item, str):
            total += utf8_len(item) + 2
        elif isinstance(item, (int, float)):
            total += 24
        elif isinstance(item, (list, tuple)):
            marker = id(item)
            if marker in seen:
                return None
            seen.add(marker)
            total += 2
            for child in item:
                stack.append((child, depth + 1))
        elif _is_mapping(item):
            marker = id(item)
            if marker in seen:
                return None
            seen.add(marker)
            total += 2
            for key, child in item.items():
                total += (utf8_len(key) + 3) if isinstance(key, str) else 24
                stack.append((child, depth + 1))
        else:
            # No JSON form: it cannot be measured, so it cannot be trusted.
            return None
        if total > budget:
            return budget + 1
    return total


class _Warnings:
    """Bounded, de-duplicated warning collector.

    The internal list is capped as well, so a pathological chain cannot grow it
    without bound; the suppressed count is reported instead of the messages.
    """

    def __init__(self, limit=MAX_WARNINGS):
        self._limit = max(1, int(limit))
        self._items = []
        self._seen = set()
        self._suppressed = 0

    def add(self, message):
        if not isinstance(message, str) or not message:
            return
        message, _ = truncate_utf8(message, MAX_TEXT_BYTES)
        if message in self._seen:
            return
        if len(self._items) >= self._limit * 4:
            self._suppressed += 1
            return
        self._seen.add(message)
        self._items.append(message)

    def freeze(self):
        items = list(self._items)
        extra = self._suppressed
        if len(items) > self._limit:
            extra += len(items) - (self._limit - 1)
            items = items[: self._limit - 1]
        if extra:
            items.append("%d additional warnings suppressed" % extra)
        return items


def _worst(states):
    """Fold statuses into the one that must be published.

    Ambiguity dominates because a contradicted source is worse than an
    incomplete one; ``missing`` is only published when nothing was readable at
    all, otherwise it degrades to ``partial``.
    """
    states = [state for state in states if state]
    if not states:
        return STATUS_COMPLETE
    if STATUS_AMBIGUOUS in states:
        return STATUS_AMBIGUOUS
    if STATUS_PARTIAL in states:
        return STATUS_PARTIAL
    if all(state == STATUS_MISSING for state in states):
        return STATUS_MISSING
    if STATUS_MISSING in states:
        return STATUS_PARTIAL
    return STATUS_COMPLETE


def _downgrade(status):
    if status == STATUS_COMPLETE:
        return STATUS_PARTIAL
    return status


def _text_fragments(value, warnings, where):
    """``[(text, truncated)]`` from a documented text field.

    Accepts one string or a list of strings. Anything else is reported rather
    than coerced, because coercing a structure into a string would present
    something unobserved as prompt text.
    """
    out = []
    if value is None:
        return out
    if isinstance(value, str):
        candidates = (value,)
    elif isinstance(value, (list, tuple)):
        candidates = value
    else:
        warnings.add("%s: text field is neither a string nor a string list" % where)
        return out
    for item in candidates:
        if not isinstance(item, str):
            warnings.add("%s: ignored a non-string text fragment" % where)
            continue
        if not item:
            continue
        text, cut = truncate_utf8(item, MAX_TEXT_BYTES)
        if cut:
            warnings.add(
                "%s: text truncated to the %d byte policy cap" % (where, MAX_TEXT_BYTES)
            )
        out.append((text, cut))
    return out


# ---------------------------------------------------------------------------
# receipt -> text
# ---------------------------------------------------------------------------
def _channel_fragments(receipt, warnings, where):
    """Text of a per-channel receipt, or None when it is not a per-channel one.

    Only channels published as ``complete`` contribute. A channel that is
    missing, changed, or unverifiable degrades the result and its text is not
    copied; ``origin_text`` is deliberately never read, because it is the text
    the channel had *before* it was replaced and is not what was encoded.
    """
    sources = receipt.get("channel_sources")
    if not _is_mapping(sources) or not sources:
        return None
    fragments = []
    states = []
    for key in sorted(sources.keys(), key=lambda item: str(item)):
        channel = sources[key]
        label = "%s channel %r" % (where, key)
        if not _is_mapping(channel):
            warnings.add("%s: channel entry is not a readable mapping" % label)
            states.append(STATUS_AMBIGUOUS)
            continue
        state = channel.get("state")
        text = channel.get("text")
        if state == SOURCE_STATE_COMPLETE:
            if isinstance(text, str) and text:
                value, cut = truncate_utf8(text, MAX_TEXT_BYTES)
                if cut:
                    warnings.add(
                        "%s: text truncated to the %d byte policy cap"
                        % (label, MAX_TEXT_BYTES)
                    )
                    states.append(STATUS_PARTIAL)
                else:
                    states.append(STATUS_COMPLETE)
                fragments.append(value)
            else:
                warnings.add("%s: a complete channel published no usable text" % label)
                states.append(STATUS_PARTIAL)
            continue
        if state == "missing":
            warnings.add("%s: channel is missing from the encoded structure" % label)
            states.append(STATUS_PARTIAL)
            continue
        warnings.add(
            "%s: channel state %r is not verified; its text is not copied"
            % (label, state)
        )
        states.append(STATUS_AMBIGUOUS)
    return fragments, states


def _simple_fragments(receipt, warnings, where):
    """Text of a receipt without per-channel proof."""
    state = receipt.get("source_state")
    if receipt.get("replacement_text"):
        warnings.add(
            "%s: a channel was replaced; the original text is not reliable" % where
        )
        return [], [STATUS_AMBIGUOUS]
    if state in (SOURCE_STATE_AMBIGUOUS, SOURCE_STATE_UNVERIFIED):
        warnings.add(
            "%s: source state %r cannot support copyable text" % (where, state)
        )
        return [], [STATUS_AMBIGUOUS]
    if state not in (SOURCE_STATE_COMPLETE, SOURCE_STATE_PARTIAL):
        warnings.add("%s: unknown source state %r; text is not copied" % (where, state))
        return [], [STATUS_AMBIGUOUS]

    fragments = []
    states = []
    items = receipt.get("sources")
    if items is None:
        items = receipt.get("text")
    for value, cut in _text_fragments(items, warnings, where):
        fragments.append(value)
        if cut or state == SOURCE_STATE_PARTIAL:
            states.append(STATUS_PARTIAL)
        else:
            states.append(STATUS_COMPLETE)
    if not fragments:
        if state == SOURCE_STATE_PARTIAL:
            warnings.add("%s: a partial source published no text" % where)
        states.append(
            STATUS_PARTIAL if state == SOURCE_STATE_PARTIAL else STATUS_COMPLETE
        )
    if receipt.get("truncated") is True:
        warnings.add("%s: receipt is marked truncated; the record stays partial" % where)
        states.append(STATUS_PARTIAL)
    return fragments, states


def _receipt_fragments(receipt, role, warnings, where):
    channel_result = _channel_fragments(receipt, warnings, where)
    if channel_result is not None:
        fragments, states = channel_result
        state = receipt.get("source_state")
        if state in (SOURCE_STATE_AMBIGUOUS, SOURCE_STATE_UNVERIFIED):
            # A whole receipt that contradicts itself contributes text only
            # where an individual channel proved its own text.
            states.append(STATUS_AMBIGUOUS)
        elif state == SOURCE_STATE_PARTIAL:
            states.append(STATUS_PARTIAL)
        return fragments, states
    return _simple_fragments(receipt, warnings, where)


def _entry_fragments(entry, role, warnings, where):
    if not _is_mapping(entry):
        warnings.add("%s: entry carries no receipt" % where)
        return [], [STATUS_PARTIAL]
    entry_role = entry.get("role")
    if isinstance(entry_role, str) and entry_role and entry_role != role:
        warnings.add(
            "%s: entry role %r does not match slot %r; skipped" % (where, entry_role, role)
        )
        return [], [STATUS_PARTIAL]
    status = entry.get("status")
    if status == "unverifiable":
        warnings.add("%s: receipt was invalidated; its text is not copied" % where)
        return [], [STATUS_AMBIGUOUS]
    if status != "observed":
        warnings.add("%s: entry was never observed; its text is not copied" % where)
        return [], [STATUS_PARTIAL]
    receipt = entry.get("stage")
    if not _is_mapping(receipt):
        warnings.add("%s: an observed entry carries no readable receipt" % where)
        return [], [STATUS_AMBIGUOUS]
    receipt_role = receipt.get("role")
    if isinstance(receipt_role, str) and receipt_role and receipt_role not in (
        "unassigned",
        role,
    ):
        warnings.add(
            "%s: receipt role %r does not match slot %r; skipped"
            % (where, receipt_role, role)
        )
        return [], [STATUS_PARTIAL]
    return _receipt_fragments(receipt, role, warnings, where)


def _collect_slot(slot, role, warnings, where):
    """``(fragments, states)`` for one explicit positive or negative slot.

    ``where`` is the diagnostic location (``stage[2] positive``); it is carried
    into every warning so two slots of the same role on different stages stay
    distinguishable.
    """
    if slot is None:
        # An absent slot is reported absent. It is not an empty prompt and not a
        # failure: some sampler calls genuinely have no such argument.
        return [], [STATUS_MISSING]
    if not _is_mapping(slot):
        warnings.add("%s: slot is not a readable structure" % where)
        return [], [STATUS_AMBIGUOUS]

    slot_role = slot.get("role")
    if isinstance(slot_role, str) and slot_role and slot_role != role:
        warnings.add("%s: slot declares role %r; skipped" % (where, slot_role))
        return [], [STATUS_AMBIGUOUS]

    states = []
    state = slot.get("source_state")
    if state in (SOURCE_STATE_AMBIGUOUS, SOURCE_STATE_UNVERIFIED):
        warnings.add("%s: slot source state %r cannot support copyable text" % (where, state))
        states.append(STATUS_AMBIGUOUS)
    elif state == SOURCE_STATE_PARTIAL:
        states.append(STATUS_PARTIAL)

    entries = slot.get("entries")
    if entries is None:
        entries = []
    stream = _is_sequence(entries)
    if stream is None:
        warnings.add("%s: slot entries are not a readable sequence" % where)
        states.append(STATUS_AMBIGUOUS)
        return [], states

    fragments = []
    seen = set()
    index = 0
    for entry in itertools.islice(iter(stream), MAX_SLOT_ENTRIES + 1):
        if index >= MAX_SLOT_ENTRIES:
            warnings.add(
                "%s: entry iteration capped at %d entries" % (where, MAX_SLOT_ENTRIES)
            )
            states.append(STATUS_PARTIAL)
            break
        items, item_states = _entry_fragments(
            entry, role, warnings, "%s[%d]" % (where, index)
        )
        index += 1
        states.extend(item_states)
        for value in items:
            # Exact duplicates only: no normalisation, no similarity, and no
            # reading of prompt words to decide what belongs together.
            if value in seen:
                continue
            seen.add(value)
            fragments.append(value)
    if index == 0 and not states:
        # A slot with no entries is legitimately empty.
        states.append(STATUS_COMPLETE)
    return fragments, states


def _stage_node_id(stage):
    value = stage.get("node_id")
    if isinstance(value, str):
        return truncate_utf8(value, MAX_TEXT_BYTES)[0]
    return DEFAULT_NODE_ID


def _stage_label(stage):
    value = stage.get("label")
    if isinstance(value, str) and value:
        return truncate_utf8(value, MAX_TEXT_BYTES)[0]
    return DEFAULT_STAGE_LABEL


def _collect_stage(stage, warnings, where):
    """One wire stage. Never returns None: an unreadable entry still occupies
    its position in the chain, marked missing, so a consumer cannot read
    "unreadable" as "nothing was there"."""
    if not _is_mapping(stage):
        warnings.add("%s: stage is not a readable structure" % where)
        return {
            "nodeId": DEFAULT_NODE_ID,
            "label": DEFAULT_STAGE_LABEL,
            "positive": [],
            "negative": [],
            "status": STATUS_MISSING,
        }

    if stage.get("evicted") is True or stage.get("cycle") is True:
        warnings.add(
            "%s: an ancestor stage was evicted; its prompts are unknown" % where
        )
        return {
            "nodeId": _stage_node_id(stage),
            "label": _stage_label(stage),
            "positive": [],
            "negative": [],
            "status": STATUS_MISSING,
        }

    positive, positive_states = _collect_slot(
        stage.get("positive"), "positive", warnings, where + " positive"
    )
    negative, negative_states = _collect_slot(
        stage.get("negative"), "negative", warnings, where + " negative"
    )
    states = positive_states + negative_states

    state = stage.get("source_state")
    if state in (SOURCE_STATE_AMBIGUOUS, SOURCE_STATE_UNVERIFIED):
        states.append(STATUS_AMBIGUOUS)
    elif state == SOURCE_STATE_PARTIAL:
        states.append(STATUS_PARTIAL)

    status = _worst(states)
    if status == STATUS_COMPLETE and not positive and not negative:
        status = STATUS_MISSING
    return {
        "nodeId": _stage_node_id(stage),
        "label": _stage_label(stage),
        "positive": positive,
        "negative": negative,
        "status": status,
    }


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
def build_record(stage_chain, image_association, output_node_id=DEFAULT_NODE_ID):
    """Build the bounded v1 wire record.

    ``image_association`` is required. ``dependency`` is an explicit current-run
    graph association with partial status; ``exact`` proves image identity.
    ``ambiguous`` and ``unknown`` never export text.
    """
    if image_association not in IMAGE_ASSOCIATIONS:
        raise ValueError(
            "image_association must be one of %r" % (IMAGE_ASSOCIATIONS,)
        )
    if not isinstance(output_node_id, str):
        raise TypeError("output_node_id must be a string")

    warnings = _Warnings()
    node_id, node_cut = truncate_utf8(output_node_id, MAX_TEXT_BYTES)
    if node_cut:
        warnings.add("outputNodeId truncated to the %d byte policy cap" % MAX_TEXT_BYTES)

    stream = _is_sequence(stage_chain)
    if stream is None:
        warnings.add("stage chain is not a readable sequence")
        raw = []
    else:
        raw = list(itertools.islice(iter(stream), MAX_STAGES + 1))
        if len(raw) > MAX_STAGES:
            raw = raw[:MAX_STAGES]
            warnings.add(
                "stage chain exceeded the %d stage cap; older stages were dropped"
                % MAX_STAGES
            )

    collected = [
        _collect_stage(stage, warnings, "stage[%d]" % index)
        for index, stage in enumerate(raw)
    ]

    if image_association == IMAGE_ASSOCIATION_DEPENDENCY:
        warnings.add("已恢复本次执行中保存分支的实际采样正文；图像转换的精确归属未完整核验")
    elif image_association != IMAGE_ASSOCIATION_EXACT:
        warnings.add(
            "output image ownership is %s; no prompt text is exported"
            % image_association
        )
        forced = (
            STATUS_AMBIGUOUS
            if image_association == IMAGE_ASSOCIATION_AMBIGUOUS
            else STATUS_MISSING
        )
        for stage in collected:
            stage["positive"] = []
            stage["negative"] = []
            stage["status"] = forced

    # The chain arrives newest first; the record publishes oldest first so a
    # consumer reads the prompts in the order they were actually used.
    collected.reverse()

    record = {
        "schemaVersion": SCHEMA_VERSION,
        "outputNodeId": node_id,
        "imageAssociation": image_association,
        "stages": collected,
        "warnings": warnings.freeze(),
    }
    return _fit_budget(record)


def _append_warning(record, message):
    """Append one warning to a record's list, honouring the cap."""
    existing = list(record.get("warnings", ()))
    if message in existing:
        return existing
    existing.append(message)
    if len(existing) > MAX_WARNINGS:
        extra = len(existing) - (MAX_WARNINGS - 1)
        existing = existing[: MAX_WARNINGS - 1] + [
            "%d additional warnings suppressed" % extra
        ]
    return existing


def _fit_budget(record):
    """Shrink the record until its serialised form fits the byte cap.

    Stages are copied before anything is mutated, so a record handed in by a
    caller is never rewritten in place, and the caller's own warnings survive:
    the shrink warning is appended to them rather than replacing them.
    """
    if utf8_len(_serialized(record)) <= MAX_RECORD_BYTES:
        return record

    stages = [
        dict(item) if _is_mapping(item) else item for item in record.get("stages", ())
    ]
    # Size the parts once and drop by arithmetic instead of re-serialising the
    # whole document on every step: re-measuring made the shrink quadratic, and
    # the estimate plus one exact correction pass is both bounded and accurate
    # enough to keep the record as large as the cap allows.
    sizes = [utf8_len(_serialized(item)) for item in stages]
    budget = MAX_RECORD_BYTES - utf8_len(_serialized(dict(record, stages=[]))) - len(stages)
    dropped = 0
    remaining = sum(sizes)
    while dropped < len(stages) and remaining > budget:
        remaining -= sizes[dropped]
        dropped += 1
    stages = stages[dropped:]

    while stages and utf8_len(_serialized(dict(record, stages=stages))) > MAX_RECORD_BYTES:
        stages.pop(0)  # oldest first
        dropped += 1

    if dropped:
        if stages:
            stages[0]["status"] = _downgrade(stages[0]["status"])
        record = dict(record, stages=stages)
        record["warnings"] = _append_warning(
            record,
            "record exceeded the %d byte cap; %d oldest stage(s) dropped and the "
            "record is partial" % (MAX_RECORD_BYTES, dropped),
        )

    if utf8_len(_serialized(record)) <= MAX_RECORD_BYTES:
        return record

    # Even with no stage left the warning list itself can exceed the cap, so the
    # detail is replaced by one honest line rather than silently dropped.
    minimal = {
        "schemaVersion": SCHEMA_VERSION,
        "outputNodeId": truncate_utf8(record.get("outputNodeId", ""), 1024)[0],
        "imageAssociation": record.get("imageAssociation", IMAGE_ASSOCIATION_UNKNOWN),
        "stages": [],
        "warnings": [
            "record exceeded the %d byte cap; stage and warning detail was dropped"
            % MAX_RECORD_BYTES
        ],
    }
    if utf8_len(_serialized(minimal)) > MAX_RECORD_BYTES:
        raise ValueError("record cannot be represented within the byte cap")
    return minimal


def encode_record(record):
    """Serialise a record to bounded JSON text.

    The record is fitted to the byte cap first, so the returned string always
    satisfies the policy the decoder enforces. A document that cannot be
    measured at all (nested past the depth bound, cyclic, or holding a value with
    no JSON form) is refused with a ``ValueError`` rather than serialised on
    faith, because its size and content cannot be bounded.
    """
    if not _is_mapping(record):
        raise TypeError("record must be a mapping")
    if _bounded_measure(record) is None:
        raise ValueError("record is too deeply nested, cyclic, or not JSON-representable")
    try:
        fitted = _fit_budget(dict(record))
        payload = _serialized(fitted)
    except RecursionError:
        raise ValueError("record is too deeply nested to serialise")
    if utf8_len(payload) > MAX_RECORD_BYTES:
        raise ValueError("record cannot be represented within the byte cap")
    return payload


# ---------------------------------------------------------------------------
# decode
# ---------------------------------------------------------------------------
def _validate_texts(value, budget):
    """``(texts, size)`` or None, bounded by ``budget`` bytes.

    A list of strings is read element by element and abandoned as soon as the
    remaining budget is spent, so a list of a million entries cannot cost a
    million measurements.
    """
    if value is None:
        return [], 0
    if not isinstance(value, (list, tuple)):
        return None
    out = []
    size = 0
    for item in value:
        if not isinstance(item, str):
            return None
        length = utf8_len(item)
        if length > MAX_TEXT_BYTES:
            return None
        size += length + 3
        if size > budget:
            return None
        out.append(item)
    return out, size


def _validate_stage(item, budget):
    """``(stage, size)`` or None. Only the documented keys are read."""
    if not _is_mapping(item):
        return None
    node_id = item.get("nodeId", DEFAULT_NODE_ID)
    label = item.get("label", DEFAULT_STAGE_LABEL)
    if not isinstance(node_id, str) or utf8_len(node_id) > MAX_TEXT_BYTES:
        return None
    if not isinstance(label, str) or utf8_len(label) > MAX_TEXT_BYTES:
        return None
    status = item.get("status")
    if status not in PUBLIC_STATUSES:
        return None
    size = utf8_len(node_id) + utf8_len(label) + 24
    if size > budget:
        return None
    positive = _validate_texts(item.get("positive"), budget - size)
    if positive is None:
        return None
    negative = _validate_texts(item.get("negative"), budget - size - positive[1])
    if negative is None:
        return None
    return {
        "nodeId": node_id,
        "label": label,
        "positive": positive[0],
        "negative": negative[0],
        "status": status,
    }, size + positive[1] + negative[1]


def _validate(payload):
    """The documented fields, or None.

    Only documented keys are read, so a forged or absurdly nested extra field is
    ignored *without being traversed*: a document cannot make the decoder walk a
    structure it will never publish. Every step is bounded by the byte budget,
    so an oversized document is rejected rather than measured in full.
    """
    if not _is_mapping(payload):
        return None

    version = payload.get("schemaVersion")
    if isinstance(version, bool) or not isinstance(version, int):
        return None
    if version != SCHEMA_VERSION:
        # A future or unknown schema is never accepted as complete.
        return None

    output_node_id = payload.get("outputNodeId", DEFAULT_NODE_ID)
    if not isinstance(output_node_id, str) or utf8_len(output_node_id) > MAX_TEXT_BYTES:
        return None
    size = utf8_len(output_node_id) + 8

    association = payload.get("imageAssociation")
    if association not in IMAGE_ASSOCIATIONS:
        return None
    size += len(association) + 8

    stages_in = payload.get("stages")
    if not isinstance(stages_in, (list, tuple)):
        return None
    stages = []
    for item in stages_in:
        if len(stages) >= MAX_STAGES:
            return None
        validated = _validate_stage(item, MAX_RECORD_BYTES - size)
        if validated is None:
            return None
        stage, stage_size = validated
        size += stage_size
        stages.append(stage)

    warnings_in = payload.get("warnings", [])
    if warnings_in is None:
        warnings_in = []
    if not isinstance(warnings_in, (list, tuple)):
        return None
    warnings = []
    for item in warnings_in:
        if len(warnings) >= MAX_WARNINGS:
            return None
        if not isinstance(item, str) or utf8_len(item) > MAX_TEXT_BYTES:
            return None
        size += utf8_len(item) + 3
        if size > MAX_RECORD_BYTES:
            return None
        warnings.append(item)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "outputNodeId": output_node_id,
        "imageAssociation": association,
        "stages": stages,
        "warnings": warnings,
    }


def _coerce(payload):
    if isinstance(payload, str):
        if utf8_len(payload) > MAX_RECORD_BYTES:
            # The cap is on the serialised UTF-8 document, not on the character
            # count. 70 000 emoji are 70 000 characters but 280 KB, and a text
            # like that must be refused before it is parsed: parsing succeeds,
            # the oversized field is then ignored as unknown, and the document
            # would be accepted at more than twice the cap. A parsed mapping
            # keeps the old contract — its unknown extras are still ignored
            # without being traversed, because they are never published.
            return None
        try:
            payload = json.loads(payload)
        except Exception:
            return None
    elif isinstance(payload, (bytes, bytearray, int, float, bool)) or payload is None:
        return None
    if not _is_mapping(payload):
        return None
    return _validate(payload)


def _public_view(record):
    """Public fields for a validated record.

    Ownership decides the published status. Text is exported only for ``exact``,
    and the status is then taken from the stage flags; for ``ambiguous`` and
    ``unknown`` the status comes from the ownership itself, so a record whose
    stages still claim ``complete`` can never be published as complete — the
    claim that the image belongs to this prompt is what is missing, and no stage
    flag can supply it.
    """
    association = record["imageAssociation"]
    if association not in (IMAGE_ASSOCIATION_EXACT, IMAGE_ASSOCIATION_DEPENDENCY):
        for stage in record["stages"]:
            stage["positive"] = []
            stage["negative"] = []

    stages = []
    all_positive = []
    all_negative = []
    seen_positive = set()
    seen_negative = set()
    states = []
    for stage in record["stages"]:
        positive = stage["positive"]
        negative = stage["negative"]
        stages.append(
            {
                "nodeId": stage["nodeId"],
                "label": stage["label"],
                "prompt": "\n".join(positive),
                "negativePrompt": "\n".join(negative),
            }
        )
        for value in positive:
            if value not in seen_positive:
                seen_positive.add(value)
                all_positive.append(value)
        for value in negative:
            if value not in seen_negative:
                seen_negative.add(value)
                all_negative.append(value)
        states.append(stage["status"])

    warnings = list(record["warnings"])
    raw_status = _worst(states) if states else STATUS_MISSING
    if association == IMAGE_ASSOCIATION_AMBIGUOUS:
        status = STATUS_AMBIGUOUS
    elif association == IMAGE_ASSOCIATION_UNKNOWN:
        status = STATUS_MISSING
    elif association == IMAGE_ASSOCIATION_DEPENDENCY:
        status = STATUS_PARTIAL if all_positive else STATUS_MISSING
        warnings = _append_warning({"warnings": warnings},
            "已恢复本次执行中保存分支的实际采样正文；图像转换的精确归属未完整核验")
    elif raw_status == STATUS_COMPLETE:
        status = STATUS_COMPLETE
    elif all_positive:
        # Part of the evidence does not hold, but every fragment published here
        # was verified, and the consumer disables copy on ``ambiguous``. Hiding
        # verified text behind ``ambiguous`` would be a worse answer than saying
        # "this is what could be confirmed": the stage's own raw status stays in
        # the record for diagnostics, and the reason travels in the warnings.
        status = STATUS_PARTIAL
        if raw_status == STATUS_AMBIGUOUS:
            ambiguous_stages = sum(1 for state in states if state == STATUS_AMBIGUOUS)
            warnings = _append_warning(
                {"warnings": warnings},
                "public status partial: verified text stays copyable while %d stage(s) "
                "remain ambiguous" % ambiguous_stages,
            )
    elif raw_status == STATUS_AMBIGUOUS:
        status = STATUS_AMBIGUOUS
    else:
        # Nothing reliable to copy, and no contradiction to report.
        status = STATUS_MISSING

    return {
        "prompt": "\n".join(all_positive),
        "negativePrompt": "\n".join(all_negative),
        "promptStages": stages,
        "promptStatus": status,
        "promptWarnings": warnings,
    }


def decode_record(payload):
    """Decode a wire record into the public fields, or None.

    Accepts a JSON string or an already parsed mapping. Every field is
    validated; an invalid, oversized, malformed, or future-schema record yields
    None so the caller keeps its static result and supplies its own warning.
    This never raises on bad input.
    """
    record = _coerce(payload)
    if record is None:
        return None
    return _public_view(record)


def to_public(record):
    """Public fields for an in-memory record built by this module, or None."""
    if not _is_mapping(record):
        return None
    validated = _validate(record)
    if validated is None:
        return None
    return _public_view(validated)


__all__ = [
    "POLICY",
    "SCHEMA_VERSION",
    "IMAGE_ASSOCIATION_EXACT",
    "IMAGE_ASSOCIATION_DEPENDENCY",
    "IMAGE_ASSOCIATION_AMBIGUOUS",
    "IMAGE_ASSOCIATION_UNKNOWN",
    "STATUS_COMPLETE",
    "STATUS_PARTIAL",
    "STATUS_AMBIGUOUS",
    "STATUS_MISSING",
    "DEFAULT_STAGE_LABEL",
    "DEFAULT_NODE_ID",
    "build_record",
    "encode_record",
    "decode_record",
    "to_public",
    "truncate_utf8",
    "utf8_len",
]
