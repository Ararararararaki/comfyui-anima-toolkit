"""Own native Harness runs through the installed Relay's public MCP interface.

DSH owns its tools, skills, model adapters and permission enforcement. This
module owns only the Toolkit operation and its request file. It neither boots
another Host nor reads someone else's Session log. Relay 0.2.17 does not expose
tool-call records: reports leave that count unknown and link to the native UI.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import inspect
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit, urlunsplit
import uuid

from .errors import AgentError

_FINAL_BEGIN = "<<<TK_FINAL_PROMPT>>>"
_FINAL_END = "<<<TK_FINAL_PROMPT_END>>>"
_TERMINAL = {"succeeded", "incomplete", "failed", "cancelled"}
_SOURCES = {"dsh-active", "dsh-workbuddy", "dsh-opencode"}
_REQUIRED_TOOLS = {"list_capabilities", "list_workspaces", "start_run", "wait_run", "cancel_run"}


def _local_url(value: object) -> str:
    try:
        parts = urlsplit(value)
        if parts.scheme != "http" or parts.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError()
        if parts.username or parts.password or not parts.port or parts.query or parts.fragment:
            raise ValueError()
        return urlunsplit(parts)
    except (ValueError, TypeError):
        raise AgentError("DSH Relay 地址必须是本机 HTTP 地址。") from None


@dataclass(repr=False)
class Endpoint:
    url: str
    token: str
    host_url: str
    authority: str
    epoch: int


def read_endpoint(path: Path) -> Endpoint:
    """Read the versioned public descriptor and its separate token, in memory."""
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(document, dict) or document.get("schemaVersion") != 1:
            raise ValueError()
        if document.get("mode") not in {"embedded", "standalone"}:
            raise ValueError()
        url = _local_url(document["mcpUrl"])
        host = _local_url(document["hostWebUrl"])
        if urlsplit(url).netloc != urlsplit(host).netloc:
            raise ValueError()
        token_path = Path(document["tokenFilePath"])
        if not token_path.is_absolute():
            raise ValueError()
        token = token_path.read_text(encoding="utf-8").strip()
        if not token or len(token) > 8192 or any(char.isspace() for char in token):
            raise ValueError()
        epoch = document["ownerEpoch"]
        if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch <= 0:
            raise ValueError()
        authority = document["authorityId"]
        if not isinstance(authority, str) or not authority:
            raise ValueError()
        return Endpoint(url, token, host, authority, epoch)
    except AgentError:
        raise
    except (OSError, ValueError, TypeError, KeyError):
        raise AgentError("无法读取 DSH Relay 连接；请启动已安装 Relay 的 DSH。") from None


def _unwrap(result):
    """Keep MCP errors and transport exceptions out of public node diagnostics."""
    if isinstance(result, dict):  # The injected test adapter has the same face.
        return result
    if getattr(result, "isError", False):
        raise AgentError("DSH 原生操作失败；请在 DSH 查看本次运行。")
    value = getattr(result, "structuredContent", None)
    if isinstance(value, dict):
        return value
    for block in getattr(result, "content", ()):
        if getattr(block, "type", None) == "text":
            try:
                value = json.loads(block.text)
            except (TypeError, ValueError):
                continue
            if isinstance(value, dict):
                return value
    raise AgentError("DSH Relay 返回了无法读取的结果。")


@asynccontextmanager
async def sdk_connector(endpoint: Endpoint):
    """Versioned SDK transport; localhost bypasses ambient external proxies."""
    try:
        import httpx
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
    except ImportError:
        raise AgentError("原生 DSH 执行需要安装 mcp==1.26.0。") from None
    headers = {"Authorization": f"Bearer {endpoint.token}",
               "x-dsh-relay-principal": "toolkit-prompt-agent"}
    async with httpx.AsyncClient(headers=headers, trust_env=False, follow_redirects=False,
                                 timeout=httpx.Timeout(40.0)) as client:
        async with streamable_http_client(endpoint.url, http_client=client,
                                          terminate_on_close=False) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
                if not _REQUIRED_TOOLS <= {tool.name for tool in tools.tools}:
                    raise AgentError("DSH Relay 缺少原生执行接口，请更新 Relay 后重试。")

                class Peer:
                    async def call(self, name, arguments):
                        result = await session.call_tool(name, arguments)
                        if result.isError:
                            # Relay's public tool error is useful for diagnosis,
                            # but credentials must never enter public messages.
                            message = " ".join(block.text for block in result.content if getattr(block, "type", "") == "text")
                            message = message.replace(endpoint.token, "[redacted]")
                            raise AgentError("DSH 原生接口：" + message[:400])
                        return _unwrap(result)

                yield Peer()


def _selection(capabilities: dict, connection: dict, settings: dict) -> dict:
    if connection.get("id") not in _SOURCES:
        raise AgentError("DSH 原生执行需要选择 DSH 模型来源。")
    catalog = capabilities.get("models", {})
    route = catalog.get("default", {}) if connection["id"] == "dsh-active" and not connection.get("model_override") else connection
    provider, model = route.get("provider"), route.get("model")
    found = next((entry for group in catalog.get("groups", []) if group.get("id") == provider
                  for entry in group.get("models", []) if entry.get("id") == model), None)
    if found is None:
        raise AgentError("此 DSH 模型当前不可用，请在 DSH 配置后重试。")
    selected = {"provider": provider, "model": model}
    effort = settings.get("reasoning_effort") or route.get("reasoningEffort")
    if effort:
        if effort not in {item.get("id") for item in found.get("reasoning", {}).get("efforts", [])}:
            raise AgentError("此 DSH 模型不支持所选思考强度。")
        selected["reasoningEffort"] = effort
    preset = settings.get("agent_preset", "")
    presets = capabilities.get("presets", {}).get("presets", [])
    if preset and preset not in {item.get("id") for item in presets}:
        raise AgentError("DSH 中没有所选 Agent 预设。")
    if "read-only" not in capabilities.get("permissionPresets", []):
        raise AgentError("当前 DSH 没有只读权限预设。")
    return selected


def _assistant_text(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AgentError("DSH 本次运行没有返回最终稿，原提示词已保留。")
    text = value.strip()
    if _FINAL_BEGIN in text or _FINAL_END in text:
        if text.count(_FINAL_BEGIN) != 1 or text.count(_FINAL_END) != 1:
            raise AgentError("DSH 最终稿标记不完整，原提示词已保留。")
        before, rest = text.split(_FINAL_BEGIN, 1)
        body, after = rest.split(_FINAL_END, 1)
        if after.strip():
            raise AgentError("DSH 最终稿后仍有额外内容，原提示词已保留。")
        text = body.strip()
    return text


def _run(value, active=None):
    value = _unwrap(value)
    if (not isinstance(value.get("runId"), str) or not value["runId"]
            or value.get("status") not in _TERMINAL | {"running", "unknown", "needs_attention"}
            or (active and value["runId"] != active.run_id)):
        raise AgentError("DSH 返回的运行身份或状态不一致，本轮未保存。")
    return value


@dataclass
class _Active:
    operation_id: str
    endpoint: Endpoint
    request_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    run_id: str = ""
    session_id: str = ""
    status: str = "preparing"
    web_url: str = ""
    cancel_requested: bool = False
    cancel_sent: bool = False
    done: asyncio.Event = field(default_factory=asyncio.Event)

    def public(self):
        return {"run_id": self.run_id, "native_session_id": self.session_id,
                "status": self.status, "web_url": self.web_url,
                "cancel_requested": self.cancel_requested, "operation_id": self.operation_id}


class NativeExecutor:
    """One fresh native Session per operation, under the existing core lease."""
    def __init__(self, request_root: Path | str, *, descriptor: Path | str | None = None,
                 connector=None):
        home = Path(os.environ.get("DSH_HOME", "").strip() or Path.home() / ".dsh")
        profile = os.environ.get("DSH_PROFILE", "").strip() or "web"
        self.descriptor = Path(descriptor or os.environ.get("DSH_RELAY_ENDPOINT_DESCRIPTOR", "").strip()
                               or home / "plugins" / "dsh-relay" / profile / "relay-endpoint.json")
        self.request_root = Path(request_root).absolute()
        self.connector = connector or sdk_connector
        self._active = {}
        self._latest = {}
        self._cancelled = OrderedDict()

    async def catalog(self):
        endpoint = read_endpoint(self.descriptor)
        try:
            async with self.connector(endpoint) as peer:
                capabilities = _unwrap(await peer.call("list_capabilities", {}))
                workspaces = _unwrap(await peer.call("list_workspaces", {}))
                # These public catalog faces contain connection identities,
                # never settings, credentials, or conversation history.
                return {"capabilities": capabilities, "workspaces": workspaces,
                        "host_url": endpoint.host_url}
        except AgentError:
            raise
        except Exception:
            raise AgentError("无法连接 DSH Relay，请检查 DSH 是否运行。") from None

    def status(self, session_id: str, operation_id: str = ""):
        active = self._active.get(session_id)
        if active and (not operation_id or active.operation_id == operation_id):
            return active.public()
        latest = self._latest.get(session_id)
        if latest and (not operation_id or latest["operation_id"] == operation_id):
            return dict(latest)
        return {"status": "idle", "operation_id": operation_id,
                "cancel_requested": (session_id, operation_id) in self._cancelled}

    async def cancel(self, session_id: str, operation_id: str = ""):
        active = self._active.get(session_id)
        if operation_id:
            self._cancelled[(session_id, operation_id)] = True
            self._cancelled.move_to_end((session_id, operation_id))
            while len(self._cancelled) > 256:
                self._cancelled.popitem(last=False)
        if active is None or (operation_id and active.operation_id != operation_id):
            return self.status(session_id, operation_id)
        active.cancel_requested = True
        self._cancelled[(session_id, active.operation_id)] = True
        # Short UI acknowledgement. The owner sends native cancel, waits for
        # terminal and prevents a later classification/edit run in this op.
        return active.public()

    def provider(self, settings, connection, session_id, *, operation_id="", on_progress=None):
        return NativeProvider(self, settings, connection, session_id, operation_id, on_progress)

    async def generate(self, profile, state, request, preset, settings, connection,
                       on_progress=None):
        style = "Lowercase tags separated by commas; prose may follow a blank line." \
            if profile.data["style"] == "tags" else "Coherent English prose."
        payload = {"task": request["mode"], "instruction": request["instruction"],
                   "current_prompt": state["prompt"], "model_profile": profile.data["label"],
                   "recent_instructions": [turn["instruction"][:1000] for turn in state["history"][-4:]],
                   "creative_rules": preset.get("instructions", ""),
                   "custom_instructions": request.get("custom_instructions", ""),
                   "output_contract": "Only the final English visual prompt. No JSON, headings or commentary. "
                       + style + " No implicit anchors or locked sections exist; follow requested replacements."}
        text, workflow = await self.execute(payload, request["session_id"], settings, connection,
                                            operation_id=request.get("native_operation_id", ""),
                                            on_progress=on_progress)
        try:
            wrapped = json.loads(text)
        except ValueError:
            wrapped = None
        if isinstance(wrapped, (dict, list)):
            raise AgentError("DSH 返回了 JSON 包装，未确认图像提示词正文。")
        prompt = profile.validate_snapshot(text)
        return {"prompt": prompt, "message": "已通过 DSH 原生 Agent 生成最终稿；执行过程可在 DSH 查看。",
                "changes": ["按本轮指令更新正文"], "warnings": [], "workflow": workflow}

    async def execute(self, payload, session_id, settings, connection, *, operation_id="", on_progress=None):
        if session_id in self._active:
            raise AgentError("本节点的 DSH 操作仍在运行。")
        if connection.get("id") not in _SOURCES:
            raise AgentError("DSH 原生执行需要选择 DSH 模型来源。")
        operation_id = operation_id or uuid.uuid4().hex
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", operation_id):
            raise AgentError("DSH 操作身份无效。")
        if (session_id, operation_id) in self._cancelled:
            raise AgentError("已取消 DSH 操作，原提示词已保留。")
        workspace = Path(settings.get("workspace", "")).expanduser()
        if not settings.get("workspace") or not workspace.is_absolute() or not workspace.is_dir():
            raise AgentError("请选择存在的 DSH 工作目录。")
        skill = settings.get("skill", "").strip()
        if skill and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", skill):
            raise AgentError("DSH Skill 名称无效，请使用原生技能名。")
        endpoint = read_endpoint(self.descriptor)
        active = _Active(operation_id, endpoint)
        self._active[session_id] = active
        request_directory = (self.request_root if self.request_root.is_relative_to(workspace) else
                             workspace / ".dsh" / "tk-prompt-agent-requests")
        request_file = request_directory / f"{active.request_id}.json"
        deadline = time.monotonic() + max(30, float(settings.get("timeout", 600)))
        snapshot = None
        terminal = False
        cancel_deadline = None
        try:
            async with self.connector(endpoint) as peer:
                capabilities = _unwrap(await peer.call("list_capabilities", {}))
                selection = _selection(capabilities, connection, settings)
                if active.cancel_requested:
                    active.status = "cancelled"
                    terminal = True
                    raise AgentError("已取消 DSH 操作，原提示词已保留。")
                request_directory.mkdir(parents=True, exist_ok=True)
                request_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                task = ((f"/{skill}\n" if skill else "") + f"Read the Toolkit request at {request_file}. "
                        "Follow its output_contract and use the native skills and tools needed for the task. "
                        "Do not change any files. Output only the requested final answer between "
                        f"{_FINAL_BEGIN} and {_FINAL_END}; no content after the closing marker.")
                arguments = {"workspace": str(workspace), "task": task,
                             "permissionPreset": "read-only", "sessionMode": "fresh", "openBrowser": False,
                             "idempotencyKey": f"toolkit-{active.request_id}",
                             "authorizationBasis": "explicit-user-request",
                             "reviewTargets": [str(request_file)],
                             "contextReadScope": [str(workspace), str(request_file)],
                             "writeScope": [], **selection}
                if settings.get("agent_preset"):
                    arguments["agentPreset"] = settings["agent_preset"]
                snapshot = _run(await peer.call("start_run", arguments))
                active.run_id = snapshot["runId"]
                active.session_id = snapshot.get("sessionId", "")
                while True:
                    active.status = snapshot.get("status", "unknown")
                    active.web_url = self._web_url(snapshot.get("webUrl", ""), endpoint)
                    if on_progress:
                        result = on_progress(active.public())
                        if inspect.isawaitable(result):
                            await result
                    if active.status in _TERMINAL:
                        terminal = True
                        break
                    if active.status == "needs_attention" or time.monotonic() >= deadline:
                        active.cancel_requested = True
                    if active.cancel_requested and not active.cancel_sent:
                        snapshot = _run(await peer.call("cancel_run", {"runId": active.run_id,
                                        "idempotencyKey": f"toolkit-cancel-{active.request_id}"}), active)
                        active.cancel_sent = True
                        cancel_deadline = time.monotonic() + 30
                        continue
                    if cancel_deadline and time.monotonic() >= cancel_deadline:
                        active.status = "unknown"
                        raise AgentError("DSH 尚未确认取消，本轮未保存；请在 DSH 查看本次运行。")
                    snapshot = _run(await peer.call("wait_run", {"runId": active.run_id, "timeoutMs": 1000}), active)
                if active.cancel_requested or active.status != "succeeded":
                    raise AgentError("DSH 运行未完成或已取消，原提示词已保留；可在 DSH 查看过程。")
                if snapshot.get("assistantTextTruncated"):
                    raise AgentError("DSH 最终稿被截断，原提示词已保留。")
                text = _assistant_text(snapshot.get("assistantText"))
                report = {"id": "dsh-native", "version": 1,
                          "native": {**active.public(), **selection, "agent_preset": snapshot.get("agentPreset"),
                                     "permission": "read-only", "requested_skill": skill,
                                     "tools_recorded": None, "tool_trace_available": False},
                          "steps": [{"id": "native", "label": "DSH 原生执行",
                                     "summary": "由 DSH 持有技能、工具和模型配置；本次会话的完整过程在 DSH 查看。"},
                                    {"id": "validation", "label": "最终稿", "summary": "仅采用本次成功运行的最终助手正文。"}]}
                return text, report
        except asyncio.CancelledError:
            # HTTP caller cancellation must request native cancellation too.
            active.cancel_requested = True
            if active.run_id and not terminal:
                await asyncio.shield(self._cancel_after_disconnect(active))
                terminal = active.status in _TERMINAL
            raise
        except AgentError:
            raise
        except Exception as error:
            active.status = "unknown" if active.run_id else "failed"
            # The SDK's AnyIO task groups wrap domain errors on exit. Preserve
            # the redacted public cause rather than misreporting a network loss.
            pending = [error]
            while pending:
                item = pending.pop()
                if isinstance(item, AgentError):
                    raise item from None
                if isinstance(item, BaseExceptionGroup):
                    pending.extend(item.exceptions)
            raise AgentError("DSH 连接中断，本轮未保存；请在 DSH 查看或取消本次运行。") from None
        finally:
            if terminal or not active.run_id:
                request_file.unlink(missing_ok=True)
            self._latest[session_id] = active.public()
            self._active.pop(session_id, None)
            active.done.set()

    @staticmethod
    def _web_url(value, endpoint):
        try:
            parts = urlsplit(value)
            if parts.scheme != "http" or parts.netloc != urlsplit(endpoint.host_url).netloc:
                return ""
            # Host-generated links are presentation data; do not retain tokens.
            if parts.username or parts.password or "token=" in parts.query.lower():
                return ""
            return value
        except (TypeError, ValueError):
            return ""

    async def _cancel_after_disconnect(self, active):
        try:
            async with self.connector(active.endpoint) as peer:
                snapshot = _run(await peer.call("cancel_run", {"runId": active.run_id,
                                "idempotencyKey": f"toolkit-cancel-{active.request_id}"}), active)
                deadline = time.monotonic() + 30
                while snapshot.get("status") not in _TERMINAL:
                    if time.monotonic() >= deadline:
                        active.status = "unknown"
                        return
                    snapshot = _run(await peer.call("wait_run", {"runId": active.run_id, "timeoutMs": 1000}), active)
                active.status = snapshot["status"]
        except Exception:
            active.status = "unknown"


class NativeProvider:
    """Structured editor adapter; native tools still execute inside each run."""
    def __init__(self, executor, settings, connection, session_id, operation_id="", on_progress=None):
        self.executor, self.settings, self.connection = executor, settings, connection
        self.session_id, self.on_progress = session_id, on_progress
        self.operation_id = operation_id or uuid.uuid4().hex
        self.workflow = None

    async def complete(self, messages, schema):
        payload = {"messages": messages, "response_schema": schema,
                   "output_contract": "Follow the supplied messages and response_schema. Return only the required JSON object, "
                                      "without Markdown, narration, or any extra fields." if schema else
                                      "Follow the supplied messages. Return only the requested final text."}
        text, self.workflow = await self.executor.execute(payload, self.session_id, self.settings, self.connection,
                                                          operation_id=self.operation_id,
                                                          on_progress=self.on_progress)
        return text
