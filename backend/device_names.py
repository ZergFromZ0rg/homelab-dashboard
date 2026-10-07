"""Friendlier names for devices found on the LAN.

Two parts. ``guess`` reads a scan result (its hostname, the MAC's maker and
the ports that answered) and says what kind of thing it probably is — "iPhone
or iPad", "Printer". It is a guess and the UI shows it as one. ``NameStore``
keeps the names the user typed, keyed by MAC (IP when there isn't one), so a
rename survives the device getting a new address.
"""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path

from backend.jsonstore import read_json, write_json_atomic

NAMES_FILE = Path(os.getenv("DEVICE_NAMES_FILE", "/data/device-names.json"))
MAX_NAMES = 500
MAX_LENGTH = 60

# Checked in order against the hostname, lowercased. First hit wins.
HOSTNAME_KINDS = [
    (("iphone",), "iPhone"),
    (("ipad",), "iPad"),
    (("macbook", "mbp", "mba-"), "MacBook"),
    (("imac", "mac-mini", "macmini", "mac-studio"), "Mac"),
    (("apple-tv", "appletv"), "Apple TV"),
    (("homepod",), "HomePod"),
    (("android", "galaxy", "pixel", "oneplus", "redmi", "xiaomi", "huawei", "moto"), "Android phone"),
    (("printer", "laserjet", "officejet", "deskjet", "envy", "pixma", "epson", "brother", "npi"), "Printer"),
    (("chromecast", "google-home", "nest"), "Google Home / Chromecast"),
    (("roku",), "Roku"),
    (("echo", "alexa", "amazon"), "Amazon device"),
    (("tv", "bravia", "lg-webos", "webos", "vizio"), "TV"),
    (("playstation", "ps4", "ps5"), "PlayStation"),
    (("xbox",), "Xbox"),
    (("switch", "nintendo"), "Nintendo"),
    (("sonos",), "Sonos speaker"),
    (("cam", "reolink", "hikvision", "doorbell", "ring-"), "Camera"),
    (("esp", "tasmota", "shelly", "wled"), "Smart device"),
    (("laptop", "thinkpad", "notebook", "xps", "surface"), "Laptop"),
    (("desktop", "-pc", "pc-", "win-"), "PC"),
    (("raspberrypi", "pi-hole", "pihole"), "Raspberry Pi"),
    (("router", "gateway", "ap-", "unifi"), "Network gear"),
    (("nas", "synology", "diskstation", "qnap"), "NAS"),
]

# A service that answers only on one kind of device.
PORT_KINDS = [
    ({"printer", "ipp", "lpd"}, "Printer"),
    ({"ios"}, "iPhone or iPad"),
    ({"rtsp"}, "Camera"),
]
PORT_NUMBERS = {9100: "Printer", 631: "Printer", 515: "Printer", 62078: "iPhone or iPad", 554: "Camera", 8009: "Google Home / Chromecast"}

# Substrings of the maker's registered name, lowercased.
VENDOR_KINDS = [
    (("raspberry pi",), "Raspberry Pi"),
    (("espressif",), "Smart device"),
    (("sonos",), "Sonos speaker"),
    (("roku",), "Roku"),
    (("nintendo",), "Nintendo"),
    (("sony interactive",), "PlayStation"),
    (("microsoft",), "Xbox or Surface"),
    (("ubiquiti", "tp-link", "netgear", "mikrotik", "cisco", "zyxel", "aruba", "asustek"), "Network gear"),
    (("synology", "qnap"), "NAS"),
    (("canon", "epson", "brother", "lexmark", "xerox", "ricoh", "kyocera"), "Printer"),
    (("hewlett", "hp inc"), "HP device"),
    (("apple",), "Apple device"),
    (("samsung",), "Samsung device"),
    (("google",), "Google device"),
    (("amazon",), "Amazon device"),
    (("lg electronics",), "LG device"),
    (("xiaomi", "oneplus", "huawei", "oppo", "vivo", "motorola", "murata"), "Android phone"),
    (("intel", "liteon", "azurewave", "realtek", "killer", "qualcomm", "mediatek"), "Laptop or PC"),
    (("dell", "lenovo", "giga-byte", "micro-star", "asrock"), "Laptop or PC"),
]


def _named(needle: str, hostname: str, tokens: list[str]) -> bool:
    # Short words ("tv", "nas", "cam") must start a word of the name, or
    # "banana" is a NAS; long ones are distinctive enough to match anywhere.
    return needle in hostname if len(needle) >= 6 else any(t.startswith(needle) for t in tokens)


def guess(device: dict) -> dict | None:
    """{"kind": label, "why": evidence} or None when nothing gives it away."""
    hostname = (device.get("hostname") or "").lower()
    ports = device.get("ports") or []
    vendor = (device.get("vendor") or "").lower()
    if hostname:
        tokens = [t for t in re.split(r"[^a-z0-9]+", hostname) if t]
        for needles, kind in HOSTNAME_KINDS:
            hit = next((n for n in needles if _named(n.strip("-"), hostname, tokens)), None)
            if hit:
                return {"kind": kind, "why": f"name contains “{hit}”"}
    for p in ports:
        for services, kind in PORT_KINDS:
            if p.get("service") in services:
                return {"kind": kind, "why": f"answers on {p.get('service')} {p.get('port')}"}
        if p.get("port") in PORT_NUMBERS:
            return {"kind": PORT_NUMBERS[p["port"]], "why": f"answers on port {p['port']}"}
    for needles, kind in VENDOR_KINDS:
        if any(n in vendor for n in needles):
            return {"kind": kind, "why": f"made by {device.get('vendor')}"}
    if device.get("randomized"):
        return {"kind": "Phone/laptop", "why": "uses a private (randomized) address"}
    return None


def annotate(devices: list[dict]) -> list[dict]:
    for d in devices:
        d["guess"] = guess(d)
    return devices


def key_of(device_key: str) -> str:
    return (device_key or "").strip().lower()


class NameStore:
    def __init__(self, path: Path = NAMES_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        data = read_json(self.path, {})
        self._names: dict[str, str] = {
            k: v for k, v in (data.items() if isinstance(data, dict) else []) if isinstance(k, str) and isinstance(v, str)
        }

    def all(self) -> dict[str, str]:
        with self._lock:
            return dict(self._names)

    def set(self, key: str, name: str) -> dict[str, str]:
        """Name a device; a blank name takes the custom name away."""
        key, name = key_of(key), (name or "").strip()[:MAX_LENGTH]
        if not key or len(key) > 64:
            raise ValueError("a device key is needed")
        with self._lock:
            if name:
                if key not in self._names and len(self._names) >= MAX_NAMES:
                    raise ValueError("too many named devices")
                self._names[key] = name
            else:
                self._names.pop(key, None)
            write_json_atomic(self.path, self._names, label="device names")
            return dict(self._names)


names = NameStore()
