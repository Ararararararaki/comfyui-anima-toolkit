"""Thread-local connection pools with request-scoped configuration and drainable close."""
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
        with self._condition:
            if self._closed:
                raise RuntimeError("Toolkit thread HTTP resources are closed")
            lease = getattr(self._local, "lease", None)
            if lease is None:
                session = self._factory()
                session.trust_env = False
                session.headers.update(self._headers)
                lease = _ThreadSession(session, self._retire_session)
                self._local.lease = lease
                self._sessions.append((session, lease.finalizer))
            session = lease.session
            self._active += 1
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
        # Registration can run in a loader thread; reject new leases before
        # dispatching the drain onto the application's executor.
        with self._condition:
            self._closed = True


_APP_OWNERS_KEY = "tk_thread_http_owners"


def install(app, owner, *, namespace="danbooru"):
    """One stable app slot retires replaced worker pools off the event loop."""
    key = _APP_OWNERS_KEY if namespace == "danbooru" else _APP_OWNERS_KEY + "." + namespace
    slot = app.get(key)
    if slot is not None:
        previous = slot["owner"]
        if previous is owner:
            return
        if previous is not None:
            begin_close = getattr(previous, "_begin_close", None)
            if begin_close is not None:
                begin_close()
            # Aiohttp startup owns this loop. Import/reload may run inside an
            # unrelated asyncio.run() which is about to close.
            loop = slot.get("loop") or getattr(app, "_loop", None)
            if loop is None or not loop.is_running():
                slot["pending"].append(previous)
            else:
                slot["retiring"].append(asyncio.run_coroutine_threadsafe(asyncio.to_thread(previous.close), loop))
        slot["owner"] = owner
        return

    slot = {"owner": owner, "retiring": [], "pending": [], "loop": getattr(app, "_loop", None)}

    async def startup(application):
        slot["loop"] = asyncio.get_running_loop()

    async def cleanup(application):
        current = slot["owner"]
        if current is not None:
            await asyncio.to_thread(current.close)
        for pending in slot["pending"]:
            await asyncio.to_thread(pending.close)
        if slot["retiring"]:
            await asyncio.gather(*(asyncio.shield(asyncio.wrap_future(item)) for item in slot["retiring"]))
        slot["pending"].clear()
        slot["retiring"].clear()
        slot["owner"] = None

    app[key] = slot
    # Normal registration precedes startup; a first install into a live/frozen
    # app instead uses aiohttp's already-bound loop above.
    on_startup = getattr(app, "on_startup", None)
    if on_startup is not None and not getattr(on_startup, "frozen", False):
        on_startup.append(startup)
    app.on_cleanup.append(cleanup)
