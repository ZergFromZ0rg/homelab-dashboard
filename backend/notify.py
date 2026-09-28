"""Phone notifications through ntfy.

The alert loop already knows the moment something breaks; this gets it to
a phone. ntfy (https://ntfy.sh, or a server you run) needs no account: a
message is a POST to ``<server>/<topic>``, and the phone app subscribes to
the topic. Turning it on picks a long random topic — on a public server the
topic *is* the secret, anyone who knows it can read along.

What goes out: alert changes (firing and resolved) at or above the chosen
severity, and a passkey being added or removed — the security event you'd
most want to hear about when you didn't do it yourself.

Settings live in ``/data/notify.json``; nothing is sent until enabled.
"""

from __future__ import annotations

import secrets
import threading
from pathlib import Path

import requests

from backend.env import env_str
from backend.jsonstore import read_json, write_json_atomic
from backend.log import system as log

FILE = Path(env_str("NOTIFY_FILE", "/data/notify.json"))
DEFAULT_SERVER = "https://ntfy.sh"
TIMEOUT = 8

SEVERITY_RANK = {"warn": 1, "bad": 2}
_lock = threading.Lock()


def settings() -> dict:
    data = read_json(FILE, {})
    return {
        "enabled": bool(data.get("enabled")),
        "server": data.get("server") or DEFAULT_SERVER,
        "topic": data.get("topic") or "",
        "min_severity": data.get("min_severity") if data.get("min_severity") in SEVERITY_RANK else "warn",
        "dashboard_url": data.get("dashboard_url") or "",
    }


def update(changes: dict, dashboard_url: str | None = None) -> dict:
    with _lock:
        current = settings()
        if "enabled" in changes:
            current["enabled"] = bool(changes["enabled"])
        if "server" in changes:
            server = str(changes["server"] or "").strip().rstrip("/") or DEFAULT_SERVER
            if not server.startswith(("http://", "https://")):
                raise ValueError("the ntfy server must be an http(s) URL")
            current["server"] = server
        if changes.get("min_severity") in SEVERITY_RANK:
            current["min_severity"] = changes["min_severity"]
        if changes.get("new_topic") or (current["enabled"] and not current["topic"]):
            current["topic"] = "homelab-" + secrets.token_urlsafe(18).replace("_", "").replace("-", "")[:22]
        if dashboard_url:
            current["dashboard_url"] = dashboard_url
        write_json_atomic(FILE, current, label="notify")
        return current


def send(title: str, message: str, *, priority: int = 3, tags: list[str] | None = None,
         force: bool = False) -> bool:
    """One notification. ``force`` sends even while disabled (the test
    button, while setting up). Never raises — a down ntfy server must not
    break whatever was reporting."""
    cfg = settings()
    if not cfg["topic"] or not (cfg["enabled"] or force):
        return False
    headers = {"Title": title.encode("utf-8").decode("latin-1", "replace"), "Priority": str(priority)}
    if tags:
        headers["Tags"] = ",".join(tags)
    if cfg["dashboard_url"]:
        headers["Click"] = cfg["dashboard_url"]
    try:
        response = requests.post(f"{cfg['server']}/{cfg['topic']}", data=message.encode("utf-8"),
                                 headers=headers, timeout=TIMEOUT)
        response.raise_for_status()
        return True
    except requests.RequestException as error:
        log.warning("ntfy notification failed: %s", error)
        return False


def alert(event: dict) -> None:
    """An alert changed state (see alerts.py for the event shape)."""
    cfg = settings()
    severity = event.get("severity") or "bad"
    if not cfg["enabled"] or SEVERITY_RANK.get(severity, 2) < SEVERITY_RANK[cfg["min_severity"]]:
        return
    firing = event.get("status") == "firing"
    title = event.get("title") or "homelab alert"
    send(
        title if firing else f"Resolved: {title}",
        event.get("message") or title,
        priority=(4 if severity == "bad" else 3) if firing else 2,
        tags=(["rotating_light"] if severity == "bad" else ["warning"]) if firing else ["white_check_mark"],
    )


def security(title: str, message: str) -> None:
    send(title, message, priority=4, tags=["key"])
