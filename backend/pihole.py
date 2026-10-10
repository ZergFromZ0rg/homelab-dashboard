"""Pi-hole collector, plus the few changes the dashboard can make to it.

Logs in once with an app password, reuses the session id until it expires
(Pi-hole caps concurrent sessions, so never one login per request), and
caches the last good answers. The browser and the agent read the cache;
neither talks to Pi-hole. A failed poll keeps the previous data and flags it
stale, so a collector problem is not mistaken for a network problem.

Changes are a short list, each one a button somebody clicks: pause or resume
blocking, move a device between groups, allow or un-allow a domain.

Configured by ``PIHOLE_URL`` and ``PIHOLE_APP_PASSWORD`` (server-side only).
"""

from __future__ import annotations

import asyncio
import threading
import time

import requests

from backend.env import env_float, env_str
from backend.log import system as log

FAST_SECONDS = env_float("PIHOLE_POLL_SECONDS", 60)  # summary, leases, blocking, health
SLOW_SECONDS = env_float("PIHOLE_DEVICES_SECONDS", 300)  # devices
TIMEOUT = 8
# Longer than this since the last good poll and the data is called stale.
STALE_AFTER = 3 * FAST_SECONDS


class PiholeError(Exception):
    """``status`` is Pi-hole's HTTP status when it answered, else None."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


# Query statuses that mean "Pi-hole refused to answer" — the ones its own
# "blocked" counters add up. SPECIAL_DOMAIN is the surprising one: names Pi-hole
# refuses on purpose (iCloud Private Relay, Firefox's canary domain,
# _dns.resolver.arpa) are most of a typical household's "blocked".
BLOCKED = {
    "GRAVITY", "REGEX", "DENYLIST", "GRAVITY_CNAME", "REGEX_CNAME", "DENYLIST_CNAME",
    "EXTERNAL_BLOCKED_IP", "EXTERNAL_BLOCKED_NULL", "EXTERNAL_BLOCKED_NXRA", "SPECIAL_DOMAIN",
}
# Of those, the ones the allow list can lift. A special domain is switched by a
# setting, not a list, so offering "Allow" for it would do nothing.
ALLOWABLE = BLOCKED - {"SPECIAL_DOMAIN", "EXTERNAL_BLOCKED_IP", "EXTERNAL_BLOCKED_NULL", "EXTERNAL_BLOCKED_NXRA"}
DETAIL_QUERIES = 1000  # how much of the query log one device's detail reads
DETAIL_TTL = 20.0
CLIENT_HISTORY_TTL = 120.0


class Pihole:
    def __init__(self, url: str = "", password: str = ""):
        self.url = (url or env_str("PIHOLE_URL")).rstrip("/")
        self.password = password or env_str("PIHOLE_APP_PASSWORD")
        self._sid: str | None = None
        self._sid_until = 0.0
        self._lock = threading.Lock()  # the cached state below
        self._io = threading.Lock()  # one request on the shared session at a time
        self._data: dict = {}
        self._devices: list[dict] = []
        self._extras: dict = {}  # clients (comments, groups), static leases, per-client counts
        self._devices_at = 0.0
        self._ok_at = 0.0
        self._error: str | None = None
        self._fail_since: float | None = None  # start of the current outage, if any
        self._history: list[tuple[float, int, int]] = []  # (bucket start, total, blocked), 10 min each
        self._detail_cache: dict[str, tuple[float, dict]] = {}
        self._client_history: tuple[float, dict] | None = None

    @property
    def configured(self) -> bool:
        return bool(self.url and self.password)

    # --- transport -------------------------------------------------------------

    def _login(self) -> None:
        try:
            response = requests.post(
                f"{self.url}/api/auth", json={"password": self.password}, timeout=TIMEOUT
            )
            body = response.json()
        except (requests.RequestException, ValueError) as error:
            raise PiholeError(f"can't reach Pi-hole: {error}") from error
        session = body.get("session") if isinstance(body, dict) else None
        if not isinstance(session, dict) or not session.get("valid") or not session.get("sid"):
            raise PiholeError("Pi-hole rejected the app password")
        self._sid = session["sid"]
        # Renew a minute early rather than ride the session to its last second.
        self._sid_until = time.time() + max(60, float(session.get("validity") or 300)) - 60

    def request(self, method: str, path: str, params: dict | None = None, body: dict | None = None) -> dict:
        """One authenticated request on the shared session; logs in again on 401."""
        with self._io:
            for attempt in (0, 1):
                if not self._sid or time.time() >= self._sid_until:
                    self._login()
                try:
                    response = requests.request(
                        method, f"{self.url}{path}", params=params or None, json=body,
                        headers={"sid": self._sid}, timeout=TIMEOUT,
                    )
                except requests.RequestException as error:
                    raise PiholeError(f"can't reach Pi-hole: {error}") from error
                if response.status_code == 401 and attempt == 0:
                    self._sid = None
                    continue
                if not response.ok:
                    raise PiholeError(_reason(response, path), response.status_code)
                if response.status_code == 204:
                    return {}
                try:
                    parsed = response.json()
                except ValueError as error:
                    raise PiholeError(f"Pi-hole sent something unreadable for {path}") from error
                return parsed if isinstance(parsed, dict) else {}
        raise PiholeError("Pi-hole kept refusing the session")

    def get(self, path: str, **params) -> dict:
        return self.request("GET", path, params)

    # --- polling ---------------------------------------------------------------

    def poll_fast(self) -> None:
        try:
            summary = self.get("/api/stats/summary")
            leases = self.get("/api/dhcp/leases").get("leases") or []
            blocking = self.get("/api/dns/blocking")
            ftl = self.get("/api/info/ftl").get("ftl") or {}
            version = self.get("/api/info/version").get("version") or {}
        except PiholeError as error:
            with self._lock:
                if str(error) != self._error:
                    log.warning("pihole: %s", error)
                self._error = str(error)
                self._fail_since = self._fail_since or time.time()
            return
        queries = summary.get("queries") or {}
        data = {
            "summary": {
                "total": queries.get("total", 0),
                "blocked": queries.get("blocked", 0),
                "percent_blocked": round(float(queries.get("percent_blocked") or 0), 1),
                "active_clients": (summary.get("clients") or {}).get("active", 0),
                "gravity_domains": (summary.get("gravity") or {}).get("domains_being_blocked", 0),
            },
            "blocking": {
                "enabled": blocking.get("blocking") == "enabled",
                "state": blocking.get("blocking"),
                "timer": blocking.get("timer"),
            },
            "leases": [
                {"mac": (lease.get("hwaddr") or "").lower(), "ip": lease.get("ip"),
                 "name": lease.get("name") or "", "expires": lease.get("expires")}
                for lease in leases if isinstance(lease, dict)
            ],
            "health": {
                "uptime": ftl.get("uptime"),
                "mem_percent": ftl.get("%mem"),
                "cpu_percent": ftl.get("%cpu"),
                "versions": {part: _local(version.get(part)) for part in _PARTS},
                "update_available": [part for part in _PARTS if _outdated(version.get(part))],
            },
        }
        with self._lock:
            self._data = data
            self._ok_at = time.time()
            self._error = None
            self._fail_since = None

    def poll_devices(self) -> None:
        try:
            devices = self.get("/api/network/devices", max_devices=100).get("devices") or []
            extras = self._poll_extras()
            history = self.get("/api/history").get("history") or []
        except PiholeError as error:
            with self._lock:
                self._error = str(error)
            return
        rows = []
        for device in devices:
            if not isinstance(device, dict):
                continue
            ips = [i for i in device.get("ips") or [] if isinstance(i, dict) and i.get("ip")]
            rows.append({
                "mac": (device.get("hwaddr") or "").lower(),
                "vendor": device.get("macVendor") or "",
                "first_seen": device.get("firstSeen"),
                "last_query": device.get("lastQuery"),
                "queries": device.get("numQueries") or 0,
                "ips": [{"ip": i["ip"], "name": i.get("name") or "", "last_seen": i.get("lastSeen")} for i in ips],
            })
        with self._lock:
            self._devices = rows
            self._extras = extras
            self._history = [
                (h["timestamp"], h.get("total") or 0, h.get("blocked") or 0)
                for h in history if isinstance(h, dict) and "timestamp" in h
            ]
            self._devices_at = time.time()

    def _poll_extras(self) -> dict:
        """What the device table needs beyond the device list: the comments and
        groups you gave clients in Pi-hole, your static leases, and how much
        each address asked and was blocked. Each is best-effort — a Pi-hole
        without one of them just leaves that column empty."""
        extras: dict = {"clients": {}, "groups": {}, "static": [], "queries": {}, "blocked": {}}

        def best_effort(fn):
            try:
                fn()
            except PiholeError as error:
                log.info("pihole: some device details unavailable (%s)", error)

        def clients():
            for client in self.get("/api/clients").get("clients") or []:
                if isinstance(client, dict) and client.get("client"):
                    extras["clients"][client["client"].lower()] = {
                        "comment": client.get("comment") or "", "groups": client.get("groups") or [],
                    }
            for group in self.get("/api/groups").get("groups") or []:
                if isinstance(group, dict) and "id" in group:
                    extras["groups"][group["id"]] = group.get("name") or ""

        def static_leases():
            dhcp = (self.get("/api/config/dhcp").get("config") or {}).get("dhcp") or {}
            for entry in dhcp.get("hosts") or []:
                mac, _, rest = str(entry).partition(",")
                ip, _, name = rest.partition(",")
                if mac and ip:
                    extras["static"].append({"mac": mac.strip().lower(), "ip": ip.strip(), "name": name.strip()})

        def counts():
            for key, params in (("queries", {}), ("blocked", {"blocked": "true"})):
                for client in self.get("/api/stats/top_clients", count=200, **params).get("clients") or []:
                    if isinstance(client, dict) and client.get("ip"):
                        extras[key][client["ip"]] = client.get("count") or 0

        for fn in (clients, static_leases, counts):
            best_effort(fn)
        return extras

    def refresh(self) -> None:
        """Poll what is due. Blocking: call it from a thread."""
        if not self.configured:
            return
        self.poll_fast()
        if time.time() - self._devices_at >= SLOW_SECONDS and self._ok_at:
            self.poll_devices()

    # --- reading ---------------------------------------------------------------

    def snapshot(self) -> dict:
        with self._lock:
            if not self.configured:
                return {"configured": False}
            now = time.time()
            return {
                "configured": True,
                "reachable": self._error is None and self._ok_at > 0,
                "error": self._error,
                "stale": bool(self._ok_at) and now - self._ok_at > STALE_AFTER,
                "updated_at": self._ok_at or None,
                "url": self.url,
                **self._data,
                "devices_total": len(self._devices),
                "leases_total": len(self._data.get("leases") or []),
            }

    def history(self) -> list[tuple[float, int, int]]:
        with self._lock:
            return list(self._history)

    def down_for(self, now: float | None = None) -> float | None:
        """Seconds Pi-hole has been unreachable, or None while it answers."""
        with self._lock:
            return None if self._fail_since is None else (now or time.time()) - self._fail_since

    # --- one device, on demand -------------------------------------------------

    def device_detail(self, ip: str) -> dict:
        """What one address has been up to: its query rate through the day,
        what it asked for most, what got blocked, and the latest queries.
        Reads the query log, the heaviest endpoint, so only when a device is
        opened, and cached for a few seconds."""
        now = time.time()
        with self._lock:
            hit = self._detail_cache.get(ip)
            if hit and now - hit[0] < DETAIL_TTL:
                return hit[1]
        queries = self.get("/api/queries", client_ip=ip, length=DETAIL_QUERIES).get("queries") or []
        asked: dict[str, int] = {}
        refused: dict[str, int] = {}
        liftable: dict[str, bool] = {}
        recent = []
        for q in queries:
            if not isinstance(q, dict) or not q.get("domain"):
                continue
            blocked = q.get("status") in BLOCKED
            asked[q["domain"]] = asked.get(q["domain"], 0) + 1
            if blocked:
                refused[q["domain"]] = refused.get(q["domain"], 0) + 1
                liftable[q["domain"]] = q.get("status") in ALLOWABLE
            recent.append({
                "time": q.get("time"), "domain": q["domain"], "type": q.get("type"),
                "status": q.get("status"), "blocked": blocked,
                "allowable": blocked and q.get("status") in ALLOWABLE,
            })
        recent.sort(key=lambda r: r["time"] or 0, reverse=True)

        def top(counts: dict[str, int]) -> list[dict]:
            return [
                {"domain": d, "count": c, "allowable": liftable.get(d, False)}
                for d, c in sorted(counts.items(), key=lambda kv: -kv[1])[:10]
            ]

        detail = {
            "ip": ip,
            "sample": len(recent),
            "since": min((r["time"] for r in recent if r["time"]), default=None),
            "blocked_sample": sum(1 for r in recent if r["blocked"]),
            "top_blocked": top(refused),
            "top_domains": top(asked),
            "recent": recent[:40],
            "series": self._series(ip),
        }
        with self._lock:
            self._detail_cache[ip] = (now, detail)
            if len(self._detail_cache) > 50:
                self._detail_cache.pop(next(iter(self._detail_cache)))
        return detail

    def _series(self, ip: str) -> list[dict]:
        """Queries per 10 minutes for one address over the last day. Pi-hole
        names its eight busiest addresses and lumps the rest as "others", so a
        quiet device has no line of its own: an empty list, not a guess."""
        now = time.time()
        with self._lock:
            cached = self._client_history
        if not cached or now - cached[0] > CLIENT_HISTORY_TTL:
            try:
                cached = (now, self.get("/api/history/clients"))
            except PiholeError:
                cached = cached or (now, {})
            with self._lock:
                self._client_history = cached
        rows = (cached[1].get("history") or [])
        if not any(ip in (r.get("data") or {}) for r in rows[-3:]):
            return []
        return [{"t": r["timestamp"], "v": (r.get("data") or {}).get(ip, 0)} for r in rows if "timestamp" in r]

    # --- changes ---------------------------------------------------------------

    def set_blocking(self, enabled: bool, seconds: int | None = None) -> dict:
        """Turn blocking on, or off — for ``seconds`` if given, else until turned back on."""
        body = {"blocking": bool(enabled), "timer": int(seconds) if (seconds and not enabled) else None}
        result = self.request("POST", "/api/dns/blocking", body=body)
        self.poll_fast()
        return result

    def set_client_groups(self, mac: str, groups: list[int]) -> None:
        """Put a device in these groups. A device Pi-hole has no client entry for
        gets one; the comment you already gave it is kept."""
        mac = mac.lower()
        current = self.get("/api/clients").get("clients") or []
        entry = next((c for c in current if (c.get("client") or "").lower() == mac), None)
        if entry:
            self.request("PUT", f"/api/clients/{entry['client']}", body={"comment": entry.get("comment") or "", "groups": groups})
        else:
            self.request("POST", "/api/clients", body={"client": mac.upper(), "comment": "", "groups": groups})
        with self._lock:
            self._devices_at = 0.0  # re-read clients on the next refresh

    def allow_domain(self, domain: str, comment: str = "") -> None:
        self.request("POST", "/api/domains/allow/exact", body={
            "domain": domain, "comment": comment or "allowed from the dashboard", "groups": [0], "enabled": True,
        })

    def unallow_domain(self, domain: str) -> None:
        self.request("DELETE", f"/api/domains/allow/exact/{domain}")

    def devices(self) -> list[dict]:
        with self._lock:
            return list(self._devices)

    def device_inputs(self) -> dict:
        """Everything the device table merges, copied under the lock."""
        with self._lock:
            return {
                "devices": list(self._devices),
                "leases": list(self._data.get("leases") or []),
                "extras": dict(self._extras),
                "updated_at": self._devices_at or None,
            }


def _reason(response, path: str) -> str:
    """Pi-hole's own explanation when it gave one: {"error": {"message": ...}}."""
    try:
        error = response.json().get("error") or {}
        message = error.get("message") if isinstance(error, dict) else None
    except (ValueError, AttributeError):
        message = None
    return f"Pi-hole refused: {message}" if message else f"Pi-hole answered {response.status_code} for {path}"


_PARTS = ("core", "web", "ftl", "docker")


def _version(value) -> str | None:
    """core/web/ftl nest ``{"version": ...}``; docker is a bare string."""
    return value.get("version") if isinstance(value, dict) else value


def _local(part) -> str | None:
    return _version(part.get("local")) if isinstance(part, dict) else None


def _outdated(part) -> bool:
    if not isinstance(part, dict):
        return False
    local, remote = _version(part.get("local")), _version(part.get("remote"))
    return bool(local and remote and local != remote)


collector = Pihole()


async def run_forever() -> None:
    if not collector.configured:
        log.info("pihole: PIHOLE_URL / PIHOLE_APP_PASSWORD not set, collector idle")
        return
    while True:
        await asyncio.to_thread(collector.refresh)
        await asyncio.sleep(FAST_SECONDS)
