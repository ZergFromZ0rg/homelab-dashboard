"""The internet connection itself, read from the router.

Routers that have UPnP on (most do) answer a few read-only questions about
their WAN side without a login: is the link up, how fast is it, what is the
public address, and how many bytes have crossed it. The byte counters are the
point. They count *everything* going out to or coming from the internet,
Wi-Fi devices included, which the switch can't see: a phone on the router's own
Wi-Fi is routed straight out of the router and never touches a switch port.
(Measured on this network: 46 MB downloaded in two minutes, 0.3 MB of it to
anything on the switch.)

Nothing here changes the router. The only requests are UPnP "Get" calls to the
router's own address, found by asking the default gateway (SSDP, unicast) and
never followed anywhere else.

The counters are 32-bit, so they wrap every ~4 GB (5 minutes at 100 Mbit); a
poll every 15 seconds always catches a wrap, and a counter that went down by
more than a wrap could explain is a reboot. What is kept: a two-hour ring of
rates for the live view, and ten-minute byte buckets for 90 days, so the totals
are exact sums, not rates guessed from samples.

  ROUTER_IP         the router's address; default: the hosts' default gateway
  WAN_UPNP_URL      the router's UPnP description URL, if discovery can't find it
  WAN_FILE          where the buckets are kept (default /data/wan.json)
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import threading
import time
import xml.etree.ElementTree as ET
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

from backend.env import env_float, env_str
from backend.jsonstore import read_json, write_json_atomic
from backend.log import system as log

WAN_FILE = Path(env_str("WAN_FILE", "/data/wan.json"))
POLL_SECONDS = 15
LINK_EVERY = 60  # the link and address change rarely; counters are every poll
RETRY_SECONDS = 300  # a router that doesn't answer is asked again this often
TIMEOUT = 5
BUCKET = 600
RETENTION = 90 * 86400
RING = 2 * 3600 // POLL_SECONDS + 8
PERSIST_EVERY = 300
WRAP = 2 ** 32
MAX_XML = 256 * 1024

# range -> (seconds shown, step). Two hours come from the live ring; longer
# ranges from the ten-minute buckets, so none is finer than ten minutes.
RANGES = {
    "2h": (2 * 3600, 60),
    "24h": (86400, 600),
    "7d": (7 * 86400, 1800),
    "30d": (30 * 86400, 7200),
    "90d": (90 * 86400, 21600),
}
DEFAULT_RANGE = "2h"

FULL_PERCENT = env_float("WAN_FULL_PERCENT", 90) / 100
FULL_MINUTES = 10
DOWN_POLLS = 3  # the link must be reported down this many polls in a row (45 s)

SERVICES = {
    "common": "urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1",
    "ip": "urn:schemas-upnp-org:service:WANIPConnection:1",
    "ppp": "urn:schemas-upnp-org:service:WANPPPConnection:1",
}


class WanError(Exception):
    pass


# ---- counters -----------------------------------------------------------------


def delta(old: int, new: int, max_bytes: float) -> int:
    """Bytes between two readings of a 32-bit counter. ``max_bytes`` is the most
    the link could have moved in the time between them: a counter that went
    down by more than that could be a wrap is a reboot, which restarts at 0."""
    if new >= old:
        return new - old
    wrapped = new + WRAP - old
    return wrapped if wrapped <= max_bytes else new


# ---- talking to the router -------------------------------------------------------


def _text(url: str) -> str:
    response = requests.get(url, timeout=TIMEOUT, stream=True)
    response.raise_for_status()
    body = response.raw.read(MAX_XML + 1, decode_content=True)
    if len(body) > MAX_XML:
        raise WanError("the router's description is too large")
    return body.decode("utf-8", "replace")


def _ssdp(ip: str) -> str | None:
    """The router's UPnP description URL, by asking it directly (unicast)."""
    message = "\r\n".join([
        "M-SEARCH * HTTP/1.1", "HOST: 239.255.255.250:1900", 'MAN: "ssdp:discover"', "MX: 2",
        "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1", "", "",
    ]).encode()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2)
    try:
        sock.sendto(message, (ip, 1900))
        data, _ = sock.recvfrom(4096)
    except OSError:
        return None
    finally:
        sock.close()
    match = re.search(rb"(?im)^location:\s*(\S+)", data)
    return match.group(1).decode("ascii", "replace") if match else None


# Where routers usually serve their UPnP description. SSDP is the proper way to
# find it, but a router answers from a different UDP port than it was asked on, and
# Docker's address translation drops that reply, so from inside a container the
# direct, unicast ask can come back empty even though the router is listening.
COMMON_DESCRIPTIONS = tuple(
    (port, path)
    for port in (49152, 5000, 52869, 49153, 2869, 1900, 8000, 37215)
    for path in ("InternetGatewayDevice.xml", "rootDesc.xml", "picsdesc.xml", "igd.xml")
)
PROBE_TIMEOUT = 1.5


