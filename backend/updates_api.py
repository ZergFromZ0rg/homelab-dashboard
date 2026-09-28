"""Image update routes, proxied to each homelab-agent's ``/updates*``.

The agent checks registries itself (every few hours) and reports per
container in its ``/containers`` snapshot, so the badges ride the normal
``/ws`` tick. These routes start an update job, follow it, and force a
check. Each update and its outcome go on the activity feed.

Starting one is gated like delete (``auth.check_token``) on top of the
session. See homelab-agent's updates.py.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Header

from backend import activity, audit_log, auth
from backend.files_api import _agent, _call

router = APIRouter(prefix="/api/updates/{host}")

_reported: set[str] = set()


def _what(job: dict) -> str:
    projects = job.get("projects") or []
    return ", ".join(projects) if len(projects) <= 3 else f"{len(projects)} stacks"


@router.post("")
def start(host: str, body: dict | None = None, x_register_token: str | None = Header(default=None)):
    """``{"containers": [names]}``, or ``{}`` for every update on the host."""
    auth.check_token(x_register_token)
    response = _call("POST", f"{_agent(host)}/updates", json=body or {})
    if response.status_code == 200:
        job = json.loads(response.body)
        activity.record("update", f"Updating {_what(job)}", host)
    return response


@router.post("/check")
def check(host: str):
    return _call("POST", f"{_agent(host)}/updates/check", timeout=120)


@router.get("/jobs/{job_id}")
def job(host: str, job_id: str):
    response = _call("GET", f"{_agent(host)}/updates/jobs/{job_id}")
    if response.status_code == 200:
        body = json.loads(response.body)
        state = body.get("state")
        if state != "running" and job_id not in _reported:
            _reported.add(job_id)
            results = body.get("results") or {}
            problems = "; ".join(f"{p} {r}" for p, r in results.items() if r != "done")
            kind, verb = {
                "done": ("update_done", "updated"),
                "rolled_back": ("update_rolled_back", "update rolled back"),
            }.get(state, ("update_failed", "update failed"))
            activity.record(kind, f"{_what(body)} {verb}" + (f": {problems}" if problems else ""), host)
            audit_log.record(f"image {verb}", who="system", host=host, ok=state == "done",
                             target={"project": ", ".join(body.get("projects") or []), "id": job_id},
                             detail=problems[:300] or None)
    return response
