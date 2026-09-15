"""Live "is this app currently in use" probes for a couple of container
images whose own API can answer that question — qBittorrent (active
torrents) and Jellyfin (active playback sessions) so far.

Not a general app-health framework: one probe function per app, and a
container we don't recognize just gets no badge. Add a new
``(needle, probe_fn)`` pair to ``_PROBES`` to extend it.

A container is matched to a probe by image name. Credentials come from
Settings → Live-activity credentials (server-side, entered from the
dashboard itself) with the ``QBITTORRENT_USERNAME``/``JELLYFIN_API_KEY``
env vars as a fallback for anyone who'd rather configure it that way.

Each probe does real HTTP calls, so results are cached per container for
CACHE_SECONDS — the /ws loop runs once per connected browser tab, and
without a cache N tabs would each hit the app's API every 2s.
"""

from __future__ import annotations

import threading
import time

import requests

from backend.env import env_str
from backend.log import system as log

CACHE_SECONDS = 15

# Same preference list as the frontend's containerUrl() — pick the web UI
# port, not an incidental one (qBittorrent also publishes 6881 for the
# torrent protocol itself).
_COMMON_WEB_PORTS = {
    80, 443, 3000, 3001, 5000, 8000, 8080, 8081, 8082, 8083, 8096, 8888,
    9000, 9090, 9091,
}

# Fallback for anyone who'd rather configure this via .env/compose than
# Settings → Live-activity credentials (checked first — see refresh()).
QBITTORRENT_USERNAME = env_str("QBITTORRENT_USERNAME")
QBITTORRENT_PASSWORD = env_str("QBITTORRENT_PASSWORD")
JELLYFIN_API_KEY = env_str("JELLYFIN_API_KEY")

_cache: dict[tuple, dict] = {}
_cache_lock = threading.Lock()
_warned: set[str] = set()


def _warn_once(app: str, message: str) -> None:
    if app in _warned:
        return
    _warned.add(app)
    log.info("%s", message)


def _container_url(host: str, ports: dict | None) -> str | None:
    if not ports:
        return None

    tcp_keys = sorted(k for k, v in ports.items() if k.endswith("/tcp") and v)
    if not tcp_keys:
        return None

    preferred = next(
        (k for k in tcp_keys if int(k.split("/")[0]) in _COMMON_WEB_PORTS),
        None,
    )
    key = preferred or tcp_keys[0]
    port = ports[key][0]
    return f"http://{host}:{port}"


def _qbittorrent_activity(url: str, creds: dict) -> dict | None:
    username = creds.get("username") or QBITTORRENT_USERNAME
    password = creds.get("password") or QBITTORRENT_PASSWORD

    if not (username and password):
        _warn_once(
            "qbittorrent",
            "found a qBittorrent container but no credentials are set "
            "(Settings → Live-activity credentials, or QBITTORRENT_USERNAME/"
            "QBITTORRENT_PASSWORD) — skipping live-activity probing",
        )
        return None

    session = requests.Session()

    try:
        login = session.post(
            f"{url}/api/v2/auth/login",
            data={"username": username, "password": password},
            timeout=4,
        )
        if login.status_code != 200 or login.text.strip() != "Ok.":
            return None

        response = session.get(f"{url}/api/v2/torrents/info", timeout=4)
        response.raise_for_status()
        torrents = response.json()
    except (requests.RequestException, ValueError):
        return None

    downloading = sum(1 for t in torrents if (t.get("dlspeed") or 0) > 0)
    uploading = sum(1 for t in torrents if (t.get("upspeed") or 0) > 0)

    if not downloading and not uploading:
        return None

    parts = []
    if downloading:
        parts.append(f"{downloading} downloading")
    if uploading:
        parts.append(f"{uploading} seeding")

    return {"app": "qBittorrent", "detail": ", ".join(parts)}


def _jellyfin_activity(url: str, creds: dict) -> dict | None:
    api_key = creds.get("api_key") or JELLYFIN_API_KEY

    if not api_key:
        _warn_once(
            "jellyfin",
            "found a Jellyfin container but no API key is set "
            "(Settings → Live-activity credentials, or JELLYFIN_API_KEY) — "
            "skipping live-activity probing",
        )
        return None

    try:
        response = requests.get(
            f"{url}/Sessions",
            headers={"X-Emby-Token": api_key},
            timeout=4,
        )
        response.raise_for_status()
        sessions = response.json()
    except (requests.RequestException, ValueError):
        return None

    playing = [s for s in sessions if s.get("NowPlayingItem")]
    if not playing:
        return None

    users = sorted({s.get("UserName") or "someone" for s in playing})
    count = len(playing)
    label = "user" if count == 1 else "users"

    return {
        "app": "Jellyfin",
        "detail": f"{count} {label} streaming ({', '.join(users)})",
    }


# Container image (lowercased) substring -> probe function. First match
# wins; checked in this order. The name on the left is also the value
# used in Settings → Live-activity credentials — keep both in sync when
# adding an app.
_PROBES = [
    ("qbittorrent", _qbittorrent_activity),
    ("jellyfin", _jellyfin_activity),
]
_PROBES_BY_NAME = dict(_PROBES)


def _match(container: dict) -> str | None:
    """Returns the matched app name (a key of _PROBES_BY_NAME), or None."""
    image = (container.get("image") or "").lower()
    return next((needle for needle, _ in _PROBES if needle in image), None)


def _cache_key(host: str, container: dict) -> tuple:
    return (host, container.get("id"))


def peek(host: str, container: dict) -> dict | None:
    """Non-blocking: today's cached result, or None if we have nothing
    fresh (either never probed, or probed-and-not-active — both render
    the same, no badge)."""
    with _cache_lock:
        entry = _cache.get(_cache_key(host, container))
    if entry and time.time() - entry["at"] < CACHE_SECONDS:
        return entry["result"]
    return None


def stale(host: str, container: dict) -> bool:
    """True when this is a container we know how to probe (by image
    match) and its cached result (if any) has expired — the caller
    should run refresh() for it off the event loop."""
    if _match(container) is None:
        return False
    with _cache_lock:
        entry = _cache.get(_cache_key(host, container))
    return not entry or time.time() - entry["at"] >= CACHE_SECONDS


def refresh(
    host: str,
    container: dict,
    credentials: dict | None = None,
) -> dict | None:
    """Blocking — makes the actual HTTP calls and caches the result. Run
    via asyncio.to_thread, only for containers stale() flagged.

    ``credentials`` is the whole Settings-configured map
    (``{"qbittorrent": {...}, "jellyfin": {...}}``); only the matched
    app's entry (if any) is handed to its probe function."""
    name = _match(container)
    if name is None:
        return None

    url = _container_url(host, container.get("ports"))
    creds = (credentials or {}).get(name) or {}
    result = _PROBES_BY_NAME[name](url, creds) if url else None

    with _cache_lock:
        _cache[_cache_key(host, container)] = {"at": time.time(), "result": result}

    return result
