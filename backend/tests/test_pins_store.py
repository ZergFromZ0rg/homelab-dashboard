from backend.pins import PinStore


def test_persists_and_reloads(tmp_path):
    path = tmp_path / "pins.json"
    store = PinStore(path)
    store.replace(["nas/plex", "nuc-1/grafana"])

    reloaded = PinStore(path)
    assert reloaded.all() == ["nas/plex", "nuc-1/grafana"]


def test_replace_cleans_input(tmp_path):
    store = PinStore(tmp_path / "pins.json")
    result = store.replace(
        ["nas/plex", "nas/plex", "  ", 42, "nas/plex", "nuc-1/x "]
    )
    assert result == ["nas/plex", "nuc-1/x"]


def test_replace_only_writes_on_change(tmp_path):
    path = tmp_path / "pins.json"
    store = PinStore(path)
    store.replace(["a/b"])
    mtime = path.stat().st_mtime_ns
    store.replace(["a/b"])
    assert path.stat().st_mtime_ns == mtime


def test_caps_pin_count(tmp_path):
    store = PinStore(tmp_path / "pins.json")
    result = store.replace([f"h/c{i}" for i in range(500)])
    assert len(result) == 200


def test_bad_file_loads_empty(tmp_path):
    path = tmp_path / "pins.json"
    path.write_text("{ not json")
    assert PinStore(path).all() == []
