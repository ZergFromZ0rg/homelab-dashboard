"""The Pi-hole collector: one shared session, re-login on 401, last good data
kept (and flagged stale) through a failure, nothing sent when unconfigured."""

import pytest
import requests
from fastapi.testclient import TestClient

from backend import auth, main, pihole


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
CLIENTS = {"clients": [{"client": "AA:BB:CC:00:00:01", "name": "phone.lan", "comment": "Dad's phone", "groups": [3]}]}
GROUPS = {"groups": [{"id": 0, "name": "Default"}, {"id": 3, "name": "personal"}]}
DHCP_CONFIG = {"config": {"dhcp": {"hosts": ["74:56:3c:98:7b:21,192.168.0.246,bigboy"]}}}
TOP = {"clients": [{"name": "phone.lan", "ip": "192.168.0.211", "count": 50}]}
TOP_BLOCKED = {"clients": [{"name": "phone.lan", "ip": "192.168.0.211", "count": 5}]}
ROUTES = {"/api/clients": CLIENTS, "/api/groups": GROUPS, "/api/config/dhcp": DHCP_CONFIG, "/api/stats/summary": SUMMARY, "/api/dhcp/leases": LEASES, "/api/dns/blocking": BLOCKING,
          "/api/info/ftl": FTL, "/api/info/version": VERSION, "/api/network/devices": DEVICES}


QUERIES = {"queries": [
    {"time": 30, "domain": "ads.example.com", "type": "A", "status": "GRAVITY"},
    {"time": 20, "domain": "ads.example.com", "type": "A", "status": "GRAVITY"},
    {"time": 10, "domain": "apple.com", "type": "A", "status": "FORWARDED"},
    {"time": 5, "domain": "apple.com", "type": "AAAA", "status": "CACHE"},
    {"time": 1, "domain": "track.example.net", "type": "A", "status": "REGEX"},
    {"time": 40, "domain": "mask.icloud.com", "type": "A", "status": "SPECIAL_DOMAIN"},
    {"time": 41, "domain": "mask.icloud.com", "type": "A", "status": "SPECIAL_DOMAIN"},
    {"time": 42, "domain": "mask.icloud.com", "type": "A", "status": "SPECIAL_DOMAIN"},
]}
CLIENT_HISTORY = {"history": [{"timestamp": 100, "data": {"192.168.0.211": 4, "others": 1}},
                              {"timestamp": 700, "data": {"192.168.0.211": 9, "others": 2}}]}


class Fake:
    """Stands in for requests: counts logins, can reject a session once or go dark,
    and writes down every change it was asked to make."""

    def __init__(self, monkeypatch):
        self.logins = 0
        self.gets = 0
        self.reject_next = False
        self.down = False
        self.password_ok = True
        self.writes = []
        self.fail_write = None  # (status, message)
        monkeypatch.setattr(pihole.requests, "post", self.post)
        monkeypatch.setattr(pihole.requests, "request", self.request)

    def post(self, url, json=None, timeout=None):
        if self.down:
            raise requests.ConnectionError("refused")
        self.logins += 1
        if not self.password_ok:
            return Reply(200, {"session": {"valid": False, "sid": None}})
        return Reply(200, {"session": {"valid": True, "sid": f"sid{self.logins}", "validity": 1800}})

    def request(self, method, url, params=None, json=None, headers=None, timeout=None):
        if self.down:
            raise requests.ConnectionError("refused")
        path = url.split("8053")[1]
        if method != "GET":
            self.writes.append((method, path, json))
            if self.fail_write:
                return Reply(self.fail_write[0], {"error": {"message": self.fail_write[1]}})
            return Reply(204 if method == "DELETE" else 200, None if method == "DELETE" else {"ok": True})
        self.gets += 1
        if self.reject_next:
            self.reject_next = False
            return Reply(401, {})
        if path == "/api/stats/top_clients":
            return Reply(200, TOP_BLOCKED if (params or {}).get("blocked") else TOP)
        if path == "/api/queries":
            return Reply(200, QUERIES)
        if path == "/api/history/clients":
            return Reply(200, CLIENT_HISTORY)
        if path == "/api/history":
            return Reply(200, {"history": [{"timestamp": 100, "total": 10, "blocked": 1}]})
        return Reply(200, ROUTES[path])


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
    extras = collector.device_inputs()["extras"]
    assert extras["clients"]["aa:bb:cc:00:00:01"]["comment"] == "Dad's phone"
    assert extras["groups"][3] == "personal"
    assert extras["static"] == [{"mac": "74:56:3c:98:7b:21", "ip": "192.168.0.246", "name": "bigboy"}]
    assert extras["queries"]["192.168.0.211"] == 50 and extras["blocked"]["192.168.0.211"] == 5
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
    body = web.get("/api/pihole/devices").json()
    row = next(d for d in body["devices"] if d["mac"] == "aa:bb:cc:00:00:01")
    assert row["name"] == "Dad's phone"
    assert row["kind"] == "personal"


