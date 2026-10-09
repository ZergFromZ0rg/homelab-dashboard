"""Network watch on the dashboard: the switch and status are proxied and gated,
and what the watchers found becomes alerts that fire, stay, and resolve."""

import pytest
import requests
from fastapi.testclient import TestClient

from backend import alerts, audit_log, auth, main, netwatch_api
from backend.registry import registry


class Reply:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body
        self.ok = status < 400

    def json(self):
        if self._body is None:
            raise ValueError
        return self._body


@pytest.fixture(autouse=True)
def clean_cache():
    """The remembered findings are module state the Overview reads, so one test's
    leftovers would show up as alerts in unrelated ones."""
    netwatch_api._latest.clear()
    yield
    netwatch_api._latest.clear()


@pytest.fixture
def web(monkeypatch):
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://agent:8123/"}, "nas": {"url": "http://nas:8123"}})
    monkeypatch.setattr(auth, "API_TOKEN", "")
    return TestClient(main.app)


FINDING = {"id": "abc123def4", "kind": "gateway-changed", "severity": "bad", "title": "The gateway's address changed hands",
           "message": "Your gateway 192.168.0.1 is now answered by de:ad.", "hint": "Check which device has that MAC.",
           "last": 1000.0}


def test_status_and_switch_reach_the_agent(web, monkeypatch):
    calls = []

    def fake(method, url, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        return Reply(200, {"enabled": True, "state": "watching"})

    monkeypatch.setattr(netwatch_api.requests, "request", fake)
    assert web.get("/api/netwatch/box").json()["state"] == "watching"
    assert web.post("/api/netwatch/box", json={"enabled": True}).status_code == 200
    web.post("/api/netwatch/box", json={})
    assert calls == [("GET", "http://agent:8123/netwatch", None), ("POST", "http://agent:8123/netwatch", {"enabled": True}),
                     ("POST", "http://agent:8123/netwatch", {"enabled": False})]  # no body is off, never on


def test_the_switch_needs_the_token_and_status_does_not(web, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "secret")
    monkeypatch.setattr(netwatch_api.requests, "request", lambda *a, **k: Reply(200, {"enabled": False}))
    assert web.post("/api/netwatch/box", json={"enabled": True}).status_code in (401, 403)
    assert web.get("/api/netwatch/box").status_code == 200
    assert web.post("/api/netwatch/box", json={"enabled": True}, headers={"X-Register-Token": "secret"}).status_code == 200


@pytest.mark.parametrize("reply,message", [(Reply(404), "rebuild"), (Reply(401), "AGENT_TOKEN")])
def test_an_old_or_refusing_agent_is_named(web, monkeypatch, reply, message):
    monkeypatch.setattr(netwatch_api.requests, "request", lambda *a, **k: reply)
    resp = web.get("/api/netwatch/box")
    assert resp.status_code == 502 and message in resp.json()["error"]


def test_an_unreachable_agent_and_an_unknown_host(web, monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("refused")

    monkeypatch.setattr(netwatch_api.requests, "request", boom)
    assert "couldn't reach" in web.get("/api/netwatch/box").json()["error"]
    assert web.get("/api/netwatch/nope").status_code == 404


def test_refresh_gathers_active_findings_from_hosts_that_are_watching(web, monkeypatch):
    bodies = {
        "http://agent:8123/netwatch": Reply(200, {"enabled": True, "active": [FINDING]}),
        "http://nas:8123/netwatch": Reply(200, {"enabled": False, "active": [FINDING]}),  # off: whatever it holds is ignored
    }
    monkeypatch.setattr(netwatch_api.requests, "get", lambda url, **k: bodies[url])
    found = netwatch_api.refresh()
    assert [(f["host"], f["id"]) for f in found] == [("box", "abc123def4")]
    assert netwatch_api.latest() == found  # the Overview reads this without asking anyone


def test_one_unreachable_or_old_agent_does_not_hide_the_others(web, monkeypatch):
    def get(url, **kwargs):
        if "nas" in url:
            raise requests.ConnectionError("down")
        return Reply(200, {"enabled": True, "active": [FINDING]})

    monkeypatch.setattr(netwatch_api.requests, "get", get)
    assert [f["host"] for f in netwatch_api.refresh()] == ["box"]
    monkeypatch.setattr(netwatch_api.requests, "get", lambda url, **k: Reply(404))
    assert netwatch_api.refresh() == [] and netwatch_api.latest() == []  # the list is replaced, never accumulated


def test_a_finding_is_an_alert_that_fires_and_resolves_with_the_findings_own_wording():
    finding = {**FINDING, "host": "box"}
    raw = alerts.evaluate({}, [], findings=[finding])
    [(key, alert)] = raw.items()
    assert key == "netwatch:box:abc123def4"
    assert alert["title"].startswith("box: The gateway") and alert["severity"] == "bad"
    assert alert["hint"] == "Check which device has that MAC."

    monitor = alerts.AlertMonitor()
    fired = monitor.poll({}, [], findings=[finding])
    assert [(e["status"], e["key"]) for e in fired] == [("firing", key)]
    assert monitor.poll({}, [], findings=[finding]) == []  # still firing: no repeat notification
    resolved = monitor.poll({}, [], findings=[])
    assert [(e["status"], e["key"]) for e in resolved] == [("resolved", key)]


def test_a_warning_is_a_warning_and_the_overview_lists_it():
    warn = {**FINDING, "host": "box", "severity": "warn", "id": "w1"}
    [(key, alert)] = alerts.evaluate({}, [], findings=[warn]).items()
    assert alerts.severity_of(key, alert) == "warn"


def test_the_audit_log_names_the_switch():
    assert audit_log.describe("POST", "/api/netwatch/box") == ("network watch switched", "box")


# --- review fixes ---------------------------------------------------------------------------

@pytest.mark.parametrize("finding", [
    {"host": "box"},  # nothing else
    {"host": "box", "id": "x"},  # no title
    {"id": "x", "title": "t", "message": "m"},  # no host
    {"host": "box", "id": "x", "title": None, "message": "m"},
    "a string", 7, None, ["a", "list"],
])
def test_a_malformed_finding_is_skipped_not_fatal(finding):
    good = {**FINDING, "host": "box"}
    raw = alerts.evaluate({}, [], findings=[finding, good])  # the Overview and the alert loop both call this
    assert list(raw) == ["netwatch:box:abc123def4"]


def test_an_agent_of_another_version_cannot_feed_the_dashboard_garbage(web, monkeypatch):
    junk = [{"id": "x"}, {"id": 5, "title": "t", "message": "m"}, "text", {**FINDING}]
    monkeypatch.setattr(netwatch_api.requests, "get", lambda url, **k: Reply(200, {"enabled": True, "active": junk}))
    assert [f["id"] for f in netwatch_api.refresh() if f["host"] == "box"] == ["abc123def4"]
