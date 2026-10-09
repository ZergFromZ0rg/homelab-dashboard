"""Automatic capture: what triggers it, what it asks for, what stops it, and
that it can never leave a host stuck or widen what is recorded."""

import time as real_time

import pytest
import requests
from fastapi.testclient import TestClient

from backend import audit_log, auth, autocapture, capture_store, main
from backend.registry import registry


class FakeClock:
    """A clock one module can be given in place of ``time``. Patching the real
    ``time`` module would change it for everything else running too — including
    the test's own sleeps — so each module gets a stand-in of its own."""

    def __init__(self, start=1_700_000_000.0):
        self.now = start
        self.slept = 0.0

    def time(self):
        self.now += 0.001  # strictly increasing, so "newest" is never a tie
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        self.slept += seconds

    strftime = staticmethod(real_time.strftime)
    localtime = staticmethod(real_time.localtime)


def use_clock(monkeypatch, *modules):
    clock = FakeClock()
    for module in modules:
        monkeypatch.setattr(module, "time", clock)
    return clock


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(autocapture, "FILE", tmp_path / "autocapture.json")
    monkeypatch.setattr(capture_store, "DIR", tmp_path / "captures")
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://agent:8123"}, "nas": {"url": "http://nas:8123"}})
    monkeypatch.setattr(autocapture, "_address", lambda name: {"nas.lan": "192.168.1.20", "localhost": "127.0.0.1"}.get(name) or (name if name[0].isdigit() else None))
    monkeypatch.setattr(audit_log, "record", lambda *a, **k: None)
    monkeypatch.setattr(autocapture, "_started_at", 0.0)  # the post-restart grace has its own tests
    autocapture._recent.clear()
    autocapture._last_for_check.clear()
    autocapture._busy.clear()


def check(kind="tcp", target="nas.lan:445", origin=None, cid="c1", name="NAS"):
    return {"id": cid, "name": name, "type": kind, "target": target, "origin": origin, "status": "down"}


def event(key="check:c1", status="firing", title="NAS is down"):
    return {"key": key, "status": status, "title": title}


# --- settings -------------------------------------------------------------------------------------

def test_it_is_off_until_switched_on_and_settings_are_validated_and_persist():
    assert autocapture.settings() == {"enabled": False, "duration": 20, "per_host_per_hour": 4, "keep": 10}
    assert autocapture.update({"enabled": True, "duration": 30})["duration"] == 30
    assert autocapture.settings()["enabled"] is True  # read back from disk
    for bad in ({"enabled": "yes"}, {"duration": 3}, {"duration": 999}, {"keep": 0}, {"per_host_per_hour": True}, {"keep": 1.5}):
        with pytest.raises(ValueError):
            autocapture.update(bad)
    assert autocapture.update({"unknown": 1}) == autocapture.settings()  # strangers are ignored


def test_a_corrupted_settings_file_means_defaults_not_a_crash(tmp_path):
    (tmp_path / "autocapture.json").write_text("{not json")
    assert autocapture.settings()["enabled"] is False
    (tmp_path / "autocapture.json").write_text('{"duration": 99999, "keep": "many", "enabled": 1}')
    assert autocapture.settings() == {"enabled": True, "duration": 120, "per_host_per_hour": 4, "keep": 10}  # clamped, junk dropped


# --- what to capture -------------------------------------------------------------------------------

@pytest.mark.parametrize("kind,target,expected", [
    ("tcp", "nas.lan:445", "host 192.168.1.20 and port 445"),
    ("tls", "nas.lan:8443", "host 192.168.1.20 and port 8443"),
    ("tls", "nas.lan", "host 192.168.1.20 and port 443"),
    ("http", "https://nas.lan/status", "host 192.168.1.20 and port 443"),
    ("http", "http://nas.lan:8080/", "host 192.168.1.20 and port 8080"),
    ("keyword", "nas.lan", "host 192.168.1.20 and port 80"),
    ("ping", "192.168.1.1", "host 192.168.1.1"),
    ("dns", "example.com", "port 53"),
    ("tcp", "unresolvable.example:22", "port 22"),  # the name won't resolve here: still narrowed by port
    ("ping", "unresolvable.example", None),         # nothing to narrow by: everything
])
def test_the_capture_filter_follows_the_checks_own_connection(kind, target, expected):
    assert autocapture.expression_for(check(kind, target)) == expected


