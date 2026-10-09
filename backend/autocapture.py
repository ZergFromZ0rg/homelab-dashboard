"""Capture traffic by itself when an alert fires.

A broken connection is usually gone by the time you open the Packets tab, and
"it keeps happening" is the hardest thing to debug without a packet. So, when
this is on, a service check that goes down (or loses packets) makes the
dashboard ask the right host's agent for a short capture of just that
connection, and keeps it under Saved captures, marked *auto*.

What it can and cannot do, so nobody expects more:

- It starts when the alert **fires** — after the check has failed enough times
  to count as down — so it records the failure *continuing*, not its first
  second. The first failed probes are not in it.
- It is **headers only and never promiscuous**: automatic capture never widens
  what is recorded, whatever you chose by hand last.
- It is **narrow**: the check's own address and port where they can be worked
  out, not the whole network.
- It is **rate-limited**: a few per host per hour and one per check per ten
  minutes, one at a time per host, and it steps aside for a capture you started.
- It keeps only the newest few; older automatic captures are dropped, yours never.
- It **ignores the first couple of minutes after the dashboard starts**: the alert
  monitor begins with nothing remembered, so every check that is *already* down
  "fires" again then. That is a restart, not a failure beginning.

Off unless switched on (Network → Watch).
"""

from __future__ import annotations

import ipaddress
import json
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import requests

from backend import alerts, audit_log, capture_store
from backend.docker import agent_headers
from backend.env import env_str
from backend.hosts import agent_for
from backend.jsonstore import write_json_atomic
from backend.log import system as log

FILE = Path(env_str("AUTOCAPTURE_FILE", "/data/autocapture.json"))
DEFAULTS = {"enabled": False, "duration": 20, "per_host_per_hour": 4, "keep": 10}
LIMITS = {"duration": (5, 120), "per_host_per_hour": (1, 20), "keep": (1, capture_store.MAX_AUTO)}
CHECK_COOLDOWN = 600  # seconds before the same check may trigger another
GRACE = max(120.0, 2 * alerts.INTERVAL_SECONDS)  # after a start, alerts that "fire" are just being rediscovered
TIMEOUT = 40
SETTLE = 10  # seconds past the duration to wait for the capture to finish

_started_at = time.time()
_lock = threading.Lock()
_recent: dict[str, list[float]] = {}  # host -> when automatic captures started (last hour)
_last_for_check: dict[str, float] = {}
_busy: set[str] = set()


class Refused(Exception):
    """Not capturing, and why — logged, never raised to a user."""


class NotStarted(Refused):
    """Refused before anything was recorded, so the attempt costs no budget."""


# --- settings ------------------------------------------------------------------------------

def settings() -> dict:
    try:
        saved = json.loads(FILE.read_text())
    except (OSError, ValueError):
        saved = {}
    out = dict(DEFAULTS)
    for key, default in DEFAULTS.items():
        value = saved.get(key, default)
        if key == "enabled":
            out[key] = bool(value)
        elif isinstance(value, int) and not isinstance(value, bool):
            low, high = LIMITS[key]
            out[key] = max(low, min(high, value))
    return out


def update(changes: dict) -> dict:
    """Merge validated changes; raises ValueError with a message for the user."""
    current = settings()
    for key, value in (changes or {}).items():
        if key == "enabled":
            if not isinstance(value, bool):
                raise ValueError("enabled must be true or false")
            current[key] = value
        elif key in LIMITS:
            low, high = LIMITS[key]
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f"{key.replace('_', ' ')} must be a whole number from {low} to {high}")
            current[key] = value
    write_json_atomic(FILE, current, label="autocapture")
    return current


# --- what to capture ---------------------------------------------------------------------------

def _address(name: str) -> str | None:
    """An IPv4 address for a name or address, or None."""
    try:
        return str(ipaddress.IPv4Address(name))
    except ValueError:
        pass
    try:
        return socket.getaddrinfo(name, None, socket.AF_INET)[0][4][0]
    except OSError:
        return None


def expression_for(check: dict) -> str | None:
    """A capture filter for the connection a check probes. None means "all
    traffic" (the target could not be worked out); Refused means there is
    nothing a capture on the wire could show (a loopback target)."""
    kind, target = check.get("type"), str(check.get("target") or "")
    host, port = None, None
    if kind in ("http", "keyword"):
        try:
            parts = urlsplit(target if "//" in target else f"//{target}")
            host = parts.hostname
        except ValueError as error:  # an unbalanced "[" and the like
            raise Refused(f"can't work out what {target!r} connects to") from error
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:  # a port outside 0-65535: narrow by address only
            port = None
    elif kind in ("tcp", "tls"):
        host, _, raw_port = target.rpartition(":") if ":" in target else (target, "", "")
        port = int(raw_port) if raw_port.isdigit() else (443 if kind == "tls" else None)
    elif kind == "ping":
        host = target
    elif kind == "dns":
        return "port 53"
    if not host:
        return None
    address = _address(host)
    if address and ipaddress.IPv4Address(address).is_loopback:
        raise Refused(f"{target} is this machine itself, so there is nothing on the network to capture")
    parts = []
    if address:
        parts.append(f"host {address}")
    if port:
        parts.append(f"port {port}")
    return " and ".join(parts) or None


def host_for(check: dict, main_host: str | None) -> str | None:
    """The host whose agent sends this check's probes: where the failing
    traffic can be seen. Checks without an origin run from the dashboard."""
    return check.get("origin") or main_host


# --- when to capture ----------------------------------------------------------------------------

