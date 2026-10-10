"""Read-only Pi-hole collector.

Logs in once with an app password, reuses the session id until it expires
(Pi-hole caps concurrent sessions, so never one login per request), and
caches the last good answers. The browser and the agent read the cache;
neither talks to Pi-hole. A failed poll keeps the previous data and flags it
stale, so a collector problem is not mistaken for a network problem.

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
    pass


class Pihole:
    def __init__(self, url: str = "", password: str = ""):
        self.url = (url or env_str("PIHOLE_URL")).rstrip("/")
        self.password = password or env_str("PIHOLE_APP_PASSWORD")
        self._sid: str | None = None
        self._sid_until = 0.0
        self._lock = threading.Lock()
        self._data: dict = {}
        self._devices: list[dict] = []
        self._extras: dict = {}  # clients (comments, groups), static leases, per-client counts
        self._devices_at = 0.0
        self._ok_at = 0.0
        self._error: str | None = None

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

    def get(self, path: str, **params) -> dict:
        """One authenticated GET on the shared session; logs in again on 401."""
        with self._lock:
            for attempt in (0, 1):
                if not self._sid or time.time() >= self._sid_until:
                    self._login()
                try:
                    response = requests.get(
                        f"{self.url}{path}", params=params or None,
                        headers={"sid": self._sid}, timeout=TIMEOUT,
                    )
                except requests.RequestException as error:
                    raise PiholeError(f"can't reach Pi-hole: {error}") from error
                if response.status_code == 401 and attempt == 0:
                    self._sid = None
                    continue
                if not response.ok:
                    raise PiholeError(f"Pi-hole answered {response.status_code} for {path}")
                try:
                    body = response.json()
                except ValueError as error:
                    raise PiholeError(f"Pi-hole sent something unreadable for {path}") from error
                return body if isinstance(body, dict) else {}
        raise PiholeError("Pi-hole kept refusing the session")

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

    def poll_devices(self) -> None:
        try:
            devices = self.get("/api/network/devices", max_devices=100).get("devices") or []
            extras = self._poll_extras()
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
