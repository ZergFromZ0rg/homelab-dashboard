"""The router's WAN counters: 32-bit wraps and reboots, what is kept, what is
asked of the router, and what the numbers mean next to the switch's."""

import pytest
import requests
from fastapi.testclient import TestClient

from backend import bandwidth, main, speedtest, switch, wan
from backend.wan import WRAP, Wan, WanError

T0 = 1_000_000 * wan.BUCKET  # a bucket boundary
MBIT = 1e6 / 8  # bytes per second at one megabit


class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now


class FakeRouter:
    def __init__(self, counters=None, link=None, fail=None):
        self.counters_list = list(counters or [])
        self.fail = fail
        self._link = link or {"up": True, "mbps": 100, "kind": "Ethernet", "address": "203.0.113.7"}
        self.calls = 0

    def counters(self):
        self.calls += 1
        if self.fail:
            raise self.fail
        return self.counters_list.pop(0)

    def link(self):
        return self._link


def make(tmp_path, router=None, clock=None, connect=None):
    clock = clock or Clock()
    monitor = Wan(tmp_path / "wan.json", clock=clock, connect=connect or (lambda: router))
    return monitor, clock


def feed(monitor, clock, readings, every=15):
    """(rx, tx) readings, one poll's worth of time apart."""
    for rx, tx in readings:
        monitor.record(clock.now, rx, tx)
        clock.now += every


# ---- the counters ------------------------------------------------------------


def test_delta_is_the_difference_between_two_readings():
    assert wan.delta(1000, 5000, 1e9) == 4000


def test_a_counter_that_wrapped_is_counted_across_the_wrap():
    assert wan.delta(WRAP - 1000, 3000, 1e9) == 4000


def test_a_counter_that_restarted_at_zero_is_a_reboot_not_a_four_gigabyte_download():
    # it dropped by more than the link could have moved in the time between readings
    assert wan.delta(2_000_000_000, 50_000, 1_000_000) == 50_000


def test_a_wrap_larger_than_the_link_allows_is_not_believed():
    assert wan.delta(1_000_000, 500_000, 100_000) == 500_000


# ---- recording ------------------------------------------------------------------


def test_bytes_land_in_the_bucket_and_peaks_are_the_busiest_poll(tmp_path):
    monitor, clock = make(tmp_path)
    feed(monitor, clock, [(0, 0), (1_500_000, 150_000), (1_500_000 + 3_000_000, 150_000 + 30_000)])
    bucket = monitor.buckets[T0]
    assert bucket[:2] == [4_500_000, 180_000]
    assert bucket[2] == pytest.approx(3_000_000 * 8 / 15)  # the second poll was the busy one
    assert bucket[3] == pytest.approx(150_000 * 8 / 15)  # the first poll carried most of the upload


def test_a_wrap_between_polls_does_not_lose_or_invent_bytes(tmp_path):
    monitor, clock = make(tmp_path)
    feed(monitor, clock, [(WRAP - 2_000_000, 0), (1_000_000, 0)])
    assert monitor.buckets[T0][0] == 3_000_000


def test_a_router_reboot_counts_from_zero(tmp_path):
    monitor, clock = make(tmp_path)
    feed(monitor, clock, [(2_000_000_000, 0), (40_000, 0), (140_000, 0)])
    assert monitor.buckets[T0][0] == 40_000 + 100_000


def test_a_long_gap_is_not_smeared_into_one_slot(tmp_path):
    monitor, clock = make(tmp_path)
    monitor.record(clock.now, 0, 0)
    clock.now += 3 * wan.BUCKET
    monitor.record(clock.now, 900_000_000, 0)  # the dashboard was down; that is a baseline, not a spike
    assert monitor.buckets == {}


def test_buckets_older_than_ninety_days_are_dropped(tmp_path):
    monitor, clock = make(tmp_path)
    feed(monitor, clock, [(0, 0), (1000, 0)])
    clock.now += wan.RETENTION + wan.BUCKET
    feed(monitor, clock, [(2000, 0), (3000, 0)])
    assert T0 not in monitor.buckets and len(monitor.buckets) == 1


# ---- reading ------------------------------------------------------------------------


def test_rates_are_averages_of_the_live_samples(tmp_path):
    monitor, clock = make(tmp_path)
    mb = int(10 * MBIT * 15)  # 10 Mbit/s for one poll
    feed(monitor, clock, [(0, 0), (mb, 0), (3 * mb, 0)])
    rx, tx = monitor.rate(120, clock.now)
    assert rx == pytest.approx(15e6) and tx == 0  # (10 + 20) / 2
    assert monitor.rate(120, clock.now + 3600) == (None, None)


