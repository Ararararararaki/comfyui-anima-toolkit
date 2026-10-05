"""Host observation adapter: binds real encoder text to real outputs.

Scope of this slice:
  * record the text a CLIP was actually given, keyed to the token object the
    tokenizer actually returned  (``CLIP.tokenize``)
  * attach a small immutable text receipt to the conditioning structure the
    encoder actually returned (``CLIP.encode_from_tokens`` and
    ``CLIP.encode_from_tokens_scheduled``)
  * decide the role (positive/negative) at the moment the sampler consumes the
    conditioning, from the sampler's own parameters (``comfy.sample.sample`` /
    ``comfy.sample.sample_custom``)
  * carry that stage forward along ``latent_image``

Nothing in this module looks at node class names, widget names, prompt verbs
such as "negative", or text content. A router, a translator, or a dynamic text
node all end up calling ``CLIP.tokenize``, and that call is the only place text
is read.

Installation is explicit and atomic: every target interface is verified before a
single wrapper is applied, an unknown host version disables observation instead
of guessing, and uninstall removes only the wrappers this module still owns (a
wrapper installed by another plugin underneath is left in place and keeps being
called).

Interface verification compares *call contracts*, never signature strings: an
annotation or a default's whitespace can differ between host versions without
changing how the function is called, so only the parameters required to bind a
call and their kinds are checked.
"""

import collections.abc
import contextvars
import functools
import inspect
import logging
import threading
import types
import weakref

from .prompt_provenance import (
    MAX_STAGE_BYTES,
    MAX_STAGE_ENTRIES,
    OBSERVER_API_VERSION,
    PROVENANCE_VERSION,
    RECORD_NAMESPACE,
    STAGE_STATE_AMBIGUOUS,
    STAGE_STATE_COMPLETE,
    STAGE_STATE_PARTIAL,
    Provenance,
    WeakTensorRef,
    describe_stage,
    measured_bytes,
    safe_bool,
    safe_shape,
)

LOG = logging.getLogger("prompt_provenance")

OBSERVER_VERSION = "0.2.0"

# Keyword the host sampler binds a conditioning slot to. The role is taken from
# the sampler's own parameter names, never from a node's widget or title.
ROLE_SLOTS = ("positive", "negative")

# ---------------------------------------------------------------------------
# call contracts
# ---------------------------------------------------------------------------
# Each entry lists the parameters a wrapper must be able to bind by keyword,
# plus the positional arity the host is allowed to use. Anything else about the
# host function (annotations, defaults, extra keyword-only parameters, a
# ``**kwargs`` tail) is irrelevant to whether observation can be installed, so
# it is deliberately not compared.
CLIP_CONTRACTS = {
    "tokenize": {
        "positional": ("self", "text"),
        "keyword": ("return_word_ids",),
        "reject_positional_beyond": 2,
    },
    "encode_from_tokens": {
        "positional": ("self", "tokens"),
        "keyword": ("return_pooled", "return_dict"),
        "reject_positional_beyond": 2,
    },
    "encode_from_tokens_scheduled": {
        "positional": ("self", "tokens"),
        "keyword": ("unprojected", "add_dict", "show_pbar"),
        "reject_positional_beyond": 2,
    },
}

SAMPLER_CONTRACTS = {
    "sample": {
        "required_keyword": ("positive", "negative", "latent_image"),
        "positional": ("model", "noise"),
        "reject_positional_beyond": None,
    },
    "sample_custom": {
        "required_keyword": ("positive", "latent_image"),
        "positional": ("model", "noise"),
        "reject_positional_beyond": None,
    },
}


def _parameter_map(func):
    try:
        return dict(inspect.signature(func).parameters)
    except (TypeError, ValueError):
        return None


def _accepts_keyword(parameters, name):
    """True when ``name`` can be passed by keyword to this function."""
    param = parameters.get(name)
    if param is None:
        return any(
            item.kind is item.VAR_KEYWORD for item in parameters.values()
        )
    if param.kind is param.VAR_POSITIONAL:
        return False
    return param.kind in (param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY)


def _accepts_positional_count(parameters, count):
    """True when the function can be called with ``count`` positional args."""
    positional = 0
    variadic = False
    names = list(parameters.values())
    for index, param in enumerate(names):
        if param.kind is param.VAR_POSITIONAL:
            variadic = True
            break
        if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD):
            positional += 1
    if variadic:
        return True
    if positional < count:
        return False
    # Do not let the wrapper (or the host) rely on positional binding beyond
    # the parameters the contract already names.
    named = 0
    for param in names:
        if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD):
            named += 1
    return count <= named


def verify_call_contract(func, contract, label):
    """Check the parts of a call contract that decide installability.

    Returns None when the host matches, or a short reason string. Deliberately
    ignores annotations, default values, and textual formatting.

    Verification stays strict: the named parameters and the positional arity the
    wrapper relies on must really be present. A peer wrapper written with
    ``functools.wraps`` reports the signature it wraps, so reinstalling over a
    peer is accepted without weakening this check — and a callable whose
    signature genuinely does not match is still refused.
    """
    parameters = _parameter_map(func)
    if parameters is None:
        return "%s has no introspectable signature" % label

    for name in contract.get("positional", ()):
        if name not in parameters:
            return "%s no longer accepts parameter %s" % (label, name)

    limit = contract.get("reject_positional_beyond")
    if limit is not None and not _accepts_positional_count(parameters, limit):
        return "%s cannot be called with %d positional arguments" % (label, limit)

    for name in contract.get("keyword", ()):
        if not _accepts_keyword(parameters, name):
            return "%s no longer accepts keyword %s" % (label, name)

    for name in contract.get("required_keyword", ()):
        if not _accepts_keyword(parameters, name):
            return "%s no longer accepts keyword %s" % (label, name)

    return None


