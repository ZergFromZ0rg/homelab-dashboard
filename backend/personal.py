"""Third-party data for the Personal tab: weather, place search, word of the day.

All keyless and fetched server-side, so browsers never talk to those hosts
and one fetch serves every open tab:

- weather + place search: Open-Meteo (open-meteo.com)
- word of the day: English Wiktionary's "Word of the day" Atom feed

Results are cached in memory. If a refresh fails (no outbound internet, the
provider is down) the last good value is served rather than an error; an
error only surfaces when there's nothing cached yet.
"""

from __future__ import annotations

import re
import threading
import time
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

import requests

from backend.log import system as log

TIMEOUT_SECONDS = 6
USER_AGENT = "homelab-dashboard/1.0 (self-hosted dashboard; personal tab)"

WEATHER_TTL = 15 * 60
PLACES_TTL = 24 * 3600
WORD_TTL = 3600

WEATHER_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
WORD_FEED_URL = (
    "https://en.wiktionary.org/w/api.php"
    "?action=featuredfeed&feed=wotd&feedformat=atom"
)
ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}

UNITS = ("metric", "imperial")
FORECAST_DAYS = 5
MAX_DEFINITIONS = 3


class PersonalDataError(Exception):
    """The upstream provider couldn't be reached or returned junk."""


_cache: dict[tuple, tuple[float, object]] = {}
_lock = threading.Lock()


def _cached(key: tuple, ttl: float, fetch):
    """Return a fresh cached value, else fetch. On fetch failure fall back to
    a stale value if we have one."""
    now = time.time()

    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]

    try:
        value = fetch()
    except (requests.RequestException, ValueError, KeyError, ET.ParseError) as error:
        if hit:
            log.info("personal: %s refresh failed (%s); serving stale", key[0], error)
            return hit[1]
        raise PersonalDataError(f"{key[0]} unavailable: {error}") from error

    with _lock:
        _cache[key] = (now, value)
    return value


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def _get_json(url: str, params: dict) -> dict:
    response = requests.get(
        url,
        params=params,
        timeout=TIMEOUT_SECONDS,
        headers={"User-Agent": USER_AGENT},
    )
    response.raise_for_status()
    return response.json()


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------


def _round(value, digits=0):
    return None if value is None else round(value, digits)


def _fetch_weather(lat: float, lon: float, units: str) -> dict:
    imperial = units == "imperial"
    data = _get_json(
        WEATHER_URL,
        {
            "latitude": lat,
            "longitude": lon,
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
            "weather_code,wind_speed_10m,is_day",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
            "precipitation_probability_max",
            "timezone": "auto",
            "forecast_days": FORECAST_DAYS,
            "temperature_unit": "fahrenheit" if imperial else "celsius",
            "wind_speed_unit": "mph" if imperial else "kmh",
        },
    )

    current = data["current"]
    daily = data["daily"]

    return {
        "units": {"temp": "°F" if imperial else "°C", "wind": "mph" if imperial else "km/h"},
        "timezone": data.get("timezone"),
        "current": {
            "temperature": _round(current["temperature_2m"]),
            "feels_like": _round(current.get("apparent_temperature")),
            "humidity": current.get("relative_humidity_2m"),
            "wind": _round(current.get("wind_speed_10m")),
            "code": current.get("weather_code"),
            "is_day": bool(current.get("is_day", 1)),
        },
        "daily": [
            {
                "date": daily["time"][i],
                "code": daily["weather_code"][i],
                "high": _round(daily["temperature_2m_max"][i]),
                "low": _round(daily["temperature_2m_min"][i]),
                "precip": daily["precipitation_probability_max"][i],
            }
            for i in range(len(daily["time"]))
        ],
        "fetched_at": time.time(),
    }


def get_weather(lat: float, lon: float, units: str = "metric") -> dict:
    if units not in UNITS:
        raise ValueError(f"units must be one of {UNITS}")
    # ~1 km grid: nearby requests share a cache entry.
    lat, lon = round(lat, 2), round(lon, 2)
    return _cached(("weather", lat, lon, units), WEATHER_TTL, lambda: _fetch_weather(lat, lon, units))


# ---------------------------------------------------------------------------
# Place search (for picking the weather location)
# ---------------------------------------------------------------------------


