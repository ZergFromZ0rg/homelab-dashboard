"""LAN scan routes, proxied to each homelab-agent's ``/network/scan``.

The agent sweeps the subnet its host is on and reports devices as it finds
them; the dashboard starts it and polls. Starting a scan is active network
probing, so it needs the same gate as the other changing routes.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import requests
from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse

from backend import auth
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
    return JSONResponse(status_code=response.status_code, content=body)


@router.get("/scan")
def scan_status(host: str):
    return _call("GET", host)


@router.post("/scan")
def scan_start(host: str, body: dict | None = None, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return _call("POST", host, json=body or {})


nodes_router = APIRouter()


def _identity(item: tuple[str, dict]) -> tuple[str, list]:
    name, node = item
    try:
        response = requests.get(
            f"{node['url'].rstrip('/')}/network/self", headers=agent_headers(), timeout=15
        )
        if response.ok:
            return name, response.json().get("addresses", [])
    except (requests.RequestException, ValueError):
        pass
    return name, []


@nodes_router.get("/api/lan-nodes")
def lan_nodes():
    """Every node's own private LAN addresses — how a scan result is told
    apart as "that's bigboy". Agents too old to answer just have no entry."""
    items = list(registry.all().items())
    with ThreadPoolExecutor(max(1, len(items))) as pool:
        found = dict(pool.map(_identity, items))
    return {"nodes": {name: addrs for name, addrs in found.items() if addrs}}