def test_steady_rate_waits_for_most_of_the_window(tmp_path):
    monitor, clock = make(tmp_path)
    feed(monitor, clock, [(i * 1_000_000, 0) for i in range(5)])  # 4 samples of a 10-minute window
    assert monitor.steady_rate(600, clock.now) == (None, None)
    feed(monitor, clock, [(i * 1_000_000 + 5_000_000, 0) for i in range(36)])
    assert monitor.steady_rate(600, clock.now)[0] is not None


def test_totals_are_exact_sums_of_the_buckets(tmp_path):
    monitor, clock = make(tmp_path)
    feed(monitor, clock, [(0, 0), (10_000_000, 1_000_000)], every=15)
    clock.now = T0 + 2 * wan.BUCKET
    feed(monitor, clock, [(10_000_000, 1_000_000), (30_000_000, 3_000_000)])  # the gap before it is a baseline, not counted
    assert monitor.totals(86400, clock.now) == (10_000_000 + 20_000_000, 1_000_000 + 2_000_000)


def test_the_two_hour_trend_comes_from_the_live_samples_in_minute_steps(tmp_path):
    monitor, clock = make(tmp_path)
    feed(monitor, clock, [(i * 1_875_000, 0) for i in range(9)])  # 1.875 MB every 15 s is 1 Mbit/s
    points = monitor.trend("2h", clock.now)
    assert [p["t"] - T0 for p in points] == [0, 60, 120]
    assert all(p["rx"] == pytest.approx(1_000_000, rel=0.01) for p in points)


def test_a_longer_trend_is_bytes_over_the_time_the_buckets_cover_and_the_filling_bucket_counts_only_what_it_has(tmp_path):
    monitor, clock = make(tmp_path)
    monitor.buckets = {T0: [75_000_000, 0, 0, 0], T0 + wan.BUCKET: [3_750_000, 0, 0, 0]}  # a full bucket, and one 30 s old
    (point,) = [p for p in monitor.trend("24h", T0 + wan.BUCKET + 30) if p["t"] == T0]
    # 75 MB over 600 s = 1 Mbit/s; the filling bucket: 3.75 MB over 30 s = 1 Mbit/s too
    assert point["rx"] == pytest.approx(1_000_000, rel=0.01)


def test_snapshot_says_what_it_covers_and_never_totals_under_a_day(tmp_path):
    monitor, clock = make(tmp_path)
    monitor.link = {"up": True, "mbps": 100, "kind": "Ethernet", "address": "203.0.113.7"}
    feed(monitor, clock, [(0, 0), (1_000_000, 0), (2_000_000, 0)])
    snap = monitor.snapshot("2h", clock.now)
    assert snap["state"] == "up" and snap["totals_window"] == "24h" and snap["link_mbps"] == 100
    assert snap["rx_bytes"] == 2_000_000 and snap["covers_seconds"] >= 0
    assert snap["address"] == "203.0.113.7"


def test_an_unknown_range_is_refused(tmp_path):
    monitor, _ = make(tmp_path)
    with pytest.raises(ValueError):
        monitor.snapshot("1y")


# ---- keeping it -----------------------------------------------------------------------


def test_buckets_and_the_last_reading_survive_a_restart_and_a_short_gap_is_counted(tmp_path):
    monitor, clock = make(tmp_path)
    feed(monitor, clock, [(0, 0), (1_000_000, 100_000)])
    monitor.save()
    again, _ = make(tmp_path, clock=clock)
    assert set(again.buckets) == set(monitor.buckets)
    assert again.buckets[T0][:2] == monitor.buckets[T0][:2] and again.buckets[T0][2] == pytest.approx(monitor.buckets[T0][2], abs=1)
    again.record(clock.now + 30, 4_000_000, 100_000)  # the restart took 45 s: those bytes are real
    assert again.totals(86400, clock.now + 30)[0] == 4_000_000


def test_a_damaged_file_is_ignored(tmp_path):
    (tmp_path / "wan.json").write_text('{"buckets": {"x": [1, 2], "5": "no"}, "last": "bad"}')
    monitor, _ = make(tmp_path)
    assert monitor.buckets == {} and monitor.last is None


# ---- asking the router -------------------------------------------------------------------

