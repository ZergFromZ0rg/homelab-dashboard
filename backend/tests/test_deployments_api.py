"""End-to-end-ish tests for the deployment routes with the fleet and the
agent HTTP calls stubbed out."""

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.deployments import DeploymentStore

GB = 1024**3


def fleet():
    machines = {
        "nuc-1": {
            "online": True,
            "cpu": 10.0,
            "cpu_cores": 8,
            "ram": 20.0,
            "ram_total_bytes": 32 * GB,
            "temperature": 45.0,
            "filesystems": [{"mountpoint": "/", "free_bytes": 200 * GB}],
            "gpu": None,
        },
        "nuc-2": {
            "online": True,
            "cpu": 80.0,
            "cpu_cores": 4,
            "ram": 85.0,
            "ram_total_bytes": 16 * GB,
            "temperature": 55.0,
            "filesystems": [{"mountpoint": "/", "free_bytes": 50 * GB}],
            "gpu": None,
        },
    }
    nodes = {
        "nuc-1": {"url": "http://nuc-1:9000"},
        "nuc-2": {"url": "http://nuc-2:9000"},
    }
    return nodes, machines, {"nuc-1": [], "nuc-2": []}, set(), set()


@pytest.fixture
def client(tmp_path, monkeypatch):
    store = DeploymentStore(tmp_path / "deployments.json")
    monkeypatch.setattr(main, "deployments", store)
    monkeypatch.setattr(main, "_build_fleet", fleet)
    monkeypatch.setattr(main.registry, "all", lambda: fleet()[0])
    monkeypatch.setattr(main.llm, "parse_constraints", lambda *a, **k: (None, []))
    monkeypatch.setattr(main.llm, "explain_placement", lambda *a, **k: None)
    return TestClient(main.app)


def test_dry_run_ranks_without_deploying(client):
    resp = client.post(
        "/api/deployments?dry_run=1",
        json={"image": "nginx:latest"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["recommended"] == "nuc-1"
    assert [r["node"] for r in body["ranked"]] == ["nuc-1", "nuc-2"]
    assert client.get("/api/deployments").json() == []


def test_real_deploy_calls_agent_and_persists(client, monkeypatch):
    calls = {}

    def fake_deploy(nodes, host, payload):
        calls["host"] = host
        calls["payload"] = payload
        return {"success": True, "id": "abc123def456"}

    monkeypatch.setattr(main, "deploy_container", fake_deploy)

    resp = client.post("/api/deployments", json={"image": "nginx:latest"})
    assert resp.status_code == 200
    record = resp.json()
    assert record["status"] == "running"
    assert record["placed_on"] == "nuc-1"
    assert record["agent_container_id"] == "abc123def456"
    assert calls["host"] == "nuc-1"
    assert calls["payload"]["image"] == "nginx:latest"
    assert calls["payload"]["labels"] == {"deployed-by": "homelab-dashboard"}

    listed = client.get("/api/deployments").json()
    assert len(listed) == 1 and listed[0]["id"] == record["id"]


def test_agent_rejection_marks_failed(client, monkeypatch):
    monkeypatch.setattr(
        main,
        "deploy_container",
        lambda *a, **k: {"success": False, "error": "pull failed", "stage": "pull"},
    )
    resp = client.post("/api/deployments", json={"image": "nope:latest"})
    record = resp.json()
    assert record["status"] == "failed"
    assert record["error"] == "pull failed"


def test_manual_override_to_ineligible_node_rejected(client):
    resp = client.post(
        "/api/deployments?node=nuc-2",
        json={
            "image": "nginx:latest",
            "resources": {"memory_mb": 8192},
        },
    )
    assert resp.status_code == 409


def test_no_eligible_node_returns_409(client):
    resp = client.post(
        "/api/deployments",
        json={"image": "nginx:latest", "constraints": {"require_gpu": True}},
    )
    assert resp.status_code == 409


def test_delete_removes_record_and_container(client, monkeypatch):
    monkeypatch.setattr(
        main, "deploy_container", lambda *a, **k: {"success": True, "id": "c1"}
    )
    removed = {}
    monkeypatch.setattr(
        main,
        "remove_container",
        lambda nodes, host, cid: removed.update(host=host, cid=cid) or {"success": True},
    )

    record = client.post("/api/deployments", json={"image": "nginx:latest"}).json()
    resp = client.request(
        "DELETE", f"/api/deployments/{record['id']}"
    )
    assert resp.status_code == 200
    assert resp.json()["removed_container"] is True
    assert removed == {"host": "nuc-1", "cid": "c1"}
    assert client.get("/api/deployments").json() == []


def test_token_enforced_when_set(client, monkeypatch):
    monkeypatch.setattr(main, "REGISTER_TOKEN", "s3cret")
    resp = client.post("/api/deployments?dry_run=1", json={"image": "nginx"})
    assert resp.status_code == 401
    resp = client.post(
        "/api/deployments?dry_run=1",
        json={"image": "nginx"},
        headers={"X-Register-Token": "s3cret"},
    )
    assert resp.status_code == 200
