from backend.deployments import DeploymentStore
from backend.models import DeploymentRecord, DeploymentSpec


def record(**kwargs):
    base = dict(
        spec=DeploymentSpec(image="nginx:latest"),
        status="running",
        placed_on="nuc-1",
        agent_container_id="abc123",
    )
    base.update(kwargs)
    return DeploymentRecord(**base)


def test_persists_and_reloads(tmp_path):
    path = tmp_path / "d.json"
    store = DeploymentStore(path)
    rec = store.add(record())

    reloaded = DeploymentStore(path)
    assert [r.id for r in reloaded.all()] == [rec.id]
    assert reloaded.get(rec.id).spec.image == "nginx:latest"


def test_reconcile_marks_running_failed_offline(tmp_path):
    store = DeploymentStore(tmp_path / "d.json")
    running = store.add(record())
    vanished = store.add(record(agent_container_id="gone999"))
    on_dead_host = store.add(record(placed_on="nuc-2", agent_container_id="x1"))

    live = {
        "nuc-1": [{"id": "abc123def", "status": "running"}],
        "nuc-2": [],
    }
    store.reconcile(live, offline_hosts={"nuc-2"})

    assert store.get(running.id).status == "running"
    assert store.get(vanished.id).status == "failed"
    assert store.get(on_dead_host.id).status == "node_offline"


def test_reconcile_leaves_placing_alone(tmp_path):
    store = DeploymentStore(tmp_path / "d.json")
    placing = store.add(record(status="placing", agent_container_id=None))
    store.reconcile({"nuc-1": []}, offline_hosts=set())
    assert store.get(placing.id).status == "placing"


def test_reconcile_recovers_from_failed_when_container_returns(tmp_path):
    store = DeploymentStore(tmp_path / "d.json")
    rec = store.add(record(status="failed"))
    store.reconcile(
        {"nuc-1": [{"id": "abc123", "status": "running"}]}, offline_hosts=set()
    )
    assert store.get(rec.id).status == "running"


def test_reconcile_marks_unhealthy_container_failed(tmp_path):
    store = DeploymentStore(tmp_path / "d.json")
    rec = store.add(record())
    store.reconcile(
        {"nuc-1": [{"id": "abc123", "status": "running", "health": "unhealthy"}]},
        offline_hosts=set(),
    )
    got = store.get(rec.id)
    assert got.status == "failed"
    assert "healthcheck" in got.events[-1].detail

    # Healthcheck recovers -> back to running.
    store.reconcile(
        {"nuc-1": [{"id": "abc123", "status": "running", "health": "healthy"}]},
        offline_hosts=set(),
    )
    got = store.get(rec.id)
    assert got.status == "running"
    assert got.events[-1].kind == "recovered"


def test_reconcile_grace_window_for_just_deployed(tmp_path):
    import time as _t

    store = DeploymentStore(tmp_path / "d.json")
    # Just deployed, container not in the snapshot yet.
    fresh = store.add(record(deployed_at=_t.time()))
    store.reconcile({"nuc-1": []}, offline_hosts=set())
    assert store.get(fresh.id).status == "running"

    # Past the grace window -> failed.
    store.update(fresh.id, deployed_at=_t.time() - 999)
    store.reconcile({"nuc-1": []}, offline_hosts=set())
    assert store.get(fresh.id).status == "failed"


def test_grace_does_not_apply_to_present_but_broken(tmp_path):
    import time as _t

    store = DeploymentStore(tmp_path / "d.json")
    fresh = store.add(record(deployed_at=_t.time()))
    # Present but exited — a real failure, no grace.
    store.reconcile(
        {"nuc-1": [{"id": "abc123", "status": "exited"}]}, offline_hosts=set()
    )
    assert store.get(fresh.id).status == "failed"


def test_reconcile_stack_unhealthy_member_fails(tmp_path):
    store = DeploymentStore(tmp_path / "d.json")
    rec = store.add(record(kind="stack", agent_container_id="webproj"))
    store.reconcile(
        {
            "nuc-1": [
                {"name": "webproj-a-1", "status": "running", "compose_project": "webproj"},
                {
                    "name": "webproj-b-1",
                    "status": "running",
                    "health": "unhealthy",
                    "compose_project": "webproj",
                },
            ]
        },
        offline_hosts=set(),
    )
    got = store.get(rec.id)
    assert got.status == "failed"
    assert "webproj-b-1" in got.events[-1].detail
