"""Scheduled volume backups: the settings, the schedule and the pruning.

The split with the agent is deliberate. An agent knows how to read one
volume and write one archive and nothing else — no schedule, no retention,
no idea that other nodes exist. Everything that needs a view of the whole
fleet lives here, so a job is configured in one place and a new node needs
no per-host environment beyond opting in to storing archives at all.

A job is: *this source, on this host, to this directory on that host,
every so often, keeping so many.* A source is a named volume or a host
directory — the second because most homelab data lives in a bind mount,
and the agent has to be opted in per host to read one.

Two decisions worth not relitigating:

**Retention is per job, matched by filename prefix.** Several jobs can
share a directory, so "keep 7" has to mean seven of *this job's* archives.
The agent names them ``<volume>-<stamp>.tar.gz``, and the prefix is what
tells them apart. Pruning never deletes a file it can't attribute — an
archive somebody put there by hand is not ours to delete.

**Pruning happens after a successful upload, never before.** The window
where the new archive exists and the old one doesn't yet is the window
where a failure costs you a backup, and it should be as short as possible
and on the right side of the write.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from pathlib import Path

import requests

from backend.env import env_float, env_int, env_str
from backend.jsonstore import read_json, write_json_atomic
from backend.log import system as log

BACKUPS_FILE = Path(env_str("VOLUME_BACKUPS_FILE", "/data/volume_backups.json"))

# How often the loop wakes up to see whether anything is due. Backups run
# on the order of hours; this only bounds how late one can start.
TICK_SECONDS = env_float("VOLUME_BACKUP_TICK", 60)

# A backup runs in a helper container and is polled, not waited on.
START_TIMEOUT = 15
POLL_TIMEOUT = 10
POLL_SECONDS = env_float("VOLUME_BACKUP_POLL", 10)

# Long enough for a big volume over a slow link, short enough that a job
# wedged forever eventually reports something.
MAX_RUN_SECONDS = env_float("VOLUME_BACKUP_MAX_SECONDS", 6 * 3600)

# Verifying decompresses the whole archive, so it scales with the backup,
# not with a request.
VERIFY_TIMEOUT = env_float("VOLUME_BACKUP_VERIFY_TIMEOUT", 900)

DEFAULT_INTERVAL_HOURS = env_float("VOLUME_BACKUP_INTERVAL_HOURS", 24)
DEFAULT_KEEP = env_int("VOLUME_BACKUP_KEEP", 7)

MAX_JOBS = 50
MAX_NAME = 80
MAX_ERROR = 300

ARCHIVE = re.compile(r"^(?P<prefix>.+)-\d{8}-\d{6}\.tar\.gz$")


class BackupError(Exception):
    """Something the person who configured the job needs to read."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def source_of(job: dict) -> str:
    """What a job copies — a volume name or a host path. One field in the
    UI, two on the wire, because the agent mounts them differently."""
    return job.get("volume") or job.get("path") or ""


def archive_prefix(source: str) -> str:
    """The agent's own naming rule, mirrored. The same sanitiser covers a
    volume name and a path, whose slashes become dashes. Kept in step by
    ``test_prefix_matches_the_agents_naming``."""
    return re.sub(r"[^A-Za-z0-9._-]", "-", source).strip("-") or "volume"


def owns(archive_name: str, source: str) -> bool:
    match = ARCHIVE.match(archive_name or "")
    return bool(match and match.group("prefix") == archive_prefix(source))