# the shape of the real DIR-822 description: a default namespace, services nested in devices
DESCRIPTION = """<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceList><device><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/soap.cgi?service=WANCommonIFC1</controlURL></service>
</serviceList><deviceList><device><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/soap.cgi?service=WANIPConn1</controlURL></service>
</serviceList></device></deviceList></device></deviceList></device></root>"""


def test_the_services_are_found_in_the_description_and_resolved_against_it():
    found = wan._services(DESCRIPTION, "http://192.168.0.1:49152/InternetGatewayDevice.xml")
    assert found == {"common": "http://192.168.0.1:49152/soap.cgi?service=WANCommonIFC1",
                     "ip": "http://192.168.0.1:49152/soap.cgi?service=WANIPConn1"}


def test_an_unreadable_description_is_an_error_not_a_crash():
    with pytest.raises(WanError):
        wan._services("<root", "http://192.168.0.1/x")


def discover(monkeypatch, location, xml=DESCRIPTION, ip="192.168.0.1"):
    monkeypatch.setattr(wan, "_ssdp", lambda ip: location)
    monkeypatch.setattr(wan, "_text", lambda url: xml)
    router = wan.Router(ip)
    router.discover()
    return router


def test_discovery_works_from_the_gateways_own_answer(monkeypatch):
    router = discover(monkeypatch, "http://192.168.0.1:49152/InternetGatewayDevice.xml")
    assert "common" in router.controls


def test_a_description_that_points_at_another_machine_is_never_followed(monkeypatch):
    with pytest.raises(WanError, match="somewhere else"):
        discover(monkeypatch, "http://203.0.113.9/desc.xml")


def test_a_control_url_on_another_machine_is_dropped(monkeypatch):
    evil = DESCRIPTION.replace("/soap.cgi?service=WANCommonIFC1", "http://203.0.113.9/steal")
    with pytest.raises(WanError, match="no WAN counters"):
        discover(monkeypatch, "http://192.168.0.1:49152/d.xml", xml=evil)


def test_a_router_that_does_not_answer_says_so(monkeypatch):
    monkeypatch.setattr(wan, "_ssdp", lambda ip: None)
    monkeypatch.setattr(wan, "_probe", lambda ip: None)
    with pytest.raises(WanError, match="doesn't answer UPnP"):
        wan.Router("192.168.0.1").discover()


def test_when_discovery_is_swallowed_by_docker_the_usual_addresses_are_tried(monkeypatch):
    """From inside a container the router's SSDP reply (from another port) is dropped by NAT."""
    monkeypatch.setattr(wan, "_ssdp", lambda ip: None)
    monkeypatch.setattr(wan, "_is_gateway_description", lambda url: url == "http://192.168.0.1:49152/InternetGatewayDevice.xml")
    monkeypatch.setattr(wan, "_text", lambda url: DESCRIPTION)
    router = wan.Router("192.168.0.1")
    router.discover()
    assert router.controls["common"].startswith("http://192.168.0.1:49152/")


def test_the_probe_only_ever_asks_the_router_itself(monkeypatch):
    asked = []
    monkeypatch.setattr(wan, "_is_gateway_description", lambda url: asked.append(url) or False)
    assert wan._probe("192.168.0.1") is None
    assert asked and all(u.startswith("http://192.168.0.1:") for u in asked)


def test_only_a_gateway_description_counts_as_one(monkeypatch):
    class Body:
        def __init__(self, data):
            self.data = data
        def read(self, n, decode_content=True):
            return self.data

    class Resp:
        ok = True
        def __init__(self, data):
            self.raw = Body(data)
        def close(self):
            pass

    monkeypatch.setattr(wan.requests, "get", lambda *a, **k: Resp(b"<root>...InternetGatewayDevice...</root>"))
    assert wan._is_gateway_description("http://192.168.0.1:49152/x.xml") is True
    monkeypatch.setattr(wan.requests, "get", lambda *a, **k: Resp(b"<html>a router login page</html>"))
    assert wan._is_gateway_description("http://192.168.0.1:49152/x.xml") is False
    monkeypatch.setattr(wan.requests, "get", lambda *a, **k: (_ for _ in ()).throw(wan.requests.ConnectionError("refused")))
    assert wan._is_gateway_description("http://192.168.0.1:49152/x.xml") is False


class Reply:
    def __init__(self, text, status=200):
        self.text, self.status_code = text, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


