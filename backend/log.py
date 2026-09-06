"""One place to configure logging.

Everything logs to stdout (so ``docker logs`` / ``docker compose logs``
picks it up). ``LOG_LEVEL`` controls verbosity (default INFO).

``scheduler`` is the logger for placement decisions — deploy, move,
reschedule, fail, recover. Filter the container's logs to it for a
fleet-wide audit trail:

    docker logs homelab-dashboard-api 2>&1 | grep ' scheduler '
"""

from __future__ import annotations

import logging
import os
import sys

_configured = False


def configure() -> None:
    global _configured
    if _configured:
        return

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)-9s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    level = os.getenv("LOG_LEVEL", "INFO").upper()

    for name in ("scheduler", "system"):
        lg = logging.getLogger(name)
        lg.setLevel(level)
        lg.handlers[:] = [handler]
        lg.propagate = False

    _configured = True


configure()

scheduler = logging.getLogger("scheduler")
system = logging.getLogger("system")
