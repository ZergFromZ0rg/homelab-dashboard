import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.service_activity_credentials import ServiceActivityCredentialStore


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(
        main,
        "service_activity_credentials",
        ServiceActivityCredentialStore(tmp_path / "creds.json"),
    )
    return TestClient(main.app)


def test_get_starts_unconfigured(client):
    assert client.get("/api/service-activity-credentials").json() == {
        "configured": {"qbittorrent": False, "jellyfin": False}
    }


def test_put_never_echoes_secret_values_back(client):
    resp = client.put(
        "/api/service-activity-credentials",
        json={
            "app": "qbittorrent",
            "credentials": {"username": "admin", "password": "secret"},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"configured": {"qbittorrent": True, "jellyfin": False}}
    assert "secret" not in resp.text
    assert "admin" not in resp.text


def test_get_after_put_still_never_leaks_secrets(client):
    client.put(
        "/api/service-activity-credentials",
        json={"app": "jellyfin", "credentials": {"api_key": "key123"}},
    )
    resp = client.get("/api/service-activity-credentials")
    assert "key123" not in resp.text
    assert resp.json() == {"configured": {"qbittorrent": False, "jellyfin": True}}


def test_put_rejects_unknown_app(client):
    resp = client.put(
        "/api/service-activity-credentials",
        json={"app": "plex", "credentials": {"token": "x"}},
    )
    assert resp.status_code == 400


def test_put_rejects_non_object_credentials(client):
    resp = client.put(
        "/api/service-activity-credentials",
        json={"app": "qbittorrent", "credentials": "admin"},
    )
    assert resp.status_code == 400


def test_delete_clears_the_app(client):
    client.put(
        "/api/service-activity-credentials",
        json={"app": "jellyfin", "credentials": {"api_key": "key123"}},
    )
    resp = client.delete("/api/service-activity-credentials/jellyfin")
    assert resp.status_code == 200
    assert resp.json() == {"configured": {"qbittorrent": False, "jellyfin": False}}