def test_a_loopback_target_is_refused_there_is_nothing_on_the_wire():
    with pytest.raises(autocapture.Refused, match="this machine itself"):
        autocapture.expression_for(check("http", "http://localhost:8080/"))


def test_the_origin_host_is_where_the_failing_traffic_is():
    assert autocapture.host_for(check(origin="nas"), "box") == "nas"
    assert autocapture.host_for(check(origin=None), "box") == "box"  # a dashboard check runs from the dashboard's host
    assert autocapture.host_for(check(origin=None), None) is None


# --- when it triggers ---------------------------------------------------------------------------------

@pytest.fixture
def started(monkeypatch):
    runs = []
    monkeypatch.setattr(autocapture, "_run", lambda *args: (runs.append(args), autocapture._busy.discard(args[0])))
    autocapture.update({"enabled": True})
    return runs


def settle(runs, count=1):
    end = real_time.time() + 2
    while len(runs) < count and real_time.time() < end:
        real_time.sleep(0.01)
    return runs


def test_a_check_going_down_starts_one_capture_of_that_connection(started):
    assert autocapture.consider(event(), [check()], "box") is True
    [(host, reason, trigger, expr, config)] = settle(started)
    assert (host, reason, trigger, expr) == ("box", "NAS is down", "check:c1", "host 192.168.1.20 and port 445")
    assert config["duration"] == 20


def test_packet_loss_triggers_it_too_but_a_merely_slow_check_does_not(started):
    assert autocapture.consider(event("check:c1:loss"), [check()], "box") is True
    assert autocapture.consider(event("check:c1:slow"), [check(cid="c1")], "box") is False
    assert autocapture.consider(event("check:c1", status="resolved"), [check()], "box") is False
    assert autocapture.consider(event("host:box:ram"), [check()], "box") is False
    assert autocapture.consider(event("check:zzz"), [check()], "box") is False  # a check that no longer exists


def test_nothing_happens_while_it_is_off(started):
    autocapture.update({"enabled": False})
    assert autocapture.consider(event(), [check()], "box") is False and started == []


def test_the_same_check_is_not_captured_again_within_ten_minutes(started):
    assert autocapture.consider(event(), [check()], "box", now=1000.0) is True
    autocapture._busy.clear()
    assert autocapture.consider(event(), [check()], "box", now=1000.0 + 599) is False
    assert autocapture.consider(event(), [check()], "box", now=1000.0 + 601) is True


def test_a_host_has_an_hourly_limit_and_one_capture_at_a_time(monkeypatch):
    # A capture in progress holds its host until it ends, so this stub never lets go.
    monkeypatch.setattr(autocapture, "_run", lambda *args: None)
    autocapture.update({"enabled": True, "per_host_per_hour": 2})
    assert autocapture.consider(event("check:a"), [check(cid="a")], "box", now=1000.0) is True
    assert autocapture.consider(event("check:b"), [check(cid="b")], "box", now=1001.0) is False  # box is still busy
    autocapture._busy.clear()
    assert autocapture.consider(event("check:b"), [check(cid="b")], "box", now=1001.0) is True
    autocapture._busy.clear()
    assert autocapture.consider(event("check:c"), [check(cid="c")], "box", now=1002.0) is False  # two this hour already
    assert autocapture.consider(event("check:c"), [check(cid="c")], "box", now=1000.0 + 3700) is True  # the hour rolled over
    assert autocapture.consider(event("check:d"), [check(cid="d")], "nas", now=1002.0) is True  # another host: its own budget


