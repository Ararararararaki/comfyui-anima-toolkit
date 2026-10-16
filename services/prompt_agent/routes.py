"""Thin asynchronous ComfyUI chat/config API; never exposes provider secrets."""
from __future__ import annotations

from aiohttp import web

from .errors import AgentError, SessionConflict
from .runtime import get_runtime
from .storage import public_state

PREFIX = "/anima/prompt-agent"


def register_routes(routes, runtime_getter=get_runtime) -> None:
    async def body(request):
        # Check origin for browser mutations; API requests without Origin remain usable locally.
        origin = request.headers.get("Origin")
        if origin:
            from urllib.parse import urlsplit
            if urlsplit(origin).netloc != request.host:
                raise web.HTTPForbidden(text="Cross-origin settings writes are not allowed")
        if request.content_length and request.content_length > 300000:
            raise AgentError("请求过大")
        try:
            data = await request.json()
        except (ValueError, UnicodeError) as error:
            raise AgentError("请求必须是 JSON") from error
        if not isinstance(data, dict):
            raise AgentError("请求必须是 JSON 对象")
        return data

    def endpoint(handler):
        async def wrapped(request):
            try:
                return web.json_response(await handler(request), dumps=lambda obj: __import__("json").dumps(obj, ensure_ascii=False))
            except AgentError as error:
                return web.json_response({"error": str(error)}, status=409 if isinstance(error, SessionConflict) else 400)
            except web.HTTPException:
                raise
            except Exception:
                return web.json_response({"error": "Prompt Agent 内部错误，本轮未确认；请检查服务端日志或运行核心测试"}, status=500)
        return wrapped

    async def meta(request):
        return runtime_getter().meta()

    async def config(request):
        return runtime_getter().save_config(await body(request))

    async def activate_provider(request):
        data = await body(request)
        return runtime_getter().activate_provider(data.get("id", ""))

    async def native_meta(request):
        return await runtime_getter().native_meta()

    async def native_config(request):
        runtime = runtime_getter()
        runtime.save_native_settings(await body(request))
        return await runtime.native_meta()

    async def native_status(request):
        return runtime_getter().native.status(request.match_info["session_id"],
                                             request.query.get("operation_id", ""))

    async def native_cancel(request):
        data = await body(request)
        return await runtime_getter().native.cancel(request.match_info["session_id"], data.get("operation_id", ""))

    async def presets(request):
        return runtime_getter().presets.save(await body(request))

    async def delete_preset(request):
        if request.can_read_body:
            await body(request)
        elif request.headers.get("Origin"):
            from urllib.parse import urlsplit
            if urlsplit(request.headers["Origin"]).netloc != request.host:
                raise web.HTTPForbidden()
        runtime_getter().presets.delete(request.match_info["preset_id"])
        return {"ok": True}

    async def edit(request):
        return await runtime_getter().agent.edit(await body(request))

    async def interrogate(request):
        return await runtime_getter().interrogation.run(await body(request))

    async def accept_interrogation(request):
        return runtime_getter().agent.accept_interrogation(await body(request))

    async def expand_interrogation(request):
        return await runtime_getter().interrogation.expand(await body(request))

    async def interrogation_config(request):
        return runtime_getter().interrogation.config.save(await body(request))

    async def session(request):
        return {"state": public_state(runtime_getter().sessions.load(request.match_info["session_id"]))}

    async def control(request):
        data = await body(request)
        sid, action = request.match_info["session_id"], request.match_info["action"]
        if action == "retry":
            return await runtime_getter().agent.edit({"session_id": sid, "revision": data.get("revision"),
                **({"native_operation_id": data["native_operation_id"]} if "native_operation_id" in data else {})}, retry=True)
        return runtime_getter().agent.control(sid, data.get("revision"), action)

    routes.get(PREFIX + "/meta")(endpoint(meta))
    routes.post(PREFIX + "/config")(endpoint(config))
    routes.post(PREFIX + "/activate-provider")(endpoint(activate_provider))
    routes.get(PREFIX + "/native/meta")(endpoint(native_meta))
    routes.post(PREFIX + "/native/config")(endpoint(native_config))
    routes.get(PREFIX + "/native/session/{session_id}")(endpoint(native_status))
    routes.post(PREFIX + "/native/session/{session_id}/cancel")(endpoint(native_cancel))
    routes.post(PREFIX + "/presets")(endpoint(presets))
    routes.delete(PREFIX + "/presets/{preset_id}")(endpoint(delete_preset))
    routes.post(PREFIX + "/edit")(endpoint(edit))
    routes.post(PREFIX + "/interrogate")(endpoint(interrogate))
    routes.post(PREFIX + "/accept-interrogation")(endpoint(accept_interrogation))
    routes.post(PREFIX + "/expand-interrogation")(endpoint(expand_interrogation))
    routes.post(PREFIX + "/interrogation-config")(endpoint(interrogation_config))
    routes.get(PREFIX + "/session/{session_id}")(endpoint(session))
    routes.post(PREFIX + "/session/{session_id}/{action}")(endpoint(control))
