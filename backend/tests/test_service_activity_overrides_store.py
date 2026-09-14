from backend.service_activity_overrides import ServiceActivityOverrideStore


def test_persists_and_reloads(tmp_path):
    path = tmp_path / "overrides.json"
    store = ServiceActivityOverrideStore(path)
    store.replace({"bigboy/torrent-box": "qbittorrent", "nas/media": "jellyfin"})

    reloaded = ServiceActivityOverrideStore(path)
    assert reloaded.all() == {
        "bigboy/torrent-box": "qbittorrent",
        "nas/media": "jellyfin",
    }


def test_replace_drops_invalid_entries(tmp_path):
    store = ServiceActivityOverrideStore(tmp_path / "overrides.json")
    result = store.replace(
        {
            "bigboy/x": "qbittorrent",
            "bigboy/y": "not-a-real-app",
            "  ": "jellyfin",
            42: "jellyfin",
            "nas/z": "NONE",
        }
    )
    assert result == {"bigboy/x": "qbittorrent", "nas/z": "none"}


def test_replace_only_writes_on_change(tmp_path):
    path = tmp_path / "overrides.json"
    store = ServiceActivityOverrideStore(path)
    store.replace({"a/b": "jellyfin"})
    mtime = path.stat().st_mtime_ns
    store.replace({"a/b": "jellyfin"})
    assert path.stat().st_mtime_ns == mtime


def test_caps_entry_count(tmp_path):
    store = ServiceActivityOverrideStore(tmp_path / "overrides.json")
    result = store.replace({f"h/c{i}": "jellyfin" for i in range(500)})
    assert len(result) == 200


def test_bad_file_loads_empty(tmp_path):
    path = tmp_path / "overrides.json"
    path.write_text("{ not json")
    assert ServiceActivityOverrideStore(path).all() == {}
