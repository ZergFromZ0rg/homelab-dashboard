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
            "volumes": [{"name": "jellyfin_config", "allowed": True,
                         "bytes": 184_320_000, "files": 2_411, "partial": False}],
            "directories": [
                {"path": "/home/zerg/homelab/jellyfin/cache", "allowed": False,
                 "bytes": 4_000_000, "files": 12, "partial": False},
                {"path": "/home/zerg/homelab/jellyfin/empty", "allowed": True,
                 "bytes": 0, "files": 0, "partial": False},
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

    assert body["unprotected_count"] == 5
    assert body["unprotected_bytes"] == (
        730_508_267 + 1_891_612_940 + 4_000_000 + 184_320_000
    )
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

    assert body["unprotected_count"] == 5


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


# ---- backing up whole projects --------------------------------------------


def ask(client, **over):
    body = {
        "host": "bigboy", "projects": ["ai-librarian", "jellyfin"],
        "dest_host": "thinkpad", "directory": "/backups/bigboy",
        **over,
    }
    return client.post("/api/backups/from-projects", json=body)


def test_selecting_a_project_creates_a_job_per_piece_of_its_data(client, jobs):
    """People think in stacks — "back up jellyfin" — not in bind mounts."""
    out = ask(client).json()

    sources = sorted(c["source"] for c in out["created"])
    assert sources == [
        "/home/zerg/ai-librarian/data/models",
        "/home/zerg/ai-librarian/data/qdrant",
        "jellyfin_config",
    ]
    assert len(jobs.all()) == 3


def test_a_directory_the_host_does_not_allow_is_refused_with_the_fix(client, jobs):
    """jellyfin's cache is outside BACKUP_SOURCE_DIRS. Creating a job that
    can only fail would be worse than saying so."""
    out = ask(client).json()

    refused = {r["name"]: r["why"] for r in out["refused"]}
    assert "/home/zerg/homelab/jellyfin/cache" in refused
    assert "Settings" in refused["/home/zerg/homelab/jellyfin/cache"]


def test_applying_the_same_selection_twice_adds_nothing(client, jobs):
    """Select everything and apply is the sane gesture; it must not
    produce a second copy of every job."""
    first = ask(client).json()
    second = ask(client).json()

    assert len(first["created"]) == 3
    assert second["created"] == []
    assert len(second["already_covered"]) == 3
    assert len(jobs.all()) == 3


def test_a_piece_already_covered_by_a_parent_job_is_not_duplicated(client, jobs):
    jobs.add(a_path_job(path="/home/zerg/ai-librarian"))

    out = ask(client).json()

    assert "/home/zerg/ai-librarian/data/qdrant" in out["already_covered"]
    assert not any("qdrant" in c["source"] for c in out["created"])


def test_an_unselected_project_is_left_alone(client, jobs):
    out = ask(client, projects=["jellyfin"]).json()

    assert [c["source"] for c in out["created"]] == ["jellyfin_config"]


def test_the_destination_is_required(client):
    assert ask(client, dest_host="").status_code == 400
    assert ask(client, directory="").status_code == 400


def test_projects_must_be_a_list(client):
    assert ask(client, projects="all of them").status_code == 400


def test_creating_from_projects_is_token_gated(client, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "sekret")
    assert ask(client).status_code == 401


# ---- deciding not to back something up ------------------------------------


@pytest.fixture
def ignores(tmp_path, monkeypatch):
    from backend import backup_ignores

    store = backup_ignores.IgnoreStore(tmp_path / "ignores.json")
    monkeypatch.setattr(backup_ignores, "store", store)
    return store


def test_an_ignored_stack_stops_counting_as_a_gap(client, ignores):
    """Otherwise the panel reports the same answer forever, alongside the
    gaps that are real, and stops being read."""
    before = client.get("/api/hosts/bigboy/recovery").json()
    assert before["unprotected_count"] == 5

    client.put("/api/hosts/bigboy/recovery/ignore",
               json={"projects": ["jellyfin"], "reason": "media is re-acquirable"})

    after = client.get("/api/hosts/bigboy/recovery").json()

    assert after["unprotected_count"] == 2, "only ai-librarian's two remain"
    assert after["ignored_count"] == 1


def test_an_ignored_stack_is_still_shown_with_its_reason(client, ignores):
    """Hiding it would just move the surprise."""
    client.put("/api/hosts/bigboy/recovery/ignore",
               json={"projects": ["jellyfin"], "reason": "media is re-acquirable"})

    body = client.get("/api/hosts/bigboy/recovery").json()
    jellyfin = next(p for p in body["projects"] if p["project"] == "jellyfin")

    assert jellyfin["ignored"]["reason"] == "media is re-acquirable"
    assert jellyfin["items"], "its data is still listed"


def test_ignoring_does_not_change_its_bytes_out_of_existence(client, ignores):
    """The data is still there and still unprotected; what changed is that
    somebody decided about it."""
    client.put("/api/hosts/bigboy/recovery/ignore", json={"projects": ["jellyfin"]})

    body = client.get("/api/hosts/bigboy/recovery").json()

    assert body["unprotected_bytes"] == 730_508_267 + 1_891_612_940
    jellyfin = next(p for p in body["projects"] if p["project"] == "jellyfin")
    assert any(i["bytes"] for i in jellyfin["items"])


def test_a_decision_can_be_taken_back(client, ignores):
    client.put("/api/hosts/bigboy/recovery/ignore", json={"projects": ["jellyfin"]})

    resp = client.delete("/api/hosts/bigboy/recovery/ignore/jellyfin")

    assert resp.status_code == 200
    assert client.get("/api/hosts/bigboy/recovery").json()["unprotected_count"] == 5


def test_unignoring_something_that_was_not_ignored_is_a_404(client, ignores):
    assert client.delete(
        "/api/hosts/bigboy/recovery/ignore/jellyfin"
    ).status_code == 404


def test_decisions_are_per_host(client, ignores):
    """Two hosts can run the same stack and disagree about whether its data
    matters."""
    ignores.add("thinkpad", "jellyfin", "not the one I care about")

    body = client.get("/api/hosts/bigboy/recovery").json()

    assert body["ignored_count"] == 0, "thinkpad's decision is not bigboy's"


def test_decisions_survive_a_restart(tmp_path):
    from backend import backup_ignores

    path = tmp_path / "ignores.json"
    backup_ignores.IgnoreStore(path).add("bigboy", "grafana", "replaced by this")

    (row,) = backup_ignores.IgnoreStore(path).all()

    assert row["project"] == "grafana"
    assert row["reason"] == "replaced by this"


def test_ignoring_is_token_gated(client, ignores, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "sekret")

    assert client.put("/api/hosts/bigboy/recovery/ignore",
                      json={"projects": ["x"]}).status_code == 401
    assert client.delete(
        "/api/hosts/bigboy/recovery/ignore/x"
    ).status_code == 401
