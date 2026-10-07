"""Runtime installer for the prompt-provenance observation pair.

The plugin package imports this module through its guarded initialization. It is the
only place that knows the host and the services at once -- it imports ``comfy.sd``,
``comfy.sample``, ``nodes`` and ``comfy_execution.utils`` lazily inside
:func:`install`, hands them to the real ``PromptObserver`` and
``PromptImageBridge``, and installs the two as one unit: a host that matches only
one contract leaves generation exactly as it was found.

No wrapper, codec, graph or widget inspection, PIL/torch patch, private executor
hook, thread, HTTP route, user config or ``sys.path`` change lives here; every
wrapper belongs to the services, and every failure becomes a bounded string. State
hangs on the owning package, so a reload of this file finds the pair it already
installed. Whole-package purges explicitly retire verified predecessor pairs.
"""

import importlib
import logging
import sys
import threading

LOG = logging.getLogger("anima.prompt_provenance.installer")

INSTALLER_VERSION = "0.1.0"

# Reload-durable state anchor, and the cap on every string this module publishes.
_STATE_ATTR = "_anima_prompt_provenance_installer"
_REASON_CHARS = 240

# The production layout is fixed: exactly these three relative imports and no
# fallback, so a missing service is reported rather than silently replaced by
# another module that happens to be importable.
_SERVICE_IMPORTS = (
    ("observer", "prompt observer service", ".services.prompt_observer"),
    ("bridge", "prompt image bridge service", ".services.prompt_image_bridge"),
    ("codec", "prompt record codec", ".services.prompt_record"),
)

_HOST_PATHS = ("comfy.sd", "comfy.sample", "nodes", "comfy_execution.utils")


class _State:
    """Everything install/uninstall/status share, and nothing that can leak."""

    __slots__ = ("lock", "observer", "bridge", "sources", "installed", "reason",
                 "diagnosis", "installs", "uninstalls", "retirements")

    def __init__(self):
        self.lock = threading.RLock()
        self.observer = self.bridge = None
        self.sources = {}
        self.installed = False
        self.reason = self.diagnosis = None
        self.installs = self.uninstalls = self.retirements = 0


def _holder():
    """The module the state hangs on: the owning package, else this module.

    A package object outlives ``importlib.reload`` of its own submodules, so the
    installed pair survives a host reload of this file.
    """
    if __package__:
        package = sys.modules.get(__package__)
        if package is not None:
            return package
    return sys.modules.get(__name__)


def _state():
    holder = _holder()
    state = getattr(holder, _STATE_ATTR, None)
    if state is None:
        state = _State()
        setattr(holder, _STATE_ATTR, state)
    return state


def _bounded(text):
    """One line, hard-capped: no message may grow with an exception's content."""
    if text is None:
        return None
    collapsed = " ".join(str(text).split())
    if len(collapsed) <= _REASON_CHARS:
        return collapsed
    return collapsed[:_REASON_CHARS - 3] + "..."


def _note(state, message):
    bounded = _bounded(message)
    if bounded != state.diagnosis:
        LOG.warning("prompt provenance installer: %s", bounded)
    state.diagnosis = bounded


def _service_view(service):
    """Primitives only: a service's published counters, never its stored cache."""
    view = {"present": service is not None, "installed": False, "wrappers": 0, "counters": {}}
    if service is None:
        return view
    view["installed"] = bool(getattr(service, "installed", False))
    try:
        health = service.health()
        view["wrappers"] = len(health.get("wrappers") or health.get("targets") or ())
        view["counters"] = {str(k): v for k, v in (health.get("counters") or {}).items()
                            if isinstance(v, int) and not isinstance(v, bool)}
    except Exception as error:
        view["error"] = type(error).__name__
    return view


def _snapshot(state, reason):
    return {
        "installer_version": INSTALLER_VERSION,
        "installed": _active(state),
        "reason": _bounded(reason),
        "diagnosis": _bounded(state.diagnosis),
        "installs": state.installs, "uninstalls": state.uninstalls, "retirements": state.retirements,
        "sources": dict(state.sources),
        "observer": _service_view(state.observer),
        "bridge": _service_view(state.bridge),
    }


