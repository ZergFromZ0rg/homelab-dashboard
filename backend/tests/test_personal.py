import pytest
import requests
from fastapi.testclient import TestClient

from backend import main, personal

WEATHER_JSON = {
    "timezone": "America/Toronto",
    "current": {
        "temperature_2m": 17.14,
        "apparent_temperature": 15.6,
        "relative_humidity_2m": 63,
        "weather_code": 3,
        "wind_speed_10m": 15.1,
        "is_day": 1,
    },
    "daily": {
        "time": ["2026-09-19", "2026-09-20"],
        "weather_code": [3, 61],
        "temperature_2m_max": [18.6, 21.2],
        "temperature_2m_min": [9.2, 11.0],
        "precipitation_probability_max": [8, 70],
    },
}

WOTD_ENTRY = """
<div class="mw-parser-output"><style>.x{color:red}</style>
<table><tbody><tr><td><b><a href="/wiki/supernova#English"><span id="WOTD-rss-title">supernova</span></a></b> <i>n</i></td></tr>
<tr><td><div id="WOTD-rss-description">
<ol><li><span>(<a href="/wiki/astronomy">astronomy</a>)</span> A <a href="/wiki/bright">bright</a> explosion of a star.
<ul><li>An example quotation that must be skipped.</li></ul></li>
<li>(figurative) Something brilliant.</li></ol>
</div></td></tr></tbody></table>
<ol><li>Unrelated list after the description.</li></ol></div>
"""

WOTD_FEED = f"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>old</title><updated>2026-09-18T00:00:00Z</updated>
    <summary type="html">&lt;span id="WOTD-rss-title"&gt;stale&lt;/span&gt;</summary></entry>
  <entry><title>new</title><updated>2026-09-19T00:00:00Z</updated>
    <summary type="html"><![CDATA[{WOTD_ENTRY}]]></summary></entry>
</feed>"""


class FakeResponse:
    def __init__(self, json_body=None, content=b""):
        self._json = json_body
        self.content = content

    def raise_for_status(self):
        pass

    def json(self):
        return self._json


@pytest.fixture(autouse=True)
def fresh_cache():
    personal.clear_cache()
    yield
    personal.clear_cache()


@pytest.fixture
def client():
    return TestClient(main.app)


def test_weather_is_normalised_and_cached(monkeypatch):
    calls = []

    def fake_get(url, params=None, **kwargs):
        calls.append(params)
        return FakeResponse(WEATHER_JSON)

    monkeypatch.setattr(personal.requests, "get", fake_get)

    first = personal.get_weather(43.4643, -80.5204, "metric")
    second = personal.get_weather(43.4601, -80.5199, "metric")  # same ~1km cell

    assert first is second
    assert len(calls) == 1
    assert first["units"] == {"temp": "°C", "wind": "km/h"}
    assert first["current"]["temperature"] == 17.0
    assert first["current"]["is_day"] is True
    assert first["daily"][1] == {
        "date": "2026-09-20", "code": 61, "high": 21.0, "low": 11.0, "precip": 70,
    }


def test_weather_imperial_asks_upstream_for_imperial(monkeypatch):
    seen = {}

    def fake_get(url, params=None, **kwargs):
        seen.update(params)
        return FakeResponse(WEATHER_JSON)

    monkeypatch.setattr(personal.requests, "get", fake_get)
    result = personal.get_weather(40.0, -75.0, "imperial")

    assert seen["temperature_unit"] == "fahrenheit"
    assert seen["wind_speed_unit"] == "mph"
    assert result["units"] == {"temp": "°F", "wind": "mph"}


def test_stale_value_served_when_refresh_fails(monkeypatch):
    monkeypatch.setattr(personal.requests, "get", lambda *a, **k: FakeResponse(WEATHER_JSON))
    good = personal.get_weather(10.0, 10.0)

    # Expire the entry, then make upstream fail.
    monkeypatch.setattr(personal, "WEATHER_TTL", -1)

    def boom(*a, **k):
        raise requests.ConnectionError("offline")

    monkeypatch.setattr(personal.requests, "get", boom)
    assert personal.get_weather(10.0, 10.0) is good


def test_error_when_nothing_cached_and_upstream_down(monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("offline")

    monkeypatch.setattr(personal.requests, "get", boom)
    with pytest.raises(personal.PersonalDataError):
        personal.get_weather(1.0, 1.0)


def test_places_are_trimmed_to_the_useful_fields(monkeypatch):
    body = {
        "results": [
            {"name": "Waterloo", "admin1": "Ontario", "country": "Canada",
             "latitude": 43.46, "longitude": -80.52, "population": 1, "postcodes": ["x"]},
        ]
    }
    monkeypatch.setattr(personal.requests, "get", lambda *a, **k: FakeResponse(body))
    assert personal.search_places("  waterloo ") == [
        {"name": "Waterloo", "region": "Ontario", "country": "Canada",
         "latitude": 43.46, "longitude": -80.52}
    ]


def test_places_with_no_matches_is_empty_list(monkeypatch):
    monkeypatch.setattr(personal.requests, "get", lambda *a, **k: FakeResponse({}))
    assert personal.search_places("zzzzzz") == []


def test_word_entry_parser_takes_top_level_definitions_only():
    parsed = personal.parse_word_entry(WOTD_ENTRY)
    assert parsed["word"] == "supernova"
    assert parsed["part_of_speech"] == "n"
    assert parsed["definitions"] == [
        "(astronomy) A bright explosion of a star.",
        "(figurative) Something brilliant.",
    ]
    assert parsed["url"] == "https://en.wiktionary.org/wiki/supernova#English"


def test_word_of_the_day_uses_the_newest_feed_entry(monkeypatch):
    monkeypatch.setattr(
        personal.requests, "get",
        lambda *a, **k: FakeResponse(content=WOTD_FEED.encode()),
    )
    word = personal.get_word_of_the_day()
    assert word["word"] == "supernova"
    assert word["date"] == "2026-09-19"


def test_word_parser_rejects_junk():
    with pytest.raises(ValueError):
        personal.parse_word_entry("<div>nothing here</div>")


# --- routes ---------------------------------------------------------------


def test_weather_route_validates_coordinates(client):
    assert client.get("/api/personal/weather?lat=91&lon=0").status_code == 422
    assert client.get("/api/personal/weather?lat=0").status_code == 422


def test_weather_route_rejects_unknown_units(client):
    assert client.get("/api/personal/weather?lat=1&lon=1&units=kelvin").status_code == 400


def test_weather_route_returns_502_when_upstream_is_down(client, monkeypatch):
    def boom(*a, **k):
        raise requests.ConnectionError("offline")

    monkeypatch.setattr(personal.requests, "get", boom)
    resp = client.get("/api/personal/weather?lat=1&lon=1")
    assert resp.status_code == 502


def test_places_route_requires_a_query(client):
    assert client.get("/api/personal/places").status_code == 422
    assert client.get("/api/personal/places?q=a").status_code == 422


def test_places_route_happy_path(client, monkeypatch):
    monkeypatch.setattr(
        personal.requests, "get",
        lambda *a, **k: FakeResponse({"results": [
            {"name": "Toronto", "latitude": 43.7, "longitude": -79.4}]}),
    )
    body = client.get("/api/personal/places?q=toronto").json()
    assert body["places"][0]["name"] == "Toronto"
