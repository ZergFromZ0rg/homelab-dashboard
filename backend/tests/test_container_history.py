import pytest

from backend import container_history as ch


@pytest.fixture(autouse=True)
def _fresh(monkeypatch, tmp_path):
    monkeypatch.setattr(ch, "_FILE", tmp_path / "container-history.json")
    ch.reset()
    yield
    ch.reset()


def snapshot(cpu=10.0, mem=100 * 1024**2, name="jellyfin", status="running"):
    return {
        "bigboy": [{
            "name": name, "status": status,
            "stats": {"cpu_percent": cpu, "memory": {"used_bytes": mem}},
        }]
    }


def test_samples_land_in_five_minute_buckets():
    base = 1_790_000_000
    ch.record(snapshot(cpu=10), now=base)
    ch.record(snapshot(cpu=20), now=base + 60)

    out = ch.history("bigboy", "jellyfin", "24h", now=base + 120)

    assert len(out["points"]) == 1, "both samples belong to the same bucket"
    assert out["points"][0]["cpu"] == 15.0, "the bucket is their mean"


def test_a_bucket_is_a_mean_not_a_sum_however_many_ticks_land_in_it():
    """The reconcile cadence isn't guaranteed, so the count matters."""
    base = 1_790_000_000
    for _ in range(7):
        ch.record(snapshot(cpu=30, mem=50 * 1024**2), now=base)

    (point,) = ch.history("bigboy", "jellyfin", "24h", now=base)["points"]

    assert point["cpu"] == 30.0
    assert point["mem"] == 50 * 1024**2


def test_separate_buckets_stay_separate():
    base = 1_790_000_000
    ch.record(snapshot(cpu=10), now=base)
    ch.record(snapshot(cpu=90), now=base + ch.BUCKET_SECONDS)

    points = ch.history("bigboy", "jellyfin", "24h", now=base + ch.BUCKET_SECONDS)["points"]

    assert [p["cpu"] for p in points] == [10.0, 90.0]


def test_history_is_keyed_by_name_so_a_recreate_does_not_reset_it():
    """A container id changes every deploy; the graph shouldn't."""
    base = 1_790_000_000
    ch.record(snapshot(cpu=10), now=base)
    # Same name, new id, new bucket — as after a rebuild.
    ch.record(snapshot(cpu=20), now=base + ch.BUCKET_SECONDS)

    points = ch.history("bigboy", "jellyfin", "24h", now=base + ch.BUCKET_SECONDS)["points"]
    assert len(points) == 2


def test_stopped_containers_are_not_sampled():
    base = 1_790_000_000
    ch.record(snapshot(status="exited"), now=base)

    assert ch.history("bigboy", "jellyfin", "24h", now=base)["points"] == []


def test_a_container_with_no_stats_at_all_is_skipped():
    base = 1_790_000_000
    ch.record({"bigboy": [{"name": "x", "status": "running", "stats": {}}]}, now=base)

    assert ch.history("bigboy", "x", "24h", now=base)["points"] == []


def test_old_buckets_are_dropped():
    base = 1_790_000_000
    ch.record(snapshot(cpu=10), now=base)

    # Well past the retention window.
    later = base + ch.RETENTION_SECONDS + ch.BUCKET_SECONDS * 2
    ch.record(snapshot(cpu=20), now=later)

    points = ch.history("bigboy", "jellyfin", "7d", now=later)["points"]

    assert [p["cpu"] for p in points] == [20.0]


def test_the_range_bounds_what_comes_back():
    base = 1_790_000_000
    ch.record(snapshot(cpu=10), now=base)
    ch.record(snapshot(cpu=20), now=base + 10 * 3600)

    now = base + 10 * 3600
    assert len(ch.history("bigboy", "jellyfin", "24h", now=now)["points"]) == 2
    assert len(ch.history("bigboy", "jellyfin", "6h", now=now)["points"]) == 1


def test_a_week_is_downsampled_to_something_drawable():
    """2016 five-minute buckets is far more than a chart has pixels for."""
    base = 1_790_000_000
    for i in range(2016):
        ch.record(snapshot(cpu=float(i % 100)), now=base + i * ch.BUCKET_SECONDS)

    out = ch.history("bigboy", "jellyfin", "7d", now=base + 2016 * ch.BUCKET_SECONDS)

    assert len(out["points"]) <= ch.TARGET_POINTS
    assert out["bucket_seconds"] > ch.BUCKET_SECONDS, "reported width follows the grouping"


def test_a_short_range_is_not_downsampled():
    base = 1_790_000_000
    for i in range(12):
        ch.record(snapshot(), now=base + i * ch.BUCKET_SECONDS)

    out = ch.history("bigboy", "jellyfin", "24h", now=base + 12 * ch.BUCKET_SECONDS)

    assert out["bucket_seconds"] == ch.BUCKET_SECONDS


def test_an_unknown_container_is_empty_not_an_error():
    assert ch.history("bigboy", "nope", "24h")["points"] == []


def test_an_unknown_range_is_rejected():
    with pytest.raises(ValueError, match="range must be one of"):
        ch.history("bigboy", "jellyfin", "forever")


def test_hosts_are_kept_apart():
    base = 1_790_000_000
    ch.record({
        "bigboy": [{"name": "x", "status": "running",
                    "stats": {"cpu_percent": 1, "memory": {"used_bytes": 1}}}],
        "thinkpad": [{"name": "x", "status": "running",
                      "stats": {"cpu_percent": 99, "memory": {"used_bytes": 2}}}],
    }, now=base)

    assert ch.history("bigboy", "x", "24h", now=base)["points"][0]["cpu"] == 1.0
    assert ch.history("thinkpad", "x", "24h", now=base)["points"][0]["cpu"] == 99.0


def test_it_survives_a_restart(monkeypatch, tmp_path):
    base = 1_790_000_000
    monkeypatch.setattr(ch, "PERSIST_INTERVAL_SECONDS", 0)
    ch.record(snapshot(cpu=42), now=base)

    ch._series.clear()
    ch._load()

    assert ch.history("bigboy", "jellyfin", "24h", now=base)["points"][0]["cpu"] == 42.0


def test_a_corrupt_file_does_not_stop_it_starting(monkeypatch, tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"bigboy": {"x": {"notanumber": ["a", "b", "c"]}}}')
    monkeypatch.setattr(ch, "_FILE", bad)

    ch._series.clear()
    ch._load()  # must not raise

    assert ch.history("bigboy", "x", "24h")["points"] == []