def _clean_job(raw: dict, *, default_dest: str | None = None) -> dict:
    """One job, with every field forced into range. Anything unreadable
    falls back to a default rather than failing the whole file — a job with
    a silly interval should still back up, just not every six seconds."""
    volume = str(raw.get("volume") or "").strip()
    path = str(raw.get("path") or "").strip()
    source = str(raw.get("source_host") or "").strip()

    if bool(volume) == bool(path):
        raise BackupError("a backup job needs either a volume or a path")

    if not source:
        raise BackupError("a backup job needs a source host")

    interval = float(raw.get("interval_hours") or DEFAULT_INTERVAL_HOURS)
    keep = int(raw.get("keep") or DEFAULT_KEEP)

    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:12]),
        "name": str(raw.get("name") or volume or path.rsplit("/", 1)[-1])[:MAX_NAME],
        "source_host": source,
        "volume": volume or None,
        "path": path or None,
        "dest_host": str(raw.get("dest_host") or default_dest or source).strip(),
        "directory": str(raw.get("directory") or "").strip(),
        # An hour is the floor for the same reason the agent's config
        # backup has one: a schedule tighter than the work takes is a way
        # to keep a host permanently busy.
        "interval_hours": min(max(interval, 1.0), 24 * 30),
        "keep": min(max(keep, 1), 500),
        "stop_containers": bool(raw.get("stop_containers")),
        "enabled": raw.get("enabled", True) is not False,
        "created_at": float(raw.get("created_at") or time.time()),
        "last_run_at": raw.get("last_run_at"),
        "last_success_at": raw.get("last_success_at"),
        "last_error": (str(raw["last_error"])[:MAX_ERROR]
                       if raw.get("last_error") else None),
        "last_archive": raw.get("last_archive") or None,
        "last_pruned": list(raw.get("last_pruned") or []),
        "last_stopped": list(raw.get("last_stopped") or []),
        "running": False,
    }


