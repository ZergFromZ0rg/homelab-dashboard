"""service_activity probes qBittorrent / Jellyfin containers for whether
they're actively in use right now; results are cached per container so
repeated /ws ticks (one loop per connected browser tab) don't re-hit the
app's API every 2s."""

import pytest
import requests

from backend import service_activity as sa


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    sa._cache.clear()
    sa._warned.clear()
    monkeypatch.setattr(sa, "QBITTORRENT_USERNAME", "admin")
    monkeypatch.setattr(sa, "QBITTORRENT_PASSWORD", "secret")
    monkeypatch.setattr(sa, "JELLYFIN_API_KEY", "key123")
    yield


def _container(image, cid="abc", ports=None, name="c"):
    return {
        "id": cid,
        "name": name,
        "image": image,
        "ports": ports or {"8080/tcp": [8080]},
    }


def test_unmatched_container_is_never_stale_or_probed():
    c = _container("nginx:latest")
    assert sa.stale("nas", c) is False
    assert sa.peek("nas", c) is None


def test_qbittorrent_active_when_a_torrent_is_transferring(monkeypatch):
    seen_urls = []

    class FakeSession:
        def post(self, url, data, timeout):
            seen_urls.append(url)
            assert data == {"username": "admin", "password": "secret"}
            return FakeResponse(200, text="Ok.")

        def get(self, url, timeout):
            seen_urls.append(url)
            return FakeResponse(
                200,
                [
                    {"dlspeed": 500, "upspeed": 0},
                    {"dlspeed": 0, "upspeed": 0},
                ],
            )

    monkeypatch.setattr(sa.requests, "Session", FakeSession)

    c = _container(
        "linuxserver/qbittorrent",
        ports={"6881/tcp": [6881], "8080/tcp": [8080]},
    )
    assert sa.stale("nas", c) is True

    result = sa.refresh("nas", c)
    assert result == {"app": "qBittorrent", "detail": "1 downloading"}
    # picked the WebUI port (8080), not the torrent protocol port (6881)
    assert all(url.startswith("http://nas:8080/") for url in seen_urls)

    assert sa.peek("nas", c) == result
    assert sa.stale("nas", c) is False


def test_qbittorrent_idle_when_nothing_transferring(monkeypatch):
    class FakeSession:
        def post(self, url, data, timeout):
            return FakeResponse(200, text="Ok.")

        def get(self, url, timeout):
            return FakeResponse(200, [{"dlspeed": 0, "upspeed": 0}])

    monkeypatch.setattr(sa.requests, "Session", FakeSession)

    c = _container("qbittorrent")
    assert sa.refresh("nas", c) is None
    assert sa.peek("nas", c) is None  # cached "checked, not active"


def test_qbittorrent_bad_login_is_none(monkeypatch):
    class FakeSession:
        def post(self, url, data, timeout):
            return FakeResponse(200, text="Fails.")

        def get(self, url, timeout):
            raise AssertionError("should not fetch torrents without a session")

    monkeypatch.setattr(sa.requests, "Session", FakeSession)

    assert sa.refresh("nas", _container("qbittorrent")) is None


def test_qbittorrent_without_credentials_is_skipped(monkeypatch):
    monkeypatch.setattr(sa, "QBITTORRENT_USERNAME", "")
    monkeypatch.setattr(sa, "QBITTORRENT_PASSWORD", "")

    assert sa.refresh("nas", _container("qbittorrent")) is None


def test_jellyfin_reports_active_sessions(monkeypatch):
    def fake_get(url, headers, timeout):
        assert url.endswith("/Sessions")
        assert headers["X-Emby-Token"] == "key123"
        return FakeResponse(
            200,
            [
                {"UserName": "zerg", "NowPlayingItem": {"Name": "Movie"}},
                {"UserName": "guest", "NowPlayingItem": None},
            ],
        )

    monkeypatch.setattr(sa.requests, "get", fake_get)

    result = sa.refresh("nas", _container("jellyfin/jellyfin", cid="jf1"))
    assert result == {"app": "Jellyfin", "detail": "1 user streaming (zerg)"}


