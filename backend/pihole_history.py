"""DNS over weeks: what Pi-hole's own long-term database keeps.

Pi-hole writes every query to a database it keeps for ``database.maxDBdays``
(91 by default) and can answer "how many, how many blocked" in ten-minute
buckets for any span. So nothing is stored here: the dashboard asks, folds the
buckets into the step the range needs, and keeps the answer for a minute.

A point is **queries per hour**, whatever the step, so a day and a month read on
the same scale. The rate is worked out from the buckets that really exist in the
slot, so a slot that is only partly over (now) or partly missing (Pi-hole was
down) isn't drawn as a dip.
"""

from __future__ import annotations

import threading
import time

# range -> (seconds shown, step seconds). Pi-hole's own buckets are 10 minutes.
RANGES = {
    "24h": (86400, 600),
    "7d": (7 * 86400, 3600),
    "30d": (30 * 86400, 6 * 3600),
    "90d": (90 * 86400, 86400),
}
RANGE_KEYS = tuple(RANGES)
BUCKET = 600
TTL = 60.0
TOP = 8

_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}


def fold(rows: list[dict], step: int) -> list[dict]:
    """Ten-minute buckets -> points of ``step`` seconds: queries per hour and the
    blocked share of what was asked."""
    slots: dict[int, list[int]] = {}
    for row in rows:
        try:
            t = int(row["timestamp"])
            total, blocked = int(row.get("total") or 0), int(row.get("blocked") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        slot = slots.setdefault(t // step * step, [0, 0, 0])
        slot[0] += 1
        slot[1] += total
        slot[2] += blocked
    points = []
    for t in sorted(slots):
        buckets, total, blocked = slots[t]
        hours = buckets * BUCKET / 3600
        points.append({
            "t": t,
            "queries_per_hour": round(total / hours, 1) if hours else None,
            "blocked_pct": round(100 * blocked / total, 1) if total else None,
            "queries": total,
            "blocked": blocked,
        })
    return points


def _fetch(collector, range_key: str, now: float) -> dict:
    span, step = RANGES[range_key]
    window = {"from": int(now - span), "until": int(now)}
    rows = collector.get("/api/history/database", **window).get("history") or []
    summary = collector.get("/api/stats/database/summary", **window)
    asked = collector.get("/api/stats/database/top_domains", **window, blocked="false", count=TOP).get("domains") or []
    refused = collector.get("/api/stats/database/top_domains", **window, blocked="true", count=TOP).get("domains") or []
    clients = collector.get("/api/stats/database/top_clients", **window, count=TOP).get("clients") or []
    return {
        "range": range_key,
        "step": step,
        "start": window["from"],
        "end": window["until"],
        # Pi-hole keeps data from when it was set up; a 90-day view of a 2-day-old
        # database says how much it really has.
        "covers_seconds": (rows[-1]["timestamp"] - rows[0]["timestamp"] + BUCKET) if rows else 0,
        "points": fold(rows, step),
        "summary": {
            "queries": summary.get("sum_queries"),
            "blocked": summary.get("sum_blocked"),
            "blocked_pct": round(summary["percent_blocked"], 1) if isinstance(summary.get("percent_blocked"), (int, float)) else None,
            "clients": summary.get("total_clients"),
        },
        "top_asked": [{"domain": d.get("domain"), "count": d.get("count")} for d in asked],
        "top_blocked": [{"domain": d.get("domain"), "count": d.get("count")} for d in refused],
        "top_clients": [{"ip": c.get("ip"), "name": c.get("name") or c.get("ip"), "count": c.get("count")} for c in clients],
    }


def get(collector, range_key: str, now: float | None = None, names: dict[str, str] | None = None) -> dict:
    """The history for a range. ``names`` maps an address to the name you gave the
    device, which wins over what Pi-hole's reverse lookup says."""
    if range_key not in RANGES:
        raise ValueError(f"range must be one of: {', '.join(RANGE_KEYS)}")
    now = time.time() if now is None else now
    with _lock:
        hit = _cache.get(range_key)
    if hit and now - hit[0] < TTL:
        data = hit[1]
    else:
        data = _fetch(collector, range_key, now)
        with _lock:
            _cache[range_key] = (now, data)
    names = names or {}
    return {**data, "top_clients": [{**c, "name": names.get(c["ip"]) or c["name"]} for c in data["top_clients"]]}


def reset() -> None:
    with _lock:
        _cache.clear()
