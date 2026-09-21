import pytest

from backend import alert_history, alerts
from backend.jsonstore import read_json


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setattr(alert_history, "_FILE", tmp_path / "alerts.json")
    alert_history._entries.clear()
    alerts._open.clear()
    yield


def _event(status, key="host:nuc-1:ram", **kw):
    base = {
        "status": status,
        "key": key,
        "title": "nuc-1 RAM high",
        "message": "nuc-1 RAM at 93% (threshold 90%)",
        "host": "nuc-1",
        "severity": "warn",
        "timestamp": 1000.0,
    }
    base.update(kw)
    return base


def test_firing_opens_an_episode():
    alert_history.record(_event("firing"))

    (entry,) = alert_history.recent()
    assert entry["key"] == "host:nuc-1:ram"
    assert entry["at"] == 1000.0
    assert entry["resolved_at"] is None
    assert entry["severity"] == "warn"
    assert entry["host"] == "nuc-1"


def test_resolved_closes_the_same_episode():
    alert_history.record(_event("firing"))
    alert_history.record(_event("resolved", timestamp=1600.0))

    (entry,) = alert_history.recent()
    assert entry["at"] == 1000.0
    assert entry["resolved_at"] == 1600.0


def test_refire_while_open_keeps_the_original_start():
    """A dashboard restart loses AlertMonitor's in-memory firing set, so a
    still-breaching alert fires again. That's the same episode."""
    alert_history.record(_event("firing"))
    alert_history.record(_event("firing", timestamp=2000.0, message="now at 97%"))

    (entry,) = alert_history.recent()
    assert entry["at"] == 1000.0
    assert entry["message"] == "now at 97%"


def test_repeated_episodes_for_the_same_key_are_separate():
    alert_history.record(_event("firing"))
    alert_history.record(_event("resolved", timestamp=1600.0))
    alert_history.record(_event("firing", timestamp=5000.0))

    entries = alert_history.recent()
    assert len(entries) == 2
    assert entries[0]["at"] == 5000.0 and entries[0]["resolved_at"] is None
    assert entries[1]["resolved_at"] == 1600.0


def test_resolved_without_a_known_start_has_no_start_time():
    alert_history.record(_event("resolved", timestamp=1600.0))

    (entry,) = alert_history.recent()
    assert entry["at"] is None
    assert entry["resolved_at"] == 1600.0


def test_sweep_closes_episodes_that_are_no_longer_firing():
    alert_history.record(_event("firing", key="host:nuc-1:ram"))
    alert_history.record(_event("firing", key="host:nas:offline"))

    alert_history.sweep({"host:nas:offline"}, now=3000.0)

    by_key = {e["key"]: e for e in alert_history.recent()}
    assert by_key["host:nuc-1:ram"]["resolved_at"] == 3000.0
    assert by_key["host:nas:offline"]["resolved_at"] is None


def test_sweep_leaves_already_closed_episodes_alone():
    alert_history.record(_event("firing"))
    alert_history.record(_event("resolved", timestamp=1600.0))

    alert_history.sweep(set(), now=3000.0)

    assert alert_history.recent()[0]["resolved_at"] == 1600.0


def test_entries_persist_and_are_capped(monkeypatch, tmp_path):
    monkeypatch.setattr(alert_history, "MAX_ENTRIES", 3)
    for i in range(5):
        alert_history.record(_event("firing", key=f"host:h{i}:ram", timestamp=float(i)))

    saved = read_json(alert_history._FILE, None)
    assert [e["key"] for e in saved] == ["host:h4:ram", "host:h3:ram", "host:h2:ram"]


def test_monitor_events_carry_everything_the_history_needs():
    """The real producer — what AlertMonitor emits has to line up with
    what ``record`` reads."""
    monitor = alerts.AlertMonitor(breach_cycles=1)
    machines = {"nuc-1": {"online": False, "agent_reachable": True, "cpu": 1, "ram": 1}}

    for event in monitor.poll(machines, [], now=100.0):
        alert_history.record(event)

    (entry,) = alert_history.recent()
    assert entry["key"] == "host:nuc-1:offline"
    assert entry["severity"] == "bad"
    assert entry["host"] == "nuc-1"
    assert entry["at"] == 100.0

    machines["nuc-1"]["online"] = True
    for event in monitor.poll(machines, [], now=200.0):
        alert_history.record(event)

    assert alert_history.recent()[0]["resolved_at"] == 200.0


def test_api_route_serves_the_history(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from backend import main

    alert_history.record(_event("firing"))

    with TestClient(main.app) as client:
        body = client.get("/api/alerts").json()

    assert body["alerts"][0]["key"] == "host:nuc-1:ram"
    assert body["alerts"][0]["resolved_at"] is None
