from backend.service_activity_credentials import ServiceActivityCredentialStore


def test_starts_unconfigured(tmp_path):
    store = ServiceActivityCredentialStore(tmp_path / "creds.json")
    assert store.configured() == {"qbittorrent": False, "jellyfin": False}
    assert store.all() == {}


def test_set_full_credentials_marks_configured(tmp_path):
    store = ServiceActivityCredentialStore(tmp_path / "creds.json")
    fully_configured = store.set(
        "qbittorrent", {"username": "admin", "password": "secret"}
    )
    assert fully_configured is True
    assert store.configured()["qbittorrent"] is True
    assert store.all() == {"qbittorrent": {"username": "admin", "password": "secret"}}


def test_partial_credentials_are_not_configured(tmp_path):
    store = ServiceActivityCredentialStore(tmp_path / "creds.json")
    fully_configured = store.set("qbittorrent", {"username": "admin"})
    assert fully_configured is False
    assert store.configured()["qbittorrent"] is False


def test_set_merges_fields_not_replaces(tmp_path):
    store = ServiceActivityCredentialStore(tmp_path / "creds.json")
    store.set("qbittorrent", {"username": "admin"})
    store.set("qbittorrent", {"password": "secret"})
    assert store.all()["qbittorrent"] == {"username": "admin", "password": "secret"}


def test_blank_value_clears_just_that_field(tmp_path):
    store = ServiceActivityCredentialStore(tmp_path / "creds.json")
    store.set("qbittorrent", {"username": "admin", "password": "secret"})
    store.set("qbittorrent", {"password": ""})
    assert store.all()["qbittorrent"] == {"username": "admin"}
    assert store.configured()["qbittorrent"] is False


def test_clear_removes_the_whole_app(tmp_path):
    store = ServiceActivityCredentialStore(tmp_path / "creds.json")
    store.set("jellyfin", {"api_key": "key123"})
    store.clear("jellyfin")
    assert store.all() == {}
    assert store.configured()["jellyfin"] is False


def test_rejects_unknown_app(tmp_path):
    store = ServiceActivityCredentialStore(tmp_path / "creds.json")
    try:
        store.set("plex", {"token": "x"})
        assert False, "should have raised"
    except ValueError:
        pass


def test_persists_and_reloads(tmp_path):
    path = tmp_path / "creds.json"
    store = ServiceActivityCredentialStore(path)
    store.set("qbittorrent", {"username": "admin", "password": "secret"})
    store.set("jellyfin", {"api_key": "key123"})

    reloaded = ServiceActivityCredentialStore(path)
    assert reloaded.all() == {
        "qbittorrent": {"username": "admin", "password": "secret"},
        "jellyfin": {"api_key": "key123"},
    }


def test_bad_file_loads_empty(tmp_path):
    path = tmp_path / "creds.json"
    path.write_text("{ not json")
    assert ServiceActivityCredentialStore(path).all() == {}


def test_all_returns_a_copy_not_live_reference(tmp_path):
    store = ServiceActivityCredentialStore(tmp_path / "creds.json")
    store.set("qbittorrent", {"username": "admin", "password": "secret"})
    snapshot = store.all()
    snapshot["qbittorrent"]["password"] = "tampered"
    assert store.all()["qbittorrent"]["password"] == "secret"
