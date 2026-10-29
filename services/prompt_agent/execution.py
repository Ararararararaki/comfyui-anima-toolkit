"""Run ownership shared by HTTP and ComfyUI: one model snapshot, bounded jobs, cancellation."""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass, field
import logging
import threading
import time
from uuid import uuid4

from .errors import AgentError, SessionConflict
from .storage import identifier

_current = ContextVar("prompt_agent_execution", default=None)
TERMINAL = {"completed", "failed", "cancelled"}


def model_snapshot():
    scope = _current.get()
    return deepcopy(scope[1]) if scope else None


def check_current():
    scope = _current.get()
    if scope and scope[0].cancel_requested:
        raise asyncio.CancelledError()


def record_progress(progress):
    scope = _current.get()
    if scope:
        check_current()
        job = scope[0]
        if progress.get("stage") not in {"completed", "failed", "cancelled", "expansion_failed"}:
            job.phase = progress.get("stage", job.phase)
        job.progress = {k: deepcopy(v) for k, v in progress.items()
                        if k in {"stage", "model", "protocol", "elapsed", "received_bytes", "message"}}
        return job.id
    return ""


@dataclass
class Job:
    id: str
    session: str
    model: str
    status: str = "queued"
    phase: str = "preparing"
    created: float = field(default_factory=time.monotonic)
    finished: float = 0
    progress: dict = field(default_factory=dict)
    result: dict | None = None
    error: Exception | None = None
    task: asyncio.Task | None = None
    cancel_requested: bool = False

    def public(self):
        value = {"task_id": self.id, "session_id": self.session, "status": self.status,
                 "phase": self.phase, "model": self.model, "progress": deepcopy(self.progress),
                 "elapsed": round((self.finished or time.monotonic()) - self.created, 1)}
        if self.status == "completed":
            value["result"] = deepcopy(self.result)
        elif self.error:
            value["error"] = str(self.error)
            value["error_status"] = 409 if isinstance(self.error, SessionConflict) else 400
        return value


