"""Container settings proxy: generated fallback, gating, and the activity
feed hearing about each apply exactly once."""

import pytest
from fastapi.testclient import TestClient

from backend import activity, auth, compose_api, files_api, main
from backend.registry import registry


class Resp:
    def __init__(self, status, body):
        self.status_code = status
        self.ok = status < 400
        self._body = body

    def json(self):
        return self._body


@pytest.fixture
def agent(monkeypatch):
    answers = {}
    calls = []
    recorded = []

    def fake(method, url, **kwargs):
        calls.append((method, url, kwargs.get("json"), kwargs.get("params")))
        return answers[(method, url.split("8123")[1])]

    monkeypatch.setattr(files_api.requests, "request", fake)
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://agent:8123"}})
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(activity, "record", lambda *a: recorded.append(a))
    compose_api._reported.clear()
    return answers, calls, recorded


@pytest.fixture
def web():
    return TestClient(main.app)


def test_compose_settings_pass_through(web, agent):
    answers, calls, _ = agent
    answers[("GET", "/compose")] = Resp(200, {"project": "media", "files": []})
    assert web.get("/api/compose/box/containers/abc").json()["project"] == "media"
    assert calls[0][3] == {"container": "abc"}


def test_a_non_compose_container_gets_a_generated_file(web, agent):
    answers, _, _ = agent
    answers[("GET", "/compose")] = Resp(400, {"error": "not compose", "compose": False})
    answers[("GET", "/compose/generate")] = Resp(200, {"compose": False, "generated": "services: {}\n"})
    assert web.get("/api/compose/box/containers/abc").json()["generated"] == "services: {}\n"


def test_apply_is_gated_and_logged_once(web, agent, monkeypatch):
    answers, _, recorded = agent
    answers[("POST", "/compose/apply")] = Resp(200, {"id": "j1", "project": "media", "state": "running"})
    answers[("GET", "/compose/jobs/j1")] = Resp(
        200, {"id": "j1", "project": "media", "state": "rolled_back", "error": "jellyfin exited with code 1; back"}
    )

    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")
    assert web.post("/api/compose/box/apply", json={}).status_code == 401
    monkeypatch.setattr(auth, "API_TOKEN", "")

    assert web.post("/api/compose/box/apply", json={"container": "abc"}).status_code == 200
    web.get("/api/compose/box/jobs/j1")
    web.get("/api/compose/box/jobs/j1")

    assert recorded == [
        ("compose", "Applying a compose change to media", "box"),
        ("compose_rolled_back", "Compose change to media rolled back: jellyfin exited with code 1; back", "box"),
    ]
