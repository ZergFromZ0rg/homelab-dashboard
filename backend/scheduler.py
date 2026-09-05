"""Deterministic placement scoring.

Given a ``DeploymentSpec`` and the same per-host stats the dashboard
already streams (``get_machine_stats()`` output, plus the agent GPU blob
and the registry's stale flags), rank every node. No I/O, no LLM — this is
pure arithmetic so it can be unit tested with plain dicts.

The LLM, when enabled, only feeds this function a cleaner ``Constraints``
and narrates its output afterward. It never changes the ranking.
"""

from __future__ import annotations

from backend.models import Constraints, DeploymentSpec, PlacementResult

MB = 1024 * 1024

# Fallback rootfs footprint when we can't inspect the image manifest.
DEFAULT_IMAGE_MB = 500

# Rough compressed-then-unpacked sizes for common bases, matched as a
# substring of the image ref. Only used for the disk hard filter, so being
# approximate is fine.
IMAGE_SIZE_HINTS_MB = {
    "alpine": 20,
    "busybox": 10,
    "nginx": 200,
    "redis": 150,
    "postgres": 450,
    "mariadb": 600,
    "mysql": 600,
    "python": 1000,
    "node": 1100,
    "jellyfin": 1300,
    "plex": 400,
    "homeassistant": 1800,
    "home-assistant": 1800,
    "pytorch": 7000,
    "tensorflow": 6000,
    "cuda": 4000,
}

# Penalty weights.
PENALTY_GPU_WASTED = 15  # non-GPU workload landing on a GPU box
PENALTY_HOT = 10  # CPU sensor already above HOT_TEMP_C
PENALTY_STALE = 20  # registry hasn't heard from the agent recently
HOT_TEMP_C = 75


def estimate_image_mb(image: str) -> int:
    ref = image.lower()
    for hint, size in IMAGE_SIZE_HINTS_MB.items():
        if hint in ref:
            return size
    return DEFAULT_IMAGE_MB


def _node_gpu(machine: dict) -> bool:
    gpu = machine.get("gpu") or {}
    return bool(gpu.get("devices"))


def _free_disk_bytes(machine: dict) -> float | None:
    filesystems = machine.get("filesystems") or []
    frees = [
        fs["free_bytes"]
        for fs in filesystems
        if isinstance(fs.get("free_bytes"), (int, float))
    ]
    return max(frees) if frees else None


def _managed_count(host: str, deployments: list[dict] | None) -> int:
    if not deployments:
        return 0
    return sum(
        1
        for d in deployments
        if d.get("placed_on") == host and d.get("status") in ("running", "placing")
    )


