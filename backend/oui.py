"""Who made a network card, from its MAC address.

The first three bytes of a MAC are an assignment from the IEEE to a
manufacturer. The registry is a public 4 MB CSV; it is downloaded once into
the data volume (and again after 90 days) and read into memory. Until that
has happened ``describe`` answers "unknown" rather than making a scan wait.

Phones and many laptops use a *randomized* address — the "locally
administered" bit (0x02 in the first byte) is set and no manufacturer is
registered. Those are named as such instead of left blank, since "private
address" is the real answer.
"""

from __future__ import annotations

import csv
import io
import os
import threading
import time

import requests

from backend.log import system as log

OUI_FILE = os.getenv("OUI_FILE", "/data/oui.csv")
OUI_URL = "https://standards-oui.ieee.org/oui/oui.csv"
MAX_AGE = 90 * 24 * 3600

_table: dict[str, str] | None = None
_loading = False
_lock = threading.Lock()


def _parse(text: str) -> dict[str, str]:
    table = {}
    reader = csv.reader(io.StringIO(text))
    next(reader, None)
    for row in reader:
        if len(row) >= 3 and len(row[1]) == 6:
            table[row[1].upper()] = row[2].strip()
    return table


def _load() -> None:
    global _table, _loading
    try:
        stale = (not os.path.exists(OUI_FILE)) or time.time() - os.path.getmtime(OUI_FILE) > MAX_AGE
        if stale:
            try:
                response = requests.get(OUI_URL, headers={"User-Agent": "homelab-dashboard"}, timeout=40)
                response.raise_for_status()
                os.makedirs(os.path.dirname(OUI_FILE) or ".", exist_ok=True)
                tmp = f"{OUI_FILE}.tmp"
                with open(tmp, "wb") as f:
                    f.write(response.content)
                os.replace(tmp, OUI_FILE)
            except (requests.RequestException, OSError) as error:
                # An old copy is still better than none.
                log.info("couldn't refresh the MAC vendor list: %s", error)
        with open(OUI_FILE, encoding="utf-8", errors="replace") as f:
            table = _parse(f.read())
        with _lock:
            _table = table
    except OSError as error:
        log.info("no MAC vendor list available: %s", error)
        with _lock:
            _table = {}
    finally:
        _loading = False


def _ensure() -> dict[str, str] | None:
    global _loading
    with _lock:
        if _table is not None:
            return _table
        if not _loading:
            _loading = True
            threading.Thread(target=_load, daemon=True).start()
    return None


def describe(mac: str | None) -> dict:
    """{"vendor": name or None, "randomized": bool} for a MAC."""
    cleaned = "".join(c for c in (mac or "") if c in "0123456789abcdefABCDEF").upper()
    if len(cleaned) < 6:
        return {"vendor": None, "randomized": False}
    if int(cleaned[:2], 16) & 0x02:
        return {"vendor": None, "randomized": True}
    table = _ensure()
    return {"vendor": (table or {}).get(cleaned[:6]), "randomized": False}


def annotate(devices: list[dict]) -> list[dict]:
    for d in devices:
        info = describe(d.get("mac"))
        d["vendor"] = info["vendor"]
        d["randomized"] = info["randomized"]
    return devices
