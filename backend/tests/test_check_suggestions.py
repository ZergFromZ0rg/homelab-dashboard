import pytest
from fastapi.testclient import TestClient

from backend import auth, check_suggestions as cs, checks, checks_api, main
from backend.checks import CheckService, CheckStore, Result

NODES = {"bigboy": {"url": "http://100.72.0.9:8123"}, "thinkpad": {"url": "http://homelab-agent:8123"}}
LAN = {"bigboy": [{"iface": "eth0", "ip": "192.168.0.10", "mac": "aa"}], "thinkpad": [{"ip": "192.168.0.132"}]}


def box(host, name, ports=None, status="running"):
    return {"host": host, "name": name, "status": status, "ports": ports or {}}


def grouped(items):
    """The snapshot's shape: host -> list (the containers carry no host)."""
    out = {}
    for item in items:
        out.setdefault(item["host"], []).append({k: v for k, v in item.items() if k != "host"})
    return out


CONTAINERS = grouped([
    box("bigboy", "jellyfin", {"8096/tcp": ["8096"]}),
    box("bigboy", "qbittorrent", {"6881/tcp": ["6881"], "6881/udp": ["6881"], "8080/tcp": ["8080"]}),
    box("bigboy", "postgres", {"5432/tcp": ["5432"]}),
    box("bigboy", "internal-only"),
    box("bigboy", "stopped", {"9000/tcp": ["9000"]}, status="exited"),
    box("ghost", "nowhere", {"80/tcp": ["80"]}),
    box("thinkpad", "udp-only", {"53/udp": ["53"]}),
])


# The ping suggestions that need an agent (host pairs, internet); tests about
# hosts and containers set them aside.
NETWORK_KEYS = {"link:bigboy:thinkpad", "link:thinkpad:bigboy", "internet:1.1.1.1"}


def by_key(items):
    return {i["key"]: i for i in items}


def test_hosts_and_container_ports_are_suggested():
    found = by_key(cs.suggest(CONTAINERS, NODES, LAN, [], set()))
    assert found["host:bigboy"]["type"] == "ping" and found["host:bigboy"]["target"] == "192.168.0.10"
    assert found["host:thinkpad"]["target"] == "192.168.0.132"
    assert found["container:bigboy:jellyfin"]["type"] == "http"
    assert found["container:bigboy:jellyfin"]["target"] == "http://192.168.0.10:8096"
    # the web port wins over the torrent port
    assert found["container:bigboy:qbittorrent"]["target"] == "http://192.168.0.10:8080"
    assert found["container:bigboy:postgres"]["type"] == "tcp"
    assert found["container:bigboy:postgres"]["target"] == "192.168.0.10:5432"
    for skipped in ("internal-only", "stopped", "udp-only"):
        assert not [k for k in found if k.endswith(skipped)]
    assert not [k for k in found if "ghost" in k]


def test_falls_back_to_the_agent_url_host_without_lan_addresses():
    found = by_key(cs.suggest({}, NODES, {}, [], set()))
    assert found["host:bigboy"]["target"] == "100.72.0.9"


def test_existing_checks_and_dismissals_hide_suggestions():
    existing = [
        {"name": "Gateway", "type": "ping", "target": "192.168.0.10"},
        {"name": "Jelly", "type": "http", "target": "http://192.168.0.10:8096"},
        {"name": "pg", "type": "tcp", "target": "192.168.0.10:5432"},
        {"name": "q", "type": "tcp", "target": "bigboy:8080"},      # by host name, not LAN address
    ]
    found = by_key(cs.suggest(CONTAINERS, NODES, LAN, existing, {"host:thinkpad"} | NETWORK_KEYS))
    assert set(found) == set()


