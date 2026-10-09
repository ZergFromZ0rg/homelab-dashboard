"""Saved captures: stored on the data volume, bounded, ids can't escape the
directory, and every way into the contents is token-gated and audited."""

import struct

import pytest
from fastapi.testclient import TestClient

from backend import audit_log, auth, capture_api, capture_store, main
from backend.registry import registry

SNAPSHOT = {
    "state": "done", "iface": "eth0", "filter": {"expr": "tcp"}, "payload": "full", "promisc": True,
    "duration": 60, "started_at": 100.0, "totals": {"pkts": 5000, "bytes": 123456}, "drops": 3,
    "packets": [{"n": 1, "ts": 100.5, "len": 60, "hex": "aabb"}, {"n": 2, "ts": 100.6, "len": 70, "hex": "ccdd"}],
}


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(capture_store, "DIR", tmp_path / "captures")
    return tmp_path / "captures"


def test_save_then_list_open_and_download():
    meta = capture_store.save("thinkpad", "  morning   check ", SNAPSHOT)
    assert meta["name"] == "morning check" and meta["host"] == "thinkpad"
    assert (meta["packets"], meta["total_packets"], meta["bytes"], meta["drops"]) == (2, 5000, 123456, 3)
    assert (meta["payload"], meta["promisc"], meta["filter"]) == ("full", True, {"expr": "tcp"})

    assert [m["id"] for m in capture_store.list_all()] == [meta["id"]]
    opened = capture_store.read(meta["id"])
    assert opened["capture"]["packets"][1]["hex"] == "ccdd" and opened["meta"]["id"] == meta["id"]
    content, found = capture_store.pcap(meta["id"])
    assert content[:4] == bytes.fromhex("d4c3b2a1") and found["name"] == "morning check"
    assert not list(capture_store.DIR.glob("*.pcap"))  # built on request, never stored twice


def test_a_blank_name_gets_a_default_and_an_empty_capture_is_refused():
    assert capture_store.save("bigboy", "", SNAPSHOT)["name"].startswith("bigboy ")
    with pytest.raises(capture_store.StoreError, match="no packets"):
        capture_store.save("bigboy", "x", {**SNAPSHOT, "packets": []})


def test_rename_and_delete():
    cid = capture_store.save("a", "one", SNAPSHOT)["id"]
    assert capture_store.rename(cid, "two")["name"] == "two"
    assert capture_store.list_all()[0]["name"] == "two"
    assert capture_store.delete(cid) is True
    assert capture_store.list_all() == [] and capture_store.read(cid) is None
    assert capture_store.delete(cid) is False


@pytest.mark.parametrize("bad", ["../../etc/passwd", "..", "abc", "ZZZZZZZZZZZZ", "0123456789ab/x", ""])
def test_ids_cannot_reach_other_files(bad, store):
    assert capture_store.read(bad) is None and capture_store.pcap(bad) is None
    assert capture_store.rename(bad, "x") is None and capture_store.delete(bad) is False


def test_the_count_and_size_limits_refuse_rather_than_evict(monkeypatch):
    monkeypatch.setattr(capture_store, "MAX_CAPTURES", 2)
    first = capture_store.save("a", "1", SNAPSHOT)["id"]
    capture_store.save("a", "2", SNAPSHOT)
    with pytest.raises(capture_store.StoreError, match="delete one first"):
        capture_store.save("a", "3", SNAPSHOT)
    assert capture_store.read(first) is not None  # nothing was evicted

    monkeypatch.setattr(capture_store, "MAX_CAPTURES", 50)
    monkeypatch.setattr(capture_store, "MAX_TOTAL_BYTES", 10)
    with pytest.raises(capture_store.StoreError, match="full space"):
        capture_store.save("a", "big", SNAPSHOT)


def _records(data):
    magic, major, minor, _, _, _, link = struct.unpack("<IHHiIII", data[:24])
    out, pos = [], 24
    while pos < len(data):
        sec, usec, caplen, origlen = struct.unpack("<IIII", data[pos:pos + 16])
        out.append((sec, usec, caplen, origlen, data[pos + 16:pos + 16 + caplen]))
        pos += 16 + caplen
    assert pos == len(data)  # no trailing bytes: every record is whole
    return (magic, major, minor, link), out


def test_pcap_is_built_from_the_saved_packets():
    frame = bytes.fromhex("aa" * 6 + "bb" * 6 + "0800") + b"\x45" + bytes(19)
    packets = [{"n": 1, "ts": 1700000000.25, "len": 200, "hex": frame.hex(), "l2": 14}]
    header, records = _records(capture_store.build_pcap(packets))
    assert header == (0xA1B2C3D4, 2, 4, 1)
    assert records == [(1700000000, 250000, len(frame), 200, frame)]  # as short as it was kept, wire length intact


def test_pcap_of_a_tunnel_capture_is_raw_ip_and_a_mixed_one_gets_placeholder_headers():
    ip4, ip6 = b"\x45" + bytes(19), b"\x60" + bytes(39)
    tunnel = [{"ts": 1.0, "len": 20, "hex": ip4.hex(), "l2": 0}]
    assert _records(capture_store.build_pcap(tunnel))[0][3] == 101

    ether = bytes(12) + b"\x08\x00" + ip4
    mixed = [{"ts": 1.0, "len": len(ether), "hex": ether.hex(), "l2": 14}, {"ts": 2.0, "len": 40, "hex": ip6.hex(), "l2": 0}]
    header, records = _records(capture_store.build_pcap(mixed))
    assert header[3] == 1
    assert records[1][4] == bytes(12) + b"\x86\xdd" + ip6 and records[1][3] == 54  # IPv6 ethertype, 14 bytes longer


