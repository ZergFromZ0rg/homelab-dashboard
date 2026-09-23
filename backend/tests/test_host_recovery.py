"""What you would have if a machine died tonight.

The interesting case is the host nobody has configured. It must report
every project as unprotected rather than reporting nothing — "no backup
jobs" and "nothing worth backing up" look identical in a naive
implementation and mean opposite things.
"""

import pytest
from fastapi.testclient import TestClient

from backend import auth, main, volume_backup_api
from backend import volume_backups as vb
from backend.volume_backups import BackupJobStore

from backend.tests.test_volume_backups import NODES, a_job, a_path_job, stub_calls

AGENT = {
    "host": "bigboy",
    "source_dirs": ["/home/zerg/ai-librarian"],
    "projects": [
        {
            "project": "ai-librarian",
            "working_dir": "/home/zerg/ai-librarian",
            "containers": ["ai-librarian-qdrant-1"],
            "volumes": [],
            "directories": [
                {"path": "/home/zerg/ai-librarian/data/qdrant", "allowed": True,
                 "bytes": 730_508_267, "files": 145, "partial": False},
                {"path": "/home/zerg/ai-librarian/data/models", "allowed": True,
                 "bytes": 1_891_612_940, "files": 134, "partial": False},
            ],
        },
        {
            "project": "jellyfin",
            "working_dir": "/home/zerg/homelab/jellyfin",
            "containers": ["jellyfin"],
            "volumes": [{"name": "jellyfin_config", "allowed": True}],
            "directories": [
                {"path": "/home/zerg/homelab/jellyfin/cache", "allowed": False,
                 "bytes": 4_000_000, "files": 12, "partial": False},
            ],
        },
    ],
}


@pytest.fixture
def jobs(tmp_path, monkeypatch):
    store = BackupJobStore(tmp_path / "volume_backups.json")
    monkeypatch.setattr(vb, "store", store)
    monkeypatch.setattr(volume_backup_api, "store", store)
    monkeypatch.setattr(main.registry, "all", lambda: NODES)
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(volume_backup_api, "_config_backup",
                        lambda nodes, host: {"state": "ok"})
    return store


@pytest.fixture
def client(jobs, monkeypatch):
    stub_calls(monkeypatch, {"/backup/projects": AGENT})
    return TestClient(main.app)


def test_a_host_with_no_jobs_reports_everything_as_unprotected(client):
    body = client.get("/api/hosts/bigboy/recovery").json()

    assert body["unprotected_count"] == 4
    assert body["unprotected_bytes"] == 730_508_267 + 1_891_612_940 + 4_000_000
    assert all(p["protected"] is False for p in body["projects"])


def test_a_directory_job_protects_everything_beneath_it(client, jobs):
    """One job on the parent is how four directories get covered — the
    coverage test has to understand that or it reports false gaps."""
    jobs.add(a_path_job(path="/home/zerg/ai-librarian"))

    body = client.get("/api/hosts/bigboy/recovery").json()
    librarian = next(p for p in body["projects"] if p["project"] == "ai-librarian")

    assert librarian["protected"] is True
    assert all(i["protected_by"]["job"] for i in librarian["items"])


def test_a_sibling_directory_is_not_covered(client, jobs):
    """/data/qdrant must not be read as covering /data/qdrant2."""
    jobs.add(a_path_job(path="/home/zerg/ai-librarian/data/qdrant"))

    body = client.get("/api/hosts/bigboy/recovery").json()
    items = {i["name"]: i for p in body["projects"] for i in p["items"]}

    assert items["/home/zerg/ai-librarian/data/qdrant"]["protected_by"]
    assert not items["/home/zerg/ai-librarian/data/models"]["protected_by"]


def test_a_volume_is_matched_exactly(client, jobs):
    jobs.add(a_job(volume="jellyfin_config", source_host="bigboy"))

    body = client.get("/api/hosts/bigboy/recovery").json()
    items = {i["name"]: i for p in body["projects"] for i in p["items"]}

    assert items["jellyfin_config"]["protected_by"]["job"]


def test_a_job_from_another_host_does_not_count(client, jobs):
    """Backing up thinkpad's /home/zerg/ai-librarian protects thinkpad, not
    bigboy, however similar the paths look."""
    jobs.add(a_path_job(path="/home/zerg/ai-librarian", source_host="thinkpad"))

    body = client.get("/api/hosts/bigboy/recovery").json()

    assert body["unprotected_count"] == 4


def test_the_protection_carries_the_jobs_health(client, jobs):
    """"Protected by a job that has never worked" is not protected, and the
    view has to say which."""
    job = jobs.add(a_path_job(path="/home/zerg/ai-librarian"))
    jobs.record(job["id"], last_run_at=1, last_error="no space left")

    body = client.get("/api/hosts/bigboy/recovery").json()
    item = body["projects"][0]["items"][0]

    assert item["protected_by"]["state"] == "failing"


def test_directories_nobody_allowed_are_still_reported(client):
    """jellyfin's cache is outside BACKUP_SOURCE_DIRS. Hiding it would mean
    the gap analysis only ever lists gaps somebody already half-closed."""
    body = client.get("/api/hosts/bigboy/recovery").json()
    items = {i["name"]: i for p in body["projects"] for i in p["items"]}

    assert items["/home/zerg/homelab/jellyfin/cache"]["allowed"] is False


def test_the_config_backup_is_reported_separately(client):
    """Compose files and data are different things with different answers,
    and one "backup: ok" hides that."""
    body = client.get("/api/hosts/bigboy/recovery").json()

    assert body["config_backup"]["state"] == "ok"


def test_recovery_is_token_gated(client, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "sekret")

    assert client.get("/api/hosts/bigboy/recovery").status_code == 401
