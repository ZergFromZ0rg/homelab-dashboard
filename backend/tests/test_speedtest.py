"""The scheduled internet speed test: when it runs, what it keeps, and when it alerts."""

import time

import pytest
from fastapi.testclient import TestClient

from backend import main, speedtest
from backend.speedtest import SpeedTest, SpeedTestError

GOOD = {"down_mbps": 94.0, "up_mbps": 11.0, "ping_ms": 14.0, "jitter_ms": 2.0}


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


def make(tmp_path, clock=None, busy=False, measure=None, **kw):
    clock = clock or Clock()
    test = SpeedTest(tmp_path / "s.json", measure_fn=measure or (lambda: dict(GOOD)), clock=clock, busy_fn=lambda: busy, **kw)
    return test, clock


def results(*downs, busy=False):
    return [{"at": i, "down_mbps": d, "up_mbps": 10, "ping_ms": 10, "jitter_ms": 1, "busy": busy} for i, d in enumerate(downs)]


# ---- the rate ------------------------------------------------------------


def test_rate_leaves_out_the_slow_start():
    # 1 MB/s for the first second, then 10 MB/s: only the second part counts.
    samples = [(0.0, 0), (1.0, 1_000_000), (2.0, 11_000_000), (3.0, 21_000_000)]
    assert speedtest._rate(samples, 0.0) == pytest.approx(80.0)  # 10 MB/s = 80 Mbit/s


def test_rate_falls_back_to_the_whole_run_when_the_steady_part_is_too_short():
    samples = [(0.0, 0), (1.2, 1_500_000)]
    assert speedtest._rate(samples, 0.0) == pytest.approx(10.0)


def test_rate_needs_at_least_two_samples():
    assert speedtest._rate([(0.0, 5)], 0.0) is None


# ---- recording -----------------------------------------------------------


def test_a_run_is_recorded_and_survives_a_restart(tmp_path):
    test, clock = make(tmp_path)
    result = test.run(manual=True)
    assert result["down_mbps"] == 94.0 and result["manual"] and not result["busy"]
    again = SpeedTest(tmp_path / "s.json", measure_fn=lambda: dict(GOOD), clock=clock)
    assert again.results == test.results and again.every_hours == test.every_hours


def test_a_manual_run_on_a_busy_line_is_marked_busy(tmp_path):
    test, _ = make(tmp_path, busy=True)
    assert test.run(manual=True)["busy"] is True


def test_a_failure_is_kept_as_the_error_and_a_later_success_clears_it(tmp_path):
    calls = iter([SpeedTestError("couldn't reach speed.cloudflare.com: down"), None])

    def measure():
        outcome = next(calls)
        if outcome:
            raise outcome
        return dict(GOOD)

    test, _ = make(tmp_path, measure=measure)
    with pytest.raises(SpeedTestError):
        test.run()
    assert test.results == [] and "cloudflare" in test.snapshot()["error"]["message"]
    test.run()
    assert test.snapshot()["error"] is None and len(test.results) == 1


def test_history_is_capped(tmp_path):
    test, _ = make(tmp_path)
    for _ in range(speedtest.KEEP + 5):
        test.run()
    assert len(test.results) == speedtest.KEEP
    assert len(test.snapshot()["results"]) == speedtest.SHOWN


def test_two_runs_at_once_are_refused(tmp_path):
    test, _ = make(tmp_path)
    test._running = True
    with pytest.raises(SpeedTestError):
        test.run()


# ---- the schedule --------------------------------------------------------


def test_the_first_test_waits_a_minute_after_start(tmp_path):
    test, clock = make(tmp_path)
    assert test.tick() is False
    clock.now += 61
    assert test.tick() is True


def test_after_a_test_the_next_is_one_interval_away(tmp_path):
    test, clock = make(tmp_path)
    test.run()
    clock.now += 6 * 3600 - 5
    assert test.tick() is False
    clock.now += 10
    assert test.tick() is True


def test_a_restart_does_not_run_a_test_that_is_not_due(tmp_path):
    test, clock = make(tmp_path)
    test.run()
    clock.now += 3600
    again, _ = make(tmp_path, clock=clock)
    assert again.tick() is False


def test_a_busy_line_postpones_a_scheduled_test_but_only_for_an_hour(tmp_path):
    test, clock = make(tmp_path, busy=True)
    test.run()
    clock.now += 6 * 3600 + 60
    assert test.tick() is False
    clock.now += speedtest.BUSY_GRACE
    assert test.tick() is True


def test_off_means_off(tmp_path):
    test, clock = make(tmp_path)
    test.set_every(0)
    clock.now += 10 * 24 * 3600
    assert test.due_at() is None and test.tick() is False


def test_a_failed_test_is_retried_sooner_than_the_schedule(tmp_path):
    def fail():
        raise SpeedTestError("down")

    test, clock = make(tmp_path, measure=fail)
    clock.now += 61
    assert test.tick() is True
    assert test.due_at() == clock.now + speedtest.RETRY


def test_only_listed_intervals_are_accepted(tmp_path):
    test, _ = make(tmp_path)
    with pytest.raises(ValueError):
        test.set_every(5)
    test.set_every(12)
    assert test.every_hours == 12


# ---- the alert -----------------------------------------------------------


def test_two_slow_results_in_a_row_raise_one_alert():
    alert = speedtest.evaluate(results(90, 95, 92, 90, 94, 93, 91, 30, 35))
    assert list(alert) == ["network:internet-slow"]
    assert "30" in alert["network:internet-slow"]["message"] and "35" in alert["network:internet-slow"]["message"]


def test_one_slow_result_is_a_blip():
    assert speedtest.evaluate(results(90, 95, 92, 90, 94, 93, 91, 92, 30)) == {}


def test_a_line_that_is_always_slow_is_not_slow():
    assert speedtest.evaluate(results(20, 21, 20, 22, 20, 21, 20, 21, 20)) == {}


def test_not_enough_history_says_nothing():
    assert speedtest.evaluate(results(90, 95, 92, 30, 35)) == {}


def test_busy_line_results_are_ignored_both_as_usual_and_as_slow():
    quiet = results(90, 95, 92, 90, 94, 93, 91, 92, 93)
    busy = [{**r, "busy": True, "down_mbps": 10} for r in results(1, 2)]
    assert speedtest.evaluate(quiet + busy) == {}


# ---- the routes ----------------------------------------------------------


@pytest.fixture
def client():
    return TestClient(main.app)


def test_get_reports_the_schedule_and_choices(client):
    body = client.get("/api/speedtest").json()
    assert body["every_hours"] == speedtest.DEFAULT_HOURS and 6 in body["choices"] and body["results"] == []


def test_the_schedule_can_be_changed_from_the_page(client):
    assert client.put("/api/speedtest/schedule", json={"every_hours": 12}).json()["every_hours"] == 12
    assert client.put("/api/speedtest/schedule", json={"every_hours": 7}).status_code == 422


def test_run_starts_a_test_in_the_background(client, monkeypatch, tmp_path):
    test, _ = make(tmp_path)
    monkeypatch.setattr(speedtest, "test", test)
    response = client.post("/api/speedtest/run")
    assert response.status_code == 202 and response.json()["running"] is True
    for _ in range(50):
        if test.results:
            break
        time.sleep(0.02)
    assert client.get("/api/speedtest").json()["results"][0]["down_mbps"] == 94.0


def test_run_while_running_is_a_conflict(client, monkeypatch, tmp_path):
    test, _ = make(tmp_path)
    test._running = True
    monkeypatch.setattr(speedtest, "test", test)
    assert client.post("/api/speedtest/run").status_code == 409
