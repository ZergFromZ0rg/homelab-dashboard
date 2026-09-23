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
from backend import backup_ignores
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
    """Every configured job, each carrying the one word for how it's doing.

    The state is computed here rather than in the browser so the tab, the
    Overview panel and the alert that pages you cannot disagree about
    whether a backup is working.
    """
    import time

    now = time.time()
    jobs = [{**job, "state": volume_backups.state(job, now)} for job in store.all()]

    return {"backups": jobs, "default_dest_host": default_dest_host()}


@router.get("/api/hosts/{host}/recovery")
def host_recovery(host: str, x_register_token: str | None = Header(default=None)):
    """What you would have if this machine died tonight.

    Three separate questions, because they have three separate answers and
    a single "backup: ok" hides that:

    - its **compose files**, which the agent pushes to a git repo, and which
      are what you rebuild the stacks *from*;
    - its **data**, which is only whatever a backup job actually covers;
    - and everything else, which is what you would lose.

    The last one is the point. A host nobody has configured reports every
    project as unprotected rather than reporting nothing at all.
    """
    auth.check_token(x_register_token)

    nodes = registry.all()

    try:
        found = volume_backups.projects_on(nodes, host)
    except BackupError as error:
        raise _fail(error)

    jobs = [j for j in store.all() if j["source_host"] == host]

    def protection(kind: str, name: str) -> dict | None:
        for job in jobs:
            if volume_backups.covers(job, kind, name):
                return {
                    "job": job["name"],
                    "id": job["id"],
                    "dest": f"{job['dest_host']}:{job['directory']}",
                    "state": volume_backups.state(job),
                }
        return None

    ignored = backup_ignores.store.for_host(host)
    projects = []
    unprotected_bytes = 0

    for project in found.get("projects", []):
        items = []

        for volume in project.get("volumes", []):
            items.append({**volume, "kind": "volume", "name": volume["name"],
                          "protected_by": protection("volume", volume["name"])})

        for directory in project.get("directories", []):
            items.append({**directory, "kind": "path", "name": directory["path"],
                          "protected_by": protection("path", directory["path"])})

        # Ignoring the stack means every piece of it; a piece named on its
        # own stands by itself. Coverage is per piece, so decisions are too
        # — jellyfin's config is worth keeping and its 900 GB of media is
        # not, and one flag per stack cannot say that.
        whole = ignored.get(project["project"])

        for item in items:
            item["ignored"] = whole or ignored.get(item["name"]) or None

            # Decided or covered, either way it is not an open question.
            if not item["protected_by"] and not item["ignored"]:
                unprotected_bytes += item.get("bytes") or 0

        projects.append({
            "project": project["project"],
            "working_dir": project.get("working_dir"),
            "containers": project.get("containers", []),
            "items": items,
            "protected": all(i["protected_by"] for i in items) if items else True,
            # "Nothing left to decide here", which is what the reader
            # actually wants to know.
            "settled": all(
                i["protected_by"] or i["ignored"] for i in items
            ) if items else True,
            "ignored": whole or None,
        })

    return {
        "host": host,
        "source_dirs": found.get("source_dirs", []),
        "config_backup": _config_backup(nodes, host),
        "projects": projects,
        "unprotected_bytes": unprotected_bytes,
        "unprotected_count": sum(
            1 for p in projects for i in p["items"]
            if not i["protected_by"] and not i["ignored"]
        ),
        "ignored_count": sum(
            1 for p in projects for i in p["items"]
            if i["ignored"] and not i["protected_by"]
        ),
    }


def _config_backup(nodes: dict, host: str) -> dict:
    """The compose-file backup, which is a different thing from the data and
    is what you would actually rebuild the stacks from."""
    from backend import backups

    try:
        return backups.status_for(host, volume_backups._base_url(nodes, host))
    except Exception as error:  # noqa: BLE001 - a missing half is not fatal
        log.debug("config backup status for %s: %s", host, error)
        return {"state": "unknown"}


@router.put("/api/hosts/{host}/recovery/ignore")
def ignore_projects(host: str, payload: dict,
                    x_register_token: str | None = Header(default=None)):
    """Record that a stack is deliberately not backed up.

    Not a way to hide things — an ignored stack stays on the page with the
    reason. What changes is that it stops being counted as a gap, so the
    number at the top keeps meaning something.
    """
    auth.check_token(x_register_token)

    # "projects" is the older spelling; either names stacks or pieces.
    names = payload.get("names") or payload.get("projects")
    reason = str(payload.get("reason") or "")

    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise HTTPException(status_code=400, detail="names must be a list of strings")

    return {
        "ignored": [backup_ignores.store.add(host, name, reason) for name in names]
    }