# ---------------------------------------------------------------------------
# stage carriers
# ---------------------------------------------------------------------------
# A stage must survive from the sampler that produced a latent to the next node
# that consumes it, without this module holding a strong reference to the tensor
# and without writing an attribute onto a third-party tensor object.
#
# The carrier is therefore a weak-identity store: the key is a small wrapper
# around ``id(tensor)`` that holds only a weakref plus the shape observed at
# registration time, and the value is a small immutable stage. The store holds
# no tensor reference at all, so an evicted or collected tensor takes its stage
# with it. Its capacities come from the memory budgets in prompt_provenance, so
# there is one source of truth for how much this module may retain.

# Name deliberately never written onto a tensor. A third-party tensor may forbid
# attributes, may be shared, and must not be mutated by observation; stages live
# in the identity store instead. Kept as a constant so a test can assert that
# nothing ever sets it.
STAGE_ATTR_NAME = "_prompt_provenance_stage"


class LatentIdentity:
    """Weak identity for a latent; never holds the tensor itself."""

    __slots__ = ("_ref", "_id", "_shape", "_hash")

    def __init__(self, tensor):
        self._id = id(tensor)
        self._hash = self._id
        self._shape = safe_shape(tensor)
        try:
            self._ref = weakref.ref(tensor)
        except TypeError:
            # A tensor that refuses weak references cannot be tracked without
            # holding it, so the stage is dropped instead of leaking the tensor.
            self._ref = None

    @property
    def trackable(self):
        return self._ref is not None

    @property
    def tensor_id(self):
        return self._id

    def alive(self):
        if self._ref is None:
            return False
        try:
            return self._ref() is not None
        except Exception:
            return False

    def matches(self, tensor):
        if self._ref is None:
            return False
        try:
            return self._ref() is tensor
        except Exception:
            return False

    def __eq__(self, other):
        return (
            isinstance(other, LatentIdentity)
            and self._id == other._id
            and self._shape == other._shape
        )

    def __hash__(self):
        return self._hash


class StageStore:
    """Bounded weak-identity store of small immutable stages.

    Entries are keyed by the tensor's ``id`` and every read re-verifies the
    stored weak reference against the object being asked about. A plain id
    lookup would be unsound: once a tensor is collected, CPython may hand its id
    to an unrelated object, and a lookup by id (or by an ``__eq__`` that compares
    ids and shapes) would then return a stage that belongs to a dead tensor.
    """

    def __init__(self, max_entries=MAX_STAGE_ENTRIES):
        self._entries = {}
        self._order = []
        self._max = max_entries
        self._guard = threading.RLock()

    def put(self, tensor, stage):
        identity = LatentIdentity(tensor)
        if not identity.trackable:
            return False
        key = identity.tensor_id
        with self._guard:
            self._entries[key] = (identity, stage)
            self._order = [item for item in self._order if item != key]
            self._order.append(key)
            self._evict()
        return True

    def get(self, tensor):
        if tensor is None:
            return None
        key = id(tensor)
        with self._guard:
            entry = self._entries.get(key)
            if entry is not None:
                identity, stage = entry
                if identity.matches(tensor):
                    return stage
                # The id now belongs to a different object; the record is stale.
                self._entries.pop(key, None)
                self._order = [item for item in self._order if item != key]
            # A miss is the moment to drop entries whose tensor is gone;
            # otherwise a store that is only written to would keep dead
            # identities until the next put.
            self._evict()
            return None

    def _evict(self):
        """Keep the most recent entries; drop the oldest and the dead.

        This store is a cache of recent results, so when it is full the oldest
        live entry is the one to release. Keeping the oldest and dropping the
        newest would discard the stage a caller is most likely about to read,
        which is the opposite of what a recent-results cache is for.
        """
        survivors = []
        for key in reversed(self._order):
            entry = self._entries.get(key)
            if entry is None:
                continue
            if not entry[0].alive():
                self._entries.pop(key, None)
                continue
            if len(survivors) >= self._max:
                self._entries.pop(key, None)
                continue
            survivors.append(key)
        survivors.reverse()
        self._order = survivors

    def size(self):
        with self._guard:
            return len(self._entries)


