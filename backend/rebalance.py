"""Ongoing placement optimization.

Initial placement is only half of scheduling — nodes drift as workloads
grow. ``suggest_moves`` looks at every scheduler-managed container running
on a node that is now under CPU/RAM pressure and, if a materially better
home exists, proposes moving it. It only considers *stateless* containers
(no named volume to leave behind) and it never acts — the dashboard shows
the suggestions and the user clicks "move", which runs the normal redeploy
path.

Env knobs:
  REBALANCE_CPU_PERCENT  node CPU above this = "hot" (default 80)
  REBALANCE_RAM_PERCENT  node RAM above this = "hot" (default 85)
  REBALANCE_MIN_GAIN     the destination must beat staying put by at least
                         this many placement-score points (default 15)
"""

from __future__ import annotations

from backend import scheduler
from backend.deployments import _same_container
from backend.env import env_float
from backend.models import DeploymentRecord

HOT_CPU_PERCENT = env_float("REBALANCE_CPU_PERCENT", 80)
HOT_RAM_PERCENT = env_float("REBALANCE_RAM_PERCENT", 85)
MIN_GAIN = env_float("REBALANCE_MIN_GAIN", 15)


def _pressure(machine: dict) -> list[str]:
    reasons = []
    cpu = machine.get("cpu")
    ram = machine.get("ram")
    if isinstance(cpu, (int, float)) and cpu > HOT_CPU_PERCENT:
        reasons.append(f"CPU {cpu:.0f}%")
    if isinstance(ram, (int, float)) and ram > HOT_RAM_PERCENT:
        reasons.append(f"RAM {ram:.0f}%")
    return reasons


def _without_container(
    containers: dict[str, list[dict]], host: str, container_id: str | None
) -> dict[str, list[dict]]:
    """Copy of ``containers`` with one container removed from ``host`` — so a
    container isn't judged to conflict with (or crowd) itself when we score
    its current node as a stay-put baseline."""
    if not container_id:
        return containers
    trimmed = dict(containers)
    trimmed[host] = [
        c for c in containers.get(host, [])
        if not _same_container(c.get("id"), container_id)
    ]
    return trimmed


def suggest_moves(
    machines: dict[str, dict],
    containers: dict[str, list[dict]],
    deployments: list[DeploymentRecord],
    *,
    stale_hosts: set[str] | None = None,
) -> list[dict]:
    stale_hosts = stale_hosts or set()
    dep_dicts = [record.model_dump() for record in deployments]
    suggestions: list[dict] = []

    for record in deployments:
        if record.status != "running" or not record.placed_on:
            continue
        if record.spec.stateful():
            continue

        host = record.placed_on
        machine = machines.get(host)
        if not machine:
            continue

        pressure = _pressure(machine)
        if not pressure:
            continue

        scoped = _without_container(containers, host, record.agent_container_id)
        ranked = scheduler.score_nodes(
            record.spec,
            machines,
            stale_hosts=stale_hosts,
            deployments=dep_dicts,
            containers=scoped,
        )
        by_node = {r.node: r for r in ranked}

        here = by_node.get(host)
        if here is None or not here.eligible:
            continue

        alternative = next(
            (
                r
                for r in ranked
                if r.eligible
                and r.node != host
                and not _pressure(machines.get(r.node, {}))
            ),
            None,
        )
        if alternative is None:
            continue

        gain = round(alternative.score - here.score, 1)
        if gain < MIN_GAIN:
            continue

        suggestions.append(
            {
                "deployment_id": record.id,
                "image": record.spec.image,
                "name": record.spec.name,
                "from_node": host,
                "from_pressure": ", ".join(pressure),
                "to_node": alternative.node,
                "to_score": alternative.score,
                "here_score": here.score,
                "gain": gain,
                "reason": (
                    f"{host} is under pressure ({', '.join(pressure)}); "
                    f"{alternative.node} scores {alternative.score:.0f} for this "
                    f"workload vs {here.score:.0f} staying put"
                ),
            }
        )

    suggestions.sort(key=lambda s: -s["gain"])
    return suggestions
