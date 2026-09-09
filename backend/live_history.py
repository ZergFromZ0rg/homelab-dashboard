"""Rolling history for data that doesn't come from Prometheus: GPU
temperature and container up/down status. ``record_fleet`` is called every
reconcile tick (~5s) — from the always-on loop, *not* the /ws loop, so the
heartbeat has no gaps when no browser is connected. Kept for
WINDOW_SECONDS.

Persisted to disk (same volume the node registry uses) so a dashboard
redeploy doesn't wipe history for containers that never actually
restarted — only re-written every PERSIST_INTERVAL_SECONDS, since writing
on every sample would be wasteful for data this short-lived.
"""

import os
import threading
import time
from collections import deque

from backend.jsonstore import read_json, write_json_atomic

WINDOW_SECONDS = 30 * 60
# The sample cadence is the reconcile loop's (~5s); size the ring buffer
# for a bit more than one full window at that rate.
MAX_SAMPLES = WINDOW_SECONDS // 4
HEARTBEAT_BUCKETS = 30

PERSIST_PATH = os.getenv("LIVE_HISTORY_FILE", "/data/live_history.json")
PERSIST_INTERVAL_SECONDS = 30

# ``record_fleet`` runs on the reconcile thread while the /ws coroutine
# reads ``container_heartbeat`` / ``gpu_temp_history`` on the event loop —
# different threads, so guard the shared buffers.
_lock = threading.Lock()
_gpu_temps: dict[str, deque] = {}
_container_samples: dict[tuple, deque] = {}
_last_persisted = 0.0


def _load() -> None:
    data = read_json(PERSIST_PATH, None)
    if not isinstance(data, dict):
        return

    now = time.time()

    for host, points in (data.get("gpu_temps") or {}).items():
        fresh = [p for p in points if now - p["t"] < WINDOW_SECONDS]

        if fresh:
            _gpu_temps[host] = deque(fresh, maxlen=MAX_SAMPLES)

    for key, samples in (data.get("container_samples") or {}).items():
        host, _, container_id = key.partition("|")
        fresh = [s for s in samples if now - s["t"] < WINDOW_SECONDS]

        if fresh:
            _container_samples[(host, container_id)] = deque(
                fresh, maxlen=MAX_SAMPLES
            )


def _save() -> None:
    write_json_atomic(
        PERSIST_PATH,
        {
            "gpu_temps": {host: list(buf) for host, buf in _gpu_temps.items()},
            "container_samples": {
                f"{host}|{container_id}": list(buf)
                for (host, container_id), buf in _container_samples.items()
            },
        },
        label="live_history",
        indent=None,
    )


def _maybe_persist_locked() -> None:
    global _last_persisted
    now = time.time()
    if now - _last_persisted >= PERSIST_INTERVAL_SECONDS:
        _last_persisted = now
        _save()


def record_fleet(machines: dict, containers: dict[str, list]) -> None:
    """One sampling pass over the whole fleet: GPU package temperature and
    every container's up/down state. Called from the reconcile loop.

    ``machines`` supplies ``machines[host]["gpu"]``; ``containers`` is
    ``{host: [container, ...]}``.
    """
    now = time.time()
    live_keys = set()

    with _lock:
        for host, conts in containers.items():
            devices = ((machines.get(host) or {}).get("gpu") or {}).get("devices") or []
            temp = devices[0].get("temperature_c") if devices else None
            if temp is not None:
                _gpu_temps.setdefault(host, deque(maxlen=MAX_SAMPLES)).append(
                    {"t": int(now), "v": temp}
                )

            for c in conts:
                key = (host, c["id"])
                _container_samples.setdefault(key, deque(maxlen=MAX_SAMPLES)).append(
                    {"t": now, "status": c["status"], "health": c.get("health")}
                )
                live_keys.add(key)

        # Drop history for containers that no longer exist so removed ones
        # don't accumulate forever in memory (or on disk).
        for key in list(_container_samples):
            if key not in live_keys:
                del _container_samples[key]

        _maybe_persist_locked()


def gpu_temp_history(host: str) -> list:
    with _lock:
        return list(_gpu_temps.get(host, []))


def _is_up(sample: dict) -> bool:
    return sample["status"] == "running" and sample.get("health") != "unhealthy"


def container_heartbeat(host: str, container_id: str) -> dict:
    now = time.time()

    with _lock:
        samples = [
            s
            for s in _container_samples.get((host, container_id), [])
            if s["t"] >= now - WINDOW_SECONDS
        ]

    if not samples:
        return {"buckets": [None] * HEARTBEAT_BUCKETS, "uptime_percent": None}

    bucket_seconds = WINDOW_SECONDS / HEARTBEAT_BUCKETS
    buckets = []

    for i in range(HEARTBEAT_BUCKETS):
        bucket_start = now - WINDOW_SECONDS + i * bucket_seconds
        bucket_end = bucket_start + bucket_seconds
        bucket_samples = [
            s for s in samples if bucket_start <= s["t"] < bucket_end
        ]

        if not bucket_samples:
            buckets.append(None)
        else:
            buckets.append("up" if all(_is_up(s) for s in bucket_samples) else "down")

    up_count = sum(1 for s in samples if _is_up(s))
    uptime_percent = round(100 * up_count / len(samples), 1)

    return {"buckets": buckets, "uptime_percent": uptime_percent}


_load()
