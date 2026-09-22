"""Scheduled volume backups: the store, the schedule and the pruning.

No agent is contacted — ``_call`` is the seam, because everything the
dashboard does here is one of four HTTP calls to an agent that is tested
in its own repo.
"""

import time

import pytest

from backend import volume_backups as vb
from backend.volume_backups import BackupError, BackupJobStore


@pytest.fixture
def jobs(tmp_path):
    return BackupJobStore(tmp_path / "volume_backups.json")


def a_job(**overrides):
    return {
        "name": "qdrant",
        "source_host": "bigboy",
        "volume": "ai-librarian_qdrant",
        "dest_host": "thinkpad",
        "directory": "/backups/bigboy",
        "interval_hours": 24,
        "keep": 3,
        **overrides,
    }


# ---- the store ------------------------------------------------------------


def test_a_job_needs_a_volume_and_a_source(jobs):
    with pytest.raises(BackupError):
        jobs.add({"name": "nameless"})


def test_the_destination_defaults_to_the_dashboards_host(jobs):
    """Where you want a backup is somewhere other than the box you are
    backing up, and the dashboard's host is the one you will still be
    looking at."""
    job = jobs.add(
        {"source_host": "bigboy", "volume": "qdrant"}, default_dest="thinkpad"
    )

    assert job["dest_host"] == "thinkpad"


def test_without_a_default_it_backs_up_to_its_own_host(jobs):
    job = jobs.add({"source_host": "bigboy", "volume": "qdrant"})
    assert job["dest_host"] == "bigboy"


def test_interval_and_keep_are_clamped(jobs):
    job = jobs.add(a_job(interval_hours=0.001, keep=99999))

    assert job["interval_hours"] == 1.0
    assert job["keep"] == 500


def test_the_same_volume_to_the_same_place_twice_is_refused(jobs):
    jobs.add(a_job())

    with pytest.raises(BackupError) as caught:
        jobs.add(a_job())

    assert caught.value.status_code == 409


def test_the_same_volume_to_a_different_directory_is_fine(jobs):
    jobs.add(a_job())
    jobs.add(a_job(directory="/backups/offsite"))

    assert len(jobs.all()) == 2


def test_jobs_survive_a_restart(tmp_path):
    path = tmp_path / "volume_backups.json"
    BackupJobStore(path).add(a_job())

    (reloaded,) = BackupJobStore(path).all()

    assert reloaded["volume"] == "ai-librarian_qdrant"
    assert reloaded["keep"] == 3


def test_an_unreadable_job_is_dropped_not_fatal(tmp_path):
    """One corrupt row should not stop every other backup on the box."""
    path = tmp_path / "volume_backups.json"
    path.write_text('[{"volume": "ok", "source_host": "bigboy"}, {"name": "junk"}]')

    assert [j["volume"] for j in BackupJobStore(path).all()] == ["ok"]


def test_editing_a_job_keeps_its_history(jobs):
    job = jobs.add(a_job())
    jobs.record(job["id"], last_success_at=1790000000.0, last_error=None)

    updated = jobs.update(job["id"], {"keep": 10})

    assert updated["keep"] == 10
    assert updated["last_success_at"] == 1790000000.0


def test_editing_an_unknown_job_is_a_404(jobs):
    with pytest.raises(BackupError) as caught:
        jobs.update("nope", {"keep": 1})

    assert caught.value.status_code == 404


# ---- the schedule ---------------------------------------------------------


def test_a_job_that_has_never_run_is_due(jobs):
    assert vb.due(jobs.add(a_job())) is True


def test_a_disabled_job_is_never_due(jobs):
    assert vb.due(jobs.add(a_job(enabled=False))) is False


def test_a_running_job_is_not_due_again(jobs):
    job = jobs.add(a_job())
    jobs.mark_running(job["id"], True)

    assert vb.due(jobs.all()[0]) is False


def test_due_is_measured_from_the_last_attempt_not_the_last_success(jobs):
    """A job failing every time must not retry in a tight loop against a
    host that is plainly unwell."""
    job = jobs.add(a_job(interval_hours=24))
    now = time.time()
    jobs.record(job["id"], last_run_at=now - 60, last_success_at=now - 99999)

    assert vb.due(jobs.all()[0], now) is False


def test_a_job_past_its_interval_is_due(jobs):
    job = jobs.add(a_job(interval_hours=1))
    now = time.time()
    jobs.record(job["id"], last_run_at=now - 3601)

    assert vb.due(jobs.all()[0], now) is True


# ---- naming and ownership -------------------------------------------------


def test_prefix_matches_the_agents_naming():
    """The agent names archives ``<sanitised volume>-<stamp>.tar.gz`` and
    retention matches on that prefix. If the two ever disagree, pruning
    silently stops finding anything and backups pile up forever."""
    assert vb.archive_prefix("ai-librarian_qdrant") == "ai-librarian_qdrant"
    assert vb.archive_prefix("a/b") == "a-b"
    assert vb.owns("ai-librarian_qdrant-20260921-010203.tar.gz", "ai-librarian_qdrant")


