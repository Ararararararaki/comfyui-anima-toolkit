"""Runtime provenance for the text that actually reaches CLIP encoding.

Pure stdlib. No torch import, no ComfyUI import, and no durable tensor
reference: every tensor that matters for identity is held through a weakref,
and reading a torch property that could return a non-bool tensor is done
defensively so a tensor ``==`` can never decide control flow here.

The model is deliberately class-name agnostic. Nothing in this module inspects
node class names, widget names, prompt verbs such as "negative", or text
content. The only inputs are the actual text handed to a tokenizer, the actual
object the tokenizer returned, and the actual conditioning structure an encoder
returned.
"""

import hashlib
import json
import re
import sys
import threading
import time
import weakref

PROVENANCE_VERSION = 1
RECORD_NAMESPACE = "comfyui_prompt_provenance"
SCHEMA_VERSION = 3

# ---------------------------------------------------------------------------
# limits
# ---------------------------------------------------------------------------
# Memory-protection budgets.
#
# These are limits this module imposes on itself so a long session cannot grow
# without bound. They are NOT statements about the host: no chunk count, no
# prompt length, and no model or workflow step/page ceiling is derivable from
# the tokenizer or sampler interface, so none is claimed.
#
# Everything here is counted in BYTES and measured, never in characters. A
# character budget would understate cost badly: a CJK or emoji string costs up
# to 4 UTF-8 bytes per character, and the recorded identity structures and the
# retained containers cost real bytes on top of the text.
#
# Crossing a budget degrades the recorded state (to partial or unverified) and
# raises a warning. It never silently truncates, and it never changes what the
# host is asked to do.
# ---------------------------------------------------------------------------
MAX_TOKEN_DEPTH = 12
MAX_PAGE_NODES = 8192

# Per-binding text budget. Text beyond it is kept up to a UTF-8 boundary, the
# receipt is flagged ``truncated`` with ``text_len_original`` intact, and the
# source state is degraded, because a partial string cannot support a complete
# claim.
MAX_TEXT_BYTES = 8 * 1024

# Per-run budget covering everything a run holds: recorded text, token identity
# structures, and the retained CPU token containers. Oldest bindings are
# released first when it is exceeded, and the newest binding is degraded rather
# than dropped, so the most recent answer stays readable.
MAX_RUN_BYTES = 8 * 1024 * 1024

# Global budget across every active run plus everything the strong-hold tables
# keep. A per-run cap alone is not a memory bound: N concurrent prompts would
# multiply it, so this is the number that actually protects the process. It is
# deliberately far below a machine's RAM, because this is a provenance observer
# and not the reason a machine runs out of memory.
MAX_GLOBAL_BYTES = 32 * 1024 * 1024

# Global budget for frozen sampling stages, which outlive the run that made
# them. Also caps how many stage handles are kept.
MAX_STAGE_BYTES = 4 * 1024 * 1024
MAX_STAGE_ENTRIES = 4096

# Cost ceiling for measuring a single container. A container whose real cost
# cannot be established within this many nodes is not retained, because
# retaining it would mean guessing its size.
MAX_MEASURE_NODES = 20000

# Capacity budgets, secondary to the byte budgets above. A binding beyond the
# identity table's capacity can no longer be looked up by token identity, so
# keeping more of them would hold memory without making it reachable.
MAX_RUNS = 32
MAX_BINDINGS_PER_RUN = 1024
MAX_ALIAS_REFS_PER_BINDING = 16

# Bounded identity table for token containers that cannot be weak-referenced
# (a plain dict is the standard return shape). Entries hold one reference each
# and are evicted oldest-first, so the table stays small in a long session.
MAX_RETAINED_TOKEN_OBJECTS = 256

# Distinct diagnostics kept. Overflow warnings embed byte counts, so the
# collection is capped rather than allowed to grow one string per distinct
# number.
MAX_WARNINGS = 32

OBSERVER_API_VERSION = 1

# Public source-state protocol. Four states, and no caller may invent a fifth:
#   complete    — the receipt's text is proven to be the text that was encoded
#   partial     — part of the truth is known; something relevant was not observed
#   ambiguous   — observed structures disagree, so no single text can be claimed
#   unverified  — nothing about this source could be established at all
STAGE_STATE_COMPLETE = "complete"
STAGE_STATE_PARTIAL = "partial"
STAGE_STATE_AMBIGUOUS = "ambiguous"
STAGE_STATE_UNVERIFIED = "unverified"
STAGE_STATES = (
    STAGE_STATE_COMPLETE,
    STAGE_STATE_PARTIAL,
    STAGE_STATE_AMBIGUOUS,
    STAGE_STATE_UNVERIFIED,
)

# The only key under which text is recognized inside an explicitly registered
# source record. A record is registered through the observer protocol; nothing
# in this module reads arbitrary mapping fields such as "text", "prompt", or
# "caption" out of a token structure, because a tokenizer may use those names
# for something that is not the prompt.
SOURCE_TEXT_FIELD = "input_text"
SOURCE_ID_FIELD = "tokenize_id"


# ---------------------------------------------------------------------------
# defensive primitive reads
# ---------------------------------------------------------------------------
def safe_bool(value):
    """Conservative bool; PyTorch may hand back a tensor from a comparison."""
    if value is True:
        return True
    if value is False or value is None:
        return False
    try:
        return bool(value)
    except Exception:
        return False


def safe_shape(tensor):
    """Tensor shape as a tuple of ints, or None.

    Shape is the only property read off a tensor: it never reads device memory
    and it is the guard that rejects an id reused after a weakref died.
    """
    try:
        return tuple(int(dim) for dim in tensor.shape)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# byte accounting
# ---------------------------------------------------------------------------
def utf8_bytes(text):
    """Real UTF-8 byte cost of a string, not its character count."""
    if not isinstance(text, str):
        return 0
    return len(text.encode("utf-8", "surrogatepass"))


def truncate_to_bytes(text, limit):
    """Cut a string to at most ``limit`` UTF-8 bytes.

    Slicing by characters would exceed the byte budget for non-ASCII text, and
    slicing the encoded bytes would split a multi-byte character. Decoding with
    ``ignore`` drops the partial trailing character, so the result is always
    valid text that really fits.
    """
    encoded = text.encode("utf-8", "surrogatepass")
    if len(encoded) <= limit:
        return text, False
    return encoded[:limit].decode("utf-8", "ignore"), True


