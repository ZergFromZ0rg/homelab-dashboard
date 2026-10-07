"""The packet-capture proxy: statuses and reasons pass through, changes and
the download are token-gated, and the audit log has words for them."""

import pytest
import requests
from fastapi.testclient import TestClient

from backend import audit_log, auth, capture_api, main
from backend.registry import registry


class FakeResponse:
    def __init__(self, status=200, json_body=None, content=b""):
        self.status_code = status
        self._json = json_body
        self.content = content

    def json(self):
        if self._json is None:
            raise ValueError
        return self._json


@pytest.fixture
def web(monkeypatch):
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://agent:8123/"}})
    monkeypatch.setattr(auth, "API_TOKEN", "")
    return TestClient(main.app)


@pytest.fixture
def seen(monkeypatch):
    calls = []

    def fake(method, url, **kwargs):
        calls.append((method, url, kwargs.get("params"), kwargs.get("json")))
        return FakeResponse(200, {"state": "capturing"})

    monkeypatch.setattr(capture_api.requests, "request", fake)
    return calls


def test_start_forwards_the_request_body(web, seen):
    body = {"iface": "eth0", "duration": 30, "filter": {"port": 443}, "payload": False}
    assert web.post("/api/capture/box", json=body).json() == {"state": "capturing"}
    assert seen[0] == ("POST", "http://agent:8123/capture", None, body)


def test_status_asks_only_for_what_is_new(web, seen):
    web.get("/api/capture/box", params={"after": 41})
    assert seen[0][:3] == ("GET", "http://agent:8123/capture", {"after": 41})
    web.get("/api/capture/box", params={"after": -5})
    assert seen[1][2] == {"after": 0}


def test_stop_and_interfaces_route_to_the_agent(web, seen):
    web.delete("/api/capture/box")
    web.get("/api/capture/box/interfaces")
    assert [(c[0], c[1]) for c in seen] == [
        ("DELETE", "http://agent:8123/capture"),
        ("GET", "http://agent:8123/capture/interfaces"),
    ]


def test_the_agents_reason_for_refusing_is_kept(web, monkeypatch):
    monkeypatch.setattr(
        capture_api.requests, "request",
        lambda *a, **k: FakeResponse(400, {"error": "a capture is already running — stop it first"}),
    )
    resp = web.post("/api/capture/box", json={})
    assert resp.status_code == 400 and "already running" in resp.json()["error"]


def test_an_old_agent_says_to_rebuild(web, monkeypatch):
    monkeypatch.setattr(capture_api.requests, "request", lambda *a, **k: FakeResponse(404))
    resp = web.get("/api/capture/box")
    assert resp.status_code == 502 and "rebuild" in resp.json()["error"]


def test_a_rejected_token_is_named(web, monkeypatch):
    monkeypatch.setattr(capture_api.requests, "request", lambda *a, **k: FakeResponse(401))
    assert "AGENT_TOKEN" in web.get("/api/capture/box").json()["error"]


def test_an_unreachable_agent(web, monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("refused")

    monkeypatch.setattr(capture_api.requests, "request", boom)
    assert "couldn't reach" in web.get("/api/capture/box").json()["error"]


def test_unknown_host(web):
    assert web.get("/api/capture/nope").status_code == 404


def test_changes_and_the_download_need_the_token(web, seen, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "secret")
    assert web.post("/api/capture/box", json={}).status_code in (401, 403)
    assert web.delete("/api/capture/box").status_code in (401, 403)
    assert web.get("/api/capture/box/pcap").status_code in (401, 403)
    assert seen == []
    assert web.post("/api/capture/box", json={}, headers={"X-Register-Token": "secret"}).status_code == 200


def test_pcap_comes_back_as_a_download(web, monkeypatch):
    monkeypatch.setattr(
        capture_api.requests, "get", lambda *a, **k: FakeResponse(200, content=b"\xd4\xc3\xb2\xa1data")
    )
    resp = web.get("/api/capture/box/pcap")
    assert resp.content == b"\xd4\xc3\xb2\xa1data"
    assert 'filename="box-capture.pcap"' in resp.headers["content-disposition"]


def test_the_audit_log_has_words_for_it():
    assert audit_log.describe("POST", "/api/capture/box") == ("packet capture", "box")
    assert audit_log.describe("DELETE", "/api/capture/box") == ("packet capture", "box")
    assert audit_log.describe("GET", "/api/capture/box/pcap") == ("packet capture downloaded", "box")