# --- detail and changes ------------------------------------------------------------


def test_device_detail_counts_what_was_asked_and_refused(monkeypatch):
    collector, fake = make(monkeypatch)
    detail = collector.device_detail("192.168.0.211")
    assert detail["sample"] == 8 and detail["blocked_sample"] == 6 and detail["since"] == 1
    # Pi-hole counts special domains as blocked, so the detail does too
    assert detail["top_blocked"][0] == {"domain": "mask.icloud.com", "count": 3, "allowable": False}
    assert detail["top_blocked"][1] == {"domain": "ads.example.com", "count": 2, "allowable": True}
    assert detail["top_domains"][0]["count"] == 3
    assert detail["recent"][0]["domain"] == "mask.icloud.com" and detail["recent"][0]["allowable"] is False
    assert detail["recent"][-1]["domain"] == "track.example.net"  # the oldest comes last
    assert [r["allowable"] for r in detail["recent"] if r["domain"] == "ads.example.com"] == [True, True]
    assert detail["series"] == [{"t": 100, "v": 4}, {"t": 700, "v": 9}]
    reads = fake.gets
    collector.device_detail("192.168.0.211")
    assert fake.gets == reads  # cached: the query log isn't read twice in a few seconds


def test_a_quiet_device_has_no_series_of_its_own(monkeypatch):
    collector, _ = make(monkeypatch)
    assert collector.device_detail("192.168.0.99")["series"] == []


def test_pause_and_resume_blocking(monkeypatch):
    collector, fake = make(monkeypatch)
    collector.set_blocking(False, 300)
    collector.set_blocking(True)
    assert fake.writes[0] == ("POST", "/api/dns/blocking", {"blocking": False, "timer": 300})
    assert fake.writes[1] == ("POST", "/api/dns/blocking", {"blocking": True, "timer": None})


def test_new_client_entry_for_a_device_pihole_has_not_registered(monkeypatch):
    collector, fake = make(monkeypatch)
    collector.set_client_groups("aa:bb:cc:00:00:09", [0])
    assert fake.writes == [("POST", "/api/clients", {"client": "AA:BB:CC:00:00:09", "comment": "", "groups": [0]})]


def test_existing_client_keeps_its_comment_when_regrouped(monkeypatch):
    collector, fake = make(monkeypatch)
    collector.set_client_groups("aa:bb:cc:00:00:01", [3])
    assert fake.writes == [("PUT", "/api/clients/AA:BB:CC:00:00:01", {"comment": "Dad's phone", "groups": [3]})]


def test_allow_and_unallow(monkeypatch):
    collector, fake = make(monkeypatch)
    collector.allow_domain("ads.example.com")
    collector.unallow_domain("ads.example.com")
    assert fake.writes[0][:2] == ("POST", "/api/domains/allow/exact")
    assert fake.writes[0][2]["domain"] == "ads.example.com" and fake.writes[0][2]["groups"] == [0]
    assert fake.writes[1][:2] == ("DELETE", "/api/domains/allow/exact/ads.example.com")


def test_pihole_refusals_come_through_in_its_words(monkeypatch):
    collector, fake = make(monkeypatch)
    fake.fail_write = (400, "Item already present")
    with pytest.raises(pihole.PiholeError, match="Item already present") as raised:
        collector.allow_domain("ads.example.com")
    assert raised.value.status == 400


def test_outage_clock_starts_on_first_failure_and_clears(monkeypatch):
    collector, fake = make(monkeypatch)
    assert collector.down_for() is None
    fake.down = True
    collector.refresh()
    first = collector._fail_since
    collector.refresh()
    assert collector._fail_since == first and collector.down_for() is not None
    fake.down = False
    collector.refresh()
    assert collector.down_for() is None


# --- routes ------------------------------------------------------------------------


