import os
import re
import time

import requests

PROMETHEUS = os.getenv(
    "PROMETHEUS_URL",
    "http://localhost:9090",
)

# History charts cover the last 30 minutes at 1-minute resolution. The
# range query is only re-run every HISTORY_REFRESH_SECONDS regardless of
# how often get_machine_history() is called — the /ws loop calls it every
# 2s, but re-running a 30-minute range query that often would just hammer
# Prometheus for data that hasn't meaningfully changed.
HISTORY_WINDOW_SECONDS = 30 * 60
HISTORY_STEP_SECONDS = 60
HISTORY_REFRESH_SECONDS = 30

_history_cache = {"data": {}, "fetched_at": 0.0}

# Virtual / container / VPN interfaces to keep out of host network totals.
# RE2 anchors the whole string, so "lo" matches only "lo", real NICs
# (eth0, enp3s0, wlan0, ...) pass through.
VIRTUAL_IFACE_RE = (
    "lo|docker.*|veth.*|br-.*|virbr.*|vnet.*|tailscale.*|wg.*|tun.*|tap.*"
    "|cni.*|cali.*|flannel.*|kube.*|nerdctl.*|cilium.*|ovs.*|bond.*|dummy.*"
)

# Whole physical disks only (no partitions, loop, dm, ram, zram, cd-rom).
WHOLE_DISK_RE = (
    "sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk[0-9]+"
)

# Pseudo / ephemeral filesystems that are not real storage. Deliberately
# excludes "fuse*" as a family — fuseblk (ntfs-3g) and sshfs/rclone mounts
# are real disks a homelab actually cares about; only the kernel pseudo-fs
# families below are structurally never storage.
PSEUDO_FSTYPE_RE = (
    "tmpfs|overlay|squashfs|ramfs|devtmpfs|efivarfs|autofs|nsfs|tracefs"
    "|debugfs|securityfs|fusectl|configfs|bpf|cgroup.*|proc|sysfs|mqueue"
    "|pstore|rpc_pipefs|binfmt_misc"
)

SKIP_MOUNT_RE = re.compile(
    r"^/(boot|dev|proc|sys|run|snap|var/lib/docker|var/lib/kubelet|var/snap)(/|$)"
)

# Docker auto-bind-mounts these single files from the host into every
# container (for hostname/DNS resolution). node_exporter running
# containerized reports each as if it were its own filesystem mount,
# duplicating the real root filesystem — drop them by exact mountpoint.
SKIP_MOUNT_EXACT = {
    "/etc/hostname",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/mtab",
    "/etc/timezone",
}

# Highest plausible CPU/board temperature in Celsius; anything above is a
# bogus sensor reading and is dropped.
MAX_TEMP_C = 115


def query(promql: str):
    response = requests.get(
        f"{PROMETHEUS}/api/v1/query",
        params={"query": promql},
        timeout=5,
    )
    response.raise_for_status()
    return response.json()["data"]["result"]


def value_by_job(promql: str):
    values = {}

    for result in query(promql):
        job = result["metric"].get("job")

        if job:
            values[job] = float(result["value"][1])

    return values


def value_by_job_device(promql: str):
    values = {}

    for result in query(promql):
        metric = result["metric"]
        job = metric.get("job")
        device = metric.get("device")

        if job and device:
            values[(job, device)] = float(result["value"][1])

    return values


def list_jobs() -> list[str]:
    """Every Prometheus job that exposes node_exporter metrics."""
    jobs = set()

    for result in query("count by (job) (node_boot_time_seconds)"):
        job = result["metric"].get("job")

        if job:
            jobs.add(job)

    return sorted(jobs)


def get_cpu_models() -> dict:
    """job -> CPU model_name, from node_cpu_info (requires node_exporter's
    --collector.cpu.info flag; absent jobs just get no model string)."""
    models = {}

    for result in query("node_cpu_info"):
        job = result["metric"].get("job")
        model = result["metric"].get("model_name")

        if job and model and job not in models:
            models[job] = re.sub(r"\s+", " ", model).strip()

    return models


def get_physical_cores() -> dict:
    """job -> physical core count, from node_cpu_info's (package, core)
    labels. Needs --collector.cpu.info; a job whose export doesn't carry
    both labels (some VMs / ARM) just gets no entry, and the UI falls back
    to the logical count."""
    seen: dict[str, set] = {}

    for result in query("node_cpu_info"):
        metric = result["metric"]
        job = metric.get("job")
        package = metric.get("package")
        core = metric.get("core")

        if job is None or package is None or core is None:
            continue

        seen.setdefault(job, set()).add((package, core))

    return {job: len(pairs) for job, pairs in seen.items() if pairs}