def test_a_similar_volume_name_does_not_own_the_archive():
    assert not vb.owns("qdrant-20260921-010203.tar.gz", "qdrant-two")
    assert not vb.owns("qdrant-two-20260921-010203.tar.gz", "qdrant")


def test_something_a_person_put_there_is_not_ours():
    assert not vb.owns("notes.txt", "qdrant")
    assert not vb.owns("qdrant-backup.tar.gz", "qdrant")


# ---- pruning --------------------------------------------------------------


def archive(name, at):
    return {"name": name, "bytes": 10, "modified_at": at}


def stub_calls(monkeypatch, responses):
    """Replace the one HTTP seam. Returns the calls made."""
    seen = []

    def fake_call(method, url, **kwargs):
        seen.append((method, url, kwargs))

        for match, body in responses.items():
            if match in url:
                if isinstance(body, Exception):
                    raise body
                return body

        return {}

    monkeypatch.setattr(vb, "_call", fake_call)
    return seen


NODES = {"bigboy": {"url": "http://bigboy:8123"},
         "thinkpad": {"url": "http://thinkpad:8123"}}


def test_pruning_keeps_the_newest_and_deletes_the_rest(monkeypatch, jobs):
    job = jobs.add(a_job(keep=2))
    seen = stub_calls(monkeypatch, {
        "/backup/archives?": {},
        "/backup/archives": {"archives": [
            archive("ai-librarian_qdrant-20260101-000000.tar.gz", 1),
            archive("ai-librarian_qdrant-20260303-000000.tar.gz", 3),
            archive("ai-librarian_qdrant-20260202-000000.tar.gz", 2),
        ]},
        "/backup/archives/delete": {"deleted": [
            "ai-librarian_qdrant-20260101-000000.tar.gz"
        ]},
    })

    deleted = vb.prune(NODES, job)

    assert deleted == ["ai-librarian_qdrant-20260101-000000.tar.gz"]
    sent = [c for c in seen if "delete" in c[1]][0][2]["json"]
    assert sent["names"] == ["ai-librarian_qdrant-20260101-000000.tar.gz"]


def test_pruning_leaves_another_jobs_archives_alone(monkeypatch, jobs):
    """Two jobs can share a directory. 'Keep 1' means one of *this* job's."""
    job = jobs.add(a_job(keep=1))
    stub_calls(monkeypatch, {
        "/backup/archives": {"archives": [
            archive("ai-librarian_qdrant-20260303-000000.tar.gz", 3),
            archive("jellyfin_config-20260101-000000.tar.gz", 1),
            archive("please-keep-me.tar.gz", 0),
        ]},
        "/backup/archives/delete": {"deleted": []},
    })

    assert vb.prune(NODES, job) == []


def test_nothing_to_prune_makes_no_delete_call(monkeypatch, jobs):
    job = jobs.add(a_job(keep=5))
    seen = stub_calls(monkeypatch, {"/backup/archives": {"archives": []}})

    assert vb.prune(NODES, job) == []
    assert not [c for c in seen if "delete" in c[1]]


# ---- running a job --------------------------------------------------------


def test_a_local_backup_asks_for_no_remote(monkeypatch, jobs):
    job = jobs.add(a_job(source_host="bigboy", dest_host="bigboy"))
    seen = stub_calls(monkeypatch, {"/backup/volumes/run": {"id": "abc"}})

    vb.start_backup(NODES, job)

    body = seen[0][2]["json"]
    assert "remote" not in body
    assert body["volume"] == "ai-librarian_qdrant"


def test_a_cross_node_backup_is_told_where_to_send_it(monkeypatch, jobs):
    job = jobs.add(a_job())
    seen = stub_calls(monkeypatch, {
        "/backup/volumes/run": {"id": "abc"},
        "/backup/volumes": {"store": {"receive_url": "http://thinkpad:8123"}},
    })

    vb.start_backup(NODES, job)

    body = [c for c in seen if "run" in c[1]][0][2]["json"]
    assert body["remote"]["url"] == "http://thinkpad:8123"


def test_the_agents_public_url_beats_its_registered_one(monkeypatch, jobs):
    """thinkpad registers as a container name the dashboard resolves on its
    own network. A helper on bigboy cannot use that."""
    job = jobs.add(a_job())
    nodes = {**NODES, "thinkpad": {"url": "http://homelab-agent:8123"}}
    stub_calls(monkeypatch, {
        "/backup/volumes/run": {"id": "abc"},
        "/backup/volumes": {"store": {"receive_url": "http://thinkpad:8123"}},
    })

    assert vb._receive_url(nodes, "thinkpad") == "http://thinkpad:8123"