def score_node(
    host: str,
    machine: dict,
    spec: DeploymentSpec,
    *,
    stale: bool = False,
) -> PlacementResult:
    res = spec.resources
    con = spec.constraints
    reasons: list[str] = []

    has_gpu = _node_gpu(machine)
    ram_total = machine.get("ram_total_bytes")
    ram_pct = machine.get("ram")
    cpu_pct = machine.get("cpu")
    cores = machine.get("cpu_cores")
    temp = machine.get("temperature")

    free_ram_mb = None
    if isinstance(ram_total, (int, float)) and isinstance(ram_pct, (int, float)):
        free_ram_mb = int(ram_total * (1 - ram_pct / 100) / MB)

    free_cpu_cores = None
    if isinstance(cores, (int, float)) and isinstance(cpu_pct, (int, float)):
        free_cpu_cores = round(cores * (1 - cpu_pct / 100), 2)

    def disqualify(reason: str) -> PlacementResult:
        return PlacementResult(
            node=host,
            eligible=False,
            score=0.0,
            reasons=[reason],
            free_ram_mb=free_ram_mb,
            free_cpu_cores=free_cpu_cores,
            has_gpu=has_gpu,
        )

    # ---- hard filters -------------------------------------------------
    if not machine.get("online", False):
        return disqualify("node is offline")

    if con.require_gpu and not has_gpu:
        return disqualify("workload requires a GPU; this node has none")

    if con.node_in and host not in con.node_in:
        return disqualify("excluded: not in the allowed node list")

    if con.node_not_in and host in con.node_not_in:
        return disqualify("excluded: on the disallowed node list")

    if con.max_node_cpu_percent is not None and isinstance(cpu_pct, (int, float)):
        if cpu_pct > con.max_node_cpu_percent:
            return disqualify(
                f"CPU at {cpu_pct:.0f}% is over the {con.max_node_cpu_percent:.0f}% ceiling"
            )

    if res.memory_mb is not None:
        if free_ram_mb is None:
            return disqualify("RAM stats unavailable; cannot guarantee the memory limit")
        if free_ram_mb < res.memory_mb:
            return disqualify(
                f"only {free_ram_mb} MB RAM free, needs {res.memory_mb} MB"
            )

    if res.cpus is not None:
        if cores is None:
            return disqualify("CPU stats unavailable; cannot satisfy the CPU request")
        if res.cpus > cores:
            return disqualify(
                f"requests {res.cpus} cores, node has only {cores}"
            )

    image_mb = estimate_image_mb(spec.image)
    free_disk = _free_disk_bytes(machine)
    if free_disk is not None and free_disk < image_mb * MB:
        return disqualify(
            f"~{image_mb} MB needed for the image, only "
            f"{free_disk / MB / 1024:.1f} GB free on disk"
        )

    # ---- fit score --------------------------------------------------
    # Worst-fit: prefer the node left with the *most* headroom after
    # placement, so load spreads instead of piling onto one box.
    if free_ram_mb is not None and isinstance(ram_total, (int, float)):
        ram_after = free_ram_mb - (res.memory_mb or 0)
        ram_frac = max(0.0, min(1.0, ram_after / (ram_total / MB)))
    elif isinstance(ram_pct, (int, float)):
        ram_frac = max(0.0, 1 - ram_pct / 100)
    else:
        ram_frac = 0.5

    if free_cpu_cores is not None and isinstance(cores, (int, float)) and cores:
        cpu_after = free_cpu_cores - (res.cpus or 0)
        cpu_frac = max(0.0, min(1.0, cpu_after / cores))
    elif isinstance(cpu_pct, (int, float)):
        cpu_frac = max(0.0, 1 - cpu_pct / 100)
    else:
        cpu_frac = 0.5

    score = 100 * (0.5 * ram_frac + 0.5 * cpu_frac)

    if free_ram_mb is not None:
        reasons.append(f"{free_ram_mb / 1024:.1f} GB RAM free before placement")
    if free_cpu_cores is not None:
        reasons.append(f"{free_cpu_cores:.1f} CPU cores idle")

    # ---- penalties -------------------------------------------------
    if has_gpu and not con.require_gpu:
        score -= PENALTY_GPU_WASTED
        reasons.append("has a GPU (kept free for GPU workloads): -15")

    if isinstance(temp, (int, float)) and temp > HOT_TEMP_C:
        score -= PENALTY_HOT
        reasons.append(f"CPU sensor at {temp:.0f} °C: -10")

    if stale:
        score -= PENALTY_STALE
        reasons.append("agent registration is stale: -20")

    score = max(0.0, min(100.0, score))

    return PlacementResult(
        node=host,
        eligible=True,
        score=round(score, 1),
        reasons=reasons,
        free_ram_mb=free_ram_mb,
        free_cpu_cores=free_cpu_cores,
        has_gpu=has_gpu,
    )


def score_nodes(
    spec: DeploymentSpec,
    machines: dict[str, dict],
    *,
    stale_hosts: set[str] | None = None,
    deployments: list[dict] | None = None,
) -> list[PlacementResult]:
    """Rank every known node, best first.

    Ineligible nodes are still returned (score 0, ``eligible=False``) with
    the disqualifying reason so the UI can show "why not".
    """
    stale_hosts = stale_hosts or set()

    results = [
        score_node(host, machine, spec, stale=host in stale_hosts)
        for host, machine in machines.items()
    ]

    # eligible first, then score desc, then fewest managed containers, then name
    results.sort(
        key=lambda r: (
            not r.eligible,
            -r.score,
            _managed_count(r.node, deployments),
            r.node,
        )
    )
    return results


def recommended_node(ranked: list[PlacementResult]) -> str | None:
    for result in ranked:
        if result.eligible:
            return result.node
    return None
