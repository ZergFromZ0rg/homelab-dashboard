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

The probes run *from the dashboard backend*, so they test reachability from
where the dashboard lives ("localhost" means the dashboard container itself —
use the host's LAN address or hostname for things on the host).

State kept per check:

- the last few hours of raw samples (for the sparkline and short-range chart)
- hourly buckets for 30 days (for uptime % and the longer charts)

Both are persisted to the ``/data`` volume, so a redeploy doesn't reset your
uptime history. A check only turns ``down`` after ``CHECK_FAILURES_BEFORE_DOWN``
failures in a row, so one dropped packet doesn't page you.
"""

from __future__ import annotations

import asyncio
import re
import random
import socket
import struct
import threading
import time
import uuid
import warnings
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import requests

from backend.env import env_float, env_str
from backend.jsonstore import read_json, write_json_atomic
from backend.log import system as log

CHECKS_FILE = Path(env_str("CHECKS_FILE", "/data/checks.json"))
HISTORY_FILE = Path(env_str("CHECK_HISTORY_FILE", "/data/check_history.json"))

TYPES = ("http", "keyword", "ping", "tcp", "dns")
HTTP_TYPES = ("http", "keyword")

MAX_CHECKS = 100
MAX_NAME_LENGTH = 60
MAX_TARGET_LENGTH = 500

MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL = 10, 3600, 60
MIN_TIMEOUT, MAX_TIMEOUT, DEFAULT_TIMEOUT = 1.0, 30.0, 5.0

# Consecutive failed probes before a check counts as down.
FAILURES_BEFORE_DOWN = max(1, int(env_float("CHECK_FAILURES_BEFORE_DOWN", 2)))
WORKERS = max(1, int(env_float("CHECK_WORKERS", 16)))

RAW_WINDOW_SECONDS = 3 * 3600
RAW_MAX_SAMPLES = RAW_WINDOW_SECONDS // MIN_INTERVAL
BUCKET_SECONDS = 3600
BUCKET_RETENTION_SECONDS = 30 * 86400
RECENT_POINTS = 40
PERSIST_EVERY_SECONDS = 60
MAX_DETAIL_LENGTH = 200
MAX_KEYWORD_LENGTH = 200
KEYWORD_MODES = ("present", "absent")
# How much of a page a keyword check reads before giving up on finding text.
MAX_BODY_BYTES = 512 * 1024

USER_AGENT = "homelab-dashboard/1.0 (service check)"
MAX_REDIRECTS = 5

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
    "verify_tls", "paused", "keyword", "keyword_mode",
)


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
    }[kind](target)

    interval = _number(merged.get("interval"), "interval", MIN_INTERVAL, MAX_INTERVAL, DEFAULT_INTERVAL, integer=True)
    timeout = _number(merged.get("timeout"), "timeout", MIN_TIMEOUT, MAX_TIMEOUT, DEFAULT_TIMEOUT)
    if timeout > interval:
        raise ValueError("timeout can't be longer than the interval")

    expect = merged.get("expect_status")
    if kind in HTTP_TYPES:
        expect = _number(expect, "expected status", 100, 599, None, integer=True)
    else:
        expect = None

    if kind == "keyword":
        keyword, keyword_mode = _clean_keyword(
            merged.get("keyword"), merged.get("keyword_mode") or "present"
        )
    else:
        keyword, keyword_mode = None, "present"

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
        "verify_tls": verify if kind in HTTP_TYPES else True,
        "keyword": keyword,
        "keyword_mode": keyword_mode,
        "paused": paused,
        "created_at": merged.get("created_at") or time.time(),
    }


# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------


@dataclass
class Result:
    ok: bool
    ms: float | None = None
    detail: str | None = None


def _short(text: object) -> str:
    return " ".join(str(text).split())[:MAX_DETAIL_LENGTH]


def _read_text(response, started: float, timeout: float) -> tuple[str, bool]:
    """Read up to MAX_BODY_BYTES of a response as text. -> (text, truncated).
    Raises TimeoutError if the whole read takes longer than ``timeout``, so
    a server that trickles bytes can't hold a check open forever."""
    chunks: list[bytes] = []
    size = 0
    truncated = False

    for chunk in response.iter_content(chunk_size=16384):
        if time.perf_counter() - started > timeout:
            raise TimeoutError
        chunks.append(chunk)
        size += len(chunk)
        if size >= MAX_BODY_BYTES:
            truncated = True
            break

    return b"".join(chunks)[:MAX_BODY_BYTES].decode("utf-8", errors="replace"), truncated


def _keyword_result(spec: dict, code: int, text: str, truncated: bool, ms: float) -> Result:
    keyword = spec["keyword"]
    shown = keyword if len(keyword) <= 40 else keyword[:37] + "..."
    found = keyword.lower() in text.lower()

    if spec["keyword_mode"] == "absent":
        if found:
            return Result(False, ms, _short(f'HTTP {code} · unwanted text "{shown}" found'))
        return Result(True, ms, _short(f'HTTP {code} · "{shown}" not present'))

    if found:
        return Result(True, ms, _short(f'HTTP {code} · found "{shown}"'))
    where = f" in the first {MAX_BODY_BYTES // 1024} KB" if truncated else ""
    return Result(False, ms, _short(f'HTTP {code} · "{shown}" not found{where}'))


def _probe_http(spec: dict) -> Result:
    timeout = spec["timeout"]
    keyword_check = spec["type"] == "keyword"
    started = time.perf_counter()

    session = requests.Session()
    session.max_redirects = MAX_REDIRECTS
    session.headers["User-Agent"] = USER_AGENT

    try:
        with warnings.catch_warnings():
            # Self-signed certs are normal on a LAN; the user opted out of
            # verification on this check, so don't spam the log about it.
            warnings.simplefilter("ignore")
            response = session.get(
                spec["target"],
                timeout=(timeout, timeout),
                verify=spec.get("verify_tls", True),
                allow_redirects=True,
                stream=True,  # headers first; never download a big body blindly
            )

        code = response.status_code
        expected = spec.get("expect_status")
        status_ok = code == expected if expected else code < 400

        if keyword_check and status_ok:
            text, truncated = _read_text(response, started, timeout)
            ms = (time.perf_counter() - started) * 1000
            return _keyword_result(spec, code, text, truncated, ms)

        ms = (time.perf_counter() - started) * 1000
        response.close()
    except requests.exceptions.SSLError as error:
        return Result(False, None, _short(f"TLS error: {error}"))
    except (requests.exceptions.Timeout, TimeoutError):
        return Result(False, None, f"timed out after {timeout:g}s")
    except requests.exceptions.TooManyRedirects:
        return Result(False, None, "too many redirects")
    except requests.exceptions.ConnectionError as error:
        return Result(False, None, _short(_connection_reason(error)))
    except requests.RequestException as error:
        return Result(False, None, _short(error))
    finally:
        session.close()

    detail = f"HTTP {code} (expected {expected})" if expected and not status_ok else f"HTTP {code}"
    return Result(status_ok, ms, detail)


def _connection_reason(error: Exception) -> str:
    text = str(error)
    if "Name or service not known" in text or "nodename nor servname" in text or "getaddrinfo" in text:
        return "DNS lookup failed"
    if "Connection refused" in text:
        return "connection refused"
    if "Connection reset" in text:
        return "connection reset"
    return f"connection failed: {text}"


def _probe_tcp(spec: dict) -> Result:
    host, _, port = spec["target"].rpartition(":")
    started = time.perf_counter()
    try:
        sock = socket.create_connection((host, int(port)), timeout=spec["timeout"])
    except socket.gaierror:
        return Result(False, None, "DNS lookup failed")
    except (socket.timeout, TimeoutError):
        return Result(False, None, f"timed out after {spec['timeout']:g}s")
    except ConnectionRefusedError:
        return Result(False, None, "connection refused")
    except OSError as error:
        return Result(False, None, _short(error))
    ms = (time.perf_counter() - started) * 1000
    sock.close()
    return Result(True, ms, "connected")


def _probe_dns(spec: dict) -> Result:
    started = time.perf_counter()
    try:
        answers = socket.getaddrinfo(spec["target"], None)
    except socket.gaierror as error:
        return Result(False, None, _short(f"lookup failed: {error.strerror or error}"))
    except OSError as error:
        return Result(False, None, _short(error))
    ms = (time.perf_counter() - started) * 1000
    address = answers[0][4][0] if answers else "?"
    return Result(bool(answers), ms, f"resolved to {address}")


def _icmp_checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack(f"!{len(data) // 2}H", data))
    total = (total >> 16) + (total & 0xFFFF)
    total += total >> 16
    return ~total & 0xFFFF


