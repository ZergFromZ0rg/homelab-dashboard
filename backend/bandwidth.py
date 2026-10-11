"""Bandwidth by device, from the switch.

Each device plugged into the switch has a port, and the switch counts every
byte through it, so a port is a device meter: how much it is moving now, the
last two hours as a trend, and what it moved in the last 24 hours. The port
carries the device's name (the description set on the switch), the same name
Network → Switch shows.

What this cannot see: anything that reaches the network through the router
(Wi-Fi phones, TVs) is one port, the router's, however many devices are behind
it. That row is marked ``uplink`` so the UI can say so instead of pretending
it is one device.

Rates come from the switch module's own cache (cheap, every 30 s). The 24 hour
totals and the trend are two extra Prometheus questions, asked once a minute
in the background; a request only reads what is already there.
"""

from __future__ import annotations

import asyncio
import threading
import time

import requests

from backend import prometheus, switch
from backend.log import system as log

# range -> (seconds shown, step, window the totals are summed over). The totals
# are never shorter than a day: "what did it move in 2 hours" is not a total anyone asks for.
RANGES = {
    "2h": (2 * 3600, 60, "24h"),
    "24h": (86400, 300, "24h"),
    "7d": (7 * 86400, 1800, "7d"),
    "30d": (30 * 86400, 7200, "30d"),
}
DEFAULT_RANGE = "2h"
SPAN, STEP, _ = RANGES[DEFAULT_RANGE]
REFRESH_SECONDS = 60
RANGE_TTL = 90  # other ranges are fetched when asked for and kept this long


def _series(promql: str, start: float, end: float, step: int) -> dict[str, list[dict]]:
    """ifIndex -> [{t, v}] for a range query."""
    out: dict[str, list[dict]] = {}
    for result in prometheus.query_range(promql, start, end, step):
        index = (result.get("metric") or {}).get("ifIndex")
        if index is None:
            continue
        out[index] = [{"t": int(t), "v": None if v == "NaN" else float(v)} for t, v in result["values"]]
    return out


def _fetch(now: float, range_key: str = DEFAULT_RANGE) -> dict[str, dict]:
    """ifIndex -> {down_24h, up_24h, down, up}: bytes moved over the totals window
    and the trend in bits/s, all from the device's side (down = to the device).
    (The totals keep their ``_24h`` names whatever the window; the response says which.)"""
    span, step, window = RANGES[range_key]
    sel = f'job="{switch.JOB}"'
    # A point is the average over its whole step, not the sample that landed on it.
    rate = f"{max(step, 120)}s"
    # The switch counts from its own side: "out" is what it sends the device.
    down_day = switch._by_index(f"increase(ifHCOutOctets{{{sel}}}[{window}])")
    up_day = switch._by_index(f"increase(ifHCInOctets{{{sel}}}[{window}])")
    down = _series(f"rate(ifHCOutOctets{{{sel}}}[{rate}]) * 8", now - span, now, step)
    up = _series(f"rate(ifHCInOctets{{{sel}}}[{rate}]) * 8", now - span, now, step)
    out: dict[str, dict] = {}
    for index in set(down_day) | set(up_day) | set(down) | set(up):
        out[index] = {
            "down_24h": round(switch._value(down_day, index) or 0),
            "up_24h": round(switch._value(up_day, index) or 0),
            "down": down.get(index, []),
            "up": up.get(index, []),
        }
    return out


class Bandwidth:
    def __init__(self):
        self._lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict[str, dict]]] = {}

    def refresh(self, now: float | None = None, range_key: str = DEFAULT_RANGE) -> None:
        now = now or time.time()
        try:
            data = _fetch(now, range_key)
        except (requests.RequestException, ValueError, KeyError, TypeError) as failure:
            log.warning("bandwidth history unavailable: %s", failure)
            return  # keep the last answer; the live rates still come from the switch cache
        with self._lock:
            self._cache[range_key] = (now, data)

    def snapshot(self, ports_snapshot: dict | None = None, range_key: str = DEFAULT_RANGE) -> dict:
        """The switch's ports with their totals and trends attached. The default
        range is kept fresh in the background; any other is fetched when first
        asked for and then reused for ``RANGE_TTL`` seconds."""
        if range_key not in RANGES:
            raise ValueError(f"range must be one of: {', '.join(RANGES)}")
        with self._lock:
            at, history = self._cache.get(range_key, (0.0, None))
        if range_key != DEFAULT_RANGE and time.time() - at > RANGE_TTL:
            self.refresh(range_key=range_key)
            with self._lock:
                at, history = self._cache.get(range_key, (at, history))
        base = ports_snapshot if ports_snapshot is not None else switch.monitor.snapshot()
        rows = []
        for port in base.get("ports") or []:
            extra = (history or {}).get(str(port["index"])) or {}
            down_bps, up_bps = port["received_bps"], port["sent_bps"]
            down_24h, up_24h = extra.get("down_24h"), extra.get("up_24h")
            down_trend, up_trend = extra.get("down", []), extra.get("up", [])
            uplink = port["name"].lower() == switch.UPLINK
            if uplink:
                # The router stands for the internet. What the switch sends it is on
                # its way out (upload) and what it sends the switch is coming in
                # (download), the reverse of a device's own down and up.
                down_bps, up_bps = up_bps, down_bps
                down_24h, up_24h = up_24h, down_24h
                down_trend, up_trend = up_trend, down_trend
            rows.append({
                "index": port["index"],
                "name": port["name"],
                "port": port["port"],
                "labelled": port["labelled"],
                "up": port["up"],
                "speed_mbps": port["speed_mbps"],
                "uplink": uplink,
                "down_bps": down_bps,
                "up_bps": up_bps,
                "down_24h": down_24h,
                "up_24h": up_24h,
                "down_trend": down_trend,
                "up_trend": up_trend,
            })
        return {
            "state": base.get("state", "loading"),
            "reachable": base.get("reachable", True),
            "devices": rows,
            "range": range_key,
            "totals_window": RANGES[range_key][2],
            "history_at": at or None,
            "updated_at": base.get("updated_at"),
        }


monitor = Bandwidth()


async def run_forever() -> None:
    while True:
        await asyncio.to_thread(monitor.refresh)
        await asyncio.sleep(REFRESH_SECONDS)
