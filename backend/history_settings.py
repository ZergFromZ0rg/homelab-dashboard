"""How long the dashboard remembers: the audit log (who did what) and the
activity history (what happened to the fleet). Settings → History.

Kept in /data/history.json. 0 days means keep everything.
"""

from __future__ import annotations

from pathlib import Path

from backend.env import env_str
from backend.jsonstore import read_json, write_json_atomic

FILE = Path(env_str("HISTORY_SETTINGS_FILE", "/data/history.json"))

DEFAULTS = {"audit_days": 365, "activity_days": 30}
CHOICES = {"audit_days": (30, 90, 180, 365, 730, 0), "activity_days": (7, 14, 30, 90, 180, 365)}


def get() -> dict:
    stored = read_json(FILE, {})
    out = dict(DEFAULTS)
    for key, allowed in CHOICES.items():
        if stored.get(key) in allowed:
            out[key] = stored[key]
    return out


def update(changes: dict) -> dict:
    current = get()
    for key, value in changes.items():
        if key not in CHOICES:
            raise ValueError(f"{key} isn't a history setting")
        if value not in CHOICES[key]:
            raise ValueError(f"{key} must be one of {', '.join(map(str, CHOICES[key]))}")
        current[key] = value
    write_json_atomic(FILE, current, label="history settings")
    return current
