"""Which host is which: the dashboard's own host, and an agent's URL.

Shared by the routers; used to live in main.py.
"""

from __future__ import annotations

import os

from fastapi import HTTPException

from backend.registry import registry

# The host the dashboard itself runs on, if any — it gets its own
# top-level section instead of being shown as just another node.
#
# Auto-detected: Docker sets a container's HOSTNAME env var to its own
# short container ID by default, and every agent already reports that
# same ID for this container in its container list (an agent lists every
# container on its host, this one included). So whichever registered
# agent reports a container ID matching our own HOSTNAME is the host
# we're running on — no configuration needed. MAIN_HOST overrides this
# when set, for setups where that detection doesn't apply (HOSTNAME
# overridden in compose, or the dashboard runs on a host with no agent).
SELF_CONTAINER_ID = os.getenv("HOSTNAME", "").strip()
MAIN_HOST_OVERRIDE = os.getenv("MAIN_HOST", "").strip() or None


def detect_main_host(agent_data: dict) -> str | None:
    if not SELF_CONTAINER_ID:
        return None

    for host, data in agent_data.items():
        for container in data.get("containers", []):
            container_id = container.get("id") or ""

            if container_id and (
                SELF_CONTAINER_ID.startswith(container_id)
                or container_id.startswith(SELF_CONTAINER_ID)
            ):
                return host

    return None


def agent_for(host: str) -> str:
    nodes = registry.all()
    if host not in nodes:
        raise HTTPException(status_code=404, detail="Unknown host")
    return nodes[host]["url"].rstrip("/")
