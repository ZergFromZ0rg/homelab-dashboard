"""Phone notifications: off until turned on, a secret topic, severity
filter, and security events."""

from fastapi.testclient import TestClient

from backend import main, notify


class Sent:
    def __init__(self, monkeypatch, status=200):
        self.calls = []
        outer = self

        class R:
            status_code = status

            def raise_for_status(self):
                if status >= 400:
                    raise notify.requests.HTTPError(status)

        def post(url, data=None, headers=None, timeout=None):
            outer.calls.append((url, data.decode(), headers))
            return R()

        monkeypatch.setattr(notify.requests, "post", post)


def test_nothing_is_sent_until_enabled(monkeypatch):
    sent = Sent(monkeypatch)
    notify.alert({"status": "firing", "severity": "bad", "title": "bigboy offline", "message": "x"})
    assert sent.calls == []


def test_enabling_picks_a_long_secret_topic_and_alerts_go_out(monkeypatch):
    sent = Sent(monkeypatch)
    cfg = notify.update({"enabled": True})
    assert cfg["topic"].startswith("homelab-") and len(cfg["topic"]) >= 24

    notify.alert({"status": "firing", "severity": "bad", "title": "bigboy offline", "message": "down"})
    notify.alert({"status": "resolved", "severity": "bad", "title": "bigboy offline", "message": "up"})

    (url, body, headers), (_, _, resolved) = sent.calls
    assert url == f"https://ntfy.sh/{cfg['topic']}" and body == "down"
    assert headers["Title"] == "bigboy offline" and headers["Priority"] == "4"
    assert resolved["Title"] == "Resolved: bigboy offline" and resolved["Priority"] == "2"


def test_severity_filter(monkeypatch):
    sent = Sent(monkeypatch)
    notify.update({"enabled": True, "min_severity": "bad"})
    notify.alert({"status": "firing", "severity": "warn", "title": "RAM high", "message": "x"})
    assert sent.calls == []


def test_routes_test_button_and_a_bad_server(monkeypatch):
    sent = Sent(monkeypatch)
    web = TestClient(main.app)
    assert web.post("/api/notify/test").status_code == 400  # no topic yet
    cfg = web.put("/api/notify", json={"enabled": True, "server": "https://ntfy.example.org/"},
                  headers={"Origin": "https://thinkpad.example.ts.net"}).json()
    assert cfg["server"] == "https://ntfy.example.org"
    assert web.post("/api/notify/test").json() == {"sent": True}
    assert sent.calls[0][2]["Click"] == "https://thinkpad.example.ts.net"
    assert web.put("/api/notify", json={"server": "ftp://nope"}).status_code == 400


def test_a_new_topic_on_request(monkeypatch):
    first = notify.update({"enabled": True})["topic"]
    assert notify.update({"new_topic": True})["topic"] != first