@router.delete("/api/hosts/{host}/recovery/ignore/{name:path}")
def unignore(host: str, name: str,
             x_register_token: str | None = Header(default=None)):
    """``:path`` because a decision can name a directory, and a directory
    has slashes in it."""
    auth.check_token(x_register_token)

    if not backup_ignores.store.remove(host, name):
        raise HTTPException(status_code=404, detail="that was not ignored")

    return {"ok": True}


@router.post("/api/backups/from-projects")
def backup_from_projects(payload: dict,
                         x_register_token: str | None = Header(default=None)):
    """Create jobs for whole projects, rather than for paths.

    People think in stacks — "back up jellyfin" — not in bind mounts, and
    the mapping from one to the other is something this already knows. So
    the caller names projects and a destination; this works out the data
    each one owns and creates a job per piece that isn't covered already.

    Idempotent on purpose: naming a project twice adds nothing the second
    time, so the sane gesture (select everything, apply) does not produce
    duplicate jobs for whatever was already set up.
    """
    auth.check_token(x_register_token)

    host = str(payload.get("host") or "").strip()
    wanted = payload.get("projects")
    dest_host = str(payload.get("dest_host") or "").strip()
    directory = str(payload.get("directory") or "").strip()

    if not host or not dest_host or not directory:
        raise HTTPException(
            status_code=400,
            detail="host, dest_host and directory are all required",
        )

    if not isinstance(wanted, list) or not all(isinstance(p, str) for p in wanted):
        raise HTTPException(status_code=400, detail="projects must be a list of names")

    nodes = registry.all()

    try:
        found = volume_backups.projects_on(nodes, host)
    except BackupError as error:
        raise _fail(error)

    existing = [j for j in store.all() if j["source_host"] == host]
    created, skipped, refused = [], [], []

    for project in found.get("projects", []):
        if project["project"] not in wanted:
            continue

        pieces = (
            [("volume", v["name"], v) for v in project.get("volumes", [])]
            + [("path", d["path"], d) for d in project.get("directories", [])]
        )

        for kind, name, info in pieces:
            if any(volume_backups.covers(j, kind, name) for j in existing):
                skipped.append(name)
                continue

            # An empty source produces an empty archive every night and
            # looks like protection. Better to say why than to create it.
            if not info.get("bytes"):
                refused.append({"name": name, "why": "it is empty"})
                continue

            if kind == "path" and info.get("allowed") is False:
                refused.append({
                    "name": name,
                    "why": f"{host} does not allow that directory to be backed "
                           "up yet — add it in this host's Settings",
                })
                continue

            spec = {
                "name": f"{project['project']} {name.rsplit('/', 1)[-1]}"[:60],
                "source_host": host,
                "dest_host": dest_host,
                "directory": directory,
                "interval_hours": payload.get("interval_hours") or 24,
                "keep": payload.get("keep") or 7,
                "stop_containers": bool(payload.get("stop_containers", True)),
                **({"volume": name} if kind == "volume" else {"path": name}),
            }

            try:
                job = store.add(spec, default_dest=dest_host)
                created.append({"id": job["id"], "name": job["name"], "source": name})
                existing.append(job)
            except BackupError as error:
                refused.append({"name": name, "why": str(error)})

    return {"created": created, "already_covered": skipped, "refused": refused}


@router.get("/api/backups/destinations")
def backup_destinations(x_register_token: str | None = Header(default=None)):
    """Every host, and whether a backup can be sent to it.

    So choosing where a backup goes is a choice between known options
    rather than a guess you only find out was wrong after selecting it. A
    host that cannot store anything says why, in its agent's own words.
    """
    auth.check_token(x_register_token)

    nodes = registry.all()
    out = []

    for host in sorted(nodes):
        try:
            store_info = volume_backups.store_on(nodes, host)
            roots = [r for r in store_info.get("roots") or [] if r.get("usable")]
            blocked = [r for r in store_info.get("roots") or [] if not r.get("usable")]

            out.append({
                "host": host,
                "can_store": bool(roots),
                "roots": [r["path"] for r in roots],
                "encrypted": bool(store_info.get("encrypted")),
                "problem": (blocked[0].get("problem") if blocked else None) or (
                    None if roots else
                    f"{host} stores no backups — set BACKUP_HOST_DIR in its "
                    "agent's .env to a directory on that machine"
                ),
            })
        except BackupError as error:
            out.append({
                "host": host, "can_store": False, "roots": [],
                "encrypted": False, "problem": str(error),
            })

    return {"destinations": out}


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


