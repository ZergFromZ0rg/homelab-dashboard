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

SPAN = 2 * 3600
STEP = 60
REFRESH_SECONDS = 60


def _series(promql: str, start: float, end: float) -> dict[str, list[dict]]:
    """ifIndex -> [{t, v}] for a range query."""
    out: dict[str, list[dict]] = {}
    for result in prometheus.query_range(promql, start, end, STEP):
        index = (result.get("metric") or {}).get("ifIndex")
        if index is None:
            continue
        out[index] = [{"t": int(t), "v": None if v == "NaN" else float(v)} for t, v in result["values"]]
    return out


def _fetch(now: float) -> dict[str, dict]:
    """ifIndex -> {down_24h, up_24h, down, up}: bytes moved in 24 h and the
    trend in bits/s, all from the device's side (down = to the device)."""
    sel = f'job="{switch.JOB}"'
    # The switch counts from its own side: "out" is what it sends the device.
    down_day = switch._by_index(f"increase(ifHCOutOctets{{{sel}}}[24h])")
    up_day = switch._by_index(f"increase(ifHCInOctets{{{sel}}}[24h])")
    down = _series(f"rate(ifHCOutOctets{{{sel}}}[2m]) * 8", now - SPAN, now)
    up = _series(f"rate(ifHCInOctets{{{sel}}}[2m]) * 8", now - SPAN, now)
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
        self._by_index: dict[str, dict] | None = None
        self._at = 0.0

    def refresh(self, now: float | None = None) -> None:
        now = now or time.time()
        try:
            data = _fetch(now)
        except (requests.RequestException, ValueError, KeyError, TypeError) as failure:
            log.warning("bandwidth history unavailable: %s", failure)
            return  # keep the last answer; the live rates still come from the switch cache
        with self._lock:
            self._by_index, self._at = data, now

    def snapshot(self, ports_snapshot: dict | None = None) -> dict:
        """The switch's ports with their totals and trends attached."""
        base = ports_snapshot if ports_snapshot is not None else switch.monitor.snapshot()
        with self._lock:
            history, at = self._by_index, self._at
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
            "history_at": at or None,
            "updated_at": base.get("updated_at"),
        }


monitor = Bandwidth()


async def run_forever() -> None:
    while True:
        await asyncio.to_thread(monitor.refresh)
        await asyncio.sleep(REFRESH_SECONDS)
