"""Noticing that a device which is almost always online has gone quiet."""

import pytest

from backend import pihole_alerts, presence
from backend.presence import PresenceStore

H = 3600
DAY = 24 * H
T0 = 1_000_000 * H  # an hour boundary


def row(mac="a", name="Fire TV", online=True, ghost=""):
    return {"mac": mac, "name": name, "online": online, "ghost": ghost}


@pytest.fixture
def store(tmp_path):
    return PresenceStore(tmp_path / "presence.json")


def watch(store, mac="a", days=4, online_hours=None, name="Fire TV"):
    """Sample once an hour for `days` days; online except in the hours listed (hour offsets)."""
    missing = set(online_hours or [])
    for h in range(days * 24):
        store.observe([row(mac, name, online=h not in missing)], T0 + h * H + 60)


def test_a_device_watched_too_briefly_says_nothing(store):
    watch(store, days=2)
    assert store.usual("a", T0 + 2 * DAY) is None
    assert store.gone([row(online=False)], T0 + 2 * DAY + 5 * H) == []


def test_an_always_online_device_that_vanishes_is_gone(store):
    watch(store, days=4)
    now = T0 + 4 * DAY + 3 * H  # last seen in hour 95; 3+ hours ago
    gone = store.gone([row(online=False)], now)
    assert [g["mac"] for g in gone] == ["a"]
    assert gone[0]["percent"] == 100 and gone[0]["days"] == 4
    assert gone[0]["away_seconds"] >= 3 * H


def test_staying_gone_keeps_the_alert_up(store):
    watch(store, days=4)
    for days_away in (1, 2, 3):
        gone = store.gone([row(online=False)], T0 + 4 * DAY + days_away * DAY)
        assert [g["mac"] for g in gone] == ["a"], days_away
        assert gone[0]["percent"] == 100  # its record before it left, not diluted by the absence
    # the record is a rolling week: once under three days of it are left there is nothing to judge by
    assert store.gone([row(online=False)], T0 + 4 * DAY + 5 * DAY) == []


def test_a_short_absence_is_not_enough(store):
    watch(store, days=4)
    last = T0 + 4 * DAY - H + 60  # the last sample
    assert store.gone([row(online=False)], last + 30 * 60) == []  # 30 minutes: under the 45
    assert store.gone([row(online=False)], last + 50 * 60) == []  # 50 minutes: not yet an hour past a gapless record
    assert store.gone([row(online=False)], last + 70 * 60) != []


def test_a_device_that_is_online_is_never_gone(store):
    watch(store, days=4)
    assert store.gone([row(online=True)], T0 + 5 * DAY) == []


def test_a_sleeper_is_not_usually_online(store):
    # online half of every day: nobody is surprised when it is off
    watch(store, days=4, online_hours=[h for h in range(96) if h % 24 >= 12])
    u = store.usual("a", T0 + 4 * DAY)
    assert u["ratio"] < presence.USUAL_RATIO
    assert store.gone([row(online=False)], T0 + 4 * DAY + 6 * H) == []


def test_a_longer_than_usual_gap_is_what_counts(store):
    # online all but one 5-hour stretch: 5 hours away is normal for it, 11+ is not
    watch(store, days=4, online_hours=range(30, 35))
    last = T0 + 4 * DAY - H + 60
    assert store.usual("a", T0 + 4 * DAY)["longest_gap"] == 5
    assert store.gone([row(online=False)], last + 8 * H) == []
    assert store.gone([row(online=False)], last + 12 * H) != []


def test_unknown_and_hidden_rows_are_ignored(store):
    watch(store, days=4)
    now = T0 + 5 * DAY
    assert store.gone([row(online=None)], now) == []  # doesn't use Pi-hole for DNS: can't tell
    assert store.gone([row(online=False, ghost="stale")], now) == []


def test_nothing_is_sampled_while_pihole_is_untrusted(store):
    store.observe([row()], T0, trusted=False)
    assert store.usual("a", T0) is None and store._devices == {}
    watch(store, days=4)
    # an outage of Pi-hole: devices all look offline, but those samples are dropped
    for h in range(96, 120):
        store.observe([row(online=False)], T0 + h * H + 60, trusted=False)
    assert store.usual("a", T0 + 4 * DAY)["ratio"] == 1.0


def test_samples_are_spaced(store):
    store.observe([row()], T0 + 10)
    store.observe([row(online=False)], T0 + 20)  # too soon: ignored
    assert store._devices["a"]["last"] == T0 + 10


def test_it_survives_a_restart(store, tmp_path):
    watch(store, days=4)
    store._save(T0 + 5 * DAY)
    again = PresenceStore(tmp_path / "presence.json")
    assert again.usual("a", T0 + 4 * DAY)["ratio"] == 1.0
    assert again.gone([row(online=False)], T0 + 4 * DAY + 3 * H) != []


def test_old_hours_are_forgotten(store):
    watch(store, days=4)
    store.observe([row()], T0 + 30 * DAY)
    assert max(store._devices["a"]["hours"]) == int((T0 + 30 * DAY) // H)
    assert min(store._devices["a"]["hours"]) > int(T0 // H) + 20 * 24  # the first week is gone


def test_the_alert_says_what_is_missing():
    gone = [{"mac": "aa:bb:cc:00:00:01", "name": "Fire TV", "away_seconds": 3 * H + 120, "percent": 96, "days": 5}]
    out = pihole_alerts.evaluate(down_for=None, error=None, rows=[], new={}, history=[], gone=gone)
    alert = out["network:offline:aabbcc000001"]
    assert alert["title"] == "Fire TV is offline"
    assert "96% of the last 5 days" in alert["message"] and "3 h" in alert["message"]
    assert alert["severity"] == "warn"


@pytest.mark.parametrize("seconds,text", [(50 * 60, "50 min"), (3 * H, "3 h"), (30 * H, "30 h"), (3 * DAY, "3 days")])
def test_spans_read_naturally(seconds, text):
    assert pihole_alerts._span(seconds) == text