def restore_steps(job: dict, archive: str) -> list[dict]:
    """How to put this archive back, as commands with the real values in.

    Written out rather than summarised because a restore happens rarely,
    under pressure, and usually by someone reading it for the first time.
    The archive lives on the *destination* host and the data belongs on the
    *source* host, so the first step is nearly always a copy between them —
    which a single-line hint quietly skipped, and which is the step that
    makes the rest not work.
    """
    source_host = job["source_host"]
    dest_host = job["dest_host"]
    local = source_host == dest_host
    path = f"{job['directory'].rstrip('/')}/{archive}"
    staged = path if local else f"/tmp/{archive}"
    steps = []

    if not local:
        steps.append({
            "where": dest_host,
            "what": "Copy the archive to the host the data belongs on.",
            "command": f"scp {path} {source_host}:/tmp/",
        })

    encrypted = archive.endswith(".gpg")

    if encrypted:
        folder = staged.rsplit("/", 1)[0]
        plain = staged.removesuffix(".gpg")
        steps.append({
            "where": source_host,
            "what": (
                "Decrypt it. Run through the agent's image rather than the "
                "host's own gpg: a host that runs an agent certainly has "
                "Docker, and may well not have gpg installed. The passphrase "
                "is the one set on the agent that made this backup — if it is "
                "lost, this archive cannot be recovered by any means."
            ),
            "command": (
                f"docker run --rm -i -v {folder}:/src:ro --entrypoint gpg "
                "homelab-agent --batch --quiet --pinentry-mode loopback "
                f"--passphrase '<passphrase>' -d /src/{archive} > {plain}"
            ),
        })
        staged = plain

    if job.get("volume"):
        steps.append({
            "where": source_host,
            "what": (
                f"Stop whatever uses {job['volume']}, then replace its "
                "contents. Everything in the volume is deleted first, so a "
                "half-restore can't leave old and new files mixed."
            ),
            "command": (
                f"docker run --rm -v {job['volume']}:/dest "
                f"-v {staged.rsplit('/', 1)[0]}:/src:ro alpine "
                f"sh -c 'rm -rf /dest/* && tar xzf /src/{archive} -C /dest'"
            ),
        })
    else:
        stopped = " ".join(job.get("last_stopped") or []) or "<its containers>"
        steps.append({
            "where": source_host,
            "what": "Stop whatever writes to this directory.",
            "command": f"docker stop {stopped}",
        })
        steps.append({
            "where": source_host,
            "what": (
                f"Replace the contents of {job['path']}. The directory is "
                "emptied first so a restore can't leave old and new files "
                "mixed together."
            ),
            "command": (
                f"sudo rm -rf {job['path'].rstrip('/')}/* && "
                f"sudo tar xzf {staged} -C {job['path']}"
            ),
        })
        steps.append({
            "where": source_host,
            "what": "Start it again.",
            "command": f"docker start {stopped}",
        })

    steps.append({
        "where": "anywhere",
        "what": "Check the archive before trusting it — or use Verify above.",
        "command": (
            f"tar tzf {staged} | head" if not encrypted else
            f"docker run --rm -i -v {path.rsplit('/', 1)[0]}:/src:ro "
            "--entrypoint gpg homelab-agent --batch --quiet --pinentry-mode "
            f"loopback --passphrase '<passphrase>' -d /src/{archive} "
            "| tar tz | head"
        ),
    })

    return steps


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

    mine = [a for a in archives if volume_backups.owns(a["name"], source_of(job))]

    return {
        "host": job["dest_host"],
        "directory": job["directory"],
        "archives": mine,
        "restore": restore_steps(job, mine[0]["name"] if mine else "<archive>"),
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

    # Before scheduling anything, find out what is actually on the
    # destinations. A run that finished while this process was restarting
    # is a real backup, and treating it as never-happened copies it again.
    try:
        await loop.run_in_executor(
            None, volume_backups.adopt_existing, registry.all()
        )
    except Exception as error:  # noqa: BLE001 - never block the loop starting
        log.warning("could not adopt existing archives: %s", error)

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
