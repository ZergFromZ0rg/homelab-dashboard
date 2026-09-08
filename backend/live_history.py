"""Rolling history for data that doesn't come from Prometheus: GPU
temperature and container up/down status. Sampled once per /ws tick
(every 2s), kept for WINDOW_SECONDS.

Persisted to disk (same volume the node registry uses) so a dashboard
redeploy doesn't wipe history for containers that never actually
restarted — only re-run every PERSIST_INTERVAL_SECONDS regardless of the
2s sample rate, since writing to disk on every single sample would be
wasteful for data this short-lived anyway.
"""

import os
import time
from collections import deque

from backend.jsonstore import read_json, write_json_atomic

WINDOW_SECONDS = 30 * 60
SAMPLE_INTERVAL_SECONDS = 2
MAX_SAMPLES = WINDOW_SECONDS // SAMPLE_INTERVAL_SECONDS
HEARTBEAT_BUCKETS = 30

PERSIST_PATH = os.getenv("LIVE_HISTORY_FILE", "/data/live_history.json")
PERSIST_INTERVAL_SECONDS = 30

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


def maybe_persist() -> None:
    """Call once per /ws tick; actually writes at most every
    PERSIST_INTERVAL_SECONDS regardless of how often it's called."""
    global _last_persisted

    now = time.time()

    if now - _last_persisted >= PERSIST_INTERVAL_SECONDS:
        _last_persisted = now
        _save()


def record_gpu_temp(host: str, temperature_c) -> None:
    if temperature_c is None:
        return

    buf = _gpu_temps.setdefault(host, deque(maxlen=MAX_SAMPLES))
    buf.append({"t": int(time.time()), "v": temperature_c})


def gpu_temp_history(host: str) -> list:
    return list(_gpu_temps.get(host, []))


def record_container_sample(host: str, container_id: str, status: str, health) -> None:
    key = (host, container_id)
    buf = _container_samples.setdefault(key, deque(maxlen=MAX_SAMPLES))
    buf.append({"t": time.time(), "status": status, "health": health})


def prune_containers(live_keys: set) -> None:
    """Drop history for containers that no longer exist, so removed
    containers don't accumulate forever in memory (or on disk)."""
    for key in list(_container_samples.keys()):
        if key not in live_keys:
            del _container_samples[key]


def _is_up(sample: dict) -> bool:
    return sample["status"] == "running" and sample.get("health") != "unhealthy"


def container_heartbeat(host: str, container_id: str) -> dict:
    samples = list(_container_samples.get((host, container_id), []))

    if not samples:
        return {"buckets": [None] * HEARTBEAT_BUCKETS, "uptime_percent": None}

    now = time.time()
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
