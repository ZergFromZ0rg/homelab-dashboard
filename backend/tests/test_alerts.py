from backend.alerts import AlertMonitor


def machine(**kw):
    base = {"online": True, "agent_reachable": True, "cpu": 10.0, "ram": 20.0}
    base.update(kw)
    return base


def keys(events):
    return {(e["key"], e["status"]) for e in events}


def test_host_offline_fires_and_resolves_immediately():
    mon = AlertMonitor(breach_cycles=2)

    events = mon.poll({"nuc-1": machine(online=False)}, [])
    assert keys(events) == {("host:nuc-1:offline", "firing")}

    # Still offline -> no repeat event.
    assert mon.poll({"nuc-1": machine(online=False)}, []) == []

    events = mon.poll({"nuc-1": machine(online=True)}, [])
    assert keys(events) == {("host:nuc-1:offline", "resolved")}


def test_ram_alert_is_debounced():
    mon = AlertMonitor(breach_cycles=3)
    hot = {"nuc-1": machine(ram=95.0)}

    assert mon.poll(hot, []) == []          # 1st breach
    assert mon.poll(hot, []) == []          # 2nd breach
    events = mon.poll(hot, [])              # 3rd -> fire
    assert keys(events) == {("host:nuc-1:ram", "firing")}

    events = mon.poll({"nuc-1": machine(ram=40.0)}, [])
    assert keys(events) == {("host:nuc-1:ram", "resolved")}


def test_debounce_counter_resets_when_breach_clears():
    mon = AlertMonitor(breach_cycles=2)
    hot = {"nuc-1": machine(cpu=99.0)}
    cool = {"nuc-1": machine(cpu=10.0)}

    assert mon.poll(hot, []) == []
    assert mon.poll(cool, []) == []   # resets the counter
    assert mon.poll(hot, []) == []    # back to 1, not 2
    events = mon.poll(hot, [])
    assert keys(events) == {("host:nuc-1:cpu", "firing")}


def test_failed_deployment_fires():
    mon = AlertMonitor()
    deployments = [
        {"id": "d1", "status": "failed", "placed_on": "nuc-1",
         "spec": {"image": "nginx"}, "error": "pull failed"}
    ]
    events = mon.poll({"nuc-1": machine()}, deployments)
    assert keys(events) == {("deploy:d1", "firing")}
    assert "pull failed" in events[0]["message"]

    deployments[0]["status"] = "running"
    events = mon.poll({"nuc-1": machine()}, deployments)
    assert keys(events) == {("deploy:d1", "resolved")}


def test_agent_unreachable_but_host_up():
    mon = AlertMonitor()
    events = mon.poll({"nuc-1": machine(online=True, agent_reachable=False)}, [])
    assert keys(events) == {("host:nuc-1:agent", "firing")}


# --- disk / temperature / container / backup rules ---------------------------

from backend import alerts

NOW = 1_800_000_000.0


def fs(mount="/mnt/media", used=50.0, days=None, free=500e9):
    return {"device": "sda1", "mountpoint": mount, "used_percent": used,
            "days_until_full": days, "free_bytes": free}


def evaluate(machines, containers=None):
    return alerts.evaluate(machines, [], containers, now=NOW)


def test_disk_usage_warns_then_goes_critical():
    warn = evaluate({"nas": machine(filesystems=[fs(used=92)])})
    assert warn["host:nas:disk:/mnt/media"]["severity"] == "warn"

    crit = evaluate({"nas": machine(filesystems=[fs(used=98)])})
    assert crit["host:nas:disk:/mnt/media"]["severity"] == "bad"

    assert evaluate({"nas": machine(filesystems=[fs(used=80)])}) == {}


def test_disk_alert_names_the_free_space():
    alert = evaluate({"nas": machine(filesystems=[fs(used=95, free=2.2e12)])})[
        "host:nas:disk:/mnt/media"
    ]
    assert "95% full" in alert["message"] and "2200 GB free" in alert["message"]


def test_disk_fill_forecast_alerts_inside_the_window_only():
    soon = evaluate({"nas": machine(filesystems=[fs(used=60, days=5.4)])})
    alert = soon["host:nas:diskfull:/mnt/media"]
    assert alert["severity"] == "warn"
    assert "5 days" in alert["message"]

    imminent = evaluate({"nas": machine(filesystems=[fs(used=60, days=1.2)])})
    assert imminent["host:nas:diskfull:/mnt/media"]["severity"] == "bad"

    assert evaluate({"nas": machine(filesystems=[fs(days=30)])}) == {}
    assert evaluate({"nas": machine(filesystems=[fs(days=None)])}) == {}


