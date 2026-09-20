import pytest

from backend import prometheus


@pytest.fixture(autouse=True)
def fresh_cache():
    prometheus._forecast_cache.update(data={}, fetched_at=0.0)
    yield
    prometheus._forecast_cache.update(data={}, fetched_at=0.0)


def series(job, device, mountpoint, value):
    return {
        "metric": {"job": job, "device": device, "mountpoint": mountpoint},
        "value": [0, str(value)],
    }


def test_days_until_full_rounds_and_drops_far_or_missing_forecasts():
    assert prometheus.days_until_full(86400 * 9.04) == 9.0
    assert prometheus.days_until_full(None) is None
    assert prometheus.days_until_full(0) is None
    assert prometheus.days_until_full(-5) is None
    assert prometheus.days_until_full(86400 * 4000) is None


def test_forecast_query_asks_for_the_downward_trend_only(monkeypatch):
    seen = []
    monkeypatch.setattr(prometheus, "query", lambda q: seen.append(q) or [])
    prometheus.get_filesystem_forecasts()
    assert "deriv(" in seen[0]
    assert "> 0" in seen[0]
    assert f"[{prometheus.FORECAST_WINDOW}]" in seen[0]


def test_forecasts_are_keyed_and_results_are_cached(monkeypatch):
    calls = []

    def fake_query(q):
        calls.append(q)
        return [series("nas", "sda1", "/mnt/media", 86400 * 3)]

    monkeypatch.setattr(prometheus, "query", fake_query)
    first = prometheus.get_filesystem_forecasts()
    second = prometheus.get_filesystem_forecasts()

    assert first == {("nas", "sda1", "/mnt/media"): 86400 * 3}
    assert second is first
    assert len(calls) == 1


def test_prometheus_failure_keeps_the_previous_forecasts(monkeypatch):
    monkeypatch.setattr(
        prometheus, "query",
        lambda q: [series("nas", "sda1", "/mnt/media", 86400 * 3)],
    )
    good = prometheus.get_filesystem_forecasts()

    prometheus._forecast_cache["fetched_at"] = 0.0  # expire it

    def boom(q):
        raise prometheus.requests.ConnectionError("down")

    monkeypatch.setattr(prometheus, "query", boom)
    assert prometheus.get_filesystem_forecasts() == good


def test_infinite_and_garbage_values_are_ignored(monkeypatch):
    monkeypatch.setattr(
        prometheus, "query",
        lambda q: [
            series("a", "d", "/", "+Inf"),
            series("b", "d", "/", "NaN"),
            series("c", "d", "/", "oops"),
            series("d", "d", "/", 100),
        ],
    )
    assert prometheus.get_filesystem_forecasts() == {("d", "d", "/"): 100.0}


def test_get_filesystems_attaches_days_until_full(monkeypatch):
    def fake_query(q):
        if "deriv" in q:
            return [series("nas", "sda1", "/mnt/media", 86400 * 4.5)]
        if "size_bytes" in q:
            return [
                series("nas", "sda1", "/mnt/media", 1000),
                series("nas", "nvme0", "/", 1000),
            ]
        return [
            series("nas", "sda1", "/mnt/media", 100),
            series("nas", "nvme0", "/", 500),
        ]

    monkeypatch.setattr(prometheus, "query", fake_query)
    fs = {f["mountpoint"]: f for f in prometheus.get_filesystems()["nas"]}

    assert fs["/mnt/media"]["days_until_full"] == 4.5
    assert fs["/mnt/media"]["used_percent"] == 90.0
    assert fs["/"]["days_until_full"] is None


def test_invalid_window_env_falls_back(monkeypatch):
    import importlib

    monkeypatch.setenv("DISK_FORECAST_WINDOW", "1h; drop")
    reloaded = importlib.reload(prometheus)
    try:
        assert reloaded.FORECAST_WINDOW == "24h"
    finally:
        monkeypatch.delenv("DISK_FORECAST_WINDOW")
        importlib.reload(prometheus)
