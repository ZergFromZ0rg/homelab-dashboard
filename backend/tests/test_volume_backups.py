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


# ---- directory sources ----------------------------------------------------


def a_path_job(**overrides):
    return a_job(volume=None, path="/home/zerg/ai-librarian/data/qdrant", **overrides)


def test_a_job_takes_a_volume_or_a_path_but_not_both(jobs):
    with pytest.raises(BackupError, match="either a volume or a path"):
        jobs.add(a_job(path="/home/zerg"))

    with pytest.raises(BackupError, match="either a volume or a path"):
        jobs.add(a_job(volume=None))


def test_a_path_job_is_named_after_its_last_component(jobs):
    job = jobs.add({
        "source_host": "bigboy", "path": "/home/zerg/ai-librarian/data/qdrant",
    })

    assert job["name"] == "qdrant"
    assert job["volume"] is None


def test_a_path_prefix_matches_the_agents_naming():
    """The agent turns a path's slashes into dashes; retention matches on
    the result. If the two drift, pruning silently stops finding anything."""
    path = "/home/zerg/ai-librarian/data/qdrant"

    assert vb.archive_prefix(path) == "home-zerg-ai-librarian-data-qdrant"
    assert vb.owns(f"{vb.archive_prefix(path)}-20260922-010203.tar.gz", path)


def test_a_path_job_does_not_own_a_similar_paths_archives(jobs):
    mine = "/home/zerg/ai-librarian/data/qdrant"
    other = "/home/zerg/ai-librarian/data/qdrant2"

    assert not vb.owns(f"{vb.archive_prefix(other)}-20260922-010203.tar.gz", mine)


def test_the_same_path_twice_to_one_place_is_refused(jobs):
    jobs.add(a_path_job())

    with pytest.raises(BackupError) as caught:
        jobs.add(a_path_job())

    assert caught.value.status_code == 409


def test_a_volume_and_a_path_are_different_sources(jobs):
    jobs.add(a_job())
    jobs.add(a_path_job())

    assert len(jobs.all()) == 2


def test_a_path_job_sends_a_path_not_a_volume(monkeypatch, jobs):
    job = jobs.add(a_path_job())
    seen = stub_calls(monkeypatch, {
        "/backup/volumes/run": {"id": "abc"},
        "/backup/volumes": {"store": {"receive_url": "http://thinkpad:8123"}},
    })

    vb.start_backup(NODES, job)

    body = [c for c in seen if "run" in c[1]][0][2]["json"]
    assert body["path"] == "/home/zerg/ai-librarian/data/qdrant"
    assert "volume" not in body


def test_pruning_a_path_job_matches_its_own_archives(monkeypatch, jobs):
    job = jobs.add(a_path_job(keep=1))
    prefix = vb.archive_prefix(job["path"])
    stub_calls(monkeypatch, {
        "/backup/archives": {"archives": [
            archive(f"{prefix}-20260303-000000.tar.gz", 3),
            archive(f"{prefix}-20260101-000000.tar.gz", 1),
            archive("ai-librarian_qdrant-20260101-000000.tar.gz", 1),
        ]},
        "/backup/archives/delete": {"deleted": [f"{prefix}-20260101-000000.tar.gz"]},
    })

    assert vb.prune(NODES, job) == [f"{prefix}-20260101-000000.tar.gz"]


def test_a_path_job_survives_a_restart(tmp_path):
    path = tmp_path / "volume_backups.json"
    BackupJobStore(path).add(a_path_job())

    (reloaded,) = BackupJobStore(path).all()

    assert reloaded["path"] == "/home/zerg/ai-librarian/data/qdrant"
    assert reloaded["volume"] is None


# ---- health, and the alert it raises --------------------------------------


def test_state_covers_each_way_a_job_can_be(jobs):
    now = 1790000000.0
    job = jobs.add(a_job(interval_hours=24))

    assert vb.state(job, now) == "pending"

    jobs.record(job["id"], last_run_at=now, last_success_at=now)
    assert vb.state(jobs.all()[0], now) == "ok"

    jobs.record(job["id"], last_success_at=now - 24 * 3600 * 2)
    assert vb.state(jobs.all()[0], now) == "stale"

    jobs.record(job["id"], last_run_at=now, last_error="no space left")
    assert vb.state(jobs.all()[0], now) == "failing"

    jobs.mark_running(job["id"], True)
    assert vb.state(jobs.all()[0], now) == "running"


def test_a_paused_job_is_not_stale(jobs):
    """Pausing is a decision, not a fault, and it must not page anyone."""
    now = 1790000000.0
    job = jobs.add(a_job(enabled=False))
    jobs.record(job["id"], last_success_at=now - 99999999)

    assert vb.state(jobs.all()[0], now) == "paused"


