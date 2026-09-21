import pytest
import requests

from backend import backups

NOW = 1_000_000.0
HOUR = 3600


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    backups.clear_cache()
    monkeypatch.setattr(backups, "MAX_AGE_HOURS", 0)
    yield
    backups.clear_cache()


def raw(**kw):
    base = {
        "enabled": True,
        "configured": True,
        "interval_hours": 12,
        "last_run_at": NOW - 1 * HOUR,
        "last_success_at": NOW - 1 * HOUR,
        "last_error": None,
        "last_commit": "abc123",
        "running": False,
        "projects": {"web": {}, "media": {}},
    }
    base.update(kw)
    return base


def test_recent_success_is_ok():
    out = backups.classify(raw(), NOW)
    assert out["state"] == "ok"
    assert out["last_success_age"] == pytest.approx(HOUR)
    assert out["projects"] == 2


def test_stale_after_one_and_a_half_intervals():
    # 12h interval -> stale beyond 18h.
    assert backups.classify(raw(last_success_at=NOW - 17 * HOUR), NOW)["state"] == "ok"
    assert backups.classify(raw(last_success_at=NOW - 19 * HOUR), NOW)["state"] == "stale"


def test_short_intervals_still_get_two_hours_of_slack():
    # 1h interval -> stale beyond 3h (interval + 2h), not 1.5h.
    fast = raw(interval_hours=1)
    assert backups.classify({**fast, "last_success_at": NOW - 2.5 * HOUR}, NOW)["state"] == "ok"
    assert backups.classify({**fast, "last_success_at": NOW - 3.5 * HOUR}, NOW)["state"] == "stale"


def test_explicit_max_age_overrides_the_schedule(monkeypatch):
    monkeypatch.setattr(backups, "MAX_AGE_HOURS", 4)
    assert backups.classify(raw(last_success_at=NOW - 5 * HOUR), NOW)["state"] == "stale"


def test_failing_when_last_attempt_errored_after_the_last_success():
    out = backups.classify(
        raw(last_run_at=NOW - 60, last_success_at=NOW - 5 * HOUR, last_error="push rejected"),
        NOW,
    )
    assert out["state"] == "failing"
    assert out["last_error"] == "push rejected"


def test_never_succeeded_with_an_error_is_failing():
    out = backups.classify(raw(last_success_at=None, last_error="bad token"), NOW)
    assert out["state"] == "failing"


def test_configured_but_not_run_yet_is_pending():
    assert backups.classify(raw(last_success_at=None, last_run_at=None), NOW)["state"] == "pending"


def test_not_configured_and_disabled():
    assert backups.classify(raw(configured=False), NOW)["state"] == "not_configured"
    assert backups.classify(raw(enabled=False), NOW)["state"] == "disabled"


def test_long_error_is_truncated():
    out = backups.classify(raw(last_success_at=None, last_error="x" * 1000), NOW)
    assert len(out["last_error"]) == backups.MAX_ERROR_LENGTH


class FakeResponse:
    def __init__(self, payload, status=200, date=None):
        self._payload = payload
        self.status_code = status
        self.headers = {"Date": date} if date else {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def json(self):
        return self._payload


def test_age_uses_the_agents_clock_not_ours(monkeypatch):
    # The agent thinks it's 2001-09-09 01:46:40 UTC (epoch 1_000_000_000);
    # our own clock is wildly different and must not matter.
    payload = raw(last_success_at=1_000_000_000 - 2 * HOUR, last_run_at=1_000_000_000 - 2 * HOUR)
    monkeypatch.setattr(
        backups.requests, "get",
        lambda *a, **k: FakeResponse(payload, date="Sun, 09 Sep 2001 01:46:40 GMT"),
    )
    out = backups.status_for("nuc", "http://nuc:8123")
    assert out["state"] == "ok"
    assert out["last_success_age"] == pytest.approx(2 * HOUR)


def test_status_is_cached(monkeypatch):
    calls = []

    def fake_get(*a, **k):
        calls.append(1)
        return FakeResponse(raw())

    monkeypatch.setattr(backups.requests, "get", fake_get)
    backups.status_for("nuc", "http://nuc:8123")
    backups.status_for("nuc", "http://nuc:8123")
    assert len(calls) == 1


def test_old_agent_without_backup_route_is_unsupported(monkeypatch):
    monkeypatch.setattr(backups.requests, "get", lambda *a, **k: FakeResponse({}, status=404))
    assert backups.status_for("old", "http://old:8123")["state"] == "unsupported"


def test_unreachable_agent_is_unknown_not_an_exception(monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(backups.requests, "get", boom)
    assert backups.status_for("nuc", "http://nuc:8123") == {"state": "unknown"}


def test_a_failed_refresh_keeps_the_last_good_status_and_ages_it(monkeypatch):
    monkeypatch.setattr(backups, "_agent_now", lambda response: NOW)
    monkeypatch.setattr(backups.requests, "get", lambda *a, **k: FakeResponse(raw()))
    first = backups.status_for("nuc", "http://nuc:8123")
    assert first["state"] == "ok"

    def boom(*a, **k):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(backups.requests, "get", boom)
    # Expire the cache entry by pretending 10 minutes passed.
    ts, value = backups._cache["nuc"]
    backups._cache["nuc"] = (ts - 600, value)

    later = backups.status_for("nuc", "http://nuc:8123")
    assert later["state"] == "ok"
    assert later["last_success_age"] >= first["last_success_age"] + 599


# --- wiring: the agent poll carries the backup status onto the machine -------


def test_agent_poll_attaches_backup_and_merge_puts_it_on_the_machine(monkeypatch):
    from backend import docker
    from backend.scheduler_api import merge_agent_snapshot

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"containers": [{"id": "a", "name": "x"}], "gpu": None, "updated_at": 1}

    monkeypatch.setattr(docker.requests, "get", lambda *a, **k: Resp())
    monkeypatch.setattr(docker.backups, "status_for", lambda host, url: {"state": "ok"})
    # The poll also asks for the agent's version now; this test isn't about
    # that, and the stub above would otherwise answer /version too.
    monkeypatch.setattr(docker.versions, "for_host", lambda host, url: {"state": "current"})
    docker._LAST_GOOD.clear()

    host, snapshot = docker.get_host_data("nuc", "http://nuc:8123")
    assert snapshot["backup"] == {"state": "ok"}

    machines = {"nuc": {"online": True}}
    merge_agent_snapshot(machines, {host: snapshot})
    assert machines["nuc"]["backup"] == {"state": "ok"}


def test_unreachable_agent_reports_no_backup_status(monkeypatch):
    from backend import docker

    def boom(*a, **k):
        raise requests.ConnectionError("down")

    monkeypatch.setattr(docker.requests, "get", boom)
    docker._LAST_GOOD.clear()
    _, snapshot = docker.get_host_data("nuc", "http://nuc:8123")
    assert snapshot["reachable"] is False and snapshot["backup"] is None
