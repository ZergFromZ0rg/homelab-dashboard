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