class StageRegistry:
    """Bounded, byte-budgeted store of frozen sampling stages.

    A stage that inherits from an earlier one must not embed a copy of that
    earlier stage: embedding would re-copy the whole ancestor chain at every
    sampling step, so a long chain would cost quadratic time and memory and an
    inherited reference could form a cycle. Instead each stage is stored once
    and referenced by a small integer handle, so inheritance is O(1) and a
    handle can never point at itself.
    """

    def __init__(self, max_entries=None, max_bytes=None):
        self._stages = {}
        self._sizes = {}
        self._order = []
        self._next_handle = 1
        self._bytes = 0
        self._max_entries = MAX_STAGE_ENTRIES if max_entries is None else max_entries
        self._max_bytes = MAX_STAGE_BYTES if max_bytes is None else max_bytes
        self._guard = threading.RLock()
        self.evicted = 0

    def register(self, stage):
        """Store ``stage`` and return its handle, or None if unmeasurable."""
        size = measured_bytes(stage)
        if size is None:
            return None
        with self._guard:
            handle = self._next_handle
            self._next_handle += 1
            self._stages[handle] = stage
            self._sizes[handle] = size
            self._order.append(handle)
            self._bytes += size
            self._evict()
            return handle

    def get(self, handle):
        if not isinstance(handle, int):
            return None
        with self._guard:
            return self._stages.get(handle)

    def for_run(self, prompt_id):
        """Frozen receipts for one execution, newest first, within existing budgets.

        No tensors are retained and no new unbounded history is created. A
        missing context never falls back to the most recent user's execution.
        """
        if not isinstance(prompt_id, str) or not prompt_id:
            return []
        with self._guard:
            return [self._stages[handle] for handle in reversed(self._order)
                    if self._stages[handle].get('run_id') == prompt_id]

    def _evict(self):
        """Release the oldest stages until both budgets are satisfied."""
        while self._order and (
            len(self._stages) > self._max_entries or self._bytes > self._max_bytes
        ):
            handle = self._order.pop(0)
            size = self._sizes.pop(handle, 0)
            if self._stages.pop(handle, None) is not None:
                self._bytes -= size
                self.evicted += 1

    @property
    def bytes_used(self):
        with self._guard:
            return self._bytes

    def size(self):
        with self._guard:
            return len(self._stages)

    def chain(self, stage, max_depth=32):
        """Resolve a stage and its ancestors, newest first.

        Follows handles with a depth cap and a visited set, so a deep or
        accidentally cyclic chain terminates instead of running away. An
        ancestor whose stage was evicted is reported as unverified rather than
        omitted, because a consumer must not read "gone" as "nothing was there".
        """
        resolved = []
        seen = set()
        current = stage
        depth = 0
        while current is not None and depth < max_depth:
            resolved.append(current)
            reference = current.get("upstream")
            if not isinstance(reference, collections.abc.Mapping):
                break
            handle = reference.get("handle")
            if handle is None or handle in seen:
                if handle is not None and handle in seen:
                    resolved.append({"cycle": True, "handle": handle})
                break
            seen.add(handle)
            ancestor = self.get(handle)
            if ancestor is None:
                resolved.append({
                    "handle": handle,
                    "source_state": STAGE_STATE_UNVERIFIED,
                    "evicted": True,
                })
                break
            current = ancestor
            depth += 1
        return resolved


# Conditioning receipts are recorded against the conditioning tensor's weak
# identity. A tensor carries no place to hang Python metadata, and writing into
# the conditioning structure would modify the value the model consumes. Each
# observer owns its store, so one observer's records can never be read as
# another's.


# Active role path. A ContextVar rather than a thread-local: two async requests
# interleaved on one thread would share a thread-local and read each other's
# role, which is exactly the confusion this module exists to prevent.
_active_role = contextvars.ContextVar("prompt_provenance_role", default=())


def _is_conditioning_pair(value):
    """True for the host's ``[cond_tensor, metadata_dict]`` entry shape."""
    return (
        isinstance(value, (list, tuple))
        and len(value) >= 2
        and isinstance(value[1], dict)
    )


def _slot_entries(conditioning):
    """Normalize one sampler slot into a list of conditioning entries.

    The host passes a list of ``[tensor, metadata]`` entries, and an empty list
    means "nothing in this slot". A bare conditioning tensor is accepted as a
    single entry because a cached or directly forwarded conditioning can arrive
    that way, and reporting it as "not a list" would discard a real observation.
    ``None`` means the value cannot be a conditioning slot at all.
    """
    if conditioning is None:
        return []
    if isinstance(conditioning, (list, tuple)):
        return list(conditioning)
    if isinstance(conditioning, collections.abc.Mapping):
        return None
    return [conditioning]


def _conditioning_tensors(result):
    """Yield the conditioning tensors an encoder result actually carries.

    Reads the four return shapes the host produces, without guessing: a bare
    tensor is itself, a dict return carries ``"cond"``, a two-tuple from
    ``return_pooled`` carries the tensor first, and the scheduled list carries
    one tensor per ``[tensor, metadata]`` entry. Anything else yields nothing,
    which the caller reports as an unobserved source.
    """
    if result is None:
        return
    if isinstance(result, dict):
        cond = result.get("cond")
        if cond is not None:
            yield cond
        return
    if isinstance(result, (list, tuple)):
        if _is_conditioning_pair(result):
            # A single [cond, metadata] pair handed back directly.
            yield result[0]
            return
        for entry in result:
            if _is_conditioning_pair(entry):
                yield entry[0]
            elif entry is not None and not isinstance(entry, (list, tuple, dict)):
                # A bare tensor inside a sequence, e.g. a pooled tuple whose
                # first element is the conditioning tensor.
                yield entry
        return
    yield result


