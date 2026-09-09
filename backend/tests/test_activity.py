import pytest

from backend import activity
from backend.jsonstore import read_json


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setattr(activity, "_FILE", tmp_path / "activity.json")
    activity._entries.clear()
    activity._prev_containers.clear()
    activity._prev_nodes.clear()
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


def test_container_vanishing_is_a_stop():
    activity.observe({"nas": _machine()}, {"nas": [_c("plex")]}, [])
    activity.observe({"nas": _machine()}, {"nas": []}, [])
    assert kinds() == ["container_stop"]


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


def test_cap_and_reload(monkeypatch, tmp_path):
    path = tmp_path / "a.json"
    monkeypatch.setattr(activity, "_FILE", path)
    for i in range(150):
        activity.record("container_start", f"c{i} started")
    assert len(activity.recent()) == activity.MAX_ENTRIES

    activity._entries.clear()
    activity._entries.extend(read_json(path, []))
    assert len(activity.recent()) == activity.MAX_ENTRIES