def test_a_successful_run_records_the_archive(monkeypatch, jobs):
    job = jobs.add(a_job())
    stub_calls(monkeypatch, {
        "/backup/volumes/run": {"id": "abc"},
        "/backup/volumes/jobs/": {
            "state": "succeeded",
            "result": {"name": "ai-librarian_qdrant-20260921-010203.tar.gz",
                       "bytes": 1234, "sha256": "de" * 32, "seconds": 9.5},
        },
        "/backup/volumes": {"store": {"receive_url": "http://thinkpad:8123"}},
        "/backup/archives": {"archives": []},
    })

    out = vb.run_job(NODES, job, jobs=jobs, sleep=lambda _: None)

    assert out["ok"] is True
    stored = jobs.all()[0]
    assert stored["last_archive"]["bytes"] == 1234
    assert stored["last_error"] is None
    assert stored["last_success_at"]
    assert stored["running"] is False


def test_a_failed_run_records_why(monkeypatch, jobs):
    job = jobs.add(a_job())
    stub_calls(monkeypatch, {
        "/backup/volumes/run": {"id": "abc"},
        "/backup/volumes/jobs/": {"state": "failed", "error": "no space left"},
        "/backup/volumes": {"store": {"receive_url": "http://thinkpad:8123"}},
    })

    out = vb.run_job(NODES, job, jobs=jobs, sleep=lambda _: None)

    assert out["ok"] is False
    stored = jobs.all()[0]
    assert "no space left" in stored["last_error"]
    assert stored["last_success_at"] is None
    assert stored["running"] is False


def test_a_prune_failure_does_not_fail_a_written_backup(monkeypatch, jobs):
    """The archive is on disk. Reporting the run as failed because the
    tidying up didn't work would be a lie about the backup."""
    job = jobs.add(a_job())
    stub_calls(monkeypatch, {
        "/backup/volumes/run": {"id": "abc"},
        "/backup/volumes/jobs/": {"state": "succeeded", "result": {"bytes": 1}},
        "/backup/volumes": {"store": {"receive_url": "http://thinkpad:8123"}},
        "/backup/archives": BackupError("the agent is gone", status_code=502),
    })

    out = vb.run_job(NODES, job, jobs=jobs, sleep=lambda _: None)

    assert out["ok"] is True
    assert jobs.all()[0]["last_error"] is None


def test_watching_survives_an_agent_restarting_briefly(monkeypatch, jobs):
    job = jobs.add(a_job())
    answers = [
        BackupError("unknown backup job", status_code=404),
        {"state": "running"},
        {"state": "succeeded", "result": {"bytes": 5}},
    ]

    def fake_call(method, url, **kwargs):
        if "/backup/volumes/jobs/" in url:
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        return {}

    monkeypatch.setattr(vb, "_call", fake_call)

    assert vb.wait_for(NODES, job, "abc", sleep=lambda _: None)["state"] == "succeeded"


def test_watching_gives_up_after_three_misses(monkeypatch, jobs):
    job = jobs.add(a_job())

    def fake_call(method, url, **kwargs):
        raise BackupError("gone", status_code=502)

    monkeypatch.setattr(vb, "_call", fake_call)

    with pytest.raises(BackupError, match="lost track"):
        vb.wait_for(NODES, job, "abc", sleep=lambda _: None)


def test_watching_stops_after_the_time_limit(monkeypatch, jobs):
    job = jobs.add(a_job())
    monkeypatch.setattr(vb, "_call", lambda *a, **k: {"state": "running"})
    clock = iter([0, 1, vb.MAX_RUN_SECONDS + 2])

    with pytest.raises(BackupError, match="still running"):
        vb.wait_for(NODES, job, "abc", sleep=lambda _: None, now=lambda: next(clock))


def test_run_due_skips_what_is_not_due(monkeypatch, jobs):
    jobs.add(a_job(interval_hours=24))
    ready = jobs.add(a_job(volume="other", interval_hours=1))
    jobs.record(jobs.all()[0]["id"], last_run_at=time.time())

    stub_calls(monkeypatch, {
        "/backup/volumes/run": {"id": "abc"},
        "/backup/volumes/jobs/": {"state": "succeeded", "result": {}},
        "/backup/volumes": {"store": {"receive_url": "http://thinkpad:8123"}},
        "/backup/archives": {"archives": []},
    })

    ran = vb.run_due(NODES, jobs=jobs, sleep=lambda _: None)

    assert [r["id"] for r in ran] == [ready["id"]]


def test_an_agent_without_the_route_says_to_update_it(monkeypatch, jobs):
    """A fleet where one node is a version behind should say which problem
    it has, not 'the agent answered 404'."""
    import requests

    class Resp:
        status_code = 404

        def json(self):
            return {}

    monkeypatch.setattr(requests, "request", lambda *a, **k: Resp())

    with pytest.raises(BackupError, match="predates volume backups"):
        vb.volumes_on(NODES, "bigboy")


def test_an_unregistered_host_is_a_404(jobs):
    with pytest.raises(BackupError) as caught:
        vb._base_url(NODES, "ghost")

    assert caught.value.status_code == 404