def _echo_request(ident: int, seq: int, payload: bytes = b"homelab-dashboard") -> bytes:
    header = struct.pack("!BBHHH", 8, 0, 0, ident, seq)
    checksum = _icmp_checksum(header + payload)
    return struct.pack("!BBHHH", 8, 0, checksum, ident, seq) + payload


def _icmp_body(packet: bytes) -> bytes:
    """The ICMP message inside whatever a socket handed back: raw sockets
    (and macOS datagram ones) include the IPv4 header, Linux datagram ones
    don't. An IPv4 header starts 0x4N; no ICMP message we care about does."""
    if packet and packet[0] >> 4 == 4:
        return packet[(packet[0] & 0x0F) * 4:]
    return packet


def _open_icmp_socket() -> tuple[socket.socket, bool]:
    """-> (socket, is_raw). Unprivileged datagram ICMP first (Linux needs the
    container's net.ipv4.ping_group_range to include its gid; macOS just
    works), then a raw socket (root with CAP_NET_RAW)."""
    try:
        return socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP), False
    except OSError:
        pass
    return socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP), True


ICMP_DENIED = (
    "ICMP isn't permitted for the dashboard container (needs "
    "net.ipv4.ping_group_range or CAP_NET_RAW) — use a Port check instead"
)


