import pytest
from fastapi.testclient import TestClient

from backend import auth
from backend import main
from backend import self_update


@pytest.fixture
def client():
    return TestClient(main.app)


def test_get_status_delegates_to_self_update(client, monkeypatch):
    monkeypatch.setattr(self_update, "status", lambda: {"available": False, "state": "unavailable"})
    resp = client.get("/api/self-update")
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "state": "unavailable"}


def test_post_triggers_when_open(client, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(self_update, "trigger", lambda: {"started": True})
    resp = client.post("/api/self-update")
    assert resp.status_code == 200
    assert resp.json() == {"started": True}


def test_post_requires_token_when_set(client, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")
    resp = client.post("/api/self-update")
    assert resp.status_code == 401

    monkeypatch.setattr(self_update, "trigger", lambda: {"started": True})
    resp = client.post("/api/self-update", headers={"X-Register-Token": "s3cret"})
    assert resp.status_code == 200


def test_post_returns_409_when_unavailable(client, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "")

    def _raise():
        raise RuntimeError("HOST_REPO_PATH isn't set")

    monkeypatch.setattr(self_update, "trigger", _raise)
    resp = client.post("/api/self-update")
    assert resp.status_code == 409
    assert "HOST_REPO_PATH" in resp.json()["detail"]
