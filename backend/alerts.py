"""Opt-in alerting: watch the fleet snapshot and POST a small JSON body to
``ALERT_WEBHOOK_URL`` when something crosses a line — and again when it
recovers. Off unless that URL is set.

Rules (all thresholds are env-tunable):

- a host Prometheus had marked ``online`` goes offline
- a host's agent stops responding
- a host's RAM or CPU sits above its threshold for ``ALERT_BREACH_CYCLES``
  consecutive checks (a single spike doesn't page you)
- a filesystem is nearly full, or on course to fill within a few days
- a CPU/GPU temperature sits above its threshold
- a container is unhealthy, crash-looping, or restarting
- a host's configuration backup is failing or has gone stale
- a service check (HTTP / TCP / DNS probe) is down
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

import re
import time
from datetime import datetime, timezone

import requests

from backend import volume_backups
from backend.env import env_float, env_str
from backend.log import system

WEBHOOK_URL = env_str("ALERT_WEBHOOK_URL")
RAM_PERCENT = env_float("ALERT_RAM_PERCENT", 90)
CPU_PERCENT = env_float("ALERT_CPU_PERCENT", 95)
DISK_PERCENT = env_float("ALERT_DISK_PERCENT", 90)
DISK_CRITICAL_PERCENT = env_float("ALERT_DISK_CRITICAL_PERCENT", 97)
# Warn when a filesystem is on course to be full within this many days; it
# turns critical at a quarter of that (min 1 day).
DISK_FORECAST_DAYS = env_float("ALERT_DISK_FORECAST_DAYS", 7)
TEMP_CELSIUS = env_float("ALERT_TEMP_CELSIUS", 85)
# A container that has restarted at least this many times and (re)started
# within the window below is treated as crash-looping. The count alone would
# flag a container that restarted five times last spring forever.
RESTART_COUNT = int(env_float("ALERT_RESTART_COUNT", 5))
RESTART_WINDOW_SECONDS = env_float("ALERT_RESTART_WINDOW_MINUTES", 30) * 60
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
        containers: dict[str, list] | None = None,
        checks: list[dict] | None = None,
        backups: list[dict] | None = None,
        *,
        now: float | None = None,
    ) -> list[dict]:
        now = now or time.time()
        raw = evaluate(machines, deployments, containers, checks, backups, now=now)

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
            events.append(_event("resolved", key, {}, now))

        return events

    def firing_keys(self) -> set[str]:
        """Alert keys currently firing — what the history loop reconciles
        its open episodes against."""
        return set(self._firing)


def severity_of(key: str, alert: dict) -> str:
    """"warn" or "bad". Most alerts say which they are; a resource breach
    that doesn't is a warning, anything else is bad."""
    return alert.get("severity") or ("warn" if key.endswith((":ram", ":cpu")) else "bad")


# Remember what a firing alert looked like so the "resolved" event can
# still name it after the breach data is gone.
_open: dict[str, dict] = {}


def _event(status: str, key: str, alert: dict, now: float) -> dict:
    if status == "firing":
        title = alert.get("title", key)
        known = {
            "title": title,
            "severity": severity_of(key, alert),
            "host": alert.get("host"),
        }
        _open[key] = known
        message = alert.get("message", title)
    else:
        known = _open.pop(key, {"title": key, "severity": "bad", "host": None})
        message = f"{known['title']} recovered"
    return {
        "status": status,
        "key": key,
        "title": known["title"],
        "message": message,
        "host": known["host"],
        "severity": known["severity"],
        "timestamp": now,
    }


_FRACTION_RE = re.compile(r"(\.\d{6})\d+")


def _started_epoch(value) -> float | None:
    """Docker's ``StartedAt`` (RFC 3339, nanosecond precision, or the
    ``0001-01-01`` zero value for a container that never started)."""
    if not isinstance(value, str) or value.startswith("0001-"):
        return None

    try:
        parsed = datetime.fromisoformat(
            _FRACTION_RE.sub(r"\1", value).replace("Z", "+00:00")
        )
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.timestamp()


