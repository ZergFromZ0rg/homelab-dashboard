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
# Kept for Settings → History's "activity" period (30 days by default),
# with a hard cap so a flapping container can't grow it without bound.
# Only the newest LIVE_ENTRIES go out on every /ws tick.
MAX_ENTRIES = 20000
LIVE_ENTRIES = 150
_PRUNE_EVERY = 3600

_entries: list[dict] = read_json(_FILE, [])
if not isinstance(_entries, list):
    _entries = []
_pruned_at = 0.0

# Runtime diff state, seeded on the first observe() and never persisted.
_prev_containers: dict[tuple, tuple] = {}
_prev_names: dict[tuple, str] = {}
_prev_nodes: dict[str, tuple] = {}
_prev_facts: dict[str, dict] = {}
_seen_event_at: dict[str, float] = {}
_initialized = False


def recent(limit: int = LIVE_ENTRIES) -> list[dict]:
    return list(_entries[:limit])


def history(limit: int = 200, before: float | None = None, q: str | None = None) -> list[dict]:
    """Older entries for the History view: newest first, paged by time."""
    needle = (q or "").lower().strip()
    out = []
    for entry in _entries:
        if before is not None and entry["at"] >= before:
            continue
        if needle and needle not in f"{entry.get('text', '')} {entry.get('host') or ''} {entry.get('kind', '')}".lower():
            continue
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def _prune(now: float) -> None:
    global _pruned_at
    from backend import history_settings

    days = history_settings.get()["activity_days"]
    cutoff = now - days * 86400
    while _entries and _entries[-1]["at"] < cutoff:
        _entries.pop()
    del _entries[MAX_ENTRIES:]
    _pruned_at = now


def record(kind: str, text: str, host: str | None = None) -> None:
    now = time.time()
    _entries.insert(0, {"at": now, "kind": kind, "text": text, "host": host})
    if now - _pruned_at > _PRUNE_EVERY or len(_entries) > MAX_ENTRIES:
        _prune(now)
    write_json_atomic(_FILE, _entries, label="activity", indent=None)


def _container_label(container: dict, host: str) -> str:
    return f"{container.get('name') or container.get('id', '?')[:12]} on {host}"


def observe(
    machines: dict, containers: dict[str, list], deployment_dumps: list[dict]
) -> None:
    global _initialized

    # A host whose agent isn't answering has no trustworthy container list:
    # keep what we last saw for it, so an outage doesn't read as every
    # container removed and then new again.
    blind = {h for h, m in machines.items() if m.get("agent_reachable") is False}

    cur_containers: dict[tuple, tuple] = {}
    cur_names: dict[tuple, str] = {}
    for host, conts in containers.items():
        if host in blind:
            continue
        for c in conts:
            cur_containers[(host, c["id"])] = (
                c.get("status"),
                c.get("health"),
                c.get("restart_count") or 0,
            )
            cur_names[(host, c["id"])] = c.get("name") or c["id"][:12]
    for key, value in _prev_containers.items():
        if key[0] in blind:
            cur_containers[key] = value
            cur_names[key] = _prev_names.get(key, key[1][:12])

    cur_facts = {host: _facts(m) for host, m in machines.items()}

    cur_nodes = {
        host: (bool(m.get("online")), m.get("agent_reachable"))
        for host, m in machines.items()
    }

    if not _initialized:
        _prev_containers.update(cur_containers)
        _prev_names.update(cur_names)
        _prev_nodes.update(cur_nodes)
        _prev_facts.update(cur_facts)
        for d in deployment_dumps:
            _seen_event_at[d["id"]] = max(
                (e["at"] for e in d.get("events", [])), default=0.0
            )
        _initialized = True
        return

    _diff_containers(cur_containers, cur_names)
    _diff_nodes(cur_nodes)
    _diff_facts(cur_facts)
    _diff_deployments(deployment_dumps)

    _prev_containers.clear()
    _prev_containers.update(cur_containers)
    _prev_names.clear()
    _prev_names.update(cur_names)
    _prev_nodes.clear()
    _prev_nodes.update(cur_nodes)
    _prev_facts.clear()
    _prev_facts.update(cur_facts)


def _diff_containers(cur: dict[tuple, tuple], names: dict[tuple, str]) -> None:
    # Recreating a container (an image update, a compose change) gives it a
    # new id under the same name, so "new" and "removed" are decided by name
    # per host: a new id whose name was already there is a recreate.
    before = {(h, n) for (h, _), n in _prev_names.items()}
    after = {(h, n) for (h, _), n in names.items()}

    for key, (status, health, restarts) in cur.items():
        host, _ = key
        label = f"{names[key]} on {host}"
        prev = _prev_containers.get(key)

        if prev is None:
            if (host, names[key]) in before:
                record("container_recreated", f"{label} recreated", host)
            else:
                record("container_new", f"{label} is new", host)
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

    for key, name in _prev_names.items():
        if key not in cur and (key[0], name) not in after:
            record("container_removed", f"{name} on {key[0]} removed", key[0])


def _facts(machine: dict) -> dict:
    facts = machine.get("host_facts") if isinstance(machine.get("host_facts"), dict) else {}
    return {
        "os_updates": facts.get("os_updates"),
        "reboot_required": facts.get("reboot_required"),
        "uptime": machine.get("uptime"),
    }


def _diff_facts(cur: dict[str, dict]) -> None:
    """The machine under the containers: OS updates arriving and being
    installed (from the dashboard or by hand), a reboot becoming due, and
    the host having rebooted."""
    for host, now in cur.items():
        was = _prev_facts.get(host)
        if not was:
            continue

        old, new = was["os_updates"], now["os_updates"]
        if isinstance(old, int) and isinstance(new, int) and new != old:
            if new < old:
                left = f", {new} left" if new else ""
                record("os_updated", f"{old - new} OS update{'s' if old - new != 1 else ''} installed on {host}{left}", host)
            else:
                record("os_updates_available", f"{new - old} new OS update{'s' if new - old != 1 else ''} for {host}", host)

        if now["reboot_required"] is True and was["reboot_required"] is False:
            record("reboot_required", f"{host} needs a reboot", host)

        up, was_up = now["uptime"], was["uptime"]
        if isinstance(up, (int, float)) and isinstance(was_up, (int, float)) and up + 60 < was_up:
            record("node_rebooted", f"{host} rebooted", host)


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
