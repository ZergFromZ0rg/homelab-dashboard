"""The Personal tab's notes.

Free-text notes on the ``/data`` volume, so what you jot on your phone is
there on your desktop. Unlike the to-do list (which is one small list PUT
whole), notes can be long and edited from several devices, so they're saved
one at a time and every save says which version it was based on: if someone
else changed that note in the meantime the save is refused (``Conflict``)
instead of silently overwriting their edit.

Notes are stored as plain text in ``notes.json`` and served to anyone who
can reach the dashboard, exactly like the to-do list — don't keep secrets
here.
"""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path

from backend.env import env_str
from backend.jsonstore import read_json, write_json_atomic

NOTES_FILE = Path(env_str("NOTES_FILE", "/data/notes.json"))

MAX_NOTES = 100
MAX_BODY_LENGTH = 20_000

# Two timestamps this close are the same version (JSON float round-trips).
_EPSILON = 1e-6


class Conflict(Exception):
    """The note changed since the version the caller was editing."""

    def __init__(self, current: dict):
        super().__init__("note changed elsewhere")
        self.current = current


def _clean_body(value) -> str:
    if not isinstance(value, str):
        raise ValueError("'body' must be text")
    body = value.replace("\r\n", "\n").replace("\r", "\n")
    if len(body) > MAX_BODY_LENGTH:
        raise ValueError(f"a note can be at most {MAX_BODY_LENGTH:,} characters")
    return body


class NoteStore:
    def __init__(self, path: Path = NOTES_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._notes: dict[str, dict] = self._load()

    def _load(self) -> dict[str, dict]:
        data = read_json(self.path, [])
        notes: dict[str, dict] = {}

        for raw in data if isinstance(data, list) else []:
            if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
                continue
            body = raw.get("body")
            if not isinstance(body, str):
                continue
            created = raw.get("created_at")
            updated = raw.get("updated_at")
            now = time.time()
            notes[raw["id"]] = {
                "id": raw["id"],
                "body": body[:MAX_BODY_LENGTH],
                "created_at": float(created) if isinstance(created, (int, float)) else now,
                "updated_at": float(updated) if isinstance(updated, (int, float)) else now,
            }

        return notes

    def _save_locked(self) -> None:
        write_json_atomic(self.path, list(self._notes.values()), label="notes")

    def all(self) -> list[dict]:
        """Newest edit first."""
        with self._lock:
            return sorted(
                (dict(n) for n in self._notes.values()),
                key=lambda n: n["updated_at"],
                reverse=True,
            )

    def get(self, note_id: str) -> dict | None:
        with self._lock:
            note = self._notes.get(note_id)
            return dict(note) if note else None

    def create(self, body: str = "") -> dict:
        body = _clean_body(body)
        with self._lock:
            if len(self._notes) >= MAX_NOTES:
                raise ValueError(f"at most {MAX_NOTES} notes — delete one first")
            now = time.time()
            note = {"id": uuid.uuid4().hex[:12], "body": body, "created_at": now, "updated_at": now}
            self._notes[note["id"]] = note
            self._save_locked()
            return dict(note)

    def update(self, note_id: str, body: str, base_updated_at: float | None = None) -> dict | None:
        """Save ``body``. ``base_updated_at`` is the version the caller was
        editing; if the stored note has moved on, raises ``Conflict``. Leave
        it None to overwrite regardless. Returns None if the note is gone."""
        body = _clean_body(body)
        with self._lock:
            note = self._notes.get(note_id)
            if note is None:
                return None
            if base_updated_at is not None and abs(note["updated_at"] - base_updated_at) > _EPSILON:
                raise Conflict(dict(note))
            if body != note["body"]:
                note["body"] = body
                # Strictly newer than what any client holds, even within one clock tick.
                note["updated_at"] = max(time.time(), note["updated_at"] + 1e-3)
                self._save_locked()
            return dict(note)

    def delete(self, note_id: str) -> bool:
        with self._lock:
            if self._notes.pop(note_id, None) is None:
                return False
            self._save_locked()
            return True
