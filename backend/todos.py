"""The Overview tab's to-do list.

Same deliberately-dumb, lock-guarded, atomic-write store as ``pins.py`` — a
list of ``{"id", "text", "done", "created_at"}`` on the ``/data`` volume.
The client always PUTs the whole list (add / rename / toggle / delete /
reorder are all just a new array), and it rides the ``/ws`` payload so an
edit on one browser shows up on every other.
"""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path

from backend.env import env_str
from backend.jsonstore import read_json, write_json_atomic

TODOS_FILE = Path(env_str("TODOS_FILE", "/data/todos.json"))

MAX_TODOS = 200
MAX_TEXT_LENGTH = 500


class TodoStore:
    def __init__(self, path: Path = TODOS_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._todos: list[dict] = self._load()

    def _load(self) -> list[dict]:
        data = read_json(self.path, [])
        return _clean(data if isinstance(data, list) else [])

    def _save_locked(self) -> None:
        write_json_atomic(self.path, self._todos, label="todos")

    def all(self) -> list[dict]:
        with self._lock:
            return [dict(item) for item in self._todos]

    def replace(self, items: list) -> list[dict]:
        """Set the full list (the client always sends the whole thing)."""
        cleaned = _clean(items)
        with self._lock:
            if cleaned != self._todos:
                self._todos = cleaned
                self._save_locked()
            return [dict(item) for item in self._todos]


def _clean(items: list) -> list[dict]:
    """Keep well-formed rows in order: non-blank text (trimmed, capped), a
    stable id, a bool ``done``, a numeric ``created_at``. Drop the rest."""
    out: list[dict] = []
    seen_ids: set[str] = set()

    for item in items:
        if not isinstance(item, dict):
            continue

        text = str(item.get("text", "")).strip()[:MAX_TEXT_LENGTH]
        if not text:
            continue

        item_id = str(item.get("id") or "").strip() or uuid.uuid4().hex
        if item_id in seen_ids:
            item_id = uuid.uuid4().hex
        seen_ids.add(item_id)

        created_at = item.get("created_at")
        if not isinstance(created_at, (int, float)):
            created_at = time.time()

        out.append(
            {
                "id": item_id,
                "text": text,
                "done": bool(item.get("done")),
                "created_at": float(created_at),
            }
        )
        if len(out) >= MAX_TODOS:
            break

    return out
