"""The network alert rules: Pi-hole down, a device nobody has accounted for,
and a spike in blocking. New-device tracking starts from a baseline so turning
it on doesn't report the whole house."""

import pytest
from fastapi.testclient import TestClient

from backend import alerts, auth, device_meta, device_names, main, pihole, pihole_alerts
from backend.pihole_alerts import KnownStore, block_spike, evaluate

NOW = 1_000_000.0


def row(mac, name="x", source="hostname", kind="unknown", kind_source="", ghost=""):
    return {"mac": mac, "name": name, "name_source": source, "kind": kind, "kind_source": kind_source, "ghost": ghost}


@pytest.fixture
def store(tmp_path):
    return KnownStore(tmp_path / "known.json")


def test_the_first_look_makes_everyone_known(store):
    store.observe([row("a"), row("b")], NOW)
    assert store.new() == {}
    store.observe([row("a"), row("b"), row("c")], NOW + 60)
    assert list(store.new()) == ["c"]


def test_an_empty_network_is_not_learned(store):
    store.observe([], NOW)  # Pi-hole hasn't answered yet
    store.observe([row("a")], NOW + 60)
    assert store.new() == {}  # "a" was the baseline, not a newcomer


def test_new_devices_clear_when_named_or_after_a_day(store):
    store.observe([row("a")], NOW)
    store.observe([row("a"), row("b"), row("c")], NOW + 10)
    assert set(store.new()) == {"b", "c"}
    store.observe([row("a"), row("b", "Dad's phone", "label"), row("c")], NOW + 20)
    assert set(store.new()) == {"c"}
    store.observe([row("a"), row("b"), row("c")], NOW + 10 + pihole_alerts.NEW_WINDOW + 1)
    assert store.new() == {}


def test_servers_and_pihole_named_devices_arrive_known(store):
    store.observe([row("a")], NOW)
    store.observe([row("a"), row("s", kind="server"), row("p", "Mom's phone", "pihole")], NOW + 10)
    assert store.new() == {}


def test_marking_known_and_persistence(store, tmp_path):
    store.observe([row("a")], NOW)
    store.observe([row("a"), row("b")], NOW + 10)
    store.acknowledge("B")
    assert store.new() == {}
    again = KnownStore(tmp_path / "known.json")
    again.observe([row("a"), row("b")], NOW + 20)
    assert again.new() == {}  # remembered across a restart


def test_hidden_rows_are_not_newcomers(store):
    store.observe([row("a")], NOW)
    store.observe([row("a"), row("g", ghost="stale")], NOW + 10)
    assert store.new() == {}


def history(recent, usual, buckets=60):
    """(timestamp, total, blocked) buckets: `usual` percent for a day, then `recent`."""
    out = [(i * 600, 20, round(20 * usual / 100)) for i in range(buckets)]
    out += [((buckets + i) * 600, 40, round(40 * recent / 100)) for i in range(pihole_alerts.RECENT_BUCKETS)]
    return out


def test_spike_needs_to_be_high_and_unusual():
    assert block_spike(history(recent=60, usual=8))["rate"] == 60
    assert block_spike(history(recent=12, usual=8)) is None  # normal wobble
    assert block_spike(history(recent=60, usual=55)) is None  # always like this
    assert block_spike(history(recent=60, usual=8)[:3]) is None  # not enough history
    quiet = [(i * 600, 1, 0) for i in range(60)] + [(36000 + i, 5, 5) for i in range(4)]
    assert block_spike(quiet) is None  # a handful of queries is not a spike


def test_alerts_for_each_condition():
    rows = [row("a", "iPad"), row("b", "mystery")]
    out = evaluate(down_for=None, error=None, rows=rows, new={"b": NOW}, history=history(60, 8))
    assert set(out) == {"network:new-devices", "network:block-spike"}
    assert "mystery" in out["network:new-devices"]["message"]
    assert out["network:block-spike"]["debounce"] is True

    down = evaluate(down_for=pihole_alerts.DOWN_AFTER + 60, error="refused", rows=[], new={}, history=[])
    assert down["network:pihole-down"]["severity"] == "bad"
    blip = evaluate(down_for=30, error="refused", rows=[], new={}, history=[])
    assert blip == {}  # a short blip isn't an alert


def test_many_new_devices_are_one_alert():
    rows = [row(str(i), f"dev{i}") for i in range(7)]
    out = evaluate(down_for=None, error=None, rows=rows, new={r["mac"]: NOW for r in rows}, history=[])
    assert list(out) == ["network:new-devices"]
    assert out["network:new-devices"]["title"].startswith("7 new devices")
    assert "and 3 more" in out["network:new-devices"]["message"]


def test_network_alerts_flow_through_the_alert_monitor():
    monitor = alerts.AlertMonitor(breach_cycles=2)
    net = {"network:pihole-down": {"title": "Pi-hole is unreachable", "message": "m", "severity": "bad"}}
    first = monitor.poll({}, [], network=net, now=NOW)
    assert [(e["status"], e["key"]) for e in first] == [("firing", "network:pihole-down")]
    assert [(e["status"]) for e in monitor.poll({}, [], network={}, now=NOW + 60)] == ["resolved"]
