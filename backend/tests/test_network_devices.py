"""The device table's merge: one row per MAC, names from the strongest source,
servers recognised from your static leases, Pi-hole's own rows hidden."""

import pytest
from fastapi.testclient import TestClient

from backend import auth, device_meta, device_names, main, network_devices, pihole

NOW = 1_000_000.0
PHONE, TABLET, BIGBOY, SWITCH, RANDOM, OLD = (
    "ec:73:79:93:bb:1b", "ea:d6:19:43:81:b6", "74:56:3c:98:7b:21", "a0:63:91:95:47:21", "be:56:d7:90:93:f8",
    "11:22:33:44:55:66",
)


def device(mac, ip, name=None, last=NOW - 60, queries=10, vendor="Apple, Inc."):
    return {"mac": mac, "vendor": vendor, "first_seen": NOW - 5000, "last_query": last, "queries": queries,
            "ips": [{"ip": ip, "name": name or "", "last_seen": last}]}


def inputs(**over):
    base = {
        "devices": [
            device(PHONE, "192.168.0.211", "Shitty-Virus-40.lan"),
            device(TABLET, "192.168.0.229", "Galaxy-Tab-A7.lan", vendor=""),
            device(BIGBOY, "192.168.0.246", "bigboy.lan", vendor="Giga-Byte"),
            device(RANDOM, "192.168.0.242", None, vendor=""),
            device(OLD, "192.168.0.99", "gone.lan", last=NOW - 30 * 86400),
            device("ip-127.0.0.1", "127.0.0.1", "localhost"),
            device("ip-192.168.0.132", "192.168.0.132", "pi.hole"),
        ],
        "leases": [
            {"mac": PHONE, "ip": "192.168.0.211", "name": "Shitty-Virus-40", "expires": NOW + 600},
            {"mac": TABLET, "ip": "192.168.0.229", "name": "Galaxy-Tab-A7", "expires": NOW + 600},
            {"mac": RANDOM, "ip": "192.168.0.242", "name": "*", "expires": NOW + 600},
        ],
        "extras": {
            "clients": {PHONE: {"comment": "iPad Air", "groups": [3]}},
            "groups": {0: "Default", 3: "personal"},
            "static": [
                {"mac": BIGBOY, "ip": "192.168.0.246", "name": "bigboy"},
                {"mac": SWITCH, "ip": "192.168.0.109", "name": "netgear"},
                {"mac": "5c:ff:35:08:84:ee", "ip": "192.168.0.132", "name": "thinkpad"},
            ],
            "queries": {"192.168.0.211": 200, "192.168.0.246": 40},
            "blocked": {"192.168.0.211": 50},
        },
    }
    base.update(over)
    return base


def rows(names=None, meta=None, **over):
    return {r["mac"]: r for r in network_devices.merge(inputs(**over), names or {}, meta or {}, NOW)}


def test_name_prefers_your_label_then_pihole_comment_then_hostname_then_vendor():
    assert rows()[PHONE]["name"] == "iPad Air" and rows()[PHONE]["name_source"] == "pihole"
    assert rows(names={PHONE: "Kid's iPad"})[PHONE]["name"] == "Kid's iPad"
    assert rows()[TABLET]["name"] == "Galaxy-Tab-A7"
    assert rows()[RANDOM]["name"] == RANDOM  # no name, no vendor: the MAC itself
    assert rows()[RANDOM]["private_mac"] is True


def test_static_leases_make_servers_even_without_dns_traffic():
    r = rows()
    assert r[BIGBOY]["kind"] == "server" and r[BIGBOY]["ip_type"] == "static-lease"
    # the switch never asks DNS, but it is in your reservations, so it is listed
    assert r[SWITCH]["name"] == "netgear" and r[SWITCH]["online"] is None
    # the thinkpad shows up in Pi-hole only as its own "ip-" row; it keeps its real MAC
    assert r["5c:ff:35:08:84:ee"]["name"] == "thinkpad"
    assert r["5c:ff:35:08:84:ee"]["queries_24h"] is None


def test_pihole_own_rows_never_become_devices():
    assert not [m for m in rows() if m.startswith("ip-")]
    assert rows()["5c:ff:35:08:84:ee"]["ghost"] == ""  # a server, so it is listed


def test_only_reservations_count_as_static():
    r = rows(leases=[])  # every lease lapsed: the phone is away, not "static"
    assert r[PHONE]["ip_type"] == "dynamic"
    assert r[BIGBOY]["ip_type"] == "static-lease"


def test_kind_label_wins_then_group():
    assert rows()[PHONE]["kind"] == "personal" and rows()[PHONE]["kind_source"] == "Pi-hole group"
    assert rows(meta={PHONE: {"kind": "media", "notes": "bedroom"}})[PHONE]["kind"] == "media"
    assert rows(meta={PHONE: {"kind": "media", "notes": "bedroom"}})[PHONE]["notes"] == "bedroom"
    assert rows()[TABLET]["kind"] == "unknown"


def test_online_needs_a_recent_query_and_an_active_lease():
    r = rows()
    assert r[PHONE]["online"] is True
    gone = rows(devices=[device(PHONE, "192.168.0.211", last=NOW - 3600)], leases=inputs()["leases"])
    assert gone[PHONE]["online"] is False
    expired = rows(leases=[{"mac": PHONE, "ip": "192.168.0.211", "name": "x", "expires": NOW - 5}])
    assert expired[PHONE]["online"] is False


def test_block_rate_and_counts():
    r = rows()[PHONE]
    assert (r["queries_24h"], r["blocked_24h"], r["block_rate"]) == (200, 50, 25.0)
    assert rows()[BIGBOY]["block_rate"] == 0.0
    assert rows()[TABLET]["block_rate"] is None


def test_old_unleased_devices_are_ghosts():
    assert rows()[OLD]["ghost"] == "stale"
    assert rows()[PHONE]["ghost"] == ""


def test_servers_sort_first():
    merged = network_devices.merge(inputs(), {}, {}, NOW)
    assert [r["kind"] for r in merged[:3]] == ["server"] * 3


@pytest.fixture
def web(monkeypatch, tmp_path):
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(device_names, "names", device_names.NameStore(tmp_path / "names.json"))
    monkeypatch.setattr(device_meta, "meta", device_meta.MetaStore(tmp_path / "meta.json"))
    collector = pihole.Pihole("http://pi:8053", "x")
    monkeypatch.setattr(collector, "device_inputs", lambda: {**inputs(), "updated_at": NOW})
    monkeypatch.setattr(pihole, "collector", collector)
    return TestClient(main.app)


def test_labelling_a_device_sticks(web):
    assert web.put(f"/api/pihole/devices/{TABLET.upper()}", json={"name": "Galaxy Tablet", "kind": "personal", "notes": "kitchen"}).status_code == 200
    row = next(d for d in web.get("/api/pihole/devices").json()["devices"] if d["mac"] == TABLET)
    assert (row["name"], row["kind"], row["notes"]) == ("Galaxy Tablet", "personal", "kitchen")
    # a blank clears each field back to its default
    web.put(f"/api/pihole/devices/{TABLET}", json={"name": "", "kind": "", "notes": ""})
    row = next(d for d in web.get("/api/pihole/devices").json()["devices"] if d["mac"] == TABLET)
    assert (row["name"], row["kind"], row["notes"]) == ("Galaxy-Tab-A7", "unknown", "")


def test_a_bad_kind_is_refused(web):
    assert web.put(f"/api/pihole/devices/{TABLET}", json={"kind": "toaster"}).status_code == 400
