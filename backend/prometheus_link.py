"""Whether each agent actually has Prometheus metrics behind it.

Host CPU, RAM, disk and temperature come from Prometheus; containers come
from the agent. The two are joined on one string: an agent's ``HOST_NAME``
has to equal its Prometheus ``job_name``. Nothing enforces that, and a
mismatch fails silently in the worst way — ``_offline_machine`` marks a
reachable agent ``online``, so the host card renders with every gauge
blank and nothing anywhere says why.

This finds the mismatch and, where it can, names the job you probably
meant.
"""

from __future__ import annotations

import difflib
from urllib.parse import urlparse

# node_exporter's default. The agent's own port is 8123, so its registered
# URL gives us the address and this gives us the port.
EXPORTER_PORT = 9100


def suggest(name: str, jobs: list[str]) -> str | None:
    """The Prometheus job this agent probably meant to be.

    Case and a trailing domain are the two mistakes that actually happen —
    ``Bigboy`` for ``bigboy``, ``nuc.local`` for ``nuc`` — so they're
    checked before falling back to fuzzy matching.
    """
    lowered = name.lower()

    for job in jobs:
        if job.lower() == lowered:
            return job

    for job in jobs:
        stripped = job.lower().split(".")[0]
        if stripped == lowered or lowered.split(".")[0] == job.lower():
            return job

    close = difflib.get_close_matches(name, jobs, n=1, cutoff=0.8)
    return close[0] if close else None


def exporter_address(agent_url: str | None) -> str | None:
    """Where node_exporter probably listens, from the agent's own URL."""
    if not agent_url:
        return None

    host = urlparse(agent_url).hostname
    return f"{host}:{EXPORTER_PORT}" if host else None


def scrape_config(name: str, agent_url: str | None = None) -> str:
    """The prometheus.yml stanza this host needs."""
    address = exporter_address(agent_url) or f"{name}:{EXPORTER_PORT}"

    return (
        "  - job_name: " + name + "\n"
        "    static_configs:\n"
        "      - targets: ['" + address + "']"
    )


def unmatched_agents(nodes: dict, jobs: list[str]) -> list[dict]:
    """Registered agents with no Prometheus job of the same name.

    Sorted, so the issue list doesn't reshuffle between ticks.
    """
    known = set(jobs)
    found = []

    for name in sorted(nodes):
        if name in known:
            continue

        url = (nodes[name] or {}).get("url")
        found.append({
            "host": name,
            "suggestion": suggest(name, jobs),
            "scrape_config": scrape_config(name, url),
        })

    return found


def issues(nodes: dict, jobs: list[str]) -> tuple[list[dict], list[str]]:
    """Overview issues and next-steps for every mismatch.

    Nothing is reported when Prometheus itself is unreachable — ``jobs``
    is empty then, and calling every host misconfigured because the
    metrics backend is down would bury the one thing that is wrong.
    """
    if not jobs:
        return [], []

    found = []
    recommendations = []

    for entry in unmatched_agents(nodes, jobs):
        host = entry["host"]
        suggestion = entry["suggestion"]

        if suggestion:
            message = (
                f"{host}'s agent is reporting, but Prometheus has no job "
                f"called {host} — it has {suggestion}. Host metrics are blank "
                "until the two names match."
            )
            step = (
                f"Rename one of them so they agree: either set HOST_NAME="
                f"{suggestion} on {host}'s agent, or rename the Prometheus "
                f"job to {host}."
            )
        else:
            message = (
                f"{host}'s agent is reporting, but Prometheus has no job "
                f"called {host}, so its CPU, RAM, disk and temperature are "
                "blank."
            )
            step = (
                f"Add a scrape job named {host} to prometheus.yml:\n"
                + entry["scrape_config"]
            )

        found.append({
            "key": f"host:{host}:no-metrics",
            "title": f"{host} has no Prometheus job",
            "message": message,
            "severity": "warn",
        })
        recommendations.append(step)

    return found, recommendations