def _is_gateway_description(url: str) -> bool:
    try:
        response = requests.get(url, timeout=PROBE_TIMEOUT, stream=True)
        if not response.ok:
            return False
        head = response.raw.read(65536, decode_content=True)
        response.close()
    except requests.RequestException:
        return False
    return b"InternetGatewayDevice" in head


def _probe(ip: str) -> str | None:
    urls = [f"http://{ip}:{port}/{path}" for port, path in COMMON_DESCRIPTIONS]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for url, found in zip(urls, pool.map(_is_gateway_description, urls)):
            if found:
                return url
    return None


def _services(xml: str, base: str) -> dict[str, str]:
    """service kind -> control URL, from a UPnP device description."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as error:
        raise WanError(f"the router's description isn't readable: {error}") from error
    found: dict[str, str] = {}
    for service in root.iter():
        if not service.tag.endswith("service"):
            continue
        fields = {child.tag.rsplit("}", 1)[-1]: (child.text or "").strip() for child in service}
        for kind, urn in SERVICES.items():
            if fields.get("serviceType") == urn and fields.get("controlURL"):
                found.setdefault(kind, urljoin(base, fields["controlURL"]))
    return found


class Router:
    """One router's WAN side, over UPnP. Read-only."""

    def __init__(self, ip: str, description: str | None = None):
        self.ip = ip
        self.description = description
        self.controls: dict[str, str] = {}

    def discover(self) -> None:
        location = self.description or _ssdp(self.ip) or _probe(self.ip)
        if not location:
            raise WanError(f"{self.ip} doesn't answer UPnP (it may be off in the router's settings)")
        # Only ever talk to the router itself, wherever a reply says to look.
        if urlparse(location).hostname != self.ip or urlparse(location).scheme != "http":
            raise WanError("the router's UPnP description points somewhere else; ignoring it")
        self.controls = {kind: url for kind, url in _services(_text(location), location).items()
                         if urlparse(url).hostname == self.ip and urlparse(url).scheme == "http"}
        if "common" not in self.controls:
            raise WanError("the router has no WAN counters over UPnP")

    def _call(self, kind: str, action: str) -> dict[str, str]:
        url = self.controls[kind]
        urn = SERVICES[kind]
        body = (
            '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
            f'<u:{action} xmlns:u="{urn}"/></s:Body></s:Envelope>'
        )
        try:
            response = requests.post(url, data=body, timeout=TIMEOUT, headers={
                "Content-Type": 'text/xml; charset="utf-8"', "SOAPAction": f'"{urn}#{action}"'})
            response.raise_for_status()
        except requests.RequestException as error:
            raise WanError(f"{action}: {error}") from error
        return dict(re.findall(r"<(New\w+)>([^<]*)</\1>", response.text[:MAX_XML]))

    def counters(self) -> tuple[int, int]:
        try:
            rx = int(self._call("common", "GetTotalBytesReceived")["NewTotalBytesReceived"])
            tx = int(self._call("common", "GetTotalBytesSent")["NewTotalBytesSent"])
        except (KeyError, ValueError) as error:
            raise WanError("the router's byte counters weren't numbers") from error
        return rx, tx

    def link(self) -> dict:
        props = self._call("common", "GetCommonLinkProperties")
        speeds = [int(props[k]) for k in ("NewLayer1UpstreamMaxBitRate", "NewLayer1DownstreamMaxBitRate")
                  if props.get(k, "").isdigit() and int(props[k]) > 0]
        out = {
            "up": (props.get("NewPhysicalLinkStatus") or "").lower() != "down",
            "mbps": round(min(speeds) / 1e6) if speeds else None,
            "kind": props.get("NewWANAccessType"),
            "address": None,
        }
        for kind in ("ip", "ppp"):
            if kind in self.controls:
                try:
                    out["address"] = self._call(kind, "GetExternalIPAddress").get("NewExternalIPAddress") or None
                except WanError:
                    pass
                break
        return out


def find_router_ip() -> str | None:
    """The router: ``ROUTER_IP``, else the default gateway the hosts report."""
    configured = env_str("ROUTER_IP")
    if configured:
        return configured
    from backend.lan_api import lan_nodes  # not at import time: main imports this module

    gateways = [g for g in (lan_nodes().get("gateways") or {}).values() if g]
    return Counter(gateways).most_common(1)[0][0] if gateways else None