def measured_bytes(value, node_budget=None):
    """Measured byte cost of a nested structure, or None if unmeasurable.

    Counts the interpreter's own size for every object reached plus the real
    UTF-8 bytes of every string, so it reflects what the structure actually
    costs rather than an estimate. Returns None when the walk exceeds its node
    budget, which lets a caller refuse to retain a structure whose size it
    cannot establish instead of guessing.

    A structure's cost is always the full cost of everything reachable from it.
    A container therefore reports its channels as well, and a table that also
    holds those channels reports them a second time. That over-counting is
    deliberate: a conservative upper bound stays correct when one table evicts
    an object the other still holds, whereas skipping shared objects made the
    accounting understate what was really retained. The budget is a safety
    margin, not a precise heap measurement.
    """
    if node_budget is None:
        node_budget = MAX_MEASURE_NODES
    total = 0
    seen = set()
    stack = [value]
    nodes = 0
    while stack:
        current = stack.pop()
        nodes += 1
        if nodes > node_budget:
            return None
        total += sys.getsizeof(current)
        if isinstance(current, str):
            # getsizeof already counts the compact representation; add the
            # UTF-8 cost that a serialized receipt would pay.
            total += utf8_bytes(current)
            continue
        if isinstance(current, (bytes, bytearray)):
            continue
        if isinstance(current, (list, tuple, set, frozenset, dict)):
            key = id(current)
            if key in seen:
                continue
            seen.add(key)
            if isinstance(current, dict):
                stack.extend(current.keys())
                stack.extend(current.values())
            else:
                stack.extend(current)
            continue
    return total


class WeakTensorRef:
    """Weak identity for a tensor, immune to PyTorch's elementwise ``==``.

    ``Tensor.__eq__`` returns a tensor, so plain dict keys (and
    ``WeakKeyDictionary``) compare tensor *values*: expensive, device-syncing,
    and wrong for identity. Identity here is ``id()`` plus a weakref, and a
    recycled id is rejected by re-checking the shape captured at bind time.
    """

    __slots__ = ("_ref", "_id", "_shape", "_hash")

    def __init__(self, target):
        self._id = id(target)
        self._hash = self._id
        self._shape = safe_shape(target)
        self._ref = None
        try:
            self._ref = weakref.ref(target)
        except TypeError:
            # A target that refuses weak references cannot be identified at all:
            # an id plus a shape is not identity, since the id may be reused by
            # an unrelated object with the same shape. Identity is reported as
            # unknown instead of being asserted.
            self._ref = None

    @property
    def identifiable(self):
        return self._ref is not None

    def get(self):
        if self._ref is None:
            return None
        try:
            return self._ref()
        except Exception:
            return None

    def resolve(self):
        """Live tensor, or None when it is gone, unknown, or replaced."""
        target = self.get()
        if target is None:
            return None
        if id(target) != self._id:
            return None
        if self._shape is not None and safe_shape(target) != self._shape:
            return None
        return target

    def matches(self, target):
        """Strict identity: False whenever identity cannot be proven."""
        if self._ref is None:
            return False
        try:
            return self._ref() is target
        except Exception:
            return False

    @property
    def tensor_id(self):
        return self._id

    @property
    def shape(self):
        return self._shape

    def __eq__(self, other):
        return (
            isinstance(other, WeakTensorRef)
            and self._identifiable_eq(other)
            and self._id == other._id
            and self._shape == other._shape
        )

    def _identifiable_eq(self, other):
        return self._ref is not None and other._ref is not None

    def __hash__(self):
        return self._hash

    def __repr__(self):
        return "<WeakTensorRef id=%d shape=%r identifiable=%s>" % (
            self._id,
            self._shape,
            self._ref is not None,
        )


# ---------------------------------------------------------------------------
# structural identity for token structures (never reads a tensor)
# ---------------------------------------------------------------------------
class IdentityUnavailable(ValueError):
    """Raised when a structure's identity cannot be established."""


def _entry_identity(entry, budget):
    """Structural identity of one tokenizer entry.

    Structure is preserved: a nested group keeps its grouping and its arity, so
    ``[[1, 2], [3]]`` and ``[[1], [2, 3]]`` are different identities rather than
    the same flattened sequence. An entry that refuses weak references, or a
    structure deeper than the budget, raises ``IdentityUnavailable`` so callers
    fail closed instead of claiming a match they cannot prove.
    """
    if budget <= 0:
        raise IdentityUnavailable("token structure depth budget exceeded")
    if isinstance(entry, bool):
        return ("bool", entry)
    if isinstance(entry, int):
        return ("int", entry)
    if isinstance(entry, float):
        # repr keeps the exact value without depending on float equality.
        return ("float", repr(entry))
    if isinstance(entry, str):
        return ("str", entry)
    if isinstance(entry, (bytes, bytearray, memoryview)):
        return ("bytes", hashlib.sha1(bytes(entry)).digest())
    if isinstance(entry, (list, tuple)):
        return (
            "list" if isinstance(entry, list) else "tuple",
            tuple(_entry_identity(item, budget - 1) for item in entry),
        )
    if isinstance(entry, dict):
        try:
            items = sorted(
                (str(key), _entry_identity(value, budget - 1))
                for key, value in entry.items()
            )
        except TypeError:
            raise IdentityUnavailable("token mapping keys are not orderable")
        return ("dict", tuple(items))
    ref = WeakTensorRef(entry)
    if not ref.identifiable:
        raise IdentityUnavailable(
            "entry of type %s refuses weak references" % type(entry).__name__
        )
    return ("object", ref)


