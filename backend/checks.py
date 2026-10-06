"""Service checks: "is the thing actually answering?", with latency and history.

A container being ``running`` doesn't mean Jellyfin serves a page, the
router answers, or the internet is up. A check is a small probe the dashboard
backend runs on a schedule:

    http     GET a URL; up if it answers with the expected status (default:
             any non-error, i.e. < 400 after redirects). Latency = time to
             response headers.
    keyword  like http, and the page must also contain (or, inverted, must
             NOT contain) some text — catches an error page served with a
             200. Latency = time to download the page (first 512 KB).
    ping     one ICMP echo to an IPv4 host. Latency = round trip.
    tcp      open a TCP connection to host:port. Latency = connect time.
    dns      resolve a hostname with the backend's resolver. Latency = lookup.
    tls      TLS handshake to host[:port] (default 443); up while the
             certificate has at least ``warn_days`` left. Latency = handshake.

The probes run *from the dashboard backend*, so they test reachability from
where the dashboard lives ("localhost" means the dashboard container itself —
use the host's LAN address or hostname for things on the host).

State kept per check:

- the last few hours of raw samples (for the sparkline and short-range chart)
- hourly buckets for 30 days (for uptime % and the longer charts)

A check can run from a host instead of the dashboard (``origin``): the
dashboard asks that host's agent to probe, so "can the NAS reach the router"
and "can the internet reach it" are different checks. If the agent can't be
reached the probe is *inconclusive* — it says nothing about the target, so it
never turns a check red; the row just reports that it can't probe.

Optional settings that shape how a check is read:

- ``slow_ms``: answering slower than this for ``CHECK_FAILURES_BEFORE_DOWN``
  probes in a row makes the check ``degraded`` — still up (it counts toward
  uptime), but flagged and alerted as slow.
- ``parent``: another check this one depends on. While the parent is down, a
  failing child stays ``down`` (that is the truth) but reports
  ``suppressed_by`` the root cause, and doesn't page on its own.
- ``group``: a free-text label the table groups rows under.

Both are persisted to the ``/data`` volume, so a redeploy doesn't reset your
uptime history. A check only turns ``down`` after ``CHECK_FAILURES_BEFORE_DOWN``
failures in a row, so one dropped packet doesn't page you.
"""

from __future__ import annotations

import asyncio
import bisect
import re
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import requests

from backend.env import env_float, env_str
from backend.jsonstore import read_json, write_json_atomic
from backend.docker import agent_headers
from backend.log import system as log
from backend.probes import DEFAULT_WARN_DAYS, Result, _short
from backend.probes import probe as probe_here
from backend.registry import registry

CHECKS_FILE = Path(env_str("CHECKS_FILE", "/data/checks.json"))
HISTORY_FILE = Path(env_str("CHECK_HISTORY_FILE", "/data/check_history.json"))

TYPES = ("http", "keyword", "ping", "tcp", "dns", "tls")
HTTP_TYPES = ("http", "keyword")

MAX_CHECKS = 100
MAX_NAME_LENGTH = 60
MAX_TARGET_LENGTH = 500

MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL = 10, 3600, 60
MIN_TIMEOUT, MAX_TIMEOUT, DEFAULT_TIMEOUT = 1.0, 30.0, 5.0
# A certificate changes over weeks, so an hourly look is plenty.
TLS_DEFAULT_INTERVAL = 3600
MIN_WARN_DAYS, MAX_WARN_DAYS = 1, 365

# Consecutive failed probes before a check counts as down.
FAILURES_BEFORE_DOWN = max(1, int(env_float("CHECK_FAILURES_BEFORE_DOWN", 2)))
WORKERS = max(1, int(env_float("CHECK_WORKERS", 16)))

RAW_WINDOW_SECONDS = 3 * 3600
RAW_MAX_SAMPLES = RAW_WINDOW_SECONDS // MIN_INTERVAL
BUCKET_SECONDS = 3600
BUCKET_RETENTION_SECONDS = 30 * 86400
RECENT_POINTS = 40
PERSIST_EVERY_SECONDS = 60
MAX_KEYWORD_LENGTH = 200
KEYWORD_MODES = ("present", "absent")


