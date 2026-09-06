"""Persistent record of scheduler-managed deployments.

Same shape as ``registry.py`` / ``live_history.py``: a lock-guarded dict
written to a JSON file on the ``/data`` volume so it survives a dashboard
restart. This is the desired-state list — "we asked node X to run image Y"
— which the ``/ws`` loop reconciles against the live container snapshot on
every tick.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from backend.log import scheduler, system
from backend.models import DeploymentRecord

DEPLOYMENTS_FILE = Path(os.getenv("DEPLOYMENTS_FILE", "/data/deployments.json"))


class DeploymentStore:
    def __init__(self, path: Path = DEPLOYMENTS_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._records: dict[str, DeploymentRecord] = self._load()

    def _load(self) -> dict[str, DeploymentRecord]:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}

        records: dict[str, DeploymentRecord] = {}
        for entry in data if isinstance(data, list) else []:
            try:
                record = DeploymentRecord.model_validate(entry)
            except ValueError:
                continue
            records[record.id] = record
        return records

    def _save_locked(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            payload = [
                record.model_dump() for record in self._records.values()
            ]
            tmp.write_text(json.dumps(payload, indent=2) + "\n")
            tmp.replace(self.path)
        except OSError as error:
            system.warning("deployments save failed: %s", error)

    def add(self, record: DeploymentRecord) -> DeploymentRecord:
        with self._lock:
            self._records[record.id] = record
            self._save_locked()
            return record

    def get(self, deployment_id: str) -> DeploymentRecord | None:
        with self._lock:
            record = self._records.get(deployment_id)
            return record.model_copy(deep=True) if record else None

    def update(self, deployment_id: str, **fields) -> DeploymentRecord | None:
        with self._lock:
            record = self._records.get(deployment_id)
            if record is None:
                return None
            for key, value in fields.items():
                setattr(record, key, value)
            record.touch()
            self._save_locked()
            return record.model_copy(deep=True)

    def log_event(
        self, deployment_id: str, kind: str, detail: str = "", *, automatic: bool = False
    ) -> DeploymentRecord | None:
        with self._lock:
            record = self._records.get(deployment_id)
            if record is None:
                return None
            record.log(kind, detail, automatic=automatic)
            self._save_locked()
            level = scheduler.warning if kind == "failed" else scheduler.info
            level(
                "%s %s%s %s%s",
                kind,
                deployment_id[:8],
                f"/{record.kind}" if record.kind != "container" else "",
                "(auto) " if automatic else "",
                detail,
            )
            return record.model_copy(deep=True)

    def remove(self, deployment_id: str) -> bool:
        with self._lock:
            existed = self._records.pop(deployment_id, None) is not None
            if existed:
                self._save_locked()
            return existed

    def all(self) -> list[DeploymentRecord]:
        with self._lock:
            return [r.model_copy(deep=True) for r in self._records.values()]

    # A container the agent hasn't put in its snapshot yet (a just-finished
    # deploy) looks "gone" for a few seconds. Don't flip a freshly-running
    # record to failed on absence alone until this much time has passed —
    # a container that's *present but broken* is failed immediately.
    ABSENCE_GRACE_SECONDS = 20

    def reconcile(self, live: dict[str, list[dict]], offline_hosts: set[str]) -> None:
        """Refresh each record's status against the live container snapshot.

        ``live`` is ``{host: [container, ...]}`` straight off the /ws loop.
        A record whose container is present, running and (if it has a
        healthcheck) healthy stays ``running``; an unreachable host makes it
        ``node_offline``; a vanished, stopped, or ``unhealthy`` container
        makes it ``failed``. ``placing`` and ``stopped`` records are left
        alone.
        """
        now = time.time()
        with self._lock:
            changed = False
            for record in self._records.values():
                if record.status in ("placing", "stopped"):
                    continue
                if not record.placed_on or not record.agent_container_id:
                    continue

                if record.placed_on in offline_hosts:
                    new_status, detail, absent = (
                        "node_offline",
                        f"{record.placed_on} unreachable",
                        False,
                    )
                elif record.kind == "stack":
                    new_status, detail, absent = _stack_status(
                        live.get(record.placed_on, []), record.agent_container_id
                    )
                else:
                    new_status, detail, absent = _container_status(
                        live.get(record.placed_on, []), record.agent_container_id
                    )

                if (
                    new_status == "failed"
                    and absent
                    and record.status == "running"
                    and record.deployed_at
                    and now - record.deployed_at < self.ABSENCE_GRACE_SECONDS
                ):
                    continue

                if new_status != record.status:
                    previous = record.status
                    record.status = new_status
                    kind = None
                    if new_status == "running" and previous in ("failed", "node_offline"):
                        kind, text = "recovered", detail or f"running on {record.placed_on}"
                    elif new_status == "failed":
                        kind, text = "failed", detail or "no running container"
                    elif new_status == "node_offline":
                        kind, text = "node_offline", detail
                    if kind:
                        record.log(kind, text)
                        level = scheduler.warning if kind != "recovered" else scheduler.info
                        level("%s %s %s", kind, record.id[:8], text)
                    else:
                        record.touch()
                    changed = True

            if changed:
                self._save_locked()


def _same_container(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    return a.startswith(b) or b.startswith(a)


def _healthy(container: dict) -> tuple[bool, str]:
    """A running container is 'up' unless its healthcheck says otherwise."""
    if container.get("status") != "running":
        return False, f"container is {container.get('status') or 'gone'}"
    if container.get("health") == "unhealthy":
        return False, "container healthcheck is failing"
    return True, ""


def _container_status(
    containers: list[dict], container_id: str
) -> tuple[str, str, bool]:
    """Returns ``(status, detail, absent)`` — ``absent`` is True only when the
    container isn't in the snapshot at all (vs present but broken)."""
    match = next(
        (c for c in containers if _same_container(c.get("id"), container_id)), None
    )
    if match is None:
        return "failed", "container is gone", True
    up, why = _healthy(match)
    return ("running", "", False) if up else ("failed", why, False)


def _stack_status(
    containers: list[dict], project: str
) -> tuple[str, str, bool]:
    members = [c for c in containers if c.get("compose_project") == project]
    if not members:
        return "failed", "no containers for this project", True

    unhealthy = [c["name"] for c in members if c.get("health") == "unhealthy"]
    if unhealthy:
        return "failed", f"unhealthy service(s): {', '.join(unhealthy)}", False

    if any(c.get("status") == "running" for c in members):
        return "running", "", False
    return "failed", "no running containers in the project", False
