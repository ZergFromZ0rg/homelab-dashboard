import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.todos import TodoStore


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "todos", TodoStore(tmp_path / "todos.json"))
    return TestClient(main.app)


def test_get_starts_empty(client):
    assert client.get("/api/todos").json() == {"todos": []}


def test_put_replaces_and_persists(client):
    resp = client.put(
        "/api/todos",
        json={"todos": [{"id": "a", "text": "wire rack", "done": False}]},
    )
    assert resp.status_code == 200
    body = resp.json()["todos"]
    assert body[0]["text"] == "wire rack" and body[0]["id"] == "a"
    assert client.get("/api/todos").json()["todos"][0]["text"] == "wire rack"


def test_put_rejects_non_list(client):
    assert client.put("/api/todos", json={"todos": "nope"}).status_code == 400
    assert client.put("/api/todos", json={}).status_code == 400
