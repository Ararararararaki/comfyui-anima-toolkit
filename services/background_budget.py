"""Admission control for speculative work; never waits on generation/UI threads.

The queue is read without importing ComfyUI. Unknown memory readings fail open.
Low-memory hysteresis avoids repeatedly starting expensive work near the limit.
"""
from contextlib import contextmanager
import os
import sys
import threading
import time

_SLOT = threading.Lock()
_MEMORY_LOCK = threading.Lock()
_LOW_MEMORY = False
_MEMORY_CHECK_AT = 0.0


def _memory_available():
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes

        class MemoryStatus(ctypes.Structure):
            _fields_ = [('length', wintypes.DWORD), ('load', wintypes.DWORD)] + [
                (name, ctypes.c_ulonglong) for name in (
                    'total', 'available', 'total_page', 'available_page',
                    'total_virtual', 'available_virtual', 'extended')]
        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.total, status.available
    elif sys.platform.startswith('linux'):
        with open('/proc/meminfo', encoding='ascii') as stream:
            values = {line.split(':', 1)[0]: int(line.split()[1]) * 1024 for line in stream}
        return values['MemTotal'], values['MemAvailable']
    return None


def defer_reason():
    global _LOW_MEMORY, _MEMORY_CHECK_AT
    try:
        server = sys.modules.get('server')
        instance = getattr(getattr(server, 'PromptServer', None), 'instance', None)
        queue = getattr(instance, 'prompt_queue', None)
        if queue is not None and queue.get_tasks_remaining() > 0:
            return 'generation-active'
    except Exception:
        pass
    with _MEMORY_LOCK:
        now = time.monotonic()
        if now - _MEMORY_CHECK_AT >= 1.0:
            _MEMORY_CHECK_AT = now
            try:
                memory = _memory_available()
                if memory:
                    total, available = memory
                    # Reserve for generation and interactive requests, not a cache quota.
                    threshold = max(1.5 * 1024**3, total * (0.15 if _LOW_MEMORY else 0.10))
                    _LOW_MEMORY = available < threshold
            except Exception:
                pass
        return 'memory-pressure' if _LOW_MEMORY else None


def wait_until_idle(stop=None):
    while defer_reason():
        if stop is not None:
            if stop.wait(1.0):
                return False
        else:
            time.sleep(1.0)
    return stop is None or not stop.is_set()


@contextmanager
def background_slot(stop=None):
    """One speculative builder/decoder at a time. Foreground work bypasses it."""
    acquired = False
    try:
        while wait_until_idle(stop):
            if _SLOT.acquire(timeout=1.0):
                acquired = True
                break
        yield acquired and wait_until_idle(stop)
    finally:
        if acquired:
            _SLOT.release()
