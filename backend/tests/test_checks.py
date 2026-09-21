import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from backend import alerts, auth, checks, main
from backend.checks import CheckService, CheckStore, Result, build_spec, probe


class SyncExecutor:
    """Runs submitted work inline so scheduling tests are deterministic."""

    def submit(self, fn, *args):
        fn(*args)


def make_service(tmp_path, prober=None, **kw):
    store = CheckStore(tmp_path / "checks.json")
    return CheckService(
        store=store,
        history_path=tmp_path / "history.json",
        prober=prober or (lambda spec: Result(True, 12.0, "ok")),
        executor=SyncExecutor(),
        **kw,
    )


def add(service, **kw):
    payload = {"name": "web", "type": "http", "target": "example.com"}
    payload.update(kw)
    return service.store.create(payload)


# --- validation ----------------------------------------------------------------


def test_defaults_and_normalisation():
    spec = build_spec({"name": "  My   Site ", "type": "http", "target": "example.com/health"})
    assert spec["name"] == "My Site"
    assert spec["target"] == "https://example.com/health"
    assert (spec["interval"], spec["timeout"]) == (60, 5.0)
    assert spec["verify_tls"] is True and spec["paused"] is False
    assert len(spec["id"]) == 12


@pytest.mark.parametrize("raw,expected", [
    ("192.168.1.10:8096", "http://192.168.1.10:8096"),
    ("router", "http://router"),
    ("nas.local:5000/x", "http://nas.local:5000/x"),
    ("jellyfin.example.com", "https://jellyfin.example.com"),
    ("https://a.b/c", "https://a.b/c"),
    ("http://a.b", "http://a.b"),
])
def test_http_scheme_defaults(raw, expected):
    assert build_spec({"name": "x", "type": "http", "target": raw})["target"] == expected


@pytest.mark.parametrize("raw", ["", "  ", "ftp://x.y", "file:///etc/passwd", "http://", "a b.c",
                                 "javascript:alert(1)", "http://x:99999", "x" * 600])
def test_bad_http_targets_are_rejected(raw):
    with pytest.raises(ValueError):
        build_spec({"name": "x", "type": "http", "target": raw})


def test_tcp_and_dns_targets():
    assert build_spec({"name": "ssh", "type": "tcp", "target": "192.168.1.10:22"})["target"] == "192.168.1.10:22"
    assert build_spec({"name": "d", "type": "dns", "target": "Example.com."})["target"] == "Example.com"
    for bad in ("nas", "nas:0", "nas:70000", "nas:abc", ":22", "bad host:22"):
        with pytest.raises(ValueError):
            build_spec({"name": "x", "type": "tcp", "target": bad})
    for bad in ("", "a b", "exa$mple.com"):
        with pytest.raises(ValueError):
            build_spec({"name": "x", "type": "dns", "target": bad})


def test_numbers_are_range_checked():
    ok = build_spec({"name": "x", "type": "tcp", "target": "h:1", "interval": "30", "timeout": "3"})
    assert (ok["interval"], ok["timeout"]) == (30, 3.0)
    for patch in ({"interval": 5}, {"interval": 99999}, {"timeout": 0}, {"timeout": 99},
                  {"interval": "soon"}, {"timeout": True}, {"interval": 10, "timeout": 20}):
        with pytest.raises(ValueError):
            build_spec({"name": "x", "type": "tcp", "target": "h:1", **patch})


def test_name_type_and_flags_are_validated():
    for bad in ({"name": ""}, {"name": "x" * 61}, {"type": "smtp"}, {"verify_tls": "no"}, {"paused": 1}):
        with pytest.raises(ValueError):
            build_spec({"name": "x", "type": "dns", "target": "a.b", **bad})


def test_expect_status_only_applies_to_http():
    assert build_spec({"name": "x", "type": "http", "target": "a.b", "expect_status": "401"})["expect_status"] == 401
    assert build_spec({"name": "x", "type": "tcp", "target": "a:1", "expect_status": 200})["expect_status"] is None
    with pytest.raises(ValueError):
        build_spec({"name": "x", "type": "http", "target": "a.b", "expect_status": 42})


