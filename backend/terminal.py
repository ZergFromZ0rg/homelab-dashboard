"""Web terminal: the browser's xterm talks to ``/ws/terminal/{host}``, and
this relays it to that host's agent, which runs the shell.

The dashboard is a relay and a gate, nothing more. Bytes pass through
untouched in both directions (binary frames are terminal I/O, text frames
JSON control — the agent's protocol, see its terminal.py), so nothing here
has to understand a terminal.

**Login is required, not just honoured.** Everywhere else, a dashboard
with no passkey is open to whoever reaches it — acceptable for graphs, not
for a root shell. So a terminal refuses until a passkey exists, and the
SessionGate has already checked the session by the time this runs.

Every session goes on the activity feed once the shell is up, with the name of
the passkey that opened it.
"""

from __future__ import annotations

import asyncio
import json
import time
from urllib.parse import urlencode

from fastapi import APIRouter, WebSocket
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from backend import activity, audit_log, auth, passkeys
from backend.docker import agent_headers
from backend.log import system as log
from backend.registry import registry

router = APIRouter()

OPEN_TIMEOUT = 20  # a host shell starts a helper container first


def agent_socket_url(base: str, query: dict) -> str:
    base = base.rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://"):]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://"):]
    return f"{base}/terminal?{urlencode(query)}"


async def _refuse(websocket: WebSocket, message: str) -> None:
    await websocket.send_text(json.dumps({"type": "error", "message": message}))
    await websocket.close()


def target_param(websocket: WebSocket) -> str:
    return "host" if websocket.query_params.get("target") == "host" else "container"


def _size(value, default: int) -> int:
    try:
        return max(1, min(int(value), 1000))
    except (TypeError, ValueError):
        return default


@router.websocket("/ws/terminal/{host}")
async def terminal_socket(websocket: WebSocket, host: str):
    await websocket.accept()

    if not passkeys.store.enabled():
        await _refuse(
            websocket,
            "The terminal needs sign-in. Add a passkey in Settings → Passkeys first.",
        )
        return

    # A shell on the host itself is root on that machine: it wants a
    # passkey confirmation from the last few minutes, like the other
    # root-level actions. The browser confirms first, then connects.
    if target_param(websocket) == "host" and passkeys.store.enabled() and not (
        auth.token_ok.get() or passkeys.store.elevated_until(auth.session_token.get())
    ):
        await _refuse(websocket, "Confirm with your passkey to open a host shell.")
        return

    node = registry.all().get(host)
    if not node:
        await _refuse(websocket, f"{host} isn't a registered host")
        return

    params = websocket.query_params
    target = "host" if params.get("target") == "host" else "container"
    container = (params.get("container") or "").strip()
    if target == "container" and not container:
        await _refuse(websocket, "no container given")
        return

    device = passkeys.store.session_device(
        websocket.cookies.get(passkeys.SESSION_COOKIE)
    )
    query = {
        "target": target,
        "cols": _size(params.get("cols"), 80),
        "rows": _size(params.get("rows"), 24),
        "by": device or "dashboard",
    }
    if target == "container":
        query["container"] = container
    what = (
        f"Host shell on {host}"
        if target == "host"
        else f"Shell in {(params.get('name') or container[:12])[:80]}"
    )

    try:
        agent = await connect(
            agent_socket_url(node["url"], query),
            additional_headers=agent_headers(),
            open_timeout=OPEN_TIMEOUT,
            max_size=None,
            ping_interval=20,
        )
    except InvalidStatus as error:
        status = error.response.status_code
        await _refuse(
            websocket,
            "this host's agent has no terminal — rebuild it to update"
            if status == 404 or status == 403
            else f"{host}'s agent refused the connection ({status})",
        )
        return
    except (OSError, asyncio.TimeoutError) as error:
        await _refuse(websocket, f"couldn't reach {host}'s agent: {error}")
        return

    started = time.time()
    who = device or audit_log.who_from_headers({k.lower(): v for k, v in websocket.headers.items()})
    ip = audit_log.ip_from_headers({k.lower(): v for k, v in websocket.headers.items()}, websocket.client and (websocket.client.host,))
    shell_seen = {"yes": False}

    def opened():
        shell_seen["yes"] = True
        audit_log.record(f"{what} opened", who=who, host=host, ip=ip,
                         target={"target": target, "container": container} if container else {"target": target})
        activity.record(
            "terminal", f"{what} opened" + (f" by {device}" if device else ""), host
        )

    try:
        await _relay(websocket, agent, opened)
    finally:
        await agent.close()
        log.info("%s closed after %.0fs", what, time.time() - started)
        if shell_seen["yes"]:
            audit_log.record(f"{what} closed", who=who, host=host, ip=ip,
                             detail=f"{time.time() - started:.0f}s")


async def _relay(browser: WebSocket, agent, opened) -> None:
    async def agent_to_browser():
        # Logged on the shell's first output rather than on connect: the
        # agent accepts and *then* refuses, and a refusal isn't a session.
        logged = False
        try:
            async for message in agent:
                if isinstance(message, bytes):
                    if not logged:
                        logged = True
                        opened()
                    await browser.send_bytes(message)
                else:
                    await browser.send_text(message)
        except ConnectionClosed:
            pass
        # The agent refuses (off, bad token) by closing with a 44xx code and
        # the reason. Pass that on as words, not just a dead terminal.
        code = agent.close_code
        if code and 4000 <= code < 5000 and agent.close_reason:
            await browser.send_text(
                json.dumps({"type": "error", "message": agent.close_reason})
            )

    async def browser_to_agent():
        try:
            while True:
                message = await browser.receive()
                if message["type"] == "websocket.disconnect":
                    return
                if message.get("bytes") is not None:
                    await agent.send(message["bytes"])
                elif message.get("text") is not None:
                    await agent.send(message["text"])
        except ConnectionClosed:
            pass

    tasks = {
        asyncio.create_task(agent_to_browser()),
        asyncio.create_task(browser_to_agent()),
    }
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        try:
            await browser.close()
        except RuntimeError:
            pass  # already closed by the browser
