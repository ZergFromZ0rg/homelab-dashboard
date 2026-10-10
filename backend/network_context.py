"""What the network looks like, as read-only tools for an AI agent.

Four questions an agent can ask: how is the network overall, what is on it,
tell me about one device, and is anything wrong. Each is a plain function over
the same cache the dashboard reads, so the agent sees the numbers you see, and
none of them can change anything: pausing blocking, allowing a domain or
moving a device stay buttons you click.

``TOOLS`` carries each one's name, description and JSON schema in the shape
tool-calling APIs take, so an agent layer can list them and call them without
knowing anything else about the dashboard. (The names are ``network_summary``
and so on: tool names can't contain dots.)
"""

from __future__ import annotations

import time

from backend import device_meta, device_names, network_alerts, network_devices, pihole, pihole_alerts, switch

MAX_DEVICES = 100
MAX_QUERIES = 50


def _rows(now: float | None = None) -> tuple[list[dict], dict]:
    inputs = pihole.collector.device_inputs()
    rows = network_devices.merge(inputs, device_names.names.all(), device_meta.meta.all(), now or time.time())
    fresh = pihole_alerts.known.new()
    for row in rows:
        row["new"] = row["mac"] in fresh
    switch.attach_ports(rows, switch.monitor.snapshot())
    return rows, inputs


def _unavailable() -> dict | None:
    if not pihole.collector.configured:
        return {"error": "Pi-hole isn't connected to the dashboard, so there is no network data."}
    return None


def _compact(row: dict) -> dict:
    """The fields worth an agent's attention; the rest is table plumbing."""
    compact = {
        "mac": row["mac"], "name": row["name"], "kind": row["kind"], "ip": row["ip"],
        "online": row["online"], "vendor": row["vendor"], "private_mac": row["private_mac"],
        "queries_24h": row["queries_24h"], "blocked_24h": row["blocked_24h"], "block_rate_percent": row["block_rate"],
        "last_seen": row["last_seen"], "first_seen": row["first_seen"], "notes": row["notes"],
        "groups": row["groups"], "new": row["new"], "static_ip": row["ip_type"] == "static-lease",
    }
    if row.get("port"):
        compact["switch_port"] = row["port"]
    return compact


def summary() -> dict:
    if (gone := _unavailable()):
        return gone
    snap = pihole.collector.snapshot()
    rows, _ = _rows()
    shown = [r for r in rows if not r["ghost"]]
    stats = snap.get("summary") or {}
    return {
        "pihole": {
            "reachable": bool(snap.get("reachable")),
            "stale": bool(snap.get("stale")),
            "error": snap.get("error"),
            "blocking_enabled": (snap.get("blocking") or {}).get("enabled"),
            "blocking_paused_seconds_left": (snap.get("blocking") or {}).get("timer"),
            "updated_at": snap.get("updated_at"),
        },
        "queries_24h": stats.get("total"),
        "blocked_24h": stats.get("blocked"),
        "block_percent": stats.get("percent_blocked"),
        "devices": {
            "known": len(shown),
            "online": sum(1 for r in shown if r["online"] is True),
            "new_unnamed": sum(1 for r in shown if r["new"]),
            "unlabelled": sum(1 for r in shown if r["kind"] == "unknown"),
        },
        "alerts": len(alerts()["alerts"]),
    }


def devices(online: bool | None = None, kind: str | None = None) -> dict:
    if (gone := _unavailable()):
        return gone
    rows, _ = _rows()
    out = [
        _compact(r) for r in rows
        if not r["ghost"]
        and (online is None or r["online"] is online)
        and (not kind or r["kind"] == kind)
    ]
    return {"count": len(out), "devices": out[:MAX_DEVICES]}


