"""Who did what, kept for months.

The activity feed is a rolling view of the fleet (120 entries — hours);
this is the record of what *people and scripts* asked the dashboard to do.
Every request that changes something is written here by
``AuditMiddleware``, so a new route is covered without anyone remembering
to add a line. Things that aren't a single request — a shell session, a
job's outcome — call ``record`` themselves.

Beyond changes, a few **reads** are recorded too — the ones that expose
something: opening or downloading a file, downloading a container's log,
reading a journal or an agent's settings, watching a log stream. Actions
nobody clicked (a nightly update, an auto-rebalance move) are recorded
with who = "system".

Append-only JSON lines on the data volume. At ``MAX_BYTES`` the file is
archived under its start time; archives whose newest entry is older than
the retention period (Settings → History, a year by default) are deleted.
Entries carry identifiers — the path, container, host — never contents or
credentials: the body keys worth keeping are an allowlist.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from urllib.parse import unquote_plus

from backend.env import env_str

FILE = Path(env_str("AUDIT_FILE", "/data/audit.jsonl"))
MAX_BYTES = 5 * 1024 * 1024
MAX_ARCHIVES = 400  # a hard stop (~2 GB) whatever the retention says
MAX_BODY = 32 * 1024

# Body/query keys that identify what was acted on. Anything else in a body
# (file contents, passwords, compose text) is never written.
TARGET_KEYS = ("path", "container", "containers", "name", "host", "hosts", "app",
               "target", "service", "project", "network", "id", "overwrite", "pull")

# Reads worth a line: they hand over file contents, logs or settings.
READS = [
    re.compile(p) for p in (
        r"^/api/files/[^/]+/(text|download)$",
        r"^/api/containers/[^/]+/[^/]+/logs/download$",
        r"^/api/hosts/[^/]+/services/[^/]+/logs$",
        r"^/api/hosts/[^/]+/journal$",
        r"^/api/hosts/[^/]+/config$",
    )
]

# Routes that change nothing that matters to an audit: personal scratch
# (pins, notes, to-dos, weather), the agents' own registration heartbeat,
# and the halves of a passkey ceremony that only fetch a challenge.
QUIET = [
    re.compile(p) for p in (
        r"^/api/nodes$",  # POST: an agent registering itself every minute
        r"^/api/(pins|todos|notes)(/|$)",
        r"^/api/personal/",
        r"^/api/auth/.*/options$",
        r"^/api/compose/[^/]+/preview$",  # a dry run
        r"^/api/updates/[^/]+/check$",
    )
]

_lock = threading.Lock()


# --- describing an entry -----------------------------------------------------

_LABELS = [
    (r"^/api/files/[^/]+/text$", lambda m: "file opened"),  # GET; PUT is matched by method below
    (r"^/api/files/[^/]+/download$", lambda m: "file downloaded"),
    (r"^/api/containers/[^/]+/[^/]+/logs/download$", lambda m: "container log downloaded"),
    (r"^/api/hosts/[^/]+/services/[^/]+/logs$", lambda m: "service journal read"),
    (r"^/api/hosts/[^/]+/journal$", lambda m: "system journal read"),
    (r"^/api/hosts/[^/]+/config$", lambda m: "agent settings read"),
    (r"^/api/history/settings$", lambda m: "history settings changed"),
    (r"^/api/containers/[^/]+/[^/]+/(start|stop|restart)$", lambda m: f"container {m[1]}"),
    (r"^/api/compose/[^/]+/apply$", lambda m: "compose change applied"),
    (r"^/api/updates/[^/]+$", lambda m: "image update"),
    (r"^/api/files/[^/]+/upload$", lambda m: "file uploaded"),
    (r"^/api/files/[^/]+/rename$", lambda m: "renamed"),
    (r"^/api/files/[^/]+/mkdir$", lambda m: "folder created"),
    (r"^/api/disk/[^/]+/delete$", lambda m: "deleted"),
    (r"^/api/rebuild/[^/]+$", lambda m: "rebuild"),
    (r"^/api/fleet/rebuild$", lambda m: "fleet rebuild"),
    (r"^/api/hosts/[^/]+/power$", lambda m: "host power"),
    (r"^/api/hosts/[^/]+/services/", lambda m: "service action"),
    (r"^/api/hosts/[^/]+/os-updates", lambda m: "OS update"),
    (r"^/api/networks/", lambda m: "network change"),
    (r"^/api/deployments", lambda m: "deployment change"),
    (r"^/api/stacks", lambda m: "stack change"),
    (r"^/api/backups", lambda m: "backup change"),
    (r"^/api/checks", lambda m: "service check change"),
    (r"^/api/nodes/", lambda m: "node removed"),
    (r"^/api/auth/login/verify$", lambda m: "signed in"),
    (r"^/api/auth/register/verify$", lambda m: "passkey added"),
    (r"^/api/auth/elevate/verify$", lambda m: "confirmed with passkey"),
    (r"^/api/auth/logout$", lambda m: "signed out"),
    (r"^/api/auth/passkeys/", lambda m: "passkey changed"),
    (r"^/api/service-activity-credentials", lambda m: "app credentials changed"),
    (r"^/api/notify", lambda m: "notification settings"),
]
_LABELS = [(re.compile(p), f) for p, f in _LABELS]

_HOST = re.compile(r"^/api/(?:containers|compose|updates|files|disk|rebuild|hosts|networks)/([^/]+)")


_WRITES = {  # the same path, changing rather than reading
    "file opened": "file edited",
    "agent settings read": "agent settings changed",
}


def describe(method: str, path: str) -> tuple[str, str | None]:
    """``(action, host)`` in words, for the log and its viewer."""
    action = next((f(m) for rx, f in _LABELS if (m := rx.match(path))), f"{method} {path}")
    if method not in ("GET", "HEAD"):
        action = _WRITES.get(action, action)
    host = _HOST.match(path)
    return action, host[1] if host else None


def _targets(query: str, body: bytes) -> dict:
    out = {}
    for part in query.split("&"):
        key, _, value = part.partition("=")
        if key in TARGET_KEYS and value:
            out[key] = unquote_plus(value)[:300]
    if body and len(body) <= MAX_BODY:
        try:
            data = json.loads(body)
        except ValueError:
            data = None
        if isinstance(data, dict):
            for key in TARGET_KEYS:
                if key in data and isinstance(data[key], (str, int, float, bool, list)):
                    value = data[key]
                    out[key] = value[:50] if isinstance(value, list) else (
                        str(value)[:300] if not isinstance(value, bool) else value
                    )
    return out


# --- writing and reading -----------------------------------------------------


def _archives() -> list[Path]:
    """Archived files, newest first (named by when they were archived)."""
    return sorted(FILE.parent.glob(FILE.stem + ".*.jsonl"), reverse=True)


def _last_at(path: Path) -> float:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4096))
            tail = f.read().decode("utf-8", "replace").strip().splitlines()
        return json.loads(tail[-1]).get("at", 0) if tail else 0
    except (OSError, ValueError):
        return 0


def prune() -> int:
    """Delete archives entirely older than the retention period. Returns
    how many went."""
    from backend import history_settings

    days = history_settings.get()["audit_days"]
    cutoff = time.time() - days * 86400 if days else None
    gone = 0
    for i, path in enumerate(_archives()):
        if i >= MAX_ARCHIVES or (cutoff and _last_at(path) < cutoff):
            try:
                path.unlink()
                gone += 1
            except OSError:
                pass
    return gone


def _rotate() -> None:
    if not FILE.exists() or FILE.stat().st_size < MAX_BYTES:
        return
    # Named by time (so they sort), never over an existing archive.
    stamp = int(time.time() * 1000)
    while (target := FILE.with_name(f"{FILE.stem}.{stamp}.jsonl")).exists():
        stamp += 1
    FILE.rename(target)
    prune()


def record(action: str, *, who: str, host: str | None = None, ok: bool = True,
           target: dict | None = None, detail: str | None = None, ip: str | None = None,
           status: int | None = None, ms: int | None = None) -> None:
    entry = {"at": round(time.time(), 3), "who": who, "action": action, "host": host, "ok": ok}
    for key, value in (("target", target), ("detail", detail), ("ip", ip),
                       ("status", status), ("ms", ms)):
        if value:
            entry[key] = value
    line = json.dumps(entry, separators=(",", ":")) + "\n"
    with _lock:
        try:
            FILE.parent.mkdir(parents=True, exist_ok=True)
            _rotate()
            with open(FILE, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError:
            pass  # a full disk must not take the dashboard down with it


def read(limit: int = 200, before: float | None = None, q: str | None = None) -> list[dict]:
    """Newest first, across the rotated files."""
    needle = (q or "").lower().strip()
    out: list[dict] = []
    for path in [FILE, *_archives()]:
        if not path.exists():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if before is not None and entry.get("at", 0) >= before:
                continue
            if needle and needle not in line.lower():
                continue
            out.append(entry)
            if len(out) >= limit:
                return out
    return out


# --- who is asking -------------------------------------------------------------


def who_from_headers(headers: dict) -> str:
    """The passkey's name for a session, "API token" for a script, else
    "anonymous" (login is off)."""
    from backend import auth, passkeys

    for part in headers.get("cookie", "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == passkeys.SESSION_COOKIE and passkeys.store.check_session(value):
            return passkeys.store.session_device(value) or "signed in"
    token = headers.get("x-register-token")
    if token and auth.API_TOKEN and auth.token_matches(token):
        return "API token"
    return "anonymous"


def ip_from_headers(headers: dict, client) -> str | None:
    forwarded = headers.get("x-forwarded-for") or headers.get("x-real-ip")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return client[0] if client else None


class AuditMiddleware:
    """Records every mutating ``/api`` request after it's answered."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        reading = scope.get("method") in ("GET", "HEAD", "OPTIONS")
        if (
            scope["type"] != "http"
            or not path.startswith("/api/")
            or (reading and not (scope.get("method") == "GET" and any(rx.match(path) for rx in READS)))
            or (not reading and any(rx.search(path) for rx in QUIET))
        ):
            return await self.app(scope, receive, send)

        body = bytearray()
        started = time.monotonic()
        status = {"code": None}

        async def peek():
            message = await receive()
            if message["type"] == "http.request" and len(body) <= MAX_BODY:
                body.extend(message.get("body", b""))
            return message

        async def watch(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, peek, watch)
        finally:
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
            action, host = describe(scope["method"], scope["path"])
            code = status["code"]
            record(
                action,
                who=who_from_headers(headers),
                host=host,
                ok=code is not None and code < 400,
                target=_targets(scope.get("query_string", b"").decode("latin-1"), bytes(body)),
                ip=ip_from_headers(headers, scope.get("client")),
                status=code,
                ms=int((time.monotonic() - started) * 1000),
            )
