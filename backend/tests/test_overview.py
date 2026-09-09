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
