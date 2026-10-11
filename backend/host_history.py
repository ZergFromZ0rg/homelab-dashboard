"""A host's history over hours to months: CPU, memory, load, CPU temperature,
network and disk fill from Prometheus, and the GPU from the dashboard's own store.

The 2-second ``/ws`` stream only carries two hours. For longer ranges the page
asks here, only while someone is looking, and each range is aggregated by
Prometheus itself over one step, so a point is the average (the peak, for
temperature) of its whole step rather than one sample that happened to land on it.
"""

from __future__ import annotations

import re
import time

import requests

from backend import gpu_history, prometheus

# range -> (seconds, step). About 300 points each: more is wasted on a chart.
RANGES = {
    "6h": (6 * 3600, 60),
    "24h": (86400, 300),
    "7d": (7 * 86400, 1800),
    "30d": (30 * 86400, 7200),
    "90d": (90 * 86400, 21600),
}
RANGE_KEYS = tuple(RANGES)

_JOB_RE = re.compile(r"[A-Za-z0-9_.:-]+")
MAX_DISKS = 6


def _points(result: dict) -> list[dict]:
    return [{"t": int(t), "v": None if v == "NaN" else float(v)} for t, v in result["values"]]


def _one(promql: str, start: float, end: float, step: int) -> list[dict]:
    results = prometheus.query_range(promql, start, end, step)
    return _points(results[0]) if results else []


def _temperature_query(job: str, window: str) -> str:
    chips = prometheus._cpu_chip_ids_by_job().get(job)
    chip = f',chip=~"{"|".join(re.escape(c) for c in sorted(chips))}"' if chips else ""
    return f'max(max_over_time(node_hwmon_temp_celsius{{job="{job}"{chip}}}[{window}]) < {prometheus.MAX_TEMP_C})'


def _disks(job: str, window: str, start: float, end: float, step: int) -> list[dict]:
    fs = f'job="{job}",fstype!~"{prometheus.PSEUDO_FSTYPE_RE}"'
    promql = (f"100 * (1 - avg_over_time(node_filesystem_avail_bytes{{{fs}}}[{window}]) "
              f"/ node_filesystem_size_bytes{{{fs}}})")
    seen, out = set(), []
    for result in prometheus.query_range(promql, start, end, step):
        metric = result["metric"]
        mount, device = metric.get("mountpoint", ""), metric.get("device", "")
        if (prometheus.SKIP_MOUNT_RE.match(mount) or mount in prometheus.SKIP_MOUNT_EXACT or device in seen):
            continue
        seen.add(device)  # a bind mount repeats the same filesystem under another path
        out.append({"mountpoint": mount, "device": device, "points": _points(result)})
    out.sort(key=lambda d: d["mountpoint"])
    return out[:MAX_DISKS]


def _prometheus(job: str, start: float, end: float, step: int) -> dict:
    window = f"{max(step, 120)}s"
    virtual = prometheus.VIRTUAL_IFACE_RE
    series = {
        "cpu": _one(f'100 - avg(rate(node_cpu_seconds_total{{job="{job}",mode="idle"}}[{window}])) * 100', start, end, step),
        "ram": _one(
            f'100 * (1 - avg_over_time(node_memory_MemAvailable_bytes{{job="{job}"}}[{window}]) '
            f'/ node_memory_MemTotal_bytes{{job="{job}"}})', start, end, step),
        "load": _one(f'avg_over_time(node_load1{{job="{job}"}}[{window}])', start, end, step),
        "temperature": _one(_temperature_query(job, window), start, end, step),
        "network_rx": _one(
            f'sum(rate(node_network_receive_bytes_total{{job="{job}",device!~"{virtual}"}}[{window}]))', start, end, step),
        "network_tx": _one(
            f'sum(rate(node_network_transmit_bytes_total{{job="{job}",device!~"{virtual}"}}[{window}]))', start, end, step),
    }
    series["disks"] = _disks(job, window, start, end, step)
    return series


def get(host: str, range_key: str, now: float | None = None) -> dict:
    if range_key not in RANGES:
        raise ValueError(f"range must be one of: {', '.join(RANGE_KEYS)}")
    now = time.time() if now is None else now
    span, step = RANGES[range_key]
    out: dict = {"host": host, "range": range_key, "step": step, "start": now - span, "end": now,
                 "prometheus": True, "series": {}, "gpus": gpu_history.history(host, range_key, now)}
    if not _JOB_RE.fullmatch(host):  # it goes into a PromQL label matcher
        out["prometheus"] = False
        return out
    try:
        if host not in prometheus.list_jobs():
            out["prometheus"] = False  # an agent with no node_exporter job: only its GPU has history
            return out
        out["series"] = _prometheus(host, now - span, now, step)
    except (requests.RequestException, ValueError, KeyError) as failure:
        out["prometheus"] = False
        out["error"] = f"Prometheus: {failure}"
    return out
