"""The /api/stacks route with the fleet and agent HTTP stubbed."""

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend import scheduler_api as sched
from backend.deployments import DeploymentStore

GB = 1024**3

COMPOSE = """
services:
  web:
    image: nginx:1.27
    ports:
      - "8090:80"
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
  cache:
    image: redis:7
    mem_limit: 128m
"""


def fleet():
    machines = {
        "big": {
            "online": True, "cpu": 10.0, "cpu_cores": 8,
            "ram": 20.0, "ram_total_bytes": 32 * GB, "temperature": 40.0,
            "filesystems": [{"mountpoint": "/", "free_bytes": 300 * GB}], "gpu": None,
        },
        "small": {
            "online": True, "cpu": 15.0, "cpu_cores": 2,
            "ram": 88.0, "ram_total_bytes": 4 * GB, "temperature": 50.0,
            "filesystems": [{"mountpoint": "/", "free_bytes": 40 * GB}], "gpu": None,
        },
    }
    nodes = {"big": {"url": "http://big:9000"}, "small": {"url": "http://small:9000"}}
    return nodes, machines, {"big": [], "small": []}, set(), set()


@pytest.fixture
def client(tmp_path, monkeypatch):
    store = DeploymentStore(tmp_path / "d.json")
    monkeypatch.setattr(sched, "deployments", store)
    monkeypatch.setattr(sched, "_build_fleet", fleet)
    monkeypatch.setattr(sched.registry, "all", lambda: fleet()[0])
    monkeypatch.setattr(sched.llm, "parse_constraints", lambda *a, **k: (None, []))
    monkeypatch.setattr(sched.llm, "explain_placement", lambda *a, **k: None)
    return TestClient(main.app)


def test_dry_run_sums_resources_and_lists_services(client):
    resp = client.post(
        "/api/stacks?dry_run=1",
        json={"name": "web-stack", "compose_yaml": COMPOSE},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recommended"] == "big"
    assert body["spec"]["resources"]["memory_mb"] == 256 + 128
    assert body["spec"]["pinned"] is True
    names = {s["name"] for s in body["stack_services"]}
    assert names == {"web", "cache"}


def test_real_deploy_calls_agent_stack(client, monkeypatch):
    seen = {}

    def fake_deploy_stack(nodes, host, payload):
        seen.update(host=host, payload=payload)
        return {"success": True, "project": payload["name"],
                "services": [{"name": "web-stack-web-1", "id": "abc", "status": "running"}]}

    monkeypatch.setattr(sched, "deploy_stack", fake_deploy_stack)

    resp = client.post("/api/stacks", json={"name": "web-stack", "compose_yaml": COMPOSE})
    record = resp.json()
    assert record["kind"] == "stack"
    assert record["status"] == "running"
    assert record["placed_on"] == "big"
    assert record["agent_container_id"] == "web-stack"
    assert seen["host"] == "big"
    assert seen["payload"]["compose_yaml"] == COMPOSE


def test_invalid_compose_yaml_400(client):
    resp = client.post(
        "/api/stacks", json={"name": "bad", "compose_yaml": "services: [not, a, map]"}
    )
    assert resp.status_code == 400


def test_bad_stack_name_422(client):
    resp = client.post(
        "/api/stacks", json={"name": "Bad Name!", "compose_yaml": COMPOSE}
    )
    assert resp.status_code == 422


def test_stack_reconciles_by_compose_project(client, monkeypatch):
    monkeypatch.setattr(
        sched, "deploy_stack",
        lambda *a, **k: {"success": True, "project": "web-stack", "services": []},
    )
    record = client.post(
        "/api/stacks", json={"name": "web-stack", "compose_yaml": COMPOSE}
    ).json()

    # Within the post-deploy grace window, an empty snapshot is tolerated.
    sched.deployments.reconcile({"big": []}, set())
    assert sched.deployments.get(record["id"]).status == "running"

    # Past it -> failed.
    sched.deployments.update(record["id"], deployed_at=0)
    sched.deployments.reconcile({"big": []}, set())
    assert sched.deployments.get(record["id"]).status == "failed"

    # A running member under the project label -> running.
    sched.deployments.reconcile(
        {"big": [{"id": "c1", "status": "running", "compose_project": "web-stack"}]},
        set(),
    )
    assert sched.deployments.get(record["id"]).status == "running"


def test_delete_stack_calls_remove_stack(client, monkeypatch):
    monkeypatch.setattr(
        sched, "deploy_stack",
        lambda *a, **k: {"success": True, "project": "web-stack", "services": []},
    )
    calls = {}
    monkeypatch.setattr(
        sched, "remove_stack",
        lambda nodes, host, project, volumes=False: calls.update(
            host=host, project=project, volumes=volumes
        ) or {"success": True},
    )
    record = client.post(
        "/api/stacks", json={"name": "web-stack", "compose_yaml": COMPOSE}
    ).json()

    resp = client.request(
        "DELETE", f"/api/deployments/{record['id']}?volumes=1"
    )
    assert resp.status_code == 200
    assert calls == {"host": "big", "project": "web-stack", "volumes": True}
