"""Container settings routes, proxied to each homelab-agent's ``/compose*``.

The agent reads the compose files, checks an edit with ``docker compose
config``, and applies it as a job with a health watch and rollback — see
homelab-agent's compose_edit.py. This passes that through, and puts each
apply on the activity feed: once when it starts, once with how it ended.

Applying is gated like delete (``auth.check_token``) on top of the session.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Header

from backend import activity, audit_log, auth
from backend.files_api import _agent, _call

router = APIRouter(prefix="/api/compose/{host}")

APPLY_TIMEOUT = 30

# Jobs whose outcome is already on the feed, so polling doesn't repeat it.
_reported: set[str] = set()

OUTCOME = {
    "done": ("compose_applied", "applied"),
    "rolled_back": ("compose_rolled_back", "rolled back"),
    "failed": ("compose_failed", "failed"),
}


@router.get("/containers/{container}")
def settings(host: str, container: str):
    """The compose files behind a container — or, for one Compose didn't
    start, a generated compose file to start from."""
    base = _agent(host)
    response = _call("GET", f"{base}/compose", params={"container": container})
    if response.status_code == 400 and json.loads(response.body).get("compose") is False:
        return _call("GET", f"{base}/compose/generate", params={"container": container})
    return response


@router.post("/preview")
def preview(host: str, body: dict):
    return _call("POST", f"{_agent(host)}/compose/preview", json=body, timeout=120)


@router.post("/apply")
def apply(host: str, body: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    auth.require_elevated()
    response = _call("POST", f"{_agent(host)}/compose/apply", json=body, timeout=APPLY_TIMEOUT)
    if response.status_code == 200:
        job = json.loads(response.body)
        activity.record("compose", f"Applying a compose change to {job.get('project')}", host)
    return response


@router.get("/jobs/{job_id}")
def job(host: str, job_id: str):
    response = _call("GET", f"{_agent(host)}/compose/jobs/{job_id}")
    if response.status_code == 200:
        body = json.loads(response.body)
        outcome = OUTCOME.get(body.get("state"))
        if outcome and job_id not in _reported:
            _reported.add(job_id)
            kind, verb = outcome
            reason = f": {body['error'].splitlines()[0]}" if body.get("error") else ""
            activity.record(kind, f"Compose change to {body.get('project')} {verb}{reason}", host)
            audit_log.record(f"compose change {verb}", who="system", host=host, ok=verb == "applied",
                             target={"project": body.get("project"), "id": job_id},
                             detail=(body.get("error") or "")[:300] or None)
    return response
