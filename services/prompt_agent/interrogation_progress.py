"""Small ComfyUI progress adapter; inference services do not own the host."""
from __future__ import annotations

EVENT = "tk_prompt_agent_interrogation"


def reporter(session_id: str):
    def publish(progress):
        from .execution import record_progress
        task_id = record_progress(progress)
        # The host is optional for offline core tests and tooling.
        try:
            from server import PromptServer
            host = PromptServer.instance
        except (ImportError, AttributeError):
            return
        send = getattr(host, "send_sync", None)
        if send is not None:
            send(EVENT, {"session_id": session_id, **({"task_id": task_id} if task_id else {}), **progress})
    return publish
