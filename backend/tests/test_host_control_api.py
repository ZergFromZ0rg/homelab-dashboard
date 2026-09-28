"""Host control proxy: reading is open to the session, changing needs a
fresh passkey confirmation; failed services become an alert."""

from fastapi.testclient import TestClient

from backend import activity, alerts, auth, files_api, main, passkeys
from backend.registry import registry


class Resp:
    def __init__(self, body, status=200):
        self.status_code = status
        self.ok = status < 400
        self._body = body

    def json(self):
        return self._body


def setup(monkeypatch, calls):
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://a:8123"}})
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(activity, "record", lambda *a: calls.append(("activity",) + a))

    def fake(method, url, **kwargs):
        calls.append((method, url.split("8123")[1], kwargs.get("json")))
        return Resp({"ok": True, "services": []})

    monkeypatch.setattr(files_api.requests, "request", fake)


def test_reading_and_changing(monkeypatch):
    calls = []
    setup(monkeypatch, calls)
    web = TestClient(main.app)
    assert web.get("/api/hosts/box/services").status_code == 200
    assert web.post("/api/hosts/box/power", json={"action": "reboot"}).status_code == 200
    assert ("POST", "/host/power", {"action": "reboot"}) in calls
    assert ("activity", "node_down", "box rebooting (from the dashboard)", "box") in calls


def test_changing_needs_a_confirmation_once_login_is_on(monkeypatch):
    monkeypatch.setattr(auth, "STEP_UP", True)
    calls = []
    setup(monkeypatch, calls)
    monkeypatch.setattr(passkeys.store, "enabled", lambda: True)
    monkeypatch.setattr(passkeys.store, "check_session", lambda t: t == "good")
    monkeypatch.setattr(passkeys.store, "elevated_until", lambda t: None)
    web = TestClient(main.app)
    cookie = {"cookie": f"{passkeys.SESSION_COOKIE}=good"}

    assert web.get("/api/hosts/box/services", headers=cookie).status_code == 200
    for method, path in [("post", "/api/hosts/box/power"), ("post", "/api/hosts/box/os-updates/upgrade"),
                         ("post", "/api/hosts/box/services/cron.service/restart")]:
        resp = getattr(web, method)(path, json={"action": "reboot"}, headers=cookie)
        assert resp.status_code == 403 and resp.json()["detail"]["elevate"], path


def test_failed_services_raise_an_alert():
    found = alerts._host_alerts("bigboy", {"online": True, "host_facts": {"failed_units": ["smartd.service"]}})
    assert found["host:bigboy:services"]["title"] == "bigboy: 1 service failed"
    assert "host:bigboy:services" not in alerts._host_alerts("bigboy", {"online": True, "host_facts": {"failed_units": []}})


def test_the_agents_host_name_is_not_mistaken_for_facts(monkeypatch):
    """Regression: the agent's /containers already had "host" (its name);
    the facts reused that key and a string reached the alert rules."""
    from backend import docker

    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return {"host": "bigboy", "containers": [], "host_facts": {"failed_units": ["x.service"]}}

    monkeypatch.setattr(docker.requests, "get", lambda *a, **k: R())
    monkeypatch.setattr(docker.backups, "status_for", lambda *a: None)
    monkeypatch.setattr(docker.versions, "for_host", lambda *a: None)
    _, snap = docker.get_host_data("bigboy", "http://bigboy")
    assert snap["host_facts"] == {"failed_units": ["x.service"]}
    assert alerts._host_alerts("bigboy", {"host_facts": "bigboy"}) == {}
