"""Fallback "this container looks busy right now" signal for containers
service_activity has no answer for — no dedicated probe matched (or
matched but got nothing back: no credentials set, request failed, or the
app genuinely reports idle). Rather than a fixed global threshold (normal
load varies wildly between containers — a monitoring agent parked at 20%
CPU is unremarkable, qBittorrent jumping from 0% to 20% is not), each
container is compared against its own recent baseline.

Baseline is an EWMA of CPU% and RX/TX network bytes/sec, updated once per
reconcile tick (~5s) from the always-on loop (record_fleet), same
reasoning as live_history — it keeps learning with no browser connected.
The EWMA is frozen (not updated) while a spike is active, so a sustained
spike can't drag its own baseline up and quietly erase itself.

Purely a local computation on stats already being polled for the /ws
payload — no HTTP calls, so unlike service_activity there's nothing to
cache or dispatch to a thread; busy() is cheap enough to call inline.

Baselines are in-memory only, not persisted — like activity.py's diff
state, losing them on a restart just means a few quiet ticks before the
fallback starts working again, not incorrect data.
"""

from __future__ import annotations

from backend.env import env_float

# A spike needs BOTH a big-enough relative jump (>= FACTOR times
# baseline) and a big-enough absolute jump (>= MIN_DELTA) — relative
# alone would flag a container idling near zero for a trivial wobble
# (0.1% -> 0.5% CPU is technically "5x baseline" but not a spike);
# absolute alone would flag a container that's simply always busy.
CPU_FACTOR = env_float("RESOURCE_ACTIVITY_CPU_FACTOR", 3.0)
CPU_MIN_DELTA = env_float("RESOURCE_ACTIVITY_CPU_MIN_DELTA", 10.0)  # percentage points
NET_FACTOR = env_float("RESOURCE_ACTIVITY_NET_FACTOR", 3.0)
NET_MIN_DELTA_BPS = env_float("RESOURCE_ACTIVITY_NET_MIN_BPS", 512_000)  # ~512 KB/s

# EWMA smoothing for the baseline — higher adapts to a new normal faster.
_EWMA_ALPHA = 0.2

_baseline: dict[tuple, dict] = {}


def _is_spike(current: float, baseline: float, factor: float, min_delta: float) -> bool:
    return current >= baseline * factor and (current - baseline) >= min_delta


def _metrics(container: dict) -> tuple[float, float, float]:
    stats = container.get("stats") or {}
    cpu = stats.get("cpu_percent") or 0.0
    network = stats.get("network") or {}
    rx = network.get("rx_bps") or 0.0
    tx = network.get("tx_bps") or 0.0
    return cpu, rx, tx


def record_fleet(containers: dict[str, list]) -> None:
    """One sampling pass over the whole fleet — updates each container's
    baseline unless it's currently spiking. Called from the reconcile
    loop, not the /ws loop."""
    live_keys = set()

    for host, conts in containers.items():
        for c in conts:
            key = (host, c.get("id"))
            live_keys.add(key)
            cpu, rx, tx = _metrics(c)

            entry = _baseline.get(key)
            if entry is None:
                _baseline[key] = {"cpu": cpu, "rx": rx, "tx": tx}
                continue

            if _is_spike(cpu, entry["cpu"], CPU_FACTOR, CPU_MIN_DELTA):
                continue
            if _is_spike(rx, entry["rx"], NET_FACTOR, NET_MIN_DELTA_BPS):
                continue
            if _is_spike(tx, entry["tx"], NET_FACTOR, NET_MIN_DELTA_BPS):
                continue

            entry["cpu"] += _EWMA_ALPHA * (cpu - entry["cpu"])
            entry["rx"] += _EWMA_ALPHA * (rx - entry["rx"])
            entry["tx"] += _EWMA_ALPHA * (tx - entry["tx"])

    # Drop baselines for containers that no longer exist so removed ones
    # don't accumulate forever in memory.
    for key in list(_baseline):
        if key not in live_keys:
            del _baseline[key]


def _fmt_bps(bps: float) -> str:
    for unit in ("B/s", "KB/s", "MB/s"):
        if bps < 1024:
            return f"{bps:.0f} {unit}"
        bps /= 1024
    return f"{bps:.1f} GB/s"


def busy(host: str, container: dict) -> dict | None:
    """Non-blocking — pure read of the current baseline. None if we have
    no baseline yet (first tick after this container appeared) or nothing
    is spiking right now."""
    baseline = _baseline.get((host, container.get("id")))
    if baseline is None:
        return None

    cpu, rx, tx = _metrics(container)
    cpu_spike = _is_spike(cpu, baseline["cpu"], CPU_FACTOR, CPU_MIN_DELTA)
    rx_spike = _is_spike(rx, baseline["rx"], NET_FACTOR, NET_MIN_DELTA_BPS)
    tx_spike = _is_spike(tx, baseline["tx"], NET_FACTOR, NET_MIN_DELTA_BPS)

    if not (cpu_spike or rx_spike or tx_spike):
        return None

    parts = []
    if cpu_spike:
        parts.append(f"CPU {cpu:.0f}% (usually ~{baseline['cpu']:.0f}%)")
    if rx_spike:
        parts.append(
            f"download {_fmt_bps(rx)} (usually ~{_fmt_bps(baseline['rx'])})"
        )
    if tx_spike:
        parts.append(
            f"upload {_fmt_bps(tx)} (usually ~{_fmt_bps(baseline['tx'])})"
        )

    return {"source": "resource", "app": None, "detail": "busy — " + ", ".join(parts)}
