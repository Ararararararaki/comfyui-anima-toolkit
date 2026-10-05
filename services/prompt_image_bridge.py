"""Isolated public-hook bridge: observed sampling stages -> VAE images -> PNG.

``prompt_observer`` records a frozen sampling stage against the weak identity of
the latent a sampler returned; ``wire.prompt_record`` turns an owner-supplied
stage chain plus a *proven* image ownership into a bounded JSON document. This
module only moves identity between tensors and calls that codec: dependency
injected (``observer``, ``codec``), no torch import, no read or write of a
tensor's attributes, contents, or shape.

The exact identity path uses no graph traversal, titles, widget values or prompt
words, and no ``CurrentNodeContext.list_index`` -- a direct VAE call returns one
tensor for the whole batch, so an individual image is never inferred from a batch
index. An opaque transform (slice, stack, custom saver, Advanced guider) breaks
the identity chain and is reported ``unknown`` unless a caller states the
association through :meth:`PromptImageBridge.associate_image`. Nothing here
writes a file. The optional independent PNG writer exports current-run sampling
receipts on the image dependency spine as partial, never as pixel identity proof.
"""

import collections.abc
import functools
import inspect
import json
import logging
import threading
import weakref

LOG = logging.getLogger("prompt_provenance.bridge")

BRIDGE_VERSION = "0.1.0"

# The one PNG text field this bridge owns. An existing value under this key is
# replaced, never merged: a record copied from an earlier image must not be
# readable as this image's provenance.
PNG_FIELD = "tk_prompt_provenance"

# Fallbacks only, for a codec that does not publish its own constants.
_FALLBACK_EXACT = "exact"
_FALLBACK_UNKNOWN = "unknown"

# Live wrappers: wrapper -> (bridge, generation). A wrapper observes only while
# its owning bridge still has that generation active, so an uninstall retires
# every wrapper still reachable through a peer's closure.
#
# The owner cannot be marked on the wrapper itself: ``functools.wraps`` copies a
# wrapper's ``__dict__`` onto every peer that wraps it, so an inherited marker
# would make a retired wrapper look like a live owner and block reinstallation.
# A peer is also not itself in this table -- only the wrapper it wrapped is --
# which is why the lookup below follows ``__wrapped__``.
#
# The table and its lock live in one stable container because
# ``importlib.reload`` re-executes this module: rebuilding them would forget the
# wrappers a live peer still holds, and a second instance would then wrap over a
# live first owner.
_REGISTRY = globals().get("_REGISTRY")
if _REGISTRY is None:
    _REGISTRY = (weakref.WeakKeyDictionary(), threading.Lock())
_ACTIVE_WRAPPERS, _REGISTRY_LOCK = _REGISTRY

# Bounded, so a long or hostile wrapper chain cannot be walked forever.
_MAX_WRAPPED_DEPTH = 16


def _live_owner(previous):
    """The bridge that still actively owns ``previous``, or None.

    Follows the bounded ``__wrapped__`` chain with cycle protection, because a
    peer installed on top of a live wrapper is not itself registered: only the
    wrapper it wrapped is. A copied marker on the peer is deliberately not
    trusted.
    """
    seen = set()
    current = previous
    for _ in range(_MAX_WRAPPED_DEPTH):
        if current is None or id(current) in seen:
            return None
        seen.add(id(current))
        try:
            with _REGISTRY_LOCK:
                entry = _ACTIVE_WRAPPERS.get(current)
        except TypeError:
            # A target that refuses weak references cannot be registered.
            entry = None
        if entry is not None:
            owner, generation = entry
            return owner if owner._installed and owner._generation == generation else None
        try:
            current = getattr(current, "__wrapped__", None)
        except Exception:
            return None
    return None

# Contract semantics match ``prompt_observer.verify_call_contract``: only the
# parameters a wrapper must bind and the positional arity the host may use decide
# installability. Targets: VAE.decode(self, samples_in, vae_options={}); the two
# tiled methods (self, samples|pixel_samples, tile_x..overlap_t); VAE.encode(self,
# pixel_samples); SaveImage.save_images(self, images, filename_prefix, prompt,
# extra_pnginfo).
VAE_CONTRACTS = {
    "decode": {"source": "samples_in", "positional": ("self", "samples_in"),
               "keyword": ("vae_options",), "reject_positional_beyond": 3},
    "decode_tiled": {"source": "samples", "positional": ("self", "samples"),
                     "keyword": ("tile_x", "tile_y", "overlap", "tile_t", "overlap_t"),
                     "reject_positional_beyond": 7},
    "encode": {"source": "pixel_samples", "positional": ("self", "pixel_samples"),
               "keyword": (), "reject_positional_beyond": 2},
    "encode_tiled": {"source": "pixel_samples", "positional": ("self", "pixel_samples"),
                     "keyword": ("tile_x", "tile_y", "overlap", "tile_t", "overlap_t"),
                     "reject_positional_beyond": 7},
}

