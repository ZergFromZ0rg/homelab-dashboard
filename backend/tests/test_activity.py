import time
import pytest

from backend import activity
from backend.jsonstore import read_json


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setattr(activity, "_FILE", tmp_path / "activity.json")
    activity._entries.clear()
    activity._prev_containers.clear()
    activity._prev_nodes.clear()
    activity._prev_names.clear()
    activity._prev_facts.clear()
    activity._seen_event_at.clear()
    monkeypatch.setattr(activity, "_initialized", False)
    yield


def _c(cid, status="running", health=None, restarts=0, name=None):
    return {"id": cid, "name": name or cid, "status": status, "health": health,
            "restart_count": restarts}


def _machine(online=True, agent=True):
    return {"online": online, "agent_reachable": agent}


def kinds():
    return [e["kind"] for e in activity.recent()]


def test_first_observe_snapshots_silently():
    activity.observe(
        {"nas": _machine()}, {"nas": [_c("plex")]}, []
    )
    assert activity.recent() == []


def test_container_start_stop_and_restart():
    activity.observe({"nas": _machine()}, {"nas": [_c("plex", status="exited")]}, [])

    activity.observe({"nas": _machine()}, {"nas": [_c("plex", status="running")]}, [])
    assert kinds() == ["container_start"]

    activity.observe({"nas": _machine()}, {"nas": [_c("plex", status="exited")]}, [])
    assert kinds()[0] == "container_stop"

    activity.observe(
        {"nas": _machine()}, {"nas": [_c("plex", status="running", restarts=1)]}, []
    )
    assert kinds()[0] == "container_restart"


def test_container_vanishing_is_a_removal():
    activity.observe({"nas": _machine()}, {"nas": [_c("plex")]}, [])
    activity.observe({"nas": _machine()}, {"nas": []}, [])
    assert kinds() == ["container_removed"]
    assert activity.recent()[0]["text"] == "plex on nas removed"


def test_new_and_recreated_containers_are_told_apart_by_name():
    activity.observe({"nas": _machine()}, {"nas": [_c("a1", name="plex")]}, [])
    # An image update: same name, new id — a recreate, not new + removed.
    activity.observe({"nas": _machine()}, {"nas": [_c("b2", name="plex")]}, [])
    assert kinds() == ["container_recreated"]
    activity.observe({"nas": _machine()}, {"nas": [_c("b2", name="plex"), _c("c3", name="immich")]}, [])
    assert kinds()[0] == "container_new"


def test_an_unreachable_agent_is_not_every_container_removed():
    activity.observe({"nas": _machine()}, {"nas": [_c("plex")]}, [])
    activity.observe({"nas": _machine(agent=False)}, {"nas": []}, [])
    activity.observe({"nas": _machine()}, {"nas": [_c("plex")]}, [])
    assert "container_removed" not in kinds() and "container_new" not in kinds()


def _host(os_updates, reboot=False, uptime=10_000):
    return {"online": True, "agent_reachable": True, "uptime": uptime,
            "host_facts": {"os_updates": os_updates, "reboot_required": reboot}}


def test_os_updates_arriving_installed_and_the_reboot():
    activity.observe({"nas": _host(0)}, {"nas": []}, [])
    activity.observe({"nas": _host(12)}, {"nas": []}, [])
    assert kinds() == ["os_updates_available"]
    activity.observe({"nas": _host(0, reboot=True)}, {"nas": []}, [])
    assert kinds()[:2] == ["reboot_required", "os_updated"]
    assert "12 OS updates installed on nas" in [e["text"] for e in activity.recent()]
    activity.observe({"nas": _host(0, uptime=30)}, {"nas": []}, [])
    assert kinds()[0] == "node_rebooted"


def test_health_flip():
    activity.observe({"nas": _machine()}, {"nas": [_c("db")]}, [])
    activity.observe({"nas": _machine()}, {"nas": [_c("db", health="unhealthy")]}, [])
    assert kinds()[0] == "container_unhealthy"
    activity.observe({"nas": _machine()}, {"nas": [_c("db", health="healthy")]}, [])
    assert kinds()[0] == "container_healthy"


def test_node_and_agent_transitions():
    activity.observe({"nuc": _machine()}, {"nuc": []}, [])
    activity.observe({"nuc": _machine(online=False)}, {"nuc": []}, [])
    assert kinds()[0] == "node_down"
    activity.observe({"nuc": _machine(agent=False)}, {"nuc": []}, [])
    # back online + agent down
    assert "node_up" in kinds() and "agent_down" in kinds()


def test_new_failed_deployment_event():
    dep = {
        "id": "d1", "placed_on": "nas", "kind": "container",
        "spec": {"image": "radarr"},
        "events": [{"at": 100.0, "kind": "created", "detail": "placing"}],
    }
    activity.observe({"nas": _machine()}, {"nas": []}, [dep])  # snapshot

    dep = {**dep, "events": dep["events"] + [
        {"at": 200.0, "kind": "failed", "detail": "pull error"}
    ]}
    activity.observe({"nas": _machine()}, {"nas": []}, [dep])
    assert kinds()[0] == "deploy_failed"
    assert "pull error" in activity.recent()[0]["text"]


def test_live_view_is_short_history_is_long_and_it_reloads(monkeypatch, tmp_path):
    path = tmp_path / "a.json"
    monkeypatch.setattr(activity, "_FILE", path)
    for i in range(400):
        activity.record("container_start", f"c{i} started")
    # Every /ws tick carries only the newest; the history keeps them all.
    assert len(activity.recent()) == activity.LIVE_ENTRIES
    assert len(activity.history(1000)) == 400

    activity._entries.clear()
    activity._entries.extend(read_json(path, []))
    assert len(activity.history(1000)) == 400


def test_old_entries_go_after_the_retention_period(monkeypatch):
    now = time.time()
    activity._entries[:] = [
        {"at": now - 40 * 86400, "kind": "x", "text": "ancient", "host": None},
        {"at": now - 10 * 86400, "kind": "x", "text": "recent", "host": None},
    ][::-1]
    monkeypatch.setattr(activity, "_pruned_at", 0.0)
    activity.record("x", "now")
    assert [e["text"] for e in activity.history(10)] == ["now", "recent"]


def test_history_pages_and_filters():
    for i in range(5):
        activity.record("container_start", f"c{i} started", host="bigboy" if i % 2 else "thinkpad")
    newest = activity.history(1)[0]
    assert all(e["at"] < newest["at"] for e in activity.history(10, before=newest["at"]))
    assert {e["host"] for e in activity.history(10, q="bigboy")} == {"bigboy"}