def _private(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


# ---- what is kept ------------------------------------------------------------------


class Wan:
    def __init__(self, path: Path | None = None, clock=time.time, connect=None):
        self.path = Path(path or WAN_FILE)
        self._clock = clock
        self._connect = connect or self._find
        self._lock = threading.Lock()
        self._router: Router | None = None
        self._retry_at = 0.0
        self.error: str | None = None
        self.link: dict | None = None
        self._link_at = 0.0
        self._down_polls = 0
        self.ring: deque = deque(maxlen=RING)  # (t, rx_bps, tx_bps)
        self.buckets: dict[int, list] = {}  # start -> [rx bytes, tx bytes, rx peak bps, tx peak bps]
        self.last: tuple[float, int, int] | None = None
        self._saved_at = 0.0
        self._load()

    # -- connecting --

    @staticmethod
    def _find() -> Router:
        description = env_str("WAN_UPNP_URL") or None
        ip = (urlparse(description).hostname if description else None) or find_router_ip()
        if not ip or not _private(ip):
            raise WanError("no router address: set ROUTER_IP if the hosts don't report a gateway")
        router = Router(ip, description)
        router.discover()
        return router

    # -- polling --

    def poll(self) -> None:
        now = self._clock()
        if self._router is None:
            if now < self._retry_at:
                return
            try:
                self._router = self._connect()
            except WanError as failure:
                # Not answering UPnP is a setting or a wrong address: asking every 15 seconds helps nobody.
                self.error, self._retry_at = str(failure), now + RETRY_SECONDS
                return
        try:
            self._read(self._router, now)
            self.error = None
        except WanError as failure:
            # Ask again from scratch next time: the router may have restarted on another port.
            self.error, self._router = str(failure), None
            log.debug("wan poll failed: %s", failure)

    def _read(self, router: Router, now: float) -> None:
        if self.link is None or now - self._link_at >= LINK_EVERY:
            link = router.link()
            with self._lock:
                self.link, self._link_at = link, now
                self._down_polls = 0 if link["up"] else self._down_polls + 1
        rx, tx = router.counters()
        self.record(now, rx, tx)

    def record(self, now: float, rx: int, tx: int) -> None:
        with self._lock:
            if self.last is not None and now - self.last[0] > 0:
                t0, rx0, tx0 = self.last
                dt = now - t0
                # Faster than the line can go means a wrap has been misread; cap what one
                # gap can add to what the link could have carried.
                cap = (((self.link or {}).get("mbps") or 1000) * 1e6 / 8) * dt
                drx, dtx = delta(rx0, rx, cap), delta(tx0, tx, cap)
                if dt <= BUCKET:  # a long gap (dashboard down) is not smeared into one slot
                    bucket = self.buckets.setdefault(int(now // BUCKET) * BUCKET, [0, 0, 0.0, 0.0])
                    bucket[0] += drx
                    bucket[1] += dtx
                    bucket[2] = max(bucket[2], drx * 8 / dt)
                    bucket[3] = max(bucket[3], dtx * 8 / dt)
                    self.ring.append((now, drx * 8 / dt, dtx * 8 / dt))
                for start in [s for s in self.buckets if s < now - RETENTION]:
                    del self.buckets[start]
            self.last = (now, rx, tx)
        self._maybe_save(now)

    # -- reading --

    def rate(self, seconds: float, now: float | None = None) -> tuple[float | None, float | None]:
        """Average (rx, tx) bits/s over the last ``seconds`` of live samples."""
        now = self._clock() if now is None else now
        with self._lock:
            rows = [r for r in self.ring if now - r[0] <= seconds]
        if not rows:
            return None, None
        return sum(r[1] for r in rows) / len(rows), sum(r[2] for r in rows) / len(rows)

    def steady_rate(self, seconds: float, now: float | None = None) -> tuple[float | None, float | None]:
        """Like ``rate``, but only once most of the window has samples, so a
        few busy seconds right after a restart are not an average."""
        now = self._clock() if now is None else now
        with self._lock:
            have = sum(1 for r in self.ring if now - r[0] <= seconds)
        if have < 0.8 * seconds / POLL_SECONDS:
            return None, None
        return self.rate(seconds, now)

    def totals(self, seconds: float, now: float | None = None) -> tuple[int, int]:
        now = self._clock() if now is None else now
        with self._lock:
            rows = [b for s, b in self.buckets.items() if s + BUCKET > now - seconds]
        return sum(b[0] for b in rows), sum(b[1] for b in rows)

    def trend(self, range_key: str, now: float | None = None) -> list[dict]:
        now = self._clock() if now is None else now
        span, step = RANGES[range_key]
        out: dict[int, list] = {}
        with self._lock:
            if range_key == "2h":
                for t, rx, tx in self.ring:
                    if now - t <= span:
                        slot = out.setdefault(int(t // step) * step, [0.0, 0.0, 0])
                        slot[0] += rx
                        slot[1] += tx
                        slot[2] += 1
                return [{"t": t, "rx": round(v[0] / v[2]), "tx": round(v[1] / v[2])} for t, v in sorted(out.items())]
            for start, b in self.buckets.items():
                if start + BUCKET > now - span:
                    slot = out.setdefault(int(start // step) * step, [0, 0, 0.0])
                    slot[0] += b[0]
                    slot[1] += b[1]
                    slot[2] += min(BUCKET, max(1.0, now - start))  # the one still filling has covered less
        # a step's rate is its bytes over the time its buckets really cover
        return [{"t": t, "rx": round(v[0] * 8 / v[2]), "tx": round(v[1] * 8 / v[2])} for t, v in sorted(out.items())]

    def snapshot(self, range_key: str = DEFAULT_RANGE, now: float | None = None) -> dict:
        if range_key not in RANGES:
            raise ValueError(f"range must be one of: {', '.join(RANGES)}")
        now = self._clock() if now is None else now
        span, _ = RANGES[range_key]
        window = max(span, 86400)  # totals are never under a day
        rx_now, tx_now = self.rate(120, now)
        rx_total, tx_total = self.totals(window, now)
        with self._lock:
            link, error, down = self.link, self.error, self._down_polls
            covered = (now - min(self.buckets)) if self.buckets else 0
        state = "unavailable" if link is None else "down" if down >= DOWN_POLLS else "up"
        return {
            "state": state,
            "error": error,
            "link_mbps": (link or {}).get("mbps"),
            "address": (link or {}).get("address"),
            "kind": (link or {}).get("kind"),
            "range": range_key,
            "totals_window": "24h" if window == 86400 else range_key,
            "rx_bps": None if rx_now is None else round(rx_now),
            "tx_bps": None if tx_now is None else round(tx_now),
            "rx_bytes": rx_total,
            "tx_bytes": tx_total,
            "covers_seconds": round(covered),
            "trend": self.trend(range_key, now),
        }

    # -- persistence --

    def _maybe_save(self, now: float) -> None:
        if now - self._saved_at < PERSIST_EVERY:
            return
        self._saved_at = now
        self.save()

    def save(self) -> None:
        with self._lock:
            data = {"last": list(self.last) if self.last else None,
                    "buckets": {str(s): [round(v) for v in b] for s, b in self.buckets.items()}}
        write_json_atomic(self.path, data, label="wan", indent=None)

    def _load(self) -> None:
        raw = read_json(self.path, {})
        if not isinstance(raw, dict):
            return
        now = self._clock()
        for start, b in (raw.get("buckets") or {}).items():
            try:
                if len(b) == 4 and now - int(start) < RETENTION:
                    self.buckets[int(start)] = [int(b[0]), int(b[1]), float(b[2]), float(b[3])]
            except (TypeError, ValueError):
                continue
        last = raw.get("last")
        if isinstance(last, list) and len(last) == 3:
            try:
                self.last = (float(last[0]), int(last[1]), int(last[2]))
            except (TypeError, ValueError):
                pass


monitor = Wan()


# ---- alerts ----------------------------------------------------------------------------


def evaluate(snapshot: dict, rx_avg: float | None = None, tx_avg: float | None = None) -> dict[str, dict]:
    """Alerts for the internet link as the router reports it. Silent while the
    router can't be asked: that says nothing about the link."""
    out: dict[str, dict] = {}
    if snapshot["state"] == "down":
        out["network:wan-down"] = {
            "title": "The router's internet link is down",
            "message": "The router reports no link on its internet port (the dashboard can still reach the router itself).",
            "severity": "bad",
            "hint": "Check the modem's power and the cable between the modem and the router's internet port.",
        }
    link = snapshot.get("link_mbps")
    busiest = max(rx_avg or 0, tx_avg or 0)
    if snapshot["state"] == "up" and link and busiest > FULL_PERCENT * link * 1e6:
        out["network:wan-full"] = {
            "title": "Internet link is nearly full",
            "message": f"The router's internet link has averaged {round(100 * busiest / (link * 1e6))}% of its {link} Mbps for {FULL_MINUTES} minutes.",
            "severity": "warn",
            "hint": "Something is using all of it: Network → Bandwidth shows what crosses the switch; the rest is Wi-Fi.",
            "debounce": True,
        }
    return out


def alerts() -> dict[str, dict]:
    rx, tx = monitor.steady_rate(FULL_MINUTES * 60)
    return evaluate(monitor.snapshot(), rx, tx)


async def run_forever() -> None:
    while True:
        await asyncio.to_thread(monitor.poll)
        await asyncio.sleep(POLL_SECONDS)
