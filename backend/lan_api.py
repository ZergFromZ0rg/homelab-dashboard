"""LAN scan routes, proxied to each homelab-agent's ``/network/scan``.

The agent sweeps the subnet its host is on and reports devices as it finds
them; the dashboard starts it and polls. Starting a scan is active network
probing, so it needs the same gate as the other changing routes.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse

from backend import auth, oui
from backend.docker import agent_headers
from backend.hosts import agent_for as _agent
from backend.registry import registry

router = APIRouter(prefix="/api/lan/{host}")

TIMEOUT = 40  # starting a scan reads the host's network through a helper container


def _call(method: str, host: str, **kwargs) -> JSONResponse:
    try:
        response = requests.request(
            method, f"{_agent(host)}/network/scan", headers=agent_headers(), timeout=TIMEOUT, **kwargs
        )
    except requests.RequestException as error:
        return JSONResponse(status_code=502, content={"error": f"couldn't reach this agent: {error}"})
    if response.status_code == 404:
        return JSONResponse(status_code=502, content={"error": "this agent can't scan yet — rebuild it"})
    if response.status_code == 401:
        return JSONResponse(
            status_code=502,
            content={"error": "the agent rejected the dashboard's token — AGENT_TOKEN must match on both"},
        )
    try:
        body = response.json()
    except ValueError:
        body = {"error": f"agent answered {response.status_code}"}
    if isinstance(body, dict) and isinstance(body.get("devices"), list):
        oui.annotate(body["devices"])
    return JSONResponse(status_code=response.status_code, content=body)


@router.get("/scan")
def scan_status(host: str):
    return _call("GET", host)


@router.post("/scan")
def scan_start(host: str, body: dict | None = None, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return _call("POST", host, json=body or {})


nodes_router = APIRouter()


def _identity(item: tuple[str, dict]) -> tuple[str, list, str | None]:
    name, node = item
    try:
        response = requests.get(
            f"{node['url'].rstrip('/')}/network/self", headers=agent_headers(), timeout=15
        )
        if response.ok:
            body = response.json()
            return name, body.get("addresses", []), body.get("gateway")
    except (requests.RequestException, ValueError):
        pass
    return name, [], None


# Suggestions and the latency matrix both ask; the agents cache a minute
# themselves, this just stops a poll from fanning out to every one of them.
IDENTITY_TTL = 30.0
_identity_cache: tuple[float, dict] | None = None
_identity_lock = threading.Lock()


@nodes_router.get("/api/lan-nodes")
def lan_nodes():
    """Every node's own private LAN addresses and default gateway — how a
    scan result is told apart as "that's bigboy", and what each host's router
    is. Agents too old to answer just have no entry."""
    global _identity_cache
    with _identity_lock:
        if _identity_cache and time.monotonic() - _identity_cache[0] < IDENTITY_TTL:
            return _identity_cache[1]
    items = list(registry.all().items())
    with ThreadPoolExecutor(max(1, len(items))) as pool:
        found = list(pool.map(_identity, items))
    out = {
        "nodes": {name: addrs for name, addrs, _ in found if addrs},
        "gateways": {name: gateway for name, _, gateway in found if gateway},
    }
    with _identity_lock:
        _identity_cache = (time.monotonic(), out)
    return out
