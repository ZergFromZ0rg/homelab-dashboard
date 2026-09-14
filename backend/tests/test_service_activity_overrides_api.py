import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.service_activity_overrides import ServiceActivityOverrideStore


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(
        main,
        "service_activity_overrides",
        ServiceActivityOverrideStore(tmp_path / "overrides.json"),
    )
    return TestClient(main.app)


def test_get_starts_empty(client):
    assert client.get("/api/service-activity-overrides").json() == {"overrides": {}}


def test_put_replaces_and_persists(client):
    resp = client.put(
        "/api/service-activity-overrides",
        json={"overrides": {"bigboy/torrent-box": "qbittorrent"}},
    )
    assert resp.status_code == 200
    assert resp.json() == {"overrides": {"bigboy/torrent-box": "qbittorrent"}}
    assert client.get("/api/service-activity-overrides").json() == {
        "overrides": {"bigboy/torrent-box": "qbittorrent"}
    }


def test_put_rejects_non_object(client):
    resp = client.put(
        "/api/service-activity-overrides", json={"overrides": ["a/b"]}
    )
    assert resp.status_code == 400
    assert client.put("/api/service-activity-overrides", json={}).status_code == 400
