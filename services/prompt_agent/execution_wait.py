"""The node owns host interruption; HTTP-only editing keeps its own cancellation."""
from __future__ import annotations

import asyncio


async def await_interruptible(operation, *, check=None, interval=.25):
    if check is None:
        from comfy.model_management import throw_exception_if_processing_interrupted
        check = throw_exception_if_processing_interrupted
    task = asyncio.ensure_future(operation)
    try:
        while True:
            check()
            done, _ = await asyncio.wait((task,), timeout=interval)
            if done:
                check()
                return task.result()
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