def page_identity(page, with_cost=False):
    """Structural identity of one per-channel token structure.

    Raises ``IdentityUnavailable`` when the structure is deeper than the depth
    budget, larger than the node budget, or contains an entry whose identity
    cannot be established. Callers turn that into an unverifiable result, so a
    structure that cannot be proven never compares equal to anything.

    With ``with_cost`` the walk also returns the real byte cost of the identity
    it is building, accumulated as each node is created. Measuring it in the same
    walk avoids a second full traversal, which is the single most expensive part
    of recording a receipt.
    """
    budget = [MAX_PAGE_NODES]
    cost = [0]

    def charge(node):
        cost[0] += sys.getsizeof(node)

    def walk(value, depth):
        budget[0] -= 1
        if budget[0] < 0:
            raise IdentityUnavailable("token structure node budget exceeded")
        if depth > MAX_TOKEN_DEPTH:
            raise IdentityUnavailable("token structure depth budget exceeded")
        if isinstance(value, (list, tuple)):
            kind = "list" if isinstance(value, list) else "tuple"
            items = tuple(walk(item, depth + 1) for item in value)
            node = (kind, items)
            charge(node)
            charge(items)
            return node
        identity = _entry_identity(value, MAX_TOKEN_DEPTH - depth)
        charge(identity)
        if isinstance(identity, tuple) and len(identity) == 2 and isinstance(identity[1], tuple):
            charge(identity[1])
        return identity

    result = walk(page, 0)
    if with_cost:
        return result, cost[0]
    return result


def channel_source_text(tokens, channel):
    """Text explicitly registered for one channel, or None.

    Text is read only where it was deliberately published. A token structure
    may contain mappings whose keys look like text fields; those are never read,
    because a tokenizer is free to use such a key for something that is not the
    prompt, and reading it would present an unobserved string as the prompt.

    The only accepted shape is a mapping holding ``SOURCE_TEXT_FIELD``, and it
    must be a string. Anything else yields None, which the caller reports as an
    unobserved source rather than as text.
    """
    if not isinstance(tokens, dict):
        return None
    payload = tokens.get(channel)
    if not isinstance(payload, dict):
        return None
    text = payload.get(SOURCE_TEXT_FIELD)
    if not isinstance(text, str):
        return None
    text, _ = truncate_to_bytes(text, MAX_TEXT_BYTES)
    return text


def registered_channel_texts(tokens, channels):
    """Explicitly registered text per channel; unregistered channels are absent."""
    found = {}
    for channel in channels:
        text = channel_source_text(tokens, channel)
        if text is not None:
            found[channel] = text
    return found


# ---------------------------------------------------------------------------
# token dict shape inspection
# ---------------------------------------------------------------------------
def token_channel_keys(tokens):
    """Channel key candidates of a tokenizer result.

    A tokenizer returns either a channel map (``{"l": pages, "t5xxl": pages}``)
    or a single page list. Only mapping keys are reported: a flat list has no
    channels to track, and inventing one would misattribute text.
    """
    if isinstance(tokens, dict):
        return tuple(tokens.keys())
    return ()


def tokens_differ_from(original, current):
    """True when ``current`` is a distinct object from ``original``.

    Used to detect the token-replacement boundary: a caller that swapped a
    channel inside the dict usually also replaced the dict itself.
    """
    return original is not current


# ---------------------------------------------------------------------------
# run scoping
# ---------------------------------------------------------------------------
class RequestContextWatch:
    """Tracks which prompt a text-carrying call belongs to.

    ``comfy_execution.utils.CurrentNodeContext`` sets a ContextVar that is
    already reset by the time a wrapper installed outside that context runs, so
    the value cannot be read live. It is therefore captured at the start of a
    node call by the observer, while the context is still set. When nothing was
    captured the caller is told the attribution is uncertain rather than being
    handed a guessed prompt id.
    """

    def __init__(self, get_executing_context=None):
        self._get = get_executing_context
        self._tls = threading.local()

    def current(self):
        if self._get is None:
            return None
        try:
            return self._get() or None
        except Exception:
            return None

    def mark_call(self, prompt_id, node_id=None, list_index=None):
        self._tls.snapshot = (prompt_id, node_id, list_index)

    def clear_call(self):
        if hasattr(self._tls, "snapshot"):
            del self._tls.snapshot

    def snapshot(self):
        return getattr(self._tls, "snapshot", None)


class _Run:
    __slots__ = ("prompt_id", "created_at", "bindings", "bytes_used")

    def __init__(self, prompt_id):
        self.prompt_id = prompt_id
        self.created_at = time.monotonic()
        self.bindings = {}
        self.bytes_used = 0


# ---------------------------------------------------------------------------
# CPU token container safety
# ---------------------------------------------------------------------------
# ComfyUI's tokenizer returns a plain Python ``dict`` of pages, and a plain dict
# cannot be weak-referenced. Treating that as unverifiable would mark every
# standard workflow unknown, which is wrong: what actually matters is whether
# the container holds anything that must not be retained. A container proven to
# hold only safe CPU primitives may be kept in a bounded table and checked with
# ``is``, which is real identity; a container holding a tensor or an unknown
# object must not be retained at all and is reported partial.
SAFE_CPU_SCALARS = (bool, int, float, str, bytes, bytearray)

# Skip structures already proven safe so a shared sub-object is not rewalked.
_MAX_SAFE_WALK = 200000


def container_is_safe_cpu(value, budget=None):
    """True when ``value`` holds only safe CPU primitives.

    Safe means: no tensors, no objects of unknown type, no cycles that would
    force a decision about retaining them. The walk is bounded, and exhausting
    the budget answers False — an unproven container is not retained.
    """
    if budget is None:
        budget = [_MAX_SAFE_WALK]
    stack = [value]
    seen = set()
    while stack:
        current = stack.pop()
        budget[0] -= 1
        if budget[0] < 0:
            return False
        if current is None or isinstance(current, SAFE_CPU_SCALARS):
            continue
        if isinstance(current, (list, tuple, dict)):
            key = id(current)
            if key in seen:
                # A shared or cyclic container node: already being walked.
                continue
            seen.add(key)
            if isinstance(current, dict):
                stack.extend(current.keys())
                stack.extend(current.values())
            else:
                stack.extend(current)
            continue
        # A tensor, a model, a custom object: not retainable.
        return False
    return True