def test_forecast_days_round_half_up_like_the_ui():
    alert = evaluate({"nas": machine(filesystems=[fs(used=60, days=6.5)])})[
        "host:nas:diskfull:/mnt/media"
    ]
    assert "about 7 days" in alert["message"]


def test_forecast_alert_is_debounced_but_full_disk_is_not():
    mon = AlertMonitor(breach_cycles=2)
    fills = {"nas": machine(filesystems=[fs(used=60, days=2)])}
    assert mon.poll(fills, []) == []                      # 1st look
    assert keys(mon.poll(fills, [])) == {("host:nas:diskfull:/mnt/media", "firing")}

    full = {"nas": machine(filesystems=[fs(used=99)])}
    assert keys(AlertMonitor(breach_cycles=2).poll(full, [])) == {
        ("host:nas:disk:/mnt/media", "firing")
    }


def test_cpu_and_gpu_temperature():
    hot = evaluate({"nas": machine(
        temperature=91,
        gpu={"devices": [{"name": "GTX 1650", "temperature_c": 88}, {"temperature_c": 40}]},
    )})
    assert hot["host:nas:temp"]["severity"] == "warn"
    assert "host:nas:gpu-temp:0" in hot and "host:nas:gpu-temp:1" not in hot
    assert evaluate({"nas": machine(temperature=60)}) == {}


def container(name="nextcloud", **kw):
    base = {"id": "c1", "name": name, "status": "running", "health": None,
            "restart_count": 0, "started_at": "2026-01-01T00:00:00.000000000Z"}
    base.update(kw)
    return base


def test_unhealthy_container_is_a_bad_issue():
    out = evaluate({"nuc": machine()}, {"nuc": [container(health="unhealthy")]})
    alert = out["container:nuc:nextcloud:unhealthy"]
    assert alert["severity"] == "bad"
    assert alert["host"] == "nuc"


def test_crash_loop_needs_recent_restarts_not_just_a_high_lifetime_count():
    from datetime import datetime, timezone

    just_now = datetime.fromtimestamp(NOW - 120, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.123456789Z")

    looping = evaluate({"nuc": machine()}, {"nuc": [container(restart_count=8, started_at=just_now)]})
    assert "container:nuc:nextcloud:restarting" in looping

    # 8 lifetime restarts, but it's been up since January: not a loop.
    calm = evaluate({"nuc": machine()}, {"nuc": [container(restart_count=8)]})
    assert calm == {}

    # Docker says it's mid-restart right now.
    assert "container:nuc:nextcloud:restarting" in evaluate(
        {"nuc": machine()}, {"nuc": [container(status="restarting")]}
    )


def test_never_started_container_does_not_crash_the_rules():
    zero = container(restart_count=9, started_at="0001-01-01T00:00:00Z")
    assert evaluate({"nuc": machine()}, {"nuc": [zero]}) == {}
    junk = container(restart_count=9, started_at="not a date")
    assert evaluate({"nuc": machine()}, {"nuc": [junk]}) == {}


def test_backup_failing_and_stale_alerts():
    failing = evaluate({"nas": machine(backup={"state": "failing", "last_error": "push rejected"})})
    assert failing["host:nas:backup"]["severity"] == "bad"
    assert "push rejected" in failing["host:nas:backup"]["message"]

    stale = evaluate({"nas": machine(backup={"state": "stale", "last_success_age": 50 * 3600})})
    assert stale["host:nas:backup"]["severity"] == "warn"
    assert "2 days" in stale["host:nas:backup"]["message"]

    for state in ("ok", "pending", "not_configured", "disabled", "unsupported", "unknown"):
        assert evaluate({"nas": machine(backup={"state": state})}) == {}
    assert evaluate({"nas": machine(backup=None)}) == {}


def test_container_and_backup_alerts_resolve_when_fixed():
    mon = AlertMonitor(breach_cycles=2)
    bad = {"nuc": [container(health="unhealthy")]}
    assert keys(mon.poll({"nuc": machine()}, [], bad)) == {
        ("container:nuc:nextcloud:unhealthy", "firing")
    }
    assert keys(mon.poll({"nuc": machine()}, [], {"nuc": [container()]})) == {
        ("container:nuc:nextcloud:unhealthy", "resolved")
    }