def _probe_ping(spec: dict) -> Result:
    host = spec["target"]
    timeout = spec["timeout"]

    try:
        address = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
    except socket.gaierror:
        return Result(False, None, "DNS lookup failed (IPv4 only)")

    try:
        sock, raw = _open_icmp_socket()
    except OSError:
        return Result(False, None, ICMP_DENIED)

    ident = random.randrange(1, 0xFFFF)
    seq = random.randrange(1, 0xFFFF)

    try:
        started = time.perf_counter()
        try:
            sock.sendto(_echo_request(ident, seq), (address, 0))
        except PermissionError:
            return Result(False, None, ICMP_DENIED)
        except OSError as error:
            return Result(False, None, _short(f"send failed: {error}"))

        while True:
            remaining = timeout - (time.perf_counter() - started)
            if remaining <= 0:
                return Result(False, None, f"no reply within {timeout:g}s")
            sock.settimeout(remaining)
            try:
                data, _ = sock.recvfrom(1024)
            except (socket.timeout, TimeoutError):
                return Result(False, None, f"no reply within {timeout:g}s")
            except OSError as error:
                return Result(False, None, _short(f"receive failed: {error}"))

            message = _icmp_body(data)
            if len(message) < 8:
                continue
            kind, _code, _sum, got_ident, got_seq = struct.unpack("!BBHHH", message[:8])
            if kind == 0 and got_seq == seq and (not raw or got_ident == ident):
                ms = (time.perf_counter() - started) * 1000
                return Result(True, ms, f"reply from {address}")
            if kind == 3:
                return Result(False, None, "host unreachable")
            if kind == 11:
                return Result(False, None, "TTL exceeded in transit")
    finally:
        sock.close()


