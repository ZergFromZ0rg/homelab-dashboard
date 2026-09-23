"""The dashboard's side of an agent's settings.

A thin proxy on purpose. The agent owns what a setting means, what it will
accept and why it refuses — putting a second opinion here would mean two
places to keep in step, and the one that matters is the one that enforces
it. So this forwards the request and passes the agent's own wording back,
including its refusals: they name the exact fix, and rewording them here
would lose that.
"""

from __future__ import annotations

import requests

from backend.docker import agent_headers
from backend.log import system as log

TIMEOUT_SECONDS = 8


class ConfigError(Exception):
    """Something the person changing a setting needs to read."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _call(method: str, base_url: str, **kwargs) -> dict:
    try:
        response = requests.request(
            method, f"{base_url}/config",
            headers=agent_headers(), timeout=TIMEOUT_SECONDS, **kwargs,
        )

        if response.status_code == 404:
            raise ConfigError(
                "this agent predates dashboard settings — update it from the "
                "Servers tab, then it can be configured from here",
                status_code=501,
            )

        body = {}

        try:
            body = response.json()
        except ValueError:
            pass

        if response.status_code >= 400:
            raise ConfigError(
                str(body.get("detail") or f"the agent answered {response.status_code}"),
                status_code=response.status_code,
            )

        return body if isinstance(body, dict) else {}

    except requests.RequestException as error:
        log.debug("config call to %s failed: %s", base_url, error)
        raise ConfigError(f"couldn't reach this agent: {error}")


def read(base_url: str) -> dict:
    return _call("GET", base_url.rstrip("/"))


def write(base_url: str, settings: dict) -> dict:
    return _call("PUT", base_url.rstrip("/"), json={"settings": settings})