@pytest.fixture
def api(monkeypatch, tmp_path):
    from backend import device_meta, device_names, pihole_alerts

    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(device_names, "names", device_names.NameStore(tmp_path / "n.json"))
    monkeypatch.setattr(device_meta, "meta", device_meta.MetaStore(tmp_path / "m.json"))
    monkeypatch.setattr(pihole_alerts, "known", pihole_alerts.KnownStore(tmp_path / "k.json"))
    collector, fake = make(monkeypatch)
    collector.refresh()
    monkeypatch.setattr(pihole, "collector", collector)
    web = TestClient(main.app)
    web.fake = fake
    web.collector = collector
    return web


def test_blocking_route_validates_and_calls_through(api):
    assert api.post("/api/pihole/blocking", json={"enabled": False, "minutes": 5}).status_code == 200
    assert api.fake.writes[-1] == ("POST", "/api/dns/blocking", {"blocking": False, "timer": 300})
    assert api.post("/api/pihole/blocking", json={"enabled": True}).status_code == 200
    assert api.fake.writes[-1][2] == {"blocking": True, "timer": None}
    assert api.post("/api/pihole/blocking", json={"enabled": False, "minutes": 0}).status_code == 400
    assert api.post("/api/pihole/blocking", json={"enabled": False, "minutes": 99999}).status_code == 400
    assert api.post("/api/pihole/blocking", json={"enabled": False, "minutes": "soon"}).status_code == 400


def test_changes_need_the_gate_but_reads_do_not(api, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "secret")
    assert api.get("/api/pihole").status_code == 200
    assert api.get("/api/pihole/devices").status_code == 200
    for method, path, body in (
        ("post", "/api/pihole/blocking", {"enabled": False}),
        ("post", "/api/pihole/allow", {"domain": "example.com"}),
        ("delete", "/api/pihole/allow/example.com", None),
        ("put", "/api/pihole/devices/aa:bb:cc:00:00:01/group", {"group": 0}),
        ("put", "/api/pihole/devices/aa:bb:cc:00:00:01", {"name": "x"}),
        ("post", "/api/pihole/devices/aa:bb:cc:00:00:01/known", None),
    ):
        assert getattr(api, method)(path, **({"json": body} if body is not None else {})).status_code == 401, path
    assert not api.fake.writes
    ok = api.post("/api/pihole/allow", json={"domain": "example.com"}, headers={"X-Register-Token": "secret"})
    assert ok.status_code == 200


def test_allow_cleans_and_refuses_what_is_not_a_domain(api):
    assert api.post("/api/pihole/allow", json={"domain": " ADS.Example.com. "}).json()["domain"] == "ads.example.com"
    for bad in ("", "nodots", "has space.com", "a/b.com", "evil.com/../x", "-bad.com"):
        assert api.post("/api/pihole/allow", json={"domain": bad}).status_code == 400, bad
    assert api.delete("/api/pihole/allow/..%2Fconfig").status_code in (400, 404)
    assert len([w for w in api.fake.writes if w[0] == "POST"]) == 1


def test_pihole_errors_reach_the_ui_as_a_message(api):
    api.fake.fail_write = (400, "Item already present")
    reply = api.post("/api/pihole/allow", json={"domain": "ads.example.com"})
    assert reply.status_code == 502 and "Item already present" in reply.json()["error"]


def test_unconfigured_changes_say_so(monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(pihole, "collector", pihole.Pihole("", ""))
    reply = TestClient(main.app).post("/api/pihole/blocking", json={"enabled": True})
    assert reply.status_code == 503


def test_group_route_checks_the_group(api):
    mac = "aa:bb:cc:00:00:01"
    assert api.put(f"/api/pihole/devices/{mac}/group", json={"group": 99}).status_code == 400
    assert api.put(f"/api/pihole/devices/{mac}/group", json={"group": "x"}).status_code == 400
    assert api.put(f"/api/pihole/devices/{mac}/group", json={"group": 0}).status_code == 200
    assert api.fake.writes[-1] == ("PUT", "/api/clients/AA:BB:CC:00:00:01", {"comment": "Dad's phone", "groups": [0]})


def test_device_detail_route(api):
    body = api.get("/api/pihole/devices/aa:bb:cc:00:00:01").json()
    assert body["device"]["name"] == "Dad's phone"
    assert [d["domain"] for d in body["detail"]["top_blocked"]][:2] == ["mask.icloud.com", "ads.example.com"]
    assert api.get("/api/pihole/devices/00:00:00:00:00:00").status_code == 404
    listing = api.get("/api/pihole/devices").json()
    assert {"id": 3, "name": "personal"} in listing["groups"]