def test_unknown_fields_and_ids_are_ignored():
    spec = build_spec({"name": "x", "type": "dns", "target": "a.b", "id": "evil", "created_at": 1, "junk": 1})
    assert spec["id"] != "evil" and "junk" not in spec


# --- probes against real local servers -------------------------------------------


PAGES = {
    "/page": (200, b"<html><body>Welcome to <b>Jellyfin</b> media server</body></html>"),
    "/errorpage": (200, b"<html>Fatal error: database connection failed</html>"),
    "/503page": (503, b"<html>Jellyfin is starting up</html>"),
    "/big": (200, b"x" * 4000 + b" NEEDLE"),
    "/unicode": (200, "Bienvenue \u00e0 la m\u00e9diath\u00e8que".encode("utf-8")),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/ok")
            self.end_headers()
        elif self.path == "/loop":
            self.send_response(302)
            self.send_header("Location", "/loop")
            self.end_headers()
        elif self.path == "/slow":
            time.sleep(2.5)
            self.send_response(200)
            self.end_headers()
        elif self.path == "/trickle":
            # Headers promptly, then the body arrives far too late.
            self.send_response(200)
            self.send_header("Content-Length", "10")
            self.end_headers()
            self.wfile.flush()
            time.sleep(3)
        elif self.path in PAGES:
            code, body = PAGES[self.path]
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            code = {"/ok": 200, "/missing": 404, "/boom": 503, "/auth": 401}.get(self.path, 200)
            self.send_response(code)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"hi")

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def http_spec(url, **kw):
    return build_spec({"name": "t", "type": "http", "target": url, "timeout": 1, **kw})


def test_http_up_reports_latency(server):
    result = probe(http_spec(server + "/ok"))
    assert result.ok and result.detail == "HTTP 200"
    assert 0 < result.ms < 1000


def test_http_follows_redirects(server):
    assert probe(http_spec(server + "/redirect")).ok


def test_http_error_status_is_down_but_still_has_a_detail(server):
    result = probe(http_spec(server + "/boom"))
    assert not result.ok and result.detail == "HTTP 503"


def test_http_expected_status_can_make_a_401_healthy(server):
    assert probe(http_spec(server + "/auth", expect_status=401)).ok
    wrong = probe(http_spec(server + "/ok", expect_status=204))
    assert not wrong.ok and "expected 204" in wrong.detail


def test_http_401_is_down_by_default(server):
    assert probe(http_spec(server + "/auth")).ok is False


def test_http_redirect_loop_and_timeout(server):
    assert probe(http_spec(server + "/loop")).detail == "too many redirects"
    slow = probe(http_spec(server + "/slow"))
    assert not slow.ok and "timed out" in slow.detail


def test_http_connection_refused():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    result = probe(http_spec(f"http://127.0.0.1:{port}"))
    assert not result.ok and "refused" in result.detail


def test_tcp_open_and_closed():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        up = probe(build_spec({"name": "t", "type": "tcp", "target": f"127.0.0.1:{port}", "timeout": 1}))
        assert up.ok and up.ms is not None

    down = probe(build_spec({"name": "t", "type": "tcp", "target": f"127.0.0.1:{port}", "timeout": 1}))
    assert not down.ok and down.detail == "connection refused"


def test_dns_resolves_and_fails():
    good = probe(build_spec({"name": "t", "type": "dns", "target": "localhost"}))
    assert good.ok and good.detail.startswith("resolved to")
    bad = probe(build_spec({"name": "t", "type": "dns", "target": "definitely-not-real.invalid"}))
    assert not bad.ok and bad.ms is None


def test_a_crashing_probe_becomes_a_failed_result(monkeypatch):
    def boom(spec):
        raise RuntimeError("kaboom")

    monkeypatch.setitem(checks.__dict__, "_probe_dns", boom)
    result = probe(build_spec({"name": "t", "type": "dns", "target": "a.b"}))
    assert not result.ok and "kaboom" in result.detail


# --- state machine ----------------------------------------------------------------


