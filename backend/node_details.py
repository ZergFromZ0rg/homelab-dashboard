"""Everything else node_exporter says about a host, for the Servers tab.

``prometheus.get_machine_stats`` carries the handful of numbers every view
needs (CPU, RAM, temperature, disks, traffic) on each 2-second /ws tick.
This is the long tail — OS and kernel, load over 1/5/15 min, where CPU time
goes (user / system / iowait / steal …), each core, clock speed, pressure
stall, the memory breakdown and swap, processes, file handles, sockets,
network errors and drops, how busy each disk is, inode use, and every
temperature sensor on the box.

It is ~25 queries, so it is refreshed at most every ``REFRESH_SECONDS`` and
served from cache in between: these numbers move slowly and nobody reads a
per-core breakdown at 2-second resolution. Each query is independent — a
metric an exporter doesn't have (an older node_exporter, a collector turned
off) just leaves that field out rather than failing the whole host.
"""

from __future__ import annotations

import math
import threading
import time
from collections import defaultdict

from backend import prometheus
from backend.log import system as log

REFRESH_SECONDS = 10

_lock = threading.Lock()
_cache: tuple[float, dict] | None = None


def _vector(promql: str) -> list[tuple[dict, float]]:
    try:
        rows = [(r["metric"], float(r["value"][1])) for r in prometheus.query(promql)]
        # NaN/inf (0/0 inodes on a vfat /boot/efi, say) isn't valid JSON.
        return [(m, v) for m, v in rows if math.isfinite(v)]
    except Exception as error:  # a missing metric must not sink the rest
        log.debug("node detail query failed (%s): %s", promql, error)
        return []


def _by_job(promql: str) -> dict:
    return {m["job"]: v for m, v in _vector(promql) if m.get("job")}


def _round(value, digits=1):
    return None if value is None else round(value, digits)


VIRTUAL = prometheus.VIRTUAL_IFACE_RE


