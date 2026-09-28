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

# A passkey confirmation (Face ID / Touch ID again) before root-level
# actions. Built, off by default: turn on with PASSKEY_STEP_UP=1.
STEP_UP = env_str("PASSKEY_STEP_UP").lower() in ("1", "true", "yes", "on")

# ``API_TOKEN`` is the current name; ``REGISTER_TOKEN`` is kept as an alias
# so existing deployments don't break.
API_TOKEN = env_str("API_TOKEN") or env_str("REGISTER_TOKEN")


# Set by the SessionGate for a request carrying a valid session cookie.
# Contextvars follow the request into sync routes' worker threads.
session_ok: ContextVar[bool] = ContextVar("session_ok", default=False)
session_token: ContextVar[str | None] = ContextVar("session_token", default=None)
# Set when the request authenticated with the API token (a script).
token_ok: ContextVar[bool] = ContextVar("token_ok", default=False)


def token_matches(supplied: str | None) -> bool:
    return hmac.compare_digest((supplied or "").encode(), API_TOKEN.encode())


def check_token(supplied: str | None) -> None:
    if API_TOKEN and not session_ok.get() and not token_matches(supplied):
        raise HTTPException(
            status_code=401,
            detail="sign in with a passkey to do this (scripts: send X-Register-Token)",
        )


def require_elevated() -> None:
    """For the actions that are root on a host: a passkey confirmation in
    the last few minutes, not just a session. Scripts on the API token
    skip it (they already hold the most powerful credential), and with
    login off there is nothing to confirm with."""
    from backend import passkeys

    if not STEP_UP or not passkeys.store.enabled() or token_ok.get():
        return
    if passkeys.store.elevated_until(session_token.get()):
        return
    raise HTTPException(
        status_code=403,
        detail={"elevate": True, "message": "confirm with your passkey to do this"},
    )
