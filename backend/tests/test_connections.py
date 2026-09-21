import pytest
import requests
from fastapi.testclient import TestClient

from backend import connections, main


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")

    def json(self):
        return self._payload


AGENT_OK = {
    "host": "bigboy",
    "available": True,
    "accounting": True,
    "source": "/host/nf_conntrack",
    "flows_total": 12,
    "conversations_total": 3,
    "truncated": False,
    "updated_at": 1000.0,
    "peers": [
        {
            "proto": "tcp", "family": "ipv4",
            "src": "192.168.1.40", "dst": "192.168.1.10", "dport": 8096,
            "flows": 4, "orig_bytes": 51200, "reply_bytes": 4294967296,
            "states": ["ESTABLISHED"], "container": None, "container_id": None,
        }
    ],
}


@pytest.fixture(autouse=True)
def _fresh():
    connections._cache.clear()
    yield
    connections._cache.clear()


def respond(monkeypatch, response):
    calls = []

    def fake_get(url, **kwargs):
        calls.append((url, kwargs))
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(connections.requests, "get", fake_get)
    return calls


def test_a_working_agent_is_passed_through(monkeypatch):
    respond(monkeypatch, FakeResponse(200, AGENT_OK))

    result = connections.for_host("bigboy", "http://bigboy:8123")

    assert result["available"] is True and result["state"] == "ok"
    assert result["accounting"] is True
    assert result["conversations_total"] == 3
    assert result["peers"][0]["dport"] == 8096


def test_the_agents_own_reason_is_shown_verbatim(monkeypatch):
    """It names the exact mount or sysctl — rewording it would lose that."""
    respond(monkeypatch, FakeResponse(200, {
        "available": False,
        "reason": "conntrack table is empty here — mount the host's table in",
    }))

    result = connections.for_host("bigboy", "http://bigboy:8123")

    assert result["available"] is False
    assert result["state"] == "not_configured"
    assert "mount the host's table in" in result["reason"]


def test_an_older_agent_reads_as_unsupported(monkeypatch):
    respond(monkeypatch, FakeResponse(404))

    result = connections.for_host("bigboy", "http://bigboy:8123")

    assert result["state"] == "unsupported"
    assert "rebuild" in result["reason"]


def test_a_401_names_the_token_as_the_fix(monkeypatch):
    respond(monkeypatch, FakeResponse(401))

    result = connections.for_host("bigboy", "http://bigboy:8123")

    assert result["state"] == "unauthorized"
    assert "AGENT_TOKEN" in result["reason"]


def test_an_unreachable_agent_does_not_raise(monkeypatch):
    respond(monkeypatch, requests.ConnectionError("no route to host"))

    result = connections.for_host("bigboy", "http://bigboy:8123")

    assert result["available"] is False and result["state"] == "unknown"
    assert result["peers"] == []


def test_a_nonsense_payload_is_rejected(monkeypatch):
    respond(monkeypatch, FakeResponse(200, ["not", "a", "dict"]))
    assert connections.for_host("bigboy", "http://x")["state"] == "unknown"


def test_peers_is_always_a_list(monkeypatch):
    respond(monkeypatch, FakeResponse(200, {**AGENT_OK, "peers": None}))
    assert connections.for_host("bigboy", "http://x")["peers"] == []


def test_the_token_is_sent(monkeypatch):
    monkeypatch.setattr(connections, "AGENT_TOKEN", "sekret")
    monkeypatch.setattr(
        connections, "agent_headers", lambda: {"X-Agent-Token": "sekret"}
    )
    calls = respond(monkeypatch, FakeResponse(200, AGENT_OK))

    connections.for_host("bigboy", "http://bigboy:8123")

    url, kwargs = calls[0]
    assert url == "http://bigboy:8123/connections"
    assert kwargs["headers"]["X-Agent-Token"] == "sekret"


def test_results_are_cached_and_refresh_skips_the_cache(monkeypatch):
    calls = respond(monkeypatch, FakeResponse(200, AGENT_OK))

    connections.for_host("bigboy", "http://x")
    second = connections.for_host("bigboy", "http://x")
    assert len(calls) == 1
    assert second["cached_age"] >= 0

    connections.for_host("bigboy", "http://x", refresh=True)
    assert len(calls) == 2


def test_hosts_are_cached_separately(monkeypatch):
    calls = respond(monkeypatch, FakeResponse(200, AGENT_OK))

    connections.for_host("bigboy", "http://a")
    connections.for_host("nuc-media", "http://b")

    assert len(calls) == 2


def test_forget_drops_a_hosts_cache(monkeypatch):
    calls = respond(monkeypatch, FakeResponse(200, AGENT_OK))

    connections.for_host("bigboy", "http://x")
    connections.forget("bigboy")
    connections.for_host("bigboy", "http://x")

    assert len(calls) == 2


# ---- route ---------------------------------------------------------------


@pytest.fixture
def client():
    return TestClient(main.app)


def test_route_returns_the_hosts_table(client, monkeypatch):
    monkeypatch.setattr(
        main.registry, "all", lambda: {"bigboy": {"url": "http://bigboy:8123/"}}
    )
    respond(monkeypatch, FakeResponse(200, AGENT_OK))

    body = client.get("/api/connections/bigboy").json()

    assert body["host"] == "bigboy"
    assert body["available"] is True
    assert body["peers"][0]["dst"] == "192.168.1.10"


def test_route_404s_an_unknown_host(client, monkeypatch):
    monkeypatch.setattr(main.registry, "all", lambda: {})
    assert client.get("/api/connections/ghost").status_code == 404


def test_route_passes_refresh_through(client, monkeypatch):
    monkeypatch.setattr(
        main.registry, "all", lambda: {"bigboy": {"url": "http://bigboy:8123"}}
    )
    calls = respond(monkeypatch, FakeResponse(200, AGENT_OK))

    client.get("/api/connections/bigboy")
    client.get("/api/connections/bigboy?refresh=true")

    assert len(calls) == 2
