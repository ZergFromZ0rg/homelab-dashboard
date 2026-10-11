"""Bandwidth by device: the switch's ports with 24-hour totals and a trend."""

import requests
from fastapi.testclient import TestClient

from backend import bandwidth, main, prometheus, switch


def labels(index):
    return {"ifIndex": str(index), "job": "switch"}


PORTS = {
    "state": "up",
    "reachable": True,
    "updated_at": 1000.0,
    "ports": [
        {"index": 1, "name": "router", "port": "g1", "labelled": True, "up": True, "speed_mbps": 100,
         "sent_bps": 2e6, "received_bps": 11e6},
        {"index": 2, "name": "Bigboy", "port": "g2", "labelled": True, "up": True, "speed_mbps": 1000,
         "sent_bps": 40e6, "received_bps": 1e6},
        {"index": 4, "name": "g4", "port": "g4", "labelled": False, "up": True, "speed_mbps": 1000,
         "sent_bps": 0, "received_bps": 0},
    ],
}


def fake_prometheus(monkeypatch, fail=None):
    def query(promql):
        if fail:
            raise fail
        if promql.startswith("increase(ifHCOutOctets"):  # to the device
            return [{"metric": labels(1), "value": [0, "9e9"]}, {"metric": labels(2), "value": [0, "5e8"]}]
        if promql.startswith("increase(ifHCInOctets"):  # from the device
            return [{"metric": labels(1), "value": [0, "1e9"]}, {"metric": labels(2), "value": [0, "6e10"]}]
        raise AssertionError(promql)

    def query_range(promql, start, end, step):
        if fail:
            raise fail
        assert end - start == bandwidth.SPAN and step == bandwidth.STEP
        values = [[1000, "1000"], [1060, "NaN"], [1120, "3000"]]
        index = 2 if "Out" in promql else 1  # a distinguishable series per direction
        return [{"metric": labels(index), "values": values}]

    monkeypatch.setattr(prometheus, "query", query)
    monkeypatch.setattr(prometheus, "query_range", query_range)


def rows(snapshot):
    return {d["name"]: d for d in snapshot["devices"]}


def test_a_device_carries_its_rate_its_day_and_its_trend(monkeypatch):
    fake_prometheus(monkeypatch)
    monitor = bandwidth.Bandwidth()
    monitor.refresh(2000.0)
    bigboy = rows(monitor.snapshot(PORTS))["Bigboy"]
    assert (bigboy["down_bps"], bigboy["up_bps"]) == (1e6, 40e6)  # the device's side
    assert (bigboy["down_24h"], bigboy["up_24h"]) == (5e8, 6e10)
    assert bigboy["down_trend"][1] == {"t": 1060, "v": None}  # a gap stays a gap
    assert monitor.snapshot(PORTS)["history_at"] == 2000.0


def test_the_uplink_is_marked_so_it_is_not_taken_for_one_device(monkeypatch):
    fake_prometheus(monkeypatch)
    monitor = bandwidth.Bandwidth()
    monitor.refresh(2000.0)
    found = rows(monitor.snapshot(PORTS))
    assert found["router"]["uplink"] is True and found["Bigboy"]["uplink"] is False


def test_the_router_reads_as_the_internet_not_as_a_device(monkeypatch):
    """What the switch sends the router is on its way out, so for that one row down is
    what the router sends the switch. Everywhere else down is what the switch sends."""
    fake_prometheus(monkeypatch)
    monitor = bandwidth.Bandwidth()
    monitor.refresh(2000.0)
    router = rows(monitor.snapshot(PORTS))["router"]
    assert (router["down_bps"], router["up_bps"]) == (2e6, 11e6)  # port: sent 2e6 to the switch, received 11e6
    assert (router["down_24h"], router["up_24h"]) == (1e9, 9e9)  # from the router (In) is the download
    # the fake has an inbound series for the router only: it is the download trend
    assert router["down_trend"][0]["v"] == 1000 and router["up_trend"] == []


def test_before_the_first_refresh_rates_still_show_without_totals():
    found = rows(bandwidth.Bandwidth().snapshot(PORTS))
    assert found["Bigboy"]["up_bps"] == 40e6
    assert found["Bigboy"]["down_24h"] is None and found["Bigboy"]["down_trend"] == []


def test_a_port_with_no_history_yet_has_empty_totals_not_zero(monkeypatch):
    fake_prometheus(monkeypatch)
    monitor = bandwidth.Bandwidth()
    monitor.refresh(2000.0)
    assert rows(monitor.snapshot(PORTS))["g4"]["down_24h"] is None


def test_prometheus_failing_keeps_the_last_answer(monkeypatch):
    fake_prometheus(monkeypatch)
    monitor = bandwidth.Bandwidth()
    monitor.refresh(2000.0)
    fake_prometheus(monkeypatch, fail=requests.ConnectionError("gone"))
    monitor.refresh(2100.0)
    snap = monitor.snapshot(PORTS)
    assert snap["history_at"] == 2000.0 and rows(snap)["Bigboy"]["up_24h"] == 6e10


def test_the_route_serves_the_cache(monkeypatch):
    fake_prometheus(monkeypatch)
    bandwidth.monitor.refresh(2000.0)
    monkeypatch.setattr(switch.monitor, "snapshot", lambda: PORTS)
    body = TestClient(main.app).get("/api/bandwidth").json()
    assert [d["name"] for d in body["devices"]] == ["router", "Bigboy", "g4"]
