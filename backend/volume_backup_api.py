"""Routes for scheduled volume backups, and the loop that runs them.

Kept out of ``main.py`` for the same reason the scheduler is: this is a
self-contained feature with its own store, its own background loop and its
own vocabulary, and ``main.py`` is already the node/container/pins file.

Every mutating route is token-gated. A backup job says "read this volume
and write it to that directory on that host", which is the same class of
privilege as the rebuild route — so it gets the same gate, rather than the
open-behind-Tailscale treatment the container controls have.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Header, HTTPException

from backend import auth
from backend import volume_backups
from backend.log import system as log
from backend.registry import registry
from backend.volume_backups import BackupError, source_of, store

router = APIRouter()


def _fail(error: BackupError):
    return HTTPException(status_code=error.status_code, detail=str(error))


def default_dest_host() -> str | None:
    """The dashboard's own host, which is where a backup goes unless told
    otherwise: the box you are looking at is the one you will still be
    looking at when the box that died is the other one."""
    from backend.main import MAIN_HOST_OVERRIDE, _detect_main_host
    from backend.docker import get_all_containers

    if MAIN_HOST_OVERRIDE:
        return MAIN_HOST_OVERRIDE

    try:
        return _detect_main_host(get_all_containers(registry.all()))
    except Exception as error:  # noqa: BLE001 - a default is not worth failing over
        log.debug("could not detect the dashboard's own host: %s", error)
        return None


@router.get("/api/backups")
def list_backups():
    """Every configured job. Cheap — no agent is contacted, so this can
    ride a polling UI."""
    return {"backups": store.all(), "default_dest_host": default_dest_host()}


@router.get("/api/backups/targets/{host}")
def backup_targets(host: str, x_register_token: str | None = Header(default=None)):
    """What a host can back up, and whether it can store backups.

    The settings form is built from this, which is why a host that can't
    store anything answers with the reason rather than an empty list.
    """
    auth.check_token(x_register_token)

    try:
        return volume_backups.volumes_on(registry.all(), host)
    except BackupError as error:
        raise _fail(error)


@router.post("/api/backups", status_code=201)
def create_backup(payload: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)

    try:
        return store.add(payload, default_dest=default_dest_host())
    except BackupError as error:
        raise _fail(error)


@router.put("/api/backups/{job_id}")
def update_backup(job_id: str, payload: dict,
                  x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)

    try:
        return store.update(job_id, payload)
    except BackupError as error:
        raise _fail(error)


@router.delete("/api/backups/{job_id}")
def delete_backup(job_id: str, x_register_token: str | None = Header(default=None)):
    """Forgets the schedule. Archives already written are left alone —
    deleting a job should never delete data."""
    auth.check_token(x_register_token)

    if not store.remove(job_id):
        raise HTTPException(status_code=404, detail="no such backup job")

    return {"ok": True}


@router.post("/api/backups/{job_id}/run")
async def run_backup_now(job_id: str,
                         x_register_token: str | None = Header(default=None)):
    """Start one now. Returns as soon as the work is handed to a thread —
    a backup takes minutes, and the UI polls ``GET /api/backups``."""
    auth.check_token(x_register_token)

    job = store.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="no such backup job")

    if job.get("running"):
        raise HTTPException(status_code=409, detail="that backup is already running")

    nodes = registry.all()

    asyncio.get_running_loop().run_in_executor(
        None, volume_backups.run_job, nodes, job
    )

    return {"started": True, "id": job_id}


@router.get("/api/backups/{job_id}/archives")
def list_backup_archives(job_id: str,
                         x_register_token: str | None = Header(default=None)):
    """What this job has actually written, newest first.

    Restoring is a deliberate, hands-on job and the dashboard does not do
    it. What it can do is tell you exactly what exists and where, which is
    the part that is otherwise an ssh session and a directory listing.
    """
    auth.check_token(x_register_token)

    job = store.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="no such backup job")

    try:
        archives = volume_backups.archives_in(
            registry.all(), job["dest_host"], job["directory"]
        )
    except BackupError as error:
        raise _fail(error)

    return {
        "host": job["dest_host"],
        "directory": job["directory"],
        "archives": [a for a in archives
                     if volume_backups.owns(a["name"], source_of(job))],
        "restore_hint": (
            f"docker run --rm -v <volume>:/dest -v {job['directory']}:/src:ro "
            "alpine sh -c 'rm -rf /dest/* && tar xzf /src/<archive> -C /dest'"
        ),
    }


@router.post("/api/backups/{job_id}/archives/verify")
def verify_backup_archive(job_id: str, payload: dict,
                          x_register_token: str | None = Header(default=None)):
    """Read one archive back on the host that holds it.

    The closest thing to a restore that isn't destructive: the whole
    archive is decompressed and every member walked, so a bad checksum, a
    truncated upload or a corrupted byte all show up. What it cannot tell
    you is whether the *contents* are a working database — only starting
    one does that.
    """
    auth.check_token(x_register_token)

    job = store.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="no such backup job")

    name = str(payload.get("name") or "").strip()

    if not volume_backups.owns(name, source_of(job)):
        raise HTTPException(
            status_code=400, detail=f"{name} was not written by this job"
        )

    try:
        return volume_backups._call(
            "POST",
            f"{volume_backups._base_url(registry.all(), job['dest_host'])}"
            "/backup/archives/verify",
            json={"directory": job["directory"], "name": name},
            # Reading a big archive back takes as long as it takes.
            timeout=volume_backups.VERIFY_TIMEOUT,
        )
    except BackupError as error:
        raise _fail(error)


@router.post("/api/backups/{job_id}/archives/delete")
def delete_backup_archives(job_id: str, payload: dict,
                           x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)

    job = store.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="no such backup job")

    names = payload.get("names")

    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise HTTPException(status_code=400, detail="names must be a list of strings")

    stray = [n for n in names if not volume_backups.owns(n, source_of(job))]

    if stray:
        raise HTTPException(
            status_code=400,
            detail=f"{stray[0]} was not written by this job",
        )

    try:
        return volume_backups._call(
            "POST",
            f"{volume_backups._base_url(registry.all(), job['dest_host'])}"
            "/backup/archives/delete",
            json={"directory": job["directory"], "names": names},
        )
    except BackupError as error:
        raise _fail(error)


async def run_forever() -> None:
    """Start whatever is due, forever.

    The work itself is blocking HTTP against the agents, so each pass goes
    to a worker thread; the loop only decides *when*.
    """
    loop = asyncio.get_running_loop()

    while True:
        try:
            await loop.run_in_executor(
                None, volume_backups.run_due, registry.all()
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - the loop must not die
            log.warning("volume backup loop: %s", error)

        await asyncio.sleep(volume_backups.TICK_SECONDS)