def probe(spec: dict) -> Result:
    """Run one check once. Never raises: any failure is a failed Result."""
    try:
        return {
            "http": _probe_http,
            "keyword": _probe_http,
            "ping": _probe_ping,
            "tcp": _probe_tcp,
            "dns": _probe_dns,
        }[spec["type"]](spec)
    except Exception as error:  # noqa: BLE001 - a probe must not kill its worker
        log.warning("check %s crashed: %s", spec.get("name"), error)
        return Result(False, None, _short(f"probe error: {error}"))


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
            self._items.append(spec)
            self._save_locked()
            return dict(spec)

    def update(self, check_id: str, payload: dict) -> tuple[dict, dict] | None:
        """-> (before, after), or None if there's no such check."""
        with self._lock:
            for index, item in enumerate(self._items):
                if item["id"] == check_id:
                    spec = build_spec(payload, item)
                    self._items[index] = spec
                    self._save_locked()
                    return dict(item), dict(spec)
        return None

    def delete(self, check_id: str) -> bool:
        with self._lock:
            kept = [i for i in self._items if i["id"] != check_id]
            if len(kept) == len(self._items):
                return False
            self._items = kept
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
    streak: int = 0
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
            self.record(spec["id"], result, time.time())
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
            for k in ("type", "target", "expect_status", "verify_tls", "keyword", "keyword_mode")
        ):
            self.forget(after["id"])
        self.run_now(after["id"])

    # -- recording ----------------------------------------------------------

    def record(self, check_id: str, result: Result, now: float) -> None:
        with self._lock:
            state = self._states.setdefault(check_id, _State())

            state.samples.append((now, result.ok, result.ms, result.detail))
            hour = int(now // BUCKET_SECONDS) * BUCKET_SECONDS
            _add(state.buckets.setdefault(hour, [0, 0, 0.0, 0, 0.0]), result.ok, result.ms)
            for old in [h for h in state.buckets if h < now - BUCKET_RETENTION_SECONDS]:
                del state.buckets[old]

            if result.ok:
                state.streak = 0
                state.fail_since = None
            else:
                if state.streak == 0:
                    state.fail_since = now
                state.streak += 1

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

    def summary(self, spec: dict, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        with self._lock:
            state = self._states.get(spec["id"]) or _State()
            last = state.last

            if spec["paused"]:
                status = "paused"
            elif last is None:
                status = "pending"
            elif state.streak >= FAILURES_BEFORE_DOWN:
                status = "down"
            else:
                status = "up"

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
                    )
                },
                "status": status,
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
                "recent": recent,
            }

    def summaries(self, now: float | None = None) -> list[dict]:
        now = time.time() if now is None else now
        return [self.summary(spec, now) for spec in self.store.all()]

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

        with self._lock:
            state = self._states.get(check_id) or _State()

            if raw:
                for t, ok, ms, _ in state.samples:
                    slot = int(t // width) * width
                    if slot in slots:
                        _add(slots[slot], ok, ms)
            else:
                for hour, bucket in state.buckets.items():
                    slot = int(hour // width) * width
                    if slot in slots:
                        _merge(slots[slot], bucket)

            uptime = self._uptime(state, now, window)

        points = [
            {
                "t": t,
                "n": b[0],
                "up": b[1],
                "ms_avg": round(b[2] / b[3], 1) if b[3] else None,
                "ms_max": round(b[4], 1) if b[3] else None,
            }
            for t, b in slots.items()
        ]
        return {"range": range_key, "bucket_seconds": width, "uptime": uptime, "points": points}

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
                    "streak": state.streak,
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
                state.streak = int(saved.get("streak") or 0)
                state.fail_since = saved.get("fail_since")
                if state.samples:
                    t, ok, ms, detail = state.samples[-1]
                    state.last = (t, ok, ms, detail)
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
