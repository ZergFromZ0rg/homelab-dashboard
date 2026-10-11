"""GPU load, memory, temperature and power, kept for months.

Prometheus has the host's CPU, memory and disks for as long as it is told to
keep them, but nothing scrapes a GPU: the numbers come from the agent. So the
dashboard keeps its own long view, the same way ``container_history`` does for
containers: every fleet snapshot is folded into fifteen-minute buckets (sums
with sample counts, so the cadence of the loop doesn't matter) and the buckets
are kept for ``GPU_HISTORY_DAYS`` (default 90).

Sizing: 90 days is 8,640 buckets per GPU, about 1 MB of JSON per card, written
every five minutes rather than on every sample.

A GPU is told apart by its PCI slot, so two identical cards keep separate
histories, and a driver that doesn't report a number (an Intel iGPU has no
load) simply has no series for it.

  GPU_HISTORY_DAYS   how long to keep (default 90)
  GPU_HISTORY_FILE   where (default /data/gpu-history.json)
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from backend.env import env_float, env_str
from backend.jsonstore import read_json, write_json_atomic

BUCKET_SECONDS = 900
RETENTION_DAYS = env_float("GPU_HISTORY_DAYS", 90)
RETENTION_SECONDS = RETENTION_DAYS * 86400
PERSIST_INTERVAL_SECONDS = 300
TARGET_POINTS = 300
FILE = Path(env_str("GPU_HISTORY_FILE", "/data/gpu-history.json"))

RANGES = {"6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400}

# metric name -> where it comes from in the agent's device record
METRICS = ("utilization", "active", "memory", "temperature", "power")

_lock = threading.Lock()
# {host: {gpu_key: {"name": str, "buckets": {bucket_start: [sum, n] * len(METRICS)}}}}
_series: dict[str, dict[str, dict]] = {}
_last_persist = 0.0


def _load() -> None:
    raw = read_json(FILE, {})
    if not isinstance(raw, dict):
        return
    width = len(METRICS) * 2
    for host, gpus in raw.items():
        for key, gpu in (gpus.items() if isinstance(gpus, dict) else []):
            buckets = {}
            for start, values in ((gpu or {}).get("buckets") or {}).items():
                try:
                    if len(values) == width:
                        buckets[int(start)] = [float(v) for v in values]
                except (TypeError, ValueError):
                    continue
            if buckets:
                _series.setdefault(host, {})[key] = {"name": str(gpu.get("name") or key), "buckets": buckets}


_load()


def _bucket_of(now: float) -> int:
    return int(now // BUCKET_SECONDS) * BUCKET_SECONDS


def _values(device: dict) -> dict[str, float | None]:
    used, total = device.get("memory_used_mb"), device.get("memory_total_mb")
    memory = used / total * 100 if isinstance(used, (int, float)) and isinstance(total, (int, float)) and total else None
    return {
        "utilization": device.get("utilization_percent"),
        "active": device.get("active_percent"),
        "memory": memory,
        "temperature": device.get("temperature_c"),
        "power": device.get("power_draw_w"),
    }


def key_of(device: dict, index: int) -> str:
    return device.get("pci_slot") or f"gpu{index}"


def record(machines: dict, now: float | None = None) -> None:
    """Fold one fleet snapshot into the current bucket. Hosts whose agent isn't
    answering (the dashboard is replaying its last good answer) are skipped, so a
    stale number is never counted twice."""
    now = time.time() if now is None else now
    bucket = _bucket_of(now)
    cutoff = bucket - RETENTION_SECONDS
    with _lock:
        for host, machine in (machines or {}).items():
            if machine.get("agent_stale_age") is not None or machine.get("agent_reachable") is False:
                continue
            for index, device in enumerate(((machine.get("gpu") or {}).get("devices")) or []):
                values = _values(device)
                if all(v is None for v in values.values()):
                    continue
                gpu = _series.setdefault(host, {}).setdefault(key_of(device, index), {"name": "", "buckets": {}})
                gpu["name"] = device.get("name") or gpu["name"]
                slot = gpu["buckets"].setdefault(bucket, [0.0] * (len(METRICS) * 2))
                for i, metric in enumerate(METRICS):
                    if isinstance(values[metric], (int, float)):
                        slot[i * 2] += float(values[metric])
                        slot[i * 2 + 1] += 1
                for start in [s for s in gpu["buckets"] if s < cutoff]:
                    del gpu["buckets"][start]
    _maybe_persist(now)


def _maybe_persist(now: float) -> None:
    global _last_persist
    if now - _last_persist < PERSIST_INTERVAL_SECONDS:
        return
    _last_persist = now
    with _lock:
        snapshot = {
            host: {
                key: {"name": gpu["name"], "buckets": {str(s): [round(v, 2) for v in values] for s, values in gpu["buckets"].items()}}
                for key, gpu in gpus.items() if gpu["buckets"]
            }
            for host, gpus in _series.items()
        }
    write_json_atomic(FILE, snapshot, label="gpu history", indent=None)


def history(host: str, range_key: str = "24h", now: float | None = None) -> list[dict]:
    """One entry per GPU on ``host``: ``{key, name, points: [{t, utilization,
    active, memory, temperature, power}]}``, with a field left out of a point
    when nothing reported it, downsampled to what a chart can draw."""
    if range_key not in RANGES:
        raise ValueError(f"range must be one of: {', '.join(RANGES)}")
    now = time.time() if now is None else now
    start = _bucket_of(now - RANGES[range_key])
    with _lock:
        gpus = {key: (gpu["name"], dict(gpu["buckets"])) for key, gpu in _series.get(host, {}).items()}

    out = []
    for key, (name, buckets) in sorted(gpus.items()):
        raw = sorted((s, v) for s, v in buckets.items() if s >= start)
        group = max(1, -(-len(raw) // TARGET_POINTS))  # ceil
        points = []
        for index in range(0, len(raw), group):
            chunk = raw[index:index + group]
            point: dict = {"t": chunk[0][0]}
            for i, metric in enumerate(METRICS):
                n = sum(v[i * 2 + 1] for _, v in chunk)
                if n:
                    point[metric] = round(sum(v[i * 2] for _, v in chunk) / n, 2)
            if len(point) > 1:
                points.append(point)
        out.append({"key": key, "name": name, "points": points})
    return out


def forget_host(host: str) -> None:
    with _lock:
        _series.pop(host, None)


def reset() -> None:
    global _last_persist
    with _lock:
        _series.clear()
    _last_persist = 0.0
