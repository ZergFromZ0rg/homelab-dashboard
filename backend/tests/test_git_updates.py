from unittest.mock import Mock

import pytest
import requests
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend import audit_log, auth, git_updates, main


PROJECT = {"id": "abc123", "project": "dashboard", "enabled": False}


def response(status=200, body=None):
    return Mock(status_code=status, json=Mock(return_value=body))


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "")
    monkeypatch.setattr(main.registry, "all", lambda: {"box": {"url": "http://box:8123/"}})
    return TestClient(main.app)


def test_discovery_keeps_available_projects_when_other_hosts_fail(monkeypatch):
    def request(method, url, **kwargs):
        assert method == "GET"
        assert kwargs["timeout"] == git_updates.TIMEOUT
        if "old" in url:
            return response(404, {"detail": "Not Found"})
        if "offline" in url:
            raise requests.ConnectionError("secret URL must not be shown")
        return response(body={"enabled": True, "poll_seconds": 15, "projects": [PROJECT]})

    monkeypatch.setattr(git_updates.requests, "request", request)
    nodes = {host: {"url": f"http://{host}"} for host in ("old", "box", "offline")}
    hosts = git_updates.discover(nodes)["hosts"]
    assert [h["host"] for h in hosts] == ["box", "offline", "old"]
    assert hosts[0]["projects"] == [PROJECT]
    assert hosts[0]["enabled"] and hosts[0]["available"]
    assert hosts[1]["status_code"] == 502 and "secret" not in hosts[1]["error"]
    assert hosts[2]["status_code"] == 501 and "Update" in hosts[2]["error"]


@pytest.mark.parametrize("body", [None, [], {"projects": None}, {"projects": ["bad"]}])
def test_bad_agent_response_is_reported_per_host(monkeypatch, body):
    monkeypatch.setattr(git_updates.requests, "request", lambda *a, **k: response(body=body))
    result = git_updates.for_host("box", {"url": "http://box"})
    assert not result["available"] and result["status_code"] == 502


def test_empty_fleet_does_not_request_anything(monkeypatch):
    request = Mock()
    monkeypatch.setattr(git_updates.requests, "request", request)
    assert git_updates.discover({}) == {"hosts": []}
    request.assert_not_called()


def test_toggle_forwards_only_selection_and_agent_auth(client, monkeypatch):
    request = Mock(return_value=response(body={**PROJECT, "enabled": True}))
    monkeypatch.setattr(git_updates.requests, "request", request)
    monkeypatch.setattr(git_updates, "agent_headers", lambda: {"X-Agent-Token": "agent-secret"})
    result = client.put("/api/git-updates/box/abc123", json={"enabled": True})
    assert result.status_code == 200 and result.json()["enabled"]
    args, kwargs = request.call_args
    assert args == ("PUT", "http://box:8123/git-updates/abc123")
    assert kwargs["json"] == {"enabled": True}
    assert kwargs["headers"] == {"X-Agent-Token": "agent-secret"}


@pytest.mark.parametrize("payload", [{}, {"enabled": "false"}, {"enabled": 1}, {"enabled": None}, {"enabled": True, "path": "/evil"}])
def test_toggle_requires_a_real_boolean_and_no_extra_fields(client, monkeypatch, payload):
    request = Mock()
    monkeypatch.setattr(git_updates.requests, "request", request)
    assert client.put("/api/git-updates/box/abc123", json=payload).status_code == 400
    request.assert_not_called()


def test_unknown_host_or_invalid_project_cannot_be_targeted(client, monkeypatch):
    request = Mock()
    monkeypatch.setattr(git_updates.requests, "request", request)
    assert client.put("/api/git-updates/ghost/abc123", json={"enabled": True}).status_code == 404
    assert client.put("/api/git-updates/box/not%20an%20id", json={"enabled": True}).status_code == 400
    request.assert_not_called()


def test_discovery_and_toggle_require_dashboard_auth(client, monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN", "secret")
    request = Mock(return_value=response(body={"enabled": True, "projects": []}))
    monkeypatch.setattr(git_updates.requests, "request", request)
    assert client.get("/api/git-updates").status_code == 401
    assert client.put("/api/git-updates/box/abc123", json={"enabled": True}).status_code == 401
    request.assert_not_called()
    assert client.get("/api/git-updates", headers={"X-Register-Token": "secret"}).status_code == 200


def test_toggle_requires_step_up_before_contacting_agent(client, monkeypatch):
    def refuse():
        raise HTTPException(status_code=403, detail={"elevate": True})

    monkeypatch.setattr(auth, "require_elevated", refuse)
    request = Mock()
    monkeypatch.setattr(git_updates.requests, "request", request)
    result = client.put("/api/git-updates/box/abc123", json={"enabled": True})
    assert result.status_code == 403 and result.json()["detail"]["elevate"]
    request.assert_not_called()


def test_agent_refusal_is_visible_and_disabling_is_forwarded(client, monkeypatch):
    request = Mock(return_value=response(403, {"detail": "set REBUILD_ENABLED=1"}))
    monkeypatch.setattr(git_updates.requests, "request", request)
    result = client.put("/api/git-updates/box/abc123", json={"enabled": False})
    assert result.status_code == 403 and result.json()["detail"] == "set REBUILD_ENABLED=1"
    assert request.call_args.kwargs["json"] == {"enabled": False}


def test_selection_change_is_identifiable_in_audit_log():
    assert audit_log.describe("PUT", "/api/git-updates/box/abc123") == (
        "automatic repository updates changed", "box",
    )
