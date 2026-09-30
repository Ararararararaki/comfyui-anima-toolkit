"""Keep blocking gallery I/O off the event loop; bound live image streams and source searches."""
from __future__ import annotations

import asyncio
import weakref

_stream_limits = weakref.WeakKeyDictionary()
_search_limits = weakref.WeakKeyDictionary()


def _stream_limit():
    loop = asyncio.get_running_loop()
    return _stream_limits.setdefault(loop, asyncio.Semaphore(4))


async def search_with_warnings(source, query, cursor, limit, **filters):
    # Adapters keep warnings on their instance. Serialize each source through the
    # warning snapshot so two searches cannot exchange another request's errors.
    locks = _search_limits.setdefault(asyncio.get_running_loop(), weakref.WeakKeyDictionary())
    lock = locks.setdefault(source, asyncio.Lock())
    async with lock:
        task = asyncio.create_task(asyncio.to_thread(source.search, query, cursor, limit, **filters))
        try:
            items, next_cursor = await asyncio.shield(task)
        except asyncio.CancelledError:
            try:
                await task
            except Exception:
                pass
            raise
        warnings = list(getattr(source, "last_warnings", []) or []) if not items else []
        return items, next_cursor, warnings


class ThreadedImageStream:
    def __init__(self, upstream, limit):
        self.upstream = upstream
        self.headers = upstream.headers
        self.limit = limit

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        try:
            await asyncio.to_thread(self.upstream.close)
        finally:
            self.limit.release()

    async def read(self, size: int) -> bytes:
        task = asyncio.create_task(asyncio.to_thread(self.upstream.read, size))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # A running blocking read cannot be interrupted by cancelling its Future.
            # Let it finish before closing the socket; the event loop stays available.
            try:
                await task
            except Exception:
                pass
            raise


async def open_image_stream(opener, *args, **kwargs) -> ThreadedImageStream:
    limit = _stream_limit()
    await limit.acquire()
    task = asyncio.create_task(asyncio.to_thread(opener, *args, **kwargs))
    try:
        upstream = await asyncio.shield(task)
    except asyncio.CancelledError:
        # If the client leaves during connect, still close the eventual response.
        try:
            try:
                upstream = await task
            except Exception:
                pass
            else:
                await asyncio.to_thread(upstream.close)
        finally:
            limit.release()
        raise
    except Exception:
        limit.release()
        raise
    return ThreadedImageStream(upstream, limit)
