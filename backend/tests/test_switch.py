"""The switch: ports read from Prometheus, the alerts that follow from them,
and the join with Pi-hole's devices."""

import pytest
import requests
from fastapi.testclient import TestClient

from backend import auth, main, pihole, prometheus, switch
import test_network_devices as nd


def labels(index, alias="", name=None):
    return {"ifIndex": str(index), "ifAlias": alias, "ifName": name or f"g{index}", "job": "switch", "instance": "192.168.0.109"}


def vector(*pairs):
    return [{"metric": m, "value": [0, str(v)]} for m, v in pairs]


ROUTER, BIGBOY, SPARE, CPU = labels(1, "router"), labels(2, "Bigboy"), labels(3, ""), labels(13, "", "cpu")


class Prom:
    """A fake Prometheus: answers each query the module asks by what it asks."""

    def __init__(self, monkeypatch, **over):
        self.up = over.get("up", 1)
        self.down_lately = over.get("down_lately", False)
        self.unconfigured = over.get("unconfigured", False)
        self.status = over.get("status", {1: 1, 2: 1, 3: 1, 13: 1})
        self.lately = over.get("lately", {1: 1, 2: 1, 3: 1, 13: 1})
        self.ever = over.get("ever", {1: 1, 2: 1, 3: 1, 13: 1})
        self.speed = over.get("speed", {1: 100, 2: 1000, 3: 1000, 13: 0})
        self.usual = over.get("usual", {1: 100, 2: 1000, 3: 1000, 13: 0})
        self.sent = over.get("sent", {1: 5e6, 2: 2e8})
        self.received = over.get("received", {1: 9e6, 2: 1e6})
        self.busy = over.get("busy", {})
        self.errors_day = over.get("errors_day", {1: 0, 2: 3})
        self.errors_now = over.get("errors_now", {1: 0, 2: 0})
        self.fail = None
        monkeypatch.setattr(prometheus, "query", self.query)

    def ports(self, values):
        by_index = {1: ROUTER, 2: BIGBOY, 3: SPARE, 13: CPU}
        return vector(*[(by_index[i], v) for i, v in values.items()])

    def query(self, promql):
        if self.fail:
            raise self.fail
        if promql.startswith("up{"):
            return [] if self.unconfigured else vector((labels(0), self.up))
        if promql.startswith("max_over_time(up"):
            return vector((labels(0), 0 if self.down_lately else 1))
        if promql.startswith("ifOperStatus"):
            return self.ports(self.status)
        if promql.startswith("min_over_time(ifOperStatus") and "[2m]" in promql:
            return self.ports(self.lately)
        if promql.startswith("min_over_time(ifOperStatus"):
            return self.ports(self.ever)
        if promql.startswith("ifHighSpeed"):
            return self.ports(self.speed)
        if promql.startswith("max_over_time(ifHighSpeed"):
            return self.ports(self.usual)
        if promql.startswith("avg_over_time"):
            return self.ports(self.busy)
        if promql.startswith("rate(ifHCInOctets"):
            return self.ports(self.sent)
        if promql.startswith("rate(ifHCOutOctets"):
            return self.ports(self.received)
        if "[24h]" in promql:
            return self.ports(self.errors_day)
        if "[15m]" in promql:
            return self.ports(self.errors_now)
        raise AssertionError(promql)


def snapshot(monkeypatch, **over):
    Prom(monkeypatch, **over)
    monitor = switch.Switch()
    monitor.refresh(1000.0)
    return monitor.snapshot()


def by_name(snap):
    return {p["name"]: p for p in snap["ports"]}


# ---- reading the ports ---------------------------------------------------


def test_labelled_ports_become_rows_with_speed_and_traffic(monkeypatch):
    snap = snapshot(monkeypatch)
    assert snap["state"] == "up" and snap["instance"] == "192.168.0.109" and snap["reachable"]
    router, bigboy = by_name(snap)["router"], by_name(snap)["Bigboy"]
    assert (router["port"], router["speed_mbps"], router["up"], router["labelled"]) == ("g1", 100, True, True)
    assert bigboy["speed_mbps"] == 1000 and bigboy["errors_24h"] == 3


def test_traffic_is_the_devices_side_not_the_switchs(monkeypatch):
    """The switch's "in" is what the device sends it; a row called Bigboy should
    read the other way round."""
    bigboy = by_name(snapshot(monkeypatch))["Bigboy"]
    assert bigboy["sent_bps"] == 200_000_000  # ifHCInOctets
    assert bigboy["received_bps"] == 1_000_000  # ifHCOutOctets
    assert bigboy["usage"] == 0.2


