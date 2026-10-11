# Keeps pytest's rootdir at the repo root so `import backend.*` resolves
# the same way it does under `uvicorn backend.main:app`.

import pytest


@pytest.fixture(autouse=True)
def _isolated_passkeys(tmp_path, monkeypatch):
    """Every test starts with login off and its own auth file, so no test
    depends on (or writes) a real /data/auth.json."""
    from backend import passkeys

    monkeypatch.setattr(passkeys, "store", passkeys.PasskeyStore(tmp_path / "auth.json"))


@pytest.fixture(autouse=True)
def _isolated_audit_log(tmp_path, monkeypatch):
    """The audit log writes on every mutating request; keep it off /data."""
    from backend import audit_log

    monkeypatch.setattr(audit_log, "FILE", tmp_path / "audit.jsonl")


@pytest.fixture(autouse=True)
def _isolated_notify(tmp_path, monkeypatch):
    """Notification settings on a temp file; nothing ever reaches ntfy."""
    from backend import notify

    monkeypatch.setattr(notify, "FILE", tmp_path / "notify.json")


@pytest.fixture(autouse=True)
def _isolated_history_settings(tmp_path, monkeypatch):
    from backend import history_settings

    monkeypatch.setattr(history_settings, "FILE", tmp_path / "history.json")


@pytest.fixture(autouse=True)
def _isolated_capture_features(tmp_path, monkeypatch):
    """Saved captures and auto-capture settings on temp paths, and the in-memory
    registries the capture features keep emptied after *every* test.

    These are module-level, so one test's leftovers used to surface as alerts in
    unrelated Overview tests — far from the test that caused it. Doing it here, for
    all tests, means a test can't leak them whether or not it remembers to clean up.
    Only modules already imported are touched; nothing is imported for the purpose.
    """
    import sys

    store = sys.modules.get("backend.capture_store")
    auto = sys.modules.get("backend.autocapture")
    watch = sys.modules.get("backend.netwatch_api")
    if store:
        monkeypatch.setattr(store, "DIR", tmp_path / "captures")
    if auto:
        monkeypatch.setattr(auto, "FILE", tmp_path / "autocapture.json")
    yield
    if watch:
        watch._latest.clear()
    if auto:
        auto._busy.clear()
        auto._recent.clear()
        auto._last_for_check.clear()


@pytest.fixture(autouse=True)
def _isolated_speedtest(tmp_path, monkeypatch):
    """A speed test on a temp file that never touches the network, so no test
    can start a real one or leave a result behind."""
    from backend import speedtest

    def refuse():
        raise speedtest.SpeedTestError("no network in tests")

    monkeypatch.setattr(speedtest, "test", speedtest.SpeedTest(tmp_path / "speedtest.json", measure_fn=refuse))


@pytest.fixture(autouse=True)
def _isolated_gpu_history(tmp_path, monkeypatch):
    """GPU history on a temp file, emptied before and after every test."""
    from backend import gpu_history

    monkeypatch.setattr(gpu_history, "FILE", tmp_path / "gpu-history.json")
    gpu_history.reset()
    yield
    gpu_history.reset()
