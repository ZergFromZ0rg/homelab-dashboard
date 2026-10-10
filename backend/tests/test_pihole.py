"""The Pi-hole collector: one shared session, re-login on 401, last good data
kept (and flagged stale) through a failure, nothing sent when unconfigured."""

import requests
from fastapi.testclient import TestClient

from backend import main, pihole


class Reply:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body
        self.ok = status < 400

    def json(self):
        if self._body is None:
            raise ValueError
        return self._body


SUMMARY = {"queries": {"total": 100, "blocked": 8, "percent_blocked": 8.123}, "clients": {"active": 5},
           "gravity": {"domains_being_blocked": 72000}}
LEASES = {"leases": [{"hwaddr": "AA:BB:CC:00:00:01", "ip": "192.168.0.211", "name": "phone", "expires": 5}]}
BLOCKING = {"blocking": "enabled", "timer": None}
FTL = {"ftl": {"uptime": 99.0, "%mem": 0.2, "%cpu": 0.1}}
VERSION = {"version": {"core": {"local": {"version": "v6.4"}, "remote": {"version": "v6.5"}},
                       "web": {"local": {"version": "v6.6"}, "remote": {"version": "v6.6"}},
                       "ftl": {"local": {"version": "v6.7"}, "remote": {"version": "v6.7"}},
                       "docker": {"local": "2026.09.0", "remote": "2026.09.0"}}}
DEVICES = {"devices": [{"hwaddr": "AA:BB:CC:00:00:01", "macVendor": "Apple", "firstSeen": 1, "lastQuery": 2,
                        "numQueries": 7, "ips": [{"ip": "192.168.0.211", "name": "phone.lan", "lastSeen": 3}]}]}
ROUTES = {"/api/stats/summary": SUMMARY, "/api/dhcp/leases": LEASES, "/api/dns/blocking": BLOCKING,
          "/api/info/ftl": FTL, "/api/info/version": VERSION, "/api/network/devices": DEVICES}


class Fake:
    """Stands in for requests: counts logins, can reject a session once or go dark."""

    def __init__(self, monkeypatch):
        self.logins = 0
        self.gets = 0
        self.reject_next = False
        self.down = False
        self.password_ok = True
        monkeypatch.setattr(pihole.requests, "post", self.post)
        monkeypatch.setattr(pihole.requests, "get", self.get)

    def post(self, url, json=None, timeout=None):
        if self.down:
            raise requests.ConnectionError("refused")
        self.logins += 1
        if not self.password_ok:
            return Reply(200, {"session": {"valid": False, "sid": None}})
        return Reply(200, {"session": {"valid": True, "sid": f"sid{self.logins}", "validity": 1800}})

    def get(self, url, params=None, headers=None, timeout=None):
        if self.down:
            raise requests.ConnectionError("refused")
        self.gets += 1
        if self.reject_next:
            self.reject_next = False
            return Reply(401, {})
        return Reply(200, ROUTES[url.split("8053")[1]])


def make(monkeypatch):
    return pihole.Pihole("http://pi:8053/", "app-pass"), Fake(monkeypatch)


def test_unconfigured_does_nothing(monkeypatch):
    fake = Fake(monkeypatch)
    collector = pihole.Pihole("", "")
    collector.refresh()
    assert collector.snapshot() == {"configured": False}
    assert fake.logins == 0


def test_poll_builds_the_overview_and_logs_in_once(monkeypatch):
    collector, fake = make(monkeypatch)
    collector.refresh()
    collector.refresh()
    snap = collector.snapshot()
    assert fake.logins == 1
    assert snap["reachable"] and not snap["stale"]
    assert snap["summary"] == {"total": 100, "blocked": 8, "percent_blocked": 8.1, "active_clients": 5,
                               "gravity_domains": 72000}
    assert snap["blocking"]["enabled"] is True
    assert snap["leases"][0]["mac"] == "aa:bb:cc:00:00:01"
    assert snap["health"]["update_available"] == ["core"]
    assert snap["health"]["versions"]["docker"] == "2026.09.0"
    assert snap["devices_total"] == 1 and snap["leases_total"] == 1
    assert collector.devices()[0]["ips"][0]["name"] == "phone.lan"
    assert "app-pass" not in str(snap)


def test_a_401_logs_in_again_once(monkeypatch):
    collector, fake = make(monkeypatch)
    collector.refresh()
    fake.reject_next = True
    collector.refresh()
    assert fake.logins == 2
    assert collector.snapshot()["reachable"]


def test_failure_keeps_last_good_data(monkeypatch):
    collector, fake = make(monkeypatch)
    collector.refresh()
    fake.down = True
    collector.refresh()
    snap = collector.snapshot()
    assert snap["reachable"] is False
    assert "can't reach Pi-hole" in snap["error"]
    assert snap["summary"]["total"] == 100  # the last good numbers are still there


def test_data_goes_stale_when_polls_stop(monkeypatch):
    collector, _ = make(monkeypatch)
    collector.refresh()
    collector._ok_at -= pihole.STALE_AFTER + 1
    assert collector.snapshot()["stale"] is True


def test_bad_password_is_reported(monkeypatch):
    collector, fake = make(monkeypatch)
    fake.password_ok = False
    collector.refresh()
    snap = collector.snapshot()
    assert snap["reachable"] is False
    assert "rejected the app password" in snap["error"]


def test_routes_serve_the_cache(monkeypatch):
    collector, _ = make(monkeypatch)
    collector.refresh()
    monkeypatch.setattr(pihole, "collector", collector)
    web = TestClient(main.app)
    assert web.get("/api/pihole").json()["summary"]["blocked"] == 8
    assert web.get("/api/pihole/devices").json()["devices"][0]["mac"] == "aa:bb:cc:00:00:01"