def test_a_check_with_no_known_host_is_skipped_with_a_reason(started):
    assert autocapture.consider(event(), [check(origin=None)], None) is False


# --- the capture itself -----------------------------------------------------------------------------------

class FakeAgent:
    def __init__(self, packets=5, state_after=("capturing", "done"), refuse=None):
        self.calls, self.packets, self.states, self.refuse = [], packets, list(state_after), refuse

    def post(self, url, json=None, **kwargs):
        self.calls.append(("POST", url, json))
        if self.refuse:
            return type("R", (), {"status_code": 400, "text": self.refuse, "ok": False})()
        return type("R", (), {"status_code": 200, "text": "", "ok": True})()

    def get(self, url, params=None, **kwargs):
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        body = {"state": state, "iface": "eth0", "filter": {}, "payload": "none", "promisc": False, "duration": 1,
                "totals": {"pkts": self.packets, "bytes": 500}, "started_at": 1.0,
                "packets": [{"n": i, "ts": float(i), "len": 60, "hex": "aabb"} for i in range(self.packets)]}
        return type("R", (), {"json": lambda s: body})()

    def delete(self, url, **kwargs):
        self.calls.append(("DELETE", url, None))


@pytest.fixture
def agent(monkeypatch):
    fake = FakeAgent()
    monkeypatch.setattr(autocapture.requests, "post", fake.post)
    monkeypatch.setattr(autocapture.requests, "get", fake.get)
    monkeypatch.setattr(autocapture.requests, "delete", fake.delete)
    use_clock(monkeypatch, autocapture, capture_store)  # waiting costs nothing, and saves are ordered
    autocapture.update({"duration": 5})
    return fake


def run(host="box", expr="host 192.168.1.20 and port 445"):
    autocapture._busy.add(host)
    return autocapture._capture(host, "NAS is down", "check:c1", expr, autocapture.settings())


def test_it_asks_for_headers_only_never_promiscuous_and_saves_the_result_marked_auto(agent):
    meta = run()
    [(_, url, body)] = [c for c in agent.calls if c[0] == "POST"]
    assert url == "http://agent:8123/capture"
    assert body == {"duration": 5, "payload": "none", "promisc": False, "filter": {"expr": "host 192.168.1.20 and port 445"}}
    assert meta["auto"] is True and meta["reason"] == "NAS is down" and meta["trigger"] == "check:c1"
    assert meta["name"].startswith("auto: NAS is down") and meta["packets"] == 5
    assert "box" not in autocapture._busy  # the host is released


def test_a_capture_without_a_filter_asks_for_everything_on_that_host(agent):
    run(expr=None)
    assert "filter" not in [c for c in agent.calls if c[0] == "POST"][0][2]


def test_it_steps_aside_for_a_capture_someone_started(agent):
    agent.refuse = "a capture is already running — stop it first"
    with pytest.raises(autocapture.Refused, match="already running"):
        run()
    assert "box" not in autocapture._busy and capture_store.list_all() == []


def test_a_capture_that_saw_nothing_is_not_saved(monkeypatch, agent):
    agent.packets = 0
    with pytest.raises(autocapture.Refused, match="no packets"):
        run()
    assert capture_store.list_all() == [] and "box" not in autocapture._busy


def test_a_capture_that_overruns_is_told_to_stop_and_what_it_recorded_is_kept(monkeypatch, agent):
    agent.states = ["capturing"]  # it never reports finishing
    monkeypatch.setattr(autocapture, "SETTLE", 0)
    meta = run()
    assert ("DELETE", "http://agent:8123/capture", None) in agent.calls  # the agent was told to stop
    assert meta["packets"] == 5 and meta["auto"] is True  # and the packets it had are not thrown away
    assert "box" not in autocapture._busy


