"""What each agent is running, and whether it's current.

A control plane that can rebuild its own agents has to know which ones
need it. Each agent reports three facts at ``GET /version`` — the checkout
it was built from, when its image was built, and what its remote is at —
and reduces them to ``needs_rebuild`` and ``behind_remote``.

This is the dashboard's side: ask, cache, and normalise the shapes an
older agent might give back.

Version changes about as often as you rebuild, so it's cached for a
minute rather than re-asked on every 2-second tick — same as backups. An
agent that stops answering keeps its last known version rather than
blanking, because "I can't reach it" is already said elsewhere on the card.
"""

from __future__ import annotations

import threading
import time

import requests

from backend.log import system as log

TIMEOUT_SECONDS = 5
CACHE_SECONDS = 60

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()

UNKNOWN = {
    "state": "unknown",
    "source": None,
    "needs_rebuild": False,
    "behind_remote": False,
}


def _state(body: dict) -> str:
    """One word for the card.

    ``needs_rebuild`` wins over ``behind_remote``: if the checkout already
    carries commits the running agent doesn't, that's actionable right now
    and a rebuild picks up the remote's as well.

    ``unverified`` is the one that matters. An agent whose remote couldn't
    be reached — an ssh remote, no keys in the container, or simply no
    network — reports no ``remote_sha``. Calling that "current" claims a
    check that never happened, and that is exactly how a host sits three
    commits behind looking perfectly fine.
    """
    if body.get("needs_rebuild"):
        return "rebuild"
    if body.get("behind_remote"):
        return "behind"
    if not body.get("source"):
        return "unknown"
    return "current" if body.get("remote_sha") else "unverified"


def _fetch(base_url: str) -> dict:
    try:
        # Ungated on the agent, like /containers and /backup — it says
        # which commit is running, not anything worth a token.
        response = requests.get(
            f"{base_url}/version",
            timeout=TIMEOUT_SECONDS,
        )

        if response.status_code == 404:
            # An agent from before version reporting existed.
            return {**UNKNOWN, "state": "unsupported"}

        response.raise_for_status()
        body = response.json()

        if not isinstance(body, dict):
            raise ValueError("unexpected /version payload")

        return {
            "state": _state(body),
            "source": body.get("source"),
            "remote_sha": body.get("remote_sha"),
            "image_created": body.get("image_created"),
            "needs_rebuild": bool(body.get("needs_rebuild")),
            "behind_remote": bool(body.get("behind_remote")),
        }

    except (requests.RequestException, ValueError) as error:
        log.debug("version unavailable from %s: %s", base_url, error)
        return dict(UNKNOWN)


def for_host(host: str, base_url: str) -> dict:
    now = time.time()

    with _lock:
        hit = _cache.get(host)

    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]

    fresh = _fetch(base_url)

    # A version we knew a minute ago is better than "unknown" for a host
    # that's briefly unreachable; the card says it's unreachable anyway.
    if fresh["state"] == "unknown" and hit and hit[1]["state"] != "unknown":
        fresh = hit[1]

    with _lock:
        _cache[host] = (now, fresh)

    return fresh


def summary(machines: dict) -> dict:
    """Fleet-wide counts, for "3 of 4 agents up to date"."""
    states: dict[str, int] = {}

    for machine in machines.values():
        state = ((machine or {}).get("agent_version") or {}).get("state", "unknown")
        states[state] = states.get(state, 0) + 1

    return {
        "total": len(machines),
        "current": states.get("current", 0),
        "needs_rebuild": states.get("rebuild", 0),
        "behind_remote": states.get("behind", 0),
        "unverified": states.get("unverified", 0),
        "unknown": states.get("unknown", 0) + states.get("unsupported", 0),
    }


def forget(host: str) -> None:
    with _lock:
        _cache.pop(host, None)
