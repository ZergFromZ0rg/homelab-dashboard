"""Recent-activity feed for the Overview tab.

Not an event bus — a diff. ``observe`` is called once per reconcile tick
with the same fleet snapshot everything else uses; it compares against the
previous snapshot and records the transitions (container start/stop/
restart/health, host up/down, agent reachable, scheduler deploy/move/
fail). The list is a rolling buffer on the ``/data`` volume so it survives
a dashboard redeploy.

Module functions + module state, same shape as ``live_history.py``.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from backend.jsonstore import read_json, write_json_atomic

_FILE = Path(os.getenv("ACTIVITY_FILE", "/data/activity.json"))
MAX_ENTRIES = 120

_entries: list[dict] = read_json(_FILE, [])
if not isinstance(_entries, list):
    _entries = []

# Runtime diff state, seeded on the first observe() and never persisted.
_prev_containers: dict[tuple, tuple] = {}
_prev_nodes: dict[str, tuple] = {}
_seen_event_at: dict[str, float] = {}
_initialized = False


def recent() -> list[dict]:
    return list(_entries)


def record(kind: str, text: str, host: str | None = None) -> None:
    _entries.insert(0, {"at": time.time(), "kind": kind, "text": text, "host": host})
    del _entries[MAX_ENTRIES:]
    write_json_atomic(_FILE, _entries, label="activity", indent=None)


def _container_label(container: dict, host: str) -> str:
    return f"{container.get('name') or container.get('id', '?')[:12]} on {host}"


def observe(
    machines: dict, containers: dict[str, list], deployment_dumps: list[dict]
) -> None:
    global _initialized

    cur_containers: dict[tuple, tuple] = {}
    for host, conts in containers.items():
        for c in conts:
            cur_containers[(host, c["id"])] = (
                c.get("status"),
                c.get("health"),
                c.get("restart_count") or 0,
            )

    cur_nodes = {
        host: (bool(m.get("online")), m.get("agent_reachable"))
        for host, m in machines.items()
    }

    if not _initialized:
        _prev_containers.update(cur_containers)
        _prev_nodes.update(cur_nodes)
        for d in deployment_dumps:
            _seen_event_at[d["id"]] = max(
                (e["at"] for e in d.get("events", [])), default=0.0
            )
        _initialized = True
        return

    _diff_containers(containers, cur_containers)
    _diff_nodes(cur_nodes)
    _diff_deployments(deployment_dumps)

    _prev_containers.clear()
    _prev_containers.update(cur_containers)
    _prev_nodes.clear()
    _prev_nodes.update(cur_nodes)


def _diff_containers(containers: dict[str, list], cur: dict[tuple, tuple]) -> None:
    by_key = {
        (host, c["id"]): c for host, conts in containers.items() for c in conts
    }

    for key, (status, health, restarts) in cur.items():
        host, _ = key
        label = _container_label(by_key[key], host)
        prev = _prev_containers.get(key)

        if prev is None:
            if status == "running":
                record("container_start", f"{label} started", host)
            continue

        was_status, was_health, was_restarts = prev

        if restarts > was_restarts:
            record("container_restart", f"{label} restarted", host)
        elif was_status != "running" and status == "running":
            record("container_start", f"{label} started", host)
        elif was_status == "running" and status != "running":
            record("container_stop", f"{label} stopped", host)

        if health == "unhealthy" and was_health != "unhealthy":
            record("container_unhealthy", f"{label} is unhealthy", host)
        elif was_health == "unhealthy" and health != "unhealthy":
            record("container_healthy", f"{label} recovered", host)

    for key in _prev_containers:
        if key not in cur:
            host, cid = key
            record("container_stop", f"{cid[:12]} on {host} removed", host)


def _diff_nodes(cur: dict[str, tuple]) -> None:
    for host, (online, agent) in cur.items():
        prev = _prev_nodes.get(host)
        if prev is None:
            continue
        was_online, was_agent = prev

        if online and not was_online:
            record("node_up", f"{host} came online", host)
        elif was_online and not online:
            record("node_down", f"{host} went offline", host)

        if online and was_agent is not False and agent is False:
            record("agent_down", f"{host} agent stopped responding", host)
        elif was_agent is False and agent is not False and online:
            record("agent_up", f"{host} agent is back", host)


_EVENT_KIND = {
    "deployed": "deploy",
    "recovered": "deploy",
    "moved": "move",
    "failed": "deploy_failed",
}


def _diff_deployments(dumps: list[dict]) -> None:
    for d in dumps:
        since = _seen_event_at.get(d["id"], 0.0)
        newest = since
        for event in d.get("events", []):
            if event["at"] <= since:
                continue
            newest = max(newest, event["at"])
            kind = _EVENT_KIND.get(event["kind"])
            if not kind:
                continue
            image = (d.get("spec") or {}).get("image") or d.get("kind", "workload")
            record(kind, f"{image}: {event.get('detail') or event['kind']}", d.get("placed_on"))
        _seen_event_at[d["id"]] = newest
