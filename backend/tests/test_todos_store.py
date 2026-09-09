from backend.todos import TodoStore


def _item(text, **kw):
    return {"id": kw.get("id", ""), "text": text, "done": kw.get("done", False)}


def test_persists_and_reloads(tmp_path):
    path = tmp_path / "todos.json"
    store = TodoStore(path)
    saved = store.replace([_item("buy disks"), _item("patch nuc", done=True)])
    assert [t["text"] for t in saved] == ["buy disks", "patch nuc"]
    assert saved[1]["done"] is True

    reloaded = TodoStore(path)
    assert [t["text"] for t in reloaded.all()] == ["buy disks", "patch nuc"]
    # ids are stable across the reload
    assert [t["id"] for t in reloaded.all()] == [t["id"] for t in saved]


def test_clean_drops_bad_rows_and_assigns_ids(tmp_path):
    store = TodoStore(tmp_path / "todos.json")
    out = store.replace(
        [
            "not a dict",
            {"text": "   "},
            {"text": "  real  "},
            {"text": "x" * 999},
        ]
    )
    assert [t["text"] for t in out] == ["real", "x" * 500]
    assert all(t["id"] for t in out)
    assert isinstance(out[0]["created_at"], float)


def test_duplicate_ids_are_reassigned(tmp_path):
    store = TodoStore(tmp_path / "todos.json")
    out = store.replace(
        [{"id": "dup", "text": "a"}, {"id": "dup", "text": "b"}]
    )
    assert out[0]["id"] != out[1]["id"]


def test_replace_only_writes_on_change(tmp_path):
    path = tmp_path / "todos.json"
    store = TodoStore(path)
    store.replace([{"id": "1", "text": "a", "created_at": 1.0}])
    mtime = path.stat().st_mtime_ns
    store.replace([{"id": "1", "text": "a", "created_at": 1.0}])
    assert path.stat().st_mtime_ns == mtime


def test_caps_list_length(tmp_path):
    store = TodoStore(tmp_path / "todos.json")
    out = store.replace([_item(f"t{i}") for i in range(500)])
    assert len(out) == 200


def test_bad_file_loads_empty(tmp_path):
    path = tmp_path / "todos.json"
    path.write_text("{ not json")
    assert TodoStore(path).all() == []
