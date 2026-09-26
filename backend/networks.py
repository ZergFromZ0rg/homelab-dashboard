"""Docker networks per host, proxied to each homelab-agent's ``/networks``.

Read with ``GET /api/networks/{host}``; changed with create / remove /
connect / disconnect, which the agent itself limits (no removing Docker's
own networks or one still in use, no touching the agent's own container —
see homelab-agent's networks.py). This module only forwards and turns the
agent's answers into one shape: ``{success, ...}`` or ``{success: False,
error}`` with a message worth showing as-is.

Like connections, not on the /ws payload: it changes when someone changes
it, and the Network tab fetches it when opened and after each edit.
"""

from __future__ import annotations

import requests

from backend.docker import agent_headers

TIMEOUT_SECONDS = 10


def _error_from(response: requests.Response) -> str:
    if response.status_code == 404:
        return (
            "this agent predates network management — rebuild it from the "
            "current homelab-agent image"
        )
    if response.status_code == 401:
        return "the agent rejected the dashboard's token — AGENT_TOKEN must match on both"
    try:
        body = response.json()
    except ValueError:
        body = {}
    return body.get("error") or body.get("detail") or f"agent answered {response.status_code}"


def list_for(base_url: str) -> dict:
    try:
        response = requests.get(
            f"{base_url}/networks", headers=agent_headers(), timeout=TIMEOUT_SECONDS
        )
    except requests.RequestException as error:
        return {"available": False, "reason": f"couldn't reach this agent: {error}", "networks": []}

    if not response.ok:
        return {"available": False, "reason": _error_from(response), "networks": []}

    body = response.json()
    rows = body.get("networks") if isinstance(body, dict) else None
    return {"available": True, "networks": rows if isinstance(rows, list) else []}


def _send(method: str, url: str, payload: dict | None = None) -> dict:
    try:
        response = requests.request(
            method, url, json=payload, headers=agent_headers(), timeout=TIMEOUT_SECONDS
        )
    except requests.RequestException as error:
        return {"success": False, "error": f"couldn't reach this agent: {error}"}

    if not response.ok:
        return {"success": False, "error": _error_from(response)}
    return response.json()


def create(base_url: str, name: str, subnet: str | None, internal: bool) -> dict:
    return _send(
        "POST",
        f"{base_url}/networks",
        {"name": name, "subnet": subnet or None, "internal": bool(internal)},
    )


def remove(base_url: str, network_id: str) -> dict:
    return _send("DELETE", f"{base_url}/networks/{requests.utils.quote(network_id, safe='')}")


def attach(base_url: str, network_id: str, container: str, connect: bool) -> dict:
    action = "connect" if connect else "disconnect"
    return _send(
        "POST",
        f"{base_url}/networks/{requests.utils.quote(network_id, safe='')}/{action}",
        {"container": container},
    )