# Latency histogram bin edges (ms), roughly log-spaced. Percentiles are read
# back from per-hour counts of these bins, so they stay cheap to keep for 30
# days and are accurate to within one bin.
LATENCY_EDGES = (
    0.5, 1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 300, 500, 800,
    1200, 2000, 3000, 5000, 10000, 30000,
)
HIST_BINS = len(LATENCY_EDGES) + 1

# Downtime episodes kept per check, and for how long.
MAX_INCIDENTS = 60
INCIDENT_RETENTION_SECONDS = BUCKET_RETENTION_SECONDS

# range key -> (window seconds, bucket seconds, raw?)
RANGES = {
    "3h": (3 * 3600, 300, True),
    "24h": (24 * 3600, 3600, False),
    "7d": (7 * 86400, 2 * 3600, False),
    "30d": (30 * 86400, 8 * 3600, False),
}

_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$")
_LOCAL_SUFFIX_RE = re.compile(r"\.(local|lan|home|internal)$", re.IGNORECASE)
_IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
EDITABLE = (
    "name", "type", "target", "interval", "timeout", "expect_status",
    "verify_tls", "paused", "keyword", "keyword_mode", "warn_days",
    "slow_ms", "parent", "group", "origin",
)
MAX_ORIGIN_LENGTH = 64
# The agent probes with the same timeout the check has; this is the extra
# time allowed for the round trip to it.
REMOTE_TIMEOUT_PAD = 10.0
# What the agent needs to run a probe, and nothing more.
PROBE_FIELDS = ("type", "target", "timeout", "expect_status", "verify_tls", "keyword", "keyword_mode", "warn_days")
MAX_GROUP_LENGTH = 40
MIN_SLOW_MS, MAX_SLOW_MS = 1, 60000


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _looks_local(host: str) -> bool:
    return bool(
        _IPV4_RE.match(host)
        or "." not in host
        or _LOCAL_SUFFIX_RE.search(host)
    )


def _clean_http_target(raw: str) -> str:
    raw = raw.strip()
    if not raw or any(ch.isspace() for ch in raw):
        raise ValueError("target must be a web address (no spaces)")
    if len(raw) > MAX_TARGET_LENGTH:
        raise ValueError("target is too long")

    if "://" not in raw:
        host = urlsplit(f"//{raw}").hostname or ""
        raw = f"{'http' if _looks_local(host) else 'https'}://{raw}"

    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("target must be an http:// or https:// address")
    try:
        parts.port  # noqa: B018 - raises ValueError on a bad port
    except ValueError:
        raise ValueError("target has an invalid port") from None
    return raw


def _clean_tcp_target(raw: str) -> str:
    host, sep, port = raw.strip().rpartition(":")
    if not sep or not _HOST_RE.match(host) or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError("target must look like host:port, e.g. 192.168.1.10:22")
    return f"{host}:{int(port)}"


def _clean_tls_target(raw: str) -> str:
    """host or host:port; a pasted https:// address is reduced to its host."""
    raw = raw.strip()
    if "://" in raw:
        parts = urlsplit(raw)
        raw = f"{parts.hostname or ''}:{parts.port or 443}" if parts.hostname else ""
    host, sep, port = raw.rpartition(":")
    if not sep:
        host, port = raw, "443"
    if not _HOST_RE.match(host) or not port.isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError("target must look like host or host:port, e.g. example.com:8443")
    return f"{host}:{int(port)}"


def _clean_dns_target(raw: str) -> str:
    host = raw.strip().rstrip(".")
    if not _HOST_RE.match(host) or len(host) > 253:
        raise ValueError("target must be a hostname, e.g. example.com")
    return host


def _clean_ping_target(raw: str) -> str:
    host = raw.strip()
    if not _HOST_RE.match(host) or len(host) > 253:
        raise ValueError("target must be a hostname or IPv4 address, e.g. 192.168.1.1")
    return host


def _clean_keyword(value, mode) -> tuple[str, str]:
    keyword = str(value or "").strip()
    if not 1 <= len(keyword) <= MAX_KEYWORD_LENGTH or "\n" in keyword or "\r" in keyword:
        raise ValueError(f"the text to look for must be 1-{MAX_KEYWORD_LENGTH} characters on one line")
    if mode not in KEYWORD_MODES:
        raise ValueError("keyword_mode must be 'present' or 'absent'")
    return keyword, mode


