"""Opt-in alerting: watch the fleet snapshot and POST a small JSON body to
``ALERT_WEBHOOK_URL`` when something crosses a line — and again when it
recovers. Off unless that URL is set.

Rules (all thresholds are env-tunable):

- a host Prometheus had marked ``online`` goes offline
- a host's agent stops responding
- a host's RAM or CPU sits above its threshold for ``ALERT_BREACH_CYCLES``
  consecutive checks (a single spike doesn't page you)
- a scheduler-managed deployment goes ``failed`` or ``node_offline``

``AlertMonitor.poll`` is the pure state machine — feed it successive fleet
snapshots and it returns only the *transitions* (fired / resolved). The
loop in ``main`` does the HTTP POST. The webhook body is deliberately
generic so it works with ntfy, Gotify, Discord, Slack-compatible
endpoints, healthchecks.io, or your own receiver:

    {
      "status": "firing" | "resolved",
      "key": "host:nuc-1:ram",
      "title": "nuc-1 RAM high",
      "message": "nuc-1 RAM at 93% (threshold 90%)",
      "host": "nuc-1",
      "timestamp": 1725800000.0
    }
"""

from __future__ import annotations

import time

import requests

from backend.env import env_float, env_str
from backend.log import system

WEBHOOK_URL = env_str("ALERT_WEBHOOK_URL")
RAM_PERCENT = env_float("ALERT_RAM_PERCENT", 90)
CPU_PERCENT = env_float("ALERT_CPU_PERCENT", 95)
INTERVAL_SECONDS = env_float("ALERT_INTERVAL", 60)
# Consecutive breaching checks before a resource alert fires. Host-offline
# and deployment-failed alerts always fire on the first check.
BREACH_CYCLES = max(1, int(env_float("ALERT_BREACH_CYCLES", 2)))
# Include container-control-worthy detail without paging on a brief blip.
TIMEOUT_SECONDS = env_float("ALERT_WEBHOOK_TIMEOUT", 5)


def enabled() -> bool:
    return bool(WEBHOOK_URL)


class AlertMonitor:
    """Tracks which alert keys are currently firing so we only notify on a
    change of state. Not thread-safe — call ``poll`` from one task."""

    def __init__(self, *, breach_cycles: int = BREACH_CYCLES):
        self._breach_cycles = breach_cycles
        self._firing: set[str] = set()
        self._breach_counts: dict[str, int] = {}

    def poll(
        self,
        machines: dict[str, dict],
        deployments: list[dict],
        *,
        now: float | None = None,
    ) -> list[dict]:
        now = now or time.time()
        raw = _evaluate(machines, deployments)

        # Debounce resource alerts: they only count as "breaching" once
        # they've been seen ``breach_cycles`` checks running.
        breaching: dict[str, dict] = {}
        for key, alert in raw.items():
            if alert.get("debounce"):
                count = self._breach_counts.get(key, 0) + 1
                self._breach_counts[key] = count
                if count >= self._breach_cycles:
                    breaching[key] = alert
            else:
                breaching[key] = alert

        for key in list(self._breach_counts):
            if key not in raw:
                del self._breach_counts[key]

        events: list[dict] = []

        for key, alert in breaching.items():
            if key not in self._firing:
                self._firing.add(key)
                events.append(_event("firing", key, alert, now))

        for key in sorted(self._firing - set(breaching)):
            self._firing.discard(key)
            events.append(
                _event("resolved", key, {"title": _titles.get(key, key)}, now)
            )

        return events


# Remember the human title of a firing alert so the "resolved" event can
# still name it after the breach data is gone.
_titles: dict[str, str] = {}


def _event(status: str, key: str, alert: dict, now: float) -> dict:
    title = alert.get("title", key)
    if status == "firing":
        _titles[key] = title
    else:
        title = _titles.pop(key, title)
    return {
        "status": status,
        "key": key,
        "title": title,
        "message": alert.get("message", title) if status == "firing" else f"{title} recovered",
        "host": alert.get("host"),
        "timestamp": now,
    }


def _evaluate(
    machines: dict[str, dict], deployments: list[dict]
) -> dict[str, dict]:
    """Current raw breaches, keyed by a stable alert key."""
    out: dict[str, dict] = {}

    for name, m in machines.items():
        # A host with neither Prometheus nor a reachable agent — treat as
        # offline only if Prometheus had it as a real target at some point
        # (``online`` present and now False).
        if m.get("online") is False:
            out[f"host:{name}:offline"] = {
                "title": f"{name} offline",
                "message": f"{name} is not responding to Prometheus scrapes",
                "host": name,
            }

        if m.get("agent_reachable") is False and m.get("online"):
            out[f"host:{name}:agent"] = {
                "title": f"{name} agent unreachable",
                "message": f"{name} is up but its homelab-agent is not responding",
                "host": name,
            }

        ram = m.get("ram")
        if isinstance(ram, (int, float)) and ram >= RAM_PERCENT:
            out[f"host:{name}:ram"] = {
                "title": f"{name} RAM high",
                "message": f"{name} RAM at {ram:.0f}% (threshold {RAM_PERCENT:.0f}%)",
                "host": name,
                "debounce": True,
            }

        cpu = m.get("cpu")
        if isinstance(cpu, (int, float)) and cpu >= CPU_PERCENT:
            out[f"host:{name}:cpu"] = {
                "title": f"{name} CPU high",
                "message": f"{name} CPU at {cpu:.0f}% (threshold {CPU_PERCENT:.0f}%)",
                "host": name,
                "debounce": True,
            }

    for record in deployments:
        status = record.get("status")
        if status in ("failed", "node_offline"):
            rid = record.get("id", "")
            image = (record.get("spec") or {}).get("image") or record.get("kind", "workload")
            where = record.get("placed_on") or "?"
            out[f"deploy:{rid}"] = {
                "title": f"deployment {status}: {image}",
                "message": (
                    f"{image} on {where} is {status}"
                    + (f" — {record['error']}" if record.get("error") else "")
                ),
                "host": record.get("placed_on"),
            }

    return out


def post(event: dict, *, url: str = "", session: requests.Session | None = None) -> None:
    """Fire one webhook POST. Swallows transport errors — a down webhook
    must not take the alert loop with it."""
    target = url or WEBHOOK_URL
    if not target:
        return
    try:
        (session or requests).post(target, json=event, timeout=TIMEOUT_SECONDS)
    except requests.RequestException as error:
        system.warning("alert webhook POST failed: %s", error)
