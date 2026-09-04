import os
import re

import requests

PROMETHEUS = os.getenv(
    "PROMETHEUS_URL",
    "http://localhost:9090",
)

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


def get_machine_stats():
    jobs = list_jobs()

    up = value_by_job("up")

    cpu = value_by_job(
        '100 - (avg by(job) (rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)'
    )

    ram = value_by_job(
        "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)"
    )

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

    temperatures = value_by_job(
        f"max by(job) (node_hwmon_temp_celsius < {MAX_TEMP_C})"
    )

    filesystems = get_filesystems()
    disk_io = get_disk_io()

    machines = {}

    for host in jobs:
        machines[host] = {
            "online": up.get(host, 0) == 1,
            "cpu": round(cpu[host], 1) if host in cpu else None,
            "ram": round(ram[host], 1) if host in ram else None,
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
