"""The terminal relay. A real websocket server on localhost stands in for
the agent, so the relay is exercised end to end, byte for byte."""

import asyncio
import json
import threading

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from websockets.asyncio.server import serve

from backend import activity, auth_api, docker, main, passkeys, terminal
from backend.registry import registry


class FakeAgent:
    """Echoes terminal bytes, reports resizes, refuses on request."""

    def __init__(self):
        self.requests = []
        self.loop = asyncio.new_event_loop()
        ready = threading.Event()
        threading.Thread(target=self._run, args=(ready,), daemon=True).start()
        ready.wait(5)

    def _run(self, ready):
        asyncio.set_event_loop(self.loop)

        async def main_():
            async with serve(self._handle, "127.0.0.1", 0) as server:
                self.port = server.sockets[0].getsockname()[1]
                ready.set()
                await asyncio.Future()

        self.loop.run_until_complete(main_())

    async def _handle(self, ws):
        self.requests.append((ws.request.path, dict(ws.request.headers)))
        if "container=refuse" in ws.request.path:
            await ws.close(4403, "the terminal is off on this host")
            return
        await ws.send(b"welcome\r\n")
        async for message in ws:
            if isinstance(message, bytes):
                if message == b"exit\n":
                    await ws.send(json.dumps({"type": "exit", "code": 0}))
                    return
                await ws.send(b"echo:" + message)
            else:
                await ws.send(json.dumps({"got": json.loads(message)}))


@pytest.fixture(scope="module")
def agent():
    return FakeAgent()


@pytest.fixture
def client(agent, monkeypatch):
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": f"http://127.0.0.1:{agent.port}"}})
    monkeypatch.setattr(activity, "record", lambda *a, **k: recorded.append(a))
    recorded.clear()
    return TestClient(main.app)


recorded = []


def signed_in(monkeypatch):
    monkeypatch.setattr(passkeys.store, "enabled", lambda: True)
    monkeypatch.setattr(passkeys.store, "check_session", lambda token: token == "good")
    monkeypatch.setattr(passkeys.store, "session_device", lambda token: "MacBook")
    return {"cookie": f"{passkeys.SESSION_COOKIE}=good"}


def first_text(ws):
    return json.loads(ws.receive_text())


def test_refused_until_login_exists(client):
    with client.websocket_connect("/ws/terminal/box?container=abc") as ws:
        message = first_text(ws)
    assert message["type"] == "error"
    assert "passkey" in message["message"]
    assert recorded == []


def test_a_socket_without_a_session_is_closed_by_the_gate(client, monkeypatch):
    signed_in(monkeypatch)
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/ws/terminal/box?container=abc") as ws:
            ws.receive_text()
    assert closed.value.code == 4401


def test_the_gate_covers_every_ws_path():
    assert not auth_api._open_path("GET", "/ws/terminal/box")
    assert not auth_api._open_path("GET", "/ws")


def test_unknown_host(client, monkeypatch):
    headers = signed_in(monkeypatch)
    with client.websocket_connect("/ws/terminal/nope?container=abc", headers=headers) as ws:
        assert "isn't a registered host" in first_text(ws)["message"]


def test_relays_both_ways_and_logs_the_session(client, agent, monkeypatch):
    headers = signed_in(monkeypatch)
    monkeypatch.setattr(terminal, "agent_headers", lambda: {"X-Agent-Token": "t0k"})

    with client.websocket_connect(
        "/ws/terminal/box?container=abc123&name=jellyfin&cols=120&rows=40",
        headers=headers,
    ) as ws:
        assert ws.receive_bytes() == b"welcome\r\n"
        ws.send_bytes(b"ls\n")
        assert ws.receive_bytes() == b"echo:ls\n"
        ws.send_text(json.dumps({"type": "resize", "cols": 100, "rows": 30}))
        assert first_text(ws) == {"got": {"type": "resize", "cols": 100, "rows": 30}}
        ws.send_bytes(b"exit\n")
        assert first_text(ws) == {"type": "exit", "code": 0}

    path, sent = agent.requests[-1]
    assert path.startswith("/terminal?")
    assert "container=abc123" in path and "cols=120" in path and "by=MacBook" in path
    assert sent.get("x-agent-token") == "t0k"
    assert recorded == [("terminal", "Shell in jellyfin opened by MacBook", "box")]


def test_a_host_shell_needs_a_fresh_confirmation(client, agent, monkeypatch):
    from backend import auth
    monkeypatch.setattr(auth, "STEP_UP", True)
    headers = signed_in(monkeypatch)
    monkeypatch.setattr(passkeys.store, "elevated_until", lambda token: None)
    with client.websocket_connect("/ws/terminal/box?target=host", headers=headers) as ws:
        assert "Confirm with your passkey" in first_text(ws)["message"]


def test_a_host_shell(client, agent, monkeypatch):
    headers = signed_in(monkeypatch)
    monkeypatch.setattr(passkeys.store, "elevated_until", lambda token: 9e9)
    with client.websocket_connect("/ws/terminal/box?target=host", headers=headers) as ws:
        assert ws.receive_bytes() == b"welcome\r\n"
    assert "target=host" in agent.requests[-1][0]
    assert "container=" not in agent.requests[-1][0]
    assert recorded[0][1] == "Host shell on box opened by MacBook"


def test_an_agent_refusal_reaches_the_browser_as_words(client, monkeypatch):
    headers = signed_in(monkeypatch)
    with client.websocket_connect("/ws/terminal/box?container=refuse", headers=headers) as ws:
        message = first_text(ws)
    assert message == {"type": "error", "message": "the terminal is off on this host"}
    assert recorded == []


def test_an_unreachable_agent(client, monkeypatch):
    headers = signed_in(monkeypatch)
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://127.0.0.1:9"}})
    with client.websocket_connect("/ws/terminal/box?container=abc", headers=headers) as ws:
        assert "couldn't reach box's agent" in first_text(ws)["message"]
    assert recorded == []


def test_agent_url_scheme():
    assert terminal.agent_socket_url("http://h:8123/", {"a": 1}) == "ws://h:8123/terminal?a=1"
    assert terminal.agent_socket_url("https://h", {}) == "wss://h/terminal?"


def test_host_snapshot_carries_the_terminal_flag(monkeypatch):
    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"containers": [], "terminal": True}

    monkeypatch.setattr(docker.requests, "get", lambda *a, **k: Resp())
    monkeypatch.setattr(docker.backups, "status_for", lambda *a: None)
    monkeypatch.setattr(docker.versions, "for_host", lambda *a: None)
    _, snap = docker.get_host_data("box", "http://box")
    assert snap["terminal"] is True


def test_logs_relay_one_way(client, agent, monkeypatch):
    headers = signed_in(monkeypatch)
    with client.websocket_connect("/ws/logs/box?container=web%2F1&tail=50", headers=headers) as ws:
        assert ws.receive_bytes() == b"welcome\r\n"
    path = agent.requests[-1][0]
    assert path.startswith("/containers/web%2F1/logs?") and "tail=50" in path
