"""Persistent registry of homelab-agent nodes.

Agents self-register by POSTing ``{"name": ..., "url": ...}`` to
``/api/nodes``. The list is written to a JSON file on a Docker volume so it
survives a dashboard restart. Entries carry a ``last_seen`` timestamp and
are dropped automatically once they go past ``NODE_TTL_SECONDS`` without a
refresh.
"""

import json
import os
import threading
import time
from pathlib import Path

from backend.log import system as log

NODES_FILE = Path(os.getenv("NODES_FILE", "/data/nodes.json"))

# A node is "stale" (still shown, marked offline) after this long without a
# heartbeat, and removed entirely after the TTL.
STALE_SECONDS = int(os.getenv("NODE_STALE_SECONDS", "300"))
TTL_SECONDS = int(os.getenv("NODE_TTL_SECONDS", "86400"))


class NodeRegistry:
    def __init__(self, path: Path = NODES_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._nodes: dict[str, dict] = self._load()

    def _load(self) -> dict[str, dict]:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}

        if not isinstance(data, dict):
            return {}

        return {
            name: entry
            for name, entry in data.items()
            if isinstance(entry, dict) and entry.get("url")
        }

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(self._nodes, indent=2, sort_keys=True) + "\n"
            )
            tmp.replace(self.path)
        except OSError as error:
            log.warning("registry save failed: %s", error)

    def _prune_locked(self, now: float) -> None:
        expired = [
            name
            for name, entry in self._nodes.items()
            if now - entry.get("last_seen", 0) > TTL_SECONDS
        ]

        for name in expired:
            del self._nodes[name]

    def register(self, name: str, url: str) -> None:
        now = time.time()

        with self._lock:
            entry = self._nodes.get(name, {})
            entry["url"] = url
            entry["last_seen"] = now
            entry.setdefault("first_seen", now)
            self._nodes[name] = entry
            self._prune_locked(now)
            self._save()

    def remove(self, name: str) -> bool:
        with self._lock:
            existed = self._nodes.pop(name, None) is not None

            if existed:
                self._save()

            return existed

    def all(self) -> dict[str, dict]:
        """Live nodes, keyed by name. Prunes expired entries as a side effect."""
        now = time.time()

        with self._lock:
            self._prune_locked(now)
            return {name: dict(entry) for name, entry in self._nodes.items()}

    def listing(self) -> list[dict]:
        now = time.time()

        return [
            {
                "name": name,
                "url": entry["url"],
                "last_seen": entry.get("last_seen"),
                "first_seen": entry.get("first_seen"),
                "stale": now - entry.get("last_seen", 0) > STALE_SECONDS,
            }
            for name, entry in sorted(self.all().items())
        ]
