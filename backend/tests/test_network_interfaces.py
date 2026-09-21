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
