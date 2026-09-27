"""Which host the dashboard runs on — and that the backup code, which asks
lazily at call time, can still find out (it once imported this from
main.py by a name that moved)."""

from backend import docker, hosts, volume_backup_api


def test_detects_its_own_host_by_container_id(monkeypatch):
    monkeypatch.setattr(hosts, "SELF_CONTAINER_ID", "abc123def456")
    data = {
        "bigboy": {"containers": [{"id": "999"}]},
        "thinkpad": {"containers": [{"id": "abc123def456789"}]},
    }
    assert hosts.detect_main_host(data) == "thinkpad"
    monkeypatch.setattr(hosts, "SELF_CONTAINER_ID", "")
    assert hosts.detect_main_host(data) is None


def test_backups_default_to_the_dashboards_host(monkeypatch):
    monkeypatch.setattr(hosts, "MAIN_HOST_OVERRIDE", None)
    monkeypatch.setattr(hosts, "SELF_CONTAINER_ID", "abc")
    monkeypatch.setattr(docker, "get_all_containers", lambda nodes: {"thinkpad": {"containers": [{"id": "abc"}]}})
    assert volume_backup_api.default_dest_host() == "thinkpad"