def _ago(seconds: float) -> str:
    hours = seconds / 3600
    if hours < 1:
        return f"{max(1, round(seconds / 60))} min"
    if hours < 48:
        return f"{hours:.0f} h"
    return f"{hours / 24:.0f} days"


def _host_alerts(name: str, m: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}

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

    temp = m.get("temperature")
    if isinstance(temp, (int, float)) and temp >= TEMP_CELSIUS:
        out[f"host:{name}:temp"] = {
            "title": f"{name} running hot",
            "message": f"{name} CPU at {temp:.0f}°C (threshold {TEMP_CELSIUS:.0f}°C)",
            "host": name,
            "severity": "warn",
            "debounce": True,
        }

    gpu = m.get("gpu") or {}
    for index, device in enumerate(gpu.get("devices") or []):
        gpu_temp = device.get("temperature_c")
        if isinstance(gpu_temp, (int, float)) and gpu_temp >= TEMP_CELSIUS:
            out[f"host:{name}:gpu-temp:{index}"] = {
                "title": f"{name} GPU running hot",
                "message": (
                    f"{name} GPU {device.get('name') or index} at {gpu_temp:.0f}°C "
                    f"(threshold {TEMP_CELSIUS:.0f}°C)"
                ),
                "host": name,
                "severity": "warn",
                "debounce": True,
            }

    for fs in m.get("filesystems") or []:
        mount = fs.get("mountpoint") or fs.get("device") or "?"
        used = fs.get("used_percent")
        days = fs.get("days_until_full")

        if isinstance(used, (int, float)) and used >= DISK_PERCENT:
            free = fs.get("free_bytes")
            free_text = f", {free / 1e9:.0f} GB free" if isinstance(free, (int, float)) else ""
            out[f"host:{name}:disk:{mount}"] = {
                "title": f"{name} {mount} is {used:.0f}% full",
                "message": f"{mount} on {name} is {used:.0f}% full{free_text}",
                "host": name,
                "severity": "bad" if used >= DISK_CRITICAL_PERCENT else "warn",
            }

        if isinstance(days, (int, float)) and days <= DISK_FORECAST_DAYS:
            # Round half up (Python's round() is half-to-even) so this reads
            # the same as the UI's "full in ~N d".
            whole = int(days + 0.5)
            out[f"host:{name}:diskfull:{mount}"] = {
                "title": f"{name} {mount} filling up",
                "message": (
                    f"{mount} on {name} will be full in about "
                    f"{whole} day{'s' if whole != 1 else ''} at its current rate"
                ),
                "host": name,
                "severity": "bad" if days <= max(1, DISK_FORECAST_DAYS / 4) else "warn",
                "debounce": True,
            }

    backup = m.get("backup") or {}
    state = backup.get("state")
    if state == "failing":
        error = backup.get("last_error") or "unknown error"
        out[f"host:{name}:backup"] = {
            "title": f"{name} backup failing",
            "message": f"The last backup on {name} failed: {error}",
            "host": name,
            "severity": "bad",
        }
    elif state == "stale":
        age = backup.get("last_success_age")
        out[f"host:{name}:backup"] = {
            "title": f"{name} backup is stale",
            "message": (
                f"The last successful backup on {name} was "
                f"{_ago(age)} ago" if isinstance(age, (int, float))
                else f"The backup on {name} hasn't succeeded recently"
            ),
            "host": name,
            "severity": "warn",
        }

    return out


def _check_alert(check: dict, now: float) -> dict:
    name = check.get("name") or check.get("id")
    kind = check.get("type", "?")
    target = check.get("target", "?")
    since = check.get("down_since")
    for_text = f" for {_ago(now - since)}" if isinstance(since, (int, float)) else ""
    detail = check.get("detail")
    return {
        "title": f"{name} is down",
        "message": (
            f"{name} ({kind} {target}) has been failing{for_text}"
            + (f" — {detail}" if detail else "")
        ),
        "host": None,
        "severity": "bad",
        "hint": (
            f"Check that {target} is up and reachable from the dashboard host — "
            "a check runs from the dashboard container, so 'localhost' is the dashboard itself."
        ),
    }


