"""Optional shared-secret gate on the mutating routes (node register/
delete, container control, every deploy route). Unset = open, which is
fine behind Tailscale; set ``API_TOKEN`` to require the header.
"""

from __future__ import annotations

from fastapi import HTTPException

from backend.env import env_str

# ``API_TOKEN`` is the current name; ``REGISTER_TOKEN`` is kept as an alias
# so existing deployments don't break.
API_TOKEN = env_str("API_TOKEN") or env_str("REGISTER_TOKEN")


def check_token(supplied: str | None) -> None:
    if API_TOKEN and supplied != API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid registration token")
