"""The ways out of the Pi-hole data: Prometheus metrics (with a scrape token that
can do nothing else) and read-only tools for an agent."""

import time

import pytest
from fastapi.testclient import TestClient

from backend import auth, device_meta, device_names, main, network_alerts, network_context, passkeys, pihole, pihole_alerts
from backend.pihole_metrics import render

from test_pihole import make  # the fake Pi-hole these tests share

ROW = {"mac": "aa:bb:cc:00:00:01", "name": "Dad's phone", "kind": "personal", "ghost": "", "online": True,
       "queries_24h": 200, "blocked_24h": 50}


def metric_lines(text):
    return {line.split(" ")[0]: line.split(" ")[-1] for line in text.splitlines() if line and not line.startswith("#")}


def test_render_headline_numbers():
    snap = {"reachable": True, "updated_at": 1000.5, "summary": {"total": 200, "blocked": 50, "gravity_domains": 72000},
            "blocking": {"enabled": True}, "leases_total": 9}
    text = render(snap, [ROW], new=2)
    values = metric_lines(text)
    assert values["pihole_up"] == "1"
    assert values["pihole_queries_24h"] == "200" and values["pihole_blocked_24h"] == "50"
    assert values["pihole_block_ratio"] == "0.25"
    assert values["pihole_blocking_enabled"] == "1"
    assert values["pihole_dhcp_leases"] == "9"
    assert values["pihole_clients_online"] == "1" and values["pihole_new_devices"] == "2"
    assert "# TYPE pihole_queries_24h gauge" in text
    assert "_total" not in text  # these are a sliding window, never counters


def test_render_labels_each_device_by_name_and_mac():
    text = render({"reachable": True, "summary": {"total": 1, "blocked": 0}}, [ROW])
    assert 'pihole_device_queries_24h{name="Dad\'s phone",mac="aa:bb:cc:00:00:01",kind="personal"} 200' in text
    assert 'pihole_device_online{name="Dad\'s phone",mac="aa:bb:cc:00:00:01",kind="personal"} 1' in text
    assert "192.168" not in text  # no IPs: a moving lease would start a new series each time


def test_label_values_are_escaped():
    nasty = {**ROW, "name": 'a"b\\c\nd'}
    text = render({"reachable": True}, [nasty])
    assert 'name="a\\"b\\\\c\\nd"' in text
    assert all("\n" not in line for line in text.splitlines())


def test_unreachable_says_so_and_keeps_the_last_numbers():
    text = render({"reachable": False, "updated_at": 5, "summary": {"total": 10, "blocked": 1}}, [])
    values = metric_lines(text)
    assert values["pihole_up"] == "0" and values["pihole_queries_24h"] == "10"
    assert values["pihole_last_poll_timestamp_seconds"] == "5"


def test_hidden_rows_and_unknown_state_stay_out():
    ghost = {**ROW, "mac": "ee", "ghost": "stale"}
    switch = {**ROW, "mac": "ff", "name": "switch", "online": None, "queries_24h": None, "blocked_24h": None}
    text = render({"reachable": True}, [ROW, ghost, switch])
    assert 'mac="ee"' not in text
    assert 'pihole_device_online{name="switch"' not in text  # unknown, not "offline"
    assert 'pihole_device_queries_24h{name="switch"' not in text
    assert metric_lines(text)["pihole_clients_known"] == "2"


@pytest.fixture
def web(monkeypatch, tmp_path):
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(device_names, "names", device_names.NameStore(tmp_path / "n.json"))
    monkeypatch.setattr(device_meta, "meta", device_meta.MetaStore(tmp_path / "m.json"))
    monkeypatch.setattr(pihole_alerts, "known", pihole_alerts.KnownStore(tmp_path / "k.json"))
    monkeypatch.setattr(pihole_alerts, "_cache", None)
    collector, fake = make(monkeypatch)
    collector.refresh()
    # the fake Pi-hole's device was last seen at timestamp 2: make it a device that is here now
    collector._devices[0]["last_query"] = time.time() - 60
    collector._data["leases"][0]["expires"] = time.time() + 600
    monkeypatch.setattr(pihole, "collector", collector)
    client = TestClient(main.app)
    client.collector = collector
    return client