def get_filesystems():
    size_results = query(
        f'node_filesystem_size_bytes{{fstype!~"{PSEUDO_FSTYPE_RE}"}}'
    )

    avail_results = query(
        f'node_filesystem_avail_bytes{{fstype!~"{PSEUDO_FSTYPE_RE}"}}'
    )

    avail_lookup = {}

    for result in avail_results:
        metric = result["metric"]

        key = (
            metric.get("job"),
            metric.get("device"),
            metric.get("mountpoint"),
        )

        avail_lookup[key] = float(result["value"][1])

    # (job, device) -> [(mountpoint, total_bytes, available_bytes), ...]
    by_device: dict[tuple, list] = {}

    for result in size_results:
        metric = result["metric"]

        job = metric.get("job")
        device = metric.get("device")
        mountpoint = metric.get("mountpoint")

        if not job or not device or not mountpoint:
            continue

        if SKIP_MOUNT_RE.match(mountpoint):
            continue

        total = float(result["value"][1])
        available = avail_lookup.get((job, device, mountpoint))

        if available is None or total <= 0:
            continue

        by_device.setdefault((job, device), []).append(
            (mountpoint, total, available)
        )

    filesystems = {}

    for (job, device), entries in by_device.items():
        # A containerized node_exporter often can't see the real host "/"
        # at all — only the three files Docker auto-bind-mounts from it
        # (/etc/hostname, /etc/hosts, /etc/resolv.conf), each reported as
        # its own "mount" of the same device. Collapse one device down to
        # a single row: prefer a genuinely-named mountpoint if any is
        # present, otherwise relabel one of those bind files as "/",
        # since that's what it actually represents.
        real = [entry for entry in entries if entry[0] not in SKIP_MOUNT_EXACT]
        mountpoint, total, available = (real or entries)[0]

        if mountpoint in SKIP_MOUNT_EXACT:
            mountpoint = "/"

        used = total - available
        used_percent = (used / total) * 100

        filesystems.setdefault(job, []).append({
            "device": device,
            "mountpoint": mountpoint,
            "total_bytes": int(total),
            "used_bytes": int(used),
            "free_bytes": int(available),
            "used_percent": round(used_percent, 1),
        })

    for entries in filesystems.values():
        entries.sort(key=lambda item: item["mountpoint"])

    return filesystems


def get_disk_io():
    reads = value_by_job_device(
        f'irate(node_disk_read_bytes_total{{device=~"{WHOLE_DISK_RE}"}}[1m])'
    )

    writes = value_by_job_device(
        f'irate(node_disk_written_bytes_total{{device=~"{WHOLE_DISK_RE}"}}[1m])'
    )

    disk_io = {}

    for (job, device), read_bps in sorted(reads.items()):
        disk_io.setdefault(job, []).append({
            "name": device,
            "device": device,
            "read_bps": round(read_bps, 1),
            "write_bps": round(writes.get((job, device), 0.0), 1),
        })

    # Devices that only showed up in the write series.
    for (job, device), write_bps in sorted(writes.items()):
        if (job, device) in reads:
            continue

        disk_io.setdefault(job, []).append({
            "name": device,
            "device": device,
            "read_bps": 0.0,
            "write_bps": round(write_bps, 1),
        })

    return disk_io


# hwmon driver names for the actual CPU package/die sensor. Without this,
# "highest sensor on the box" just as easily picks an NVMe drive's temp3
# (composite/max, often hotter than the CPU) or a laptop's chassis/ACPI
# sensor over the real CPU reading.
CPU_HWMON_CHIP_NAMES = {"k10temp", "coretemp", "zenpower", "cpu_thermal"}


def _cpu_chip_ids_by_job() -> dict:
    cpu_chips: dict[str, set] = {}

    for result in query("node_hwmon_chip_names"):
        metric = result["metric"]
        job = metric.get("job")
        chip = metric.get("chip")
        chip_name = metric.get("chip_name")

        if job and chip and chip_name in CPU_HWMON_CHIP_NAMES:
            cpu_chips.setdefault(job, set()).add(chip)

    return cpu_chips


def get_cpu_temperatures() -> dict:
    cpu_chips = _cpu_chip_ids_by_job()

    if not cpu_chips:
        return {}

    temperatures: dict[str, float] = {}

    for result in query(f"node_hwmon_temp_celsius < {MAX_TEMP_C}"):
        metric = result["metric"]
        job = metric.get("job")
        chip = metric.get("chip")

        if job not in cpu_chips or chip not in cpu_chips[job]:
            continue

        value = float(result["value"][1])
        temperatures[job] = max(temperatures.get(job, value), value)

    return temperatures