def test_a_failing_backup_raises_a_bad_alert(jobs):
    from backend import alerts

    now = 1790000000.0
    job = jobs.add(a_job())
    jobs.record(job["id"], last_run_at=now, last_error="couldn't reach the agent")

    raised = alerts.evaluate({}, [], backups=jobs.all(), now=now)

    (key, alert), = raised.items()
    assert key == f"backup:{job['id']}"
    assert alerts.severity_of(key, alert) == "bad"
    assert "never succeeded" in alert["message"]
    assert "couldn't reach the agent" in alert["message"]
    assert alert["host"] == "bigboy"


def test_a_stale_backup_is_a_warning_not_a_failure(jobs):
    """Nothing broke; it just hasn't run. Worth a nudge, not a 2 a.m. page."""
    from backend import alerts

    now = 1790000000.0
    job = jobs.add(a_job(interval_hours=24))
    jobs.record(job["id"], last_run_at=now - 3 * 86400, last_success_at=now - 3 * 86400)

    raised = alerts.evaluate({}, [], backups=jobs.all(), now=now)

    (key, alert), = raised.items()
    assert alerts.severity_of(key, alert) == "warn"
    assert "behind" in alert["title"]


def test_a_healthy_backup_raises_nothing(jobs):
    from backend import alerts

    now = 1790000000.0
    job = jobs.add(a_job())
    jobs.record(job["id"], last_run_at=now, last_success_at=now)

    assert alerts.evaluate({}, [], backups=jobs.all(), now=now) == {}


def test_a_paused_or_pending_backup_raises_nothing(jobs):
    from backend import alerts

    now = 1790000000.0
    jobs.add(a_job(enabled=False))
    jobs.add(a_job(volume="other"))

    assert alerts.evaluate({}, [], backups=jobs.all(), now=now) == {}


def test_the_alert_names_what_is_unprotected(jobs):
    """The message has to be readable by someone who did not set the job
    up, months later."""
    from backend import alerts

    now = 1790000000.0
    job = jobs.add(a_path_job())
    jobs.record(job["id"], last_run_at=now, last_error="no space left on device")

    alert = alerts.evaluate({}, [], backups=jobs.all(), now=now)[f"backup:{job['id']}"]

    assert "/home/zerg/ai-librarian/data/qdrant" in alert["message"]
    assert "thinkpad:/backups/bigboy" in alert["message"]
    assert "unprotected" in alert["hint"]


def test_the_job_list_carries_its_state(backups_client, jobs):
    jobs.add(a_job())

    body = backups_client.get("/api/backups").json()

    assert body["backups"][0]["state"] == "pending"


@pytest.fixture
def backups_client(jobs, monkeypatch):
    """The app, with this test's store wired in."""
    from fastapi.testclient import TestClient

    from backend import main, volume_backup_api

    monkeypatch.setattr(vb, "store", jobs)
    monkeypatch.setattr(volume_backup_api, "store", jobs)
    monkeypatch.setattr(volume_backup_api, "default_dest_host", lambda: "thinkpad")
    return TestClient(main.app)


def test_restore_steps_start_by_moving_the_archive_to_the_right_host(jobs):
    """The archive is on the destination and the data belongs on the
    source. A hint that skipped that step read fine and didn't work."""
    from backend.volume_backup_api import restore_steps

    job = jobs.add(a_path_job())
    steps = restore_steps(job, "home-zerg-x-20260922-010203.tar.gz")

    assert steps[0]["where"] == "thinkpad"
    assert steps[0]["command"].startswith("scp /backups/bigboy/")
    assert "bigboy:/tmp/" in steps[0]["command"]


def test_restore_steps_for_a_directory_extract_in_place(jobs):
    from backend.volume_backup_api import restore_steps

    job = jobs.add(a_path_job())
    jobs.record(job["id"], last_stopped=["ai-librarian-qdrant-1"])
    commands = " ".join(
        s["command"] for s in restore_steps(jobs.all()[0], "a-20260922-010203.tar.gz")
    )

    assert "docker stop ai-librarian-qdrant-1" in commands
    assert "tar xzf /tmp/a-20260922-010203.tar.gz -C /home/zerg/ai-librarian/data/qdrant" in commands
    assert "docker start ai-librarian-qdrant-1" in commands


def test_restore_steps_for_a_volume_go_through_a_container(jobs):
    from backend.volume_backup_api import restore_steps

    job = jobs.add(a_job())
    commands = " ".join(
        s["command"] for s in restore_steps(job, "a-20260922-010203.tar.gz")
    )

    assert "-v ai-librarian_qdrant:/dest" in commands
    assert "rm -rf /dest/*" in commands


def test_a_same_host_restore_skips_the_copy(jobs):
    from backend.volume_backup_api import restore_steps

    job = jobs.add(a_path_job(dest_host="bigboy"))
    steps = restore_steps(job, "a-20260922-010203.tar.gz")

    assert not any("scp" in s["command"] for s in steps)
    assert all(s["where"] in ("bigboy", "anywhere") for s in steps)


# ---- scheduled verification -----------------------------------------------


