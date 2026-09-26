import requests

from backend import networks


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.ok = status_code < 400

    def json(self):
        return self._payload


def test_list_passes_rows_through(monkeypatch):
    rows = [{"name": "media", "containers": []}]
    monkeypatch.setattr(
        networks.requests, "get", lambda *a, **k: FakeResponse(200, {"networks": rows})
    )
    assert networks.list_for("http://agent") == {"available": True, "networks": rows}


def test_list_explains_an_old_agent(monkeypatch):
    monkeypatch.setattr(networks.requests, "get", lambda *a, **k: FakeResponse(404))
    result = networks.list_for("http://agent")
    assert result["available"] is False
    assert "predates" in result["reason"]


def test_list_unreachable(monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("refused")

    monkeypatch.setattr(networks.requests, "get", boom)
    assert "couldn't reach" in networks.list_for("http://agent")["reason"]


def test_mutations_surface_the_agents_reason(monkeypatch):
    calls = []

    def fake_request(method, url, json=None, **kwargs):
        calls.append((method, url, json))
        return FakeResponse(400, {"success": False, "error": "still in use by jellyfin"})

    monkeypatch.setattr(networks.requests, "request", fake_request)

    assert networks.remove("http://agent", "media") == {
        "success": False,
        "error": "still in use by jellyfin",
    }
    networks.attach("http://agent", "media", "jellyfin", connect=False)
    networks.create("http://agent", "lan", "", True)

    assert calls[0][:2] == ("DELETE", "http://agent/networks/media")
    assert calls[1] == ("POST", "http://agent/networks/media/disconnect", {"container": "jellyfin"})
    assert calls[2] == ("POST", "http://agent/networks", {"name": "lan", "subnet": None, "internal": True})