def test_the_same_container_on_two_hosts_is_named_per_host():
    both = grouped([box("bigboy", "portainer", {"9000/tcp": ["9000"]}), box("thinkpad", "portainer", {"9000/tcp": ["9000"]})])
    names = sorted(i["name"] for i in cs.suggest(both, NODES, LAN, [], {"host:bigboy", "host:thinkpad"} | NETWORK_KEYS))
    assert names == ["portainer (bigboy)", "portainer (thinkpad)"]
    # covering one leaves the other
    covered = [{"name": "p", "type": "http", "target": "http://192.168.0.10:9000"}]
    left = cs.suggest(both, NODES, LAN, covered, {"host:bigboy", "host:thinkpad"} | NETWORK_KEYS)
    assert [i["key"] for i in left] == ["container:thinkpad:portainer"]


def test_https_ports_use_https_and_skip_certificate_errors():
    item = cs.suggest(grouped([box("bigboy", "proxy", {"443/tcp": ["443"]})]), NODES, LAN, [], {"host:bigboy", "host:thinkpad"} | NETWORK_KEYS)[0]
    assert item["target"] == "https://192.168.0.10:443" and item["verify_tls"] is False


def test_accept_downgrades_a_website_that_errors_to_a_port_check(tmp_path, monkeypatch):
    def fake_probe(spec):
        return Result(False, None, "HTTP 401") if "8096" in spec["target"] else Result(True, 5.0, "HTTP 200")

    monkeypatch.setattr(checks, "probe", fake_probe)
    store = CheckStore(tmp_path / "checks.json")
    wanted = [s for s in cs.suggest(CONTAINERS, NODES, LAN, [], set()) if s["key"] in (
        "container:bigboy:jellyfin", "container:bigboy:qbittorrent", "host:bigboy")]
    created = cs.accept(store, wanted)
    kinds = {c["name"]: (c["type"], c["target"]) for c in created}
    assert kinds["jellyfin"] == ("tcp", "192.168.0.10:8096")
    assert kinds["qbittorrent"] == ("http", "http://192.168.0.10:8080")
    assert kinds["bigboy"] == ("ping", "192.168.0.10")


