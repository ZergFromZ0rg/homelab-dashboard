"""The /api/backups routes."""

import pytest
from fastapi.testclient import TestClient

from backend import auth, main, volume_backup_api
from backend import volume_backups as vb
from backend.volume_backups import BackupError, BackupJobStore

from backend.tests.test_volume_backups import NODES, a_job, stub_calls


@pytest.fixture
def jobs(tmp_path, monkeypatch):
    store = BackupJobStore(tmp_path / "volume_backups.json")
    monkeypatch.setattr(vb, "store", store)
    monkeypatch.setattr(volume_backup_api, "store", store)
    monkeypatch.setattr(main.registry, "all", lambda: NODES)
    monkeypatch.setattr(volume_backup_api, "default_dest_host", lambda: "thinkpad")
    return store


@pytest.fixture
def client(jobs):
    return TestClient(main.app)


def test_listing_is_empty_to_start_with(client):
    body = client.get("/api/backups").json()

    assert body["backups"] == []
    assert body["default_dest_host"] == "thinkpad"


def test_creating_a_job(client, jobs):
    resp = client.post("/api/backups", json=a_job())

    assert resp.status_code == 201
    assert resp.json()["volume"] == "ai-librarian_qdrant"
    assert len(jobs.all()) == 1


def test_creating_without_a_volume_is_a_400(client):
    assert client.post("/api/backups", json={"source_host": "bigboy"}).status_code == 400


def test_creating_the_same_job_twice_is_a_409(client):
    client.post("/api/backups", json=a_job())

    assert client.post("/api/backups", json=a_job()).status_code == 409


def test_the_destination_defaults_without_being_asked(client):
    job = client.post(
        "/api/backups", json={"source_host": "bigboy", "volume": "qdrant"}
    ).json()

    assert job["dest_host"] == "thinkpad"


def test_updating_a_job(client):
    job = client.post("/api/backups", json=a_job()).json()

    updated = client.put(f"/api/backups/{job['id']}", json={"keep": 14}).json()

    assert updated["keep"] == 14


def test_updating_an_unknown_job_is_a_404(client):
    assert client.put("/api/backups/nope", json={"keep": 1}).status_code == 404


def test_deleting_a_job_leaves_its_archives(client, jobs, monkeypatch):
    """Forgetting a schedule must never delete data."""
    job = client.post("/api/backups", json=a_job()).json()
    seen = stub_calls(monkeypatch, {})

    assert client.delete(f"/api/backups/{job['id']}").status_code == 200
    assert jobs.all() == []
    assert not [c for c in seen if "delete" in c[1]]


def test_deleting_an_unknown_job_is_a_404(client):
    assert client.delete("/api/backups/nope").status_code == 404


def test_running_a_job_now_returns_immediately(client, monkeypatch):
    job = client.post("/api/backups", json=a_job()).json()
    started = []
    monkeypatch.setattr(vb, "run_job", lambda nodes, j: started.append(j["id"]))

    resp = client.post(f"/api/backups/{job['id']}/run")

    assert resp.status_code == 200
    assert resp.json()["started"] is True


def test_running_one_that_is_already_running_is_a_409(client, jobs):
    job = client.post("/api/backups", json=a_job()).json()
    jobs.mark_running(job["id"], True)

    assert client.post(f"/api/backups/{job['id']}/run").status_code == 409


def test_listing_archives_shows_only_this_jobs_and_how_to_restore(client, monkeypatch):
    job = client.post("/api/backups", json=a_job()).json()
    stub_calls(monkeypatch, {"/backup/archives": {"archives": [
        {"name": "ai-librarian_qdrant-20260921-010203.tar.gz", "bytes": 5,
         "modified_at": 3},
        {"name": "jellyfin_config-20260921-010203.tar.gz", "bytes": 5,
         "modified_at": 2},
    ]}})

    body = client.get(f"/api/backups/{job['id']}/archives").json()

    assert [a["name"] for a in body["archives"]] == [
        "ai-librarian_qdrant-20260921-010203.tar.gz"
    ]
    # The single hint became ordered steps, because a restore crosses two
    # hosts and the copy between them was the step it skipped.
    assert body["restore"][0]["where"] == "thinkpad"
    assert "scp" in body["restore"][0]["command"]
    assert any("tar xzf" in s["command"] for s in body["restore"])


def test_deleting_an_archive_another_job_wrote_is_refused(client, monkeypatch):
    job = client.post("/api/backups", json=a_job()).json()
    stub_calls(monkeypatch, {})

    resp = client.post(
        f"/api/backups/{job['id']}/archives/delete",
        json={"names": ["jellyfin_config-20260921-010203.tar.gz"]},
    )

    assert resp.status_code == 400
    assert "not written by this job" in resp.json()["detail"]


def test_deleting_an_archive_this_job_wrote(client, monkeypatch):
    job = client.post("/api/backups", json=a_job()).json()
    name = "ai-librarian_qdrant-20260921-010203.tar.gz"
    stub_calls(monkeypatch, {"/backup/archives/delete": {"deleted": [name]}})

    resp = client.post(
        f"/api/backups/{job['id']}/archives/delete", json={"names": [name]}
    )

    assert resp.status_code == 200
    assert resp.json()["deleted"] == [name]


def test_targets_pass_the_agents_reason_through(client, monkeypatch):
    """A host that can't store backups answers with the compose line that
    would fix it. Rewording that here would lose the fix."""
    stub_calls(monkeypatch, {"/backup/volumes": {
        "volumes": [], "store": {"enabled": False, "roots": [
            {"path": "/backups", "usable": False,
             "problem": "/backups is not a writable bind mount in this agent"},
        ]},
    }})

    body = client.get("/api/backups/targets/bigboy").json()

    assert "not a writable bind mount" in body["store"]["roots"][0]["problem"]


def test_every_mutating_route_is_token_gated(client, jobs, monkeypatch):
    """A backup job says 'read this volume, write it over there'. That is
    the rebuild route's class of privilege, not the container controls'."""
    job = jobs.add(a_job())
    monkeypatch.setattr(auth, "API_TOKEN", "sekret")
    stub_calls(monkeypatch, {})

    calls = [
        ("post", "/api/backups", {"json": a_job(volume="other")}),
        ("put", f"/api/backups/{job['id']}", {"json": {"keep": 2}}),
        ("delete", f"/api/backups/{job['id']}", {}),
        ("post", f"/api/backups/{job['id']}/run", {}),
        ("get", "/api/backups/targets/bigboy", {}),
        ("get", f"/api/backups/{job['id']}/archives", {}),
    ]

    for method, path, kwargs in calls:
        assert getattr(client, method)(path, **kwargs).status_code == 401, path


def test_reading_the_job_list_stays_open(client, monkeypatch):
    """It contacts no agent and reveals no more than the Servers tab does,
    and a locked-out list would make the tab look broken."""
    monkeypatch.setattr(auth, "API_TOKEN", "sekret")

    assert client.get("/api/backups").status_code == 200