def _active(state):
    """Whether this installer's pair is still the pair installed on the host."""
    if not state.installed or state.observer is None or state.bridge is None:
        return False
    return (bool(getattr(state.observer, "installed", False))
            and bool(getattr(state.bridge, "installed", False)))


def _load_host():
    """Import the host modules; returns ``(modules, None)`` or ``(None, reason)``."""
    modules = []
    for name in _HOST_PATHS:
        try:
            modules.append(importlib.import_module(name))
        except Exception as error:
            return None, "%s unavailable: %s" % (name, type(error).__name__)
    return tuple(modules), None


def _import_service(path, label):
    """Import one fixed relative service path; returns ``(module, source|reason)``."""
    try:
        return importlib.import_module(path, __package__), path
    except Exception as error:
        return None, "%s unavailable: %s (%s)" % (label, path, type(error).__name__)


def _half_live(state):
    """Whether a predecessor pair still has one half installed.

    Only a half that is *installed* needs retiring; a pair that is already retired
    stays referenced for diagnostics and must not be retired again on every retry,
    or the retirement counter would count attempts instead of pairs.
    """
    for service in (state.observer, state.bridge):
        if service is not None and getattr(service, "installed", False):
            return True
    return False


def _activate(state, sd_module, sample_module, nodes_module, context_module):
    """Install both halves in order; returns ``None`` on success, else a reason."""
    halves = (("observer", (sd_module, sample_module, context_module)),
              ("bridge", (sd_module, nodes_module)))
    for label, arguments in halves:
        service = getattr(state, label)
        try:
            service.install(*arguments)
        except Exception as error:
            return "%s install failed: %r" % (label, error)
        if not getattr(service, "installed", False):
            reason = getattr(service, "disabled_reason", None) or "contract not matched"
            return "%s disabled: %s" % (label, reason)
    return None


def _rollback(state):
    """Retire the pair, newest install first, and remove only owned wrappers.

    Both objects are always visited, including one whose own install never ran and
    one whose mate was disabled by someone else: a half-live predecessor must not
    keep observing beside the pair that replaces it.
    """
    state.retirements += 1
    for service in (state.bridge, state.observer):
        if service is None:
            continue
        try:
            service.uninstall()
        except Exception as error:
            _note(state, "rollback failed: %r" % (error,))


def _disabled(state, reason):
    state.installed = False
    state.reason = _bounded(reason)
    LOG.warning("prompt provenance installer disabled: %s", state.reason)
    return _snapshot(state, state.reason)


def _retire_purged_pairs(nodes_module):
    """Retire our live predecessor pairs after a whole-package module purge.

    The public SaveImage wrapper can outlive its deleted package. Its own
    registry still proves ownership. Inspect only this module's bridge registry,
    following the documented __wrapped__ chain; never retire another plugin.
    Collect before changing anything, newest owner first, with a bounded walk.
    """
    save_class = getattr(nodes_module, "SaveImage", None)
    current = getattr(save_class, "save_images", None)
    expected = __package__ + ".services.prompt_image_bridge"
    observer_module = __package__ + ".services.prompt_observer"
    seen, owners = set(), []
    for _ in range(16):
        if current is None:
            break
        if id(current) in seen:
            return "cyclic save wrapper chain; predecessor retirement skipped"
        seen.add(id(current))
        namespace = getattr(current, "__globals__", {})
        if namespace.get("__name__") == expected:
            lookup = namespace.get("_live_owner")
            owner = lookup(current) if callable(lookup) else None
            if owner is not None and type(owner).__module__ == expected:
                observer = getattr(owner, "observer", None)
                if observer is None or type(observer).__module__ != observer_module:
                    return "predecessor observer ownership cannot be verified"
                if all(owner is not previous for previous in owners):
                    owners.append(owner)
        current = getattr(current, "__wrapped__", None)
    else:
        return "save wrapper chain exceeds retirement bound"
    if not owners:
        return None
    server_module = sys.modules.get("server")
    server = getattr(getattr(server_module, "PromptServer", None), "instance", None)
    queue = getattr(server, "prompt_queue", None)
    if queue is not None:
        try:
            if queue.get_tasks_remaining():
                return "generation queue is active; predecessor retirement deferred"
        except Exception:
            return "generation queue state unavailable; predecessor retirement deferred"
    try:
        for owner in owners:
            owner.uninstall()
            owner.observer.uninstall()
            if owner.installed or owner.observer.installed:
                return "predecessor retirement did not complete"
    except Exception as error:
        return "predecessor retirement failed: %r" % (error,)
    return None


