import time

from backend import autorebalance


def suggestion(dep_id, gain, to="cool", frm="hot"):
    return {
        "deployment_id": dep_id,
        "from_node": frm,
        "to_node": to,
        "gain": gain,
        "reason": "hot node",
        "image": "nginx",
        "name": None,
        "from_pressure": "CPU 92%",
        "to_score": 80.0,
        "here_score": 80.0 - gain,
    }


def record(dep_id, *, status="running", last_auto_move=None):
    return {"id": dep_id, "status": status, "last_auto_move": last_auto_move}


def test_gain_below_threshold_is_skipped(monkeypatch):
    monkeypatch.setattr(autorebalance, "MIN_GAIN", 30)
    monkeypatch.setattr(autorebalance, "MAX_PER_CYCLE", 5)
    moves = autorebalance.plan_moves(
        [suggestion("a", 20), suggestion("b", 45)],
        {"a": record("a"), "b": record("b")},
    )
    assert [m["deployment_id"] for m in moves] == ["b"]


def test_cooldown_blocks_recent_move(monkeypatch):
    monkeypatch.setattr(autorebalance, "MIN_GAIN", 10)
    monkeypatch.setattr(autorebalance, "COOLDOWN_SECONDS", 3600)
    monkeypatch.setattr(autorebalance, "MAX_PER_CYCLE", 5)
    now = time.time()
    moves = autorebalance.plan_moves(
        [suggestion("a", 50)],
        {"a": record("a", last_auto_move=now - 100)},
        now=now,
    )
    assert moves == []

    moves = autorebalance.plan_moves(
        [suggestion("a", 50)],
        {"a": record("a", last_auto_move=now - 7200)},
        now=now,
    )
    assert len(moves) == 1


def test_max_per_cycle_caps(monkeypatch):
    monkeypatch.setattr(autorebalance, "MIN_GAIN", 10)
    monkeypatch.setattr(autorebalance, "MAX_PER_CYCLE", 1)
    moves = autorebalance.plan_moves(
        [suggestion("a", 40), suggestion("b", 50)],
        {"a": record("a"), "b": record("b")},
    )
    # Highest gain first.
    assert [m["deployment_id"] for m in moves] == ["b"]


def test_non_running_deployment_skipped(monkeypatch):
    monkeypatch.setattr(autorebalance, "MIN_GAIN", 10)
    monkeypatch.setattr(autorebalance, "MAX_PER_CYCLE", 5)
    moves = autorebalance.plan_moves(
        [suggestion("a", 40)], {"a": record("a", status="failed")}
    )
    assert moves == []


def dep_record(dep_id, *, status="node_offline", kind="container", volumes=None, pinned=False, last_auto_move=None):
    return {
        "id": dep_id,
        "status": status,
        "kind": kind,
        "spec": {"volumes": volumes or [], "pinned": pinned},
        "last_auto_move": last_auto_move,
    }


def test_reschedule_picks_stranded_stateless_containers(monkeypatch):
    monkeypatch.setattr(autorebalance, "MAX_PER_CYCLE", 5)
    records = [
        dep_record("a"),
        dep_record("b", status="running"),          # not stranded
        dep_record("c", volumes=[{"source": "v", "target": "/v"}]),  # stateful
        dep_record("d", kind="stack", pinned=True),  # a stack
    ]
    chosen = [r["id"] for r in autorebalance.plan_reschedules(records)]
    assert chosen == ["a"]


def test_reschedule_respects_cooldown(monkeypatch):
    monkeypatch.setattr(autorebalance, "COOLDOWN_SECONDS", 3600)
    now = time.time()
    assert autorebalance.plan_reschedules(
        [dep_record("a", last_auto_move=now - 60)], now=now
    ) == []
    assert len(
        autorebalance.plan_reschedules(
            [dep_record("a", last_auto_move=now - 7200)], now=now
        )
    ) == 1


def test_enabled_flag(monkeypatch):
    monkeypatch.delenv("AUTO_REBALANCE", raising=False)
    assert autorebalance.enabled() is False
    monkeypatch.setenv("AUTO_REBALANCE", "true")
    assert autorebalance.enabled() is True
    monkeypatch.setenv("AUTO_REBALANCE", "0")
    assert autorebalance.enabled() is False