def test_status_pending_up_down_and_recovery(tmp_path):
    service = make_service(tmp_path)
    spec = add(service)
    t = 1_000_000.0

    assert service.summary(spec, t)["status"] == "pending"

    service.record(spec["id"], Result(True, 20.0, "HTTP 200"), t)
    assert service.summary(spec, t)["status"] == "up"

    service.record(spec["id"], Result(False, None, "HTTP 503"), t + 60)
    assert service.summary(spec, t + 60)["status"] == "up"       # 1 failure: not yet down
    service.record(spec["id"], Result(False, None, "HTTP 503"), t + 120)
    down = service.summary(spec, t + 120)
    assert down["status"] == "down"
    assert down["down_since"] == t + 60
    assert down["detail"] == "HTTP 503"
    assert down["latency_ms"] is None

    service.record(spec["id"], Result(True, 30.0, "HTTP 200"), t + 180)
    up = service.summary(spec, t + 180)
    assert up["status"] == "up" and up["down_since"] is None and up["latency_ms"] == 30.0


def test_paused_checks_are_not_run_and_report_paused(tmp_path):
    calls = []
    service = make_service(tmp_path, prober=lambda s: calls.append(1) or Result(True, 1.0))
    spec = add(service, paused=True)
    assert service.tick(now=100.0) == 0 and calls == []
    assert service.summary(spec, 100.0)["status"] == "paused"


def test_tick_respects_the_interval(tmp_path):
    calls = []
    service = make_service(tmp_path, prober=lambda s: calls.append(1) or Result(True, 1.0))
    add(service, interval=60)

    assert service.tick(now=1000.0) == 1
    assert service.tick(now=1030.0) == 0     # not due yet
    assert service.tick(now=1061.0) == 1
    assert len(calls) == 2


def test_run_now_makes_a_check_due_immediately(tmp_path):
    service = make_service(tmp_path)
    spec = add(service, interval=3600)
    service.tick(now=1000.0)
    assert service.tick(now=1001.0) == 0
    service.run_now(spec["id"])
    assert service.tick(now=1002.0) == 1


def test_uptime_and_average_latency(tmp_path):
    service = make_service(tmp_path)
    spec = add(service)
    t = 2_000_000.0
    for i in range(3):
        service.record(spec["id"], Result(True, 10.0 * (i + 1), "ok"), t + i)
    service.record(spec["id"], Result(False, None, "boom"), t + 3)

    s = service.summary(spec, t + 10)
    assert s["uptime_24h"] == 75.0
    assert s["avg_ms_24h"] == 20.0     # (10+20+30)/3, failures excluded


def test_old_samples_age_out_of_the_windows(tmp_path):
    service = make_service(tmp_path)
    spec = add(service)
    t = 5_000_000.0
    service.record(spec["id"], Result(False, None, "old"), t)
    service.record(spec["id"], Result(True, 5.0, "ok"), t + 3 * 86400)

    s = service.summary(spec, t + 3 * 86400 + 60)
    assert s["uptime_24h"] == 100.0
    assert s["uptime_7d"] == 50.0


def test_recent_is_capped_with_nulls_for_failures(tmp_path):
    service = make_service(tmp_path)
    spec = add(service)
    t = 3_000_000.0
    for i in range(60):
        service.record(spec["id"], Result(i % 10 != 0, 5.0 if i % 10 else None, "x"), t + i)
    recent = service.summary(spec, t + 100)["recent"]
    assert len(recent) == checks.RECENT_POINTS
    assert None in recent and 5.0 in recent


def test_history_buckets(tmp_path):
    service = make_service(tmp_path)
    spec = add(service)
    now = 10 * 86400 + 1800.0
    service.record(spec["id"], Result(True, 40.0, "ok"), now - 100)
    service.record(spec["id"], Result(False, None, "down"), now - 50)

    short = service.history(spec["id"], "3h", now)
    assert short["bucket_seconds"] == 300 and len(short["points"]) == 36
    filled = [p for p in short["points"] if p["n"]]
    assert sum(p["n"] for p in filled) == 2 and sum(p["up"] for p in filled) == 1

    day = service.history(spec["id"], "24h", now)
    assert len(day["points"]) == 24 and day["uptime"] == 50.0
    assert len(service.history(spec["id"], "7d", now)["points"]) == 84
    assert len(service.history(spec["id"], "30d", now)["points"]) == 90

    with pytest.raises(ValueError):
        service.history(spec["id"], "1y", now)
    assert service.history("nope", "24h", now) is None