def _number(value, label, low, high, default, integer=False):
    if value in (None, ""):
        return default
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a number")
    try:
        number = int(value) if integer else float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number") from None
    if not low <= number <= high:
        raise ValueError(f"{label} must be between {low:g} and {high:g}")
    return number


def build_spec(payload: dict, existing: dict | None = None) -> dict:
    """Validate a create/update payload (merged over ``existing``) into a
    complete, normalized spec. Raises ``ValueError`` with a message meant for
    the user."""
    if not isinstance(payload, dict):
        raise ValueError("expected a JSON object")

    merged = dict(existing or {})
    merged.update({k: v for k, v in payload.items() if k in EDITABLE})

    name = " ".join(str(merged.get("name") or "").split())
    if not 1 <= len(name) <= MAX_NAME_LENGTH:
        raise ValueError(f"name must be 1-{MAX_NAME_LENGTH} characters")

    kind = merged.get("type")
    if kind not in TYPES:
        raise ValueError(f"type must be one of: {', '.join(TYPES)}")

    target = merged.get("target")
    if not isinstance(target, str):
        raise ValueError("target is required")
    target = {
        "http": _clean_http_target,
        "keyword": _clean_http_target,
        "ping": _clean_ping_target,
        "tcp": _clean_tcp_target,
        "dns": _clean_dns_target,
        "tls": _clean_tls_target,
    }[kind](target)

    interval = _number(
        merged.get("interval"), "interval", MIN_INTERVAL, MAX_INTERVAL,
        TLS_DEFAULT_INTERVAL if kind == "tls" else DEFAULT_INTERVAL, integer=True,
    )
    timeout = _number(merged.get("timeout"), "timeout", MIN_TIMEOUT, MAX_TIMEOUT, DEFAULT_TIMEOUT)
    if timeout > interval:
        raise ValueError("timeout can't be longer than the interval")

    expect = merged.get("expect_status")
    if kind in HTTP_TYPES:
        expect = _number(expect, "expected status", 100, 599, None, integer=True)
    else:
        expect = None

    if kind == "tls":
        warn_days = _number(
            merged.get("warn_days"), "warning days", MIN_WARN_DAYS, MAX_WARN_DAYS,
            DEFAULT_WARN_DAYS, integer=True,
        )
    else:
        warn_days = None

    if kind == "keyword":
        keyword, keyword_mode = _clean_keyword(
            merged.get("keyword"), merged.get("keyword_mode") or "present"
        )
    else:
        keyword, keyword_mode = None, "present"

    slow_ms = _number(merged.get("slow_ms"), "slow threshold", MIN_SLOW_MS, MAX_SLOW_MS, None)

    group = " ".join(str(merged.get("group") or "").split()) or None
    if group and len(group) > MAX_GROUP_LENGTH:
        raise ValueError(f"group must be at most {MAX_GROUP_LENGTH} characters")

    parent = merged.get("parent") or None
    if parent is not None and (not isinstance(parent, str) or len(parent) > 64):
        raise ValueError("parent must be the id of another check")

    origin = str(merged.get("origin") or "").strip()
    if len(origin) > MAX_ORIGIN_LENGTH:
        raise ValueError("origin must be a host name")
    origin = None if origin in ("", "dashboard") else origin

    verify = merged.get("verify_tls", True)
    paused = merged.get("paused", False)
    if not isinstance(verify, bool) or not isinstance(paused, bool):
        raise ValueError("verify_tls and paused must be true or false")

    return {
        "id": merged.get("id") or uuid.uuid4().hex[:12],
        "name": name,
        "type": kind,
        "target": target,
        "interval": interval,
        "timeout": timeout,
        "expect_status": expect,
        "verify_tls": verify if kind in HTTP_TYPES + ("tls",) else True,
        "warn_days": warn_days,
        "slow_ms": slow_ms,
        "parent": parent,
        "group": group,
        "origin": origin,
        "keyword": keyword,
        "keyword_mode": keyword_mode,
        "paused": paused,
        "created_at": merged.get("created_at") or time.time(),
    }


# ---------------------------------------------------------------------------
# Running a probe: here, or from a host
# ---------------------------------------------------------------------------


