"""record_fleet is the sampling entry point (reconcile loop); busy() reads
the baseline back — same shape as live_history's tests."""

import pytest

from backend import resource_activity as ra


@pytest.fixture(autouse=True)
def _clear(monkeypatch):
    monkeypatch.setattr(ra, "CPU_FACTOR", 3.0)
    monkeypatch.setattr(ra, "CPU_MIN_DELTA", 10.0)
    monkeypatch.setattr(ra, "NET_FACTOR", 3.0)
    monkeypatch.setattr(ra, "NET_MIN_DELTA_BPS", 512_000)
    ra._baseline.clear()
    yield


def _fleet(cpu=5.0, rx=0.0, tx=0.0, cid="abc"):
    return {
        "nas": [
            {
                "id": cid,
                "stats": {"cpu_percent": cpu, "network": {"rx_bps": rx, "tx_bps": tx}},
            }
        ]
    }


def test_no_baseline_yet_is_not_busy():
    assert ra.busy("nas", {"id": "abc"}) is None


def test_first_tick_sets_baseline_without_flagging_busy():
    ra.record_fleet(_fleet(cpu=5.0))
    assert ra.busy("nas", _fleet(cpu=5.0)["nas"][0]) is None


def test_steady_load_never_spikes():
    for _ in range(5):
        ra.record_fleet(_fleet(cpu=5.0))
    assert ra.busy("nas", _fleet(cpu=5.0)["nas"][0]) is None


def test_cpu_spike_is_flagged(monkeypatch):
    ra.record_fleet(_fleet(cpu=2.0))  # baseline ~2%
    result = ra.busy("nas", _fleet(cpu=40.0)["nas"][0])
    assert result is not None
    assert result["source"] == "resource"
    assert result["app"] is None
    assert "CPU" in result["detail"]


def test_small_bump_from_idle_baseline_is_not_a_spike():
    ra.record_fleet(_fleet(cpu=0.0))
    # +5 points is below CPU_MIN_DELTA (10), even though "infinitely" more
    # than a 0 baseline in relative terms.
    assert ra.busy("nas", _fleet(cpu=5.0)["nas"][0]) is None


def test_download_spike_is_flagged():
    ra.record_fleet(_fleet(rx=1_000))
    result = ra.busy("nas", _fleet(rx=5_000_000)["nas"][0])
    assert result is not None
    assert "download" in result["detail"]


def test_upload_spike_is_flagged():
    ra.record_fleet(_fleet(tx=1_000))
    result = ra.busy("nas", _fleet(tx=5_000_000)["nas"][0])
    assert result is not None
    assert "upload" in result["detail"]


def test_sustained_spike_does_not_drag_baseline_up():
    ra.record_fleet(_fleet(cpu=2.0))  # baseline ~2%

    # Several ticks at a sustained high value — if the baseline "chased"
    # this up, the spike would eventually stop being reported.
    for _ in range(10):
        ra.record_fleet(_fleet(cpu=50.0))

    assert ra.busy("nas", _fleet(cpu=50.0)["nas"][0]) is not None


def test_baseline_recovers_after_spike_ends():
    ra.record_fleet(_fleet(cpu=2.0))
    ra.record_fleet(_fleet(cpu=50.0))  # spike tick — baseline frozen
    assert ra.busy("nas", _fleet(cpu=50.0)["nas"][0]) is not None

    for _ in range(30):
        ra.record_fleet(_fleet(cpu=2.0))  # back to normal, baseline re-converges

    assert ra.busy("nas", _fleet(cpu=2.0)["nas"][0]) is None


def test_prunes_vanished_containers():
    ra.record_fleet(_fleet(cpu=2.0, cid="abc"))
    assert ra.busy("nas", {"id": "abc"}) is None  # has a baseline (not busy)

    ra.record_fleet({"nas": []})  # abc gone from the snapshot

    # No baseline anymore either way — same "no data" None as before, but
    # confirms record_fleet actually dropped the stale entry.
    assert ("nas", "abc") not in ra._baseline
