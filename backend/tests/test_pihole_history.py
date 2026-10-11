"""DNS history: Pi-hole's ten-minute buckets folded into a chart, and what is asked of it."""

import pytest
from fastapi.testclient import TestClient

from backend import main, pihole, pihole_api, pihole_history as ph

NOW = 10_000_000.0


def rows(start, count, total=100, blocked=10):
    return [{"timestamp": start + i * 600, "total": total, "cached": 0, "blocked": blocked, "forwarded": total - blocked}
            for i in range(count)]


class Collector:
    def __init__(self, history=None, fail=None):
        self.calls, self.history, self.fail = [], history if history is not None else [], fail

    def get(self, path, **params):
        self.calls.append((path, params))
        if self.fail:
            raise self.fail
        if path == "/api/history/database":
            return {"history": self.history}
        if path == "/api/stats/database/summary":
            return {"sum_queries": 44874, "sum_blocked": 2746, "percent_blocked": 6.119, "total_clients": 32}
        if path == "/api/stats/database/top_domains":
            domains = [{"domain": "ads.example.com", "count": 9}] if params["blocked"] == "true" else [{"domain": "apple.com", "count": 90}]
            return {"domains": domains}
        if path == "/api/stats/database/top_clients":
            return {"clients": [{"ip": "192.168.0.247", "name": "pi.lan", "count": 17054}, {"ip": "127.0.0.1", "name": "localhost", "count": 5}]}
        raise AssertionError(path)


@pytest.fixture(autouse=True)
def clean():
    ph.reset()
    yield
    ph.reset()


def test_a_point_is_queries_per_hour_whatever_the_step():
    # one hour of ten-minute buckets at 100 each: 600 queries in that hour
    (point,) = ph.fold(rows(3600, 6), 3600)
    assert point["queries_per_hour"] == 600.0 and point["blocked_pct"] == 10.0
    # the same traffic folded into a day is still 600 an hour, not 14,400
    (day,) = ph.fold(rows(0, 144), 86400)
    assert day["queries_per_hour"] == 600.0


def test_a_slot_only_partly_there_is_not_drawn_as_a_dip():
    full = ph.fold(rows(0, 6) + rows(3600, 3), 3600)  # the second hour has only half its buckets
    assert [p["queries_per_hour"] for p in full] == [600.0, 600.0]


def test_a_gap_from_pi_hole_being_down_leaves_a_missing_slot_not_a_zero():
    points = ph.fold(rows(0, 6) + rows(7200, 6), 3600)
    assert [p["t"] for p in points] == [0, 7200]


def test_blocked_share_is_none_when_nothing_was_asked():
    (point,) = ph.fold(rows(0, 1, total=0, blocked=0), 600)
    assert point["blocked_pct"] is None and point["queries_per_hour"] == 0.0


def test_unreadable_buckets_are_skipped_not_fatal():
    assert ph.fold([{"timestamp": "x"}, {"total": 5}, *rows(0, 1)], 600)[0]["queries"] == 100


def test_get_asks_for_the_range_and_returns_totals_tops_and_coverage():
    collector = Collector(rows(NOW - NOW % 3600 - 3600, 6))  # one whole hour
    out = ph.get(collector, "7d", NOW)
    path, params = collector.calls[0]
    assert path == "/api/history/database" and params == {"from": int(NOW - 7 * 86400), "until": int(NOW)}
    assert out["step"] == 3600 and len(out["points"]) == 1
    assert out["summary"] == {"queries": 44874, "blocked": 2746, "blocked_pct": 6.1, "clients": 32}
    assert out["top_asked"][0]["domain"] == "apple.com" and out["top_blocked"][0]["domain"] == "ads.example.com"
    assert out["covers_seconds"] == 6 * 600  # says how much history really exists


def test_a_young_database_says_so_instead_of_pretending_to_cover_the_range():
    out = ph.get(Collector(rows(NOW - 1800, 3)), "90d", NOW)
    assert out["covers_seconds"] == 1800 and out["end"] - out["start"] == 90 * 86400


def test_your_names_win_over_pi_holes_reverse_lookup():
    out = ph.get(Collector(rows(NOW, 1)), "24h", NOW, names={"192.168.0.247": "thinkpad"})
    assert [c["name"] for c in out["top_clients"]] == ["thinkpad", "localhost"]


def test_an_answer_is_kept_for_a_minute_per_range():
    collector = Collector(rows(NOW, 1))
    ph.get(collector, "24h", NOW)
    n = len(collector.calls)
    ph.get(collector, "24h", NOW + 30, names={"192.168.0.247": "x"})
    assert len(collector.calls) == n
    ph.get(collector, "24h", NOW + 61)
    assert len(collector.calls) == 2 * n
    ph.get(collector, "7d", NOW + 62)
    assert len(collector.calls) == 3 * n


def test_names_do_not_leak_into_the_cache():
    collector = Collector(rows(NOW, 1))
    ph.get(collector, "24h", NOW, names={"192.168.0.247": "thinkpad"})
    assert ph.get(collector, "24h", NOW + 1)["top_clients"][0]["name"] == "pi.lan"


def test_an_unknown_range_is_refused():
    with pytest.raises(ValueError):
        ph.get(Collector(), "1y", NOW)


def test_the_route_validates_the_range_and_reports_pi_hole_failures(monkeypatch):
    client = TestClient(main.app)
    monkeypatch.setattr(pihole_api.pihole.collector, "url", "http://pi")
    monkeypatch.setattr(pihole_api.pihole.collector, "password", "x")
    assert client.get("/api/pihole/history?range=1y").status_code == 400
    monkeypatch.setattr(pihole_api, "_rows", lambda: ([{"ip": "192.168.0.247", "name": "thinkpad"}], {}))
    monkeypatch.setattr(pihole_api.pihole.collector, "get", lambda path, **p: (_ for _ in ()).throw(pihole.PiholeError("down", 502)))
    response = client.get("/api/pihole/history?range=7d")
    assert response.status_code == 502 and "down" in response.json()["error"]


def test_the_route_is_503_when_pi_hole_is_not_connected(monkeypatch):
    monkeypatch.setattr(pihole_api.pihole.collector, "url", "")
    assert TestClient(main.app).get("/api/pihole/history").status_code == 503
