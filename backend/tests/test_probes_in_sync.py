"""``probes.py`` lives in two repos and must stay byte-identical.

The dashboard runs probes itself and the agent runs the same code to probe
"from" a host, so a fix made in only one place quietly changes what a check
means depending on where it runs. This only means something on a machine with
both repos checked out side by side (set HOMELAB_AGENT_DIR if yours isn't
``../homelab-agent``); anywhere else it skips.
"""

import os
from pathlib import Path

import pytest

HERE = Path(__file__).resolve()
DASHBOARD_PROBES = HERE.parents[1] / "probes.py"
AGENT_DIR = Path(os.environ.get("HOMELAB_AGENT_DIR") or HERE.parents[3] / "homelab-agent")


@pytest.mark.skipif(not (AGENT_DIR / "probes.py").exists(), reason="no homelab-agent checkout next to this one")
def test_the_agents_probes_are_a_verbatim_copy():
    assert (AGENT_DIR / "probes.py").read_bytes() == DASHBOARD_PROBES.read_bytes(), (
        "probes.py differs between the dashboard and the agent: edit the dashboard's, then "
        f"cp backend/probes.py {AGENT_DIR}/probes.py"
    )