def device(who: str) -> dict:
    """One device by MAC or by name (exact first, then a unique partial match),
    with its latest queries."""
    if (gone := _unavailable()):
        return gone
    who = (who or "").strip().lower()
    if not who:
        return {"error": "say which device: a MAC address or a name"}
    rows = [r for r in _rows()[0] if not r["ghost"]]
    hits = [r for r in rows if who in (r["mac"], r["name"].lower())]
    if not hits:
        hits = [r for r in rows if who in r["name"].lower() or who in r["mac"] or who == r["ip"]]
    if not hits:
        return {"error": f"no device matches “{who}”"}
    if len(hits) > 1:
        return {"error": f"“{who}” matches {len(hits)} devices; use the MAC address",
                "candidates": [{"mac": r["mac"], "name": r["name"], "ip": r["ip"]} for r in hits[:10]]}
    row = hits[0]
    result = {"device": _compact(row), "recent_queries": None}
    if row["ip"]:
        try:
            detail = pihole.collector.device_detail(row["ip"])
            result["recent_queries"] = [
                {"time": q["time"], "domain": q["domain"], "status": q["status"], "blocked": q["blocked"]}
                for q in detail["recent"][:MAX_QUERIES]
            ]
            result["top_blocked"] = [{"domain": d["domain"], "count": d["count"]} for d in detail["top_blocked"][:5]]
        except pihole.PiholeError as error:
            result["recent_queries_error"] = str(error)
    return result


def alerts() -> dict:
    """What is wrong right now: Pi-hole unreachable, an unnamed new device,
    blocking far above usual, and whatever the switch is raising."""
    if (gone := _unavailable()):
        return gone
    now = network_alerts.current()
    return {"alerts": [
        {"key": key, "severity": alert.get("severity", "warn"), "title": alert["title"],
         "message": alert["message"], "hint": alert.get("hint")}
        for key, alert in now.items()
    ]}


def _bool(value) -> bool | None:
    if value in (None, ""):
        return None
    return str(value).lower() in ("1", "true", "yes", "on")


TOOLS = [
    {
        "name": "network_summary",
        "description": "How the home network is doing: Pi-hole's health and whether ad blocking is on, DNS queries and "
                       "blocked share over the last 24 hours, how many devices are known and online, how many new "
                       "devices nobody has named, and how many alerts are open.",
        "input_schema": {"type": "object", "properties": {}},
        "run": lambda args: summary(),
    },
    {
        "name": "network_devices",
        "description": "Every device on the network, one record each (name, kind, IP, online, vendor, queries and blocked "
                       "share in 24h, first and last seen). Servers come first. Filter to the ones online now, or to a kind.",
        "input_schema": {"type": "object", "properties": {
            "online": {"type": "boolean", "description": "true for only devices online now, false for only those that are not"},
            "kind": {"type": "string", "enum": list(device_meta.KINDS), "description": "only devices of this kind"},
        }},
        "run": lambda args: devices(_bool(args.get("online")), args.get("kind") or None),
    },
    {
        "name": "network_device",
        "description": "One device in detail: its record plus its latest 50 DNS queries (which were blocked) and the domains "
                       "blocked most. Look it up by name (“Firestick”) or MAC address.",
        "input_schema": {"type": "object", "properties": {
            "device": {"type": "string", "description": "the device's name or MAC address"},
        }, "required": ["device"]},
        "run": lambda args: device(args.get("device", "")),
    },
    {
        "name": "network_alerts",
        "description": "What is wrong on the network right now: Pi-hole unreachable, a new unnamed device, blocking far "
                       "above its usual rate, a switch port that dropped or runs slow. An empty list means nothing is.",
        "input_schema": {"type": "object", "properties": {}},
        "run": lambda args: alerts(),
    },
]

BY_NAME = {t["name"]: t for t in TOOLS}


def definitions() -> list[dict]:
    """The tools without their callables, ready to hand to a tool-calling API."""
    return [{k: v for k, v in t.items() if k != "run"} for t in TOOLS]


def call(name: str, args: dict) -> dict | None:
    tool = BY_NAME.get(name)
    return tool["run"](args or {}) if tool else None