def _container_alerts(
    host: str, containers: list[dict], now: float
) -> dict[str, dict]:
    out: dict[str, dict] = {}

    for c in containers:
        cname = c.get("name") or c.get("id") or "?"
        base = f"container:{host}:{cname}"

        if c.get("health") == "unhealthy":
            out[f"{base}:unhealthy"] = {
                "title": f"{cname} is unhealthy",
                "message": f"{cname} on {host} is failing its healthcheck",
                "host": host,
                "severity": "bad",
            }

        restarts = c.get("restart_count") or 0
        started = _started_epoch(c.get("started_at"))
        recently_started = (
            started is not None and now - started <= RESTART_WINDOW_SECONDS
        )

        if c.get("status") == "restarting" or (
            restarts >= RESTART_COUNT and recently_started
        ):
            out[f"{base}:restarting"] = {
                "title": f"{cname} keeps restarting",
                "message": (
                    f"{cname} on {host} has restarted {restarts} time"
                    f"{'' if restarts == 1 else 's'} and is crash-looping"
                ),
                "host": host,
                "severity": "bad",
            }

    return out


def _backup_alert(job: dict, state: str, now: float) -> dict:
    """A backup that has stopped working, in the words you would want at
    2 a.m.: what it protects, where it was going, and how long it has been
    since that last worked."""
    source = job.get("volume") or job.get("path") or job.get("name")
    where = f"{job.get('dest_host')}:{job.get('directory')}"
    success = job.get("last_success_at")
    age = f"last good copy {_ago(now - success)}" if success else "it has never succeeded"

    if state == "corrupt":
        verified = (job.get("last_verified") or {}).get("name") or "its newest archive"
        return {
            "title": f"backup unreadable: {job.get('name')}",
            "message": (
                f"{verified} on {where} did not read back"
                + (f" — {job['last_verify_error']}" if job.get("last_verify_error") else "")
                + ". The backup exists but cannot be restored from."
            ),
            "host": job.get("dest_host"),
            "severity": "bad",
            "hint": (
                f"Verify {job.get('name')}'s other archives from the Backups "
                "tab. An archive that fails to read back is not a backup."
            ),
        }

    if state == "failing":
        return {
            "title": f"backup failing: {job.get('name')}",
            "message": (
                f"{source} is not being backed up to {where} — {age}"
                + (f". {job['last_error']}" if job.get("last_error") else "")
            ),
            "host": job.get("source_host"),
            "severity": "bad",
            "hint": (
                f"Check the Backups tab: {job.get('name')} has failed since its "
                f"last success. Until it runs, {source} is unprotected."
            ),
        }

    return {
        "title": f"backup behind: {job.get('name')}",
        "message": (
            f"{source} should copy to {where} every "
            f"{round(job.get('interval_hours', 0))}h, but {age}"
        ),
        "host": job.get("source_host"),
        "severity": "warn",
        "hint": f"Run {job.get('name')} from the Backups tab, or check its host is up.",
    }


def evaluate(
    machines: dict[str, dict],
    deployments: list[dict],
    containers: dict[str, list] | None = None,
    checks: list[dict] | None = None,
    backups: list[dict] | None = None,
    *,
    now: float | None = None,
) -> dict[str, dict]:
    """Current raw breaches, keyed by a stable alert key. Pure — also used
    by the Overview status panel, not just the alert loop.

    An alert may carry ``severity`` ("warn" | "bad"); without one the caller
    decides (RAM/CPU are warnings, everything else is bad)."""
    now = now or time.time()
    out: dict[str, dict] = {}

    for name, m in machines.items():
        out.update(_host_alerts(name, m))

    for host, host_containers in (containers or {}).items():
        out.update(_container_alerts(host, host_containers or [], now))

    for check in checks or []:
        if check.get("status") == "down":
            out[f"check:{check['id']}"] = _check_alert(check, now)

    # A backup that quietly stops working is the failure you find out about
    # when you need the backup, which is the worst possible moment.
    for job in backups or []:
        state = volume_backups.state(job, now)

        if state in ("failing", "stale", "corrupt"):
            out[f"backup:{job['id']}"] = _backup_alert(job, state, now)

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
