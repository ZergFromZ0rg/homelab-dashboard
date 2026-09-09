"""record_fleet is the single sampling entry point (called from the
always-on reconcile loop); container_heartbeat / gpu_temp_history read it
back."""

import pytest

from backend import live_history as lh


@pytest.fixture(autouse=True)
def _clear(monkeypatch, tmp_path):
    monkeypatch.setattr(lh, "PERSIST_PATH", str(tmp_path / "h.json"))
    lh._gpu_temps.clear()
    lh._container_samples.clear()
    lh._last_persisted = 0.0
    yield


def _fleet(status="running", health=None, gpu_temp=None):
    machines = {"nas": {"gpu": {"devices": [{"temperature_c": gpu_temp}]}}}
    containers = {"nas": [{"id": "abc", "status": status, "health": health}]}
    return machines, containers


def test_records_and_reads_back_heartbeat():
    m, c = _fleet()
    for _ in range(3):
        lh.record_fleet(m, c)

    hb = lh.container_heartbeat("nas", "abc")
    assert hb["uptime_percent"] == 100.0
    assert hb["buckets"][-1] == "up"  # most recent bucket has our samples
    assert hb["buckets"][0] is None  # 29 minutes ago: no data (not "down")


def test_unhealthy_counts_as_down():
    lh.record_fleet(*_fleet(status="running", health="unhealthy"))
    hb = lh.container_heartbeat("nas", "abc")
    assert hb["buckets"][-1] == "down"
    assert hb["uptime_percent"] == 0.0


def test_gpu_temp_history_skips_none():
    lh.record_fleet(*_fleet(gpu_temp=None))
    assert lh.gpu_temp_history("nas") == []
    lh.record_fleet(*_fleet(gpu_temp=41))
    series = lh.gpu_temp_history("nas")
    assert [p["v"] for p in series] == [41]


def test_prunes_vanished_containers():
    lh.record_fleet(*_fleet())
    assert lh.container_heartbeat("nas", "abc")["uptime_percent"] == 100.0

    lh.record_fleet({"nas": {}}, {"nas": []})  # abc gone from the snapshot
    assert lh.container_heartbeat("nas", "abc")["uptime_percent"] is None


def test_missing_gpu_key_is_fine():
    lh.record_fleet({"nas": {}}, {"nas": [{"id": "abc", "status": "running"}]})
    assert lh.container_heartbeat("nas", "abc")["buckets"][-1] == "up"


def test_persists_across_reload(monkeypatch, tmp_path):
    path = str(tmp_path / "reload.json")
    monkeypatch.setattr(lh, "PERSIST_PATH", path)
    lh._last_persisted = 0.0
    lh.record_fleet(*_fleet(gpu_temp=50))
    assert lh._last_persisted  # wrote (first call, past the interval)

    lh._gpu_temps.clear()
    lh._container_samples.clear()
    monkeypatch.setattr(lh, "PERSIST_PATH", path)
    lh._load()
    assert lh.container_heartbeat("nas", "abc")["uptime_percent"] == 100.0
    assert [p["v"] for p in lh.gpu_temp_history("nas")] == [50]
