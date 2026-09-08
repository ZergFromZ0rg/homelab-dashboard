"""Environment-variable helpers with one consistent rule: a variable that
is **set but empty** falls back to the default, same as an unset one.

That case isn't academic — `docker compose` passes an unset `${VAR:-}` as
an empty string, so `float(os.getenv("VAR"))` would raise and
`os.getenv("VAR", default)` would return `""` instead of the default.
"""

from __future__ import annotations

import os

_TRUTHY = {"1", "true", "yes", "on"}


def env_str(name: str, default: str = "") -> str:
    value = os.getenv(name, "").strip()
    return value or default


def env_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in _TRUTHY


def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name) or default)
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    try:
        return int(float(os.getenv(name) or default))
    except ValueError:
        return default