def _freeze_stage(value):
    """Copy a stage into an immutable, tensor-free value.

    A stage is stored in a weak-identity store, so it must not keep anything
    alive. Leaves that cannot be represented as data (a tensor, a model, a
    callback) are dropped rather than retained, lists become tuples, and
    mappings become read-only mappings. The result stays key-addressable so a
    consumer can read ``stage["positive"]``, but a later mutation of the
    caller's own structure cannot rewrite a recorded stage.

    Mappings are matched by the ``Mapping`` protocol rather than by ``dict`` so
    that a stage nested inside another stage survives a re-freeze; an
    already-frozen mapping is a ``MappingProxyType``, which is not a ``dict``.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_stage(item) for item in value)
    if isinstance(value, collections.abc.Mapping):
        return types.MappingProxyType(
            {
                str(key): _freeze_stage(item)
                for key, item in value.items()
                if _is_storable(item)
            }
        )
    return None


def _is_storable(value):
    if value is None or isinstance(value, (str, bool, int, float)):
        return True
    if isinstance(value, (list, tuple)):
        return all(_is_storable(item) for item in value)
    if isinstance(value, collections.abc.Mapping):
        return all(_is_storable(item) for item in value.values())
    return False



class ObservationDisabled(Exception):
    """Raised to disable observation without disturbing generation."""


class _WrapperRecord:
    __slots__ = ("target", "name", "wrapper", "previous")

    def __init__(self, target, name, wrapper, previous):
        self.target = target
        self.name = name
        self.wrapper = wrapper
        self.previous = previous


class PromptObserver:
    """Installs, drives, and removes the provenance wrappers.

    Observation failures never propagate: every wrapper catches its own errors,
    logs once, and lets the original call's result through unchanged, so an
    observation bug can never break a generation.

    Lifecycle is tracked by an **install generation**, not by a single installed
    flag. A wrapper closure survives uninstall whenever another writer kept a
    reference to it — a peer wrapper that calls through, a cached bound method —
    and a plain boolean would let that stale closure start observing again the
    moment the same observer was reinstalled. Each install therefore stamps its
    wrappers with a new generation number, and a wrapper only observes while its
    own generation is the active one. Once its generation is retired the wrapper
    is an inert pass-through: it forwards the call verbatim and records nothing.
    """

    def __init__(self, provenance=None, log=LOG):
        self.provenance = provenance or Provenance()
        self.log = log
        self._lock = threading.RLock()
        self._wrappers = []
        self._installed = False
        self._disabled_reason = None
        self._failure_logged = set()
        # Monotonic install counter and the generation currently allowed to
        # observe. `_active_generation is None` means nothing may observe.
        self._generation = 0
        self._active_generation = None
        self.stages = StageStore()
        self.stage_registry = StageRegistry()
        self.conditioning_receipts = StageStore()
        self.counters = {
            "tokenize_calls": 0,
            "encode_calls": 0,
            "scheduled_calls": 0,
            "sample_calls": 0,
            "stages_bound": 0,
            "stages_read": 0,
            "stages_dropped": 0,
            "wrapper_failures": 0,
        }

    # -- lifecycle --------------------------------------------------------
    @property
    def installed(self):
        return self._installed

    @property
    def disabled_reason(self):
        return self._disabled_reason

    @property
    def active_generation(self):
        return self._active_generation

    def _is_active(self, generation):
        """Whether a wrapper of ``generation`` may observe right now.

        ``None`` means the wrapper was built outside an install — the private
        factory used directly — so there is no install generation to gate on and
        it observes as before. Wrappers built by ``install`` always carry a
        generation, so the gate is what decides their fate.
        """
        if generation is None:
            return True
        return self._active_generation is not None and self._active_generation == generation

    def install(self, sd_module, sample_module=None, context_module=None):
        """Verify every signature, then install all wrappers atomically.

        Returns the number of wrappers installed. Raises ``ObservationDisabled``
        when the host does not match the verified interface; in that case no
        wrapper has been applied and nothing is modified.
        """
        with self._lock:
            if self._installed:
                return 0
            clip_class = getattr(sd_module, "CLIP", None)
            if clip_class is None:
                raise ObservationDisabled("comfy.sd has no CLIP class")
            plan = self._verify(clip_class)
            if sample_module is not None:
                plan.extend(self._verify_sample(sample_module))
            if context_module is not None:
                self._bind_context(context_module)

            # The generation is claimed before any wrapper is built, so every
            # wrapper of this install shares one token and no earlier closure can
            # match it.
            self._generation += 1
            generation = self._generation
            applied = []
            try:
                for target, name, previous in plan:
                    wrapper = self._make_wrapper(name, previous, generation)
                    setattr(target, name, wrapper)
                    applied.append(_WrapperRecord(target, name, wrapper, previous))
            except Exception as error:
                # Atomic install: roll back anything already applied, and make
                # sure a partially applied generation can never observe.
                for record in reversed(applied):
                    self._restore(record)
                self._active_generation = None
                raise ObservationDisabled("wrapper install failed: %s" % error)
            self._wrappers = applied
            self._active_generation = generation
            self._installed = True
            return len(applied)

    def uninstall(self):
        """Retire this install generation and remove the wrappers still owned.

        If another plugin replaced one of our wrappers after install, its
        wrapper stays in place: a module may not undo a change it did not make.
        Either way the retired generation stops observing, so a wrapper that is
        still reachable through a peer or a cached reference becomes an inert
        pass-through instead of a second observer.
        """
        with self._lock:
            self._active_generation = None
            removed = 0
            for record in reversed(self._wrappers):
                current = getattr(record.target, record.name, None)
                if current is record.wrapper:
                    self._restore(record)
                    removed += 1
            self._wrappers = []
            self._installed = False
            return removed

    def _restore(self, record):
        try:
            setattr(record.target, record.name, record.previous)
        except Exception as error:  # pragma: no cover - defensive
            self.log.warning("could not restore %s: %s", record.name, error)

    def _bind_context(self, context_module):
        getter = getattr(context_module, "get_executing_context", None)
        if getter is None:
            return
        self.provenance.context = type(self.provenance.context)(getter)

    # -- verification -----------------------------------------------------
    def _verify(self, clip_class):
        """Check CLIP call contracts; no signature-string comparison."""
        plan = []
        for name, contract in CLIP_CONTRACTS.items():
            func = getattr(clip_class, name, None)
            if func is None:
                raise ObservationDisabled("CLIP.%s missing" % name)
            reason = verify_call_contract(func, contract, "CLIP.%s" % name)
            if reason is not None:
                raise ObservationDisabled(reason)
            plan.append((clip_class, name, func))
        return plan

    def _verify_sample(self, sample_module):
        plan = []
        for name, contract in SAMPLER_CONTRACTS.items():
            func = getattr(sample_module, name, None)
            if func is None:
                if name == "sample":
                    raise ObservationDisabled("comfy.sample.sample missing")
                # sample_custom is optional on a host that predates it.
                continue
            reason = verify_call_contract(func, contract, "comfy.sample.%s" % name)
            if reason is not None:
                raise ObservationDisabled(reason)
            plan.append((sample_module, name, func))
        return plan

    # -- wrappers ---------------------------------------------------------
    def _make_wrapper(self, name, previous, generation=None):
        if name == "tokenize":
            return self._wrap_tokenize(previous, generation)
        if name == "encode_from_tokens":
            return self._wrap_encode_from_tokens(previous, generation)
        if name == "encode_from_tokens_scheduled":
            return self._wrap_scheduled(previous, generation)
        if name in ("sample", "sample_custom"):
            return self._wrap_sampler(previous, name, generation)
        raise ObservationDisabled("no wrapper for %s" % name)

    @staticmethod
    def _read_argument(previous, args, kwargs, name):
        """Read one named argument for observation without touching the call.

        The wrapper forwards ``*args, **kwargs`` unchanged, so this is how the
        value to observe is obtained: bind the caller's actual arguments to the
        wrapped function's own signature and read the parameter out. Binding is
        read-only, ``apply_defaults`` fills omitted parameters so an argument
        the caller left out is still observed, and nothing here is ever passed
        on — so the host's real defaults stay in force.

        Every failure is left to the caller's ``_guard``: introspection can fail
        in more ways than a missing argument (a replaced ``__signature__``, a
        decorated callable, a broken descriptor), and none of those may stop the
        wrapped function from running. Callers must therefore invoke this inside
        ``_guard`` and treat ``None`` as "argument not observed".
        """
        bound = inspect.signature(previous).bind(*args, **kwargs)
        bound.apply_defaults()
        return bound.arguments.get(name)

    def _guard(self, label, func):
        """Run ``func``; on any failure log once and return None."""
        try:
            return func()
        except Exception as error:
            self.counters["wrapper_failures"] += 1
            if label not in self._failure_logged:
                self._failure_logged.add(label)
                self.log.warning("prompt provenance observation failed in %s: %r", label, error)
            return None

    def _wrap_tokenize(self, previous, generation=None):
        observer = self

        @functools.wraps(previous)
        def tokenize(*args, **kwargs):
            # A retired generation is an inert pass-through: the call runs
            # exactly as it would have without this wrapper, and nothing is
            # observed or counted as this observer's work.
            if not observer._is_active(generation):
                return previous(*args, **kwargs)
            # Forwarded verbatim: the wrapper must not substitute a default for
            # an argument the caller omitted, because the host's own default may
            # differ and observation must never change behavior. The text is
            # read for observation through a read-only binding instead.
            # Not guarded: the host's own exceptions must propagate unchanged.
            result = previous(*args, **kwargs)
            observer.counters["tokenize_calls"] += 1
            observer._guard(
                "tokenize",
                lambda: observer._record_text(
                    observer._read_argument(previous, args, kwargs, "text"), result
                ),
            )
            return result

        return tokenize

    def _record_text(self, text, tokens):
        if not isinstance(text, str):
            # Non-text token payloads (precomputed tensors, token id lists) are
            # not text and must not be reported as one.
            return None
        binding = self.provenance.bind_text(text, tokens)
        if binding.state != "complete":
            self.log.debug("text binding not complete: %s", binding.reason)
        return binding

    def _wrap_encode_from_tokens(self, previous, generation=None):
        observer = self

        @functools.wraps(previous)
        def encode_from_tokens(*args, **kwargs):
            if not observer._is_active(generation):
                return previous(*args, **kwargs)
            # Read-only observation, fully guarded: a failure here must degrade
            # the receipt, never prevent the wrapped call or alter its result.
            tokens = observer._guard(
                "encode read arguments",
                lambda: observer._read_argument(previous, args, kwargs, "tokens"),
            )
            binding = observer._guard("encode lookup", lambda: observer._lookup(tokens))
            # Not guarded: the host's own exceptions must propagate unchanged.
            result = previous(*args, **kwargs)
            observer.counters["encode_calls"] += 1
            observer._guard(
                "encode attach",
                lambda: observer._attach(binding, tokens, result, "encode_from_tokens"),
            )
            return result

        return encode_from_tokens

    def _wrap_scheduled(self, previous, generation=None):
        observer = self

        @functools.wraps(previous)
        def encode_from_tokens_scheduled(*args, **kwargs):
            if not observer._is_active(generation):
                return previous(*args, **kwargs)
            tokens = observer._guard(
                "scheduled read arguments",
                lambda: observer._read_argument(previous, args, kwargs, "tokens"),
            )
            binding = observer._guard("scheduled lookup", lambda: observer._lookup(tokens))
            # Not guarded: the host's own exceptions must propagate unchanged.
            result = previous(*args, **kwargs)
            observer.counters["scheduled_calls"] += 1
            observer._guard(
                "scheduled attach",
                lambda: observer._attach_scheduled(binding, tokens, result),
            )
            return result

        return encode_from_tokens_scheduled

    def _lookup(self, tokens):
        binding = self.provenance.lookup(tokens)
        if binding is None:
            # A cache hit path can hand the encoder a token object whose
            # binding was evicted. The encoder still gets text from somewhere,
            # so the absence is reported as unknown, never as "no text".
            return None
        return binding

    def _channel_report(self, tokens, binding):
        if binding is None:
            return None
        if binding.released:
            # The binding's structures were released to fit the memory budget, so
            # per-channel verification is no longer possible. The text receipt is
            # still reported, and the record stays partial rather than claiming
            # channels it can no longer check.
            return None
        return self.provenance.verify_channels(tokens, binding)

    def _attach(self, binding, tokens, result, stage_name):
        report = self._channel_report(tokens, binding)
        if binding is None:
            record = self._unknown_record(None)
        else:
            role = self._current_role()
            record = self.provenance.build_record(binding, role, stage_name, report)
        return self._bind_encoder_result(result, record)

    def _attach_scheduled(self, binding, tokens, result):
        report = self._channel_report(tokens, binding)
        if binding is None:
            record = self._unknown_record(None)
        else:
            role = self._current_role()
            record = self.provenance.build_record(
                binding, role, "encode_from_tokens_scheduled", report
            )
        return self._bind_encoder_result(result, record)

    def _unknown_record(self, note):
        return {
            "ns": RECORD_NAMESPACE,
            "version": PROVENANCE_VERSION,
            "role": self._current_role(),
            "stage": "unknown",
            "source_state": STAGE_STATE_PARTIAL,
            "text": None,
            "reason": note or "no receipt for this token object",
            "ambiguous": True,
        }

    def _bind_encoder_result(self, result, record):
        """Record the receipt against the conditioning tensors actually returned.

        The receipt is bound to the *tensor*, never to a metadata dict. Writing
        into the conditioning structure would modify the value ComfyUI hands to
        the model — including the ``model_conds`` and ``extra_conds`` payloads
        the sampler and model read — which observation must never do.

        The host has four real return shapes and each is read as it is:
          * ``encode_from_tokens(return_dict=True)`` -> ``{"cond": tensor, ...}``
          * ``encode_from_tokens(return_pooled=True)`` -> ``(cond_tensor, pooled)``
          * ``encode_from_tokens()`` -> the bare conditioning tensor
          * ``encode_from_tokens_scheduled()`` -> ``[[cond_tensor, pooled], ...]``
        """
        bound = 0
        for tensor in _conditioning_tensors(result):
            if self.conditioning_receipts.put(tensor, record):
                bound += 1
        return bound

    # -- sampler stage ----------------------------------------------------
    def _wrap_sampler(self, previous, name, generation=None):
        observer = self

        @functools.wraps(previous)
        def sampler(*args, **kwargs):
            if not observer._is_active(generation):
                return previous(*args, **kwargs)
            bound = observer._guard(
                "sampler bind", lambda: observer._bind_arguments(previous, args, kwargs)
            )
            if bound is None:
                return previous(*args, **kwargs)
            arguments, stages = bound
            observer.counters["sample_calls"] += 1
            latent = arguments.get("latent_image")
            upstream = observer._guard("sampler upstream", lambda: observer._read_stage(latent))

            # The role is pushed around each slot access so an encoder call made
            # from inside the sampler can see which slot it is serving. The
            # ContextVar token is always reset, including on the exception and
            # interrupt paths, which are never caught here.
            token = observer._push_role("positive")
            try:
                stages["positive"] = observer._guard(
                    "sampler positive",
                    lambda: observer._stages_for(arguments.get("positive"), "positive"),
                )
            finally:
                observer._pop_role(token)
            token = observer._push_role("negative")
            try:
                stages["negative"] = observer._guard(
                    "sampler negative",
                    lambda: observer._stages_for(arguments.get("negative"), "negative"),
                )
            finally:
                observer._pop_role(token)

            # Only observe: the original positional and keyword arguments are
            # forwarded untouched. Rebuilding the call from bound arguments
            # would duplicate every positional parameter.
            result = previous(*args, **kwargs)
            if result is None:
                return result
            observer._guard(
                "sampler attach",
                lambda: observer._attach_sampling_stage(result, stages, upstream),
            )
            return result

        return sampler

    def _role_stack(self):
        """Current role path for this execution context.

        A ContextVar, so two async requests interleaved on one thread never
        share a role. Values are tuples, so the path is replaced rather than
        mutated in place and an unrelated context cannot observe the change.
        """
        return _active_role.get()

    def _push_role(self, role):
        return _active_role.set(self._role_stack() + (role,))

    @staticmethod
    def _pop_role(token):
        _active_role.reset(token)

    def _bind_arguments(self, previous, args, kwargs):
        """Read-only binding of the sampler's own parameter names.

        ``apply_defaults`` fills omitted parameters so a slot that was left out
        of a legitimate call is still observed; the bound values are used for
        observation only and are never forwarded, so the call the host receives
        is byte-for-byte the call the caller made.
        """
        try:
            bound = inspect.signature(previous).bind(*args, **kwargs)
        except TypeError:
            return None
        bound.apply_defaults()
        arguments = dict(bound.arguments)
        stages = {}
        for slot in ROLE_SLOTS:
            # An absent slot (sample_custom has no "negative") is reported as
            # absent rather than assumed to be an empty prompt.
            stages[slot] = None if slot not in arguments else arguments[slot]
        return arguments, stages

    def _stages_for(self, conditioning, role):
        """Resolve one consumer slot to every receipt its entries carry.

        A slot's conditioning list may hold several entries, and ComfyUI
        genuinely uses that: region prompts, multi-branch positives, and CLIP
        hook schedules all put multiple entries in one slot. Reporting only the
        first entry would silently drop the rest, which is the original bug this
        method exists to fix, so every entry is reported.

        Each entry is classified:
          * ``observed``    — the entry carries a receipt for this consumption
          * ``unobserved``  — the entry exists but carries no receipt
          * ``unverifiable``— the entry's receipt was invalidated (changed
                              channels, evicted binding)
        Any ``unobserved`` or ``unverifiable`` entry makes the slot partial: a
        slot that contains text nobody observed is not fully known.
        """
        slot = {
            "role": role,
            "entries": [],
            "observed": [],
            "unobserved": [],
            "unverifiable": [],
            "source_state": STAGE_STATE_COMPLETE,
            "ambiguous": False,
        }
        entries = _slot_entries(conditioning)
        if entries is None:
            slot["source_state"] = STAGE_STATE_PARTIAL
            slot["ambiguous"] = True
            slot["reason"] = "slot is not a conditioning structure"
            return slot

        for index, entry in enumerate(entries):
            entry_state = self._classify_entry(entry, role, index)
            slot["entries"].append(entry_state)
            status = entry_state["status"]
            if status == "observed":
                slot["observed"].append(entry_state)
            elif status == "unverifiable":
                slot["unverifiable"].append(entry_state)
            else:
                slot["unobserved"].append(entry_state)

        if slot["unverifiable"]:
            slot["source_state"] = STAGE_STATE_AMBIGUOUS
            slot["ambiguous"] = True
        elif slot["unobserved"]:
            # Some text reached this slot that was never observed, so the slot
            # is partial even though the observed entries are individually fine.
            slot["source_state"] = STAGE_STATE_PARTIAL
            slot["ambiguous"] = True
        elif not slot["observed"]:
            # An empty slot is legitimately empty; anything else is unknown.
            slot["source_state"] = STAGE_STATE_COMPLETE if not conditioning else STAGE_STATE_PARTIAL
            slot["ambiguous"] = bool(conditioning)
        return slot

    def _classify_entry(self, entry, role, index):
        """Classify one conditioning entry by the tensor it actually carries.

        Attribution comes only from this module's own receipt store, looked up
        by the weak identity of ``entry[0]``. A ``prompt_provenance`` key found
        in the entry's metadata is deliberately ignored: any node, custom node,
        or plugin can write that key, so trusting it would let an unrelated
        value be reported as this text's source.

        A conditioning tensor that this module never encoded — a concatenation,
        a weighted merge, a tensor produced by another plugin's transform —
        has no receipt and is reported unobserved, which makes the slot partial
        rather than guessed.
        """
        tensor = None
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            tensor = entry[0]
        elif entry is not None and not isinstance(entry, (list, tuple, dict)):
            tensor = entry

        state = {
            "index": index,
            "role": role,
            "status": "unobserved",
            "source_state": STAGE_STATE_PARTIAL,
        }
        if tensor is None:
            return state
        record = self.conditioning_receipts.get(tensor)
        if record is None:
            return state
        stage = dict(record)
        stage["role"] = role
        stage["index"] = index
        stage = self._apply_channel_verification(stage)
        state["status"] = (
            "unverifiable"
            if stage.get("source_state") == STAGE_STATE_AMBIGUOUS
            else "observed"
        )
        state["stage"] = stage
        state["source_state"] = stage.get("source_state", STAGE_STATE_PARTIAL)
        return state

    def _apply_channel_verification(self, stage):
        """Downgrade a receipt whose channels no longer prove its text.

        A conditioning built from merged channels carries the receipt of the
        first tokenize call; if a channel was replaced the merged structure no
        longer proves that text, so the stage must say so rather than repeat the
        original prompt as if it were the whole story.
        """
        replacement = stage.get("replacement_text")
        if replacement:
            stage["source_state"] = STAGE_STATE_AMBIGUOUS
            stage["ambiguous"] = True
            return stage
        channel_state = stage.get("channel_state")
        if channel_state and any(value != "complete" for value in channel_state.values()):
            stage["source_state"] = STAGE_STATE_AMBIGUOUS
            stage["ambiguous"] = True
            return stage
        return stage

    def _current_role(self):
        """Role of the innermost in-flight sampler slot, if there is one."""
        stack = self._role_stack()
        if not stack:
            return "unassigned"
        return stack[-1]

    def _attach_sampling_stage(self, result, stages, upstream):
        # The ancestor is referenced by handle, never embedded: embedding the
        # whole upstream stage would copy its entire ancestor chain at every
        # step, and an inherited object reference could form a cycle.
        upstream_ref = None
        if isinstance(upstream, collections.abc.Mapping):
            upstream_ref = _freeze_stage({
                "handle": upstream.get("handle"),
                "source_state": upstream.get("source_state"),
            })
        context = self.provenance.context.current()
        node_id = getattr(context, "node_id", "")
        run_id = getattr(context, "prompt_id", "")
        stage = {
            "stage": "sampling",
            "node_id": node_id if isinstance(node_id, str) else "",
            "run_id": run_id if isinstance(run_id, str) else "",
            "upstream": upstream_ref,
            "positive": stages.get("positive"),
            "negative": stages.get("negative"),
            "source_state": self._combine_state(stages, upstream),
        }
        self._write_stage(result, stage)

    @staticmethod
    def _combine_state(stages, upstream):
        states = []
        for slot in stages.values():
            if slot:
                states.append(slot.get("source_state"))
        if upstream is not None:
            states.append(upstream.get("source_state"))
        if not states:
            return STAGE_STATE_PARTIAL
        if any(state == STAGE_STATE_AMBIGUOUS for state in states):
            return STAGE_STATE_AMBIGUOUS
        if any(state == STAGE_STATE_PARTIAL for state in states):
            return STAGE_STATE_PARTIAL
        if all(state == STAGE_STATE_COMPLETE for state in states):
            return STAGE_STATE_COMPLETE
        return STAGE_STATE_PARTIAL

    def _write_stage(self, result, stage):
        """Record the stage against the latent the sampler returned.

        Stages live in a weak-identity store keyed on the tensor: this module
        never writes an attribute onto a third-party tensor, and never holds the
        tensor alive. A latent that refuses weak references cannot be tracked,
        so its stage is dropped rather than kept with no owner.

        The frozen stage is registered once and its handle recorded inside it,
        which is what lets a later stage reference this one without copying it.
        """
        frozen = dict(_freeze_stage(stage))
        handle = self.stage_registry.register(frozen)
        if handle is None:
            # The stage could not be measured within the node budget, so its
            # real cost is unknown and it is not kept.
            self.counters["stages_dropped"] += 1
            self.provenance.warn("sampling stage not recorded: cost unmeasurable")
            return
        frozen["handle"] = handle
        stored = _freeze_stage(frozen)
        if self.stages.put(result, stored):
            self.counters["stages_bound"] += 1
        else:
            self.counters["stages_dropped"] += 1

    def _read_stage(self, latent):
        if latent is None:
            return None
        stage = self.stages.get(latent)
        if stage is not None:
            self.counters["stages_read"] += 1
        return stage

    def stage_for(self, latent):
        """Public accessor for the stage recorded against a latent."""
        return self._read_stage(latent)

    def stage_chain(self, stage, max_depth=32):
        """A stage together with its resolvable ancestors, newest first."""
        if stage is None:
            return []
        return self.stage_registry.chain(stage, max_depth=max_depth)

    # -- introspection ----------------------------------------------------
    def health(self):
        return {
            "api_version": OBSERVER_API_VERSION,
            "observer_version": OBSERVER_VERSION,
            "installed": self._installed,
            "disabled_reason": self._disabled_reason,
            "wrappers": [(type(r.target).__name__, r.name) for r in self._wrappers],
            "counters": dict(self.counters),
            "provenance": dict(self.provenance.counters),
            "active_runs": self.provenance.active_runs(),
            "total_bindings": self.provenance.total_bindings(),
            "warnings": list(self.provenance.warnings),
        }

    def describe(self, stage):
        return describe_stage(stage)


def install(sd_module, sample_module=None, context_module=None, provenance=None):
    """Convenience constructor: verify, install, and return the observer."""
    observer = PromptObserver(provenance=provenance)
    try:
        observer.install(sd_module, sample_module, context_module)
    except ObservationDisabled as error:
        observer._disabled_reason = str(error)
        LOG.warning("prompt provenance observation disabled: %s", error)
        raise
    return observer