def probe_from_agent(spec: dict) -> Result:
    """Ask the agent on ``spec['origin']`` to run the probe. Anything that
    stops it from running (unknown host, agent down, old agent) is
    inconclusive — it must not make the target look down."""
    host = spec["origin"]
    node = registry.all().get(host)

    def unknown(detail: str) -> Result:
        return Result(False, None, _short(detail), inconclusive=True)

    if node is None:
        return unknown(f"{host} isn't a registered node")
    try:
        response = requests.post(
            f"{node['url'].rstrip('/')}/probe",
            json={k: spec.get(k) for k in PROBE_FIELDS},
            headers=agent_headers(),
            timeout=spec["timeout"] + REMOTE_TIMEOUT_PAD,
        )
    except requests.RequestException as error:
        return unknown(f"can't reach {host}'s agent: {error}")

    if response.status_code in (404, 405):
        return unknown(f"{host}'s agent is too old to run checks — rebuild it")
    if response.status_code in (401, 403):
        return unknown(f"{host}'s agent refused the token")
    if not response.ok:
        return unknown(f"{host}'s agent answered {response.status_code}")
    try:
        data = response.json()
        return Result(bool(data["ok"]), data.get("ms"), _short(data.get("detail") or ""))
    except (ValueError, KeyError, TypeError):
        return unknown(f"{host}'s agent sent an unreadable answer")


def probe(spec: dict) -> Result:
    """Run one check once, from where its ``origin`` says. Never raises."""
    return probe_from_agent(spec) if spec.get("origin") else probe_here(spec)


# ---------------------------------------------------------------------------
# Definitions
# ---------------------------------------------------------------------------


