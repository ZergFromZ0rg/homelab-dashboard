"""'Why is this container busy?' — gathers what explain.py reasons over."""

from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException

from backend import activity, container_history, explain, volume_backups

router = APIRouter()

# Enough activity to cover the day the analysis looks at, with room for a
# flapping container's noise.
EVENT_LIMIT = 500


def _gather(host: str, name: str, container: dict, machine: dict | None, peers: list[dict]) -> dict:
    now = time.time()
    return explain.explain(
        host=host,
        container=container,
        machine=machine,
        peers=peers,
        series_24h=container_history.history(host, name, "24h", now=now)["points"],
        series_7d=container_history.history(host, name, "7d", now=now)["points"],
        events=activity.history(limit=EVENT_LIMIT),
        backup_jobs=volume_backups.store.all(),
        now=now,
    )


@router.get("/api/containers/{host}/{name}/why")
async def why_is_it_busy(host: str, name: str):
    """What this container is doing to its host, and what changed.

    Read from the shared /ws snapshot, so asking costs no agent round-trip:
    the numbers are the ones already on the row.
    """
    # Imported here: main imports this module at startup.
    from backend import main

    snapshot = await main.shared_update()
    peers = (snapshot.get("containers") or {}).get(host)
    if peers is None:
        raise HTTPException(status_code=404, detail=f"no host called {host}")

    container = next((c for c in peers if c.get("name") == name), None)
    if container is None:
        raise HTTPException(status_code=404, detail=f"{host} has no container called {name}")

    machine = (snapshot.get("machines") or {}).get(host)
    return await asyncio.to_thread(_gather, host, name, container, machine, peers)
