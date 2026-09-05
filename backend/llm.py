"""Optional LLM layer for the scheduler.

Two independent, single-call helpers, both gated on ``ANTHROPIC_API_KEY``:

- ``parse_constraints`` turns a free-text requirement into the structured
  ``Constraints`` the scheduler understands.
- ``explain_placement`` narrates a ranking that has *already* been decided.

Neither is allowed to change a placement. If the key is absent, the import
of ``anthropic`` fails, or the model returns something unparseable, every
function degrades to a safe no-op and the scheduler runs on the structured
form fields alone.
"""

from __future__ import annotations

import json
import os

from backend.models import Constraints, DeploymentSpec, PlacementResult

MODEL = os.getenv("SCHEDULER_LLM_MODEL", "claude-sonnet-5")


def enabled() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def _client():
    from anthropic import Anthropic

    return Anthropic()


def parse_constraints(
    notes: str, node_names: list[str]
) -> tuple[Constraints | None, list[str]]:
    """Best-effort structuring of ``notes``. Returns ``(constraints, warnings)``.

    ``constraints`` is ``None`` when the LLM is disabled or failed — the
    caller then falls back to the constraints already on the form.
    """
    notes = (notes or "").strip()
    if not notes or not enabled():
        return None, []

    prompt = (
        "You translate a homelab user's plain-English placement request into "
        "a strict JSON constraint object for a container scheduler.\n\n"
        f"Known node names: {', '.join(node_names) or '(none)'}\n\n"
        f"Request: {notes!r}\n\n"
        "Reply with ONLY a JSON object with these optional keys:\n"
        '  "require_gpu": boolean,\n'
        '  "node_in": [string]      // restrict to these exact node names,\n'
        '  "node_not_in": [string]  // never these exact node names,\n'
        '  "max_node_cpu_percent": number 0-100\n'
        "Only map to node names from the known list. Omit keys you are unsure "
        "about. If the request implies nothing schedulable, reply {}."
    )

    try:
        client = _client()
        message = client.messages.create(
            model=MODEL,
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(
            block.text for block in message.content if block.type == "text"
        ).strip()
        text = text[text.find("{") : text.rfind("}") + 1]
        raw = json.loads(text)
    except Exception as error:  # noqa: BLE001 - any failure -> safe fallback
        return None, [f"could not interpret the note automatically ({error})"]

    warnings: list[str] = []
    known = set(node_names)
    for key in ("node_in", "node_not_in"):
        if key in raw and isinstance(raw[key], list):
            good = [n for n in raw[key] if n in known]
            dropped = [n for n in raw[key] if n not in known]
            if dropped:
                warnings.append(
                    f"ignored unknown node name(s) in the note: {', '.join(map(str, dropped))}"
                )
            raw[key] = good or None

    try:
        parsed = Constraints(notes=notes, **{k: raw[k] for k in raw if k in Constraints.model_fields})
    except ValueError as error:
        return None, [f"note produced invalid constraints ({error})"]

    return parsed, warnings


def explain_placement(
    spec: DeploymentSpec, ranked: list[PlacementResult]
) -> str | None:
    if not enabled():
        return None

    eligible = [r for r in ranked if r.eligible][:3]
    if not eligible:
        return None

    summary = [
        {
            "node": r.node,
            "score": r.score,
            "free_ram_mb": r.free_ram_mb,
            "free_cpu_cores": r.free_cpu_cores,
            "has_gpu": r.has_gpu,
            "reasons": r.reasons,
        }
        for r in eligible
    ]

    prompt = (
        "A deterministic scheduler ranked these nodes for a container. "
        "Write 2-3 plain sentences for the user explaining why the top node "
        "was chosen over the runner-up. Do not contradict the scores; you are "
        "explaining them, not re-deciding.\n\n"
        f"Image: {spec.image}\n"
        f"Requested resources: {spec.resources.model_dump()}\n"
        f"Ranking: {json.dumps(summary)}"
    )

    try:
        client = _client()
        message = client.messages.create(
            model=MODEL,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(
            block.text for block in message.content if block.type == "text"
        ).strip() or None
    except Exception:  # noqa: BLE001
        return None