def test_metrics_route(web):
    reply = web.get("/api/pihole/metrics")
    assert reply.status_code == 200
    assert reply.headers["content-type"].startswith("text/plain; version=0.0.4")
    assert "pihole_up 1" in reply.text
    assert 'pihole_device_queries_24h{name="Dad\'s phone"' in reply.text


def test_metrics_404_when_pihole_is_not_connected(monkeypatch):
    monkeypatch.setattr(pihole, "collector", pihole.Pihole("", ""))
    assert TestClient(main.app).get("/api/pihole/metrics").status_code == 404


@pytest.fixture
def locked(web, monkeypatch):
    """Passkey login on, and a scrape token set."""
    monkeypatch.setattr(passkeys.store, "enabled", lambda: True)
    monkeypatch.setattr(auth, "METRICS_TOKEN", "scrape-secret")
    return web


def test_prometheus_can_scrape_with_its_token_only(locked):
    assert locked.get("/api/pihole/metrics").status_code == 401
    assert locked.get("/api/pihole/metrics", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert locked.get("/api/pihole/metrics", headers={"Authorization": "Basic scrape-secret"}).status_code == 401
    ok = locked.get("/api/pihole/metrics", headers={"Authorization": "Bearer scrape-secret"})
    assert ok.status_code == 200 and "pihole_up" in ok.text


def test_the_scrape_token_opens_nothing_else(locked):
    bearer = {"Authorization": "Bearer scrape-secret"}
    for path in ("/api/pihole", "/api/pihole/devices", "/api/agent/tools", "/api/nodes", "/api/audit"):
        assert locked.get(path, headers=bearer).status_code == 401, path
    assert locked.post("/api/pihole/blocking", json={"enabled": False}, headers=bearer).status_code == 401
    assert locked.post("/api/pihole/metrics", headers=bearer).status_code in (401, 405)
    assert locked.get("/api/pihole/metrics/", headers=bearer).status_code == 401


def test_no_scrape_token_set_means_no_scraping(web, monkeypatch):
    monkeypatch.setattr(passkeys.store, "enabled", lambda: True)
    monkeypatch.setattr(auth, "METRICS_TOKEN", "")
    assert web.get("/api/pihole/metrics", headers={"Authorization": "Bearer "}).status_code == 401
    assert web.get("/api/pihole/metrics", headers={"Authorization": "Bearer"}).status_code == 401


# --- the agent's tools -----------------------------------------------------------------


def test_tools_are_listed_in_tool_calling_shape(web):
    tools = web.get("/api/agent/tools").json()["tools"]
    assert [t["name"] for t in tools] == ["network_summary", "network_devices", "network_device", "network_alerts"]
    for tool in tools:
        assert tool["description"] and tool["input_schema"]["type"] == "object"
        assert "run" not in tool
        assert all(c.isalnum() or c in "_-" for c in tool["name"])  # tool names can't contain dots
    assert web.get("/api/agent/tools").json()["tools"][2]["input_schema"]["required"] == ["device"]


def test_summary(web):
    body = web.get("/api/agent/tools/network_summary").json()
    assert body["pihole"]["reachable"] is True
    assert body["queries_24h"] == 100 and body["blocked_24h"] == 8
    assert body["devices"]["known"] >= 1 and "online" in body["devices"]
    assert body["alerts"] == 0


def test_devices_and_filters(web):
    everyone = web.get("/api/agent/tools/network_devices").json()
    assert everyone["count"] == len(everyone["devices"]) >= 1
    phone = next(d for d in everyone["devices"] if d["mac"] == "aa:bb:cc:00:00:01")
    assert phone["name"] == "Dad's phone" and phone["online"] is True and phone["queries_24h"] == 50
    assert "ghost" not in phone and "groups" in phone
    servers = web.get("/api/agent/tools/network_devices?kind=server").json()["devices"]
    assert servers and all(d["kind"] == "server" for d in servers)  # bigboy, from the static lease
    online = web.get("/api/agent/tools/network_devices?online=true").json()["devices"]
    assert phone["mac"] in [d["mac"] for d in online] and all(d["online"] is True for d in online)
    offline = web.get("/api/agent/tools/network_devices?online=false").json()["devices"]
    assert phone["mac"] not in [d["mac"] for d in offline]


def test_one_device_by_name_or_mac_with_its_queries(web):
    by_name = web.get("/api/agent/tools/network_device?device=dad").json()
    assert by_name["device"]["mac"] == "aa:bb:cc:00:00:01"
    assert by_name["recent_queries"][0]["domain"] and len(by_name["recent_queries"]) <= 50
    assert by_name["top_blocked"][0]["domain"] == "mask.icloud.com"
    by_mac = web.get("/api/agent/tools/network_device?device=AA:BB:CC:00:00:01").json()
    assert by_mac["device"]["name"] == "Dad's phone"


def test_device_lookup_says_when_it_cannot_decide(web):
    assert "no device matches" in web.get("/api/agent/tools/network_device?device=zzz").json()["error"]
    assert "say which device" in web.get("/api/agent/tools/network_device").json()["error"]


def test_ambiguous_names_list_the_candidates(monkeypatch):
    rows = [{**ROW, "mac": "a", "name": "Fire TV 1", "ip": "1", "ghost": "", "new": False, "kind": "media"},
            {**ROW, "mac": "b", "name": "Fire TV 2", "ip": "2", "ghost": "", "new": False, "kind": "media"}]
    monkeypatch.setattr(pihole, "collector", pihole.Pihole("http://pi", "x"))
    monkeypatch.setattr(network_context, "_rows", lambda now=None: (rows, {}))
    result = network_context.device("fire")
    assert "matches 2 devices" in result["error"]
    assert [c["mac"] for c in result["candidates"]] == ["a", "b"]


def test_alerts_include_everything_the_dashboard_raises(web, monkeypatch):
    assert web.get("/api/agent/tools/network_alerts").json() == {"alerts": []}
    monkeypatch.setattr(network_alerts, "current", lambda: {
        "network:pihole-down": {"title": "Pi-hole is unreachable", "message": "m", "severity": "bad", "hint": "h"},
        "network:switch-down": {"title": "Switch is not answering SNMP", "message": "m2"},
    })
    alerts = web.get("/api/agent/tools/network_alerts").json()["alerts"]
    assert [(a["key"], a["severity"]) for a in alerts] == [("network:pihole-down", "bad"), ("network:switch-down", "warn")]
    assert web.get("/api/agent/tools/network_summary").json()["alerts"] == 2


def test_unknown_tool(web):
    assert web.get("/api/agent/tools/network_reboot").status_code == 404


def test_the_tools_cannot_change_anything(web):
    """Only GET exists on these routes, and no tool is wired to a change."""
    assert web.post("/api/agent/tools/network_summary").status_code == 405
    assert web.put("/api/agent/tools/network_summary").status_code == 405
    assert web.delete("/api/agent/tools/network_summary").status_code == 405
    web.get("/api/agent/tools/network_devices")
    web.get("/api/agent/tools/network_device?device=dad")


def test_not_connected_says_so_in_every_tool(monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(pihole, "collector", pihole.Pihole("", ""))
    client = TestClient(main.app)
    for name in ("network_summary", "network_devices", "network_device?device=x", "network_alerts"):
        assert "isn't connected" in client.get(f"/api/agent/tools/{name}").json()["error"], name
