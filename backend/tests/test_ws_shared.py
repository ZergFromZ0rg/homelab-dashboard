"""Every open dashboard gets the same per-tick payload, built once — not
once per connection, which is what made the dashboard idle at ~15% CPU."""

from fastapi.testclient import TestClient

from backend import main


def test_two_dashboards_one_build_per_tick(monkeypatch):
    builds = []

    async def build():
        builds.append(1)
        return {"type": "dashboard_update", "n": len(builds)}

    monkeypatch.setattr(main, "_build_update", build)
    monkeypatch.setitem(main._tick, "payload", None)
    web = TestClient(main.app)

    with web.websocket_connect("/ws") as a, web.websocket_connect("/ws") as b:
        first_a = a.receive_json()
        first_b = b.receive_json()

    assert first_a == first_b == {"type": "dashboard_update", "n": 1}
    assert len(builds) == 1
