"""The load/atomic-save dance every ``/data`` JSON store was repeating:
read and shrug off a missing or corrupt file, write via a temp file +
rename so a crash mid-write can't truncate the real one.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.log import system


def read_json(path: str | Path, default: Any) -> Any:
    """Parsed contents of ``path``, or ``default`` if it's missing or not
    valid JSON."""
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def write_json_atomic(
    path: str | Path,
    data: Any,
    *,
    label: str = "state",
    indent: int | None = 2,
    sort_keys: bool = False,
) -> None:
    """Write ``data`` as JSON to ``path`` via ``path.tmp`` + rename. Logs and
    swallows OS errors — a read-only volume shouldn't crash the caller."""
    path = Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        body = json.dumps(data, indent=indent, sort_keys=sort_keys)
        tmp.write_text(body + "\n" if indent else body)
        tmp.replace(path)
    except OSError as error:
        system.warning("%s save failed: %s", label, error)
