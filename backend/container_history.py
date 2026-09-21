"""Per-container CPU and memory, kept for days.

``live_history`` keeps a fine-grained two-hour window for the heartbeat
and GPU temperature. This is the long view: the same samples averaged into
five-minute buckets and kept for a week, which is what "has this container
been creeping up all week?" needs and what a 2-hour ring can never answer.

Keyed by **container name**, not id. An id changes every time a container
is recreated, so an id-keyed series would reset itself every deploy —
exactly when you most want to compare before and after.

Sizing: a five-minute bucket over seven days is 2016 points per container
per metric. Twenty containers is about 1.5 MB of JSON, written to the data
volume every ``PERSIST_INTERVAL_SECONDS`` rather than on every sample.

  CONTAINER_HISTORY_DAYS   how long to keep (default 7)
  CONTAINER_HISTORY_FILE   where (default /data/container-history.json)
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

from backend.env import env_float
from backend.jsonstore import read_json, write_json_atomic

BUCKET_SECONDS = 300
RETENTION_DAYS = env_float("CONTAINER_HISTORY_DAYS", 7)
RETENTION_SECONDS = RETENTION_DAYS * 86400
MAX_BUCKETS = int(RETENTION_SECONDS // BUCKET_SECONDS)

PERSIST_INTERVAL_SECONDS = 120

_FILE = Path(os.getenv("CONTAINER_HISTORY_FILE", "/data/container-history.json"))

# {host: {name: {bucket_start: [cpu_sum, mem_sum, samples]}}}
_series: dict[str, dict[str, dict[int, list]]] = {}
_lock = threading.Lock()
_last_persist = 0.0


def _load() -> None:
    raw = read_json(_FILE, {})
    if not isinstance(raw, dict):
        return

    for host, containers in raw.items():
        if not isinstance(containers, dict):
            continue
        for name, buckets in containers.items():
            if not isinstance(buckets, dict):
                continue
            clean = {}
            for start, value in buckets.items():
                try:
                    clean[int(start)] = [float(value[0]), float(value[1]), int(value[2])]
                except (TypeError, ValueError, IndexError):
                    continue
            if clean:
                _series.setdefault(host, {})[name] = clean


_load()


def _bucket_of(now: float) -> int:
    return int(now // BUCKET_SECONDS) * BUCKET_SECONDS


def record(containers: dict[str, list], now: float | None = None) -> None:
    """Fold one fleet snapshot into the current bucket.

    Sums rather than means, with a sample count, so a bucket stays correct
    however many ticks land in it — the reconcile loop's cadence isn't
    guaranteed and shouldn't have to be.
    """
    now = time.time() if now is None else now
    bucket = _bucket_of(now)
    cutoff = bucket - RETENTION_SECONDS

    with _lock:
        for host, items in (containers or {}).items():
            host_series = _series.setdefault(host, {})

            for container in items or []:
                name = container.get("name")
                stats = container.get("stats") or {}
                if not name or container.get("status") != "running":
                    continue

                cpu = stats.get("cpu_percent")
                mem = (stats.get("memory") or {}).get("used_bytes")
                if cpu is None and mem is None:
                    continue

                buckets = host_series.setdefault(name, {})
                slot = buckets.setdefault(bucket, [0.0, 0.0, 0])
                slot[0] += float(cpu or 0)
                slot[1] += float(mem or 0)
                slot[2] += 1

                for start in [s for s in buckets if s < cutoff]:
                    del buckets[start]

    _maybe_persist(now)


def _maybe_persist(now: float) -> None:
    global _last_persist

    if now - _last_persist < PERSIST_INTERVAL_SECONDS:
        return

    _last_persist = now

    with _lock:
        snapshot = {
            host: {
                name: {
                    str(start): [round(v[0], 2), round(v[1]), v[2]]
                    for start, v in buckets.items()
                }
                for name, buckets in containers.items()
                if buckets
            }
            for host, containers in _series.items()
        }

    write_json_atomic(_FILE, snapshot, label="container history", indent=None)


RANGES = {"6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400}

# Roughly one point per 2-3 px of chart. More is wasted bytes the eye
# can't resolve; fewer starts hiding spikes.
TARGET_POINTS = 300


def history(
    host: str, name: str, range_key: str = "24h", now: float | None = None
) -> dict:
    """The series for one container, downsampled to something a chart can
    actually draw."""
    if range_key not in RANGES:
        raise ValueError(f"range must be one of: {', '.join(RANGES)}")

    now = time.time() if now is None else now
    span = RANGES[range_key]
    start = _bucket_of(now - span)

    with _lock:
        buckets = dict(_series.get(host, {}).get(name, {}))

    raw = sorted((s, v) for s, v in buckets.items() if s >= start)

    # Group adjacent buckets so a week doesn't return 2016 points.
    width = BUCKET_SECONDS
    group = max(1, len(raw) // TARGET_POINTS + (1 if len(raw) % TARGET_POINTS else 0))
    if group > 1:
        width = BUCKET_SECONDS * group

    points = []
    for index in range(0, len(raw), group):
        chunk = raw[index : index + group]
        samples = sum(v[2] for _, v in chunk)
        if not samples:
            continue
        points.append({
            "t": chunk[0][0],
            "cpu": round(sum(v[0] for _, v in chunk) / samples, 2),
            "mem": round(sum(v[1] for _, v in chunk) / samples),
        })

    return {
        "host": host,
        "container": name,
        "range": range_key,
        "bucket_seconds": width,
        "retention_days": RETENTION_DAYS,
        "points": points,
    }


def forget_host(host: str) -> None:
    with _lock:
        _series.pop(host, None)


def reset() -> None:
    global _last_persist
    with _lock:
        _series.clear()
    _last_persist = 0.0
