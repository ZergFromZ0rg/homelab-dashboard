"""Live "is this app currently in use" probes for a couple of container
images whose own API can answer that question — qBittorrent (active
torrents) and Jellyfin (active playback sessions) so far.

Not a general app-health framework: one image-name match -> probe
function per app, fleet-wide credentials (a homelab realistically runs
one instance of each), and a container we don't recognize just gets no
badge. Add a new ``(needle, probe_fn)`` pair to ``_PROBES`` to extend it.

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


def _qbittorrent_activity(url: str) -> dict | None:
    if not (QBITTORRENT_USERNAME and QBITTORRENT_PASSWORD):
        _warn_once(
            "qbittorrent",
            "found a qBittorrent container but QBITTORRENT_USERNAME/"
            "QBITTORRENT_PASSWORD aren't set — skipping live-activity probing",
        )
        return None

    session = requests.Session()

    try:
        login = session.post(
            f"{url}/api/v2/auth/login",
            data={"username": QBITTORRENT_USERNAME, "password": QBITTORRENT_PASSWORD},
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


def _jellyfin_activity(url: str) -> dict | None:
    if not JELLYFIN_API_KEY:
        _warn_once(
            "jellyfin",
            "found a Jellyfin container but JELLYFIN_API_KEY isn't set — "
            "skipping live-activity probing",
        )
        return None

    try:
        response = requests.get(
            f"{url}/Sessions",
            headers={"X-Emby-Token": JELLYFIN_API_KEY},
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
# wins; checked in this order.
_PROBES = [
    ("qbittorrent", _qbittorrent_activity),
    ("jellyfin", _jellyfin_activity),
]

# app name (as used in a service_activity_overrides.json value) -> probe
# function. Keep in sync with service_activity_overrides.VALID_APPS.
_PROBES_BY_NAME = {needle: fn for needle, fn in _PROBES}


def _override_key(host: str, container: dict) -> str:
    return f"{host}/{container.get('name') or ''}"


def _match(container: dict, override: str | None = None):
    """override, when given, is this container's
    service_activity_overrides.json value: "none" always skips it,
    a known app name always probes as that app (regardless of image),
    and anything else (unset, or a value we don't recognize) falls back
    to the image-name auto-match."""
    if override == "none":
        return None
    if override in _PROBES_BY_NAME:
        return _PROBES_BY_NAME[override]

    image = (container.get("image") or "").lower()
    return next((fn for needle, fn in _PROBES if needle in image), None)


def _cache_key(host: str, container: dict) -> tuple:
    return (host, container.get("id"))


def peek(host: str, container: dict, overrides: dict | None = None) -> dict | None:
    """Non-blocking: today's cached result, or None if we have nothing
    fresh (either never probed, or probed-and-not-active — both render
    the same, no badge)."""
    with _cache_lock:
        entry = _cache.get(_cache_key(host, container))
    if entry and time.time() - entry["at"] < CACHE_SECONDS:
        return entry["result"]
    return None


def stale(host: str, container: dict, overrides: dict | None = None) -> bool:
    """True when this is a container we know how to probe (by image match
    or manual override) and its cached result (if any) has expired — the
    caller should run refresh() for it off the event loop."""
    override = (overrides or {}).get(_override_key(host, container))
    if _match(container, override) is None:
        return False
    with _cache_lock:
        entry = _cache.get(_cache_key(host, container))
    return not entry or time.time() - entry["at"] >= CACHE_SECONDS


def refresh(host: str, container: dict, overrides: dict | None = None) -> dict | None:
    """Blocking — makes the actual HTTP calls and caches the result. Run
    via asyncio.to_thread, only for containers stale() flagged."""
    override = (overrides or {}).get(_override_key(host, container))
    probe_fn = _match(container, override)
    if probe_fn is None:
        return None

    url = _container_url(host, container.get("ports"))
    result = probe_fn(url) if url else None

    with _cache_lock:
        _cache[_cache_key(host, container)] = {"at": time.time(), "result": result}

    return result
