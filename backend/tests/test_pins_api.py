import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.pins import PinStore


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "pins", PinStore(tmp_path / "pins.json"))
    return TestClient(main.app)


def test_get_starts_empty(client):
    assert client.get("/api/pins").json() == {"pins": []}


def test_put_replaces_and_persists(client):
    resp = client.put("/api/pins", json={"pins": ["nas/plex", "nas/plex", "nuc/x"]})
    assert resp.status_code == 200
    assert resp.json() == {"pins": ["nas/plex", "nuc/x"]}
    assert client.get("/api/pins").json() == {"pins": ["nas/plex", "nuc/x"]}


def test_put_rejects_non_list(client):
    assert client.put("/api/pins", json={"pins": "nas/plex"}).status_code == 400
    assert client.put("/api/pins", json={}).status_code == 400
