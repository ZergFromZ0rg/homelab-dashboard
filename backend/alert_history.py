"""The dashboard's own record of what the alert monitor fired.

``backend/alerts.py`` only ever POSTed its events at ``ALERT_WEBHOOK_URL``
and forgot them, so nothing here could answer "what went off last night?".
This keeps the same events as *episodes* on the ``/data`` volume: one
entry per alert key, opened when it fires and closed when it resolves, so
the UI can show a duration rather than two unlinked lines.

Module functions + module state, same shape as ``activity.py``.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from backend.jsonstore import read_json, write_json_atomic

_FILE = Path(os.getenv("ALERT_HISTORY_FILE", "/data/alerts.json"))
MAX_ENTRIES = 200

# Newest first. An entry with ``resolved_at`` still None is firing now.
_entries: list[dict] = read_json(_FILE, [])
if not isinstance(_entries, list):
    _entries = []


def recent() -> list[dict]:
    return list(_entries)


def _save() -> None:
    del _entries[MAX_ENTRIES:]
    write_json_atomic(_FILE, _entries, label="alert history", indent=None)


def _open_entry(key: str) -> dict | None:
    """The newest still-firing episode for ``key``, if any."""
    for entry in _entries:
        if entry.get("key") == key and entry.get("resolved_at") is None:
            return entry
    return None


def record(event: dict) -> None:
    """Fold one ``AlertMonitor.poll`` event into the history."""
    key = event.get("key", "")
    at = event.get("timestamp") or time.time()

    if event.get("status") == "firing":
        existing = _open_entry(key)
        if existing is not None:
            # Already tracking this one — the monitor lost its in-memory
            # state (a restart) and re-fired. Keep the original start time,
            # which is the true one, and take the fresher wording (a disk
            # alert's title carries the percentage, so it moves too).
            existing["title"] = event.get("title", existing.get("title"))
            existing["message"] = event.get("message", existing.get("message"))
            existing["severity"] = event.get("severity", existing.get("severity"))
        else:
            _entries.insert(
                0,
                {
                    "key": key,
                    "at": at,
                    "resolved_at": None,
                    "title": event.get("title", key),
                    "message": event.get("message", ""),
                    "host": event.get("host"),
                    "severity": event.get("severity", "bad"),
                },
            )
    else:
        existing = _open_entry(key)
        if existing is not None:
            existing["resolved_at"] = at
        else:
            # Resolved something we never saw fire (history file cleared
            # under a running dashboard). Record it with no start time
            # rather than inventing a zero-length episode.
            _entries.insert(
                0,
                {
                    "key": key,
                    "at": None,
                    "resolved_at": at,
                    "title": event.get("title", key),
                    "message": event.get("message", ""),
                    "host": event.get("host"),
                    "severity": event.get("severity", "bad"),
                },
            )

    _save()


def sweep(firing_keys: set[str], now: float | None = None) -> None:
    """Close episodes whose alert is no longer firing.

    ``record`` alone can't catch an alert that cleared while the dashboard
    was down: no resolved event is ever emitted for it, so the episode
    would read as "firing" forever. The loop passes the monitor's current
    key set each cycle and anything open but absent from it is closed.
    """
    now = now or time.time()
    closed = False
    for entry in _entries:
        if entry.get("resolved_at") is None and entry.get("key") not in firing_keys:
            entry["resolved_at"] = now
            closed = True
    if closed:
        _save()
