"""Optional shared-secret gate on the mutating routes (node register/
delete, container control, every deploy route). Unset = open, which is
fine behind Tailscale; set ``API_TOKEN`` to require the header.

A signed-in passkey session passes it too. The browser used to send the
token from a box on each form; with login in place that box was a second
password for the same person, so the session covers it and the token is
for scripts and agents.
"""

from __future__ import annotations

import hmac
from contextvars import ContextVar

from fastapi import HTTPException

from backend.env import env_str

# ``API_TOKEN`` is the current name; ``REGISTER_TOKEN`` is kept as an alias
# so existing deployments don't break.
API_TOKEN = env_str("API_TOKEN") or env_str("REGISTER_TOKEN")


# Set by the SessionGate for a request carrying a valid session cookie.
# Contextvars follow the request into sync routes' worker threads.
session_ok: ContextVar[bool] = ContextVar("session_ok", default=False)


def token_matches(supplied: str | None) -> bool:
    return hmac.compare_digest((supplied or "").encode(), API_TOKEN.encode())


def check_token(supplied: str | None) -> None:
    if API_TOKEN and not session_ok.get() and not token_matches(supplied):
        raise HTTPException(
            status_code=401,
            detail="sign in with a passkey to do this (scripts: send X-Register-Token)",
        )
