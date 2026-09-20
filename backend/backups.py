"""Per-host backup status, read from each homelab-agent's ``GET /backup``.

The agent pushes its host's compose/stack definitions to a git repo on a
schedule and remembers how that went. This module turns that raw status into
one ``state`` the UI and the alert rules share, so "the backup is stale"
means the same thing everywhere:

    ok              last success is recent
    stale           last success is older than expected
    failing         the last attempt failed
    pending         configured, but no run has finished yet
    not_configured  the agent has no BACKUP_REPO / GITHUB_TOKEN
    disabled        BACKUP_ENABLED=false on the agent
    unsupported     an older agent without /backup
    unknown         couldn't ask (agent unreachable, bad response)

Ages are measured against the *agent's* clock (its HTTP ``Date`` header), so
a host whose clock is off doesn't make a fresh backup look stale.

Backups change at most every few hours, so results are cached for a minute
instead of re-asked on every 2-second dashboard tick.
"""

from __future__ import annotations

import threading
import time
from email.utils import parsedate_to_datetime

import requests

from backend.env import env_float
from backend.log import system as log

TIMEOUT_SECONDS = 3
CACHE_SECONDS = 60
MAX_ERROR_LENGTH = 300

# A backup is "stale" once its last success is older than this many hours.
# 0 (the default) means "derive it from the agent's own schedule": one and a
# half intervals, and at least two hours of slack over one interval.
MAX_AGE_HOURS = env_float("ALERT_BACKUP_MAX_AGE_HOURS", 0)

_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def max_age_seconds(interval_hours: float | None) -> float | None:
    if MAX_AGE_HOURS > 0:
        return MAX_AGE_HOURS * 3600

    if not interval_hours or interval_hours <= 0:
        return None

    return max(interval_hours * 1.5, interval_hours + 2) * 3600


def classify(raw: dict, agent_now: float) -> dict:
    """Turn an agent ``/backup`` payload into the normalized status."""
    interval_hours = raw.get("interval_hours")
    last_success = raw.get("last_success_at")
    last_run = raw.get("last_run_at")
    last_error = raw.get("last_error")

    def age(timestamp):
        return None if timestamp is None else max(0.0, agent_now - float(timestamp))

    success_age = age(last_success)
    run_age = age(last_run)
    limit = max_age_seconds(interval_hours)

    if raw.get("enabled") is False:
        state = "disabled"
    elif not raw.get("configured"):
        state = "not_configured"
    elif last_error and (last_success is None or (last_run or 0) > last_success):
        state = "failing"
    elif last_success is None:
        state = "pending"
    elif limit is not None and success_age > limit:
        state = "stale"
    else:
        state = "ok"

    projects = raw.get("projects")

    return {
        "state": state,
        "running": bool(raw.get("running")),
        "interval_hours": interval_hours,
        "last_success_age": success_age,
        "last_run_age": run_age,
        "last_error": str(last_error)[:MAX_ERROR_LENGTH] if last_error else None,
        "last_commit": raw.get("last_commit"),
        "projects": len(projects) if isinstance(projects, dict) else None,
    }


def _agent_now(response: requests.Response) -> float:
    header = response.headers.get("Date")

    if header:
        try:
            return parsedate_to_datetime(header).timestamp()
        except (TypeError, ValueError):
            pass

    return time.time()


def _fetch(base_url: str) -> dict:
    try:
        response = requests.get(f"{base_url}/backup", timeout=TIMEOUT_SECONDS)

        if response.status_code == 404:
            return {"state": "unsupported"}

        response.raise_for_status()
        raw = response.json()

        if not isinstance(raw, dict):
            raise ValueError("unexpected /backup payload")

        return classify(raw, _agent_now(response))

    except (requests.RequestException, ValueError) as error:
        log.debug("backup status unavailable from %s: %s", base_url, error)
        return {"state": "unknown"}


def status_for(host: str, base_url: str) -> dict:
    """The (cached) backup status for one agent. A failed refresh keeps
    serving the last known status rather than flipping to ``unknown``."""
    now = time.time()

    with _lock:
        hit = _cache.get(host)

    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]

    fresh = _fetch(base_url)

    if fresh["state"] == "unknown" and hit and hit[1]["state"] != "unknown":
        # Re-age the last good answer instead of freezing it in time.
        stale = dict(hit[1])
        elapsed = now - hit[0]
        for field in ("last_success_age", "last_run_age"):
            if stale.get(field) is not None:
                stale[field] += elapsed
        fresh = stale

    with _lock:
        _cache[host] = (now, fresh)

    return fresh


def forget(host: str) -> None:
    with _lock:
        _cache.pop(host, None)


def clear_cache() -> None:
    with _lock:
        _cache.clear()
