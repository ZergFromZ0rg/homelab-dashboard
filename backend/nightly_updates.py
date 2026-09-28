"""Put the agents' own nightly image updates in the audit log.

A nightly update (an agent's AUTO_UPDATE_AT) happens on the agent with
nobody clicking anything, so no request passes through the dashboard. The
alert loop asks each agent for its recent update jobs once a minute and
records any nightly one it hasn't recorded yet, as who = "nightly update".
"""

from __future__ import annotations

import requests

from backend import audit_log
from backend.docker import agent_headers
from backend.log import system as log

TIMEOUT = 5
_seen: set[str] | None = None


def _already_recorded() -> set[str]:
    return {
        (e.get("target") or {}).get("id")
        for e in audit_log.read(2000, q="nightly update")
        if (e.get("target") or {}).get("id")
    }


def record_new(nodes: dict) -> int:
    global _seen
    if _seen is None:
        _seen = _already_recorded()
    added = 0
    for host, node in nodes.items():
        try:
            response = requests.get(f"{node['url'].rstrip('/')}/updates", headers=agent_headers(), timeout=TIMEOUT)
            if not response.ok:
                continue
            jobs = response.json().get("jobs") or []
        except (requests.RequestException, ValueError) as error:
            log.debug("nightly updates from %s: %s", host, error)
            continue
        for job in jobs:
            if job.get("by") != "nightly" or job.get("state") == "running" or job.get("id") in _seen:
                continue
            _seen.add(job["id"])
            results = job.get("results") or {}
            problems = "; ".join(f"{p} {r}" for p, r in results.items() if r != "done")
            audit_log.record(
                "images updated" if job.get("state") == "done" else f"image update {job.get('state')}",
                who="nightly update", host=host, ok=job.get("state") == "done",
                target={"project": ", ".join(job.get("projects") or []), "id": job["id"]},
                detail=problems[:300] or None,
            )
            added += 1
    return added
