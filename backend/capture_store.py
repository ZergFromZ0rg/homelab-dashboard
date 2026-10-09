"""Saved packet captures, kept on the dashboard's data volume.

A live capture exists only in the agent's memory and is gone when the next
one starts. "Save" copies the packet list the agent holds (and its .pcap)
here, so it can be reopened, downloaded or compared later. Saving is always
an explicit click; nothing is saved by itself.

Per capture, two files named by a random id: ``<id>.meta.json`` (what the
list shows) and ``<id>.json`` (the whole capture as the agent reported it).
The ``.pcap`` is built from that JSON when asked for, so there is one copy of
the packets, not two that could disagree. A capture holds what it was captured with — headers only
unless the payload option was on — so a saved one is as sensitive as the
live one was: opening or downloading it is gated and audited.

Bounded: a few dozen captures and a total size cap. When full, saving is
refused with a message rather than quietly deleting an older one.

The exception is captures the dashboard took by itself when an alert fired
(``auto``): nobody chose to keep those, so only the newest few are kept and the
older ones are dropped to make room. They never count against the number you
may save by hand, and they are never deleted in place of one you saved.
"""

from __future__ import annotations

import json
import re
import secrets
import struct
import threading
import time
from pathlib import Path

from backend.env import env_str

DIR = Path(env_str("CAPTURES_DIR", "/data/captures"))
MAX_CAPTURES = 30  # saved by hand
MAX_AUTO = 30  # a hard stop on automatic ones, whatever the setting says
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_NAME = 80

_ID = re.compile(r"^[0-9a-f]{12}$")
_lock = threading.Lock()


class StoreError(Exception):
    pass


def valid_id(capture_id: str) -> bool:
    return bool(_ID.match(capture_id))


def _path(capture_id: str, suffix: str) -> Path:
    return DIR / f"{capture_id}{suffix}"


def _write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _clean_name(name: str | None, fallback: str) -> str:
    name = " ".join((name or "").split())[:MAX_NAME]
    return name or fallback


def _total() -> int:
    return sum(p.stat().st_size for p in DIR.glob("*") if p.is_file())


def list_all() -> list[dict]:
    """Newest first. Unreadable entries are skipped, not fatal."""
    out = []
    for path in DIR.glob("*.meta.json") if DIR.exists() else []:
        try:
            out.append(json.loads(path.read_text()))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda m: m.get("saved_at", 0), reverse=True)


def build_pcap(packets: list[dict]) -> bytes:
    """A classic libpcap file from saved packets: link type Ethernet, or raw IP
    when every packet came off a tunnel interface. Each record is as short as
    it was kept — headers only unless the capture kept payload. (The agent
    builds the live one the same way; keep them in step.)"""
    raw_ip = bool(packets) and all(p.get("l2", 0) == 0 for p in packets)
    out = bytearray(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 101 if raw_ip else 1))
    for p in packets:
        try:
            data = bytes.fromhex(p.get("hex", ""))
        except ValueError:
            continue
        length = int(p.get("len", len(data)))
        if not raw_ip and p.get("l2", 0) == 0 and data:
            # A tunnel frame in a capture that is otherwise Ethernet ("any"):
            # a placeholder header gives every record the same shape.
            ethertype = b"\x86\xdd" if data[0] >> 4 == 6 else b"\x08\x00"
            data = bytes(12) + ethertype + data
            length += 14
        stamp = float(p.get("ts", 0))
        out += struct.pack("<IIII", int(stamp), int((stamp % 1) * 1_000_000), len(data), max(length, len(data)))
        out += data
    return bytes(out)


def save(host: str, name: str | None, snapshot: dict, auto: dict | None = None) -> dict:
    packets = snapshot.get("packets") or []
    if not packets:
        raise StoreError("there are no packets to save")
    body = json.dumps(snapshot, separators=(",", ":")).encode()
    with _lock:
        DIR.mkdir(parents=True, exist_ok=True)
        by_hand = [m for m in list_all() if not m.get("auto")]
        if not auto and len(by_hand) >= MAX_CAPTURES:
            raise StoreError(f"{MAX_CAPTURES} captures are saved already — delete one first")
        if _total() + len(body) > MAX_TOTAL_BYTES:
            raise StoreError("saved captures are using their full space — delete one first")
        capture_id = secrets.token_hex(6)
        when = time.time()
        totals = snapshot.get("totals") or {}
        meta = {
            "id": capture_id,
            "name": _clean_name(name, f"{host} {time.strftime('%Y-%m-%d %H:%M', time.localtime(when))}"),
            "host": host,
            "saved_at": round(when, 3),
            "started_at": snapshot.get("started_at"),
            "iface": snapshot.get("iface"),
            "filter": snapshot.get("filter") or {},
            "payload": snapshot.get("payload", "none"),
            "promisc": bool(snapshot.get("promisc")),
            "duration": snapshot.get("duration"),
            "packets": len(packets),
            "total_packets": totals.get("pkts", len(packets)),
            "bytes": totals.get("bytes", 0),
            "drops": snapshot.get("drops", 0),
            "size": len(body),
        }
        if auto:
            meta["auto"] = True
            meta["reason"] = str(auto.get("reason") or "")[:200]
            meta["trigger"] = str(auto.get("trigger") or "")[:80]
        _write(_path(capture_id, ".json"), body)
        _write(_path(capture_id, ".meta.json"), json.dumps(meta).encode())
    return meta


def prune_auto(keep: int) -> int:
    """Drop the oldest automatic captures beyond ``keep``. Returns how many."""
    keep = max(0, min(keep, MAX_AUTO))
    automatic = [m for m in list_all() if m.get("auto")]  # newest first
    dropped = 0
    for meta in automatic[keep:]:
        dropped += delete(meta["id"])
    return dropped


def read(capture_id: str) -> dict | None:
    if not valid_id(capture_id):
        return None
    try:
        meta = json.loads(_path(capture_id, ".meta.json").read_text())
        capture = json.loads(_path(capture_id, ".json").read_text())
    except (OSError, ValueError):
        return None
    return {"meta": meta, "capture": capture}


def pcap(capture_id: str) -> tuple[bytes, dict] | None:
    found = read(capture_id)
    if not found:
        return None
    return build_pcap(found["capture"].get("packets") or []), found["meta"]


def rename(capture_id: str, name: str) -> dict | None:
    if not valid_id(capture_id):
        return None
    with _lock:
        try:
            meta = json.loads(_path(capture_id, ".meta.json").read_text())
        except (OSError, ValueError):
            return None
        meta["name"] = _clean_name(name, meta["name"])
        _write(_path(capture_id, ".meta.json"), json.dumps(meta).encode())
    return meta


def delete(capture_id: str) -> bool:
    if not valid_id(capture_id):
        return False
    with _lock:
        found = False
        for suffix in (".meta.json", ".json"):
            try:
                _path(capture_id, suffix).unlink()
                found = True
            except FileNotFoundError:
                pass
    return found
