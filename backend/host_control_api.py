"""The machine itself — systemd services, OS updates, reboot and power
off — proxied to its agent (homelab-agent's host_control.py).

Reading (the service list, a unit's journal, what would be upgraded) needs
only the session. Changing anything is root on that machine, so it needs
a fresh passkey confirmation too, like a host shell.
"""

from __future__ import annotations

from fastapi import APIRouter, Header

from backend import activity, auth
from backend.files_api import _agent, _call

router = APIRouter(prefix="/api/hosts/{host}")


def _changing(x_register_token: str | None) -> None:
    auth.check_token(x_register_token)
    auth.require_elevated()


@router.get("/services")
def services(host: str):
    return _call("GET", f"{_agent(host)}/host/services", timeout=60)


@router.post("/services/{unit}/{action}")
def service_action(host: str, unit: str, action: str, x_register_token: str | None = Header(default=None)):
    _changing(x_register_token)
    response = _call("POST", f"{_agent(host)}/host/services/{unit}/{action}", timeout=90)
    if response.status_code == 200:
        activity.record("service", f"{unit} {action}ed on {host}", host)
    return response


@router.get("/services/{unit}/logs")
def service_logs(host: str, unit: str, lines: int = 200):
    return _call("GET", f"{_agent(host)}/host/services/{unit}/logs", params={"lines": lines}, timeout=60)


@router.get("/os-updates")
def os_updates(host: str):
    return _call("GET", f"{_agent(host)}/host/os-updates", timeout=660)


@router.post("/os-updates/upgrade")
def os_upgrade(host: str, x_register_token: str | None = Header(default=None)):
    _changing(x_register_token)
    response = _call("POST", f"{_agent(host)}/host/os-updates/upgrade", timeout=90)
    if response.status_code == 200:
        activity.record("update", f"OS upgrade started on {host}", host)
    return response


@router.get("/os-updates/status")
def os_upgrade_status(host: str):
    return _call("GET", f"{_agent(host)}/host/os-updates/status", timeout=60)


@router.post("/facts/refresh")
def refresh_facts(host: str):
    return _call("POST", f"{_agent(host)}/host/facts/refresh", timeout=90)


@router.post("/power")
def power(host: str, body: dict, x_register_token: str | None = Header(default=None)):
    """Reboot or power off, a few seconds out."""
    _changing(x_register_token)
    response = _call("POST", f"{_agent(host)}/host/power", json=body, timeout=60)
    if response.status_code == 200:
        verb = "rebooting" if body.get("action") == "reboot" else "powering off"
        activity.record("node_down", f"{host} {verb} (from the dashboard)", host)
    return response
