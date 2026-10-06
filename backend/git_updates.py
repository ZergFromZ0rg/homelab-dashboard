"""Discover source-update projects on registered agents; the agents own the work.

No host paths or repository URLs come from the browser. Each agent discovers
its own Compose checkouts and keeps its selections and deployment outcomes.
"""

from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import requests

from backend.docker import agent_headers

TIMEOUT = 8
MAX_WORKERS = 8


class GitUpdateError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _call(method: str, base_url: str, path: str, **kwargs) -> dict:
    try:
        response = requests.request(
            method, f"{base_url.rstrip('/')}{path}",
            headers=agent_headers(), timeout=TIMEOUT, **kwargs,
        )
    except requests.RequestException as error:
        # Exception strings can include credentials embedded in an agent URL.
        raise GitUpdateError("Could not reach this host's agent. It will keep its saved selections.") from error

    try:
        body = response.json()
    except ValueError:
        body = None

    if response.status_code == 404 and path == "/git-updates":
        raise GitUpdateError(
            "Update this host's homelab-agent once to discover repositories and enable automatic updates.",
            501,
        )
    if response.status_code >= 400:
        detail = body.get("detail") if isinstance(body, dict) else None
        raise GitUpdateError(
            detail if isinstance(detail, str) else f"The agent answered {response.status_code}.",
            response.status_code,
        )
    if not isinstance(body, dict):
        raise GitUpdateError("The agent returned an invalid automatic-update response.")
    return body


def for_host(host: str, node: dict) -> dict:
    try:
        body = _call("GET", node["url"], "/git-updates")
        projects = body.get("projects")
        if not isinstance(projects, list) or any(not isinstance(p, dict) for p in projects):
            raise GitUpdateError("The agent returned an invalid repository list.")
        return {
            "host": host, "available": True,
            "enabled": body.get("enabled") is True,
            "poll_seconds": body.get("poll_seconds", 15),
            "projects": projects, "error": None, "status_code": 200,
        }
    except GitUpdateError as error:
        return {
            "host": host, "available": False, "enabled": False,
            "poll_seconds": 15, "projects": [],
            "error": str(error), "status_code": error.status_code,
        }


def discover(nodes: dict) -> dict:
    if not nodes:
        return {"hosts": []}
    # A slow or older host must not prevent the others from being shown.
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(nodes))) as pool:
        futures = [pool.submit(for_host, host, nodes[host]) for host in sorted(nodes)]
        return {"hosts": [future.result() for future in futures]}


def set_enabled(base_url: str, project_id: str, enabled: bool) -> dict:
    return _call(
        "PUT", base_url, f"/git-updates/{quote(project_id, safe='')}",
        json={"enabled": enabled},
    )