def soap(**values):
    inner = "".join(f"<{k}>{v}</{k}>" for k, v in values.items())
    return Reply(f"<s:Envelope><s:Body><u:Resp>{inner}</u:Resp></s:Body></s:Envelope>")


def router_with(monkeypatch, answers):
    router = wan.Router("192.168.0.1")
    router.controls = {"common": "http://192.168.0.1/c", "ip": "http://192.168.0.1/i"}
    asked = []

    def post(url, data, timeout, headers):
        action = headers["SOAPAction"].split("#")[1].strip('"')
        asked.append(action)
        return answers[action]

    monkeypatch.setattr(wan.requests, "post", post)
    return router, asked


def test_counters_are_read_with_two_get_calls_and_nothing_else(monkeypatch):
    router, asked = router_with(monkeypatch, {"GetTotalBytesReceived": soap(NewTotalBytesReceived=496224621),
                                              "GetTotalBytesSent": soap(NewTotalBytesSent=1334774425)})
    assert router.counters() == (496224621, 1334774425)
    assert all(a.startswith("Get") for a in asked)


def test_the_link_is_its_state_its_slower_direction_and_its_public_address(monkeypatch):
    router, _ = router_with(monkeypatch, {
        "GetCommonLinkProperties": soap(NewWANAccessType="Ethernet", NewLayer1UpstreamMaxBitRate=100000000,
                                        NewLayer1DownstreamMaxBitRate=1000000000, NewPhysicalLinkStatus="Up"),
        "GetExternalIPAddress": soap(NewExternalIPAddress="203.0.113.7")})
    assert router.link() == {"up": True, "mbps": 100, "kind": "Ethernet", "address": "203.0.113.7"}


def test_a_link_reported_down_is_down(monkeypatch):
    router, _ = router_with(monkeypatch, {"GetCommonLinkProperties": soap(NewPhysicalLinkStatus="Down"),
                                          "GetExternalIPAddress": soap(NewExternalIPAddress="")})
    assert router.link()["up"] is False and router.link()["address"] is None


def test_a_router_error_is_a_wan_error(monkeypatch):
    router = wan.Router("192.168.0.1")
    router.controls = {"common": "http://192.168.0.1/c"}
    monkeypatch.setattr(wan.requests, "post", lambda *a, **k: Reply("", 500))
    with pytest.raises(WanError):
        router.counters()


# ---- polling ---------------------------------------------------------------------------------


def test_a_poll_reads_the_link_then_the_counters(tmp_path):
    router = FakeRouter([(100, 10), (200, 20)])
    monitor, clock = make(tmp_path, router)
    monitor.poll()
    clock.now += 15
    monitor.poll()
    assert monitor.error is None and monitor.link["mbps"] == 100 and monitor.buckets[T0][0] == 100


def test_a_router_that_cannot_be_found_is_asked_again_in_minutes_not_seconds(tmp_path):
    attempts = []

    def connect():
        attempts.append(1)
        raise WanError("192.168.0.1 doesn't answer UPnP")

    monitor, clock = make(tmp_path, connect=connect)
    monitor.poll()
    clock.now += 15
    monitor.poll()
    assert len(attempts) == 1 and "UPnP" in monitor.error
    clock.now += wan.RETRY_SECONDS
    monitor.poll()
    assert len(attempts) == 2


def test_a_failing_read_reconnects_on_the_next_poll(tmp_path):
    routers = [FakeRouter(fail=WanError("timeout")), FakeRouter([(5, 5)])]
    monitor, clock = make(tmp_path, connect=lambda: routers.pop(0))
    monitor.poll()
    assert monitor.error == "timeout"
    clock.now += 15
    monitor.poll()
    assert monitor.error is None and monitor.last[1:] == (5, 5)


# ---- alerts ------------------------------------------------------------------------------------


def snap(state="up", link=100):
    return {"state": state, "link_mbps": link}


def test_a_link_the_router_reports_down_is_a_bad_alert():
    assert wan.evaluate(snap("down"))["network:wan-down"]["severity"] == "bad"


def test_a_link_that_is_nearly_full_for_ten_minutes_is_a_warning():
    out = wan.evaluate(snap(), rx_avg=95e6, tx_avg=1e6)
    assert out["network:wan-full"]["severity"] == "warn" and "95%" in out["network:wan-full"]["message"]
    assert wan.evaluate(snap(), rx_avg=50e6, tx_avg=1e6) == {}
    assert wan.evaluate(snap(), rx_avg=None, tx_avg=None) == {}  # not enough samples to say


