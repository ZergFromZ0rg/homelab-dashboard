"""The audit log: every mutating request, who made it, what it named —
never what it carried."""

import json

from fastapi.testclient import TestClient

from backend import audit_log, auth, files_api, main
from backend.registry import registry


class Resp:
    status_code = 200
    ok = True

    def json(self):
        return {"success": True}


def entries():
    return audit_log.read(50)


def test_a_change_is_recorded_with_what_it_named_but_not_its_contents(monkeypatch):
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://a:8123"}})
    monkeypatch.setattr(files_api.requests, "request", lambda *a, **k: Resp())
    web = TestClient(main.app)

    web.put("/api/files/box/text", json={"path": "/home/zerg/.env", "content": "PASSWORD=hunter2"})

    [entry] = entries()
    assert entry["action"] == "file edited"
    assert entry["host"] == "box"
    assert entry["target"] == {"path": "/home/zerg/.env"}
    assert entry["who"] == "anonymous" and entry["ok"] is True and entry["status"] == 200
    assert "hunter2" not in json.dumps(entry)


def test_quiet_routes_and_reads_are_not_recorded():
    web = TestClient(main.app)
    web.put("/api/todos", json={"todos": []})
    web.get("/api/nodes")
    web.post("/api/nodes", json={"name": "x", "url": "http://x:1"})  # agent heartbeat
    assert entries() == []


def test_refusals_are_recorded_and_scripts_are_named(monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")
    monkeypatch.setattr(registry, "all", lambda: {"box": {"url": "http://a:8123"}})
    monkeypatch.setattr(files_api.requests, "request", lambda *a, **k: Resp())
    web = TestClient(main.app)

    web.post("/api/files/box/mkdir", json={"path": "/tmp/x"})
    web.post("/api/files/box/mkdir", json={"path": "/tmp/y"}, headers={"X-Register-Token": "s3cret"})

    ok, refused = entries()
    assert refused["ok"] is False and refused["status"] == 401 and refused["who"] == "anonymous"
    assert ok["ok"] is True and ok["who"] == "API token"


def test_read_filters_and_pages(monkeypatch):
    for i in range(5):
        audit_log.record(f"thing {i}", who="me", host="bigboy" if i % 2 else "thinkpad")
    assert [e["action"] for e in audit_log.read(2)] == ["thing 4", "thing 3"]
    assert {e["host"] for e in audit_log.read(10, q="bigboy")} == {"bigboy"}
    before = audit_log.read(1)[0]["at"]
    assert all(e["at"] < before for e in audit_log.read(10, before=before))


def test_rotation_keeps_the_old_file_readable(monkeypatch):
    monkeypatch.setattr(audit_log, "MAX_BYTES", 300)
    for i in range(20):
        audit_log.record(f"n{i}", who="me")
    assert audit_log.FILE.with_suffix(".jsonl.1").exists()
    assert [e["action"] for e in audit_log.read(20)] == [f"n{i}" for i in range(19, -1, -1)]


def test_the_route(monkeypatch):
    audit_log.record("signed in", who="MacBook")
    assert TestClient(main.app).get("/api/audit").json()["entries"][0]["who"] == "MacBook"