SAVE_IMAGE_CONTRACT = {"positional": ("self", "images"),
                       "keyword": ("extra_pnginfo",), "reject_positional_beyond": 5}


def _parameter_map(func):
    try:
        return dict(inspect.signature(func).parameters)
    except (TypeError, ValueError):
        return None


def _bindable(parameters, name):
    param = parameters.get(name)
    if param is None:
        return any(item.kind is item.VAR_KEYWORD for item in parameters.values())
    return param.kind in (param.POSITIONAL_OR_KEYWORD, param.KEYWORD_ONLY)


def _positional_arity(parameters):
    """Positionally bindable parameter count, or None when variadic."""
    count = 0
    for param in parameters.values():
        if param.kind is param.VAR_POSITIONAL:
            return None
        if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD):
            count += 1
    return count


def verify_call_contract(func, contract, label):
    """None when the host matches the contract, else a short reason.

    Kept here rather than imported so the bridge is diagnosable wherever it is
    deployed; a test asserts both checkers agree on the same host functions.
    """
    parameters = _parameter_map(func)
    if parameters is None:
        return "%s has no introspectable signature" % label
    for name in contract["positional"]:
        if name not in parameters:
            return "%s no longer accepts parameter %s" % (label, name)
    arity = _positional_arity(parameters)
    if arity is not None and contract["reject_positional_beyond"] > arity:
        return "%s cannot be called with %d positional arguments" % (
            label, contract["reject_positional_beyond"])
    for name in contract["keyword"]:
        if not _bindable(parameters, name):
            return "%s no longer accepts keyword %s" % (label, name)
    return None


def read_argument(func, args, kwargs, name):
    """Read one named argument for observation; never passed on to the call."""
    bound = inspect.signature(func).bind(*args, **kwargs)
    bound.apply_defaults()
    return bound.arguments.get(name)


def positional_index(func, name):
    """Index of ``name`` among the positional parameters, or None."""
    parameters = _parameter_map(func)
    if parameters is None:
        return None
    index = 0
    for param in parameters.values():
        if param.kind is param.VAR_POSITIONAL:
            return None
        if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD):
            if param.name == name:
                return index
            index += 1
    return None


def load_default_codec():
    """Import the sibling wire codec, so a missing codec stays diagnosable."""
    from . import prompt_record

    return prompt_record


