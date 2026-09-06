"""Opt-in loop that acts on rebalance suggestions instead of only showing
them. Off unless ``AUTO_REBALANCE`` is truthy. Deliberately timid:

- only moves that clear ``AUTO_REBALANCE_MIN_GAIN`` (higher than the bar
  for merely *suggesting* a move),
- one move per cycle by default,
- a per-deployment cooldown so a flapping node can't cause a move storm.

``plan_moves`` is the pure decision function; ``main`` runs the loop and
performs the moves through the same path as the redeploy endpoint.
"""

from __future__ import annotations

import os
import time


def _flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


def enabled() -> bool:
    return _flag("AUTO_REBALANCE")


def _num(name: str, default: float) -> float:
    try:
        return float(os.getenv(name) or default)
    except ValueError:
        return default


INTERVAL_SECONDS = _num("AUTO_REBALANCE_INTERVAL", 600)
MIN_GAIN = _num("AUTO_REBALANCE_MIN_GAIN", 30)
COOLDOWN_SECONDS = _num("AUTO_REBALANCE_COOLDOWN", 3600)
MAX_PER_CYCLE = int(_num("AUTO_REBALANCE_MAX_PER_CYCLE", 1))


def _cooling_down(record: dict, now: float) -> bool:
    last = record.get("last_auto_move")
    return bool(last and now - last < COOLDOWN_SECONDS)


def plan_moves(
    suggestions: list[dict],
    records_by_id: dict[str, dict],
    *,
    now: float | None = None,
) -> list[dict]:
    """Filter rebalance suggestions to the ones the loop should actually
    execute this cycle. ``records_by_id`` maps deployment id -> record dump.
    """
    now = now or time.time()
    chosen: list[dict] = []

    for suggestion in sorted(suggestions, key=lambda s: -s["gain"]):
        if len(chosen) >= MAX_PER_CYCLE:
            break
        if suggestion["gain"] < MIN_GAIN:
            continue

        record = records_by_id.get(suggestion["deployment_id"])
        if not record or record.get("status") != "running":
            continue
        if _cooling_down(record, now):
            continue

        chosen.append(suggestion)

    return chosen


def plan_reschedules(
    records: list[dict], *, now: float | None = None
) -> list[dict]:
    """Deployments stranded on an offline node that could be moved: stateless
    single containers only (a stack or a volume can't be relocated), not in
    cooldown. Returns the record dumps, at most ``MAX_PER_CYCLE``.
    """
    now = now or time.time()
    chosen: list[dict] = []
    for record in records:
        if len(chosen) >= MAX_PER_CYCLE:
            break
        if record.get("status") != "node_offline":
            continue
        if record.get("kind") != "container":
            continue
        spec = record.get("spec") or {}
        if spec.get("volumes") or spec.get("pinned"):
            continue
        if _cooling_down(record, now):
            continue
        chosen.append(record)
    return chosen
