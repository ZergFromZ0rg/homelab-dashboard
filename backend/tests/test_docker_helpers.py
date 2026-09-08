"""Unit tests for the agent HTTP helpers in backend/docker.py."""

import time

import pytest
import requests

from backend import docker as agent_http


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError("should not be reached in these cases")


@pytest.fixture(autouse=True)
def _clear_agent_cache():
    agent_http._LAST_GOOD.clear()
    agent_http._LAST_UNREACHABLE_LOG.clear()
    yield
    agent_http._LAST_GOOD.clear()


def _snapshot(containers, gpu):
    return FakeResponse(200, {"containers": containers, "gpu": gpu, "updated_at": 1})


def test_get_host_data_serves_last_good_through_a_hiccup(monkeypatch):
    calls = []

    def fake_get(url, timeout):
        calls.append(1)
        if len(calls) == 1:
            return _snapshot([{"id": "a"}], {"name": "RTX 3060"})
        raise requests.ConnectionError("boom")

    monkeypatch.setattr(agent_http.requests, "get", fake_get)

    _, first = agent_http.get_host_data("nuc-1", "http://nuc-1:9000")
    assert first["reachable"] is True and first.get("stale") is None

    _, second = agent_http.get_host_data("nuc-1", "http://nuc-1:9000")
    assert second["reachable"] is True
    assert second["stale"] is True
    assert second["gpu"] == {"name": "RTX 3060"}
    assert second["containers"] == [{"id": "a"}]


def test_get_host_data_gives_up_after_grace_window(monkeypatch):
    monkeypatch.setattr(
        agent_http.requests, "get",
        lambda *a, **k: (_ for _ in ()).throw(requests.ConnectionError("boom")),
    )
    agent_http._LAST_GOOD["nuc-1"] = {
        "containers": [{"id": "a"}], "gpu": {"name": "x"},
        "updated_at": 1, "reachable": True,
        "at": time.time() - agent_http.STALE_GRACE_SECONDS - 1,
    }

    _, data = agent_http.get_host_data("nuc-1", "http://nuc-1:9000")
    assert data["reachable"] is False
    assert data["gpu"] is None
    assert data["containers"] == []


def test_deploy_container_maps_old_agent_404(monkeypatch):
    monkeypatch.setattr(
        agent_http.requests,
        "post",
        lambda *a, **k: FakeResponse(404, {"detail": "Not Found"}),
    )
    result = agent_http.deploy_container(
        {"nuc-1": {"url": "http://nuc-1:9000"}}, "nuc-1", {"image": "nginx"}
    )
    assert result["success"] is False
    assert "POST /containers" in result["error"]


def test_deploy_container_passes_through_policy_rejection(monkeypatch):
    monkeypatch.setattr(
        agent_http.requests,
        "post",
        lambda *a, **k: FakeResponse(
            400, {"success": False, "error": "bad path", "stage": "policy"}
        ),
    )
    result = agent_http.deploy_container(
        {"nuc-1": {"url": "http://nuc-1:9000"}}, "nuc-1", {"image": "nginx"}
    )
    assert result == {"success": False, "error": "bad path", "stage": "policy"}


def test_deploy_container_unknown_host():
    try:
        agent_http.deploy_container({}, "ghost", {"image": "nginx"})
    except ValueError as error:
        assert "Unknown host" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_agent_spec_payload_shape():
    payload = agent_http.agent_spec_payload(
        {
            "image": "nginx:latest",
            "name": "web",
            "env": {"A": "1"},
            "ports": [{"container": 80, "host": 8080}],
            "volumes": [{"source": "v", "target": "/v"}],
            "restart_policy": "always",
            "resources": {"cpus": 1.5, "memory_mb": 512},
        }
    )
    assert payload["ports"] == [{"container": 80, "host": 8080, "proto": "tcp"}]
    assert payload["volumes"] == [
        {"source": "v", "target": "/v", "read_only": False}
    ]
    assert payload["labels"] == {"deployed-by": "homelab-dashboard"}
    assert payload["pull"] is True
