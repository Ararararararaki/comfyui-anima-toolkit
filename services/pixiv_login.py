"""User-initiated Pixiv login in an isolated local browser; no profile/cookie access."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
from urllib.parse import parse_qs, urlsplit

import aiohttp

TTL = 600
ACTIVE = {"opening", "waiting", "exchanging"}


def local_request(request) -> bool:
    """Never launch a browser on a remote ComfyUI server or from a foreign origin."""
    try:
        if not ipaddress.ip_address(request.remote or "").is_loopback:
            return False
        host = urlsplit("http://" + request.host).hostname
        if host not in {"localhost", "127.0.0.1", "::1"}:
            return False
        origin = request.headers.get("Origin")
        if origin and urlsplit(origin).netloc != request.host:
            return False
        return request.headers.get("Sec-Fetch-Site", "same-origin") != "cross-site"
    except ValueError:
        return False


def find_browser() -> str | None:
    candidates = []
    for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        base = os.environ.get(key)
        if base:
            candidates.extend(Path(base) / p for p in (
                "Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"))
    candidates.extend(Path(p) for p in (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"))
    for name in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge"):
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    return next((str(p) for p in candidates if p.is_file()), None)


def callback_code(url: str) -> str | None:
    """Accept only the two Pixiv callback destinations, never unrelated URL queries."""
    try:
        p = urlsplit(url)
        valid = (p.scheme == "pixiv" and p.netloc == "account" and p.path == "/login") or (
            p.scheme == "https" and p.netloc == "app-api.pixiv.net"
            and p.path == "/web/v1/users/auth/pixiv/callback")
        codes = parse_qs(p.query).get("code", []) if valid else []
        return codes[0] if len(codes) == 1 and 0 < len(codes[0]) <= 4096 else None
    except (ValueError, TypeError):
        return None


def event_code(event: dict) -> str | None:
    method, p = event.get("method"), event.get("params", {})
    if method == "Network.requestWillBeSent":
        url = p.get("request", {}).get("url", "")
    elif method in {"Page.frameRequestedNavigation", "Page.frameScheduledNavigation", "Page.windowOpen"}:
        url = p.get("url", "")
    elif method == "Page.frameNavigated":
        url = p.get("frame", {}).get("url", "")
    else:
        return None
    return callback_code(url)


class LoginSessions:
    def __init__(self):
        self.sessions = {}

    def status(self, session_id):
        s = self.sessions.get(session_id)
        if not s:
            return None
        # Explicit whitelist: the verifier, URL, code, profile and process never leave this service.
        return {k: s[k] for k in ("session_id", "state", "message", "expires_at")}

    async def start(self, url, verifier, exchange):
        if any(s["state"] in ACTIVE for s in self.sessions.values()):
            raise RuntimeError("已有登录窗口正在使用，请先完成或取消它。")
        browser = find_browser()
        if not browser:
            raise RuntimeError("未找到 Chrome 或 Edge，请使用下方手动授权，或安装其中一个浏览器。")
        while len(self.sessions) >= 8:
            self.sessions.pop(next(iter(self.sessions)))
        sid = secrets.token_urlsafe(24)
        s = {"session_id": sid, "state": "opening", "message": "正在打开登录窗口…",
             "expires_at": time.time() + TTL, "verifier": verifier, "task": None}
        self.sessions[sid] = s
        s["task"] = asyncio.create_task(self._run(s, browser, url, exchange))
        return self.status(sid)

    async def cancel(self, session_id):
        s = self.sessions.get(session_id)
        if not s:
            return None
        if s["state"] == "exchanging":
            # Token exchange writes atomically in a worker. Don't claim to cancel an already committed login.
            raise RuntimeError("正在保存授权，请稍等片刻。")
        if s["state"] in ACTIVE:
            s["state"], s["message"] = "cancelled", "已取消登录，原有授权保持不变。"
            s["task"].cancel()
            await asyncio.gather(s["task"], return_exceptions=True)
        return self.status(session_id)

    async def _run(self, s, browser, url, exchange):
        profile = None
        process = None
        try:
            profile = tempfile.mkdtemp(prefix="tk-pixiv-login-")
            process = subprocess.Popen([
                browser, "--user-data-dir=" + profile, "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check",
                "--disable-sync", "--new-window", "about:blank",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            code = await asyncio.wait_for(self._receive(s, profile, process, url), TTL)
            if s["state"] != "waiting":
                return
            s["state"], s["message"] = "exchanging", "已收到授权，正在保存…"
            try:
                await asyncio.to_thread(exchange, code, s["verifier"])
            except Exception:
                # Provider errors can embed secrets; never put them into UI or logs.
                s["state"], s["message"] = "error", "授权兑换失败，请重新登录；也可使用手动授权。"
                return
            s["state"], s["message"] = "success", "P站登录成功，可以开始搜索。"
        except asyncio.TimeoutError:
            s["state"], s["message"] = "expired", "登录等待已超过 10 分钟，请重新点击登录。"
        except asyncio.CancelledError:
            if s["state"] in ACTIVE:
                s["state"], s["message"] = "cancelled", "登录已取消。"
            raise
        except Exception:
            s["state"], s["message"] = "error", "登录窗口未能连接或已关闭，请重试或使用手动授权。"
        finally:
            s.pop("verifier", None)
            if process:
                if process.poll() is None:
                    process.terminate()
                    try:
                        await asyncio.to_thread(process.wait, 3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        await asyncio.to_thread(process.wait)
            if profile:
                # Only our known temporary directory, never a user's existing browser profile.
                await asyncio.to_thread(shutil.rmtree, profile, True)

    async def _receive(self, s, profile, process, url):
        async with aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=5)) as client:
            ws_url = await self._page_endpoint(client, profile, process)
            async with client.ws_connect(ws_url, max_msg_size=2 * 1024 * 1024) as ws:
                try:
                    for i, method in enumerate(("Page.enable", "Network.enable"), 1):
                        await ws.send_json({"id": i, "method": method})
                    await ws.send_json({"id": 3, "method": "Page.navigate", "params": {"url": url}})
                    s["state"], s["message"] = "waiting", "请在弹出的窗口登录 P站；登录后会自动完成，无需 F12。"
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        code = event_code(json.loads(msg.data))
                        if code:
                            return code
                    raise RuntimeError("Browser closed")
                finally:
                    try:
                        await asyncio.wait_for(ws.send_json({"id": 4, "method": "Browser.close"}), 2)
                    except (aiohttp.ClientError, asyncio.TimeoutError, ConnectionError):
                        pass

    async def _page_endpoint(self, client, profile, process):
        deadline = time.monotonic() + 20
        port_file = Path(profile) / "DevToolsActivePort"
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Browser closed")
            try:
                port = int((await asyncio.to_thread(port_file.read_text, encoding="utf-8")).splitlines()[0])
                if not 0 < port < 65536:
                    raise ValueError("Invalid port")
                async with client.get(f"http://127.0.0.1:{port}/json/list") as response:
                    targets = await response.json()
                for t in targets:
                    if t.get("type") != "page":
                        continue
                    endpoint = t.get("webSocketDebuggerUrl", "")
                    parsed = urlsplit(endpoint)
                    if parsed.scheme == "ws" and parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == port:
                        return endpoint
            except (OSError, ValueError, IndexError, aiohttp.ClientError):
                pass
            await asyncio.sleep(0.1)
        raise RuntimeError("Browser did not start")
