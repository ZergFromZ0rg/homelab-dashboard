# Keeps pytest's rootdir at the repo root so `import backend.*` resolves
# the same way it does under `uvicorn backend.main:app`.

import pytest


@pytest.fixture(autouse=True)
def _isolated_passkeys(tmp_path, monkeypatch):
    """Every test starts with login off and its own auth file, so no test
    depends on (or writes) a real /data/auth.json."""
    from backend import passkeys

    monkeypatch.setattr(passkeys, "store", passkeys.PasskeyStore(tmp_path / "auth.json"))
