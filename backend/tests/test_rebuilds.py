import pytest
import requests
from fastapi.testclient import TestClient

from backend import auth, main, rebuilds


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload

    def json(self):
        if self._payload is _BAD_JSON:
            raise ValueError("not json")
        return self._payload


_BAD_JSON = object()

JOB = {
    "id": "9f2c1a4b8e70", "project": "homelab", "service": "homelab-agent",
    "working_dir": "/home/zerg/homelab/homelab-agent", "pull": True,
    "replaces_self": True, "state": "running", "steps": [], "error": None,
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(
        main.registry, "all", lambda: {"bigboy": {"url": "http://bigboy:8123/"}}
    )
    return TestClient(main.app)


def respond(monkeypatch, response):
    calls = []

    def fake_request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(rebuilds.requests, "request", fake_request)
    return calls


def test_starting_a_rebuild_forwards_the_container_and_pull_flag(monkeypatch):
    calls = respond(monkeypatch, FakeResponse(200, JOB))

    job = rebuilds.start("http://bigboy:8123", "homelab-agent", pull=False)

    assert job["id"] == "9f2c1a4b8e70"
    method, url, kwargs = calls[0]
    assert method == "POST" and url == "http://bigboy:8123/rebuild"
    assert kwargs["json"] == {"container": "homelab-agent", "pull": False}


def test_a_host_that_has_not_opted_in_says_so(monkeypatch):
    respond(monkeypatch, FakeResponse(403, {
        "detail": "rebuilds are off on this host; set REBUILD_ENABLED=1 on its agent"
    }))

    with pytest.raises(rebuilds.RebuildError) as caught:
        rebuilds.start("http://bigboy:8123", "jellyfin")

    assert caught.value.status_code == 403
    assert "REBUILD_ENABLED" in str(caught.value)


def test_an_agent_without_the_route_is_told_to_update_first(monkeypatch):
    """The chicken-and-egg case: you want to update the agent *using* the
    thing the old agent doesn't have."""
    respond(monkeypatch, FakeResponse(404))

    with pytest.raises(rebuilds.RebuildError) as caught:
        rebuilds.start("http://bigboy:8123", "homelab-agent")

    assert caught.value.status_code == 501
    assert "update it on the host first" in str(caught.value)


def test_a_conflicting_rebuild_keeps_the_agents_wording(monkeypatch):
    respond(monkeypatch, FakeResponse(409, {
        "detail": "a rebuild is already running on this host"
    }))

    with pytest.raises(rebuilds.RebuildError) as caught:
        rebuilds.start("http://bigboy:8123", "jellyfin")

    assert caught.value.status_code == 409
    assert "already running" in str(caught.value)


def test_an_unreachable_agent_is_a_502(monkeypatch):
    respond(monkeypatch, requests.ConnectionError("no route to host"))

    with pytest.raises(rebuilds.RebuildError) as caught:
        rebuilds.start("http://bigboy:8123", "jellyfin")

    assert caught.value.status_code == 502


def test_a_non_json_error_still_produces_a_message(monkeypatch):
    respond(monkeypatch, FakeResponse(500, _BAD_JSON))

    with pytest.raises(rebuilds.RebuildError) as caught:
        rebuilds.start("http://bigboy:8123", "jellyfin")

    assert "answered 500" in str(caught.value)


def test_polling_a_job(monkeypatch):
    calls = respond(monkeypatch, FakeResponse(200, {**JOB, "state": "done"}))

    assert rebuilds.job("http://bigboy:8123", "9f2c")["state"] == "done"
    assert calls[0][1] == "http://bigboy:8123/rebuild/9f2c"


# ---- routes ---------------------------------------------------------------


def test_route_starts_a_rebuild(client, monkeypatch):
    respond(monkeypatch, FakeResponse(200, JOB))

    body = client.post(
        "/api/rebuild/bigboy", json={"container": "homelab-agent"}
    ).json()

    assert body["id"] == "9f2c1a4b8e70" and body["replaces_self"] is True


def test_route_requires_a_container(client, monkeypatch):
    respond(monkeypatch, FakeResponse(200, JOB))
    assert client.post("/api/rebuild/bigboy", json={}).status_code == 400


def test_route_404s_an_unknown_host(client, monkeypatch):
    monkeypatch.setattr(main.registry, "all", lambda: {})
    resp = client.post("/api/rebuild/ghost", json={"container": "x"})
    assert resp.status_code == 404


def test_route_passes_the_agents_status_code_through(client, monkeypatch):
    respond(monkeypatch, FakeResponse(403, {"detail": "rebuilds are off"}))

    resp = client.post("/api/rebuild/bigboy", json={"container": "x"})

    assert resp.status_code == 403
    assert "rebuilds are off" in resp.json()["detail"]


def test_starting_a_rebuild_needs_the_dashboard_token(client, monkeypatch):
    """The one dashboard route that makes a host run code from a repo."""
    monkeypatch.setattr(auth, "API_TOKEN", "sekret")
    respond(monkeypatch, FakeResponse(200, JOB))

    assert client.post(
        "/api/rebuild/bigboy", json={"container": "x"}
    ).status_code == 401

    assert client.post(
        "/api/rebuild/bigboy",
        json={"container": "x"},
        headers={"X-Register-Token": "sekret"},
    ).status_code == 200


def test_polling_a_job_through_the_route(client, monkeypatch):
    respond(monkeypatch, FakeResponse(200, {**JOB, "state": "handed_off"}))

    body = client.get("/api/rebuild/bigboy/9f2c1a4b8e70").json()

    assert body["state"] == "handed_off"
