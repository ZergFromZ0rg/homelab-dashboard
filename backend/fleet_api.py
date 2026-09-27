"""Fleet routes: registering nodes, starting/stopping containers, rebuilds,
an agent's settings, and one container's long history."""

from __future__ import annotations

import asyncio

import requests
from fastapi import APIRouter, Header, HTTPException

from backend import agent_config, auth, container_history, rebuilds
from backend.docker import control_container, get_all_containers
from backend.hosts import MAIN_HOST_OVERRIDE, agent_for, detect_main_host
from backend.registry import registry

router = APIRouter()


@router.get("/api/nodes")
def list_nodes():
    return registry.listing()


@router.get("/api/nodes/join")
def join_details():
    """What the Add-node command needs beyond the dashboard's address: the
    shared AGENT_TOKEN, so a new node joins locked like the rest. Behind
    the passkey login like every /api route; with login off, anyone who can
    reach this could already drive the agents through the dashboard."""
    from backend.docker import AGENT_TOKEN

    return {"agent_token": AGENT_TOKEN or None}


@router.post("/api/nodes")
def register_node(
    payload: dict,
    x_register_token: str | None = Header(default=None),
):
    auth.check_token(x_register_token)

    name = str(payload.get("name", "")).strip()
    url = str(payload.get("url", "")).strip().rstrip("/")

    if not name or not url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="name and an http(s) url are required",
        )

    registry.register(name, url)
    return {"ok": True, "name": name}


@router.delete("/api/nodes/{name}")
def delete_node(
    name: str,
    x_register_token: str | None = Header(default=None),
):
    auth.check_token(x_register_token)
    return {"ok": registry.remove(name)}


@router.post("/api/containers/{host}/{container_id}/{action}")
async def container_action(
    host: str,
    container_id: str,
    action: str,
    x_register_token: str | None = Header(default=None),
):
    """Start / stop / restart a container on a host.

    AUTH: gated. A no-op while ``API_TOKEN`` is unset, which is the current
    posture — but stopping someone's database is a host mutation, and it
    was the one such route that checked nothing. Marking the boundary now
    means turning auth on later is a single environment variable rather
    than an audit.
    """
    auth.check_token(x_register_token)

    try:
        result = await asyncio.to_thread(
            control_container,
            registry.all(),
            host,
            container_id,
            action,
        )

        return result

    except ValueError as error:
        return {
            "success": False,
            "error": str(error),
        }

    except requests.RequestException as error:
        return {
            "success": False,
            "error": f"agent unreachable: {error}",
        }


@router.post("/api/rebuild/{host}")
def start_rebuild(
    host: str,
    payload: dict | None = None,
    x_register_token: str | None = Header(default=None),
):
    """Ask a host's agent to pull and rebuild a container's Compose project.

    Token-gated here as well as on the agent: this is the one dashboard
    route that makes a host run arbitrary code from a repo.
    """
    auth.check_token(x_register_token)

    body = payload or {}
    container = str(body.get("container") or "").strip()
    if not container:
        raise HTTPException(status_code=400, detail="container is required")

    try:
        return rebuilds.start(
            agent_for(host), container, pull=bool(body.get("pull", True))
        )
    except rebuilds.RebuildError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


@router.post("/api/fleet/rebuild")
def rebuild_fleet(
    payload: dict | None = None,
    x_register_token: str | None = Header(default=None),
):
    """Update every agent, or the named ones.

    Each agent rebuilds its own project and hands the work to a throwaway
    container, so this returns as soon as the jobs exist rather than
    waiting for builds that take minutes.
    """
    auth.check_token(x_register_token)

    body = payload or {}
    hosts = body.get("hosts")
    if hosts is not None and not isinstance(hosts, list):
        raise HTTPException(status_code=400, detail="hosts must be a list")

    nodes = registry.all()
    if not nodes:
        raise HTTPException(status_code=400, detail="no agents are registered")

    main_host = MAIN_HOST_OVERRIDE or detect_main_host(
        get_all_containers(nodes)
    )

    return rebuilds.fleet(nodes, hosts, main_host)


@router.get("/api/rebuild/{host}/{job_id}")
def rebuild_job(host: str, job_id: str):
    try:
        return rebuilds.job(agent_for(host), job_id)
    except rebuilds.RebuildError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


@router.get("/api/hosts/{host}/config")
def host_config(host: str, x_register_token: str | None = Header(default=None)):
    """What this host's agent can be told, and what it already is.

    Readable on a host that doesn't accept settings too — the answer
    carries the reason and the one line that changes it, which is more use
    than an empty page.
    """
    auth.check_token(x_register_token)

    try:
        return agent_config.read(agent_for(host))
    except agent_config.ConfigError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


@router.put("/api/hosts/{host}/config")
def set_host_config(
    host: str,
    payload: dict,
    x_register_token: str | None = Header(default=None),
):
    """Change settings on one host's agent.

    Token-gated like the rebuild route: turning on rebuilds, or widening
    which directories may leave a host, is the same class of decision.
    """
    auth.check_token(x_register_token)

    settings = payload.get("settings")

    if not isinstance(settings, dict):
        raise HTTPException(status_code=400, detail="settings must be an object")

    try:
        return agent_config.write(agent_for(host), settings)
    except agent_config.ConfigError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


@router.get("/api/containers/{host}/{name}/history")
def container_history_route(host: str, name: str, range: str = "24h"):
    """CPU and memory for one container over hours or days.

    Off the /ws payload deliberately: it's only wanted while someone has a
    container's details open, and sending every container's week to every
    client every two seconds would be absurd.
    """
    try:
        return container_history.history(host, name, range)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