def query_range(promql: str, start: float, end: float, step: int):
    response = requests.get(
        f"{PROMETHEUS}/api/v1/query_range",
        params={"query": promql, "start": start, "end": end, "step": step},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["data"]["result"]


def _series_by_job(promql: str, start: float, end: float, step: int) -> dict:
    series = {}

    for result in query_range(promql, start, end, step):
        job = result["metric"].get("job")

        if not job:
            continue

        series[job] = [
            {"t": int(t), "v": None if v == "NaN" else float(v)}
            for t, v in result["values"]
        ]

    return series


def _temperature_history(start: float, end: float, step: int) -> dict:
    """Same CPU-chip preference as get_cpu_temperatures(), as a range query.

    Queried per-job (not one query with chip=~"a|b|c" across all jobs) so a
    chip id that happens to collide between two different hosts can't leak
    one host's sensor into another's series.
    """
    cpu_chips = _cpu_chip_ids_by_job()
    result = {}

    for job in list_jobs():
        chips = cpu_chips.get(job)

        if chips:
            chip_re = "|".join(re.escape(chip) for chip in sorted(chips))
            promql = (
                f'max by(job) (node_hwmon_temp_celsius'
                f'{{job="{job}",chip=~"{chip_re}"}} < {MAX_TEMP_C})'
            )
        else:
            promql = (
                f'max by(job) (node_hwmon_temp_celsius'
                f'{{job="{job}"}} < {MAX_TEMP_C})'
            )

        series = _series_by_job(promql, start, end, step)

        if job in series:
            result[job] = series[job]

    return result


def get_machine_history() -> dict:
    """Per-job CPU/RAM/network time series for sparkline charts.

    Re-queries Prometheus at most once every HISTORY_REFRESH_SECONDS;
    calls in between return the cached result.
    """
    now = time.time()

    if (
        _history_cache["data"]
        and now - _history_cache["fetched_at"] < HISTORY_REFRESH_SECONDS
    ):
        return _history_cache["data"]

    end = now
    start = now - HISTORY_WINDOW_SECONDS
    step = HISTORY_STEP_SECONDS

    cpu = _series_by_job(
        '100 - (avg by(job) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
        start,
        end,
        step,
    )

    ram = _series_by_job(
        "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)",
        start,
        end,
        step,
    )

    network_rx = _series_by_job(
        f'sum by(job) (irate(node_network_receive_bytes_total'
        f'{{device!~"{VIRTUAL_IFACE_RE}"}}[5m]))',
        start,
        end,
        step,
    )

    network_tx = _series_by_job(
        f'sum by(job) (irate(node_network_transmit_bytes_total'
        f'{{device!~"{VIRTUAL_IFACE_RE}"}}[5m]))',
        start,
        end,
        step,
    )

    temperature = _temperature_history(start, end, step)

    jobs = set(cpu) | set(ram) | set(network_rx) | set(network_tx)

    history = {
        job: {
            "cpu": cpu.get(job, []),
            "ram": ram.get(job, []),
            "temperature": temperature.get(job, []),
            "network_rx": network_rx.get(job, []),
            "network_tx": network_tx.get(job, []),
        }
        for job in jobs
    }

    _history_cache["data"] = history
    _history_cache["fetched_at"] = now
    return history


def get_machine_stats():
    jobs = list_jobs()

    up = value_by_job("up")

    cpu = value_by_job(
        '100 - (avg by(job) (rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)'
    )

    ram = value_by_job(
        "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)"
    )

    ram_total = value_by_job("node_memory_MemTotal_bytes")

    # Logical CPUs (threads) — one node_cpu_seconds_total series per
    # logical processor. This is the unit ``cpu`` utilisation is averaged
    # over and the unit Docker's --cpus flag operates in, so it's what the
    # scheduler reserves against. Physical core count is reported
    # separately, for display.
    cpu_cores = value_by_job(
        "count by(job) (count by(job, cpu) (node_cpu_seconds_total))"
    )
    physical_cores = get_physical_cores()

    cpu_models = get_cpu_models()

    uptime = value_by_job("time() - node_boot_time_seconds")

    load1 = value_by_job("node_load1")

    network_rx = value_by_job(
        f'sum by(job) (irate(node_network_receive_bytes_total'
        f'{{device!~"{VIRTUAL_IFACE_RE}"}}[1m]))'
    )

    network_tx = value_by_job(
        f'sum by(job) (irate(node_network_transmit_bytes_total'
        f'{{device!~"{VIRTUAL_IFACE_RE}"}}[1m]))'
    )

    # Prefer the real CPU sensor (k10temp/coretemp/...); only fall back to
    # "hottest sensor on the box" for a job with no recognized CPU chip.
    fallback_temperatures = value_by_job(
        f"max by(job) (node_hwmon_temp_celsius < {MAX_TEMP_C})"
    )
    temperatures = {**fallback_temperatures, **get_cpu_temperatures()}

    filesystems = get_filesystems()
    disk_io = get_disk_io()

    machines = {}

    for host in jobs:
        machines[host] = {
            "online": up.get(host, 0) == 1,
            "cpu": round(cpu[host], 1) if host in cpu else None,
            "cpu_cores": int(cpu_cores[host]) if host in cpu_cores else None,
            "cpu_physical_cores": (
                int(physical_cores[host]) if host in physical_cores else None
            ),
            "cpu_model": cpu_models.get(host),
            "ram": round(ram[host], 1) if host in ram else None,
            "ram_total_bytes": (
                int(ram_total[host]) if host in ram_total else None
            ),
            "temperature": (
                round(temperatures[host], 1)
                if host in temperatures
                else None
            ),
            "uptime": int(uptime[host]) if host in uptime else None,
            "load1": round(load1[host], 2) if host in load1 else None,
            "network_rx": (
                round(network_rx[host], 1) if host in network_rx else None
            ),
            "network_tx": (
                round(network_tx[host], 1) if host in network_tx else None
            ),
            "filesystems": filesystems.get(host, []),
            "disk_io": disk_io.get(host, []),
        }

    return machines
