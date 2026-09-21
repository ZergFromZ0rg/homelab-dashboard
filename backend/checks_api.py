"""HTTP API for service checks. Reads are open (the checks also ride every
``/ws`` tick); anything that creates, edits, runs or removes a check needs
the API token when one is set — a check makes this backend send requests to
whatever address it's given, so it's gated like the other mutating routes.
"""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query

from backend import auth, checks

router = APIRouter()


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="no such check")


def _bad_request(error: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@router.get("/api/checks")
def list_checks():
    return {"checks": checks.service.summaries()}


@router.post("/api/checks", status_code=201)
def create_check(payload: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    try:
        spec = checks.service.store.create(payload)
    except ValueError as error:
        raise _bad_request(error) from None
    checks.service.run_now(spec["id"])
    return checks.service.summary(spec)


@router.put("/api/checks/{check_id}")
def update_check(
    check_id: str, payload: dict, x_register_token: str | None = Header(default=None)
):
    auth.check_token(x_register_token)
    try:
        changed = checks.service.store.update(check_id, payload)
    except ValueError as error:
        raise _bad_request(error) from None
    if changed is None:
        raise _not_found()
    before, after = changed
    checks.service.changed(before, after)
    return checks.service.summary(after)


@router.delete("/api/checks/{check_id}")
def delete_check(check_id: str, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    if not checks.service.store.delete(check_id):
        raise _not_found()
    checks.service.forget(check_id)
    return {"deleted": check_id}


@router.post("/api/checks/{check_id}/run")
def run_check(check_id: str, x_register_token: str | None = Header(default=None)):
    """Probe now instead of waiting for the next interval."""
    auth.check_token(x_register_token)
    if checks.service.store.get(check_id) is None:
        raise _not_found()
    checks.service.run_now(check_id)
    return {"queued": check_id}


@router.get("/api/checks/{check_id}/history")
def check_history(check_id: str, range: str = Query(default="24h")):  # noqa: A002
    try:
        data = checks.service.history(check_id, range)
    except ValueError as error:
        raise _bad_request(error) from None
    if data is None:
        raise _not_found()
    return data