class TokenObjectCache:
    """Bounded, byte-accounted identity table for retained CPU objects.

    Holds at most ``max_entries`` objects, each kept only for ``is`` comparison
    against the exact object the host hands back. A container that is not proven
    to hold solely safe CPU primitives is never stored, and an object whose real
    size cannot be measured is never stored either, because keeping it would
    mean guessing how much memory it costs.

    The table measures every object it accepts and tracks the total it holds, so
    the same object registered twice is charged once: the table is keyed by
    identity and holds exactly one reference either way. That total is what the
    global memory budget is enforced against.
    """

    def __init__(self, max_entries=MAX_RETAINED_TOKEN_OBJECTS):
        self._entries = {}
        self._order = []
        self._max = max_entries
        self._guard = threading.RLock()
        self._bytes = 0
        self.hits = 0
        self.misses = 0
        self.rejected = 0
        self.evicted = 0

    def store(self, obj, binding, cost=None):
        """Retain ``obj`` for identity checks; returns False if not retainable.

        ``cost`` lets a caller supply the measured cost when it has already been
        computed with other objects excluded, so no byte is charged to two
        owners. When omitted the table measures the object itself.
        """
        if not container_is_safe_cpu(obj):
            with self._guard:
                self.rejected += 1
            return False
        if cost is None:
            cost = measured_bytes(obj)
            if cost is None:
                with self._guard:
                    self.rejected += 1
                return False
        key = id(obj)
        with self._guard:
            previous = self._entries.get(key)
            if previous is not None:
                # The same object (or a recycled id) already occupies this slot;
                # its old cost is replaced, never added to.
                self._bytes -= previous[2]
            self._entries[key] = (obj, binding, cost)
            self._bytes += cost
            self._order = [item for item in self._order if item != key]
            self._order.append(key)
            while len(self._order) > self._max:
                oldest = self._order.pop(0)
                dropped = self._entries.pop(oldest, None)
                if dropped is not None:
                    self._bytes -= dropped[2]
                    self.evicted += 1
        return True

    def lookup(self, obj):
        key = id(obj)
        with self._guard:
            found = self._entries.get(key)
            if found is None:
                self.misses += 1
                return None
            stored, binding, _cost = found
            if stored is not obj:
                # The id was recycled; the entry belongs to a different object.
                self._entries.pop(key, None)
                self._order = [item for item in self._order if item != key]
                self._bytes -= found[2]
                self.misses += 1
                return None
            self.hits += 1
            return binding

    def discard(self, obj):
        key = id(obj)
        with self._guard:
            found = self._entries.get(key)
            if found is not None and found[0] is obj:
                self._entries.pop(key, None)
                self._order = [item for item in self._order if item != key]
                self._bytes -= found[2]
                return True
            return False

    def release_binding(self, binding):
        """Drop every entry this table holds for ``binding``."""
        released = 0
        with self._guard:
            for key, entry in list(self._entries.items()):
                if entry[1] is binding:
                    self._entries.pop(key, None)
                    self._order = [item for item in self._order if item != key]
                    self._bytes -= entry[2]
                    released += 1
        return released

    def oldest_binding(self):
        with self._guard:
            for key in self._order:
                entry = self._entries.get(key)
                if entry is not None:
                    return entry[1]
            return None

    @property
    def bytes_held(self):
        """Real bytes this table holds strongly."""
        with self._guard:
            return max(0, self._bytes)

    def size(self):
        with self._guard:
            return len(self._entries)

    def clear(self):
        with self._guard:
            self._entries.clear()
            self._order = []
            self._bytes = 0


class Binding:
    """Text handed to a tokenizer plus everything needed to verify it later."""

    __slots__ = (
        "text",
        "text_len_original",
        "text_bytes",
        "text_bytes_original",
        "truncated",
        "token_pages",
        "tokens_ref",
        "tokens_id",
        "tokens_identifiable",
        "tokens_retained",
        "channel_keys",
        "channel_text",
        "channel_ids",
        "state",
        "ambiguous",
        "reason",
        "prompt_id",
        "attributed",
        "structure_bytes",
        "channel_bytes",
        "bytes_used",
        "released",
    )

    def __init__(self, text):
        if isinstance(text, str):
            self.text, self.truncated = truncate_to_bytes(text, MAX_TEXT_BYTES)
            self.text_len_original = len(text)
            self.text_bytes_original = utf8_bytes(text)
        else:
            self.text = None
            self.text_len_original = 0
            self.text_bytes_original = 0
            self.truncated = False
        self.text_bytes = utf8_bytes(self.text) if self.text else 0
        self.token_pages = None
        self.tokens_ref = None
        self.tokens_id = None
        self.tokens_identifiable = False
        self.tokens_retained = False
        self.channel_keys = ()
        self.channel_text = {}
        self.channel_ids = {}
        self.state = STAGE_STATE_UNVERIFIED
        self.ambiguous = False
        self.reason = None
        self.prompt_id = None
        self.attributed = False
        self.structure_bytes = 0
        self.channel_bytes = 0
        self.bytes_used = 0
        self.released = False

    def note_tokens(self, tokens):
        """Record how this token object can be identified later.

        A weak reference is preferred because it proves identity without
        retaining anything. Plain dicts — the standard ComfyUI return shape —
        cannot be weak-referenced, so they are handed to the bounded identity
        cache instead, which keeps the object itself for an ``is`` check and is
        only used when the container is proven to hold safe CPU primitives.
        A tensor or an unknown object is neither weak-referenceable in a useful
        way nor safe to retain, so it is reported as unidentifiable.
        """
        self.tokens_id = id(tokens)
        try:
            self.tokens_ref = weakref.ref(tokens)
        except TypeError:
            self.tokens_ref = None
        if self.tokens_ref is not None:
            self.tokens_identifiable = True
            self.tokens_retained = False
            return
        if container_is_safe_cpu(tokens):
            # Identity via the bounded cache; the entry lives in Provenance and
            # is released on eviction or run teardown.
            self.tokens_identifiable = True
            self.tokens_retained = True
            return
        self.tokens_identifiable = False
        self.tokens_retained = False

    def live_tokens(self):
        """The token object, or None when identity cannot be proven."""
        ref = self.tokens_ref
        if ref is None:
            return None
        try:
            value = ref()
        except Exception:
            return None
        if value is None or id(value) != self.tokens_id:
            return None
        return value


