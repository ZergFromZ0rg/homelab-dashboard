"""The /api/hosts/{host}/config routes.

The dashboard is a proxy here, so these test that it forwards faithfully
and passes the agent's own wording back — especially the refusals, which
name the fix.
"""

import pytest
import requests
from fastapi.testclient import TestClient

from backend import agent_config, auth, main

NODES = {"bigboy": {"url": "http://bigboy:8123/"}}


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    def json(self):
        if self._payload is _BAD:
            raise ValueError("not json")
        return self._payload


_BAD = object()

SNAPSHOT = {
    "host": "bigboy",
    "writable": True,
    "why_not": None,
    "settings": [
        {"key": "BACKUP_SOURCE_DIRS", "kind": "paths", "scope": "live",
         "group": "Backups", "label": "Directories this host may back up",
         "value": "/home/zerg", "set": True, "source": "dashboard",
         "editable": True},
    ],
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main.registry, "all", lambda: NODES)
    monkeypatch.setattr(auth, "API_TOKEN", "")
    return TestClient(main.app)


def respond(monkeypatch, response):
    calls = []

    def fake_request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(agent_config.requests, "request", fake_request)
    return calls


def test_reading_a_hosts_settings(client, monkeypatch):
    calls = respond(monkeypatch, FakeResponse(200, SNAPSHOT))

    body = client.get("/api/hosts/bigboy/config").json()

    assert body["writable"] is True
    assert body["settings"][0]["key"] == "BACKUP_SOURCE_DIRS"
    assert calls[0][:2] == ("GET", "http://bigboy:8123/config")


def test_writing_forwards_only_the_settings(client, monkeypatch):
    calls = respond(monkeypatch, FakeResponse(200, {"applied": ["BACKUP_DIRS"]}))

    resp = client.put(
        "/api/hosts/bigboy/config", json={"settings": {"BACKUP_DIRS": "/srv/b"}}
    )

    assert resp.status_code == 200
    assert resp.json()["applied"] == ["BACKUP_DIRS"]
    assert calls[0][2]["json"] == {"settings": {"BACKUP_DIRS": "/srv/b"}}


def test_a_refusal_keeps_the_agents_wording(client, monkeypatch):
    """The agent's message names the exact fix. Rewording it here would
    lose the only useful part."""
    respond(monkeypatch, FakeResponse(400, {
        "detail": "this host does not accept settings from the dashboard — set "
                  "CONFIG_WRITABLE=1 in its agent's .env and restart it",
    }))

    resp = client.put("/api/hosts/bigboy/config", json={"settings": {"BACKUP_DIRS": "/x"}})

    assert resp.status_code == 400
    assert "CONFIG_WRITABLE=1" in resp.json()["detail"]


def test_an_older_agent_says_to_update_it(client, monkeypatch):
    respond(monkeypatch, FakeResponse(404, {}))

    resp = client.get("/api/hosts/bigboy/config")

    assert resp.status_code == 501
    assert "predates dashboard settings" in resp.json()["detail"]


def test_an_unreachable_agent_is_a_502(client, monkeypatch):
    respond(monkeypatch, requests.ConnectionError("no route to host"))

    resp = client.get("/api/hosts/bigboy/config")

    assert resp.status_code == 502
    assert "couldn't reach" in resp.json()["detail"]


def test_an_unknown_host_is_a_404(client):
    assert client.get("/api/hosts/ghost/config").status_code == 404


def test_settings_must_be_an_object(client, monkeypatch):
    respond(monkeypatch, FakeResponse(200, {}))

    resp = client.put("/api/hosts/bigboy/config", json={"settings": "all of them"})

    assert resp.status_code == 400


def test_both_routes_are_token_gated(client, monkeypatch):
    """Turning on rebuilds, or widening which directories may leave a host,
    is the rebuild route's class of decision."""
    monkeypatch.setattr(auth, "API_TOKEN", "sekret")
    respond(monkeypatch, FakeResponse(200, SNAPSHOT))

    assert client.get("/api/hosts/bigboy/config").status_code == 401
    assert client.put(
        "/api/hosts/bigboy/config", json={"settings": {}}
    ).status_code == 401
    assert client.get(
        "/api/hosts/bigboy/config", headers={"X-Register-Token": "sekret"}
    ).status_code == 200