def install():
    """Install observer and bridge as one unit; returns a bounded status.

    Never raises into the caller's run: an unavailable host, a changed contract or a
    service that throws end as ``installed: False`` plus a reason, with whatever was
    already applied rolled back. A repeat call is a no-op.
    """
    state = _state()
    with state.lock:
        if _active(state):
            return _snapshot(state, "already installed")
        if _half_live(state):
            # A predecessor that is only half live is retired first, before the host
            # is even looked for: no stale wrapper may stay active beside the pair
            # that replaces it, and an unavailable host must not preserve one.
            _rollback(state)
        modules, reason = _load_host()
        if modules is None:
            return _disabled(state, reason)
        try:
            reason = _retire_purged_pairs(modules[2])
        except Exception as error:
            reason = "predecessor inspection failed: %r" % (error,)
        if reason is not None:
            return _disabled(state, reason)
        services, sources = {}, {}
        for key, label, path in _SERVICE_IMPORTS:
            module, source = _import_service(path, label)
            if module is None:
                return _disabled(state, source)
            services[key], sources[key] = module, source
        sd_module, sample_module, nodes_module, context_module = modules
        try:
            state.observer = services["observer"].PromptObserver()
            state.bridge = services["bridge"].PromptImageBridge(
                state.observer, codec=services["codec"],
                context_getter=context_module.get_executing_context)
        except Exception as error:
            if state.observer is not None or state.bridge is not None:
                _rollback(state)
            return _disabled(state, "service construction failed: %r" % (error,))
        state.sources = sources
        reason = _activate(state, sd_module, sample_module, nodes_module, context_module)
        if reason is not None:
            _rollback(state)
            return _disabled(state, reason)
        state.installed = True
        # Optional newer core save path. Older hosts keep the existing pair;
        # unsupported helpers never make generation or the pair fail.
        try:
            advanced = getattr(nodes_module, 'NODE_CLASS_MAPPINGS', {}).get('SaveImageAdvanced')
            # ComfyUI loads extras with importlib under a runtime alias. Importing
            # the source path again produces a different module with no live saver.
            images_module = sys.modules.get(getattr(advanced, '__module__', ''))
            if images_module is not None:
                state.bridge.install_png_writer(images_module)
        except Exception as error:
            _note(state, 'optional PNG writer unavailable: %s' % type(error).__name__)
        state.installs += 1
        state.reason = state.diagnosis = None
        return _snapshot(state, None)


def uninstall():
    """Retire the pair and remove only the wrappers it still owns."""
    state = _state()
    with state.lock:
        if state.observer is None and state.bridge is None:
            return _snapshot(state, "not installed")
        for service in (state.bridge, state.observer):
            if service is None:
                continue
            try:
                service.uninstall()
            except Exception as error:
                _note(state, "uninstall failed: %r" % (error,))
        state.installed = False
        state.uninstalls += 1
        state.reason = None
        return _snapshot(state, "uninstalled")


def associate_image(image, stage):
    """State a proven image -> stage association for an opaque transform.

    The caller performed the transform (crop, stack, mask composite, custom saver)
    and knows which stage the result belongs to; this forwards that statement and
    never infers one. ``False`` means nothing was recorded.
    """
    state = _state()
    with state.lock:
        bridge = state.bridge if _active(state) else None
    if bridge is None:
        return False
    try:
        return bool(bridge.associate_image(image, stage))
    except Exception as error:
        _note(state, "associate_image failed: %r" % (error,))
        return False


def status():
    """Bounded primitive diagnostics: flags, counters and one reason string."""
    state = _state()
    with state.lock:
        return _snapshot(state, state.reason)


__all__ = ["INSTALLER_VERSION", "associate_image", "install", "status", "uninstall"]
