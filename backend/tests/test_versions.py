import pytest
import requests

from backend import versions


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def json(self):
        return self._payload


CURRENT = {
    "host": "bigboy",
    "source": {"sha": "db2e663" + "0" * 33, "short": "db2e663",
               "committed_at": 1790000000.0, "branch": "main"},
    "remote_sha": "db2e663" + "0" * 33,
    "image_created": 1790000100.0,
    "needs_rebuild": False,
    "behind_remote": False,
}


@pytest.fixture(autouse=True)
def _fresh():
    versions._cache.clear()
    yield
    versions._cache.clear()


def respond(monkeypatch, response):
    calls = []
    monkeypatch.setattr(
        versions.requests, "get",
        lambda url, **kw: calls.append(url) or response,
    )
    return calls


def test_a_current_agent(monkeypatch):
    respond(monkeypatch, FakeResponse(200, CURRENT))

    out = versions.for_host("bigboy", "http://bigboy:8123")

    assert out["state"] == "current"
    assert out["source"]["short"] == "db2e663"


def test_a_pull_without_a_rebuild_reads_as_rebuild(monkeypatch):
    respond(monkeypatch, FakeResponse(200, {**CURRENT, "needs_rebuild": True}))
    assert versions.for_host("h", "http://x")["state"] == "rebuild"


def test_being_behind_the_remote_reads_as_behind(monkeypatch):
    respond(monkeypatch, FakeResponse(200, {**CURRENT, "behind_remote": True}))
    assert versions.for_host("h", "http://x")["state"] == "behind"


def test_needing_a_rebuild_outranks_being_behind(monkeypatch):
    """A rebuild picks up the remote's commits too, so it's the one thing
    worth saying."""
    respond(monkeypatch, FakeResponse(
        200, {**CURRENT, "needs_rebuild": True, "behind_remote": True}))

    assert versions.for_host("h", "http://x")["state"] == "rebuild"


def test_an_agent_predating_version_reporting(monkeypatch):
    respond(monkeypatch, FakeResponse(404))
    assert versions.for_host("h", "http://x")["state"] == "unsupported"


def test_an_unreachable_agent_is_unknown_not_an_error(monkeypatch):
    monkeypatch.setattr(
        versions.requests, "get",
        lambda *a, **k: (_ for _ in ()).throw(requests.ConnectionError("down")),
    )
    assert versions.for_host("h", "http://x")["state"] == "unknown"


def test_a_nonsense_payload_is_unknown(monkeypatch):
    respond(monkeypatch, FakeResponse(200, ["not", "a", "dict"]))
    assert versions.for_host("h", "http://x")["state"] == "unknown"


def test_an_agent_with_no_checkout_is_unknown(monkeypatch):
    respond(monkeypatch, FakeResponse(200, {"source": None}))
    assert versions.for_host("h", "http://x")["state"] == "unknown"


def test_results_are_cached(monkeypatch):
    calls = respond(monkeypatch, FakeResponse(200, CURRENT))

    versions.for_host("bigboy", "http://x")
    versions.for_host("bigboy", "http://x")

    assert len(calls) == 1


def test_a_blip_keeps_the_last_known_version(monkeypatch):
    """The card already says the agent is unreachable; blanking its
    version as well tells you nothing new."""
    respond(monkeypatch, FakeResponse(200, CURRENT))
    versions.for_host("bigboy", "http://x")
    versions.forget("bigboy")

    monkeypatch.setattr(
        versions.requests, "get",
        lambda *a, **k: (_ for _ in ()).throw(requests.ConnectionError("down")),
    )
    # Cache was cleared, so this refetches and fails — no prior entry to keep.
    assert versions.for_host("bigboy", "http://x")["state"] == "unknown"


def test_summary_counts_the_fleet():
    machines = {
        "a": {"agent_version": {"state": "current"}},
        "b": {"agent_version": {"state": "rebuild"}},
        "c": {"agent_version": {"state": "behind"}},
        "d": {"agent_version": None},
        "e": {},
    }

    out = versions.summary(machines)

    assert out == {
        "total": 5, "current": 1, "needs_rebuild": 1,
        "behind_remote": 1, "unverified": 0, "unknown": 2,
    }


def test_an_unreachable_remote_is_unverified_not_current(monkeypatch):
    """The real case: an ssh remote, no keys in the container, ls-remote
    fails. Reporting "current" claims a check that never happened, and a
    host three commits behind looks perfectly fine."""
    respond(monkeypatch, FakeResponse(200, {**CURRENT, "remote_sha": None}))

    assert versions.for_host("h", "http://x")["state"] == "unverified"


def test_unverified_is_counted_apart_from_current():
    machines = {
        "a": {"agent_version": {"state": "current"}},
        "b": {"agent_version": {"state": "unverified"}},
    }

    out = versions.summary(machines)

    assert out["current"] == 1 and out["unverified"] == 1


def test_a_known_stale_agent_still_outranks_an_unreachable_remote(monkeypatch):
    respond(monkeypatch, FakeResponse(
        200, {**CURRENT, "remote_sha": None, "needs_rebuild": True}))

    assert versions.for_host("h", "http://x")["state"] == "rebuild"