# --- persistence + editing --------------------------------------------------------


def test_history_survives_a_restart(tmp_path):
    first = make_service(tmp_path)
    spec = add(first)
    now = time.time()
    first.record(spec["id"], Result(True, 25.0, "HTTP 200"), now - 30)
    first.record(spec["id"], Result(False, None, "HTTP 500"), now - 10)
    first.persist()

    second = make_service(tmp_path)
    s = second.summary(spec, now)
    assert s["status"] == "up" and s["failing"] == 1
    assert s["uptime_24h"] == 50.0
    assert s["detail"] == "HTTP 500"


def test_history_for_deleted_checks_is_dropped_on_load(tmp_path):
    first = make_service(tmp_path)
    spec = add(first)
    first.record(spec["id"], Result(True, 1.0, "ok"), time.time())
    first.persist()
    first.store.delete(spec["id"])

    second = make_service(tmp_path)
    assert second._states == {}


def test_a_corrupt_history_file_is_ignored(tmp_path):
    (tmp_path / "history.json").write_text("{not json")
    (tmp_path / "checks.json").write_text("[]")
    make_service(tmp_path)  # must not raise


def test_invalid_stored_checks_are_dropped_not_fatal(tmp_path):
    (tmp_path / "checks.json").write_text(json.dumps([
        {"id": "a", "name": "ok", "type": "dns", "target": "example.com"},
        {"id": "b", "name": "", "type": "dns", "target": "example.com"},
        "garbage",
    ]))
    assert [c["id"] for c in CheckStore(tmp_path / "checks.json").all()] == ["a"]


def test_editing_the_target_resets_history_but_renaming_does_not(tmp_path):
    service = make_service(tmp_path)
    spec = add(service)
    service.record(spec["id"], Result(True, 9.0, "ok"), time.time())

    before, after = service.store.update(spec["id"], {"name": "renamed"})
    service.changed(before, after)
    assert service.summary(after)["status"] == "up"

    before, after = service.store.update(spec["id"], {"target": "https://other.example.com"})
    service.changed(before, after)
    assert service.summary(after)["status"] == "pending"


# --- HTTP API -----------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch):
    service = make_service(tmp_path)
    monkeypatch.setattr(checks, "service", service)
    monkeypatch.setattr(auth, "API_TOKEN", "")
    return TestClient(main.app)


def test_api_crud_roundtrip(client):
    created = client.post("/api/checks", json={"name": "Jellyfin", "type": "http", "target": "192.168.1.5:8096"})
    assert created.status_code == 201
    body = created.json()
    assert body["target"] == "http://192.168.1.5:8096" and body["status"] == "pending"

    assert [c["name"] for c in client.get("/api/checks").json()["checks"]] == ["Jellyfin"]

    updated = client.put(f"/api/checks/{body['id']}", json={"paused": True, "name": "JF"}).json()
    assert updated["paused"] is True and updated["status"] == "paused" and updated["name"] == "JF"

    assert client.post(f"/api/checks/{body['id']}/run").json() == {"queued": body["id"]}
    assert client.delete(f"/api/checks/{body['id']}").json() == {"deleted": body["id"]}
    assert client.get("/api/checks").json() == {"checks": []}


def test_api_validation_and_missing(client):
    bad = client.post("/api/checks", json={"name": "x", "type": "http", "target": "ftp://x"})
    assert bad.status_code == 400 and "http" in bad.json()["detail"]
    assert client.put("/api/checks/nope", json={"name": "x"}).status_code == 404
    assert client.delete("/api/checks/nope").status_code == 404
    assert client.post("/api/checks/nope/run").status_code == 404
    assert client.get("/api/checks/nope/history").status_code == 404


def test_api_history_range_is_validated(client):
    cid = client.post("/api/checks", json={"name": "x", "type": "dns", "target": "example.com"}).json()["id"]
    assert client.get(f"/api/checks/{cid}/history?range=24h").json()["range"] == "24h"
    assert client.get(f"/api/checks/{cid}/history?range=forever").status_code == 400


