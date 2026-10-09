"""Network watch routes, proxied to each homelab-agent's ``/netwatch``, and the
findings the alert loop turns into alerts.

The agent does the watching (ARP claims and DHCP replies, nothing else — see
the agent's netwatch.py); this is the switch, the status, and the bridge to
alerting. Turning it on or off is a change to what the host does, so it needs
the same gate as the other changing routes and is audited.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import requests
from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse

from backend import auth
from backend.docker import agent_headers
from backend.hosts import agent_for as _agent
from backend.registry import registry

router = APIRouter(prefix="/api/netwatch")

TIMEOUT = 15  # turning it on lists the host's network through a helper container
POLL_TIMEOUT = 5

_lock = threading.Lock()
_latest: list[dict] = []  # active warn/bad findings from the last refresh, per host


def _call(method: str, host: str, **kwargs) -> JSONResponse:
    try:
        response = requests.request(
            method, f"{_agent(host)}/netwatch", headers=agent_headers(), timeout=TIMEOUT, **kwargs
        )
    except requests.RequestException as error:
        return JSONResponse(status_code=502, content={"error": f"couldn't reach this agent: {error}"})
    if response.status_code == 404:
        return JSONResponse(status_code=502, content={"error": "this agent can't watch the network yet — rebuild it"})
    if response.status_code == 401:
        return JSONResponse(
            status_code=502,
            content={"error": "the agent rejected the dashboard's token — AGENT_TOKEN must match on both"},
        )
    try:
        body = response.json()
    except ValueError:
        body = {"error": f"agent answered {response.status_code}"}
    return JSONResponse(status_code=response.status_code, content=body)


@router.get("/{host}")
def status(host: str):
    return _call("GET", host)


@router.post("/{host}")
def switch(host: str, body: dict | None = None, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return _call("POST", host, json={"enabled": bool((body or {}).get("enabled"))})


# --- findings for the alert loop ------------------------------------------------------

def _active_on(item: tuple[str, dict]) -> list[dict]:
    name, node = item
    try:
        response = requests.get(f"{node['url'].rstrip('/')}/netwatch", headers=agent_headers(), timeout=POLL_TIMEOUT)
        if not response.ok:
            return []
        body = response.json()
    except (requests.RequestException, ValueError):
        return []
    if not isinstance(body, dict) or not body.get("enabled"):
        return []
    return [
        {**finding, "host": name}
        for finding in body.get("active") or []
        if isinstance(finding, dict) and all(isinstance(finding.get(k), str) and finding[k] for k in ("id", "title", "message"))
    ]


def refresh() -> list[dict]:
    """Ask every agent for the warnings and worse its watcher has raised
    lately, and remember them. Blocking: call it from a thread."""
    items = list(registry.all().items())
    found: list[dict] = []
    if items:
        with ThreadPoolExecutor(max(1, min(len(items), 8))) as pool:
            for findings in pool.map(_active_on, items):
                found.extend(findings)
    with _lock:
        _latest[:] = found
    return found


def latest() -> list[dict]:
    """What the last refresh found, without asking anyone — for the Overview."""
    with _lock:
        return list(_latest)
