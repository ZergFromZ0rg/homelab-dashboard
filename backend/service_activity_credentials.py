"""Credentials for service_activity's probes (qBittorrent WebUI login,
Jellyfin API key), entered from Settings → Live-activity credentials
instead of the backend's .env — same /data-volume JSON-store pattern as
pins.py, but for secrets, so two things are different from every other
store in this codebase:

- Writes are partial/per-app (``set(app, fields)`` merges into that app's
  entry) rather than "replace the whole thing", because the frontend is
  never handed today's values back to echo in a full replace — see
  ``configured()``.
- Nothing here is ever meant to reach ``GET`` as plaintext. main.py's
  read route calls ``configured()`` (which app), not ``all()`` (the
  secrets) — ``all()`` is for main.py's /ws loop to hand to
  service_activity.refresh() server-side only.

Stored in plaintext on disk, like every other secret this project already
handles as an env var (AGENT_TOKEN, API_TOKEN) — no new trust boundary,
just a different place to type it in. Same "fine behind Tailscale, lock
down further yourself if this API is reachable elsewhere" model as the
rest of the dashboard.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from backend.jsonstore import read_json, write_json_atomic

CREDENTIALS_FILE = Path(
    os.getenv("SERVICE_ACTIVITY_CREDENTIALS_FILE", "/data/service_activity_credentials.json")
)

# Keep in sync with service_activity._PROBES_BY_NAME. The fields listed
# for each app are exactly what "configured" means for it — qBittorrent
# needs both, Jellyfin just the one key.
REQUIRED_FIELDS = {
    "qbittorrent": {"username", "password"},
    "jellyfin": {"api_key"},
}
VALID_APPS = set(REQUIRED_FIELDS)
MAX_FIELD_LENGTH = 512


class ServiceActivityCredentialStore:
    def __init__(self, path: Path = CREDENTIALS_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._credentials: dict[str, dict[str, str]] = self._load()

    def _load(self) -> dict[str, dict[str, str]]:
        data = read_json(self.path, {})
        return _clean(data if isinstance(data, dict) else {})

    def _save_locked(self) -> None:
        write_json_atomic(self.path, self._credentials, label="service_activity_credentials")

    def all(self) -> dict[str, dict[str, str]]:
        """The real secrets — server-side use only (service_activity's
        probes). Never return this from an API route."""
        with self._lock:
            return {app: dict(fields) for app, fields in self._credentials.items()}

    def configured(self) -> dict[str, bool]:
        """Which apps have every field REQUIRED_FIELDS lists for them set
        — safe to return from an API route, since it carries no secret
        values. A qBittorrent entry with only a username (no password
        yet) is correctly "not configured"."""
        with self._lock:
            return {
                app: all(self._credentials.get(app, {}).get(f) for f in required)
                for app, required in REQUIRED_FIELDS.items()
            }

    def set(self, app: str, fields: dict) -> bool:
        """Merge ``fields`` into ``app``'s stored credentials (a blank
        value clears just that field, not the whole app). Returns whether
        the app is now fully configured."""
        if app not in VALID_APPS or not isinstance(fields, dict):
            raise ValueError(f"unknown app: {app!r}")

        cleaned = {
            k: v.strip()[:MAX_FIELD_LENGTH]
            for k, v in fields.items()
            if isinstance(k, str) and isinstance(v, str)
        }

        with self._lock:
            current = dict(self._credentials.get(app, {}))
            for key, value in cleaned.items():
                if value:
                    current[key] = value
                else:
                    current.pop(key, None)

            if current:
                self._credentials[app] = current
            else:
                self._credentials.pop(app, None)

            self._save_locked()
            return all(current.get(f) for f in REQUIRED_FIELDS[app])

    def clear(self, app: str) -> None:
        with self._lock:
            if self._credentials.pop(app, None) is not None:
                self._save_locked()


def _clean(data: dict) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for app, fields in data.items():
        if app not in VALID_APPS or not isinstance(fields, dict):
            continue
        cleaned = {
            k: v
            for k, v in fields.items()
            if isinstance(k, str) and isinstance(v, str) and v
        }
        if cleaned:
            out[app] = cleaned
    return out
