"""Per-host tools proxied to its agent: network conversations, disk usage
and delete, and Docker networks."""

from __future__ import annotations

import requests
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

from backend import auth, connections, disk, networks
from backend.docker import agent_headers
from backend.hosts import agent_for

router = APIRouter()


@router.get("/api/connections/{host}")
def host_connections(host: str, refresh: bool = False):
    """Who one host is talking to, from its agent's conntrack table.

    Deliberately off the /ws payload: a busy host's table is large and only
    interesting while someone is looking at it. Cached for 30s; ``refresh``
    forces a re-read for the panel's own reload.
    """
    base_url = agent_for(host)
    return {"host": host, **connections.for_host(host, base_url, refresh=refresh)}


@router.get("/api/disk/{host}")
def host_disk_usage(host: str, path: str = "/", refresh: bool = False):
    """What's taking the space under ``path`` on one host. Read-only; polled
    by the disk explorer while the agent's scan runs."""
    return {"host": host, **disk.usage(agent_for(host), path, refresh)}


@router.post("/api/disk/{host}/delete")
def host_disk_delete(
    host: str, body: dict, x_register_token: str | None = Header(default=None)
):
    """Delete a file or folder on a host. AUTH: gated — this destroys data,
    so it also needs a fresh passkey confirmation."""
    auth.check_token(x_register_token)
    auth.require_elevated()
    return {"host": host, **disk.delete(agent_for(host), str(body.get("path", "")))}


@router.get("/api/networks/{host}")
def host_networks(host: str):
    """Docker networks on one host and the containers on each."""
    return {"host": host, **networks.list_for(agent_for(host))}


@router.post("/api/networks/{host}")
def create_network(
    host: str, body: dict, x_register_token: str | None = Header(default=None)
):
    """Create a bridge network on a host. AUTH: gated, like container control."""
    auth.check_token(x_register_token)
    return networks.create(
        agent_for(host), str(body.get("name", "")), body.get("subnet"), bool(body.get("internal"))
    )


@router.delete("/api/networks/{host}/{network_id}")
def remove_network(
    host: str, network_id: str, x_register_token: str | None = Header(default=None)
):
    auth.check_token(x_register_token)
    return networks.remove(agent_for(host), network_id)


@router.post("/api/networks/{host}/{network_id}/{action}")
def network_membership(
    host: str,
    network_id: str,
    action: str,
    body: dict,
    x_register_token: str | None = Header(default=None),
):
    """Connect or disconnect a container. AUTH: gated."""
    auth.check_token(x_register_token)
    if action not in ("connect", "disconnect"):
        raise HTTPException(status_code=404, detail="unknown action")
    return networks.attach(
        agent_for(host), network_id, str(body.get("container", "")), action == "connect"
    )


@router.get("/api/containers/{host}/{container}/logs/download")
def container_logs_download(host: str, container: str):
    """All of a container's logs as a text file, streamed from its agent."""
    try:
        response = requests.get(f"{agent_for(host)}/containers/{container}/logs/download",
                                headers=agent_headers(), timeout=600, stream=True)
    except requests.RequestException as error:
        return JSONResponse(status_code=502, content={"error": f"couldn't reach this agent: {error}"})
    if not response.ok:
        return JSONResponse(status_code=response.status_code if response.status_code != 404 else 502,
                            content={"error": "this agent can't download logs — rebuild it" if response.status_code == 404
                                     else f"agent answered {response.status_code}"})

    def body():
        with response:
            yield from response.iter_content(64 * 1024)

    return StreamingResponse(body(), media_type="text/plain", headers={
        k: v for k, v in response.headers.items() if k.lower() == "content-disposition"
    })
