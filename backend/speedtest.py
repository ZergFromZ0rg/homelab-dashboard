"""Internet speed, measured on a schedule.

Every few hours (and whenever someone presses Run) the dashboard downloads and
uploads for a few seconds against Cloudflare's speed endpoints and keeps the
result. Nothing to install: it is plain HTTPS from the dashboard's own host, so
the number is that host's path to the internet.

A scheduled run waits while the uplink is in use, so a test never fights the
household for the line and a busy line is never mistaken for a slow one. A
manual run goes ahead and is marked ``busy`` when the line was in use.

History is kept in ``/data``; a restart neither forgets it nor re-runs a test
that is not due. Two slow results in a row, against what this line usually
does, raise one alert.
"""

from __future__ import annotations

import asyncio
import os
import statistics
import threading
import time
from pathlib import Path

import requests

from backend import switch
from backend.env import env_float, env_str
from backend.jsonstore import read_json, write_json_atomic
from backend.log import system as log

SPEEDTEST_FILE = Path(env_str("SPEEDTEST_FILE", "/data/speedtest.json"))
SERVER = "https://speed.cloudflare.com"
CHOICES = (0, 1, 3, 6, 12, 24)  # hours between tests; 0 is off
DEFAULT_HOURS = int(env_float("SPEEDTEST_EVERY_HOURS", 6))
KEEP = 500
SHOWN = 200

PING_ECHOES = 8
DOWN_STREAMS, DOWN_SECONDS, DOWN_BYTES = 4, 6.0, 50_000_000
UP_STREAMS, UP_SECONDS, UP_BYTES = 3, 5.0, 2_000_000
RAMP = 1.0  # seconds of slow start left out of the rate
BUSY_AT = 0.25  # the uplink is "in use" above this share of its link speed
BUSY_GRACE = 3600  # a scheduled test waits this long for a quiet line, then runs anyway
RETRY = 1800  # after a failed test (the internet may be down), try again sooner than the schedule says

SLOW_RATIO = 0.5
SLOW_NEEDS = 5  # earlier results required before "slower than usual" means anything
SLOW_USUAL = 14  # how many earlier results define "usual"


class SpeedTestError(RuntimeError):
    pass


def _rate(samples: list[tuple[float, int]], started: float) -> float | None:
    """Mbit/s from (time, cumulative bytes) samples, leaving out the first
    ``RAMP`` seconds while TCP is still opening its window."""
    if len(samples) < 2:
        return None
    steady = [s for s in samples if s[0] - started >= RAMP] or samples
    (t1, b1), (t2, b2) = steady[0], steady[-1]
    if t2 - t1 < 0.5:  # too short to trust: fall back to the whole run
        (t1, b1), (t2, b2) = (started, 0), samples[-1]
    return (b2 - b1) * 8 / (t2 - t1) / 1e6 if t2 > t1 else None


