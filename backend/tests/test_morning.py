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
                "update": {"state": "available"}
            }
        ]
    }
    activity = [
        {"kind": "update_failed", "text": "immich update failed", "at": now - 3600, "host": "nuc-1"},
        {"kind": "container_start", "text": "x started", "at": now - 60, "host": "nuc-1"},
        {"kind": "node_down", "text": "old", "at": now - 20 * 3600, "host": "nuc-1"}
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
    assert summary["overnight"]["highlights"][0]["kind"] == "update_failed"
    assert summary["overnight"]["highlights"][0]["tone"] == "bad"

    reboot = next(a for a in summary["needs_action"] if a["type"] == "reboot")
    assert reboot["action"]["url"] == "/api/hosts/nuc-1/power"
    assert reboot["action"]["body"] == {"action": "reboot"}


def test_lifetime_restarts_alone_are_not_degrading():
    summary = synthesize(
        machines={"nuc-1": {}},
        containers={"nuc-1": [{"name": "db", "status": "running", "restart_count": 40}]},
        activity_entries=[], alert_entries=[], deployments=[],
        check_summaries=[], backups_summary=None,
    )
    assert summary["degrading"] == []


def test_rebalance_suggestion_becomes_a_redeploy():
    summary = synthesize(
        machines={}, containers={}, activity_entries=[], alert_entries=[],
        deployments=[], check_summaries=[], backups_summary=None,
        rebalance_suggestions=[{
            "deployment_id": "d1", "name": "whoami", "from_node": "bigboy",
            "to_node": "nuc", "gain": 22.0, "reason": "bigboy is hot",
        }],
    )
    (move,) = summary["needs_action"]
    assert move["id"] == "rebalance:d1"
    assert move["action"]["url"] == "/api/deployments/d1/redeploy?node=nuc"
