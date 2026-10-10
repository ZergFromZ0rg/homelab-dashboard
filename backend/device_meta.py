"""The kind and notes you give a device, keyed by MAC.

Names live in ``device_names`` (the LAN scan uses the same ones, so a rename
shows everywhere); this holds the rest of a label. Pi-hole is a source of
devices, not the place your own metadata lives.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from backend.jsonstore import read_json, write_json_atomic

META_FILE = Path(os.getenv("DEVICE_META_FILE", "/data/device-meta.json"))
KINDS = ("server", "personal", "media", "iot", "unknown")
MAX_DEVICES = 500
MAX_NOTES = 300


class MetaStore:
    def __init__(self, path: Path = META_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        data = read_json(self.path, {})
        self._meta: dict[str, dict] = {}
        for key, value in (data.items() if isinstance(data, dict) else []):
            if isinstance(key, str) and isinstance(value, dict):
                self._meta[key] = {
                    "kind": value.get("kind") if value.get("kind") in KINDS else "",
                    "notes": str(value.get("notes") or "")[:MAX_NOTES],
                }

    def all(self) -> dict[str, dict]:
        with self._lock:
            return {k: dict(v) for k, v in self._meta.items()}

    def set(self, mac: str, kind: str | None = None, notes: str | None = None) -> dict:
        """Change the fields that are given; a blank kind or notes clears it."""
        mac = (mac or "").strip().lower()
        if not mac or len(mac) > 64:
            raise ValueError("a device key is needed")
        if kind is not None and kind and kind not in KINDS:
            raise ValueError(f"kind must be one of {', '.join(KINDS)}")
        with self._lock:
            entry = dict(self._meta.get(mac) or {"kind": "", "notes": ""})
            if kind is not None:
                entry["kind"] = kind
            if notes is not None:
                entry["notes"] = notes.strip()[:MAX_NOTES]
            if entry["kind"] or entry["notes"]:
                if mac not in self._meta and len(self._meta) >= MAX_DEVICES:
                    raise ValueError("too many labelled devices")
                self._meta[mac] = entry
            else:
                self._meta.pop(mac, None)
            write_json_atomic(self.path, self._meta, label="device meta")
            return dict(entry)


meta = MetaStore()