def test_an_unlabelled_port_shows_only_while_something_is_plugged_in(monkeypatch):
    assert "g3" in {p["port"] for p in snapshot(monkeypatch)["ports"]}
    unplugged = snapshot(monkeypatch, status={1: 1, 2: 1, 3: 2, 13: 1})
    assert "g3" not in {p["port"] for p in unplugged["ports"]}


def test_the_cpu_interface_and_link_aggregates_are_left_out(monkeypatch):
    assert "cpu" not in {p["port"] for p in snapshot(monkeypatch)["ports"]}


def test_ports_come_in_switch_order(monkeypatch):
    assert [p["index"] for p in snapshot(monkeypatch)["ports"]] == [1, 2, 3]


def test_no_switch_job_means_unconfigured(monkeypatch):
    assert snapshot(monkeypatch, unconfigured=True)["state"] == "unconfigured"


def test_a_switch_that_stopped_answering_is_down(monkeypatch):
    assert snapshot(monkeypatch, up=0, down_lately=True)["state"] == "down"


def test_nothing_is_claimed_before_the_first_refresh():
    assert switch.Switch().snapshot()["state"] == "loading"


def test_a_prometheus_failure_keeps_the_last_ports_marked_stale(monkeypatch):
    prom = Prom(monkeypatch)
    monitor = switch.Switch()
    monitor.refresh(1000.0)
    prom.fail = requests.ConnectionError("refused")
    monitor.refresh(1030.0)
    snap = monitor.snapshot()
    assert snap["state"] == "unreachable" and snap["stale"] and not snap["reachable"]
    assert "refused" in snap["error"] and len(snap["ports"]) == 3
    prom.fail = None
    monitor.refresh(1060.0)
    assert monitor.snapshot()["state"] == "up" and not monitor.snapshot()["stale"]


def test_prometheus_down_from_the_start_has_no_ports_to_show(monkeypatch):
    prom = Prom(monkeypatch)
    prom.fail = requests.ConnectionError("refused")
    monitor = switch.Switch()
    monitor.refresh(1000.0)
    snap = monitor.snapshot()
    assert snap["state"] == "unreachable" and snap["ports"] == [] and not snap["stale"]


def test_the_job_name_cannot_inject_promql():
    assert switch._JOB_RE.fullmatch("switch") and not switch._JOB_RE.fullmatch('x"} or vector(1) #')


# ---- alerts --------------------------------------------------------------


def alerts(monkeypatch, **over):
    return switch.evaluate(snapshot(monkeypatch, **over))


def test_a_healthy_switch_raises_nothing(monkeypatch):
    assert alerts(monkeypatch) == {}


def test_the_router_running_at_its_usual_100_is_not_an_alert(monkeypatch):
    """It is slow, but it has always been: only a drop from what a port normally
    does is news."""
    assert alerts(monkeypatch) == {}


def test_a_gigabit_port_falling_back_to_100_is_a_warning(monkeypatch):
    out = alerts(monkeypatch, speed={1: 100, 2: 100, 3: 1000, 13: 0})
    alert = out["network:switch-port-slow:g2"]
    assert alert["severity"] == "warn" and alert["debounce"]
    assert "Bigboy" in alert["title"] and "1000" in alert["message"]


def test_a_labelled_port_that_lost_link_is_bad(monkeypatch):
    out = alerts(monkeypatch, status={1: 1, 2: 2, 3: 1, 13: 1}, lately={1: 1, 2: 2, 3: 1, 13: 1})
    assert out["network:switch-port-down:g2"]["severity"] == "bad"


def test_a_blip_shorter_than_two_minutes_is_not_down(monkeypatch):
    assert alerts(monkeypatch, status={1: 1, 2: 2, 3: 1, 13: 1}) == {}  # still up at some point in the window


def test_a_port_that_was_never_up_this_week_is_not_an_outage(monkeypatch):
    out = alerts(monkeypatch, status={1: 1, 2: 2, 3: 1, 13: 1}, lately={1: 1, 2: 2, 3: 1, 13: 1}, ever={1: 1, 2: 2, 3: 1, 13: 1})
    assert out == {}


def test_an_unlabelled_port_is_not_watched(monkeypatch):
    out = alerts(monkeypatch, speed={1: 100, 2: 1000, 3: 10, 13: 0}, errors_now={3: 900})
    assert out == {}


def test_errors_over_the_threshold_warn(monkeypatch):
    out = alerts(monkeypatch, errors_now={1: 0, 2: switch.ERRORS_PER_15M + 1})
    assert out["network:switch-port-errors:g2"]["severity"] == "warn"
    assert alerts(monkeypatch, errors_now={1: 0, 2: switch.ERRORS_PER_15M}) == {}


