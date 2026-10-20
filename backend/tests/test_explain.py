"""'Why is this busy?': the verdicts, and that each is earned by the numbers."""

import math

import pytest
from fastapi.testclient import TestClient

from backend import explain, explain_api, main

NOW = 1_790_000_000.0
STEP = 300  # container_history's bucket
MB = 1024**2
GB = 1024**3


def series(hours, cpu, mem, end=NOW):
    """5-minute points over the last ``hours``; cpu/mem are functions of the
    age in hours (0 = now), so a test reads as 'quiet until 3 h ago'."""
    count = int(hours * 3600 // STEP)
    points = []
    for i in range(count):
        t = end - (count - 1 - i) * STEP
        age = (end - t) / 3600
        points.append({"t": t, "cpu": cpu(age), "mem": mem(age)})
    return points


def container(cpu=5.0, mem=2 * GB, limit=16 * GB, **extra):
    return {
        "name": "doc-service",
        "id": "abc123",
        "status": "running",
        "started_at": NOW - 5 * 86400,
        "restart_count": 0,
        "stats": {
            "cpu_percent": cpu,
            "memory": {"used_bytes": mem, "limit_bytes": limit},
            "network": {}, "block_io": {},
        },
        **extra,
    }


MACHINE = {"cpu_cores": 8, "ram_total_bytes": 32 * GB, "cpu": 20.0, "ram": 40.0}


def run(c=None, week=None, day=None, events=(), jobs=(), machine=MACHINE, peers=None, now=NOW):
    c = c or container()
    week = week if week is not None else series(7 * 24, lambda a: 5.0, lambda a: 2 * GB)
    day = day if day is not None else [p for p in week if p["t"] >= now - 86400]
    return explain.explain(
        host="bigboy", container=c, machine=machine, peers=peers or [c],
        series_24h=day, series_7d=week, events=list(events), backup_jobs=list(jobs), now=now,
    )


def keys(result):
    return [f["key"] for f in result["findings"]]


def finding(result, key):
    return next(f for f in result["findings"] if f["key"] == key)


# --- a normal container ------------------------------------------------------


def test_a_container_at_its_usual_level_is_not_flagged():
    result = run()

    assert result["attention"] is False
    assert "cpu_normal" in keys(result) and "mem_steady" in keys(result)
    assert "normal for it" in result["headline"]
    assert result["suggestions"] == []


def test_the_headline_gives_the_numbers_in_the_rows_own_format():
    result = run(container(cpu=5.0, mem=2 * GB, limit=16 * GB))

    assert result["headline"].startswith("CPU 5.0%, normal for it. RAM 2.0 GB, steady")
    assert "12% of its limit" in result["headline"]


# --- CPU -----------------------------------------------------------------------


def test_cpu_busy_for_hours_says_how_long_and_how_much_more_than_usual():
    week = series(7 * 24, lambda a: 200.0 if a < 3 else 5.0, lambda a: 2 * GB)

    result = run(container(cpu=210.0), week=week)

    f = finding(result, "cpu_high")
    assert f["level"] == "warn"
    assert f["title"].startswith("CPU has been high for ")
    assert result["cpu"]["run"]["seconds"] == pytest.approx(3 * 3600, abs=STEP)
    assert "× its usual" in f["detail"]
    assert f["at"] == pytest.approx(NOW - 3 * 3600, abs=2 * STEP), "the page needs the instant, to show a clock time"
    assert result["cpu"]["level"] == "high"
    assert result["attention"] is True
    assert [s["action"] for s in result["suggestions"]][0] == "logs"


def test_a_spike_that_only_just_began_is_called_a_burst_not_a_job():
    week = series(7 * 24, lambda a: 200.0 if a < 0.1 else 5.0, lambda a: 2 * GB)

    result = run(container(cpu=210.0), week=week)

    assert finding(result, "cpu_high")["title"] == "CPU is high right now"
    assert result["cpu"]["run"] is None


def test_a_busy_job_that_pauses_for_one_sample_is_still_one_run():
    def cpu(age):
        if age >= 3:
            return 5.0
        return 5.0 if abs(age - 1.5) < 0.04 else 200.0   # a single quiet bucket

    result = run(container(cpu=200.0), week=series(7 * 24, cpu, lambda a: 2 * GB))

    assert result["cpu"]["run"]["seconds"] == pytest.approx(3 * 3600, abs=STEP), "one quiet bucket doesn't split it"


def test_the_last_two_hours_do_not_redefine_normal():
    """Busy for 90 minutes against a quiet week must still read as high; if
    the baseline included those 90 minutes it would have drifted up."""
    week = series(7 * 24, lambda a: 300.0 if a < 1.5 else 4.0, lambda a: 2 * GB)

    result = run(container(cpu=300.0), week=week)

    assert result["cpu"]["usual"] == pytest.approx(4.0)
    assert result["cpu"]["level"] == "high"


def test_a_few_percent_of_cpu_is_not_high_however_many_times_usual():
    week = series(7 * 24, lambda a: 0.2 if a >= 0.5 else 3.0, lambda a: 2 * GB)

    result = run(container(cpu=3.0), week=week)

    assert result["cpu"]["level"] == "normal"
    assert "cpu_high" not in keys(result)


def test_too_little_history_says_so_instead_of_calling_it_high():
    week = series(1, lambda a: 300.0, lambda a: 2 * GB)

    result = run(container(cpu=300.0), week=week)

    assert "cpu_no_baseline" in keys(result)
    assert "cpu_high" not in keys(result)
    assert result["cpu"]["level"] == "unknown"
    assert "300%" in result["headline"], "the number is still given"


def test_cpu_over_one_vcpu_is_also_shown_in_vcpus():
    week = series(7 * 24, lambda a: 230.0 if a < 3 else 5.0, lambda a: 2 * GB)

    result = run(container(cpu=230.0), week=week)

    assert "2.3 vCPU" in result["headline"]
    assert "29% of bigboy's 8 vCPU" in finding(result, "cpu_high")["detail"]


# --- memory --------------------------------------------------------------------


def test_steadily_rising_memory_is_a_leak_with_a_time_to_the_limit():
    week = series(7 * 24, lambda a: 5.0, lambda a: 2 * GB if a > 20 else 2 * GB + (20 - a) * 100 * MB)

    result = run(container(mem=2 * GB + 2000 * MB, limit=8 * GB), week=week)

    f = finding(result, "mem_climbing")
    assert f["level"] == "warn"
    assert "an hour" in f["detail"]
    assert "reaches the limit in about" in f["detail"]
    assert result["memory"]["shape"] == "climbing"
    assert result["memory"]["hours_to_limit"] == pytest.approx((8 * GB - (2 * GB + 2000 * MB)) / (100 * MB), rel=0.1)
    assert [s["action"] for s in result["suggestions"]][:2] == ["logs", "compose"]


def test_a_climb_since_the_last_start_says_so():
    c = container(mem=2 * GB + 2000 * MB, started_at=NOW - 20 * 3600)
    week = series(7 * 24, lambda a: 5.0, lambda a: 2 * GB if a > 20 else 2 * GB + (20 - a) * 100 * MB)

    assert "since it last started" in finding(run(c, week=week), "mem_climbing")["detail"]


def test_memory_that_jumped_once_and_stayed_is_not_called_a_leak():
    """Loading a model is a step. A line fits a step passably, so this is
    the case that would be mislabelled if the two weren't told apart."""
    week = series(7 * 24, lambda a: 5.0, lambda a: 2 * GB if a > 6 else 5 * GB)

    result = run(container(mem=5 * GB), week=week)

    f = finding(result, "mem_stepped")
    assert result["memory"]["shape"] == "stepped"
    assert "3.0 GB" in f["title"]
    assert f["at"] == pytest.approx(NOW - 6 * 3600, abs=2 * STEP)
    assert "mem_climbing" not in keys(result)
    assert result["attention"] is False, "a one-off step isn't an alarm on its own"


def test_the_event_next_to_a_change_is_named():
    week = series(7 * 24, lambda a: 5.0, lambda a: 2 * GB if a > 6 else 5 * GB)
    events = [
        {"at": NOW - 6 * 3600 - 120, "kind": "container_recreated", "text": "doc-service on bigboy recreated", "host": "bigboy"},
        {"at": NOW - 20 * 3600, "kind": "container_restart", "text": "doc-service on bigboy restarted", "host": "bigboy"},
    ]

    result = run(container(mem=5 * GB), week=week, events=events)

    f = finding(result, "onset_event")
    assert "memory stepped" in f["title"] and "doc-service on bigboy recreated" in f["title"]
    assert "within 2m" in f["title"]


def test_events_about_other_containers_are_not_blamed():
    week = series(7 * 24, lambda a: 5.0, lambda a: 2 * GB if a > 6 else 5 * GB)
    events = [{"at": NOW - 6 * 3600, "kind": "container_restart", "text": "qdrant on bigboy restarted", "host": "bigboy"}]

    assert "onset_event" not in keys(run(container(mem=5 * GB), week=week, events=events))


def test_a_host_reboot_near_the_change_counts():
    week = series(7 * 24, lambda a: 200.0 if a < 3 else 5.0, lambda a: 2 * GB)
    events = [{"at": NOW - 3 * 3600, "kind": "node_rebooted", "text": "bigboy rebooted", "host": "bigboy"}]

    assert "bigboy rebooted" in finding(run(container(cpu=200.0), week=week, events=events), "onset_event")["title"]


def test_flat_memory_is_described_as_resident_not_growing():
    result = run()

    assert "resident data" in finding(result, "mem_steady")["detail"]


def test_memory_near_the_limit_is_the_worst_finding_and_leads():
    result = run(container(mem=15 * GB, limit=16 * GB))

    assert finding(result, "mem_limit")["level"] == "bad"
    assert result["findings"][0]["key"] == "mem_limit"
    assert "OOM" in finding(result, "mem_limit")["detail"]


def test_a_big_container_without_a_memory_limit_is_pointed_at_the_compose_editor():
    result = run(container(mem=3 * GB, limit=0))

    assert "no memory limit" in result["headline"] or "no memory limit" in finding(result, "mem_steady")["detail"]
    assert {"action": "compose", "text": "It has no memory limit; set one so it can't starve its neighbours."} in result["suggestions"]


# --- context -------------------------------------------------------------------


def test_a_loaded_host_and_its_busiest_neighbours_are_named():
    week = series(7 * 24, lambda a: 200.0 if a < 3 else 5.0, lambda a: 2 * GB)
    c = container(cpu=200.0)
    jellyfin = {"name": "jellyfin", "status": "running", "stats": {"cpu_percent": 60.0, "memory": {"used_bytes": 1 * GB}}}
    idle = {"name": "sonarr", "status": "running", "stats": {"cpu_percent": 0.5, "memory": {"used_bytes": 300 * MB}}}

    result = run(c, week=week, machine={**MACHINE, "cpu": 97.0}, peers=[c, jellyfin, idle])

    assert "CPU 97%" in finding(result, "host_loaded")["detail"]
    assert "jellyfin" in finding(result, "neighbours")["detail"]
    assert "sonarr" not in finding(result, "neighbours")["detail"]


def test_a_running_backup_on_the_same_host_is_named():
    jobs = [
        {"name": "qdrant", "source_host": "bigboy", "running": True},
        {"name": "elsewhere", "source_host": "nuc", "running": True},
        {"name": "idle", "source_host": "bigboy", "running": False},
    ]

    detail = finding(run(jobs=jobs), "backup")["detail"]

    assert "qdrant" in detail and "elsewhere" not in detail and "idle" not in detail


def test_heavy_disk_and_network_traffic_is_reported():
    c = container()
    c["stats"]["block_io"] = {"write_bps": 20 * MB}
    c["stats"]["network"] = {"rx_bps": 100_000}

    detail = finding(run(c), "io")["detail"]

    assert "writing 20 MB/s" in detail and "receiving" not in detail


def test_an_app_that_reports_its_own_activity_is_quoted():
    c = container(live_activity={"app": "jellyfin", "detail": "2 users streaming"})

    assert finding(run(c), "live")["detail"] == "2 users streaming"


def test_a_fresh_start_is_called_out_as_probably_warming_up():
    c = container(started_at=NOW - 6 * 60)

    f = finding(run(c), "young")
    assert "6m ago" in f["title"] and "loading models" in f["detail"]


def test_repeated_restarts_are_a_warning_with_a_logs_suggestion():
    events = [
        {"at": NOW - i * 1800, "kind": "container_restart", "text": "doc-service on bigboy restarted", "host": "bigboy"}
        for i in range(1, 4)
    ]

    result = run(events=events)

    assert finding(result, "restarts")["title"] == "Restarted 3 times in the last day"
    assert result["suggestions"][0]["action"] == "logs"


def test_a_stopped_container_says_so_and_nothing_else():
    c = container()
    c["status"] = "exited"

    result = run(c)

    assert keys(result) == ["stopped"]
    assert result["attention"] is False


def test_the_result_is_plain_json():
    import json

    json.dumps(run(container(cpu=210.0), week=series(7 * 24, lambda a: 200.0 if a < 3 else 5.0, lambda a: 2 * GB)))


# --- the shape finder, on its own -----------------------------------------------


def test_noise_around_a_level_is_steady():
    points = series(24, lambda a: 1.0, lambda a: 2 * GB + 20 * MB * math.sin(a * 7))
    assert explain.memory_shape(points)["shape"] == "steady"


def test_a_sawtooth_is_variable_not_a_leak():
    points = series(24, lambda a: 1.0, lambda a: 2 * GB + (a % 4) * 500 * MB)
    assert explain.memory_shape(points)["shape"] == "variable"


def test_a_falling_line_is_falling_and_a_rising_one_climbing():
    # "a" is age, so a bigger age is further back: older = higher means falling.
    points = series(24, lambda a: 1.0, lambda a: 2 * GB + a * 100 * MB)
    assert explain.memory_shape(points)["shape"] == "falling"
    points = series(24, lambda a: 1.0, lambda a: 4 * GB - a * 100 * MB)
    assert explain.memory_shape(points)["shape"] == "climbing"


def test_a_short_series_has_no_shape():
    assert explain.memory_shape(series(0.5, lambda a: 1.0, lambda a: 2 * GB))["shape"] == "unknown"


def test_span_and_bytes_formatting_match_the_pages():
    assert explain.format_span(45 * 60) == "45m"
    assert explain.format_span(3 * 3600 + 20 * 60) == "3h 20m"
    assert explain.format_span(12 * 3600 + 20 * 60) == "12h"
    assert explain.format_span(3 * 86400 + 4 * 3600) == "3d 4h"
    assert explain.format_bytes(5.1 * GB) == "5.1 GB"
    assert explain.format_bytes(380 * MB) == "380 MB"


# --- the route -----------------------------------------------------------------


@pytest.fixture
def web(monkeypatch):
    c = container(cpu=7.0)
    snapshot = {"containers": {"bigboy": [c]}, "machines": {"bigboy": MACHINE}}

    async def shared():
        return snapshot

    monkeypatch.setattr(main, "shared_update", shared)
    monkeypatch.setattr(explain_api.activity, "history", lambda limit=0: [])
    monkeypatch.setattr(explain_api.volume_backups.store, "all", lambda: [])
    monkeypatch.setattr(explain_api.container_history, "history", lambda host, name, rng, now=None: {"points": []})
    return TestClient(main.app)


def test_the_route_explains_a_container_from_the_shared_snapshot(web):
    response = web.get("/api/containers/bigboy/doc-service/why")

    assert response.status_code == 200
    body = response.json()
    assert body["container"] == "doc-service" and body["host"] == "bigboy"
    assert body["headline"].startswith("CPU 7.0%")
    assert "cpu_no_baseline" in [f["key"] for f in body["findings"]], "no stored history yet, and it says so"


def test_the_route_404s_for_an_unknown_host_or_container(web):
    assert web.get("/api/containers/nowhere/doc-service/why").status_code == 404
    assert web.get("/api/containers/bigboy/ghost/why").status_code == 404
