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
    found = by_key(cs.suggest(CONTAINERS, NODES, LAN, existing, {"host:thinkpad"}))
    assert set(found) == set()


def test_the_same_container_on_two_hosts_is_named_per_host():
    both = grouped([box("bigboy", "portainer", {"9000/tcp": ["9000"]}), box("thinkpad", "portainer", {"9000/tcp": ["9000"]})])
    names = sorted(i["name"] for i in cs.suggest(both, NODES, LAN, [], {"host:bigboy", "host:thinkpad"}))
    assert names == ["portainer (bigboy)", "portainer (thinkpad)"]
    # covering one leaves the other
    covered = [{"name": "p", "type": "http", "target": "http://192.168.0.10:9000"}]
    left = cs.suggest(both, NODES, LAN, covered, {"host:bigboy", "host:thinkpad"})
    assert [i["key"] for i in left] == ["container:thinkpad:portainer"]


def test_https_ports_use_https_and_skip_certificate_errors():
    item = cs.suggest(grouped([box("bigboy", "proxy", {"443/tcp": ["443"]})]), NODES, LAN, [], {"host:bigboy", "host:thinkpad"})[0]
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
