"""Stacks you have decided not to back up.

Without this the "what would I lose" panel lists the same answers forever.
Somebody looks at grafana, decides they replaced it and do not want it,
and the panel goes on reporting grafana as an unprotected gap — every
week, alongside the gaps that are real. That is how a status view stops
being read.

A decision is a fact worth recording, so recording it is the feature. An
ignored stack is not hidden: it is listed separately, with the reason, and
can be un-ignored. What changes is the headline number, which then means
"gaps I have not decided about" rather than "everything I have not
configured" — and those are very different questions.

Kept on the dashboard rather than on the agent because it is a judgement
about whether data matters, not a fact about what a host can do.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from backend.env import env_str
from backend.jsonstore import read_json, write_json_atomic

IGNORES_FILE = Path(env_str("BACKUP_IGNORES_FILE", "/data/backup_ignores.json"))

MAX_REASON = 200


def _key(host: str, project: str) -> str:
    return f"{host}\t{project}"


class IgnoreStore:
    def __init__(self, path: Path = IGNORES_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._rows: dict[str, dict] = self._load()

    def _load(self) -> dict[str, dict]:
        data = read_json(self.path, {})

        if not isinstance(data, dict):
            return {}

        out = {}

        for key, row in data.items():
            if isinstance(row, dict) and "\t" in key:
                out[key] = {
                    "host": row.get("host") or key.split("\t")[0],
                    "project": row.get("project") or key.split("\t")[1],
                    "reason": str(row.get("reason") or "")[:MAX_REASON],
                    "at": float(row.get("at") or time.time()),
                }

        return out

    def _save_locked(self) -> None:
        write_json_atomic(self.path, self._rows, label="backup ignores")

    def all(self) -> list[dict]:
        with self._lock:
            return sorted(
                (dict(r) for r in self._rows.values()),
                key=lambda r: (r["host"], r["project"]),
            )

    def for_host(self, host: str) -> dict[str, dict]:
        with self._lock:
            return {
                r["project"]: dict(r)
                for r in self._rows.values()
                if r["host"] == host
            }

    def add(self, host: str, project: str, reason: str = "") -> dict:
        row = {
            "host": host,
            "project": project,
            "reason": str(reason or "")[:MAX_REASON],
            "at": time.time(),
        }

        with self._lock:
            self._rows[_key(host, project)] = row
            self._save_locked()

        return dict(row)

    def remove(self, host: str, project: str) -> bool:
        with self._lock:
            if self._rows.pop(_key(host, project), None) is None:
                return False

            self._save_locked()
            return True


store = IgnoreStore()
