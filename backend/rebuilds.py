"""Proxy for each agent's ``/rebuild`` routes.

The agent does the work — pull the project's checkout, ``compose up -d
--build``, hand its own project to a throwaway container — and this is the
dashboard's side of it: find the agent, forward the request, and pass the
job back.

Nothing is cached. A rebuild is something someone just asked for and is
watching, so every poll is a real one; the job only changes because the
agent changed it.

The route is off on an agent until ``REBUILD_ENABLED=1``, and a host that
hasn't opted in answers 403. That isn't an error to paper over — it's the
answer, and it names the fix.
"""

from __future__ import annotations

import requests

from backend.docker import agent_headers
from backend.log import system as log

# Starting a rebuild returns as soon as the job exists, so this only has
# to cover the round trip, not the build.
TIMEOUT_SECONDS = 10


class RebuildError(Exception):
    """Something the person who pressed the button needs to read."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _call(method: str, base_url: str, path: str, **kwargs) -> dict:
    try:
        response = requests.request(
            method,
            f"{base_url}{path}",
            headers=agent_headers(),
            timeout=TIMEOUT_SECONDS,
            **kwargs,
        )

        if response.status_code == 404 and path == "/rebuild":
            raise RebuildError(
                "this agent predates the rebuild route — update it on the host "
                "first, then it can update itself",
                status_code=501,
            )

        body = {}
        try:
            body = response.json()
        except ValueError:
            pass

        if response.status_code >= 400:
            raise RebuildError(
                body.get("detail") or f"the agent answered {response.status_code}",
                status_code=response.status_code,
            )

        return body if isinstance(body, dict) else {}

    except requests.RequestException as error:
        log.debug("rebuild call to %s failed: %s", base_url, error)
        raise RebuildError(f"couldn't reach this agent: {error}") from error


def start(base_url: str, container: str, *, pull: bool = True) -> dict:
    return _call(
        "POST", base_url, "/rebuild", json={"container": container, "pull": pull}
    )


def job(base_url: str, job_id: str) -> dict:
    return _call("GET", base_url, f"/rebuild/{job_id}")


def listing(base_url: str) -> dict:
    return _call("GET", base_url, "/rebuild")
