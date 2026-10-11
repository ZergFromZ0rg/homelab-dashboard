"""GPU history: bucketed averages kept for months, per card, surviving a restart."""

import pytest

from backend import gpu_history as gh

HOUR = 3600
T0 = 1_000_000 * gh.BUCKET_SECONDS  # a bucket boundary


def machine(*devices, **over):
    return {"agent_reachable": True, "agent_stale_age": None, "gpu": {"devices": list(devices)}, **over}


def card(slot="0000:01:00.0", name="NVIDIA GeForce GTX 1650 SUPER", **kw):
    base = {"pci_slot": slot, "name": name, "utilization_percent": 10.0, "memory_used_mb": 1024.0, "memory_total_mb": 4096.0,
            "temperature_c": 40.0, "power_draw_w": 20.0}
    return {**base, **kw}


def test_samples_in_one_bucket_are_averaged_not_summed():
    gh.record({"bigboy": machine(card(utilization_percent=10.0))}, T0)
    gh.record({"bigboy": machine(card(utilization_percent=30.0))}, T0 + 60)
    (gpu,) = gh.history("bigboy", "6h", T0 + 120)
    (point,) = gpu["points"]
    assert point["utilization"] == 20.0 and point["memory"] == 25.0 and point["temperature"] == 40.0 and point["power"] == 20.0


def test_a_metric_the_driver_never_reports_has_no_series():
    """An old Intel iGPU has a name and nothing else."""
    gh.record({"tp": machine(card(utilization_percent=None, memory_used_mb=None, memory_total_mb=None, temperature_c=None,
                                  power_draw_w=None, active_percent=40.0))}, T0)
    (gpu,) = gh.history("tp", "6h", T0 + 1)
    assert gpu["points"] == [{"t": T0, "active": 40.0}]


def test_a_card_that_reports_nothing_at_all_leaves_no_history():
    gh.record({"tp": machine(card(utilization_percent=None, memory_used_mb=None, temperature_c=None, power_draw_w=None))}, T0)
    assert gh.history("tp", "6h", T0 + 1) == []


def test_two_identical_cards_keep_separate_histories_by_pci_slot():
    gh.record({"h": machine(card("0000:03:00.0", utilization_percent=5.0), card("0000:06:00.0", utilization_percent=95.0))}, T0)
    a, b = gh.history("h", "6h", T0 + 1)
    assert (a["key"], a["points"][0]["utilization"]) == ("0000:03:00.0", 5.0)
    assert (b["key"], b["points"][0]["utilization"]) == ("0000:06:00.0", 95.0)


def test_a_card_without_a_pci_slot_is_keyed_by_position():
    gh.record({"h": machine(card(None))}, T0)
    assert gh.history("h", "6h", T0 + 1)[0]["key"] == "gpu0"


def test_a_stale_or_unreachable_host_is_not_counted_twice():
    gh.record({"h": machine(card(), agent_stale_age=12.0)}, T0)
    gh.record({"h": machine(card(), agent_reachable=False)}, T0)
    assert gh.history("h", "6h", T0 + 1) == []


def test_old_buckets_fall_out_of_a_range_and_out_of_retention():
    gh.record({"h": machine(card())}, T0)
    assert gh.history("h", "6h", T0 + 7 * HOUR)[0]["points"] == []  # outside 6 h
    later = T0 + gh.RETENTION_SECONDS + 2 * gh.BUCKET_SECONDS
    gh.record({"h": machine(card())}, later)
    assert [p["t"] for p in gh.history("h", "90d", later + 1)[0]["points"]] == [gh._bucket_of(later)]


def test_a_long_range_is_downsampled_to_what_a_chart_can_draw():
    for i in range(1000):
        gh.record({"h": machine(card(utilization_percent=float(i % 100)))}, T0 + i * gh.BUCKET_SECONDS)
    (gpu,) = gh.history("h", "30d", T0 + 1000 * gh.BUCKET_SECONDS)
    assert 0 < len(gpu["points"]) <= gh.TARGET_POINTS


def test_history_survives_a_restart(tmp_path):
    gh.record({"h": machine(card(utilization_percent=42.0))}, T0)
    gh._last_persist = 0.0
    gh._maybe_persist(T0 + 1000)
    gh._series.clear()
    gh._load()
    (gpu,) = gh.history("h", "6h", T0 + 1)
    assert gpu["name"] == "NVIDIA GeForce GTX 1650 SUPER" and gpu["points"][0]["utilization"] == 42.0


def test_an_unknown_range_is_refused():
    with pytest.raises(ValueError):
        gh.history("h", "5y")
