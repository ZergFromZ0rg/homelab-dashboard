"""Unit tests for the agent HTTP helpers in backend/docker.py."""

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
