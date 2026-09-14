"""Manual per-container overrides for service_activity's probing: "treat
this container as qBittorrent/Jellyfin regardless of its image name" (a
custom or renamed image, or picking one instance among several) or "never
probe this one". Same server-shared pattern as pins.py (a dict this time,
container -> app) — it lives server-side, not in the browser, because it
changes what the backend actually probes for everyone, not just what one
browser displays.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from backend.jsonstore import read_json, write_json_atomic

OVERRIDES_FILE = Path(
    os.getenv("SERVICE_ACTIVITY_OVERRIDES_FILE", "/data/service_activity_overrides.json")
)

# A guard so a broken or hostile client can't grow the file without bound.
MAX_ENTRIES = 200
MAX_KEY_LENGTH = 256

# Keep in sync with service_activity._PROBES_BY_NAME.
VALID_APPS = {"qbittorrent", "jellyfin", "none"}


class ServiceActivityOverrideStore:
    def __init__(self, path: Path = OVERRIDES_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._overrides: dict[str, str] = self._load()

    def _load(self) -> dict[str, str]:
        data = read_json(self.path, {})
        return _clean(data if isinstance(data, dict) else {})

    def _save_locked(self) -> None:
        write_json_atomic(self.path, self._overrides, label="service_activity_overrides")

    def all(self) -> dict[str, str]:
        with self._lock:
            return dict(self._overrides)

    def replace(self, overrides: dict) -> dict[str, str]:
        """Set the full override map (the client always sends the whole set,
        same as pins/todos)."""
        cleaned = _clean(overrides)
        with self._lock:
            if cleaned != self._overrides:
                self._overrides = cleaned
                self._save_locked()
            return dict(self._overrides)


def _clean(overrides: dict) -> dict[str, str]:
    """Keys are ``"host/container-name"`` (same shape as a pin key); drop
    anything malformed, over-long, or not one of the known app values."""
    out: dict[str, str] = {}
    for key, value in overrides.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        key = key.strip()
        value = value.strip().lower()
        if not key or len(key) > MAX_KEY_LENGTH or value not in VALID_APPS:
            continue
        out[key] = value
        if len(out) >= MAX_ENTRIES:
            break
    return out