def test_a_job_that_has_never_succeeded_is_not_verified(jobs):
    """There is nothing to read back, and saying so twice helps nobody."""
    job = jobs.add(a_job())

    assert vb.verify_due(job) is False


def test_a_job_with_an_archive_is_verified(jobs):
    job = jobs.add(a_job())
    jobs.record(job["id"], last_success_at=time.time())

    assert vb.verify_due(jobs.all()[0]) is True


def test_verification_respects_its_own_interval(jobs):
    now = 1790000000.0
    job = jobs.add(a_job(verify_interval_hours=168))
    jobs.record(job["id"], last_success_at=now, last_verify_at=now - 3600)

    assert vb.verify_due(jobs.all()[0], now) is False

    jobs.record(job["id"], last_verify_at=now - 169 * 3600)
    assert vb.verify_due(jobs.all()[0], now) is True


def test_verification_can_be_turned_off(jobs):
    job = jobs.add(a_job(verify_interval_hours=0))
    jobs.record(job["id"], last_success_at=time.time())

    assert vb.verify_due(jobs.all()[0]) is False


def test_a_good_verification_is_recorded(monkeypatch, jobs):
    job = jobs.add(a_job())
    jobs.record(job["id"], last_success_at=time.time())
    prefix = vb.archive_prefix(job["volume"])
    stub_calls(monkeypatch, {
        "/backup/archives/verify": {"ok": True, "files": 145, "bytes": 730508267},
        "/backup/archives": {"archives": [
            archive(f"{prefix}-20260101-000000.tar.gz", 1),
            archive(f"{prefix}-20260303-000000.tar.gz", 3),
        ]},
    })

    out = vb.verify_job(NODES, jobs.all()[0], jobs=jobs)

    assert out["ok"] is True
    assert out["archive"] == f"{prefix}-20260303-000000.tar.gz", "the newest one"
    stored = jobs.all()[0]
    assert stored["last_verify_ok"] is True
    assert stored["last_verified"]["files"] == 145
    assert vb.state(stored) == "ok"


def test_an_archive_that_does_not_read_back_makes_the_job_corrupt(monkeypatch, jobs):
    """A job can be running perfectly to schedule and still be producing
    backups nobody can restore from. That is the worse problem."""
    job = jobs.add(a_job())
    jobs.record(job["id"], last_success_at=time.time())
    prefix = vb.archive_prefix(job["volume"])
    stub_calls(monkeypatch, {
        "/backup/archives/verify": {"ok": False, "error": "CRC check failed"},
        "/backup/archives": {"archives": [archive(f"{prefix}-20260303-000000.tar.gz", 3)]},
    })

    vb.verify_job(NODES, jobs.all()[0], jobs=jobs)

    stored = jobs.all()[0]
    assert stored["last_verify_ok"] is False
    assert vb.state(stored) == "corrupt"


def test_a_corrupt_archive_raises_a_bad_alert(monkeypatch, jobs):
    from backend import alerts

    now = 1790000000.0
    job = jobs.add(a_job())
    jobs.record(job["id"], last_success_at=now, last_verify_ok=False,
                last_verify_error="CRC check failed",
                last_verified={"name": "qdrant-20260303-000000.tar.gz"})

    (key, alert), = alerts.evaluate({}, [], backups=jobs.all(), now=now).items()

    assert key == f"backup:{job['id']}"
    assert alerts.severity_of(key, alert) == "bad"
    assert "did not read back" in alert["message"]
    assert "cannot be restored from" in alert["message"]


def test_not_being_able_to_check_is_not_the_same_as_bad(monkeypatch, jobs):
    """An unreachable host must not cry corruption — that would make the
    alert meaningless the first time somebody reboots a machine."""
    job = jobs.add(a_job())
    jobs.record(job["id"], last_success_at=time.time())

    def fake_call(method, url, **kwargs):
        raise BackupError("couldn't reach the agent", status_code=502)

    monkeypatch.setattr(vb, "_call", fake_call)

    out = vb.verify_job(NODES, jobs.all()[0], jobs=jobs)

    assert out["ok"] is None
    stored = jobs.all()[0]
    assert stored["last_verify_ok"] is None, "unknown, not false"
    assert vb.state(stored) != "corrupt"


def test_a_job_that_just_ran_is_not_verified_in_the_same_pass(monkeypatch, jobs):
    """A fresh archive was checksummed end to end on the way in. Reading it
    straight back would mostly prove the disk can still read."""
    job = jobs.add(a_job(interval_hours=1))
    stub_calls(monkeypatch, {
        "/backup/volumes/run": {"id": "abc"},
        "/backup/volumes/jobs/": {"state": "succeeded", "result": {"bytes": 1}},
        "/backup/volumes": {"store": {"receive_url": "http://thinkpad:8123"}},
        "/backup/archives": {"archives": []},
    })

    ran = vb.run_due(NODES, jobs=jobs, sleep=lambda _: None)

    assert len(ran) == 1
    assert "verify" not in ran[0]
