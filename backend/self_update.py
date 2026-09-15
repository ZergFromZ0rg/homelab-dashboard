"""Self-update: pull the latest homelab-dashboard code and rebuild/
restart dashboard-api + dashboard-web, triggered from the "Update"
button next to the connection pill in the header.

dashboard-api doesn't run ``git pull`` / ``docker compose up`` itself —
that would recreate its own container mid-command and kill the process
running them. Instead it asks the Docker daemon (over the socket it's
given at ``/var/run/docker.sock``) to run one short-lived container that
does the actual work and exits; that update container is never among the
services it redeploys, so it survives to completion and reports back via
its own logs/exit code.

Needs ``HOST_REPO_PATH`` set to this repo's checkout path *on the Docker
host* — a sibling container's volumes are resolved by the daemon against
the host filesystem, not dashboard-api's own view of it (which only ever
sees the copy baked into its image at build time, not a live checkout).
Giving dashboard-api the Docker socket is equivalent to root on the host
for whoever can reach its API — see .env.example before enabling this.
"""

from __future__ import annotations

import docker
from docker.errors import DockerException, NotFound

from backend.env import env_str
from backend.log import system as log

HOST_REPO_PATH = env_str("HOST_REPO_PATH")
UPDATE_IMAGE = env_str("SELF_UPDATE_IMAGE", "docker:27-cli")
SERVICES = env_str("SELF_UPDATE_SERVICES", "dashboard-api dashboard-web")
CONTAINER_NAME = "homelab-dashboard-self-update"
LOG_TAIL_LINES = 200

_SCRIPT = (
    "set -e; "
    "apk add --no-cache git >/dev/null; "
    "cd /repo && git pull && "
    f"docker compose build {SERVICES} && "
    f"docker compose up -d {SERVICES}"
)


def _client_or_none() -> docker.DockerClient | None:
    try:
        client = docker.from_env()
        client.ping()
        return client
    except DockerException:
        return None


def status() -> dict:
    """State of the most recent update run — for the frontend to poll
    after triggering one, since its own connection drops when
    dashboard-api restarts partway through and can't just wait on the
    POST's response."""
    if not HOST_REPO_PATH:
        return {
            "available": False,
            "state": "unavailable",
            "reason": "HOST_REPO_PATH isn't set",
        }

    client = _client_or_none()
    if client is None:
        return {
            "available": False,
            "state": "unavailable",
            "reason": "Docker socket isn't reachable from dashboard-api",
        }

    try:
        container = client.containers.get(CONTAINER_NAME)
    except NotFound:
        return {"available": True, "state": "none"}

    container.reload()
    raw_state = container.attrs.get("State", {})
    running = raw_state.get("Running", False)
    exit_code = raw_state.get("ExitCode")
    logs = container.logs(tail=LOG_TAIL_LINES).decode("utf-8", errors="replace")

    if running:
        state = "running"
    elif exit_code == 0:
        state = "succeeded"
    else:
        state = "failed"

    return {"available": True, "state": state, "exit_code": exit_code, "log": logs}


def trigger() -> dict:
    """Launch the updater container (removing any previous one first, so
    a stuck or already-finished run doesn't block a new one). Returns
    immediately — the actual pull/build/restart happens in the
    background, in that separate container."""
    if not HOST_REPO_PATH:
        raise RuntimeError(
            "HOST_REPO_PATH isn't set — see .env.example for what to set "
            "it to before self-update can run"
        )

    client = _client_or_none()
    if client is None:
        raise RuntimeError("Docker socket isn't reachable from dashboard-api")

    try:
        client.containers.get(CONTAINER_NAME).remove(force=True)
    except NotFound:
        pass

    client.containers.run(
        UPDATE_IMAGE,
        ["sh", "-c", _SCRIPT],
        name=CONTAINER_NAME,
        working_dir="/repo",
        volumes={
            "/var/run/docker.sock": {"bind": "/var/run/docker.sock", "mode": "rw"},
            HOST_REPO_PATH: {"bind": "/repo", "mode": "rw"},
        },
        detach=True,
        remove=False,
    )

    log.info("self-update: launched %s from %s", CONTAINER_NAME, HOST_REPO_PATH)
    return {"started": True}