def _collect() -> dict:
    out: dict = defaultdict(dict)

    def put(key, values, digits=1, scale=1.0):
        for job, value in values.items():
            out[job][key] = _round(value * scale, digits)

    # Identity
    for m, _ in _vector("node_os_info"):
        if m.get("job"):
            out[m["job"]]["os"] = m.get("pretty_name") or m.get("name")
    for m, _ in _vector("node_uname_info"):
        if m.get("job"):
            out[m["job"]]["kernel"] = m.get("release")
            out[m["job"]]["arch"] = m.get("machine")
            out[m["job"]]["hostname"] = m.get("nodename")

    # CPU
    put("load5", _by_job("node_load5"), 2)
    put("load15", _by_job("node_load15"), 2)

    modes = defaultdict(dict)
    for m, v in _vector("avg by(job, mode) (rate(node_cpu_seconds_total[1m])) * 100"):
        if m.get("job") and m.get("mode"):
            modes[m["job"]][m["mode"]] = round(v, 1)
    for job, by_mode in modes.items():
        out[job]["cpu_modes"] = by_mode

    cores = defaultdict(list)
    for m, v in _vector(
        '100 - avg by(job, cpu) (rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100'
    ):
        if m.get("job") and m.get("cpu") is not None:
            cores[m["job"]].append((int(m["cpu"]), round(max(0.0, v), 1)))
    for job, rows in cores.items():
        out[job]["per_core"] = [v for _, v in sorted(rows)]

    put("cpu_mhz", _by_job("avg by(job) (node_cpu_scaling_frequency_hertz)"), 0, 1e-6)
    put("cpu_mhz_max", _by_job("max by(job) (node_cpu_scaling_frequency_hertz)"), 0, 1e-6)

    # Pressure stall: share of time something was waiting on CPU / memory / IO.
    for kind in ("cpu", "memory", "io"):
        put(
            f"pressure_{kind}",
            _by_job(f"rate(node_pressure_{kind}_waiting_seconds_total[1m]) * 100"),
            1,
        )

    # Memory
    for key, metric in (
        ("mem_total", "node_memory_MemTotal_bytes"),
        ("mem_available", "node_memory_MemAvailable_bytes"),
        ("mem_free", "node_memory_MemFree_bytes"),
        ("mem_cached", "node_memory_Cached_bytes"),
        ("mem_buffers", "node_memory_Buffers_bytes"),
        ("mem_dirty", "node_memory_Dirty_bytes"),
        ("swap_total", "node_memory_SwapTotal_bytes"),
        ("swap_free", "node_memory_SwapFree_bytes"),
    ):
        put(key, _by_job(metric), 0)

    # Kernel activity
    put("procs_running", _by_job("node_procs_running"), 0)
    put("procs_blocked", _by_job("node_procs_blocked"), 0)
    put("forks_per_s", _by_job("rate(node_forks_total[1m])"), 1)
    put("ctx_switches_per_s", _by_job("rate(node_context_switches_total[1m])"), 0)
    put("interrupts_per_s", _by_job("rate(node_intr_total[1m])"), 0)
    put("fds_open", _by_job("node_filefd_allocated"), 0)
    put("fds_max", _by_job("node_filefd_maximum"), 0)
    put("entropy_bits", _by_job("node_entropy_available_bits"), 0)

    # Sockets and network health
    put("tcp_established", _by_job("node_netstat_Tcp_CurrEstab"), 0)
    put("tcp_time_wait", _by_job("node_sockstat_TCP_tw"), 0)
    put("sockets_used", _by_job("node_sockstat_sockets_used"), 0)
    for key, metric in (
        ("net_rx_errs_per_s", "node_network_receive_errs_total"),
        ("net_tx_errs_per_s", "node_network_transmit_errs_total"),
        ("net_rx_drop_per_s", "node_network_receive_drop_total"),
        ("net_tx_drop_per_s", "node_network_transmit_drop_total"),
    ):
        put(key, _by_job(f'sum by(job) (rate({metric}{{device!~"{VIRTUAL}"}}[1m]))'), 2)

    # Disks: how busy each one is, and inode use per filesystem.
    busy = defaultdict(dict)
    for m, v in _vector("rate(node_disk_io_time_seconds_total[1m]) * 100"):
        if m.get("job") and m.get("device"):
            busy[m["job"]][m["device"]] = round(min(100.0, v), 1)
    for job, rows in busy.items():
        out[job]["disk_busy"] = rows

    inodes = defaultdict(dict)
    for m, v in _vector(
        "100 * (1 - node_filesystem_files_free / node_filesystem_files)"
    ):
        if m.get("job") and m.get("mountpoint"):
            inodes[m["job"]][m["mountpoint"]] = round(v, 1)
    for job, rows in inodes.items():
        out[job]["inodes_used"] = rows

    # Every temperature sensor, named by its chip (k10temp, nvme, acpitz…).
    chip_names = {}
    for m, _ in _vector("node_hwmon_chip_names"):
        if m.get("job") and m.get("chip"):
            chip_names[(m["job"], m["chip"])] = m.get("chip_name")
    sensor_labels = {}
    for m, _ in _vector("node_hwmon_sensor_label"):
        if m.get("job") and m.get("chip") and m.get("sensor"):
            sensor_labels[(m["job"], m["chip"], m["sensor"])] = m.get("label")
    sensors = defaultdict(list)
    for m, v in _vector(
        f"node_hwmon_temp_celsius < {prometheus.MAX_TEMP_C}"
    ):
        job, chip, sensor = m.get("job"), m.get("chip"), m.get("sensor")
        if not (job and chip):
            continue
        sensors[job].append(
            {
                "chip": chip_names.get((job, chip)) or chip,
                "sensor": sensor_labels.get((job, chip, sensor)) or sensor,
                "celsius": round(v, 1),
            }
        )
    for job, rows in sensors.items():
        out[job]["sensors"] = sorted(rows, key=lambda r: (r["chip"], r["sensor"] or ""))

    return dict(out)


def get() -> dict:
    """{job: details}, refreshed at most every REFRESH_SECONDS."""
    global _cache

    now = time.time()
    with _lock:
        if _cache and now - _cache[0] < REFRESH_SECONDS:
            return _cache[1]

    try:
        fresh = _collect()
    except Exception as error:
        log.warning("node details unavailable: %s", error)
        fresh = _cache[1] if _cache else {}

    with _lock:
        _cache = (now, fresh)
    return fresh
