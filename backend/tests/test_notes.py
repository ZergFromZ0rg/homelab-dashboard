import json

import pytest
from fastapi.testclient import TestClient

from backend import main, notes as notes_module
from backend.notes import Conflict, NoteStore


@pytest.fixture
def store(tmp_path):
    return NoteStore(tmp_path / "notes.json")


# --- store ---------------------------------------------------------------------


def test_create_list_and_get(store):
    note = store.create("hello")
    assert note["body"] == "hello" and len(note["id"]) == 12
    assert note["created_at"] == note["updated_at"]
    assert store.get(note["id"]) == note
    assert store.all() == [note]
    assert store.get("nope") is None


def test_empty_notes_are_allowed_so_a_new_note_can_be_started_blank(store):
    assert store.create()["body"] == ""


def test_notes_are_listed_newest_edit_first(store):
    a = store.create("a")
    b = store.create("b")
    assert [n["id"] for n in store.all()] == [b["id"], a["id"]]
    store.update(a["id"], "a edited")
    assert [n["id"] for n in store.all()] == [a["id"], b["id"]]


def test_update_bumps_the_version_only_when_the_text_changes(store):
    note = store.create("one")
    same = store.update(note["id"], "one")
    assert same["updated_at"] == note["updated_at"]

    changed = store.update(note["id"], "two")
    assert changed["body"] == "two" and changed["updated_at"] > note["updated_at"]


def test_line_endings_are_normalised(store):
    note = store.create("a\r\nb\rc")
    assert note["body"] == "a\nb\nc"


def test_body_must_be_text_and_within_the_limit(store):
    for bad in (None, 5, ["x"], {"a": 1}):
        with pytest.raises(ValueError):
            store.create(bad)
    with pytest.raises(ValueError):
        store.create("x" * (notes_module.MAX_BODY_LENGTH + 1))
    assert store.create("x" * notes_module.MAX_BODY_LENGTH)


def test_note_limit(store, monkeypatch):
    monkeypatch.setattr(notes_module, "MAX_NOTES", 2)
    store.create("1")
    store.create("2")
    with pytest.raises(ValueError):
        store.create("3")


def test_saving_a_stale_version_is_a_conflict_and_changes_nothing(store):
    note = store.create("v1")
    mine = store.update(note["id"], "edited on the phone", note["updated_at"])

    with pytest.raises(Conflict) as info:
        store.update(note["id"], "edited on the desktop", note["updated_at"])   # still based on v1

    assert info.value.current["body"] == "edited on the phone"
    assert store.get(note["id"])["body"] == "edited on the phone"
    # Based on the current version, it goes through.
    assert store.update(note["id"], "desktop, after reload", mine["updated_at"])["body"] == "desktop, after reload"


def test_saving_without_a_base_version_overwrites(store):
    note = store.create("v1")
    store.update(note["id"], "v2", note["updated_at"])
    assert store.update(note["id"], "forced")["body"] == "forced"


def test_update_and_delete_of_missing_notes(store):
    assert store.update("nope", "x") is None
    assert store.delete("nope") is False
    note = store.create("x")
    assert store.delete(note["id"]) is True
    assert store.all() == []


def test_notes_survive_a_restart(tmp_path):
    first = NoteStore(tmp_path / "n.json")
    note = first.create("keep me")
    first.update(note["id"], "keep me, edited")

    second = NoteStore(tmp_path / "n.json")
    assert second.get(note["id"])["body"] == "keep me, edited"


def test_a_corrupt_or_odd_file_is_survived(tmp_path):
    path = tmp_path / "n.json"
    path.write_text("{not json")
    assert NoteStore(path).all() == []

    path.write_text(json.dumps([
        {"id": "a", "body": "ok", "created_at": 1, "updated_at": 2},
        {"id": 5, "body": "bad id"},
        {"id": "b", "body": 42},
        "junk",
        {"id": "c", "body": "no times"},
    ]))
    loaded = {n["id"]: n for n in NoteStore(path).all()}
    assert set(loaded) == {"a", "c"}
    assert loaded["c"]["updated_at"] > 0


# --- API -----------------------------------------------------------------------------


@pytest.fixture
def client(store, monkeypatch):
    monkeypatch.setattr(main, "notes", store)
    return TestClient(main.app)


def test_api_starts_empty_and_creates(client):
    assert client.get("/api/notes").json() == {"notes": []}
    created = client.post("/api/notes", json={"body": "first"})
    assert created.status_code == 201 and created.json()["body"] == "first"
    assert client.post("/api/notes").json()["body"] == ""          # no body at all = blank note
    assert len(client.get("/api/notes").json()["notes"]) == 2


def test_api_save_and_conflict_flow(client):
    note = client.post("/api/notes", json={"body": "v1"}).json()

    saved = client.put(f"/api/notes/{note['id']}", json={"body": "v2", "base_updated_at": note["updated_at"]})
    assert saved.status_code == 200 and saved.json()["body"] == "v2"

    stale = client.put(f"/api/notes/{note['id']}", json={"body": "v3", "base_updated_at": note["updated_at"]})
    assert stale.status_code == 409
    body = stale.json()
    assert body["current"]["body"] == "v2"
    assert body["current"]["updated_at"] == saved.json()["updated_at"]
    assert "somewhere else" in body["detail"]


def test_api_validation_and_missing(client):
    note = client.post("/api/notes", json={"body": "x"}).json()
    assert client.put(f"/api/notes/{note['id']}", json={}).status_code == 400
    assert client.put(f"/api/notes/{note['id']}", json={"body": "y" * 20_001}).status_code == 400
    assert client.put(f"/api/notes/{note['id']}", json={"body": "y", "base_updated_at": "soon"}).status_code == 400
    assert client.put(f"/api/notes/{note['id']}", json={"body": "y", "base_updated_at": True}).status_code == 400
    assert client.put("/api/notes/nope", json={"body": "y"}).status_code == 404
    assert client.delete("/api/notes/nope").status_code == 404
    assert client.post("/api/notes", json={"body": 5}).status_code == 400


def test_api_delete(client):
    note = client.post("/api/notes", json={"body": "bye"}).json()
    assert client.delete(f"/api/notes/{note['id']}").json() == {"deleted": note["id"]}
    assert client.get("/api/notes").json() == {"notes": []}
