"""In-memory rolling history for data that doesn't come from Prometheus:
GPU temperature and container up/down status. Sampled once per /ws tick
(every 2s), kept for WINDOW_SECONDS, and lost on restart — there's no
underlying time-series store for this the way there is for host metrics.
"""

import time
from collections import deque

WINDOW_SECONDS = 30 * 60
SAMPLE_INTERVAL_SECONDS = 2
MAX_SAMPLES = WINDOW_SECONDS // SAMPLE_INTERVAL_SECONDS
HEARTBEAT_BUCKETS = 30

_gpu_temps: dict[str, deque] = {}
_container_samples: dict[tuple, deque] = {}


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
    containers don't accumulate forever in memory."""
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