class Provenance:
    """Run-scoped store of text receipts."""

    def __init__(self, max_runs=MAX_RUNS, get_executing_context=None,
                 global_bytes=None, run_bytes=None):
        self._lock = threading.RLock()
        self._runs = {}
        self._order = []
        self._max_runs = max_runs
        self.max_global_bytes = MAX_GLOBAL_BYTES if global_bytes is None else global_bytes
        self.max_run_bytes = MAX_RUN_BYTES if run_bytes is None else run_bytes
        self.context = RequestContextWatch(get_executing_context)
        self.retained_tokens = TokenObjectCache()
        self.retained_channels = TokenObjectCache()
        self.active_prompt_id = None
        self.ambiguous_prompts = False
        self.counters = {
            "runs_created": 0,
            "runs_evicted": 0,
            "bindings": 0,
            "bindings_dropped": 0,
            "budget_evictions": 0,
            "global_evictions": 0,
            "released_bindings": 0,
            "bindings_replaced": 0,
            "texts_dropped": 0,
            "lookups_hit": 0,
            "lookups_miss": 0,
            "retained_tokens": 0,
            "unretainable_tokens": 0,
        }
        self.warnings = []
        self.warnings_suppressed = 0

    # -- diagnostics ------------------------------------------------------
    def warn(self, message):
        """Record a distinct warning, with a hard bound on the collection.

        Overflow warnings carry byte counts, so an unbounded list would grow
        with every distinct number and become its own leak. The list is capped
        and the excess is counted instead, which keeps the signal without the
        growth.
        """
        if message in self.warnings:
            return
        if len(self.warnings) >= MAX_WARNINGS:
            self.warnings_suppressed += 1
            return
        self.warnings.append(message)

    # -- run lifecycle ----------------------------------------------------
    def _run_for(self, prompt_id):
        key = prompt_id if prompt_id is not None else "__unattributed__"
        run = self._runs.get(key)
        if run is None:
            run = _Run(key)
            self._runs[key] = run
            self._order.append(key)
            self.counters["runs_created"] += 1
            while len(self._order) > self._max_runs:
                oldest = self._order.pop(0)
                evicted = self._runs.pop(oldest, None)
                if evicted is not None:
                    # Evicting a run must release its strong holds and aliases
                    # exactly as end_run does; otherwise the tables keep
                    # containers of a run that no longer exists.
                    self._release_run(evicted)
                    self.counters["runs_evicted"] += 1
        return run

    def begin_run(self, prompt_id):
        with self._lock:
            if self.active_prompt_id is not None and self.active_prompt_id != prompt_id:
                # Two prompts in flight: attribution by "most recent" is a
                # guess, so it is marked rather than silently applied.
                self.ambiguous_prompts = True
            self.active_prompt_id = prompt_id
            return self._run_for(prompt_id).prompt_id

    def end_run(self, prompt_id=None):
        """Release a finished run, including any retained token containers.

        Retained containers are the only thing this module holds a strong
        reference to, so they are dropped here rather than left for the bounded
        table to age out.
        """
        with self._lock:
            key = prompt_id if prompt_id is not None else self.active_prompt_id
            if key is None:
                return
            if self.active_prompt_id == key:
                self.active_prompt_id = None
            sink = self._runs.pop(key, None)
            if sink is not None:
                self._order = [item for item in self._order if item != key]
                self._release_run(sink)
            self.ambiguous_prompts = False

    def _release_run(self, run):
        """Release every binding a run owns, and its aliases anywhere.

        ``_release_binding`` looks the binding up in both strong-hold tables
        rather than trusting the run's own view, so an alias recorded while the
        same token object was also bound in another run is released too.
        """
        for binding in list(run.bindings.values()):
            self._release_binding(binding, "run released", retained=False)
        run.bindings.clear()
        run.bytes_used = 0

    def active_runs(self):
        with self._lock:
            return len(self._runs)

    def total_bindings(self):
        with self._lock:
            return sum(len(run.bindings) for run in self._runs.values())

    # -- binding ----------------------------------------------------------
    def bind_text(self, text, tokens):
        """Record text and the token object a tokenizer produced from it.

        Two different facts are recorded separately, because conflating them
        would either overstate or understate the receipt:

        * ``state`` is about the **text**: whether the string bound to this
          token structure is proven to be the string that was encoded. It is
          decided from the observed tokenize call and the structure identity,
          never from which request the call belonged to.
        * ``prompt_id`` / ``attributed`` are about **request attribution**, which
          matters for run isolation and cleanup. When it cannot be established
          it is recorded as unknown; it does not downgrade a text that was in
          fact observed, because the text claim does not depend on it.
        """
        with self._lock:
            prompt_id, attributed = self._attribute()
            run = self._run_for(prompt_id)

            binding = Binding(text)
            binding.prompt_id = prompt_id
            binding.attributed = attributed
            binding.note_tokens(tokens)
            binding.channel_keys = token_channel_keys(tokens)
            if not binding.tokens_identifiable:
                # Only a tensor or an unknown, non-retainable object lands here.
                binding.state = STAGE_STATE_UNVERIFIED
                binding.reason = "token object is not identifiable without retaining it"
                self.counters["unretainable_tokens"] += 1
            elif not isinstance(tokens, dict):
                binding.state = STAGE_STATE_UNVERIFIED
                binding.reason = "tokenizer result is not a channel map"
            elif not binding.channel_keys:
                binding.state = STAGE_STATE_UNVERIFIED
                binding.reason = "tokenizer result has no channels"
            else:
                try:
                    binding.token_pages = {}
                    structure_bytes = 0
                    for key in binding.channel_keys:
                        identity, cost = page_identity(tokens[key], with_cost=True)
                        binding.token_pages[key] = identity
                        structure_bytes += cost
                    binding.structure_bytes = structure_bytes
                    # Text per channel comes only from an explicitly registered
                    # source record, never from inspecting token contents.
                    binding.channel_text = registered_channel_texts(
                        tokens, binding.channel_keys
                    )
                    # Register each channel object in the bounded identity table
                    # so a later swap can be detected even when the replacement
                    # happens to have an identical token layout. Only the id is
                    # kept on the binding; the object itself lives in the
                    # bounded table and is released by eviction or run teardown.
                    # Each channel is charged its full measured cost here as
                    # well, so the channel table's own accounting stays a true
                    # upper bound on what it holds even when it evicts
                    # independently of the container table.
                    for key in binding.channel_keys:
                        channel = tokens[key]
                        cost = measured_bytes(channel)
                        if cost is None:
                            continue
                        if not self.retained_channels.store(channel, binding, cost=cost):
                            continue
                        binding.channel_ids[key] = id(channel)
                        binding.channel_bytes += cost
                    binding.state = STAGE_STATE_COMPLETE
                except IdentityUnavailable as error:
                    binding.token_pages = None
                    binding.state = STAGE_STATE_UNVERIFIED
                    binding.reason = str(error)
                    self.warn("token structure not verifiable: %s" % error)

            # A retained container is a strong reference, so it is only kept
            # when the table can measure it; a container too large to measure
            # within the node budget is not retained at all. The container is
            # charged its full measured cost, channels included, because a
            # conservative over-count stays correct when the channel table
            # evicts something the container still holds.
            if binding.tokens_retained:
                if self.retained_tokens.store(tokens, binding):
                    self.counters["retained_tokens"] += 1
                else:
                    binding.tokens_retained = False
                    binding.tokens_identifiable = False
                    binding.state = STAGE_STATE_UNVERIFIED
                    binding.reason = "token container too large or unsafe to retain"
                    self.warn("token container not retained: cost unmeasurable")

            # A binding is charged for the copies it owns: its text and its
            # recorded identity structures. The strong-hold tables account for
            # the containers and channels they retain, and they charge a shared
            # object once per table that holds it — a deliberate conservative
            # upper bound rather than an attempt at exact dedup.
            binding.bytes_used = (
                binding.text_bytes
                + binding.structure_bytes
                + sum(utf8_bytes(value) for value in binding.channel_text.values())
            )

            # Truncation and budget overflow degrade the claim instead of
            # silently shortening the text.
            if binding.truncated and binding.state == STAGE_STATE_COMPLETE:
                binding.state = STAGE_STATE_PARTIAL
                binding.reason = "text exceeded the %d byte receipt budget" % MAX_TEXT_BYTES
                self.warn("receipt text truncated to %d bytes" % MAX_TEXT_BYTES)

            # Re-binding the same token object replaces the previous binding for
            # that identity, so the previous binding's charge and every alias it
            # owns must be released first. Otherwise each re-bind would add a
            # full charge and leave the old structures counted forever.
            replaced = run.bindings.get(id(tokens))
            if replaced is not None:
                before = replaced.bytes_used
                run.bytes_used += self._release_binding(
                    replaced,
                    "superseded by a new binding for the same token object",
                    retained=False,
                ) - before
                run.bindings.pop(id(tokens), None)
                self.counters["bindings_replaced"] += 1

            run.bindings[id(tokens)] = binding
            run.bytes_used += binding.bytes_used
            self.counters["bindings"] += 1
            self._enforce_budgets(run, binding)
            return binding

    def total_bytes(self):
        """Everything this store currently holds, across every run and table.

        The strong-hold tables are the single owner of the bytes they retain, so
        summing them here counts each retained object exactly once no matter how
        many bindings refer to it.
        """
        with self._lock:
            return (
                sum(run.bytes_used for run in self._runs.values())
                + self.retained_tokens.bytes_held
                + self.retained_channels.bytes_held
            )

    def _release_binding(self, binding, reason, retained=False):
        """Drop a binding's strong holds and recorded structures.

        Degrading the state alone is not enough: the CPU container, the channel
        objects, and the identity structures are what actually occupy memory, so
        they are released and the binding is marked so a consumer can see the
        record is now partial rather than silently missing.

        ``retained`` says whether the binding stays reachable in its run. A
        binding that stays is charged for the text it keeps; a binding that is
        leaving the run is charged nothing, so no charge can outlive the entry
        that owned it. The return value is the binding's new charge, which the
        caller applies as a delta to its run.

        A text that cannot fit the data budget is dropped as well, and the
        receipt is then reported as unreliable: exceeding the cap to keep one
        entry would defeat the cap.
        """
        if binding.released:
            return binding.bytes_used
        self.retained_tokens.release_binding(binding)
        self.retained_channels.release_binding(binding)
        binding.token_pages = None
        binding.channel_text = {}
        binding.channel_ids = {}
        binding.structure_bytes = 0
        binding.channel_bytes = 0
        binding.tokens_retained = False
        binding.released = True
        binding.bytes_used = binding.text_bytes if retained else 0
        if binding.state == STAGE_STATE_COMPLETE:
            binding.state = STAGE_STATE_PARTIAL
        binding.reason = reason
        self.counters["released_bindings"] += 1
        return binding.bytes_used

    def _drop_text_if_over_budget(self, binding):
        """Give up the text too when even it does not fit the data budget.

        Returns the bytes freed, so the caller can settle its run accounting.
        The receipt then carries no text at all and says so, rather than holding
        the store over its cap. Must be called after the run's own accounting is
        up to date, or the check would see a stale total and drop text that
        actually fits.
        """
        if not binding.text or self.total_bytes() <= self.max_global_bytes:
            return 0
        freed = binding.bytes_used
        binding.text = None
        binding.text_bytes = 0
        binding.text_len_original = 0
        binding.truncated = False
        binding.bytes_used = 0
        binding.state = STAGE_STATE_UNVERIFIED
        binding.reason = "no reliable receipt: text dropped to fit the data budget"
        self.counters["texts_dropped"] += 1
        self.warn("receipt text dropped: it did not fit the configured data budget")
        return freed

    def _enforce_budgets(self, newest_run, newest):
        """Fit the store inside its per-run and global memory budgets.

        The global budget is the one that actually bounds the process: a
        per-run cap alone multiplies by the number of concurrent prompts. Both
        are enforced by releasing the oldest bindings first, and a binding that
        alone exceeds a budget has its strong holds and structures released
        rather than kept, because keeping it is exactly the unbounded case the
        budget exists to prevent.
        """
        evicted = False
        global_driven = False
        while True:
            run_over = (
                newest_run.bytes_used > self.max_run_bytes
                or len(newest_run.bindings) > MAX_BINDINGS_PER_RUN
            )
            global_over = self.total_bytes() > self.max_global_bytes
            if not (run_over or global_over):
                break
            victim = self._oldest_releasable(newest)
            if victim is None:
                break
            run, binding = victim
            before = binding.bytes_used
            run.bytes_used += self._release_binding(
                binding, "released to fit the memory budget", retained=False
            ) - before
            run.bindings.pop(binding.tokens_id, None)
            self.counters["bindings_dropped"] += 1
            evicted = True
            if global_over:
                global_driven = True
        if evicted:
            self.counters["budget_evictions"] += 1
        if global_driven:
            self.counters["global_evictions"] += 1
        if self.total_bytes() > self.max_global_bytes:
            # Only reachable when the newest binding alone is over the cap. Its
            # holds and structures go first, then its text if that still does
            # not fit: the cap is never exceeded to keep one entry.
            self.counters["global_evictions"] += 1
            self.warn("global memory budget exceeded; newest receipt released")
            before = newest.bytes_used
            newest_run.bytes_used += self._release_binding(
                newest, "released: single receipt exceeded the memory budget", retained=True
            ) - before
            newest_run.bytes_used -= self._drop_text_if_over_budget(newest)

    def _oldest_releasable(self, newest):
        """The oldest binding that is not the one just recorded, or None.

        Oldest-first across runs, so the answer a caller is most likely reading
        now is the last thing to go.
        """
        for key in list(self._order):
            run = self._runs.get(key)
            if run is None:
                continue
            for binding in list(run.bindings.values()):
                if binding is newest:
                    continue
                return run, binding
        return None

    def _attribute(self):
        snapshot = self.context.snapshot()
        if snapshot is not None:
            return snapshot[0], True
        live = self.context.current()
        if live is not None:
            return live[0], True
        if self.active_prompt_id is None or self.ambiguous_prompts:
            return None, False
        return self.active_prompt_id, True

    def lookup(self, tokens):
        """Binding for an exact token object, or None.

        Identity is proven either by a live weak reference or, for the standard
        non-weak-referenceable container, by the bounded identity table's ``is``
        check. Never by a bare id match: a recycled id would hand one request
        another request's text.
        """
        with self._lock:
            for run in self._runs.values():
                binding = run.bindings.get(id(tokens))
                if binding is None:
                    continue
                if binding.live_tokens() is tokens:
                    self.counters["lookups_hit"] += 1
                    return binding
            retained = self.retained_tokens.lookup(tokens)
            if retained is not None:
                self.counters["lookups_hit"] += 1
                return retained
            self.counters["lookups_miss"] += 1
            return None

    # -- channel-level verification ---------------------------------------
    def resolve_channels(self, tokens, binding):
        """Attribute every channel of a live token dict to its own tokenize call.

        This is the multi-encoder boundary, and the real shape of it matters:
        ``CLIPTextEncodeSDXL`` tokenizes one text, then replaces individual
        channels of that same dict with channels taken from a second tokenize of
        a different text, and encodes the merged dict. Reading only the first
        binding's text would report half the prompt and call the standard node
        broken.

        So each channel is resolved independently, to whichever observed
        tokenize actually produced that channel object:

        * **object identity** decides ownership. The channel value must be the
          very object a tokenize call returned, verified with ``is`` through the
          bounded identity table. Structure equality alone cannot decide it: a
          second tokenize of different text can produce a channel with an
          identical token layout, so a structural match would attribute text that
          was never encoded.
        * **content structure** is required on top of identity, which is what
          catches an in-place rewrite of a channel that is still the same object.

        A channel owned by another observed tokenize is a *known* source and is
        reported with that tokenize's text. A channel whose owner cannot be
        established is unknown and degrades the result; content is never used as
        the sole credential for attribution.
        """
        result = {
            "channels": {},
            "sources": {},
            "complete_keys": [],
            "changed_keys": [],
            "missing_keys": [],
            "unverifiable_keys": [],
            "replacement_text": {},
            "ambiguous": False,
        }
        if not isinstance(tokens, dict):
            result["ambiguous"] = True
            result["note"] = "token object is not a channel map"
            return result

        keys = set(token_channel_keys(tokens))
        if binding is not None and binding.token_pages:
            keys |= set(binding.token_pages)

        for key in keys:
            if key not in tokens:
                result["channels"][key] = "missing"
                result["missing_keys"].append(key)
                continue
            channel = tokens[key]
            try:
                snapshot = page_identity(channel)
            except IdentityUnavailable:
                result["channels"][key] = STAGE_STATE_UNVERIFIED
                result["unverifiable_keys"].append(key)
                continue

            owner = self.retained_channels.lookup(channel)
            if owner is None:
                # No observed tokenize claims this object. If the primary
                # binding recorded a different object for this key, the channel
                # is provably a replacement we cannot source; otherwise identity
                # is simply unproven.
                recorded = binding.channel_ids.get(key) if binding else None
                if recorded is not None and id(channel) != recorded:
                    result["channels"][key] = "changed"
                    result["changed_keys"].append(key)
                    replacement = self._replacement_text(tokens, key)
                    if replacement:
                        result["replacement_text"][key] = replacement
                else:
                    result["channels"][key] = STAGE_STATE_UNVERIFIED
                    result["unverifiable_keys"].append(key)
                continue

            expected = owner.token_pages.get(key)
            if expected is None:
                # The owning tokenize never produced this key, so this channel
                # cannot be attributed to its text.
                result["channels"][key] = STAGE_STATE_UNVERIFIED
                result["unverifiable_keys"].append(key)
                continue
            if snapshot != expected:
                # Same object, rewritten contents: the origin tokenize is known
                # by identity, but the current content is a modification whose
                # result was never observed. The origin is exposed separately so
                # the information is not lost, while the channel itself stays
                # degraded and out of the verified source list.
                result["channels"][key] = "changed"
                result["changed_keys"].append(key)
                origin = self._channel_text(owner, key)
                if origin is not None:
                    result.setdefault("origin_text", {})[key] = origin
                continue

            result["channels"][key] = "complete"
            result["complete_keys"].append(key)
            text = self._channel_text(owner, key)
            if text is not None:
                result["sources"][key] = text
                result.setdefault("origins", {})[key] = (
                    "primary" if owner is binding else "merged"
                )

        result["ambiguous"] = bool(
            result["changed_keys"]
            or result["missing_keys"]
            or result["unverifiable_keys"]
        )
        return result

    def verify_channels(self, tokens, binding):
        """Channel resolution for a binding; see ``resolve_channels``."""
        return self.resolve_channels(tokens, binding)

    @staticmethod
    def _channel_text(owner, key):
        """The observed text behind a channel of an owning tokenize call.

        A channel may publish its own text under the registration field; when it
        does not, the text of the tokenize call that produced it is the observed
        cause and is used instead. Nothing is inferred from the channel's
        contents.
        """
        if owner is None:
            return None
        registered = owner.channel_text.get(key)
        if registered is not None:
            return registered
        return owner.text

    @staticmethod
    def _replacement_text(tokens, channel):
        """Text the replacement channel explicitly registered, or None.

        A channel no observed tokenize claims carries text this module never
        saw. It is reported only when that channel published it under the
        registration field; otherwise the caller sees an unsourced channel with
        no text, which is the honest answer.
        """
        text = channel_source_text(tokens, channel)
        return [text] if text else None

    def collected_sources(self, tokens, binding):
        """Every distinct observed text actually consumed by this token dict.

        Only channels present in the dict contribute, so a tokenize whose
        channels were never merged in is excluded even though it was observed.
        """
        report = self.resolve_channels(tokens, binding)
        ordered = []
        for key in sorted(report.get("sources", {})):
            text = report["sources"][key]
            if text not in ordered:
                ordered.append(text)
        return ordered, report

    # -- record shaping ---------------------------------------------------
    def build_record(self, binding, role, stage, channel_report=None):
        """Versioned, JSON-safe provenance record for one conditioning slot.

        ``text`` stays the primary binding's text for a single-source
        conditioning, but it is no longer the whole answer: ``sources`` lists
        every observed text actually consumed by this token structure, in
        channel order, so a merged multi-encoder dict reports both of its real
        prompts instead of only the first one.
        """
        state = binding.state
        sources = []
        channel_sources = None
        if channel_report is not None:
            ordered_keys = sorted(channel_report.get("sources", {}))
            for key in ordered_keys:
                text = channel_report["sources"][key]
                if text not in sources:
                    sources.append(text)
            channel_sources = {
                key: {
                    "text": channel_report["sources"].get(key),
                    "origin_text": channel_report.get("origin_text", {}).get(key),
                    "state": channel_report["channels"].get(key),
                    "origin": channel_report.get("origins", {}).get(key),
                }
                for key in sorted(channel_report["channels"])
            }
            state = self._channel_state(binding, channel_report, state)
        record = {
            "ns": RECORD_NAMESPACE,
            "version": PROVENANCE_VERSION,
            "schema": SCHEMA_VERSION,
            "role": role,
            "stage": stage,
            "source_state": state,
            "text": binding.text,
            "text_len_original": binding.text_len_original,
            "truncated": binding.truncated,
            "ambiguous": state == STAGE_STATE_AMBIGUOUS,
            "channels": list(binding.channel_keys),
            "prompt_id": binding.prompt_id,
            "attributed": binding.attributed,
        }
        if sources:
            record["sources"] = sources
        if channel_sources is not None:
            record["channel_sources"] = channel_sources
        if binding.reason:
            record["reason"] = binding.reason
        if channel_report is not None:
            record["channel_state"] = dict(channel_report["channels"])
            if channel_report.get("replacement_text"):
                record["replacement_text"] = channel_report["replacement_text"]
        if binding.channel_text:
            record["channel_text"] = sorted(set(binding.channel_text.values()))
        return record

    @staticmethod
    def _channel_state(binding, channel_report, state):
        """Fold per-channel results into the slot's source state.

        A merged dict whose channels are each attributed to an observed tokenize
        is fully explained, so it is complete even though it was assembled from
        more than one tokenize call. Anything unexplained — a channel with no
        owner, a rewritten channel, a missing key — degrades the state, and a
        binding that was already degraded is never upgraded.
        """
        if channel_report.get("changed_keys") or channel_report.get("unverifiable_keys"):
            return STAGE_STATE_AMBIGUOUS
        if channel_report.get("missing_keys"):
            return STAGE_STATE_PARTIAL
        if not channel_report.get("complete_keys"):
            return STAGE_STATE_PARTIAL if binding.channel_keys else state
        if binding.state == STAGE_STATE_COMPLETE:
            return STAGE_STATE_COMPLETE
        return binding.state

    @staticmethod
    def _ordered_channels(binding):
        return list(binding.token_pages or binding.channel_keys)

    def dump_record(self, record):
        return json.dumps(record, ensure_ascii=True, sort_keys=True)


# ---------------------------------------------------------------------------
# rendering helpers
# ---------------------------------------------------------------------------
_WHITESPACE = re.compile(r"\s+")


def normalize_for_compare(text):
    if not isinstance(text, str):
        return None
    return _WHITESPACE.sub(" ", text).strip()


def describe_stage(stage):
    """Human-facing one-liner. Truncation is always announced, never silent."""
    if stage is None:
        return "no sampler stage recorded"
    parts = ["role=%s" % stage.get("role", "unknown")]
    parts.append("state=%s" % stage.get("source_state", "unknown"))
    text = stage.get("text")
    if text is None:
        parts.append("text=<unavailable>")
    else:
        parts.append("text=%r" % text)
    if stage.get("truncated"):
        parts.append(
            "TRUNCATED shown=%d of %d chars"
            % (len(text or ""), stage.get("text_len_original", 0))
        )
    if stage.get("channel_state") and any(
        value != "complete" for value in stage["channel_state"].values()
    ):
        parts.append("channels=%s" % json.dumps(stage["channel_state"], sort_keys=True))
    if stage.get("ambiguous"):
        parts.append("AMBIGUOUS")
    return " ".join(parts)