class CheckStore:
    """The list of checks the user has defined (``/data/checks.json``)."""

    def __init__(self, path: Path = CHECKS_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._items: list[dict] = self._load()

    def _load(self) -> list[dict]:
        data = read_json(self.path, [])
        items: list[dict] = []
        for raw in data if isinstance(data, list) else []:
            try:
                items.append(build_spec(raw, raw))
            except ValueError:
                log.warning("dropping invalid stored check: %r", raw.get("name") if isinstance(raw, dict) else raw)
        return items[:MAX_CHECKS]

    def _save_locked(self) -> None:
        write_json_atomic(self.path, self._items, label="checks")

    def _check_parent_locked(self, spec: dict) -> None:
        """A parent must be another existing check, and never loop back."""
        parent = spec.get("parent")
        if parent is None:
            return
        by_id = {i["id"]: i for i in self._items}
        if parent == spec["id"]:
            raise ValueError("a check can't depend on itself")
        if parent not in by_id:
            raise ValueError("the check it depends on doesn't exist")
        seen = {spec["id"]}
        while parent is not None:
            if parent in seen:
                raise ValueError("that would make the checks depend on each other")
            seen.add(parent)
            parent = (by_id.get(parent) or {}).get("parent")

    def all(self) -> list[dict]:
        with self._lock:
            return [dict(item) for item in self._items]

    def get(self, check_id: str) -> dict | None:
        with self._lock:
            return next((dict(i) for i in self._items if i["id"] == check_id), None)

    def create(self, payload: dict) -> dict:
        with self._lock:
            if len(self._items) >= MAX_CHECKS:
                raise ValueError(f"at most {MAX_CHECKS} checks")
            spec = build_spec({k: v for k, v in payload.items() if k != "id"})
            self._check_parent_locked(spec)
            self._items.append(spec)
            self._save_locked()
            return dict(spec)

    def update(self, check_id: str, payload: dict) -> tuple[dict, dict] | None:
        """-> (before, after), or None if there's no such check."""
        with self._lock:
            for index, item in enumerate(self._items):
                if item["id"] == check_id:
                    spec = build_spec(payload, item)
                    self._check_parent_locked(spec)
                    self._items[index] = spec
                    self._save_locked()
                    return dict(item), dict(spec)
        return None

    def delete(self, check_id: str) -> bool:
        with self._lock:
            kept = [i for i in self._items if i["id"] != check_id]
            if len(kept) == len(self._items):
                return False
            # Whatever depended on it now stands on its own.
            self._items = [
                {**i, "parent": None} if i.get("parent") == check_id else i for i in kept
            ]
            self._save_locked()
            return True


# ---------------------------------------------------------------------------
# Runtime state + scheduling
# ---------------------------------------------------------------------------


@dataclass
class _State:
    samples: deque = field(default_factory=lambda: deque(maxlen=RAW_MAX_SAMPLES))
    # hour start -> [samples, ups, latency_sum_ms, latency_count, latency_max_ms]
    buckets: dict = field(default_factory=dict)
    # hour start -> per-bin counts of successful latencies
    hist: dict = field(default_factory=dict)
    # downtime episodes, oldest first: {"start", "end" (None = ongoing), "detail"}
    incidents: list = field(default_factory=list)
    streak: int = 0
    # consecutive answers slower than the check's slow_ms
    slow_streak: int = 0
    # why the last probe couldn't run (inconclusive); cleared by the next that does
    probe_error: str | None = None
    fail_since: float | None = None
    last: tuple | None = None  # (t, ok, ms, detail)
    next_at: float = 0.0
    running: bool = False


def _add(bucket: list, ok: bool, ms: float | None) -> None:
    bucket[0] += 1
    bucket[1] += 1 if ok else 0
    if ok and ms is not None:
        bucket[2] += ms
        bucket[3] += 1
        bucket[4] = max(bucket[4], ms)


def _merge(into: list, other: list) -> None:
    into[0] += other[0]
    into[1] += other[1]
    into[2] += other[2]
    into[3] += other[3]
    into[4] = max(into[4], other[4])


def _bin(ms: float) -> int:
    return bisect.bisect_right(LATENCY_EDGES, ms)


def _add_hist(hist: list, ms: float) -> None:
    hist[_bin(ms)] += 1


def _percentile(hist: list, q: float, top: float | None = None) -> float | None:
    """The q-th percentile (0-1) of a bin-count list, interpolated inside the
    bin it falls in. ``top`` caps the answer at the largest value seen."""
    total = sum(hist)
    if total == 0:
        return None
    rank = q * total
    seen = 0
    for index, count in enumerate(hist):
        if count and seen + count >= rank:
            low = LATENCY_EDGES[index - 1] if index > 0 else 0.0
            high = LATENCY_EDGES[index] if index < len(LATENCY_EDGES) else low * 2 or 1.0
            value = low + (high - low) * ((rank - seen) / count)
            return round(min(value, top) if top else value, 1)
        seen += count
    return None


def _percentile_exact(values: list, q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 1)


class CheckService:
    def __init__(
        self,
        store: CheckStore | None = None,
        history_path: Path = HISTORY_FILE,
        prober=probe,
        executor=None,
    ):
        self.store = store or CheckStore()
        self.history_path = Path(history_path)
        self._prober = prober
        self._executor = executor or ThreadPoolExecutor(
            max_workers=WORKERS, thread_name_prefix="check"
        )
        self._lock = threading.RLock()
        self._states: dict[str, _State] = {}
        self._load_history()

    # -- scheduling ---------------------------------------------------------

    def tick(self, now: float | None = None) -> int:
        """Start every check that's due. Non-blocking; returns how many."""
        now = time.time() if now is None else now
        started = 0

        for spec in self.store.all():
            if spec["paused"]:
                continue
            with self._lock:
                state = self._states.setdefault(spec["id"], _State())
                if state.running or now < state.next_at:
                    continue
                state.running = True
                state.next_at = now + spec["interval"]
            self._executor.submit(self._run, spec)
            started += 1

        return started

    def _run(self, spec: dict) -> None:
        try:
            result = self._prober(spec)
            self.record(spec["id"], result, time.time(), spec.get("slow_ms"))
        finally:
            with self._lock:
                state = self._states.get(spec["id"])
                if state:
                    state.running = False

    def run_now(self, check_id: str) -> None:
        with self._lock:
            state = self._states.setdefault(check_id, _State())
            if not state.running:
                state.next_at = 0.0

    def forget(self, check_id: str) -> None:
        with self._lock:
            self._states.pop(check_id, None)

    def changed(self, before: dict, after: dict) -> None:
        """A check was edited: a different target means old samples describe
        something else, so start fresh; anything else just re-runs soon."""
        if any(
            before.get(k) != after.get(k)
            for k in ("type", "target", "expect_status", "verify_tls", "keyword", "keyword_mode", "origin")
        ):
            self.forget(after["id"])
        if after.get("paused") and not before.get("paused"):
            self._close_incident(after["id"], time.time())
        self.run_now(after["id"])

    def _close_incident(self, check_id: str, now: float) -> None:
        with self._lock:
            state = self._states.get(check_id)
            if state and state.incidents and state.incidents[-1]["end"] is None:
                state.incidents[-1]["end"] = now

    # -- recording ----------------------------------------------------------

    def record(
        self, check_id: str, result: Result, now: float, slow_ms: float | None = None
    ) -> None:
        with self._lock:
            state = self._states.setdefault(check_id, _State())

            if result.inconclusive:
                state.probe_error = result.detail
                return
            state.probe_error = None

            state.samples.append((now, result.ok, result.ms, result.detail))
            hour = int(now // BUCKET_SECONDS) * BUCKET_SECONDS
            _add(state.buckets.setdefault(hour, [0, 0, 0.0, 0, 0.0]), result.ok, result.ms)
            if result.ok and result.ms is not None:
                _add_hist(state.hist.setdefault(hour, [0] * HIST_BINS), result.ms)
            for old in [h for h in state.buckets if h < now - BUCKET_RETENTION_SECONDS]:
                del state.buckets[old]
                state.hist.pop(old, None)

            if result.ok and slow_ms is not None and result.ms is not None and result.ms > slow_ms:
                state.slow_streak += 1
            else:
                state.slow_streak = 0

            if result.ok:
                if state.incidents and state.incidents[-1]["end"] is None:
                    state.incidents[-1]["end"] = now
                state.streak = 0
                state.fail_since = None
            else:
                if state.streak == 0:
                    state.fail_since = now
                state.streak += 1
                if state.streak >= FAILURES_BEFORE_DOWN:
                    if state.incidents and state.incidents[-1]["end"] is None:
                        state.incidents[-1]["detail"] = result.detail
                    else:
                        state.incidents.append(
                            {"start": state.fail_since, "end": None, "detail": result.detail}
                        )
                        cutoff = now - INCIDENT_RETENTION_SECONDS
                        state.incidents = [
                            i for i in state.incidents if (i["end"] or now) >= cutoff
                        ][-MAX_INCIDENTS:]

            state.last = (now, result.ok, result.ms, result.detail)

    # -- reading ------------------------------------------------------------

    def _uptime(self, state: _State, now: float, window: float) -> float | None:
        total = ups = 0
        for hour, bucket in state.buckets.items():
            if hour + BUCKET_SECONDS > now - window:
                total += bucket[0]
                ups += bucket[1]
        return None if total == 0 else round(100 * ups / total, 2)

    def _avg_ms(self, state: _State, now: float, window: float) -> float | None:
        count = total = 0
        for hour, bucket in state.buckets.items():
            if hour + BUCKET_SECONDS > now - window:
                count += bucket[3]
                total += bucket[2]
        return None if count == 0 else round(total / count, 1)

    def _window_hist(self, state: _State, now: float, window: float) -> list:
        merged = [0] * HIST_BINS
        for hour, counts in state.hist.items():
            if hour + BUCKET_SECONDS > now - window:
                for i, c in enumerate(counts):
                    merged[i] += c
        return merged

    def _max_ms(self, state: _State, now: float, window: float) -> float | None:
        peaks = [
            b[4] for hour, b in state.buckets.items()
            if hour + BUCKET_SECONDS > now - window and b[3]
        ]
        return max(peaks) if peaks else None

    def incidents(self, check_id: str | None = None, since: float | None = None,
                  limit: int = 100, now: float | None = None) -> list[dict]:
        """Downtime episodes, newest first. Ongoing ones carry ``end: None``."""
        now = time.time() if now is None else now
        names = {spec["id"]: spec["name"] for spec in self.store.all()}
        out = []
        with self._lock:
            for cid, state in self._states.items():
                if cid not in names or (check_id and cid != check_id):
                    continue
                for inc in state.incidents:
                    if since is not None and (inc["end"] or now) < since:
                        continue
                    out.append({
                        "check_id": cid,
                        "name": names[cid],
                        "start": inc["start"],
                        "end": inc["end"],
                        "detail": inc["detail"],
                    })
        out.sort(key=lambda i: i["start"], reverse=True)
        return out[:limit]

    def _status(self, spec: dict) -> str:
        state = self._states.get(spec["id"]) or _State()
        if spec["paused"]:
            return "paused"
        if state.last is None:
            return "pending"
        if state.streak >= FAILURES_BEFORE_DOWN:
            return "down"
        if spec.get("slow_ms") is not None and state.slow_streak >= FAILURES_BEFORE_DOWN:
            return "degraded"
        return "up"

    def _root_cause(self, spec: dict, specs: dict) -> dict | None:
        """The topmost down check this one depends on, if any."""
        found = None
        seen = {spec["id"]}
        parent = specs.get(spec.get("parent"))
        while parent is not None and parent["id"] not in seen:
            seen.add(parent["id"])
            if self._status(parent) == "down":
                found = parent
            parent = specs.get(parent.get("parent"))
        return found

    def summary(self, spec: dict, now: float | None = None, specs: dict | None = None) -> dict:
        now = time.time() if now is None else now
        if specs is None:
            specs = {i["id"]: i for i in self.store.all()}
        with self._lock:
            state = self._states.get(spec["id"]) or _State()
            last = state.last
            status = self._status(spec)
            cause = self._root_cause(spec, specs) if status == "down" else None

            day_hist = self._window_hist(state, now, 86400)
            day_max = self._max_ms(state, now, 86400)
            recent = [
                (round(ms, 1) if ok and ms is not None else None)
                for _, ok, ms, _ in list(state.samples)[-RECENT_POINTS:]
            ]

            return {
                **{
                    k: spec[k]
                    for k in (
                        "id", "name", "type", "target", "interval", "timeout",
                        "expect_status", "verify_tls", "paused", "keyword", "keyword_mode",
                        "warn_days", "slow_ms", "parent", "group", "origin",
                    )
                },
                "status": status,
                "probe_error": state.probe_error,
                "suppressed_by": None if cause is None else {"id": cause["id"], "name": cause["name"]},
                "last_ok": None if last is None else last[1],
                "latency_ms": round(last[2], 1) if last and last[1] and last[2] is not None else None,
                "detail": last[3] if last else None,
                "checked_at": last[0] if last else None,
                "down_since": state.fail_since if status == "down" else None,
                "failing": state.streak,
                "uptime_24h": self._uptime(state, now, 86400),
                "uptime_7d": self._uptime(state, now, 7 * 86400),
                "uptime_30d": self._uptime(state, now, 30 * 86400),
                "avg_ms_24h": self._avg_ms(state, now, 86400),
                "p50_ms_24h": _percentile(day_hist, 0.5, day_max),
                "p95_ms_24h": _percentile(day_hist, 0.95, day_max),
                "incidents_24h": sum(
                    1 for i in state.incidents if (i["end"] or now) >= now - 86400
                ),
                "recent": recent,
            }

    def summaries(self, now: float | None = None) -> list[dict]:
        now = time.time() if now is None else now
        items = self.store.all()
        specs = {i["id"]: i for i in items}
        return [self.summary(spec, now, specs) for spec in items]

    def history(self, check_id: str, range_key: str, now: float | None = None) -> dict | None:
        if range_key not in RANGES:
            raise ValueError(f"range must be one of: {', '.join(RANGES)}")
        spec = self.store.get(check_id)
        if spec is None:
            return None

        now = time.time() if now is None else now
        window, width, raw = RANGES[range_key]
        end = int(now // width) * width + width
        start = end - window
        slots = {t: [0, 0, 0.0, 0, 0.0] for t in range(start, end, width)}
        hists = {t: [0] * HIST_BINS for t in slots}
        raw_ms: dict = {t: [] for t in slots}

        with self._lock:
            state = self._states.get(check_id) or _State()

            if raw:
                for t, ok, ms, _ in state.samples:
                    slot = int(t // width) * width
                    if slot in slots:
                        _add(slots[slot], ok, ms)
                        if ok and ms is not None:
                            raw_ms[slot].append(ms)
            else:
                for hour, bucket in state.buckets.items():
                    slot = int(hour // width) * width
                    if slot in slots:
                        _merge(slots[slot], bucket)
                        for i, c in enumerate(state.hist.get(hour, ())):
                            hists[slot][i] += c

            uptime = self._uptime(state, now, window)
            whole = self._window_hist(state, now, window)
            whole_max = self._max_ms(state, now, window)
            if raw:
                every = [ms for values in raw_ms.values() for ms in values]
                p50, p95 = _percentile_exact(every, 0.5), _percentile_exact(every, 0.95)
            else:
                p50, p95 = _percentile(whole, 0.5, whole_max), _percentile(whole, 0.95, whole_max)

        def point_pct(t, q):
            if raw:
                return _percentile_exact(raw_ms[t], q)
            return _percentile(hists[t], q, slots[t][4] or None)

        points = [
            {
                "t": t,
                "n": b[0],
                "up": b[1],
                "ms_avg": round(b[2] / b[3], 1) if b[3] else None,
                "ms_max": round(b[4], 1) if b[3] else None,
                "ms_p50": point_pct(t, 0.5) if b[3] else None,
                "ms_p95": point_pct(t, 0.95) if b[3] else None,
            }
            for t, b in slots.items()
        ]
        return {
            "range": range_key,
            "bucket_seconds": width,
            "uptime": uptime,
            "p50": p50,
            "p95": p95,
            "points": points,
            "incidents": self.incidents(check_id, since=start, now=now),
        }

    # -- persistence --------------------------------------------------------

    def persist(self) -> None:
        now = time.time()
        with self._lock:
            data = {
                check_id: {
                    "samples": [
                        [t, 1 if ok else 0, ms, detail]
                        for t, ok, ms, detail in state.samples
                        if now - t < RAW_WINDOW_SECONDS
                    ],
                    "buckets": {str(h): b for h, b in state.buckets.items()},
                    "hist": {str(h): c for h, c in state.hist.items()},
                    "incidents": state.incidents,
                    "streak": state.streak,
                    "slow_streak": state.slow_streak,
                    "fail_since": state.fail_since,
                }
                for check_id, state in self._states.items()
                if state.last is not None
            }
        write_json_atomic(self.history_path, {"checks": data}, label="check history", indent=None)

    def _load_history(self) -> None:
        raw = read_json(self.history_path, None)
        if not isinstance(raw, dict):
            return

        now = time.time()
        known = {spec["id"] for spec in self.store.all()}

        for check_id, saved in (raw.get("checks") or {}).items():
            if check_id not in known or not isinstance(saved, dict):
                continue
            try:
                state = _State()
                for t, ok, ms, detail in saved.get("samples", []):
                    if now - t < RAW_WINDOW_SECONDS:
                        state.samples.append((t, bool(ok), ms, detail))
                for hour, bucket in (saved.get("buckets") or {}).items():
                    if now - int(hour) < BUCKET_RETENTION_SECONDS and len(bucket) == 5:
                        state.buckets[int(hour)] = [float(x) if i in (2, 4) else int(x) for i, x in enumerate(bucket)]
                for hour, counts in (saved.get("hist") or {}).items():
                    if now - int(hour) < BUCKET_RETENTION_SECONDS and len(counts) == HIST_BINS:
                        state.hist[int(hour)] = [int(c) for c in counts]
                for inc in saved.get("incidents") or []:
                    state.incidents.append({
                        "start": float(inc["start"]),
                        "end": None if inc.get("end") is None else float(inc["end"]),
                        "detail": inc.get("detail"),
                    })
                state.streak = int(saved.get("streak") or 0)
                state.slow_streak = int(saved.get("slow_streak") or 0)
                state.fail_since = saved.get("fail_since")
                if state.samples:
                    t, ok, ms, detail = state.samples[-1]
                    state.last = (t, ok, ms, detail)
                # History from before incidents were recorded: an outage that
                # is still going deserves an entry too.
                if (
                    state.streak >= FAILURES_BEFORE_DOWN
                    and state.fail_since is not None
                    and not (state.incidents and state.incidents[-1]["end"] is None)
                ):
                    state.incidents.append({
                        "start": state.fail_since,
                        "end": None,
                        "detail": state.last[3] if state.last else None,
                    })
                self._states[check_id] = state
            except (TypeError, ValueError):
                log.warning("ignoring unreadable history for check %s", check_id)

    async def run_forever(self) -> None:
        last_persist = time.time()
        while True:
            try:
                self.tick()
                if time.time() - last_persist >= PERSIST_EVERY_SECONDS:
                    await asyncio.to_thread(self.persist)
                    last_persist = time.time()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - loop must survive
                log.warning("check scheduler cycle failed: %s", error)
            await asyncio.sleep(1)


service = CheckService()
