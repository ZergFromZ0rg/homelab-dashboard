from backend import prometheus


def series(job, device, value):
    return {"metric": {"job": job, "device": device}, "value": [0, str(value)]}


def fake_query(rx, tx):
    """Answer the receive query with `rx` and the transmit query with `tx`."""

    def query(promql):
        return rx if "receive" in promql else tx

    return query


def test_rows_carry_both_directions_per_device(monkeypatch):
    monkeypatch.setattr(
        prometheus,
        "query",
        fake_query(
            [series("nas", "eth0", 1_500_000), series("nas", "tailscale0", 20_000)],
            [series("nas", "eth0", 300_000), series("nas", "tailscale0", 9_000)],
        ),
    )

    rows = prometheus.get_network_interfaces()["nas"]

    assert [r["device"] for r in rows] == ["eth0", "tailscale0"]
    assert rows[0]["rx_bps"] == 1_500_000.0 and rows[0]["tx_bps"] == 300_000.0
    assert rows[1]["rx_bps"] == 20_000.0 and rows[1]["tx_bps"] == 9_000.0


def test_overlay_links_are_listed_but_flagged_as_outside_the_total():
    """The host's rx/tx headline counts physical NICs only. The breakdown
    shows the rest, and says which is which."""
    physical = ("eth0", "enp3s0", "wlan0")
    overlay = ("tailscale0", "wg0", "tun0")

    import re

    for device in physical:
        assert re.fullmatch(prometheus.VIRTUAL_IFACE_RE, device) is None
        assert re.fullmatch(prometheus.HIDDEN_IFACE_RE, device) is None

    for device in overlay:
        # Excluded from the total...
        assert re.fullmatch(prometheus.VIRTUAL_IFACE_RE, device)
        # ...but not from the breakdown.
        assert re.fullmatch(prometheus.HIDDEN_IFACE_RE, device) is None


def test_container_plumbing_stays_hidden():
    import re

    for device in ("lo", "veth1a2b3c", "docker0", "br-9f8e7d", "cilium_host"):
        assert re.fullmatch(prometheus.HIDDEN_IFACE_RE, device)


def test_in_total_marks_what_the_headline_figure_counts(monkeypatch):
    monkeypatch.setattr(
        prometheus,
        "query",
        fake_query(
            [series("nas", "eth0", 100), series("nas", "wg0", 100)],
            [series("nas", "eth0", 100), series("nas", "wg0", 100)],
        ),
    )

    by_device = {r["device"]: r for r in prometheus.get_network_interfaces()["nas"]}

    assert by_device["eth0"]["in_total"] is True
    assert by_device["wg0"]["in_total"] is False


def test_idle_interfaces_are_dropped(monkeypatch):
    monkeypatch.setattr(
        prometheus,
        "query",
        fake_query(
            [series("nas", "eth0", 500), series("nas", "eth1", 0)],
            [series("nas", "eth0", 100), series("nas", "eth1", 0)],
        ),
    )

    rows = prometheus.get_network_interfaces()["nas"]
    assert [r["device"] for r in rows] == ["eth0"]


def test_a_device_seen_only_transmitting_still_appears(monkeypatch):
    monkeypatch.setattr(
        prometheus,
        "query",
        fake_query([], [series("nas", "eth0", 4_000)]),
    )

    (row,) = prometheus.get_network_interfaces()["nas"]
    assert row["rx_bps"] == 0.0 and row["tx_bps"] == 4_000.0


def test_the_queries_exclude_only_the_hidden_interfaces(monkeypatch):
    seen = []
    monkeypatch.setattr(prometheus, "query", lambda q: seen.append(q) or [])

    prometheus.get_network_interfaces()

    assert len(seen) == 2
    for promql in seen:
        assert prometheus.HIDDEN_IFACE_RE in promql
        assert "tailscale" not in promql


def test_each_interface_gets_its_own_history_and_idle_ones_are_left_out(monkeypatch):
    def range_series(device, values):
        return {"metric": {"job": "nas", "device": device}, "values": [[1000 + 60 * i, str(v)] for i, v in enumerate(values)]}

    answers = {
        "receive": [range_series("eth0", [100, 300, "NaN"]), range_series("tailscale0", [0, 0, 0])],
        "transmit": [range_series("eth0", [10, 20, 30])],
    }
    asked = []

    def fake_range(promql, start, end, step):
        asked.append(promql)
        return answers["receive" if "receive" in promql else "transmit"]

    monkeypatch.setattr(prometheus, "query_range", fake_range)
    out = prometheus._interface_history(0, 1, 60)

    assert list(out["nas"]) == ["eth0"]                      # tailscale0 never moved
    eth = out["nas"]["eth0"]
    assert [p["v"] for p in eth["rx"]] == [100.0, 300.0, None]
    assert [p["v"] for p in eth["tx"]] == [10.0, 20.0, 30.0]
    assert all(prometheus.HIDDEN_IFACE_RE in q for q in asked)  # same filter as the live table