def test_jellyfin_no_sessions_is_none(monkeypatch):
    monkeypatch.setattr(sa.requests, "get", lambda *a, **k: FakeResponse(200, []))
    assert sa.refresh("nas", _container("jellyfin", cid="jf2")) is None


def test_jellyfin_without_api_key_is_skipped(monkeypatch):
    monkeypatch.setattr(sa, "JELLYFIN_API_KEY", "")
    assert sa.refresh("nas", _container("jellyfin")) is None


def test_container_with_no_tcp_ports_is_not_probed():
    assert sa.refresh("nas", _container("qbittorrent", ports={})) is None


def test_unreachable_app_is_none_not_an_error(monkeypatch):
    class FakeSession:
        def post(self, url, data, timeout):
            raise requests.ConnectionError("refused")

    monkeypatch.setattr(sa.requests, "Session", FakeSession)
    assert sa.refresh("nas", _container("qbittorrent")) is None


def test_cache_expires(monkeypatch):
    monkeypatch.setattr(sa, "CACHE_SECONDS", 0)

    class FakeSession:
        def post(self, url, data, timeout):
            return FakeResponse(200, text="Ok.")

        def get(self, url, timeout):
            return FakeResponse(200, [{"dlspeed": 10, "upspeed": 0}])

    monkeypatch.setattr(sa.requests, "Session", FakeSession)

    c = _container("qbittorrent")
    sa.refresh("nas", c)
    assert sa.stale("nas", c) is True


def test_override_none_suppresses_a_matching_image(monkeypatch):
    class FakeSession:
        def post(self, url, data, timeout):
            raise AssertionError("should not probe when overridden to none")

    monkeypatch.setattr(sa.requests, "Session", FakeSession)

    c = _container("qbittorrent", name="torrent-box")
    overrides = {"nas/torrent-box": "none"}

    assert sa.stale("nas", c, overrides) is False
    assert sa.refresh("nas", c, overrides) is None


def test_override_probes_a_non_matching_image_as_the_named_app(monkeypatch):
    def fake_get(url, headers, timeout):
        assert headers["X-Emby-Token"] == "key123"
        return FakeResponse(
            200, [{"UserName": "zerg", "NowPlayingItem": {"Name": "Movie"}}]
        )

    monkeypatch.setattr(sa.requests, "get", fake_get)

    # Custom image name — wouldn't match "jellyfin" by substring.
    c = _container("ghcr.io/acme/media-server:latest", name="media")
    overrides = {"nas/media": "jellyfin"}

    assert sa.stale("nas", c, overrides) is True
    result = sa.refresh("nas", c, overrides)
    assert result == {"app": "Jellyfin", "detail": "1 user streaming (zerg)"}


def test_override_key_is_host_and_container_name_not_id():
    # A "jellyfin" override on a *different* container name shouldn't
    # apply here even though the image still matches qBittorrent's needle.
    c = _container("qbittorrent", name="torrent-box")
    overrides = {"nas/some-other-name": "none"}
    assert sa.stale("nas", c, overrides) is True  # falls back to image match


def test_unknown_override_value_falls_back_to_image_match(monkeypatch):
    class FakeSession:
        def post(self, url, data, timeout):
            return FakeResponse(200, text="Ok.")

        def get(self, url, timeout):
            return FakeResponse(200, [{"dlspeed": 5, "upspeed": 0}])

    monkeypatch.setattr(sa.requests, "Session", FakeSession)

    c = _container("qbittorrent", name="torrent-box")
    overrides = {"nas/torrent-box": "not-a-real-app"}
    result = sa.refresh("nas", c, overrides)
    assert result == {"app": "qBittorrent", "detail": "1 downloading"}