def test_pcap_skips_a_damaged_packet_and_an_empty_capture_is_just_a_header():
    good = {"ts": 1.0, "len": 4, "hex": "aabbccdd", "l2": 14}
    assert len(_records(capture_store.build_pcap([{"ts": 1.0, "len": 2, "hex": "zz"}, good]))[1]) == 1
    assert _records(capture_store.build_pcap([]))[1] == []


def test_a_damaged_entry_is_skipped_not_fatal(store):
    good = capture_store.save("a", "ok", SNAPSHOT)["id"]
    (store / "deadbeef0000.meta.json").write_text("{not json")
    assert [m["id"] for m in capture_store.list_all()] == [good]


# --- routes --------------------------------------------------------------------

class Reply:
    def __init__(self, status=200, body=None, content=b""):
        self.status_code, self._body, self.content = status, body, content

    def json(self):
        if self._body is None:
            raise ValueError
        return self._body


@pytest.fixture
def web(monkeypatch):
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://agent:8123/"}})
    monkeypatch.setattr(auth, "API_TOKEN", "")
    return TestClient(main.app)


def test_saving_pulls_the_whole_capture_and_its_pcap_from_the_agent(web, monkeypatch):
    calls = []

    def fake(url, **kwargs):
        calls.append((url, kwargs.get("params")))
        return Reply(200, SNAPSHOT)

    monkeypatch.setattr(capture_api.requests, "get", fake)
    out = web.post("/api/capture/box/save", json={"name": "plex weirdness"}).json()
    assert out["name"] == "plex weirdness" and out["host"] == "box" and out["packets"] == 2
    assert calls == [("http://agent:8123/capture", {"after": 0, "limit": 3000})]  # one call: the pcap is built here
    assert web.get("/api/captures").json()["captures"][0]["id"] == out["id"]
    assert web.get(f"/api/captures/{out['id']}").json()["capture"]["totals"]["pkts"] == 5000
    pcap = web.get(f"/api/captures/{out['id']}/pcap")
    assert pcap.content[:4] == bytes.fromhex("d4c3b2a1") and "plex-weirdness.pcap" in pcap.headers["content-disposition"]
    assert web.patch(f"/api/captures/{out['id']}", json={"name": "renamed"}).json()["name"] == "renamed"
    assert web.delete(f"/api/captures/{out['id']}").json() == {"deleted": True}
    assert web.get(f"/api/captures/{out['id']}").status_code == 404


def test_saving_with_nothing_captured_is_a_clear_conflict(web, monkeypatch):
    monkeypatch.setattr(capture_api.requests, "get", lambda url, **k: Reply(200, {"state": "idle"}))
    resp = web.post("/api/capture/box/save", json={})
    assert resp.status_code == 409 and "no capture" in resp.json()["error"]


def test_a_full_store_is_a_conflict_with_the_reason(web, monkeypatch):
    monkeypatch.setattr(capture_api.requests, "get", lambda url, **k: Reply(200, SNAPSHOT))
    monkeypatch.setattr(capture_store, "MAX_CAPTURES", 0)
    resp = web.post("/api/capture/box/save", json={})
    assert resp.status_code == 409 and "delete one first" in resp.json()["error"]


def test_everything_but_the_list_needs_the_token(web, monkeypatch):
    cid = capture_store.save("box", "x", SNAPSHOT)["id"]
    monkeypatch.setattr(auth, "API_TOKEN", "secret")
    for method, path in (("post", "/api/capture/box/save"), ("get", f"/api/captures/{cid}"),
                         ("get", f"/api/captures/{cid}/pcap"), ("patch", f"/api/captures/{cid}"),
                         ("delete", f"/api/captures/{cid}")):
        assert getattr(web, method)(path, **({"json": {}} if method in ("post", "patch") else {})).status_code in (401, 403), path
    assert web.get("/api/captures").status_code == 200  # names and counts, not contents
    assert capture_store.read(cid) is not None


def test_unknown_or_hostile_ids_are_404(web):
    assert web.get("/api/captures/aaaaaaaaaaaa").status_code == 404
    assert web.get("/api/captures/..%2F..%2Fetc").status_code == 404


def test_saving_names_a_refusing_or_old_agent(web, monkeypatch):
    monkeypatch.setattr(capture_api.requests, "get", lambda url, **k: Reply(401))
    assert "AGENT_TOKEN" in web.post("/api/capture/box/save", json={}).json()["error"]
    monkeypatch.setattr(capture_api.requests, "get", lambda url, **k: Reply(404))
    assert "rebuild" in web.post("/api/capture/box/save", json={}).json()["error"]


def test_the_audit_log_names_these_actions():
    assert audit_log.describe("POST", "/api/capture/box/save") == ("packet capture saved", "box")
    assert audit_log.describe("GET", "/api/captures/aaaaaaaaaaaa") == ("saved capture opened", None)
    assert audit_log.describe("DELETE", "/api/captures/aaaaaaaaaaaa")[0] == "saved capture renamed or deleted"
    assert audit_log.describe("GET", "/api/captures/aaaaaaaaaaaa/pcap")[0] == "saved capture downloaded"
    assert any(rx.match("/api/captures/aaaaaaaaaaaa") for rx in audit_log.READS)
    assert any(rx.match("/api/captures/aaaaaaaaaaaa/pcap") for rx in audit_log.READS)
