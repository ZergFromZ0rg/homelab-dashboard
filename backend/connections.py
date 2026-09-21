"""Per-host network conversations, read from each homelab-agent's
``GET /connections``.

The fleet snapshot already carries how much each host and each container
sends and receives. This is the other half: *who to*. The agent parses its
host's conntrack table and returns one row per conversation; this module
fetches that, normalizes the couple of shapes an older or unconfigured
agent can give back, and caches it.

Unlike almost everything else here it is **not** on the ``/ws`` payload.
A busy host's table is large, it is only interesting when someone is
looking at it, and re-reading it on every 2-second tick would be waste on
both ends — so it has its own route, fetched when the panel opens.

The agent gates this route behind ``X-Agent-Token`` even though it only
reads, so an agent with a token set and a dashboard without one gets a
401. That reads as ``unauthorized`` rather than a generic failure, because
the fix is specific.
"""

from __future__ import annotations

import threading
import time

import requests

from backend.docker import AGENT_TOKEN, agent_headers
from backend.log import system as log

TIMEOUT_SECONDS = 5
CACHE_SECONDS = 30

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _unavailable(reason: str, **extra) -> dict:
    return {"available": False, "reason": reason, "peers": [], **extra}


def _fetch(base_url: str) -> dict:
    try:
        response = requests.get(
            f"{base_url}/connections",
            headers=agent_headers(),
            timeout=TIMEOUT_SECONDS,
        )

        if response.status_code == 404:
            return _unavailable(
                "this agent predates GET /connections — rebuild it from the "
                "current homelab-agent image",
                state="unsupported",
            )

        if response.status_code == 401:
            return _unavailable(
                "the agent rejected the dashboard's token — set AGENT_TOKEN "
                "here to the same value as the agent's"
                if AGENT_TOKEN
                else "this agent requires a token — set AGENT_TOKEN on the "
                "dashboard to match the agent's",
                state="unauthorized",
            )

        response.raise_for_status()
        body = response.json()

        if not isinstance(body, dict):
            raise ValueError("unexpected /connections payload")

        # The agent's own "not set up" answer already carries a reason
        # worth showing verbatim — it names the exact mount or sysctl.
        if not body.get("available"):
            return _unavailable(
                body.get("reason") or "the agent can't read its conntrack table",
                state="not_configured",
            )

        peers = body.get("peers")

        return {
            "available": True,
            "state": "ok",
            "accounting": bool(body.get("accounting")),
            "source": body.get("source"),
            "flows_total": body.get("flows_total"),
            "conversations_total": body.get("conversations_total"),
            "truncated": bool(body.get("truncated")),
            # False when the agent could read the table but not the Docker
            # daemon, so the UI can say "unattributed" rather than implying
            # every one of these is host traffic.
            "attributed": bool(body.get("attributed")),
            "updated_at": body.get("updated_at"),
            "peers": peers if isinstance(peers, list) else [],
        }

    except (requests.RequestException, ValueError) as error:
        log.debug("connections unavailable from %s: %s", base_url, error)
        return _unavailable(f"couldn't reach this agent: {error}", state="unknown")


def for_host(host: str, base_url: str, *, refresh: bool = False) -> dict:
    """The (cached) conversation table for one agent.

    ``refresh`` skips the cache, for the panel's own reload button — the
    point of watching this is seeing it move.
    """
    now = time.time()

    if not refresh:
        with _lock:
            hit = _cache.get(host)
        if hit and now - hit[0] < CACHE_SECONDS:
            return {**hit[1], "cached_age": round(now - hit[0], 1)}

    fresh = _fetch(base_url)

    with _lock:
        _cache[host] = (now, fresh)

    return {**fresh, "cached_age": 0.0}


def forget(host: str) -> None:
    with _lock:
        _cache.pop(host, None)
