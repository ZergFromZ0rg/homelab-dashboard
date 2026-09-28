import pytest
import time
from backend.morning import synthesize

def test_synthesize_empty_state():
    summary = synthesize(
        machines={},
        containers={},
        activity_entries=[],
        alert_entries=[],
        deployments=[],
        check_summaries=[],
        backups_summary=None
    )
    assert summary["overnight"]["events_count"] == 0
    assert summary["degrading"] == []
    assert summary["needs_action"] == []

def test_synthesize_degrading_and_actions():
    now = time.time()
    machines = {
        "nuc-1": {
            "host_facts": {
                "os_updates": 109,
                "security_updates": 12,
                "reboot_required": True,
                "failed_units": ["smartd.service"]
            },
            "filesystems": [
                {"mountpoint": "/data", "days_until_full": 4.1, "used_percent": 88}
            ]
        }
    }
    containers = {
        "nuc-1": [
            {
                "name": "jellyfin",
                "restart_count": 7,
                "status": "restarting"
            },
            {
                "name": "vaultwarden",
                "update": {"can_update": True}
            }
        ]
    }
    activity = [
        {"kind": "backup_done", "text": "Backup ok", "at": now - 3600, "host": "nuc-1"}
    ]
    
    summary = synthesize(
        machines=machines,
        containers=containers,
        activity_entries=activity,
        alert_entries=[],
        deployments=[],
        check_summaries=[],
        backups_summary={"attention": 1},
        now=now
    )

    degrading_keys = [d["key"] for d in summary["degrading"]]
    assert "services:nuc-1" in degrading_keys
    assert "os_updates:nuc-1" in degrading_keys
    assert "diskfull:nuc-1:/data" in degrading_keys
    assert "container_restarting:nuc-1:jellyfin" in degrading_keys
    assert "backups:failing" in degrading_keys
    
    action_ids = [a["id"] for a in summary["needs_action"]]
    assert "os_upgrade:nuc-1" in action_ids
    assert "reboot:nuc-1" in action_ids
    assert "container_updates:nuc-1" in action_ids

    assert summary["overnight"]["events_count"] == 1
    assert summary["overnight"]["highlights"][0]["kind"] == "backup_done"