def test_a_capture_that_overruns_and_recorded_nothing_saves_nothing(monkeypatch, agent):
    agent.states, agent.packets = ["capturing"], 0
    with pytest.raises(autocapture.Refused, match="no packets"):
        run()
    assert capture_store.list_all() == [] and "box" not in autocapture._busy


def test_an_unregistered_host_is_refused_and_released():
    with pytest.raises(autocapture.Refused, match="isn't a registered node"):
        run("ghost")
    assert "ghost" not in autocapture._busy


def test_only_the_newest_few_automatic_captures_are_kept_and_yours_never_go(agent):
    mine = capture_store.save("box", "keep me", {"packets": [{"n": 1}], "totals": {}})
    autocapture.update({"keep": 2})
    ids = [run()["id"] for _ in range(4)]
    kept = [m["id"] for m in capture_store.list_all()]
    assert mine["id"] in kept and ids[-1] in kept and ids[-2] in kept
    assert ids[0] not in kept and ids[1] not in kept and len([m for m in capture_store.list_all() if m.get("auto")]) == 2


def test_automatic_captures_do_not_use_up_the_ones_you_may_save_by_hand(monkeypatch, agent):
    monkeypatch.setattr(capture_store, "MAX_CAPTURES", 1)
    run()
    run()
    capture_store.save("box", "mine", {"packets": [{"n": 1}], "totals": {}})  # not refused: only autos exist
    with pytest.raises(capture_store.StoreError, match="delete one first"):
        capture_store.save("box", "mine too", {"packets": [{"n": 1}], "totals": {}})


def test_a_failure_in_the_background_is_logged_and_the_host_released(monkeypatch):
    recorded = []
    monkeypatch.setattr(audit_log, "record", lambda *a, **k: recorded.append((a, k)))
    monkeypatch.setattr(autocapture, "_capture", lambda *a: (_ for _ in ()).throw(requests.ConnectionError("agent down")))
    autocapture._run("box", "NAS is down", "check:c1", None, autocapture.settings())  # must not raise
    assert recorded and recorded[0][1]["ok"] is False and "agent down" in recorded[0][1]["detail"]


# --- the routes ---------------------------------------------------------------------------------------------

@pytest.fixture
def web(monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "")
    return TestClient(main.app)


def test_settings_are_readable_and_changing_them_needs_the_token(web, monkeypatch):
    assert web.get("/api/autocapture").json()["enabled"] is False
    assert web.put("/api/autocapture", json={"enabled": True, "keep": 5}).json()["keep"] == 5
    assert web.put("/api/autocapture", json={"duration": 1}).status_code == 400
    monkeypatch.setattr(auth, "API_TOKEN", "secret")
    assert web.put("/api/autocapture", json={"enabled": False}).status_code in (401, 403)
    assert web.post("/api/autocapture/box/test").status_code in (401, 403)
    assert web.get("/api/autocapture").status_code == 200


def test_the_try_it_button_takes_one_capture_now(web, monkeypatch, agent):
    out = web.post("/api/autocapture/box/test").json()
    assert out["auto"] is True and out["reason"] == "manual test" and out["host"] == "box"
    autocapture._busy.add("box")
    resp = web.post("/api/autocapture/box/test")
    assert resp.status_code == 409 and "already capturing" in resp.json()["error"]


def test_the_audit_log_names_these_actions():
    assert audit_log.describe("PUT", "/api/autocapture")[0] == "automatic capture settings changed"
    assert audit_log.describe("POST", "/api/autocapture/box/test") == ("automatic capture tried", "box")


# --- review fixes -------------------------------------------------------------------------------

def test_a_check_with_a_strange_target_never_raises_into_the_alert_loop(monkeypatch, caplog):
    autocapture.update({"enabled": True})
    started = []
    monkeypatch.setattr(autocapture, "_run", lambda *a: started.append(a))
    for target in ("http://host:99999/x", "http://[::1", "://", "http://a b/", ""):
        odd = check("http", target, origin="nas")
        assert autocapture.consider(event(), [odd], "box", now=5000.0) in (True, False)  # whatever it decides, no exception
        autocapture._busy.clear()
        autocapture._last_for_check.clear()