def test_only_the_uplink_is_watched_for_saturation(monkeypatch):
    out = alerts(monkeypatch, busy={1: 95e6, 2: 950e6})  # both ~95% of their link
    assert list(out) == ["network:switch-uplink-full:g1"]
    assert "95%" in out["network:switch-uplink-full:g1"]["message"]
    assert alerts(monkeypatch, busy={1: 50e6}) == {}


def test_a_silent_switch_is_one_alert_not_a_pile(monkeypatch):
    out = alerts(monkeypatch, up=0, down_lately=True, status={1: 2, 2: 2, 3: 2, 13: 2}, lately={1: 2, 2: 2, 3: 2, 13: 2})
    assert list(out) == ["network:switch-down"] and out["network:switch-down"]["severity"] == "bad"


def test_a_switch_down_for_seconds_only_is_not_yet_an_alert(monkeypatch):
    assert alerts(monkeypatch, up=0, down_lately=False) == {}


@pytest.mark.parametrize("state", ["unconfigured", "unreachable", "loading"])
def test_without_an_answer_about_the_switch_there_is_nothing_to_alert(state):
    assert switch.evaluate({"state": state, "ports": [], "down_lately": True}) == {}


# ---- the join with Pi-hole -----------------------------------------------


def test_a_port_label_finds_its_device_whatever_the_case(monkeypatch):
    snap = snapshot(monkeypatch)
    rows = [{"name": "bigboy", "hostname": "bigboy"}, {"name": "Dad's phone", "hostname": "phone"}]
    switch.attach_ports(rows, snap)
    assert rows[0]["port"]["port"] == "g2" and rows[0]["port"]["speed_mbps"] == 1000
    assert "port" not in rows[1]


def test_the_hostname_matches_when_the_name_is_something_else(monkeypatch):
    snap = snapshot(monkeypatch)
    rows = [{"name": "My server", "hostname": "Bigboy"}]
    switch.attach_ports(rows, snap)
    assert rows[0]["port"]["name"] == "Bigboy"


def test_unlabelled_ports_are_never_matched_to_devices(monkeypatch):
    rows = [{"name": "g3", "hostname": ""}]
    switch.attach_ports(rows, snapshot(monkeypatch))
    assert "port" not in rows[0]


def test_nothing_to_join_when_the_switch_is_not_there():
    rows = [{"name": "bigboy"}]
    switch.attach_ports(rows, {"state": "unconfigured"})
    assert rows == [{"name": "bigboy"}]


# ---- the routes ----------------------------------------------------------


@pytest.fixture
def web(monkeypatch, tmp_path):
    from backend import device_meta, device_names

    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(device_names, "names", device_names.NameStore(tmp_path / "names.json"))
    monkeypatch.setattr(device_meta, "meta", device_meta.MetaStore(tmp_path / "meta.json"))
    collector = pihole.Pihole("http://pi:8053", "x")
    monkeypatch.setattr(collector, "device_inputs", lambda: {**nd.inputs(), "updated_at": nd.NOW})
    monkeypatch.setattr(pihole, "collector", collector)
    Prom(monkeypatch)
    monitor = switch.Switch()
    monitor.refresh(1000.0)
    monkeypatch.setattr(switch, "monitor", monitor)
    return TestClient(main.app)


def test_the_route_serves_the_cached_snapshot(web):
    body = web.get("/api/switch").json()
    assert body["state"] == "up" and [p["name"] for p in body["ports"]] == ["router", "Bigboy", "g3"]


def test_the_device_table_knows_which_port_each_server_is_on(web):
    rows = {d["name"]: d for d in web.get("/api/pihole/devices").json()["devices"]}
    assert rows["bigboy"]["port"]["port"] == "g2" and rows["bigboy"]["port"]["speed_mbps"] == 1000
    assert "port" not in rows["Galaxy-Tab-A7"]


def test_switch_alerts_reach_the_overview_alerts(web, monkeypatch):
    from backend import network_alerts, pihole_alerts

    monkeypatch.setattr(pihole_alerts, "current", lambda: {"network:pihole-down": {"title": "x"}})
    assert list(network_alerts.current()) == ["network:pihole-down"]
    Prom(monkeypatch, speed={1: 100, 2: 100, 3: 1000, 13: 0})
    switch.monitor.refresh(1030.0)
    assert set(network_alerts.current()) == {"network:pihole-down", "network:switch-port-slow:g2"}
