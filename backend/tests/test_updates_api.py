"""Image update proxy: gated start, outcome on the feed once."""

import pytest
from fastapi.testclient import TestClient

from backend import activity, auth, files_api, main, updates_api
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
    answers, calls, recorded = {}, [], []

    def fake(method, url, **kwargs):
        calls.append((method, url.split("8123")[1], kwargs.get("json")))
        return answers[(method, url.split("8123")[1])]

    monkeypatch.setattr(files_api.requests, "request", fake)
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://agent:8123"}})
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(activity, "record", lambda *a: recorded.append(a))
    updates_api._reported.clear()
    return answers, calls, recorded


def test_update_all_and_its_outcome(agent, monkeypatch):
    answers, calls, recorded = agent
    web = TestClient(main.app)
    answers[("POST", "/updates")] = Resp(200, {"id": "j", "projects": ["jellyfin", "qbittorrent"], "state": "running"})
    answers[("GET", "/updates/jobs/j")] = Resp(200, {
        "id": "j", "projects": ["jellyfin", "qbittorrent"], "state": "rolled_back",
        "results": {"jellyfin": "done", "qbittorrent": "rolled back: qbittorrent keeps restarting"},
    })

    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")
    assert web.post("/api/updates/box", json={}).status_code == 401
    monkeypatch.setattr(auth, "API_TOKEN", "")

    assert web.post("/api/updates/box", json={}).status_code == 200
    assert calls[-1] == ("POST", "/updates", {})
    web.get("/api/updates/box/jobs/j")
    web.get("/api/updates/box/jobs/j")

    assert recorded == [
        ("update", "Updating jellyfin, qbittorrent", "box"),
        ("update_rolled_back",
         "jellyfin, qbittorrent update rolled back: qbittorrent rolled back: qbittorrent keeps restarting", "box"),
    ]


def test_check_passes_through(agent):
    answers, calls, _ = agent
    answers[("POST", "/updates/check")] = Resp(200, {"images": {}})
    assert TestClient(main.app).post("/api/updates/box/check").json() == {"images": {}}