def test_nothing_is_said_while_the_router_cannot_be_asked():
    assert wan.evaluate(snap("unavailable"), rx_avg=99e6, tx_avg=0) == {}


# ---- next to the switch -------------------------------------------------------------------------

PORTS = {
    "state": "up", "reachable": True, "updated_at": 1.0,
    "ports": [
        {"index": 1, "name": "router", "port": "g1", "labelled": True, "up": True, "speed_mbps": 100,
         "sent_bps": 300_000, "received_bps": 200_000},  # the router sends the switch 0.3 Mbit/s
        {"index": 2, "name": "Bigboy", "port": "g2", "labelled": True, "up": True, "speed_mbps": 1000,
         "sent_bps": 1_000, "received_bps": 100_000},
    ],
}


def fed_monitor(monkeypatch, tmp_path, rx_mbit=3.0, seconds=86400 + 60):
    monitor, clock = make(tmp_path)
    monitor.link = {"up": True, "mbps": 100, "kind": "Ethernet", "address": "203.0.113.7"}
    step = int(rx_mbit * MBIT * 15)
    count = seconds // 15
    for i in range(count + 1):
        monitor.record(clock.now, i * step, i * step // 30)
        clock.now += 15
    monkeypatch.setattr(wan, "monitor", monitor)
    return monitor, clock


def test_the_internet_row_is_the_routers_own_counters_not_the_switch_port(monkeypatch, tmp_path):
    fed_monitor(monkeypatch, tmp_path)
    snapshot = bandwidth.Bandwidth().snapshot(PORTS)
    rows = {d["name"]: d for d in snapshot["devices"]}
    assert "router" not in rows  # the port to the router is not the internet
    internet = rows["Internet"]
    assert internet["wan"] and internet["uplink"] and internet["speed_mbps"] == 100
    assert internet["down_bps"] == pytest.approx(3e6, rel=0.02)
    assert snapshot["wan"]["state"] == "up"


def test_what_the_switch_did_not_carry_is_its_own_derived_row(monkeypatch, tmp_path):
    fed_monitor(monkeypatch, tmp_path, rx_mbit=3.0)
    snapshot = bandwidth.Bandwidth().snapshot(PORTS)
    other = {d["name"]: d for d in snapshot["devices"]}["Not on the switch"]
    assert other["derived"] and other["down_bps"] == pytest.approx(3e6 - 300_000, rel=0.03)
    assert other["up_bps"] is None  # the upload side can't be told apart from LAN traffic, so it isn't guessed


def test_the_derived_total_is_withheld_until_the_router_has_been_counted_for_the_whole_window(monkeypatch, tmp_path):
    fed_monitor(monkeypatch, tmp_path, seconds=3600)  # an hour of counting against a 24 h window
    snapshot = bandwidth.Bandwidth().snapshot(PORTS)
    rows = {d["name"]: d for d in snapshot["devices"]}
    assert rows["Not on the switch"]["down_24h"] is None
    assert rows["Internet"]["totals_partial"] is True


def test_without_a_router_the_switch_port_stays_the_uplink(monkeypatch):
    snapshot = bandwidth.Bandwidth().snapshot(PORTS)  # the autouse router can't be reached
    names = [d["name"] for d in snapshot["devices"]]
    assert names == ["router", "Bigboy"] and snapshot["wan"] is None


def test_the_speed_test_is_busy_when_the_router_says_the_line_is(monkeypatch, tmp_path):
    fed_monitor(monkeypatch, tmp_path, rx_mbit=60.0, seconds=300)  # 60 of 100 Mbit/s, all of it on Wi-Fi
    assert speedtest.line_usage({"ports": []}) > speedtest.BUSY_AT


def test_the_speed_test_falls_back_to_the_switch_port_without_a_router():
    ports = {"ports": [{"name": "router", "up": True, "usage": 0.5, "speed_mbps": 100}]}
    assert speedtest.line_usage(ports) == 0.5


# ---- routes ------------------------------------------------------------------------------------------


def test_the_wan_route_serves_the_snapshot_and_validates_the_range(monkeypatch, tmp_path):
    fed_monitor(monkeypatch, tmp_path, seconds=600)
    client = TestClient(main.app)
    body = client.get("/api/wan?range=24h").json()
    assert body["state"] == "up" and body["range"] == "24h"
    assert client.get("/api/wan?range=1y").status_code == 400
