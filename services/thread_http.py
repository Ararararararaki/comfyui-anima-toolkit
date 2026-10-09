"""App-owned clients select drainable, thread-local HTTP pool generations.

Cached nodes keep the client returned by install(), even after a package purge.
Each request leases the current generation before reload can retire it. Already
accepted requests finish on their original session; subsequent requests use the
replacement. A retired raw pool never admits new work.
"""
import asyncio
import threading
import weakref
import requests


class _ThreadSession:
    """Retire a worker's connection pool when its thread-local lease disappears."""
    def __init__(self, session, retire):
        self.session = session
        self.finalizer = weakref.finalize(self, retire, session)


class ThreadHttp:
    def __init__(self, headers=None, session_factory=requests.Session, session_configurer=None):
        self._headers = dict(headers or {})
        self._factory = session_factory
        self._configure_session = session_configurer
        self._local = threading.local()
        self._condition = threading.Condition()
        self._sessions = []
        self._active = 0
        self._closed = False

    def request(self, method, url, *, proxies=None, **kwargs):
        session = self._acquire()
        return self._request_acquired(session, method, url, proxies=proxies, **kwargs)

    def _acquire(self):
        with self._condition:
            lease = getattr(self._local, "lease", None)
            if self._closed:
                raise RuntimeError("Toolkit thread HTTP resources are closed")
            if lease is None:
                session = self._factory()
                session.trust_env = False
                session.headers.update(self._headers)
                lease = _ThreadSession(session, self._retire_session)
                self._local.lease = lease
                self._sessions.append((session, lease.finalizer))
            session = lease.session
            self._active += 1
            return session

    def _request_acquired(self, session, method, url, *, proxies=None, **kwargs):
        try:
            if self._configure_session is not None:
                self._configure_session(session)
            return session.request(method, url, proxies=dict(proxies or {}), **kwargs)
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()

    def _retire_session(self, session):
        with self._condition:
            for i, (registered, finalizer) in enumerate(self._sessions):
                if registered is session:
                    self._sessions.pop(i)
                    break
            else:
                return  # Explicit close already owns this pool.
        session.close()

    def close(self):
        with self._condition:
            self._closed = True
            self._condition.wait_for(lambda: not self._active)
            sessions, self._sessions = self._sessions, []
        for session, finalizer in sessions:
            finalizer.detach()
            session.close()

    def _begin_close(self):
        # Mark retirement synchronously; drain active requests off the host loop.
        with self._condition:
            self._closed = True
            self._condition.notify_all()


_APP_OWNERS_KEY = "tk_thread_http_owners"


class ThreadHttpClient:
    """Stable namespace handle; no module identity or worker affinity is required."""
    def __init__(self, slot):
        self._slot = slot

    def request(self, method, url, *, proxies=None, **kwargs):
        with self._slot["lock"]:
            owner = self._slot["owner"]
            if owner is None:
                raise RuntimeError("Toolkit thread HTTP resources are closed")
            session = owner._acquire()
        # Never hold the namespace lock during network I/O or pool draining.
        return owner._request_acquired(session, method, url, proxies=proxies, **kwargs)


def install(app, owner, *, namespace="danbooru"):
    """Return the app's stable client and replace only its underlying pools."""
    key = _APP_OWNERS_KEY if namespace == "danbooru" else _APP_OWNERS_KEY + "." + namespace
    slot = app.get(key)
    if slot is not None:
        # Existing app slots predate the stable client on the first upgrade.
        slot.setdefault("lock", threading.Lock())
        if "client" not in slot:
            slot["client"] = ThreadHttpClient(slot)
        with slot["lock"]:
            previous = slot["owner"]
            if slot.get("stopped"):
                raise RuntimeError("Toolkit thread HTTP resources are closed")
            if owner is slot["client"] or previous is owner:
                return slot["client"]
            if previous is not None:
                previous._begin_close()
            slot["owner"] = owner
            if previous is not None:
                # Use the host loop, never a temporary loader's asyncio.run().
                loop = slot.get("loop") or getattr(app, "_loop", None)
                if loop is None or not loop.is_running():
                    slot["pending"].append(previous)
                else:
                    slot["retiring"] = [future for future in slot["retiring"]
                                        if not future.done() or future.exception() is not None]
                    slot["retiring"].append(asyncio.run_coroutine_threadsafe(asyncio.to_thread(previous.close), loop))
        return slot["client"]

    if getattr(app.on_cleanup, "frozen", False):
        raise RuntimeError("线程 HTTP 资源生命周期尚未安装，请正常重启 ComfyUI 一次")
    slot = {"owner": owner, "retiring": [], "pending": [], "loop": getattr(app, "_loop", None),
            "lock": threading.Lock(), "stopped": False}
    slot["client"] = ThreadHttpClient(slot)

    async def startup(application):
        slot["loop"] = asyncio.get_running_loop()

    async def cleanup(application):
        with slot["lock"]:
            slot["stopped"] = True
            current, slot["owner"] = slot["owner"], None
            pending, slot["pending"] = slot["pending"], []
            retiring, slot["retiring"] = slot["retiring"], []
        if current is not None:
            await asyncio.to_thread(current.close)
        for previous in pending:
            await asyncio.to_thread(previous.close)
        if retiring:
            await asyncio.gather(*(asyncio.shield(asyncio.wrap_future(item)) for item in retiring))

    app[key] = slot
    # First registration precedes startup. Replacements retain this hook and
    # use the host loop captured by startup, including on a frozen application.
    on_startup = getattr(app, "on_startup", None)
    if on_startup is not None and not getattr(on_startup, "frozen", False):
        on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    return slot["client"]
