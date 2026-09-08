"""Which containers the user has pinned to the top of the Containers tab.

Deliberately dumb: an ordered list of ``"host/container-name"`` strings on
the ``/data`` volume, same lock-guarded atomic-write pattern as
``deployments.py``. Keyed by host + name rather than container id so a pin
survives the container being recreated (a redeploy gives it a fresh id).

This is pure UI state — nothing in the scheduler reads it — but it lives
server-side so a pin set on one browser shows up on every other.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from backend.jsonstore import read_json, write_json_atomic

PINS_FILE = Path(os.getenv("PINS_FILE", "/data/pins.json"))

# A guard so a broken or hostile client can't grow the file without bound.
MAX_PINS = 200
MAX_KEY_LENGTH = 256


class PinStore:
    def __init__(self, path: Path = PINS_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._pins: list[str] = self._load()

    def _load(self) -> list[str]:
        data = read_json(self.path, [])
        return _clean(data if isinstance(data, list) else [])

    def _save_locked(self) -> None:
        write_json_atomic(self.path, self._pins, label="pins")

    def all(self) -> list[str]:
        with self._lock:
            return list(self._pins)

    def replace(self, keys: list[str]) -> list[str]:
        """Set the full pin list (the client always sends the whole set)."""
        cleaned = _clean(keys)
        with self._lock:
            if cleaned != self._pins:
                self._pins = cleaned
                self._save_locked()
            return list(self._pins)


def _clean(keys: list) -> list[str]:
    """Drop non-strings, blanks, over-long entries and duplicates; keep order."""
    seen: set[str] = set()
    out: list[str] = []
    for key in keys:
        if not isinstance(key, str):
            continue
        key = key.strip()
        if not key or len(key) > MAX_KEY_LENGTH or key in seen:
            continue
        seen.add(key)
        out.append(key)
        if len(out) >= MAX_PINS:
            break
    return out
