"""The one behaviour that makes backend/env.py worth having: a variable
that is set but empty (how `docker compose` passes `${VAR:-}`) falls back
to the default instead of raising or returning ""."""

import pytest

from backend.env import env_flag, env_float, env_int, env_str
from backend.jsonstore import read_json, write_json_atomic


@pytest.mark.parametrize("value", ["", "   "])
def test_empty_is_treated_as_unset(monkeypatch, value):
    monkeypatch.setenv("HL_TEST", value)
    assert env_str("HL_TEST", "fallback") == "fallback"
    assert env_float("HL_TEST", 8.0) == 8.0
    assert env_int("HL_TEST", 3) == 3
    assert env_flag("HL_TEST") is False


def test_values_parse(monkeypatch):
    monkeypatch.setenv("HL_TEST", "12.5")
    assert env_float("HL_TEST", 1) == 12.5
    assert env_int("HL_TEST", 1) == 12
    monkeypatch.setenv("HL_TEST", "  yes ")
    assert env_flag("HL_TEST") is True
    monkeypatch.setenv("HL_TEST", "garbage")
    assert env_float("HL_TEST", 7) == 7  # unparseable -> default


def test_jsonstore_roundtrip_and_bad_file(tmp_path):
    path = tmp_path / "nested" / "state.json"
    write_json_atomic(path, {"a": 1}, label="test")
    assert read_json(path, None) == {"a": 1}
    assert not path.with_suffix(".json.tmp").exists()

    path.write_text("{ not json")
    assert read_json(path, {"default": True}) == {"default": True}