class PromptImageBridge:
    """Only the first bridge instance wraps a given target; see ``report.md``."""

    def __init__(self, observer, codec=None, context_getter=None, log=LOG):
        if observer is None:
            raise ValueError("an observer is required")
        self.observer = observer
        self.codec = codec
        self.context_getter = context_getter
        self.log = log
        self._lock = threading.RLock()
        self._wrappers = []
        self._installed = False
        self._generation = 0
        self._disabled_reason = None
        self._failure_logged = set()
        self._local = threading.local()
        self.counters = {
            "decode_calls": 0, "decode_receipts": 0,
            "node_decode_calls": 0, "node_decode_receipts": 0,
            "encode_calls": 0, "encode_receipts": 0,
            "save_calls": 0, "save_documents": 0, "save_unknown": 0,
            "associate_calls": 0, "untrackable": 0,
            "peer_conflicts": 0, "wrapper_failures": 0,
        }

    # -- lifecycle --------------------------------------------------------
    @property
    def installed(self):
        return self._installed

    @property
    def disabled_reason(self):
        return self._disabled_reason

    def install(self, sd_module, nodes_module=None):
        """Verify every target, then install atomically; returns the count.

        An unmatched host installs nothing and is diagnosed through
        ``disabled_reason``: observation is optional, generation is not, so an
        unknown host never raises into the caller's run.
        """
        with self._lock:
            if self._installed:
                return 0
            try:
                self._codec()
            except Exception as error:
                self._disable("wire codec unavailable: %r" % (error,))
                return 0
            plan = []
            reason = self._plan(sd_module, nodes_module, plan)
            if reason is not None:
                self._disable(reason)
                return 0
            # Claim a fresh generation before touching any target. A failed
            # attempt must never leave wrappers whose generation a later retry can
            # reuse: they would come back to life as active after that retry.
            self._generation += 1
            generation = self._generation
            applied = []
            try:
                for target, name, previous, maker in plan:
                    if _live_owner(previous) is not None:
                        self.counters["peer_conflicts"] += 1
                        continue
                    wrapper = maker(previous, generation)
                    with _REGISTRY_LOCK:
                        _ACTIVE_WRAPPERS[wrapper] = (self, generation)
                    setattr(target, name, wrapper)
                    applied.append((target, name, wrapper, previous))
            except Exception as error:
                # Atomic install: undo whatever this loop already applied.
                for target, name, wrapper, previous in reversed(applied):
                    with _REGISTRY_LOCK:
                        _ACTIVE_WRAPPERS.pop(wrapper, None)
                    if getattr(target, name, None) is wrapper:
                        setattr(target, name, previous)
                self._disable("wrapper install failed: %r" % (error,))
                return 0
            self._wrappers = applied
            if not applied:
                # Every target belongs to a live peer, so this instance is not
                # installed at all. Marking it installed would permanently block
                # a later retry once that peer retires.
                return 0
            self._installed = True
            return len(applied)

    def uninstall(self):
        """Remove only the wrappers this instance still owns.

        Retiring the generation also silences every wrapper a peer still holds in
        its closure: an uninstalled bridge must not keep recording.
        """
        with self._lock:
            removed = 0
            for target, name, wrapper, previous in reversed(self._wrappers):
                with _REGISTRY_LOCK:
                    _ACTIVE_WRAPPERS.pop(wrapper, None)
                if getattr(target, name, None) is wrapper:
                    setattr(target, name, previous)
                    removed += 1
            self._wrappers = []
            self._installed = False
            self._generation += 1
            return removed

    def install_png_writer(self, images_module):
        """Optional public PNG metadata helper used by independent core savers.

        Same ownership registry/lifecycle as SaveImage; no global PIL/JSON/file
        patch. An unavailable or changed helper leaves generation untouched.
        """
        with self._lock:
            if not self._installed:
                return 0
            previous = getattr(images_module, 'inject_png_metadata', None)
            if not callable(previous) or _live_owner(previous) is not None:
                return 0
            try:
                inspect.signature(previous).bind(b'', {}, {})
            except (TypeError, ValueError):
                return 0
            bridge, generation = self, self._generation
            @functools.wraps(previous)
            def inject_png_metadata(png_bytes, prompt, extra_pnginfo):
                if not bridge._installed or generation != bridge._generation:
                    return previous(png_bytes, prompt, extra_pnginfo)
                def merge():
                    document = bridge.dependency_document(prompt)
                    if extra_pnginfo is not None and not isinstance(extra_pnginfo, collections.abc.Mapping):
                        return extra_pnginfo
                    return dict(extra_pnginfo or {}, **{PNG_FIELD: document})
                merged = bridge._guard('PNG execution document', merge)
                return previous(png_bytes, prompt, merged if merged is not None else extra_pnginfo)
            with _REGISTRY_LOCK:
                _ACTIVE_WRAPPERS[inject_png_metadata] = (self, generation)
            setattr(images_module, 'inject_png_metadata', inject_png_metadata)
            self._wrappers.append((images_module, 'inject_png_metadata', inject_png_metadata, previous))
            return 1

    def dependency_document(self, prompt):
        """Observed current-run samplers on a conservative image dependency spine.

        This survives opaque tensor transforms, but explicitly remains partial.
        Repeated list executions cannot be assigned to a particular PNG without
        pixel identity, so they export no text. No prior run is substituted.
        """
        from .output_metadata import image_dependency_nodes
        codec = self._codec()
        context = self.context_getter() if self.context_getter else None
        run_id, output_id = getattr(context, 'prompt_id', None), self.output_node_id()
        visited, warnings = image_dependency_nodes(prompt, output_id)
        stages = [dict(stage) for stage in self.observer.stage_registry.for_run(run_id)
                  if stage.get('node_id') in visited]
        for stage in stages:
            node = prompt.get(stage['node_id'], {}) if isinstance(prompt, dict) else {}
            if isinstance(node, dict) and isinstance(node.get('class_type'), str):
                stage['label'] = node['class_type']
        ids = [stage.get('node_id') for stage in stages]
        association = codec.IMAGE_ASSOCIATION_DEPENDENCY if stages else codec.IMAGE_ASSOCIATION_UNKNOWN
        if len(set(ids)) != len(ids):
            association = codec.IMAGE_ASSOCIATION_AMBIGUOUS
            warnings.append('同一采样节点执行多次，无法核验当前图片对应的列表项')
        document = codec.build_record(stages, association, output_id)
        document['warnings'] = list(dict.fromkeys(document['warnings'] + warnings))[:codec.MAX_WARNINGS]
        return self._fit_host_serialisation(codec, json.loads(codec.encode_record(document)), codec.IMAGE_ASSOCIATION_UNKNOWN)

    def health(self):
        """Bounded primitive diagnostics: fixed keys, no growing messages."""
        return {
            "bridge_version": BRIDGE_VERSION,
            "installed": self._installed,
            "generation": self._generation,
            "disabled_reason": self._disabled_reason,
            "targets": [[getattr(target, "__name__", "?"), name]
                        for target, name, _, _ in self._wrappers],
            "counters": dict(self.counters),
        }

    # -- explicit association seam ----------------------------------------
    def associate_image(self, image, stage):
        """Bind an image to a stage the caller has already proven.

        The extension point for the transforms this bridge refuses to guess
        about: a crop, a stack, a mask composite, or a custom node building an
        image outside a wrapped VAE call. The caller performed the transform and
        knows which stage the result belongs to, so it states that here.
        """
        if image is None or stage is None:
            return False
        if not self.observer.stages.put(image, stage):
            self.counters["untrackable"] += 1
            return False
        self.counters["associate_calls"] += 1
        return True

    def output_node_id(self):
        """The executing node id, read only from the injected context getter.

        ``prompt_id``, ``list_index``, and host paths are deliberately not read:
        they do not belong in a PNG record, and a batch index in particular must
        never become an image attribution.
        """
        getter = self.context_getter
        if getter is None:
            return ""
        try:
            context = getter()
        except Exception as error:
            self._note_failure("context getter", error)
            return ""
        node_id = getattr(context, "node_id", None)
        return node_id if isinstance(node_id, str) else ""

    def record_document(self, images):
        """The JSON-safe PNG document for one image batch, or None.

        Ownership comes from the observer's identity store: a tensor a wrapped
        VAE call bound to a stage is ``exact``, anything else is ``unknown`` with
        an empty chain, so a copied or stale ``tk_prompt_provenance`` value in the
        caller's metadata can never be read as this image's provenance.
        """
        codec = self._codec()
        exact = getattr(codec, "IMAGE_ASSOCIATION_EXACT", _FALLBACK_EXACT)
        unknown = getattr(codec, "IMAGE_ASSOCIATION_UNKNOWN", _FALLBACK_UNKNOWN)
        stage = self.observer.stage_for(images) if images is not None else None
        chain = list(self.observer.stage_chain(stage) or []) if stage is not None else []
        document = json.loads(codec.encode_record(
            codec.build_record(chain, exact if chain else unknown, self.output_node_id())))
        document = self._fit_host_serialisation(codec, document, unknown)
        if document.get("imageAssociation") == exact:
            self.counters["save_documents"] += 1
        else:
            self.counters["save_unknown"] += 1
        return document

    def _fit_host_serialisation(self, codec, document, unknown):
        """Re-check the size the *host* will write, not only the codec's own.

        The host serialises each ``extra_pnginfo`` value with its own
        ``json.dumps``, whose separators differ from the codec's compact form, so
        a document that only just fits the codec cap could be written too large
        and be rejected by every reader. An explicit ``unknown`` record is honest;
        one that cannot be decoded is not.
        """
        cap = getattr(codec, "MAX_RECORD_BYTES", None)
        if not isinstance(cap, int) or len(json.dumps(document)) <= cap:
            return document
        self._note_failure("document too large",
                           ValueError("record exceeds the %d byte cap in host form" % cap))
        return json.loads(codec.encode_record(
            codec.build_record([], unknown, self.output_node_id())))

    # -- wiring -----------------------------------------------------------
    def _codec(self):
        if self.codec is None:
            self.codec = load_default_codec()
        return self.codec

    def _plan(self, sd_module, nodes_module, plan):
        vae_class = getattr(sd_module, "VAE", None)
        if vae_class is None:
            return "sd module has no VAE class"
        for name, contract in VAE_CONTRACTS.items():
            func = getattr(vae_class, name, None)
            if func is None:
                return "VAE.%s missing" % name
            reason = verify_call_contract(func, contract, "VAE.%s" % name)
            if reason is not None:
                return reason
            maker = functools.partial(self._make_vae_wrapper, name)
            plan.append((vae_class, name, func, maker))
        if nodes_module is not None:
            save_class = getattr(nodes_module, "SaveImage", None)
            if save_class is None:
                return "nodes module has no SaveImage class"
            func = getattr(save_class, "save_images", None)
            if func is None:
                return "SaveImage.save_images missing"
            reason = verify_call_contract(func, SAVE_IMAGE_CONTRACT, "SaveImage.save_images")
            if reason is not None:
                return reason
            # PreviewImage inherits save_images, so the base method covers both.
            plan.append((save_class, "save_images", func, self._make_save_wrapper))
            # Public decoder nodes normalize five-dimensional VAE output into an
            # IMAGE batch. That reshape produces a different tensor identity.
            # Observe the producer boundary, never guess from shared storage or
            # tensor contents: these two public contracts decode their LATENT.
            for node_name in ("VAEDecode", "VAEDecodeTiled"):
                node_class = getattr(nodes_module, node_name, None)
                if node_class is None:
                    continue
                decoder = getattr(node_class, "decode", None)
                contract = {"positional": ("self", "vae", "samples"),
                            "keyword": ("vae", "samples"), "reject_positional_beyond": 3}
                reason = verify_call_contract(decoder, contract, node_name + ".decode")
                if reason is not None:
                    return reason
                plan.append((node_class, "decode", decoder, self._make_decode_node_wrapper))
        return None

    def _make_vae_wrapper(self, name, previous, generation):
        """One VAE wrapper: read the source stage, forward, bind the result."""
        bridge = self
        source = VAE_CONTRACTS[name]["source"]
        decoding = name.startswith("decode")
        calls = "decode_calls" if decoding else "encode_calls"
        receipts = "decode_receipts" if decoding else "encode_receipts"
        index = positional_index(previous, source)

        @functools.wraps(previous)
        def transfer(*args, **kwargs):
            if not bridge._installed or generation != bridge._generation:
                # Retired: a peer may still hold this wrapper in its closure.
                # It forwards untouched and records nothing.
                return previous(*args, **kwargs)
            if getattr(bridge._local, "depth", 0):
                # A wrapped VAE method reached from inside another wrapped one
                # (the tiled fallback path). The outer call already carries this
                # stage, so the inner one only forwards: the same sampling stage
                # is never bound twice for one result.
                return previous(*args, **kwargs)
            bridge.counters[calls] += 1
            stage = bridge._guard(
                "%s read" % name, lambda: bridge._stage_of(args, kwargs, source, index))
            bridge._local.depth = 1
            try:
                # Never guarded: the host's own exception, and any cancellation,
                # must reach the caller unchanged.
                result = previous(*args, **kwargs)
            finally:
                bridge._local.depth = 0
            if stage is None:
                return result
            bridge._guard("%s bind" % name, lambda: bridge._bind(result, stage, receipts))
            return result

        return transfer

    def _make_decode_node_wrapper(self, previous, generation):
        """Carry a proven LATENT stage through the public IMAGE producer.

        The node may normalize the decoder's five-dimensional result to a
        four-dimensional batch. We record the exact returned IMAGE, preserving
        the node's return object and exceptions. Unknown sources stay unknown;
        no tensor alias, storage address or graph branch is inferred.
        """
        bridge = self
        source_index = positional_index(previous, "samples")

        @functools.wraps(previous)
        def decode(*args, **kwargs):
            if not bridge._installed or generation != bridge._generation:
                return previous(*args, **kwargs)
            bridge.counters["node_decode_calls"] += 1

            def source_stage():
                source = args[source_index] if source_index is not None and len(args) > source_index else kwargs.get("samples")
                if not isinstance(source, collections.abc.Mapping):
                    return None
                return bridge.observer.stage_for(source.get("samples"))

            stage = bridge._guard("decode node read", source_stage)
            result = previous(*args, **kwargs)
            if stage is not None and isinstance(result, (tuple, list)) and len(result) == 1:
                bridge._guard("decode node bind", lambda: bridge._bind(result[0], stage, "node_decode_receipts"))
            return result

        return decode

    def _make_save_wrapper(self, previous, generation):
        """One SaveImage wrapper: build the record, then run the original call."""
        bridge = self

        @functools.wraps(previous)
        def save_images(*args, **kwargs):
            if not bridge._installed or generation != bridge._generation:
                return previous(*args, **kwargs)
            bridge.counters["save_calls"] += 1
            merged = bridge._guard(
                "save document", lambda: bridge._merge_document(previous, args, kwargs))
            call_args, call_kwargs = merged if merged is not None else (args, kwargs)
            return previous(*call_args, **call_kwargs)

        return save_images

    def _stage_of(self, args, kwargs, name, index):
        """The stage recorded against the wrapped call's source argument.

        Read straight from the caller's own layout instead of rebinding the whole
        call: this runs on every VAE call, where ``inspect.signature(...).bind()``
        costs more than the rest of the wrapper combined.
        """
        tensor = args[index] if index is not None and len(args) > index else kwargs.get(name)
        if tensor is None:
            return None
        return self.observer.stage_for(tensor)

    def _bind(self, result, stage, counter):
        """Bind a stage to the exact tensor the wrapped call returned.

        Only the identity store is written: no attribute, no copy, no shape or
        content hash, and no retained tensor. A tensor that refuses weak
        references is reported untrackable rather than kept alive.
        """
        if result is None:
            return False
        if self.observer.stages.put(result, stage):
            self.counters[counter] += 1
            return True
        self.counters["untrackable"] += 1
        return False

    def _merge_document(self, previous, args, kwargs):
        """Shallow-copy the caller's ``extra_pnginfo`` and add this record.

        The caller's mapping is copied, never mutated; the prompt graph,
        conditioning, images, and latents pass through untouched; and the caller's
        positional and keyword layout is preserved.
        """
        document = self.record_document(read_argument(previous, args, kwargs, "images"))
        if document and document.get('imageAssociation') == _FALLBACK_UNKNOWN:
            prompt = read_argument(previous, args, kwargs, 'prompt')
            # Preserve the original unknown outcome if the optional graph/context
            # contract is unavailable; static text is never promoted to observed.
            fallback = self._guard('save dependency document', lambda: self.dependency_document(prompt))
            if fallback is not None:
                document = fallback
        if document is None:
            return None
        current = read_argument(previous, args, kwargs, "extra_pnginfo")
        if current is None:
            merged = {}
        elif isinstance(current, collections.abc.Mapping):
            merged = dict(current)
        else:
            self.counters["untrackable"] += 1
            self._note_failure("extra_pnginfo unreadable",
                               TypeError("extra_pnginfo is %s" % type(current).__name__))
            return None
        merged[PNG_FIELD] = document
        return _replace_argument(previous, args, kwargs, "extra_pnginfo", merged)

    # -- diagnostics ------------------------------------------------------
    def _guard(self, label, func):
        """Run observation work; on failure log once and return None."""
        try:
            return func()
        except Exception as error:
            self._note_failure(label, error)
            return None

    def _note_failure(self, label, error):
        """Count and log by label only, so the set cannot grow with messages."""
        self.counters["wrapper_failures"] += 1
        if label in self._failure_logged:
            return
        self._failure_logged.add(label)
        self.log.warning("prompt image bridge failed in %s: %r", label, error)

    def _disable(self, reason):
        self._disabled_reason = reason
        self.log.warning("prompt image bridge disabled: %s", reason)
        warn = getattr(getattr(self.observer, "provenance", None), "warn", None)
        if warn is not None:
            warn("image bridge disabled: %s" % reason)


def _replace_argument(previous, args, kwargs, name, value):
    """``(args, kwargs)`` with one argument replaced in place.

    A positional argument is replaced at its own index; an omitted one is set as
    a keyword, so the host keeps receiving exactly the layout the caller used.
    """
    index = positional_index(previous, name)
    if index is not None and len(args) > index:
        return args[:index] + (value,) + args[index + 1:], kwargs
    new_kwargs = dict(kwargs)
    new_kwargs[name] = value
    return args, new_kwargs


__all__ = ["BRIDGE_VERSION", "PNG_FIELD", "PromptImageBridge", "SAVE_IMAGE_CONTRACT",
           "VAE_CONTRACTS", "load_default_codec", "positional_index", "read_argument",
           "verify_call_contract"]
