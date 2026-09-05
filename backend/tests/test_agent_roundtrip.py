"""Exercise deploy_container / remove_container against a real HTTP server
standing in for an agent — so the request shaping, headers, timeouts and
error-body passthrough are covered for real, not mocked."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from backend import docker as agent_http


class _Handler(BaseHTTPRequestHandler):
    def _body(self):
        length = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw or b"{}")

    def _reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _headers_lower(self):
        return {k.lower(): v for k, v in self.headers.items()}

    def do_POST(self):
        body = self._body()
        self.server.requests.append(
            ("POST", self.path, self._headers_lower(), body)
        )
        self._reply(*self.server.responder("POST", self.path, body))

    def do_DELETE(self):
        self.server.requests.append(
            ("DELETE", self.path, self._headers_lower(), None)
        )
        self._reply(*self.server.responder("DELETE", self.path, None))

    def log_message(self, *args):
        pass


@pytest.fixture
def agent():
    def default_responder(method, path, body):
        if method == "POST":
            return 200, {"success": True, "id": "deadbeefcafe", "name": body.get("name")}
        return 200, {"success": True, "container": "x", "action": "delete"}

    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.requests = []
    server.responder = default_responder
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()


def _nodes(server):
    return {"nuc-1": {"url": f"http://127.0.0.1:{server.server_port}"}}


def test_deploy_container_sends_reshaped_spec(agent, monkeypatch):
    monkeypatch.setattr(agent_http, "AGENT_TOKEN", "s3cret")

    payload = agent_http.agent_spec_payload(
        {
            "image": "nginx:latest",
            "name": "web",
            "ports": [{"container": 80, "host": 8080}],
            "resources": {"cpus": 1.0, "memory_mb": 256},
        }
    )
    result = agent_http.deploy_container(_nodes(agent), "nuc-1", payload)

    assert result == {"success": True, "id": "deadbeefcafe", "name": "web"}

    method, path, headers, body = agent.requests[0]
    assert (method, path) == ("POST", "/containers")
    assert headers["x-agent-token"] == "s3cret"
    assert body["image"] == "nginx:latest"
    assert body["ports"] == [{"container": 80, "host": 8080, "proto": "tcp"}]
    assert body["labels"] == {"deployed-by": "homelab-dashboard"}


def test_deploy_container_surfaces_policy_rejection(agent):
    agent.responder = lambda *a: (
        400,
        {"success": False, "error": "registry not allowed", "stage": "policy"},
    )
    result = agent_http.deploy_container(
        _nodes(agent), "nuc-1", {"image": "ghcr.io/x/y"}
    )
    assert result["success"] is False
    assert result["stage"] == "policy"


def test_deploy_container_maps_404_to_old_agent_hint(agent):
    agent.responder = lambda *a: (404, {"detail": "Not Found"})
    result = agent_http.deploy_container(
        _nodes(agent), "nuc-1", {"image": "nginx"}
    )
    assert "POST /containers" in result["error"]


def test_remove_container_roundtrip(agent):
    result = agent_http.remove_container(_nodes(agent), "nuc-1", "abc123")
    assert result["success"] is True
    method, path, _, _ = agent.requests[0]
    assert (method, path) == ("DELETE", "/containers/abc123")


def test_deploy_container_unreachable_raises():
    import requests

    with pytest.raises(requests.RequestException):
        agent_http.deploy_container(
            {"nuc-1": {"url": "http://127.0.0.1:9"}}, "nuc-1", {"image": "nginx"}
        )