def _fetch_places(query: str) -> list[dict]:
    data = _get_json(
        GEOCODE_URL,
        {"name": query, "count": 6, "language": "en", "format": "json"},
    )
    return [
        {
            "name": r["name"],
            "region": r.get("admin1"),
            "country": r.get("country"),
            "latitude": r["latitude"],
            "longitude": r["longitude"],
        }
        for r in data.get("results") or []
    ]


def search_places(query: str) -> list[dict]:
    query = " ".join(query.split())
    if not 2 <= len(query) <= 80:
        raise ValueError("query must be 2-80 characters")
    return _cached(("places", query.lower()), PLACES_TTL, lambda: _fetch_places(query))


# ---------------------------------------------------------------------------
# Word of the day
# ---------------------------------------------------------------------------


class _WotdParser(HTMLParser):
    """Pull the word, part of speech and top-level definitions out of the
    feed entry's HTML. Wiktionary marks these with stable ids
    (WOTD-rss-title / WOTD-rss-description); nested lists under a
    definition are usage examples, which we skip."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.word = ""
        self.part_of_speech = ""
        self.definitions: list[str] = []
        self._in_title = False
        self._after_title = False
        self._in_pos = False
        self._in_desc = False
        self._desc_divs = 0  # <div> nesting inside the description block
        self._li_depth = 0
        self._buf: list[str] = []
        self._nested = 0

    def handle_starttag(self, tag, attrs):
        ids = dict(attrs)
        if ids.get("id") == "WOTD-rss-title":
            self._in_title = True
        elif tag == "i" and self._after_title and not self.part_of_speech:
            self._in_pos = True
        elif ids.get("id") == "WOTD-rss-description":
            self._in_desc = True
            self._desc_divs = 1
        elif self._in_desc:
            if tag == "div":
                self._desc_divs += 1
            elif tag == "li":
                self._li_depth += 1
                if self._li_depth == 1:
                    self._buf = []
            elif tag in ("ul", "dl", "ol") and self._li_depth >= 1:
                self._nested += 1

    def handle_endtag(self, tag):
        if self._in_title and tag == "span":
            self._in_title = False
            self._after_title = True
        elif self._in_pos and tag == "i":
            self._in_pos = False
        elif self._in_desc:
            if tag == "div":
                self._desc_divs -= 1
                if self._desc_divs == 0:
                    self._in_desc = False
            elif tag in ("ul", "dl", "ol") and self._nested:
                self._nested -= 1
            elif tag == "li" and self._li_depth:
                if self._li_depth == 1:
                    text = " ".join("".join(self._buf).split())
                    if text:
                        self.definitions.append(text)
                self._li_depth -= 1

    def handle_data(self, data):
        if self._in_title:
            self.word += data
        elif self._in_pos:
            self.part_of_speech += data
        elif self._in_desc and self._li_depth == 1 and not self._nested:
            self._buf.append(data)


def parse_word_entry(summary_html: str) -> dict:
    summary_html = re.sub(r"<style.*?</style>", "", summary_html, flags=re.S)
    parser = _WotdParser()
    parser.feed(summary_html)
    word = parser.word.strip()
    if not word or not parser.definitions:
        raise ValueError("couldn't find a word in the feed entry")
    return {
        "word": word,
        "part_of_speech": parser.part_of_speech.strip() or None,
        "definitions": parser.definitions[:MAX_DEFINITIONS],
        "url": f"https://en.wiktionary.org/wiki/{word.replace(' ', '_')}#English",
    }


def _fetch_word() -> dict:
    response = requests.get(
        WORD_FEED_URL, timeout=TIMEOUT_SECONDS, headers={"User-Agent": USER_AGENT}
    )
    response.raise_for_status()
    root = ET.fromstring(response.content)

    entries = root.findall("a:entry", ATOM_NS)
    if not entries:
        raise ValueError("feed had no entries")

    # The feed lists the last ~10 days; the newest one is today's word.
    newest = max(entries, key=lambda e: e.findtext("a:updated", "", ATOM_NS))
    summary = newest.findtext("a:summary", "", ATOM_NS)
    word = parse_word_entry(summary)
    word["date"] = (newest.findtext("a:updated", "", ATOM_NS) or "")[:10]
    return word


def get_word_of_the_day() -> dict:
    return _cached(("word",), WORD_TTL, _fetch_word)
