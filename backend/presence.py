"""Which devices are usually online, so one that has gone quiet can be noticed.

Once a minute the merged device table is sampled: a device that is online has
that hour marked. A week of those marks says how reliably each one is there.
A device is "usually online" when it was online in at least 80% of the hours it
has been watched (and it has been watched for three days), and it is "gone"
when it has been missing longer than any gap in its own record, and for at
least 45 minutes.

The record is a rolling week, so a device that stays gone keeps the alert up for
a few days (until under three days of its record remain), then it is just not there.

"Online" here is the dashboard's: recent DNS queries plus a live lease. A device
too quiet to show up reliably never reaches 80%, so it never raises this; the
host-offline alert covers machines that run the dashboard's agent.
"""

from __future__ import annotations

import threading
from pathlib import Path

from backend.env import env_str
from backend.jsonstore import read_json, write_json_atomic

PRESENCE_FILE = Path(env_str("PRESENCE_FILE", "/data/presence.json"))
SAMPLE_EVERY = 55  # seconds between samples, however often it is asked
SAVE_EVERY = 300
WINDOW_HOURS = 7 * 24
MIN_OBSERVED_HOURS = 72
USUAL_RATIO = 0.8
OFFLINE_AFTER = 45 * 60


def _hour(ts: float) -> int:
    return int(ts // 3600)


class PresenceStore:
    def __init__(self, path: Path = PRESENCE_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        data = read_json(self.path, {})
        self._devices: dict[str, dict] = {}
        for mac, d in (data.items() if isinstance(data, dict) else []):
            if isinstance(d, dict) and isinstance(d.get("hours"), list):
                self._devices[mac] = {"since": float(d.get("since") or 0), "last": float(d.get("last") or 0),
                                      "hours": {int(h) for h in d["hours"]}}
        self._sampled_at = 0.0
        self._saved_at = 0.0
        self._dirty = False

    def observe(self, rows: list[dict], now: float, trusted: bool = True) -> None:
        """Mark who is online this hour. ``trusted`` is False while Pi-hole's data is
        stale or unreachable: then nobody is sampled, so an outage of Pi-hole
        doesn't look like every device leaving."""
        with self._lock:
            if not trusted or now - self._sampled_at < SAMPLE_EVERY:
                return
            self._sampled_at = now
            for row in rows:
                if row.get("ghost") or row.get("online") is None:
                    continue
                d = self._devices.get(row["mac"])
                if d is None:
                    d = self._devices[row["mac"]] = {"since": now, "last": 0.0, "hours": set()}
                    self._dirty = True
                if row["online"]:
                    if _hour(now) not in d["hours"]:
                        d["hours"].add(_hour(now))
                        self._dirty = True
                    d["last"] = now
            cutoff = _hour(now) - WINDOW_HOURS - 24
            for d in self._devices.values():
                old = {h for h in d["hours"] if h < cutoff}
                if old:
                    d["hours"] -= old
                    self._dirty = True
            if self._dirty and now - self._saved_at >= SAVE_EVERY:
                self._save(now)

    def _save(self, now: float) -> None:
        write_json_atomic(
            self.path,
            {mac: {"since": d["since"], "last": d["last"], "hours": sorted(d["hours"])} for mac, d in self._devices.items()},
            label="presence", indent=None,
        )
        self._saved_at, self._dirty = now, False

    def usual(self, mac: str, now: float) -> dict | None:
        """{"ratio", "hours", "longest_gap"} if the device has been watched long
        enough to say anything, else None."""
        with self._lock:
            d = self._devices.get(mac)
            if not d or not d["last"]:
                return None
            # Judged up to the last time it was seen: the hours it has been gone must not
            # drag its record down, or a device that stays unplugged would stop being
            # "usually online" and its alert would quietly clear.
            first = max(_hour(d["since"]), _hour(now) - WINDOW_HOURS + 1)
            watched = _hour(d["last"]) - first + 1
            if watched < MIN_OBSERVED_HOURS:
                return None
            online = sorted(h for h in d["hours"] if first <= h <= _hour(d["last"]))
            gaps = [b - a - 1 for a, b in zip(online, online[1:])]
            return {"ratio": len(online) / watched, "hours": watched, "longest_gap": max(gaps, default=0), "last": d["last"]}

    def gone(self, rows: list[dict], now: float) -> list[dict]:
        """Devices that are usually online and aren't now."""
        out = []
        for row in rows:
            if row.get("ghost") or row.get("online") is not False:
                continue
            u = self.usual(row["mac"], now)
            if not u or u["ratio"] < USUAL_RATIO:
                continue
            away = now - u["last"]
            if away >= OFFLINE_AFTER and away / 3600 >= 2 * u["longest_gap"] + 1:
                out.append({"mac": row["mac"], "name": row["name"], "away_seconds": away,
                            "percent": round(100 * u["ratio"]), "days": max(1, round(u["hours"] / 24))})
        return out


store = PresenceStore()