class ExecutionCore:
    """Sessions cannot overlap; cancelled/late runs cannot commit approved state."""
    def __init__(self, runtime):
        self.runtime = runtime
        self.jobs = {}
        self._guard = threading.RLock()

    def _prune(self):
        now = time.monotonic()
        completed = sorted((j for j in self.jobs.values() if j.status in TERMINAL),
                           key=lambda j: j.finished, reverse=True)
        for index, job in enumerate(completed):
            if index >= 24 or now - job.finished > 1800:
                self.jobs.pop(job.id, None)

    def start(self, kind, request, *, tensor=None):
        if kind not in {"edit", "retry", "interrogate", "expand-interrogation", "interrogate-accept", "layout-accept"}:
            raise AgentError("未知 Prompt Agent 任务类型")
        request = deepcopy(request)
        sid = identifier(request.get("session_id", ""))
        with self._guard:
            self._prune()
            if any(j.session == sid and j.status not in TERMINAL for j in self.jobs.values()):
                raise SessionConflict("本会话已有任务运行；请完成或取消后再提交，不会重复发送付费请求。")
            if sum(j.status not in TERMINAL for j in self.jobs.values()) >= 8:
                raise AgentError("同时运行的 Prompt Agent 任务过多，请等待已有任务完成。")
            options = request.get("options", {})
            selection = request.get("model_selection")
            if selection is None and isinstance(options, dict):
                selection = {"source": options.get("vision_provider", "current"),
                             "model": options.get("vision_model", "")}
            local_layout = kind == "layout-accept" and isinstance(request.get("layout"), dict) and request["layout"].get("llm_expand") is False
            # Native Relay owns its model adapters and credentials. Requiring
            # a readable Chat Completions config first prevents otherwise valid
            # DSH installations from using their native Agent.
            native = kind == "edit" and request.get("generation_strategy") == "native"
            if native and selection is not None and (not isinstance(selection, dict) or
                    not isinstance(selection.get("source", "current"), str) or not isinstance(selection.get("model", ""), str)):
                raise AgentError("模型连接或模型 ID 无效。")
            config = ({"model": ""} if local_layout else
                      {**self.runtime.config.load(), "model": (selection or {}).get("model", "") or "DSH"} if native else
                      self.runtime.model_config(selection))
            job = Job(uuid4().hex, sid, config.get("model", ""))
            self.jobs[job.id] = job
            job.task = asyncio.create_task(self._run(job, kind, request, config, tensor))
            def finished(task):
                if task.cancelled():
                    job.status, job.finished = "cancelled", time.monotonic()
            job.task.add_done_callback(finished)
            return job.public()

    def _job(self, task_id, session_id):
        with self._guard:
            self._prune()
            job = self.jobs.get(task_id)
            if not job or job.session != session_id:
                raise AgentError("任务不存在、已过期或不属于本会话；请勿自动重发。")
            return job

    def status(self, task_id, session_id):
        with self._guard:
            return self._job(task_id, session_id).public()

    def cancel(self, task_id, session_id):
        with self._guard:
            job = self._job(task_id, session_id)
            if job.status not in TERMINAL:
                job.cancel_requested = True
                job.status = "cancelling"
                job.task.get_loop().call_soon_threadsafe(job.task.cancel)
            return job.public()

    async def execute(self, kind, request, *, tensor=None):
        ticket = self.start(kind, request, tensor=tensor)
        job = self._job(ticket["task_id"], ticket["session_id"])
        try:
            await job.task
        except asyncio.CancelledError:
            self.cancel(job.id, job.session)
            raise
        if job.error:
            raise job.error
        if job.status == "cancelled":
            raise asyncio.CancelledError()
        return deepcopy(job.result)

    async def _run(self, job, kind, request, config, tensor):
        token = _current.set((job, config))
        job.status = "running"
        try:
            check_current()
            if kind in {"edit", "retry"}:
                job.phase = "editing"
                result = await self.runtime.agent.edit(request, **({"retry": True} if kind == "retry" else {}))
            elif kind == "layout-accept":
                from .layout import accept_layout
                job.phase = "layout-expansion"
                result = await accept_layout(self.runtime, request, tensor)
            elif kind == "expand-interrogation":
                result = await self.runtime.interrogation.expand(request)
            else:
                result = await self.runtime.interrogation.run(
                    {k: v for k, v in request.items() if k not in {"revision", "action", "locks"}}, tensor=tensor)
                if kind == "interrogate-accept":
                    if result.get("expansion_error"):
                        raise AgentError("标签反推已完成，但看图扩写失败：" + result["expansion_error"])
                    if not result.get("formatted_prompt"):
                        raise AgentError(result.get("message", "未生成有效 Prompt"))
                    check_current()
                    approved = self.runtime.agent.accept_interrogation({
                        "session_id": job.session, "revision": request["revision"],
                        "profile": request["profile"], "prompt": result["formatted_prompt"],
                        "action": request["action"], "locks": request.get("locks", []),
                        "expansion_skill": request.get("options", {}).get("expansion_skill", "")})
                    warnings = [*approved.get("warnings", []), *result.get("quality_warnings", [])]
                    result = {**approved, "interrogation": result, "warnings": warnings,
                              "message": approved.get("message", "") + (" 质量提示：" + " ".join(warnings) if warnings else "")}
            check_current()
            job.result, job.status = result, "completed"
        except asyncio.CancelledError:
            job.status = "cancelled"
        except AgentError as error:
            job.error = error if isinstance(error, SessionConflict) else AgentError(
                f"任务 {job.id[:8]}，阶段 {job.phase}：{error}")
            job.status = "failed"
        except Exception:
            logging.getLogger(__name__).exception("Prompt Agent task %s failed in %s", job.id, job.phase)
            job.error = AgentError(f"任务 {job.id[:8]}，阶段 {job.phase}：内部错误，本轮未确认，请检查服务端日志。")
            job.status = "failed"
        finally:
            job.finished = time.monotonic()
            _current.reset(token)
