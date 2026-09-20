from backend.main import _overview


def _m(**kw):
    base = {"online": True, "agent_reachable": True, "cpu": 10.0, "ram": 20.0}
    base.update(kw)
    return base


def test_all_clear():
    ov = _overview({"nuc-1": _m()}, [], set())
    assert ov == {"ok": True, "issues": [], "recommendations": []}


def test_offline_host_is_a_bad_issue_with_a_recommendation():
    ov = _overview({"nuc-1": _m(online=False)}, [], set())
    assert ov["ok"] is False
    issue = next(i for i in ov["issues"] if i["key"].endswith(":offline"))
    assert issue["severity"] == "bad"
    assert any("unreachable" in r for r in ov["recommendations"])


def test_high_ram_is_a_warning():
    ov = _overview({"nuc-1": _m(ram=97.0)}, [], set())
    issue = next(i for i in ov["issues"] if i["key"].endswith(":ram"))
    assert issue["severity"] == "warn"
    assert any("Free memory on nuc-1" in r for r in ov["recommendations"])


def test_failed_deployment_and_stale_node():
    ov = _overview(
        {"nuc-1": _m()},
        [{"id": "d1", "status": "failed", "placed_on": "nuc-1",
          "spec": {"image": "x"}, "kind": "container"}],
        {"nuc-2"},
    )
    keys = {i["key"] for i in ov["issues"]}
    assert "deploy:d1" in keys
    assert "host:nuc-2:stale" in keys
    assert ov["ok"] is False


# --- the new rule families surface in the Attention panel --------------------


def _issue(ov, fragment):
    return next(i for i in ov["issues"] if fragment in i["key"])


def test_disk_and_forecast_show_up_with_their_own_severities():
    fs = [{"device": "sda1", "mountpoint": "/mnt/media", "used_percent": 98.0,
           "free_bytes": 1e11, "days_until_full": 1.0}]
    ov = _overview({"nas": _m(filesystems=fs)}, [], set())

    assert _issue(ov, ":disk:")["severity"] == "bad"
    assert _issue(ov, ":diskfull:")["severity"] == "bad"
    assert any("docker system prune" in r for r in ov["recommendations"])
    assert any("filling up" in r for r in ov["recommendations"])


def test_unhealthy_container_reaches_the_overview():
    ov = _overview(
        {"nuc": _m()}, [], set(),
        {"nuc": [{"id": "1", "name": "nextcloud", "status": "running",
                  "health": "unhealthy", "restart_count": 0}]},
    )
    issue = _issue(ov, "container:nuc:nextcloud:unhealthy")
    assert issue["severity"] == "bad"
    assert any("docker logs nextcloud" in r for r in ov["recommendations"])


def test_backup_and_temperature_recommendations():
    ov = _overview(
        {"nas": _m(temperature=95, backup={"state": "failing", "last_error": "x"})},
        [], set(),
    )
    assert _issue(ov, ":temp")["severity"] == "warn"
    assert any("BACKUP_REPO" in r for r in ov["recommendations"])
    assert any("fans" in r for r in ov["recommendations"])


def test_worst_issues_are_listed_first():
    ov = _overview(
        {"a": _m(ram=97.0), "b": _m(online=False)}, [], set(),
    )
    severities = [i["severity"] for i in ov["issues"]]
    assert severities == sorted(severities, key=lambda s: s != "bad")
    assert severities[0] == "bad"
