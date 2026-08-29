import os
import requests

PROMETHEUS = os.getenv(
    "PROMETHEUS_URL",
    "http://localhost:9090",
)


def query(promql: str):
    response = requests.get(
        f"{PROMETHEUS}/api/v1/query",
        params={"query": promql},
        timeout=5,
    )
    response.raise_for_status()
    return response.json()["data"]["result"]


def value_by_job(promql: str):
    results = query(promql)
    values = {}

    for result in results:
        metric = result["metric"]
        job = metric.get("job")

        if job:
            values[job] = float(result["value"][1])

    return values


def value_by_job_device(promql: str):
    results = query(promql)
    values = {}

    for result in results:
        metric = result["metric"]

        job = metric.get("job")
        device = metric.get("device")

        if job and device:
            values[(job, device)] = float(
                result["value"][1]
            )

    return values


def get_filesystems():
    size_results = query(
        'node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs|vfat"}'
    )

    avail_results = query(
        'node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs|vfat"}'
    )

    avail_lookup = {}

    for result in avail_results:
        metric = result["metric"]

        key = (
            metric.get("job"),
            metric.get("device"),
            metric.get("mountpoint"),
        )

        avail_lookup[key] = float(
            result["value"][1]
        )

    filesystems = {}

    allowed_mounts = {
        "thinkpad": {"/"},
        "bigboy": {"/", "/mnt/cooldrive"},
        "pavilion": {"/"},
    }

    for result in size_results:
        metric = result["metric"]

        job = metric.get("job")
        device = metric.get("device")
        mountpoint = metric.get("mountpoint")

        if job not in allowed_mounts:
            continue

        if mountpoint not in allowed_mounts[job]:
            continue

        total = float(result["value"][1])

        key = (
            job,
            device,
            mountpoint,
        )

        available = avail_lookup.get(key)

        if available is None or total <= 0:
            continue

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

    return filesystems


def get_disk_io():
    reads = value_by_job_device(
        "irate(node_disk_read_bytes_total[1m])"
    )

    writes = value_by_job_device(
        "irate(node_disk_written_bytes_total[1m])"
    )

    device_config = {
        "thinkpad": [
            {
                "name": "System",
                "device": "sda",
            },
        ],
        "bigboy": [
            {
                "name": "NVMe",
                "device": "nvme0n1",
            },
            {
                "name": "Cooldrive",
                "device": "sda",
            },
        ],
        "pavilion": [],
    }

    disk_io = {}

    for host, devices in device_config.items():
        disk_io[host] = []

        for device in devices:
            key = (
                host,
                device["device"],
            )

            disk_io[host].append({
                "name": device["name"],
                "device": device["device"],
                "read_bps": round(
                    reads.get(key, 0),
                    1,
                ),
                "write_bps": round(
                    writes.get(key, 0),
                    1,
                ),
            })

    return disk_io


def get_machine_stats():
    up = value_by_job("up")

    cpu = value_by_job(
        '100 - (avg by(job) (rate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)'
    )

    ram = value_by_job(
        "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)"
    )

    uptime = value_by_job(
        "time() - node_boot_time_seconds"
    )

    load1 = value_by_job(
        "node_load1"
    )

    network_rx = value_by_job(
        'irate(node_network_receive_bytes_total{job="thinkpad",device="enp0s25"}[1m]) or '
        'irate(node_network_receive_bytes_total{job="bigboy",device="enp4s0"}[1m])'
    )

    network_tx = value_by_job(
        'irate(node_network_transmit_bytes_total{job="thinkpad",device="enp0s25"}[1m]) or '
        'irate(node_network_transmit_bytes_total{job="bigboy",device="enp4s0"}[1m])'
    )

    thinkpad_temp = value_by_job(
        'max by(job) (node_hwmon_temp_celsius{job="thinkpad",chip=~"platform_coretemp_.*"})'
    )

    bigboy_temp = value_by_job(
        'max by(job) (node_hwmon_temp_celsius{job="bigboy",chip="pci0000:00_0000:00:18_3"})'
    )

    temperatures = {
        **thinkpad_temp,
        **bigboy_temp,
    }

    filesystems = get_filesystems()
    disk_io = get_disk_io()

    machines = {}

    for host in [
        "thinkpad",
        "bigboy",
        "pavilion",
    ]:
        machines[host] = {
            "online": up.get(host, 0) == 1,
            "cpu": (
                round(cpu[host], 1)
                if host in cpu
                else None
            ),
            "ram": (
                round(ram[host], 1)
                if host in ram
                else None
            ),
            "temperature": (
                round(temperatures[host], 1)
                if host in temperatures
                else None
            ),
            "uptime": (
                int(uptime[host])
                if host in uptime
                else None
            ),
            "load1": (
                round(load1[host], 2)
                if host in load1
                else None
            ),
            "network_rx": (
                round(network_rx[host], 1)
                if host in network_rx
                else None
            ),
            "network_tx": (
                round(network_tx[host], 1)
                if host in network_tx
                else None
            ),
            "filesystems": filesystems.get(
                host,
                [],
            ),
            "disk_io": disk_io.get(
                host,
                [],
            ),
        }

    return machines