def test_api_mutations_need_the_token_when_one_is_set(client, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")
    payload = {"name": "x", "type": "dns", "target": "example.com"}

    assert client.post("/api/checks", json=payload).status_code == 401
    assert client.post("/api/checks", json=payload, headers={"X-Register-Token": "wrong"}).status_code == 401
    created = client.post("/api/checks", json=payload, headers={"X-Register-Token": "s3cret"})
    assert created.status_code == 201

    cid = created.json()["id"]
    assert client.put(f"/api/checks/{cid}", json={"paused": True}).status_code == 401
    assert client.delete(f"/api/checks/{cid}").status_code == 401
    assert client.post(f"/api/checks/{cid}/run").status_code == 401
    # Reads stay open.
    assert client.get("/api/checks").status_code == 200
    assert client.get(f"/api/checks/{cid}/history").status_code == 200


def test_check_limit(client, monkeypatch):
    monkeypatch.setattr(checks, "MAX_CHECKS", 2)
    for i in range(2):
        assert client.post("/api/checks", json={"name": f"c{i}", "type": "dns", "target": "a.b"}).status_code == 201
    assert client.post("/api/checks", json={"name": "c3", "type": "dns", "target": "a.b"}).status_code == 400


# --- alerts + Attention panel ------------------------------------------------------------


def down_check(**kw):
    base = {"id": "abc", "name": "Jellyfin", "type": "http", "target": "http://nas:8096",
            "status": "down", "detail": "connection refused", "down_since": 1_000.0}
    base.update(kw)
    return base


def test_a_down_check_is_a_bad_alert_with_a_hint():
    out = alerts.evaluate({}, [], None, [down_check()], now=1_000.0 + 300)
    alert = out["check:abc"]
    assert alert["severity"] == "bad"
    assert "Jellyfin is down" == alert["title"]
    assert "5 min" in alert["message"] and "connection refused" in alert["message"]
    assert "dashboard host" in alert["hint"]


def test_only_down_checks_alert():
    for status in ("up", "pending", "paused"):
        assert alerts.evaluate({}, [], None, [down_check(status=status)]) == {}


def test_check_alerts_fire_and_resolve_through_the_monitor():
    mon = alerts.AlertMonitor(breach_cycles=2)
    events = mon.poll({}, [], None, [down_check()])
    assert [(e["key"], e["status"]) for e in events] == [("check:abc", "firing")]
    events = mon.poll({}, [], None, [down_check(status="up")])
    assert [(e["key"], e["status"]) for e in events] == [("check:abc", "resolved")]


def test_overview_lists_down_checks_with_their_hint():
    ov = main._overview({}, [], set(), None, [down_check()])
    issue = next(i for i in ov["issues"] if i["key"] == "check:abc")
    assert issue["severity"] == "bad"
    assert any("reachable from the dashboard host" in r for r in ov["recommendations"])


# --- keyword checks ------------------------------------------------------------------


def kw_spec(url, keyword, **kw):
    return build_spec({"name": "kw", "type": "keyword", "target": url, "keyword": keyword, "timeout": 1, **kw})


def test_keyword_spec_validation():
    spec = build_spec({"name": "x", "type": "keyword", "target": "nas:8096", "keyword": "  Jellyfin "})
    assert spec["target"] == "http://nas:8096" and spec["keyword"] == "Jellyfin"
    assert spec["keyword_mode"] == "present" and spec["verify_tls"] is True

    for bad in ("", "   ", None, "x" * 201, "two\nlines"):
        with pytest.raises(ValueError):
            build_spec({"name": "x", "type": "keyword", "target": "nas", "keyword": bad})
    with pytest.raises(ValueError):
        build_spec({"name": "x", "type": "keyword", "target": "nas", "keyword": "a", "keyword_mode": "sometimes"})


def test_keyword_is_ignored_on_other_types_and_expect_status_still_applies():
    other = build_spec({"name": "x", "type": "http", "target": "nas", "keyword": "hello", "keyword_mode": "absent"})
    assert other["keyword"] is None and other["keyword_mode"] == "present"
    kw = build_spec({"name": "x", "type": "keyword", "target": "nas", "keyword": "a", "expect_status": 401})
    assert kw["expect_status"] == 401


def test_keyword_found_is_up_and_latency_covers_the_download(server):
    result = probe(kw_spec(server + "/page", "Jellyfin"))
    assert result.ok and result.detail == 'HTTP 200 · found "Jellyfin"'
    assert result.ms is not None


def test_keyword_match_is_case_insensitive_and_handles_unicode(server):
    assert probe(kw_spec(server + "/page", "WELCOME TO")).ok
    assert probe(kw_spec(server + "/unicode", "m\u00e9diath\u00e8que")).ok


def test_keyword_missing_is_down_even_though_the_page_loaded(server):
    result = probe(kw_spec(server + "/page", "Plex"))
    assert not result.ok and result.detail == 'HTTP 200 · "Plex" not found'
    assert result.ms is not None      # we did get an answer; latency is still real


def test_absent_mode_flips_the_condition(server):
    good = probe(kw_spec(server + "/page", "Fatal error", keyword_mode="absent"))
    assert good.ok and "not present" in good.detail
    bad = probe(kw_spec(server + "/errorpage", "Fatal error", keyword_mode="absent"))
    assert not bad.ok and "unwanted text" in bad.detail


def test_a_bad_status_wins_over_the_keyword(server):
    result = probe(kw_spec(server + "/503page", "Jellyfin"))
    assert not result.ok and result.detail == "HTTP 503"   # never even reads the body


def test_expect_status_applies_to_keyword_checks_too(server):
    assert probe(kw_spec(server + "/503page", "starting", expect_status=503)).ok


def test_body_read_is_capped(server, monkeypatch):
    # The keyword sits after 4000 bytes; with a 2 KB cap it must not be found,
    # and the message should say the page was only partly read.
    monkeypatch.setattr(checks, "MAX_BODY_BYTES", 2048)
    result = probe(kw_spec(server + "/big", "NEEDLE"))
    assert not result.ok
    assert result.detail == 'HTTP 200 · "NEEDLE" not found in the first 2 KB'

    monkeypatch.setattr(checks, "MAX_BODY_BYTES", 512 * 1024)
    assert probe(kw_spec(server + "/big", "NEEDLE")).ok


def test_a_server_that_stalls_mid_body_times_out(server):
    result = probe(kw_spec(server + "/trickle", "anything"))
    assert not result.ok and "timed out" in result.detail


def test_keyword_check_reports_connection_errors_like_http():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    result = probe(kw_spec(f"http://127.0.0.1:{port}", "x"))
    assert not result.ok and "refused" in result.detail


# --- ping checks ----------------------------------------------------------------------


import struct


def test_ping_target_validation():
    assert build_spec({"name": "x", "type": "ping", "target": "192.168.1.1"})["target"] == "192.168.1.1"
    assert build_spec({"name": "x", "type": "ping", "target": "router.local"})["target"] == "router.local"
    for bad in ("", "a b", "http://x.y", "1.2.3.4:80", "bad$host"):
        with pytest.raises(ValueError):
            build_spec({"name": "x", "type": "ping", "target": bad})


def test_icmp_checksum_makes_a_packet_verify_to_zero():
    packet = checks._echo_request(0x1234, 7)
    assert checks._icmp_checksum(packet) == 0
    assert packet[0] == 8 and packet[1] == 0                      # echo request
    assert struct.unpack("!HH", packet[4:8]) == (0x1234, 7)


def test_icmp_body_strips_an_ipv4_header_only_when_there_is_one():
    icmp = struct.pack("!BBHHH", 0, 0, 0, 1, 2)
    ip_header = bytes([0x45]) + bytes(19)                          # version 4, IHL 5
    assert checks._icmp_body(ip_header + icmp) == icmp
    assert checks._icmp_body(icmp) == icmp                         # type 0 can't look like 0x4N


class FakeIcmpSocket:
    def __init__(self, replies, raw=False):
        self.replies = list(replies)
        self.sent = None

    def sendto(self, data, addr):
        self.sent = data

    def settimeout(self, value):
        self.timeout = value

    def recvfrom(self, size):
        if not self.replies:
            raise socket.timeout()
        reply = self.replies.pop(0)
        return (reply(self.sent) if callable(reply) else reply), ("127.0.0.1", 0)

    def close(self):
        self.closed = True


def echo_reply(header=b"", ident_delta=0, seq_delta=0):
    def build(sent):
        _t, _c, _s, ident, seq = struct.unpack("!BBHHH", sent[:8])
        return header + struct.pack("!BBHHH", 0, 0, 0, ident + ident_delta, seq + seq_delta) + sent[8:]
    return build


def patch_socket(monkeypatch, replies, raw=False):
    fake = FakeIcmpSocket(replies)
    monkeypatch.setattr(checks, "_open_icmp_socket", lambda: (fake, raw))
    return fake


PING = {"name": "gw", "type": "ping", "target": "127.0.0.1", "timeout": 1}


def test_ping_reply_is_up_with_latency(monkeypatch):
    fake = patch_socket(monkeypatch, [echo_reply()])
    result = probe(build_spec(PING))
    assert result.ok and result.detail == "reply from 127.0.0.1" and result.ms >= 0
    assert fake.closed


def test_ping_reply_with_an_ip_header_is_understood(monkeypatch):
    patch_socket(monkeypatch, [echo_reply(header=bytes([0x45]) + bytes(19))])
    assert probe(build_spec(PING)).ok


def test_ping_ignores_replies_that_are_not_ours_then_times_out(monkeypatch):
    patch_socket(monkeypatch, [echo_reply(seq_delta=1)])
    result = probe(build_spec(PING))
    assert not result.ok and "no reply" in result.detail


def test_raw_sockets_also_match_the_identifier(monkeypatch):
    patch_socket(monkeypatch, [echo_reply(ident_delta=1)], raw=True)
    assert not probe(build_spec(PING)).ok
    patch_socket(monkeypatch, [echo_reply()], raw=True)
    assert probe(build_spec(PING)).ok


def test_ping_destination_unreachable(monkeypatch):
    patch_socket(monkeypatch, [struct.pack("!BBHHH", 3, 1, 0, 0, 0)])
    result = probe(build_spec(PING))
    assert not result.ok and result.detail == "host unreachable"


def test_ping_without_icmp_permission_explains_the_fix(monkeypatch):
    def denied():
        raise PermissionError("nope")

    monkeypatch.setattr(checks, "_open_icmp_socket", denied)
    result = probe(build_spec(PING))
    assert not result.ok and "ping_group_range" in result.detail and "Port check" in result.detail


def test_ping_unresolvable_host():
    result = probe(build_spec({**PING, "target": "definitely-not-real.invalid"}))
    assert not result.ok and "DNS lookup failed" in result.detail


def test_ping_loopback_for_real():
    try:
        sock, _ = checks._open_icmp_socket()
        sock.close()
    except OSError:
        pytest.skip("ICMP sockets aren't permitted in this environment")
    result = probe(build_spec(PING))
    assert result.ok and result.ms < 1000


# --- the new types through the service and API -------------------------------------------


def test_editing_the_keyword_resets_history(tmp_path):
    service = make_service(tmp_path)
    spec = service.store.create({"name": "k", "type": "keyword", "target": "nas", "keyword": "a"})
    service.record(spec["id"], Result(True, 5.0, "ok"), time.time())

    before, after = service.store.update(spec["id"], {"keyword": "b"})
    service.changed(before, after)
    assert service.summary(after)["status"] == "pending"


def test_api_roundtrip_for_keyword_and_ping(client):
    kw = client.post("/api/checks", json={"name": "JF", "type": "keyword", "target": "nas:8096",
                                          "keyword": "Jellyfin", "keyword_mode": "absent"})
    assert kw.status_code == 201
    body = kw.json()
    assert (body["keyword"], body["keyword_mode"], body["type"]) == ("Jellyfin", "absent", "keyword")

    ping = client.post("/api/checks", json={"name": "GW", "type": "ping", "target": "192.168.1.1"})
    assert ping.status_code == 201 and ping.json()["keyword"] is None

    missing = client.post("/api/checks", json={"name": "x", "type": "keyword", "target": "nas"})
    assert missing.status_code == 400 and "text to look for" in missing.json()["detail"]


def test_a_down_keyword_check_alerts_with_its_type_and_reason():
    alert = alerts.evaluate({}, [], None, [down_check(type="keyword", detail='HTTP 200 · "Jellyfin" not found')],
                            now=1_000.0 + 60)["check:abc"]
    assert "keyword" in alert["message"] and "not found" in alert["message"]
