import requests

from backend import disk


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.ok = status_code < 400

    def json(self):
        return self._payload


def test_passes_the_scan_through(monkeypatch):
    seen = {}

    def fake_get(url, params=None, **kwargs):
        seen.update(url=url, params=params)
        return FakeResponse(200, {"state": "scanning", "path": "/home", "entries": []})

    monkeypatch.setattr(disk.requests, "get", fake_get)
    result = disk.usage("http://agent", "/home", refresh=True)

    assert result["state"] == "scanning"
    assert seen == {"url": "http://agent/disk/usage", "params": {"path": "/home", "refresh": "true"}}


def test_old_agent_and_refusals_read_as_errors(monkeypatch):
    monkeypatch.setattr(disk.requests, "get", lambda *a, **k: FakeResponse(404))
    assert "predates" in disk.usage("http://agent", "/")["error"]

    monkeypatch.setattr(
        disk.requests, "get", lambda *a, **k: FakeResponse(400, {"error": "path must be absolute"})
    )
    assert disk.usage("http://agent", "x") == {
        "state": "error",
        "error": "path must be absolute",
        "entries": [],
    }


def test_unreachable(monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("refused")

    monkeypatch.setattr(disk.requests, "get", boom)
    assert disk.usage("http://agent", "/")["state"] == "error"