def _allowed(host: str, key: str, limit: int, now: float) -> None:
    with _lock:
        if host in _busy:
            raise Refused(f"already capturing on {host}")
        if now - _last_for_check.get(key, 0) < CHECK_COOLDOWN:
            raise Refused(f"{key} was captured less than {CHECK_COOLDOWN // 60} minutes ago")
        recent = [t for t in _recent.get(host, []) if now - t < 3600]
        if len(recent) >= limit:
            raise Refused(f"{host} has had {limit} automatic captures this hour")
        _recent[host] = [*recent, now]
        _last_for_check[key] = now
        _busy.add(host)


def consider(event: dict, checks: list[dict], main_host: str | None, *, now: float | None = None) -> bool:
    """Called for every alert event. Starts a capture in the background for a
    check that has just gone down or lossy; True if one was started.

    Never raises: it runs inside the alert loop, where an exception would cost
    the rest of that cycle's notifications."""
    try:
        return _consider(event, checks, main_host, now or time.time())
    except Exception as error:  # noqa: BLE001 - see above
        log.warning("auto-capture couldn't consider %s: %s", event.get("key"), error)
        return False


def _consider(event: dict, checks: list[dict], main_host: str | None, now: float) -> bool:
    key = str(event.get("key") or "")
    if event.get("status") != "firing" or not key.startswith("check:") or key.endswith(":slow"):
        return False
    config = settings()
    if not config["enabled"]:
        return False
    if now - _started_at < GRACE:
        return False  # a restart rediscovering checks that were already down
    check_id = key.split(":")[1]
    check = next((c for c in checks if c.get("id") == check_id), None)
    if check is None:
        return False
    try:
        host = host_for(check, main_host)
        if not host:
            raise Refused("this check runs from the dashboard and its host is unknown — set MAIN_HOST")
        expr = expression_for(check)
        _allowed(host, key, config["per_host_per_hour"], now)
    except Refused as why:
        log.info("auto-capture skipped for %s: %s", check.get("name"), why)
        return False
    threading.Thread(
        target=_run, daemon=True,
        args=(host, f"{event.get('title') or check.get('name')}", key, expr, config),
    ).start()
    return True


def _refund(host: str, key: str) -> None:
    """Give back what an attempt that never recorded anything was charged."""
    with _lock:
        if _recent.get(host):
            _recent[host].pop()
        _last_for_check.pop(key, None)


def run_now(host: str) -> dict:
    """The same capture, on request — for trying the feature out. Skips the
    rate limits (an explicit click) but still refuses a busy host."""
    config = settings()
    with _lock:
        if host in _busy:
            raise Refused(f"already capturing on {host}")
        _busy.add(host)
    return _capture(host, "manual test", "test", None, config)


def _run(host: str, reason: str, trigger: str, expr: str | None, config: dict) -> None:
    try:
        meta = _capture(host, reason, trigger, expr, config)
        log.info("auto-capture on %s kept %s packets (%s)", host, meta["packets"], reason)
        audit_log.record("auto capture", who="system", host=host, detail=f"{reason} · {meta['packets']} packets")
    except NotStarted as why:
        _refund(host, trigger)  # it never recorded anything, so the next alert may try again
        log.info("auto-capture on %s didn't start: %s", host, why)
    except Refused as why:
        log.info("auto-capture on %s skipped: %s", host, why)
    except Exception as error:  # noqa: BLE001 - a background job must say what happened, then end
        log.warning("auto-capture on %s failed: %s", host, error)
        audit_log.record("auto capture", who="system", host=host, ok=False, detail=f"{reason}: {error}")


def _capture(host: str, reason: str, trigger: str, expr: str | None, config: dict) -> dict:
    """Start, wait, save, prune. Always releases the host."""
    try:
        try:
            agent = agent_for(host)
        except Exception as error:  # noqa: BLE001 - an unregistered host
            raise NotStarted(f"{host} isn't a registered node") from error
        body = {"duration": config["duration"], "payload": "none", "promisc": False}
        if expr:
            body["filter"] = {"expr": expr}
        try:
            started = requests.post(f"{agent}/capture", json=body, headers=agent_headers(), timeout=TIMEOUT)
        except requests.RequestException as error:
            raise NotStarted(f"couldn't reach {host}'s agent: {error}") from error
        if started.status_code == 400 and "already running" in started.text:
            raise NotStarted(f"a capture is already running on {host}")
        if not started.ok:
            raise NotStarted(f"{host}'s agent refused ({started.status_code}): {started.text[:200]}")

        deadline = time.time() + config["duration"] + SETTLE
        snapshot = {}
        while time.time() < deadline:
            time.sleep(min(2.0, max(0.2, config["duration"] / 10)))
            snapshot = requests.get(f"{agent}/capture", params={"after": 0, "limit": 3000},
                                    headers=agent_headers(), timeout=TIMEOUT).json()
            if snapshot.get("state") != "capturing":
                break
        else:
            requests.delete(f"{agent}/capture", headers=agent_headers(), timeout=TIMEOUT)
        if not snapshot.get("packets"):
            why = f" ({snapshot['error']})" if snapshot.get("error") else ""
            raise Refused(f"the capture saw no packets{why}")

        stamp = time.strftime("%H:%M", time.localtime())
        meta = capture_store.save(host, f"auto: {reason} ({stamp})", snapshot,
                                  auto={"reason": reason, "trigger": trigger})
        capture_store.prune_auto(config["keep"])
        return meta
    except capture_store.StoreError as error:
        raise Refused(str(error)) from error
    finally:
        with _lock:
            _busy.discard(host)