def test_dismissed_persist(tmp_path):
    path = tmp_path / "d.json"
    cs.Dismissed(path).add(["host:bigboy", 5])
    assert cs.Dismissed(path).all() == {"host:bigboy"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    service = CheckService(
        store=CheckStore(tmp_path / "checks.json"), history_path=tmp_path / "h.json",
        prober=lambda spec: Result(True, 1.0, "ok"),
    )
    monkeypatch.setattr(checks, "service", service)
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(cs, "dismissed", cs.Dismissed(tmp_path / "d.json"))
    monkeypatch.setattr(cs, "settle", lambda items: items)

    async def fake_update():
        return {"containers": CONTAINERS}

    monkeypatch.setattr(main, "shared_update", fake_update)
    monkeypatch.setattr("backend.registry.registry.all", lambda: NODES)
    monkeypatch.setattr("backend.lan_api.lan_nodes", lambda: {"nodes": LAN})
    return TestClient(main.app)


def test_api_suggest_accept_dismiss(client):
    keys = [s["key"] for s in client.get("/api/checks/suggestions").json()["suggestions"]]
    assert "host:bigboy" in keys and "container:bigboy:postgres" in keys

    client.post("/api/checks/suggestions/dismiss", json={"keys": ["host:thinkpad"]})
    created = client.post(
        "/api/checks/suggestions/accept", json={"keys": ["host:bigboy", "container:bigboy:postgres", "bogus"]}
    ).json()["created"]
    assert sorted(c["name"] for c in created) == ["bigboy", "postgres"]

    left = [s["key"] for s in client.get("/api/checks/suggestions").json()["suggestions"]]
    assert "host:bigboy" not in left and "host:thinkpad" not in left
    assert client.post("/api/checks/suggestions/accept", json={"keys": "x"}).status_code == 400


def test_accept_groups_containers_under_their_host_check(tmp_path, monkeypatch):
    monkeypatch.setattr(checks, "probe", lambda spec: Result(True, 1.0, "ok"))
    store = CheckStore(tmp_path / "checks.json")
    wanted = [s for s in cs.suggest(CONTAINERS, NODES, LAN, [], set()) if s["key"] in (
        "container:bigboy:postgres", "host:bigboy", "container:thinkpad:udp-only")]
    created = {c["name"]: c for c in cs.accept(store, wanted)}   # containers listed before their host
    assert created["bigboy"]["group"] == "Hosts" and created["bigboy"]["parent"] is None
    assert created["postgres"]["group"] == "bigboy"
    assert created["postgres"]["parent"] == created["bigboy"]["id"]


def test_accept_depends_on_an_existing_ping_check(tmp_path, monkeypatch):
    monkeypatch.setattr(checks, "probe", lambda spec: Result(True, 1.0, "ok"))
    store = CheckStore(tmp_path / "checks.json")
    gateway = store.create({"name": "bigboy box", "type": "ping", "target": "bigboy"})
    wanted = [s for s in cs.suggest(CONTAINERS, NODES, LAN, [gateway], {"host:thinkpad"}) if s["key"] == "container:bigboy:postgres"]
    (created,) = cs.accept(store, wanted)
    assert created["parent"] == gateway["id"]


GATEWAYS = {"bigboy": "192.168.0.1", "thinkpad": "192.168.0.1"}


def test_every_host_pair_gets_a_ping_from_one_agent_to_the_other():
    found = by_key(cs.suggest({}, NODES, LAN, [], set()))
    link = found["link:bigboy:thinkpad"]
    assert (link["type"], link["target"], link["origin"]) == ("ping", "192.168.0.132", "bigboy")
    assert link["group"] == "Between hosts" and link["name"] == "bigboy → thinkpad"
    assert found["link:thinkpad:bigboy"]["target"] == "192.168.0.10"
    assert "link:bigboy:bigboy" not in found


def test_a_pair_already_checked_from_that_agent_is_left_out_but_the_dashboards_own_ping_is_not_a_pair():
    existing = [{"name": "x", "type": "ping", "target": "thinkpad", "origin": "bigboy"}]
    found = by_key(cs.suggest({}, NODES, LAN, existing, set()))
    assert "link:bigboy:thinkpad" not in found and "link:thinkpad:bigboy" in found
    # a ping *from an agent* to bigboy doesn't count as the dashboard watching bigboy
    existing = [{"name": "x", "type": "ping", "target": "192.168.0.10", "origin": "thinkpad"}]
    assert "host:bigboy" in by_key(cs.suggest({}, NODES, LAN, existing, set()))


def test_one_router_suggestion_per_gateway_and_one_internet_ping():
    found = by_key(cs.suggest({}, NODES, LAN, [], set(), GATEWAYS))
    routers = [i for i in found.values() if i["key"].startswith("gateway:")]
    assert [(r["target"], r["origin"]) for r in routers] == [("192.168.0.1", "bigboy")]
    wan = found["internet:1.1.1.1"]
    assert (wan["target"], wan["origin"], wan["group"]) == ("1.1.1.1", "bigboy", "Network")


def test_a_second_router_is_suggested_and_existing_pings_hide_the_rest():
    gateways = {"bigboy": "192.168.0.1", "thinkpad": "10.0.0.1"}
    found = by_key(cs.suggest({}, NODES, LAN, [], set(), gateways))
    assert {"gateway:192.168.0.1", "gateway:10.0.0.1"} <= set(found)
    existing = [
        {"name": "wan", "type": "ping", "target": "1.1.1.1"},
        {"name": "gw", "type": "ping", "target": "192.168.0.1", "origin": "bigboy"},
    ]
    left = by_key(cs.suggest({}, NODES, LAN, existing, set(), gateways))
    assert "internet:1.1.1.1" not in left and "gateway:192.168.0.1" not in left and "gateway:10.0.0.1" in left


def test_no_gateway_known_still_suggests_the_internet_ping_from_the_first_host():
    found = by_key(cs.suggest({}, NODES, LAN, [], set()))
    assert not [k for k in found if k.startswith("gateway:")]
    assert found["internet:1.1.1.1"]["origin"] == "bigboy"


def test_accepting_pair_and_router_checks_keeps_their_origin_and_hangs_them_under_the_origin_host(tmp_path):
    store = CheckStore(tmp_path / "checks.json")
    items = cs.suggest({}, NODES, LAN, [], set(), GATEWAYS)
    wanted = [i for i in items if i["key"] in ("host:bigboy", "link:bigboy:thinkpad", "gateway:192.168.0.1")]
    made = {c["name"]: c for c in cs.accept(store, wanted)}
    assert made["bigboy → thinkpad"]["origin"] == "bigboy"
    assert made["bigboy → thinkpad"]["parent"] == made["bigboy"]["id"]
    assert made["Router 192.168.0.1"]["origin"] == "bigboy"
    assert made["bigboy"]["origin"] is None


def summary(cid, target, origin, latency=1.5, status="up", type="ping"):
    return {"id": cid, "type": type, "target": target, "origin": origin, "status": status,
            "latency_ms": latency, "p95_ms_24h": 3.0, "uptime_24h": 100.0, "detail": "reply"}


def test_the_matrix_reads_agent_pings_between_hosts_by_any_name_of_the_target():
    rows = [
        summary("a", "192.168.0.132", "bigboy", 0.8),
        summary("b", "bigboy", "thinkpad", 1.2),                 # by name
        summary("c", "1.1.1.1", "bigboy"),                          # not a host
        summary("d", "192.168.0.10", None),                          # from the dashboard
        summary("e", "192.168.0.10", "bigboy"),                      # a host to itself
        summary("f", "192.168.0.132:22", "bigboy", type="tcp"),      # not a ping
    ]
    out = cs.matrix(rows, NODES, LAN)
    assert out["hosts"] == ["bigboy", "thinkpad"]
    cells = {(c["from"], c["to"]): c for c in out["cells"]}
    assert set(cells) == {("bigboy", "thinkpad"), ("thinkpad", "bigboy")}
    assert cells[("bigboy", "thinkpad")]["latency_ms"] == 0.8 and cells[("bigboy", "thinkpad")]["id"] == "a"
    assert cells[("thinkpad", "bigboy")]["latency_ms"] == 1.2


def test_lan_nodes_reports_each_hosts_gateway_and_caches_briefly(monkeypatch):
    from backend import lan_api

    calls = []

    class Reply:
        ok = True

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    def fake_get(url, **_):
        calls.append(url)
        if "100.72.0.9" in url:
            return Reply({"addresses": [{"ip": "192.168.0.10"}], "gateway": "192.168.0.1"})
        return Reply({"addresses": [{"ip": "192.168.0.132"}]})  # an older agent: no gateway

    monkeypatch.setattr(lan_api.requests, "get", fake_get)
    monkeypatch.setattr(lan_api.registry, "all", lambda: NODES)
    monkeypatch.setattr(lan_api, "_identity_cache", None)
    out = lan_api.lan_nodes()
    assert out["gateways"] == {"bigboy": "192.168.0.1"}
    assert set(out["nodes"]) == {"bigboy", "thinkpad"}
    lan_api.lan_nodes()
    assert len(calls) == 2  # the second call came from the cache


def test_suggested_agent_pings_send_several_echoes_and_accepting_keeps_that(tmp_path):
    items = cs.suggest({}, NODES, LAN, [], set(), GATEWAYS)
    network = [i for i in items if i.get("origin")]
    assert network and all(i["count"] == 5 for i in network)
    limits = {i["key"].split(":")[0]: i["max_loss"] for i in network}
    assert limits == {"link": 10, "gateway": 10, "internet": 20}
    store = CheckStore(tmp_path / "checks.json")
    made = cs.accept(store, [i for i in items if i["key"] in ("link:bigboy:thinkpad", "internet:1.1.1.1")])
    assert {c["count"] for c in made} == {5} and {c["max_loss"] for c in made} == {10, 20}


def test_matrix_cells_carry_loss_and_jitter():
    row = summary("a", "192.168.0.132", "bigboy", 0.8) | {"loss_pct_3h": 20.0, "jitter_ms_3h": 0.4}
    cell = cs.matrix([row], NODES, LAN)["cells"][0]
    assert (cell["loss_pct_3h"], cell["jitter_ms_3h"]) == (20.0, 0.4)