def test_even_an_unforeseen_failure_inside_it_is_contained(monkeypatch):
    autocapture.update({"enabled": True})
    monkeypatch.setattr(autocapture, "expression_for", lambda c: 1 / 0)
    assert autocapture.consider(event(), [check()], "box") is False  # logged, not raised


def test_a_port_out_of_range_narrows_by_address_only_and_a_broken_url_is_refused():
    assert autocapture.expression_for(check("http", "http://nas.lan:99999/x")) == "host 192.168.1.20"
    with pytest.raises(autocapture.Refused, match="can't work out"):
        autocapture.expression_for(check("http", "http://[::1"))


def test_alerts_that_fire_just_because_the_dashboard_restarted_are_not_failures_beginning(monkeypatch):
    autocapture.update({"enabled": True})
    started = []
    monkeypatch.setattr(autocapture, "_run", lambda *a: started.append(a))
    monkeypatch.setattr(autocapture, "_started_at", 10_000.0)
    assert autocapture.consider(event(), [check()], "box", now=10_000.0 + autocapture.GRACE - 1) is False  # still rediscovering
    assert autocapture.consider(event(), [check()], "box", now=10_000.0 + autocapture.GRACE + 1) is True  # a real new failure
    assert autocapture.GRACE >= 120


@pytest.mark.parametrize("failure,fragment", [
    ("busy", "already running"),
    ("unreachable", "couldn't reach"),
    ("refused", "refused (401)"),
    ("unregistered", "isn't a registered node"),
])
def test_an_attempt_that_never_recorded_anything_costs_no_budget(monkeypatch, failure, fragment, caplog):
    host = "ghost" if failure == "unregistered" else "box"
    autocapture.update({"enabled": True, "per_host_per_hour": 1})
    now = 100_000.0
    # The consider() step charges the budget; _run then finds the agent unable to start.
    autocapture._allowed(host, "check:c1", 1, now)
    if failure == "busy":
        monkeypatch.setattr(autocapture.requests, "post", lambda *a, **k: type("R", (), {"status_code": 400, "text": "a capture is already running", "ok": False})())
    elif failure == "unreachable":
        monkeypatch.setattr(autocapture.requests, "post", lambda *a, **k: (_ for _ in ()).throw(requests.ConnectionError("down")))
    elif failure == "refused":
        monkeypatch.setattr(autocapture.requests, "post", lambda *a, **k: type("R", (), {"status_code": 401, "text": "invalid agent token", "ok": False})())
    with caplog.at_level("INFO"):
        autocapture._run(host, "NAS is down", "check:c1", None, autocapture.settings())
    assert fragment in caplog.text
    assert autocapture._recent.get(host) == [] and "check:c1" not in autocapture._last_for_check  # refunded
    autocapture._allowed(host, "check:c1", 1, now + 1)  # so the next alert is allowed to try
    assert host in autocapture._busy


def test_a_capture_that_recorded_nothing_keeps_its_charge(agent):
    agent.packets = 0
    autocapture._allowed("box", "check:c1", 4, 100_000.0)
    autocapture._run("box", "NAS is down", "check:c1", None, autocapture.settings())
    assert len(autocapture._recent["box"]) == 1 and "check:c1" in autocapture._last_for_check  # it did try; don't hammer


def test_an_agent_side_failure_is_named_when_nothing_was_seen(agent, monkeypatch):
    original = agent.get

    def failing(url, params=None, **kwargs):
        response = original(url, params, **kwargs)
        body = response.json()
        body.update(state="error", error="the capture helper stopped unexpectedly: ImportError", packets=[])
        return type("R", (), {"json": lambda s: body})()

    monkeypatch.setattr(autocapture.requests, "get", failing)
    with pytest.raises(autocapture.Refused, match="ImportError"):
        run()
