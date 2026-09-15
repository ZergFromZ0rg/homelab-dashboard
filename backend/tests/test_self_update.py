"""self_update launches a separate short-lived container (via the Docker
socket) to git-pull and rebuild/restart dashboard-api + dashboard-web —
it never runs those commands in its own process, which would get killed
mid-command when its own container is recreated."""

import pytest
from docker.errors import NotFound

from backend import self_update as su


class FakeContainer:
    def __init__(self, running=True, exit_code=None, logs=b""):
        self.running = running
        self.exit_code = exit_code
        self._logs = logs
        self.removed_force = None

    def reload(self):
        pass

    @property
    def attrs(self):
        return {"State": {"Running": self.running, "ExitCode": self.exit_code}}

    def logs(self, tail=200):
        return self._logs

    def remove(self, force=False):
        self.removed_force = force


class FakeContainers:
    def __init__(self):
        self._store = {}
        self.run_calls = []

    def get(self, name):
        if name not in self._store:
            raise NotFound("no such container")
        return self._store[name]

    def run(self, image, command, **kwargs):
        self.run_calls.append({"image": image, "command": command, **kwargs})
        container = FakeContainer(running=True, exit_code=None)
        self._store[kwargs["name"]] = container
        return container


class FakeClient:
    def __init__(self, ping_ok=True):
        self.containers = FakeContainers()
        self._ping_ok = ping_ok

    def ping(self):
        if not self._ping_ok:
            raise su.DockerException("no socket")
        return True


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.setattr(su, "HOST_REPO_PATH", "/srv/homelab-dashboard")
    yield


def test_status_unavailable_when_host_repo_path_unset(monkeypatch):
    monkeypatch.setattr(su, "HOST_REPO_PATH", "")
    result = su.status()
    assert result == {
        "available": False,
        "state": "unavailable",
        "reason": "HOST_REPO_PATH isn't set",
    }


def test_status_unavailable_when_docker_unreachable(monkeypatch):
    monkeypatch.setattr(su, "docker", type("M", (), {"from_env": lambda: FakeClient(ping_ok=False)}))
    result = su.status()
    assert result["available"] is False
    assert result["state"] == "unavailable"


def test_status_none_when_never_run(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(su, "docker", type("M", (), {"from_env": lambda: client}))
    assert su.status() == {"available": True, "state": "none"}


def test_status_running(monkeypatch):
    client = FakeClient()
    client.containers._store[su.CONTAINER_NAME] = FakeContainer(running=True, exit_code=None)
    monkeypatch.setattr(su, "docker", type("M", (), {"from_env": lambda: client}))
    result = su.status()
    assert result["available"] is True
    assert result["state"] == "running"


def test_status_succeeded(monkeypatch):
    client = FakeClient()
    client.containers._store[su.CONTAINER_NAME] = FakeContainer(
        running=False, exit_code=0, logs=b"done"
    )
    monkeypatch.setattr(su, "docker", type("M", (), {"from_env": lambda: client}))
    result = su.status()
    assert result == {"available": True, "state": "succeeded", "exit_code": 0, "log": "done"}


def test_status_failed(monkeypatch):
    client = FakeClient()
    client.containers._store[su.CONTAINER_NAME] = FakeContainer(
        running=False, exit_code=1, logs=b"git pull failed"
    )
    monkeypatch.setattr(su, "docker", type("M", (), {"from_env": lambda: client}))
    result = su.status()
    assert result["state"] == "failed"
    assert result["exit_code"] == 1
    assert "git pull failed" in result["log"]


def test_trigger_raises_when_host_repo_path_unset(monkeypatch):
    monkeypatch.setattr(su, "HOST_REPO_PATH", "")
    with pytest.raises(RuntimeError, match="HOST_REPO_PATH"):
        su.trigger()


def test_trigger_raises_when_docker_unreachable(monkeypatch):
    monkeypatch.setattr(su, "docker", type("M", (), {"from_env": lambda: FakeClient(ping_ok=False)}))
    with pytest.raises(RuntimeError, match="Docker socket"):
        su.trigger()


def test_trigger_launches_updater_with_expected_volumes(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(su, "docker", type("M", (), {"from_env": lambda: client}))

    result = su.trigger()

    assert result == {"started": True}
    assert len(client.containers.run_calls) == 1
    call = client.containers.run_calls[0]
    assert call["name"] == su.CONTAINER_NAME
    assert call["working_dir"] == "/repo"
    assert call["volumes"] == {
        "/var/run/docker.sock": {"bind": "/var/run/docker.sock", "mode": "rw"},
        "/srv/homelab-dashboard": {"bind": "/repo", "mode": "rw"},
    }
    assert call["detach"] is True
    assert "git pull" in call["command"][-1]
    assert "docker compose build" in call["command"][-1]
    assert "docker compose up -d" in call["command"][-1]


def test_trigger_removes_a_previous_run_first(monkeypatch):
    client = FakeClient()
    old = FakeContainer(running=False, exit_code=0)
    client.containers._store[su.CONTAINER_NAME] = old
    monkeypatch.setattr(su, "docker", type("M", (), {"from_env": lambda: client}))

    su.trigger()

    assert old.removed_force is True
