"""What on the network is worth an alert: Pi-hole itself going dark, a device
nobody has accounted for, and blocking suddenly firing far more than usual.

Same shape as the other rules: a pure function from current state to the
alerts that should be raised right now, which the alert loop turns into
firing and resolved events. A new device stays raised until you name it (or
mark it known), or a day passes.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

from backend import presence
from backend.env import env_float, env_str
from backend.jsonstore import read_json, write_json_atomic

KNOWN_FILE = Path(env_str("KNOWN_DEVICES_FILE", "/data/known-devices.json"))
NEW_WINDOW = 24 * 3600
DOWN_AFTER = env_float("PIHOLE_DOWN_AFTER", 180)  # seconds unreachable before it is an alert
SPIKE_PERCENT = env_float("PIHOLE_SPIKE_PERCENT", 25)
RECENT_BUCKETS = 4  # 10-minute buckets: the last ~40 minutes
MIN_RECENT_QUERIES = 80
MIN_BASELINE_QUERIES = 300
CACHE_SECONDS = 15


def _identified(row: dict) -> bool:
    """You (or Pi-hole's comments) have already said what this is."""
    return row.get("name_source") in ("label", "pihole") or row.get("kind_source") == "label" or row.get("kind") == "server"


class KnownStore:
    """Which devices have been accounted for. The first time it sees any, every
    device already on the network counts as known — otherwise turning this on
    would report the whole house as new."""

    def __init__(self, path: Path = KNOWN_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        data = read_json(self.path, {})
        data = data if isinstance(data, dict) else {}
        self._initialized = bool(data.get("initialized"))
        self._known: dict[str, float] = dict(data.get("known") or {})
        self._new: dict[str, float] = dict(data.get("new") or {})

    def _save(self) -> None:
        write_json_atomic(self.path, {"initialized": self._initialized, "known": self._known, "new": self._new},
                          label="known devices")

    def observe(self, rows: list[dict], now: float) -> None:
        macs = [r for r in rows if not r.get("ghost")]
        if not macs:
            return  # nothing polled yet: don't learn an empty network
        with self._lock:
            before = (self._initialized, len(self._known), dict(self._new))
            if not self._initialized:
                self._known = {r["mac"]: now for r in macs}
                self._initialized = True
            else:
                for row in macs:
                    mac = row["mac"]
                    if mac in self._known:
                        continue
                    if _identified(row):
                        self._known[mac] = now
                        self._new.pop(mac, None)
                    else:
                        self._new.setdefault(mac, now)
                for mac, noticed in list(self._new.items()):
                    if now - noticed > NEW_WINDOW:
                        self._known[mac] = now
                        del self._new[mac]
            if before != (self._initialized, len(self._known), self._new):
                self._save()

    def acknowledge(self, mac: str) -> None:
        mac = mac.lower()
        with self._lock:
            if mac in self._new:
                self._known[mac] = time.time()
                del self._new[mac]
                self._save()

    def new(self) -> dict[str, float]:
        with self._lock:
            return dict(self._new)


known = KnownStore()


def block_spike(history: list[tuple[float, int, int]]) -> dict | None:
    """Blocked share of the last ~40 minutes against the rest of the day, if it
    is both high in itself and well above what is usual."""
    if len(history) <= RECENT_BUCKETS:
        return None
    recent, before = history[-RECENT_BUCKETS:], history[:-RECENT_BUCKETS]
    r_total, r_blocked = sum(h[1] for h in recent), sum(h[2] for h in recent)
    b_total, b_blocked = sum(h[1] for h in before), sum(h[2] for h in before)
    if r_total < MIN_RECENT_QUERIES or b_total < MIN_BASELINE_QUERIES:
        return None
    recent_rate, usual = 100 * r_blocked / r_total, 100 * b_blocked / b_total
    if recent_rate >= SPIKE_PERCENT and recent_rate >= 2 * max(usual, 5):
        return {"rate": round(recent_rate), "usual": round(usual), "blocked": r_blocked, "total": r_total}
    return None


def evaluate(*, down_for: float | None, error: str | None, rows: list[dict], new: dict[str, float],
             history: list[tuple[float, int, int]], gone: list[dict] | None = None) -> dict[str, dict]:
    out: dict[str, dict] = {}

    if down_for is not None and down_for >= DOWN_AFTER:
        minutes = max(1, round(down_for / 60))
        out["network:pihole-down"] = {
            "title": "Pi-hole is unreachable",
            "message": f"The dashboard hasn't reached Pi-hole for {minutes} min ({error or 'no answer'}). "
                       "Devices that use it for DNS or DHCP may be affected.",
            "severity": "bad",
            "hint": "Check the pihole container on the ThinkPad (docker ps, docker logs pihole).",
        }

    by_mac = {r["mac"]: r for r in rows}
    fresh = [by_mac[m] for m in new if m in by_mac]
    if fresh:
        names = ", ".join(r["name"] for r in fresh[:4]) + (f" and {len(fresh) - 4} more" if len(fresh) > 4 else "")
        out["network:new-devices"] = {
            "title": f"{len(fresh)} new device{'s' if len(fresh) != 1 else ''} on the network",
            "message": f"Not named yet: {names}.",
            "severity": "warn",
            "hint": "Open Network → DNS, click the device and name it, or mark it known.",
        }

    for device in gone or []:
        out[f"network:offline:{device['mac'].replace(':', '')}"] = {
            "title": f"{device['name']} is offline",
            "message": f"Usually online ({device['percent']}% of the last {device['days']} days), "
                       f"but not seen for {_span(device['away_seconds'])}.",
            "severity": "warn",
            "hint": "Check its power and Wi-Fi.",
        }

    spike = block_spike(history)
    if spike:
        out["network:block-spike"] = {
            "title": "Pi-hole is blocking far more than usual",
            "message": f"{spike['rate']}% of the last ~40 minutes' queries were blocked ({spike['blocked']} of "
                       f"{spike['total']}); the rest of the day it's {spike['usual']}%.",
            "severity": "warn",
            "hint": "Open Network → DNS and sort by blocked: one device is probably chattering.",
            "debounce": True,
        }
    return out


def _span(seconds: float) -> str:
    minutes = round(seconds / 60)
    if minutes < 90:
        return f"{minutes} min"
    hours = minutes / 60
    return f"{round(hours)} h" if hours < 48 else f"{round(hours / 24)} days"


_cache: tuple[float, dict] | None = None
_cache_lock = threading.Lock()


def current(now: float | None = None) -> dict[str, dict]:
    """The network alerts right now, for the alert loop and the Overview. Cached a
    few seconds: the Overview asks on every tick."""
    global _cache
    from backend import device_meta, device_names, network_devices, pihole

    now = now or time.time()
    with _cache_lock:
        if _cache and now - _cache[0] < CACHE_SECONDS:
            return _cache[1]
    collector = pihole.collector
    if not collector.configured:
        return {}
    inputs = collector.device_inputs()
    rows = network_devices.merge(inputs, device_names.names.all(), device_meta.meta.all(), now)
    known.observe(rows, now)
    snap = collector.snapshot()
    down_for = collector.down_for(now)
    # While Pi-hole's own data is old, every device would look like it left.
    trusted = down_for is None and bool(snap.get("reachable")) and not snap.get("stale")
    presence.store.observe(rows, now, trusted)
    result = evaluate(
        down_for=down_for, error=snap.get("error"),
        rows=rows, new=known.new(), history=collector.history(),
        gone=presence.store.gone(rows, now) if trusted else [],
    )
    with _cache_lock:
        _cache = (now, result)
    return result
