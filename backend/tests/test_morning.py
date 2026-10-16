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


def _repo(state="behind", dirty=False):
    return {
        "owner": "ZergFromZ0rg", "name": "ai-librarian", "branch": "main",
        "short": "f4ef1c4", "remote_short": "22ee733", "state": state, "dirty": dirty,
    }


def _project_containers(**over):
    base = {"compose_project": "ai-librarian", "rebuild": {"project": "ai-librarian", "can_pull": True}, "repo": _repo()}
    return [
        {"name": "ai-librarian-ui-1", **base, **over},
        {"name": "ai-librarian-qdrant-1", **base, **over},
    ]


def _actions(containers):
    return synthesize(
        machines={"bigboy": {}}, containers={"bigboy": containers}, activity_entries=[],
        alert_entries=[], deployments=[], check_summaries=[], backups_summary=None,
    )["needs_action"]


def test_a_project_behind_github_is_one_item_with_a_pull_and_redeploy():
    items = [a for a in _actions(_project_containers()) if a["type"] == "repo_updates"]
    assert len(items) == 1
    item = items[0]
    assert item["id"] == "repo_updates:bigboy:ai-librarian"
    assert item["title"] == "ai-librarian has new commits on GitHub"
    assert "f4ef1c4 → 22ee733" in item["subtitle"]
    assert item["button_label"] == "Pull & redeploy"
    assert item["action"]["url"] == "/api/rebuild/bigboy"
    assert item["action"]["body"] == {"container": "ai-librarian-qdrant-1", "pull": True}
    assert "ZergFromZ0rg/ai-librarian" in item["action"]["confirm"]


def test_uncommitted_changes_on_the_host_are_said_before_the_pull():
    item = next(a for a in _actions(_project_containers(repo=_repo(dirty=True))) if a["type"] == "repo_updates")
    assert "uncommitted" in item["subtitle"]
    assert "uncommitted" in item["action"]["confirm"]


@pytest.mark.parametrize("state", ["up_to_date", "ahead", "unknown", "checking"])
def test_a_repo_that_is_not_behind_asks_for_nothing(state):
    assert not [a for a in _actions(_project_containers(repo=_repo(state))) if a["type"] == "repo_updates"]


def test_without_a_rebuild_target_there_is_no_button_to_offer():
    assert not [a for a in _actions(_project_containers(rebuild=None)) if a["type"] == "repo_updates"]
