"""The file-browser proxy: statuses and errors pass through, bytes stream,
changes are gated like delete."""

import pytest
import requests
from fastapi.testclient import TestClient

from backend import auth, files_api, main
from backend.registry import registry


class FakeResponse:
    def __init__(self, status=200, json_body=None, content=b"", headers=None):
        self.status_code = status
        self.ok = status < 400
        self._json = json_body
        self._content = content
        self.headers = headers or {}

    def json(self):
        if self._json is None:
            raise ValueError
        return self._json

    def iter_content(self, size):
        for i in range(0, len(self._content), 3):
            yield self._content[i:i + 3]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


@pytest.fixture
def calls(monkeypatch):
    seen = []
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://agent:8123/"}})
    monkeypatch.setattr(auth, "API_TOKEN", "")
    return seen


@pytest.fixture
def web():
    return TestClient(main.app)


def answer(monkeypatch, calls, response):
    def fake(method, url, **kwargs):
        data = kwargs.get("data")
        calls.append((method, url, kwargs.get("params"), kwargs.get("json"), data.read() if data else None))
        return response
    monkeypatch.setattr(files_api.requests, "request", fake)


def test_listing_passes_through(web, calls, monkeypatch):
    answer(monkeypatch, calls, FakeResponse(json_body={"path": "/home/zerg", "entries": []}))
    resp = web.get("/api/files/box/list", params={"path": "~"})
    assert resp.json()["path"] == "/home/zerg"
    assert calls[0][:3] == ("GET", "http://agent:8123/files/list", {"path": "~"})


def test_a_conflict_keeps_its_status_and_reason(web, calls, monkeypatch):
    answer(monkeypatch, calls, FakeResponse(409, {"success": False, "error": "conf.yml changed on disk"}))
    resp = web.put("/api/files/box/text", json={"path": "/x", "content": "y", "modified": 1})
    assert resp.status_code == 409
    assert "changed on disk" in resp.json()["error"]
    assert calls[0][3] == {"path": "/x", "content": "y", "modified": 1}


def test_an_old_agent_says_to_rebuild(web, calls, monkeypatch):
    answer(monkeypatch, calls, FakeResponse(404))
    resp = web.get("/api/files/box/list")
    assert resp.status_code == 502
    assert "rebuild" in resp.json()["error"]


def test_an_unreachable_agent(web, calls, monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("refused")
    monkeypatch.setattr(files_api.requests, "request", boom)
    assert "couldn't reach" in web.get("/api/files/box/list").json()["error"]


def test_unknown_host(web, calls):
    assert web.get("/api/files/nope/list").status_code == 404


def test_upload_streams_the_body_through(web, calls, monkeypatch):
    answer(monkeypatch, calls, FakeResponse(json_body={"success": True}))
    payload = b"x" * 200_000
    resp = web.post("/api/files/box/upload", params={"path": "/home/zerg/a.bin"}, content=payload)
    assert resp.json() == {"success": True}
    method, url, params, _, sent = calls[0]
    assert (method, url) == ("POST", "http://agent:8123/files/upload")
    assert params == {"path": "/home/zerg/a.bin", "overwrite": "false"}
    assert sent == payload


def test_download_streams_with_headers(web, calls, monkeypatch):
    def fake_get(url, **kwargs):
        calls.append(url)
        return FakeResponse(content=b"hello world", headers={
            "Content-Type": "text/plain",
            "Content-Disposition": "attachment; filename*=UTF-8''a.txt",
            "X-Other": "dropped",
        })
    monkeypatch.setattr(files_api.requests, "get", fake_get)
    resp = web.get("/api/files/box/download", params={"path": "/a.txt"})
    assert resp.content == b"hello world"
    assert resp.headers["content-disposition"].startswith("attachment")
    assert "x-other" not in resp.headers


def test_changes_need_the_token_when_one_is_set(web, calls, monkeypatch):
    answer(monkeypatch, calls, FakeResponse(json_body={"success": True}))
    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")
    assert web.post("/api/files/box/mkdir", json={"path": "/x"}).status_code == 401
    assert web.post("/api/files/box/rename", json={"path": "/x", "name": "y"}).status_code == 401
    assert web.post("/api/files/box/upload", params={"path": "/x"}, content=b"1").status_code == 401
    assert web.put("/api/files/box/text", json={}).status_code == 401
    ok = web.post("/api/files/box/mkdir", json={"path": "/x"}, headers={"X-Register-Token": "s3cret"})
    assert ok.status_code == 200
    # Reading stays open to the session.
    assert web.get("/api/files/box/list").status_code == 200


@pytest.mark.parametrize("route", ["newfile", "move", "copy"])
def test_new_changes_are_gated_and_forwarded(web, calls, monkeypatch, route):
    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")
    answer(monkeypatch, calls, FakeResponse(json_body={"success": True}))
    body = {"path": "/x", "dest": "/y"}

    assert web.post(f"/api/files/box/{route}", json=body).status_code == 401
    ok = web.post(f"/api/files/box/{route}", json=body, headers={"X-Register-Token": "s3cret"})

    assert ok.status_code == 200
    assert calls[-1][:2] == ("POST", f"http://agent:8123/files/{route}")
    assert calls[-1][3] == body