class _Streams:
    """N threads doing the same transfer until a deadline, sharing a byte count."""

    def __init__(self):
        self.lock = threading.Lock()
        self.total = 0
        self.samples: list[tuple[float, int]] = []
        self.error: Exception | None = None

    def add(self, n: int) -> None:
        with self.lock:
            self.total += n
            self.samples.append((time.perf_counter(), self.total))

    def run(self, count: int, seconds: float, work) -> float | None:
        started = time.perf_counter()
        deadline = started + seconds
        threads = [threading.Thread(target=self._guard, args=(work, deadline), daemon=True) for _ in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(seconds + 20)
        if self.error and not self.total:
            raise SpeedTestError(f"couldn't reach {SERVER.split('//')[1]}: {self.error}")
        return _rate(self.samples, started)

    def _guard(self, work, deadline: float) -> None:
        try:
            work(self, deadline)
        except requests.RequestException as failure:
            self.error = failure


def _download(streams: _Streams, deadline: float) -> None:
    with requests.Session() as session:
        while time.perf_counter() < deadline:
            with session.get(f"{SERVER}/__down", params={"bytes": DOWN_BYTES}, stream=True, timeout=(5, 10)) as response:
                response.raise_for_status()
                for chunk in response.iter_content(262144):
                    streams.add(len(chunk))
                    if time.perf_counter() >= deadline:
                        return


def _upload(streams: _Streams, deadline: float) -> None:
    body = os.urandom(UP_BYTES)
    with requests.Session() as session:
        while time.perf_counter() < deadline:
            response = session.post(f"{SERVER}/__up", data=body, timeout=(5, 20))
            response.raise_for_status()
            streams.add(UP_BYTES)


def _ping() -> tuple[float, float]:
    """Median round trip and jitter in ms, on one kept-alive connection so the
    TLS handshake is not counted."""
    times: list[float] = []
    try:
        with requests.Session() as session:
            session.get(f"{SERVER}/__down", params={"bytes": 0}, timeout=5)  # open the connection
            for _ in range(PING_ECHOES):
                began = time.perf_counter()
                session.get(f"{SERVER}/__down", params={"bytes": 0}, timeout=5).raise_for_status()
                times.append((time.perf_counter() - began) * 1000)
    except requests.RequestException as failure:
        raise SpeedTestError(f"couldn't reach {SERVER.split('//')[1]}: {failure}") from failure
    jitter = statistics.mean(abs(a - b) for a, b in zip(times, times[1:])) if len(times) > 1 else 0.0
    return statistics.median(times), jitter


def measure() -> dict:
    ping, jitter = _ping()
    down = _Streams().run(DOWN_STREAMS, DOWN_SECONDS, _download)
    up = _Streams().run(UP_STREAMS, UP_SECONDS, _upload)
    if down is None or up is None:
        raise SpeedTestError("the transfers were too short to measure")
    return {"down_mbps": round(down, 1), "up_mbps": round(up, 1), "ping_ms": round(ping, 1), "jitter_ms": round(jitter, 1)}


def uplink_usage(snapshot: dict) -> float | None:
    """How much of the uplink's link speed is in use right now, 0 to 1."""
    for port in snapshot.get("ports") or []:
        if port["name"].lower() == switch.UPLINK and port["up"]:
            return port.get("usage")
    return None


def uplink_speed(snapshot: dict) -> int | None:
    for port in snapshot.get("ports") or []:
        if port["name"].lower() == switch.UPLINK and port["up"]:
            return port.get("speed_mbps")
    return None


class SpeedTest:
    def __init__(self, path: Path | None = None, measure_fn=None, clock=time.time, busy_fn=None):
        self.path = Path(path or SPEEDTEST_FILE)
        self._measure = measure_fn or measure
        self._clock = clock
        self._busy = busy_fn or (lambda: (uplink_usage(switch.monitor.snapshot()) or 0) > BUSY_AT)
        self._lock = threading.Lock()
        self._running = False
        self._started = clock()
        data = read_json(self.path, {})
        data = data if isinstance(data, dict) else {}
        every = data.get("every_hours", DEFAULT_HOURS)
        self.every_hours = every if every in CHOICES else DEFAULT_HOURS
        self.results = [r for r in data.get("results", []) if isinstance(r, dict) and "down_mbps" in r][-KEEP:]
        self.error: dict | None = data.get("error") if isinstance(data.get("error"), dict) else None

    def _save(self) -> None:
        write_json_atomic(self.path, {"every_hours": self.every_hours, "results": self.results, "error": self.error},
                          label="speedtest", indent=None)

    def set_every(self, hours: int) -> None:
        if hours not in CHOICES:
            raise ValueError(f"every_hours must be one of {list(CHOICES)}")
        with self._lock:
            self.every_hours = hours
            self._save()

    def due_at(self) -> float | None:
        """When the next scheduled test is due; None when scheduling is off."""
        if not self.every_hours:
            return None
        ran = self.results[-1]["at"] if self.results else 0.0
        failed = (self.error or {}).get("at", 0.0)
        if failed > ran:
            return failed + min(RETRY, self.every_hours * 3600)
        # Never run yet: a minute after the dashboard starts, not at once.
        return ran + self.every_hours * 3600 if ran else self._started + 60

    @property
    def running(self) -> bool:
        return self._running

    def run(self, manual: bool = False) -> dict:
        """Run one test now (blocks for ~15 s) and record it. A test already in
        progress is not started twice."""
        with self._lock:
            if self._running:
                raise SpeedTestError("a test is already running")
            self._running = True
        try:
            busy = self._busy()
            try:
                result = {"at": self._clock(), **self._measure(), "busy": bool(busy), "manual": manual}
            except SpeedTestError as failure:
                with self._lock:
                    self.error = {"at": self._clock(), "message": str(failure)}
                    self._save()
                log.warning("speed test failed: %s", failure)
                raise
            with self._lock:
                self.results = (self.results + [result])[-KEEP:]
                self.error = None
                self._save()
            return result
        finally:
            with self._lock:
                self._running = False

    def tick(self) -> bool:
        """Run the scheduled test if it is due and the line is quiet. Returns
        whether one ran."""
        due = self.due_at()
        if due is None or self._running or self._clock() < due:
            return False
        if self._busy() and self._clock() - due < BUSY_GRACE:
            return False
        try:
            self.run()
        except SpeedTestError:
            pass  # recorded in self.error; the next attempt is a full interval away
        return True

    def snapshot(self, switch_snapshot: dict | None = None) -> dict:
        with self._lock:
            results, error = list(self.results[-SHOWN:]), self.error
        due = self.due_at()
        return {
            "every_hours": self.every_hours,
            "choices": list(CHOICES),
            "running": self._running,
            "results": results,
            "error": error,
            "next_at": due,
            "link_mbps": uplink_speed(switch_snapshot or {}),
        }


def usual_download(results: list[dict]) -> float | None:
    """What this line normally downloads at, from the results before the latest ones.
    Tests taken while the line was busy say nothing about the line."""
    quiet = [r["down_mbps"] for r in results if not r.get("busy")]
    return statistics.median(quiet[-SLOW_USUAL:]) if len(quiet) >= SLOW_NEEDS else None


def evaluate(results: list[dict]) -> dict[str, dict]:
    """One alert when the last two quiet-line results were both under half of
    the usual download. One slow result is a blip, two is a trend."""
    quiet = [r for r in results if not r.get("busy")]
    if len(quiet) < 2 + SLOW_NEEDS:
        return {}
    usual = usual_download(quiet[:-2])
    last = quiet[-2:]
    if not usual or not all(r["down_mbps"] < usual * SLOW_RATIO for r in last):
        return {}
    return {"network:internet-slow": {
        "title": "Internet is slower than usual",
        "message": f"The last two speed tests downloaded at {last[0]['down_mbps']:g} and {last[1]['down_mbps']:g} Mbps; "
                   f"this line usually does {usual:g}.",
        "severity": "warn",
        "hint": "Restart the router, then try a test from Network → Bandwidth. If it stays slow, it is the ISP.",
        "debounce": True,
    }}


test = SpeedTest()


def alerts() -> dict[str, dict]:
    return evaluate(list(test.results))


async def run_forever() -> None:
    while True:
        await asyncio.to_thread(test.tick)
        await asyncio.sleep(60)