class BackupJobStore:
    """The configured jobs. Same lock-guarded, atomically-written store as
    the other ``/data`` files."""

    def __init__(self, path: Path = BACKUPS_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._jobs: list[dict] = self._load()

    def _load(self) -> list[dict]:
        data = read_json(self.path, [])
        rows = data if isinstance(data, list) else data.get("jobs", [])
        out = []

        for raw in rows if isinstance(rows, list) else []:
            try:
                out.append(_clean_job(raw))
            except BackupError as error:
                log.warning("dropping an unreadable backup job: %s", error)

        return out

    def _save_locked(self) -> None:
        write_json_atomic(self.path, self._jobs, label="volume backups")

    def all(self) -> list[dict]:
        with self._lock:
            return [dict(job) for job in self._jobs]

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            for job in self._jobs:
                if job["id"] == job_id:
                    return dict(job)

        return None

    def add(self, raw: dict, *, default_dest: str | None = None) -> dict:
        job = _clean_job(raw, default_dest=default_dest)

        with self._lock:
            if len(self._jobs) >= MAX_JOBS:
                raise BackupError(f"at most {MAX_JOBS} backup jobs")

            clash = [
                j for j in self._jobs
                if j["source_host"] == job["source_host"]
                and source_of(j) == source_of(job)
                and j["dest_host"] == job["dest_host"]
                and j["directory"] == job["directory"]
            ]

            if clash:
                raise BackupError(
                    f"{source_of(job)} on {job['source_host']} already backs "
                    f"up to {job['directory']} on {job['dest_host']}",
                    status_code=409,
                )

            self._jobs.append(job)
            self._save_locked()

        return dict(job)

    def update(self, job_id: str, changes: dict) -> dict:
        with self._lock:
            for index, job in enumerate(self._jobs):
                if job["id"] != job_id:
                    continue

                merged = {**job, **changes, "id": job_id}
                self._jobs[index] = _clean_job(merged)
                # Run history belongs to the job, not to the edit.
                for field in ("last_run_at", "last_success_at", "last_error",
                              "last_archive", "last_pruned", "last_stopped"):
                    self._jobs[index][field] = job[field]

                self._save_locked()
                return dict(self._jobs[index])

        raise BackupError("no such backup job", status_code=404)

    def remove(self, job_id: str) -> bool:
        with self._lock:
            before = len(self._jobs)
            self._jobs = [j for j in self._jobs if j["id"] != job_id]

            if len(self._jobs) == before:
                return False

            self._save_locked()
            return True

    def record(self, job_id: str, **fields) -> None:
        with self._lock:
            for job in self._jobs:
                if job["id"] == job_id:
                    job.update(fields)
                    self._save_locked()
                    return

    def mark_running(self, job_id: str, running: bool) -> None:
        with self._lock:
            for job in self._jobs:
                if job["id"] == job_id:
                    job["running"] = running
                    return


store = BackupJobStore()


# A job is behind once its newest archive is older than this many
# intervals. The same slack the config-backup status uses, so "stale"
# means one thing across the dashboard.
STALE_FACTOR = env_float("VOLUME_BACKUP_STALE_FACTOR", 1.5)


def state(job: dict, now: float | None = None) -> str:
    """One word for how a job is doing, and the only place that decides it.

    The Backups tab, the Overview panel and the alert loop all used to want
    this, and three copies of "is it stale" is three chances to disagree
    about whether your backups are working.

        running  copying right now
        paused   disabled by hand
        failing  the last attempt failed
        pending  configured, never run
        stale    last success is older than the schedule allows
        ok       current
    """
    if job.get("running"):
        return "running"

    if not job.get("enabled"):
        return "paused"

    success = job.get("last_success_at")
    run = job.get("last_run_at")

    # Measured against the last *attempt*: a job that failed after its last
    # success is failing, whatever that success said.
    if job.get("last_error") and (not success or (run or 0) > success):
        return "failing"

    if not success:
        return "pending"

    if (now or time.time()) - success > job["interval_hours"] * 3600 * STALE_FACTOR:
        return "stale"

    return "ok"


def due(job: dict, now: float | None = None) -> bool:
    """Whether a job should start. Measured from the last *attempt*, not
    the last success: a job failing every time shouldn't retry in a tight
    loop against a host that is plainly unwell."""
    if not job.get("enabled") or job.get("running"):
        return False

    last = job.get("last_run_at")

    if not last:
        return True

    return (now or time.time()) - float(last) >= job["interval_hours"] * 3600


# ---------------------------------------------------------------------------
# Talking to the agents
# ---------------------------------------------------------------------------


def _base_url(nodes: dict, host: str) -> str:
    node = nodes.get(host)

    if not node:
        raise BackupError(f"{host} has no registered agent", status_code=404)

    return str(node["url"]).rstrip("/")


def _call(method: str, url: str, **kwargs) -> dict:
    from backend.docker import agent_headers

    kwargs.setdefault("timeout", POLL_TIMEOUT)

    try:
        response = requests.request(method, url, headers=agent_headers(), **kwargs)
    except requests.RequestException as error:
        raise BackupError(f"couldn't reach the agent: {error}", status_code=502)

    body = {}

    try:
        body = response.json()
    except ValueError:
        pass

    if response.status_code == 404 and "/backup/volumes" in url:
        raise BackupError(
            "this agent predates volume backups — update it from the Servers "
            "tab, then it can take a backup",
            status_code=501,
        )

    if response.status_code >= 400:
        raise BackupError(
            str(body.get("detail") or f"the agent answered {response.status_code}"),
            status_code=response.status_code,
        )

    return body if isinstance(body, dict) else {}


def volumes_on(nodes: dict, host: str) -> dict:
    """What a host can back up and what it can store. This is what the
    settings form is built from, so it has to carry the reasons a host
    can't store anything as well as the fact."""
    return _call("GET", f"{_base_url(nodes, host)}/backup/volumes")


def archives_in(nodes: dict, host: str, directory: str) -> list[dict]:
    body = _call(
        "GET", f"{_base_url(nodes, host)}/backup/archives",
        params={"directory": directory},
    )

    return body.get("archives") or []


def _receive_url(nodes: dict, host: str) -> str:
    """The address the *source host's helper container* will use to reach
    the destination agent.

    Not necessarily the address this dashboard uses. A registered url can
    be a container name that only resolves on the dashboard's own Docker
    network, which a helper on another machine cannot use, so the agent's
    own ``BACKUP_PUBLIC_URL`` wins when it is set.
    """
    reported = (volumes_on(nodes, host).get("store") or {}).get("receive_url")

    return str(reported or _base_url(nodes, host)).rstrip("/")


def prune(nodes: dict, job: dict) -> list[str]:
    """Delete this job's oldest archives beyond ``keep``.

    Only files this job's volume named. A directory shared with another
    job, or with something a person put there, keeps everything that isn't
    ours.
    """
    archives = archives_in(nodes, job["dest_host"], job["directory"])
    mine = [a for a in archives if owns(a["name"], source_of(job))]
    excess = sorted(mine, key=lambda a: a["modified_at"], reverse=True)[job["keep"]:]

    if not excess:
        return []

    names = [a["name"] for a in excess]
    body = _call(
        "POST", f"{_base_url(nodes, job['dest_host'])}/backup/archives/delete",
        json={"directory": job["directory"], "names": names},
    )

    return body.get("deleted") or names


def start_backup(nodes: dict, job: dict) -> dict:
    """Ask the source host's agent to begin. Returns its job record."""
    from backend.env import env_str

    payload = {
        "directory": job["directory"],
        "stop_containers": job["stop_containers"],
    }

    if job.get("volume"):
        payload["volume"] = job["volume"]
    else:
        payload["path"] = job["path"]

    if job["dest_host"] != job["source_host"]:
        payload["remote"] = {
            "url": _receive_url(nodes, job["dest_host"]),
            "token": env_str("AGENT_TOKEN"),
        }

    return _call(
        "POST", f"{_base_url(nodes, job['source_host'])}/backup/volumes/run",
        json=payload, timeout=START_TIMEOUT,
    )


def wait_for(nodes: dict, job: dict, agent_job_id: str,
             *, sleep=time.sleep, now=time.time) -> dict:
    """Poll the agent until its job stops running.

    A backup is minutes to hours of work behind a request that returned in
    milliseconds, so this is the only honest way to find out how it went.
    """
    url = f"{_base_url(nodes, job['source_host'])}/backup/volumes/jobs/{agent_job_id}"
    started = now()
    misses = 0

    while True:
        try:
            state = _call("GET", url)
            misses = 0
        except BackupError as error:
            # An agent that restarts mid-backup loses the job record. Give
            # it a few tries before calling the backup lost.
            misses += 1

            if misses >= 3:
                raise BackupError(
                    f"lost track of the backup on {job['source_host']}: {error}",
                    status_code=502,
                )

            state = {"state": "running"}

        if state.get("state") != "running":
            return state

        if now() - started > MAX_RUN_SECONDS:
            raise BackupError(
                f"the backup on {job['source_host']} is still running after "
                f"{round(MAX_RUN_SECONDS / 3600, 1)}h — giving up on watching it",
                status_code=504,
            )

        sleep(POLL_SECONDS)


def run_job(nodes: dict, job: dict, *, jobs: BackupJobStore | None = None,
            sleep=time.sleep, now=time.time) -> dict:
    """One whole backup: start it, watch it, prune afterwards.

    Blocking on purpose — it is called from a background thread or from a
    route that has already handed the caller a job id.
    """
    jobs = jobs or store
    jobs.mark_running(job["id"], True)
    jobs.record(job["id"], last_run_at=now())

    try:
        started = start_backup(nodes, job)
        finished = wait_for(nodes, job, started["id"], sleep=sleep, now=now)

        if finished.get("state") != "succeeded":
            raise BackupError(
                finished.get("error") or f"the backup {finished.get('state')}",
                status_code=502,
            )

        archive = finished.get("result") or {}
        pruned = []

        try:
            pruned = prune(nodes, job)
        except BackupError as error:
            # The archive is safely written; failing the whole run because
            # the tidying up didn't work would be a lie about the backup.
            log.warning("backup %s: could not prune: %s", job["id"], error)

        jobs.record(
            job["id"],
            last_success_at=now(),
            last_error=None,
            last_stopped=list(finished.get("stopped") or []),
            last_archive={
                "name": archive.get("name"),
                "bytes": archive.get("bytes"),
                "sha256": archive.get("sha256"),
                "seconds": archive.get("seconds"),
                "at": now(),
            },
            last_pruned=pruned,
        )

        log.info(
            "backup %s: %s -> %s:%s (%s bytes)%s",
            job["id"], source_of(job), job["dest_host"], job["directory"],
            archive.get("bytes"),
            f", pruned {len(pruned)}" if pruned else "",
        )

        return {"ok": True, "archive": archive, "pruned": pruned}

    except BackupError as error:
        jobs.record(job["id"], last_error=str(error)[:MAX_ERROR])
        log.warning("backup %s failed: %s", job["id"], error)
        return {"ok": False, "error": str(error)}

    finally:
        jobs.mark_running(job["id"], False)


def run_due(nodes: dict, *, jobs: BackupJobStore | None = None,
            now=time.time, sleep=time.sleep) -> list[dict]:
    """Every job that is due, one at a time.

    Serial on purpose. Two backups at once means two helper containers
    reading two volumes and writing to the same disk, and the agent refuses
    a second one per host anyway.
    """
    jobs = jobs or store
    ran = []

    for job in jobs.all():
        if not due(job, now()):
            continue

        ran.append({"id": job["id"], **run_job(nodes, job, jobs=jobs,
                                               sleep=sleep, now=now)})

    return ran
