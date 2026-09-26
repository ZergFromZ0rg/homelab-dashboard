"""Per-folder disk usage, proxied to each homelab-agent's ``/disk/usage``.

The agent walks its host's disk in the background and answers straight
away — ``state: scanning`` with partial numbers, then ``done`` — so the
explorer polls this while a scan runs. See homelab-agent's disk_usage.py for
how space is counted (allocated blocks, one filesystem, hard links once).
"""

from __future__ import annotations

import requests

from backend.docker import agent_headers

TIMEOUT_SECONDS = 10


def usage(base_url: str, path: str, refresh: bool = False) -> dict:
    try:
        response = requests.get(
            f"{base_url}/disk/usage",
            params={"path": path, "refresh": "true" if refresh else "false"},
            headers=agent_headers(),
            timeout=TIMEOUT_SECONDS,
        )
    except requests.RequestException as error:
        return {"state": "error", "error": f"couldn't reach this agent: {error}", "entries": []}

    if response.status_code == 404:
        return {
            "state": "error",
            "error": "this agent predates the disk explorer — rebuild it from the "
            "current homelab-agent image",
            "entries": [],
        }
    if response.status_code == 401:
        return {
            "state": "error",
            "error": "the agent rejected the dashboard's token — AGENT_TOKEN must match on both",
            "entries": [],
        }

    try:
        body = response.json()
    except ValueError:
        body = {}

    if not response.ok:
        return {"state": "error", "error": body.get("error") or f"agent answered {response.status_code}", "entries": []}
    return body


# A big folder of small files can take minutes for rm to get through.
DELETE_TIMEOUT_SECONDS = 900


def delete(base_url: str, path: str) -> dict:
    """Delete one file or folder on a host. The agent refuses system paths,
    top-level folders, mount points and anything a running container has
    mounted, and says which; that reason comes back as ``error``."""
    try:
        response = requests.post(
            f"{base_url}/disk/delete",
            json={"path": path},
            headers=agent_headers(),
            timeout=DELETE_TIMEOUT_SECONDS,
        )
    except requests.RequestException as error:
        return {"success": False, "error": f"couldn't reach this agent: {error}"}

    if response.status_code == 404:
        return {
            "success": False,
            "error": "this agent can't delete yet — rebuild it from the current homelab-agent image",
        }
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not response.ok:
        return {"success": False, "error": body.get("error") or body.get("detail") or f"agent answered {response.status_code}"}
    return body
