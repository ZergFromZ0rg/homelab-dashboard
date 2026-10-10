"""Switch ports, read from Prometheus.

The switch only knows "right now". snmp_exporter turns its SNMP counters into
metrics, Prometheus keeps the history, and this module asks Prometheus about
the ``switch`` job: one row per port with link state, negotiated speed,
traffic and errors. Nothing here talks to the switch, and the browser never
talks to Prometheus.

A port counts as one you care about when it has a description on the switch
(``ifAlias``); that is what the alerts watch. An unlabelled port is listed
only while something is plugged into it, so a new device is noticed.

Windowed questions ("was it up this week?", "what speed does it usually
run at?") are put to Prometheus instead of remembered here, so a dashboard
restart forgets nothing.
"""

from __future__ import annotations

import re
import threading
import time

import requests

from backend import prometheus
from backend.env import env_float, env_str

_JOB_RE = re.compile(r"[A-Za-z0-9_.:-]+")
JOB = env_str("SWITCH_JOB", "switch")
if not _JOB_RE.fullmatch(JOB):  # it goes into a PromQL label matcher
    JOB = "switch"
# The port that leads to the internet; its saturation is worth an alert.
UPLINK = env_str("SWITCH_UPLINK_PORT", "router").lower()
ERRORS_PER_15M = env_float("SWITCH_ERRORS_PER_15M", 50)
SATURATED = env_float("SWITCH_UPLINK_PERCENT", 90) / 100

CACHE_SECONDS = 30  # the exporter is scraped every 30 s; asking faster learns nothing
RATE = "2m"  # four scrapes
NOTICE_MINUTES = 2  # how long a link must stay down before it is an alert
BUSY_MINUTES = 10  # how long the uplink must stay full before it is an alert
NOTICE = f"{NOTICE_MINUTES}m"
BUSY = f"{BUSY_MINUTES}m"
HISTORY = "7d"


def _number(result: dict) -> float | None:
    try:
        value = float(result["value"][1])
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    return None if value != value else value  # NaN


def _by_index(promql: str) -> dict[str, tuple[dict, float]]:
    """ifIndex -> (labels, value) for an instant query."""
    out: dict[str, tuple[dict, float]] = {}
    for result in prometheus.query(promql):
        metric, value = result.get("metric") or {}, _number(result)
        if metric.get("ifIndex") is not None and value is not None:
            out[metric["ifIndex"]] = (metric, value)
    return out


def _value(table: dict, index: str) -> float | None:
    return table[index][1] if index in table else None


def _fetch(now: float) -> dict:
    sel = f'job="{JOB}"'
    up = prometheus.query(f"up{{{sel}}}")
    if not up:
        return {"state": "unconfigured"}
    online = _number(up[0]) == 1
    quiet = prometheus.query(f"min_over_time(up{{{sel}}}[{NOTICE}])")
    down_for_notice = bool(quiet) and _number(quiet[0]) == 0

    status = _by_index(f"ifOperStatus{{{sel}}}")
    speed = _by_index(f"ifHighSpeed{{{sel}}}")
    usual_speed = _by_index(f"max_over_time(ifHighSpeed{{{sel}}}[{HISTORY}])")
    lately = _by_index(f"min_over_time(ifOperStatus{{{sel}}}[{NOTICE}])")
    ever = _by_index(f"min_over_time(ifOperStatus{{{sel}}}[{HISTORY}])")
    # The switch counts from its own side: "in" is what the device on the port
    # sends it, "out" what it sends the device. Everything here and in the UI
    # takes the device's side, which is how anyone reads a row called "Bigboy".
    sent = _by_index(f"rate(ifHCInOctets{{{sel}}}[{RATE}]) * 8")
    received = _by_index(f"rate(ifHCOutOctets{{{sel}}}[{RATE}]) * 8")
    sent_busy = _by_index(f"avg_over_time((rate(ifHCInOctets{{{sel}}}[{RATE}]) * 8)[{BUSY}:1m])")
    received_busy = _by_index(f"avg_over_time((rate(ifHCOutOctets{{{sel}}}[{RATE}]) * 8)[{BUSY}:1m])")
    errors_day = _by_index(f"increase(ifInErrors{{{sel}}}[24h]) + increase(ifOutErrors{{{sel}}}[24h])")
    errors_now = _by_index(f"increase(ifInErrors{{{sel}}}[15m]) + increase(ifOutErrors{{{sel}}}[15m])")

    ports = []
    for index, (metric, state) in status.items():
        if not index.isdigit():
            continue
        label = (metric.get("ifAlias") or "").strip()
        mbps = _value(speed, index) or 0.0
        is_up = state == 1
        if not label and not (is_up and mbps > 0):
            continue  # the CPU interface, link aggregates, empty ports
        link = mbps * 1e6
        sent_bps, received_bps = _value(sent, index) or 0.0, _value(received, index) or 0.0
        busy = max(_value(sent_busy, index) or 0.0, _value(received_busy, index) or 0.0)
        top = _value(usual_speed, index)
        day, quarter = _value(errors_day, index), _value(errors_now, index)
        ports.append({
            "index": int(index),
            "name": label or metric.get("ifName") or f"port {index}",
            "port": metric.get("ifName") or index,
            "labelled": bool(label),
            "up": is_up,
            "down_lately": (_value(lately, index) or 0) > 1,  # not up at any point in the last NOTICE
            "seen_up": _value(ever, index) == 1,  # was up at some point in HISTORY
            "speed_mbps": int(mbps) if mbps else None,
            "usual_speed_mbps": int(top) if top else None,
            "sent_bps": round(sent_bps),
            "received_bps": round(received_bps),
            "usage": round(max(sent_bps, received_bps) / link, 3) if link else None,
            "busy": round(busy / link, 3) if link else None,
            "errors_24h": round(day) if day is not None else None,
            "errors_15m": round(quarter) if quarter is not None else None,
        })
    ports.sort(key=lambda p: p["index"])
    return {
        "state": "up" if online else "down",
        "instance": up[0]["metric"].get("instance", ""),
        "down_lately": down_for_notice,
        "ports": ports,
        "updated_at": now,
    }


class Switch:
    def __init__(self):
        self._lock = threading.Lock()  # also holds the herd: one fetch, everybody reads it
        self._data: dict | None = None
        self._tried_at = 0.0
        self._error: str | None = None

    def snapshot(self, now: float | None = None) -> dict:
        now = now or time.time()
        with self._lock:
            if now - self._tried_at >= CACHE_SECONDS:
                self._tried_at = now
                try:
                    self._data, self._error = _fetch(now), None
                except (requests.RequestException, ValueError, KeyError, TypeError) as error:
                    self._error = f"Prometheus: {error}"
            data, error = self._data, self._error
        if error is None:
            return {**data, "reachable": True, "stale": False, "error": None}
        # Prometheus can't be asked: keep the last answer, marked, rather than
        # showing a healthy switch or an empty one.
        if data is None or data.get("state") == "unconfigured":
            return {"state": "unreachable", "ports": [], "reachable": False, "stale": False, "error": error}
        return {**data, "state": "unreachable", "reachable": False, "stale": True, "error": error}


monitor = Switch()


def attach_ports(rows: list[dict], snapshot: dict) -> None:
    """Give each device row the switch port it is plugged into, if a port is
    labelled with its name. The match ignores case, so a port called "Bigboy"
    finds the device "bigboy" and nobody has to rename anything."""
    by_name = {p["name"].lower(): p for p in snapshot.get("ports") or [] if p["labelled"]}
    if not by_name:
        return
    for row in rows:
        for candidate in (row.get("name"), row.get("hostname")):
            port = by_name.get((candidate or "").lower())
            if port:
                row["port"] = {key: port[key] for key in ("name", "port", "up", "speed_mbps", "usual_speed_mbps", "sent_bps", "received_bps")}
                break


def _mbps(value: float | None) -> str:
    return f"{value:g} Mbps" if value is not None else "?"


def evaluate(snapshot: dict) -> dict[str, dict]:
    """The switch alerts that should be raised right now. Silent when
    Prometheus can't be asked or the job doesn't exist: either way there is
    nothing to say about the switch."""
    if snapshot.get("state") not in ("up", "down"):
        return {}
    if snapshot.get("down_lately"):
        return {"network:switch-down": {
            "title": "Switch is not answering SNMP",
            "message": f"Prometheus hasn't been able to read {snapshot.get('instance') or 'the switch'} for "
                       f"{NOTICE_MINUTES}+ minutes. Either the switch is off, or only the monitoring is broken.",
            "severity": "bad",
            "hint": "Check the switch's power, then docker logs snmp-exporter on bigboy.",
        }}
    out: dict[str, dict] = {}
    for port in snapshot.get("ports") or []:
        if not port["labelled"]:
            continue
        name, key = port["name"], port["port"]
        if not port["up"] and port["down_lately"] and port["seen_up"]:
            out[f"network:switch-port-down:{key}"] = {
                "title": f"{name} link is down",
                "message": f"Port {key} ({name}) has had no link for {NOTICE_MINUTES}+ minutes.",
                "severity": "bad",
                "hint": f"Check the cable and that {name} is powered on.",
            }
            continue
        if not port["up"]:
            continue
        usual, speed = port["usual_speed_mbps"], port["speed_mbps"]
        if usual and speed and speed < usual:
            out[f"network:switch-port-slow:{key}"] = {
                "title": f"{name} link dropped to {_mbps(speed)}",
                "message": f"Port {key} ({name}) negotiated {_mbps(speed)}; it has been at {_mbps(usual)} this week.",
                "severity": "warn",
                "hint": "Reseat or replace the cable: a damaged pair makes gigabit fall back to 100. "
                        "If the slower link is intended, this clears itself after a week.",
                "debounce": True,
            }
        errors = port["errors_15m"]
        if errors is not None and errors > ERRORS_PER_15M:
            out[f"network:switch-port-errors:{key}"] = {
                "title": f"{name} port is logging errors",
                "message": f"Port {key} ({name}) counted {errors} bad packets in the last 15 minutes.",
                "severity": "warn",
                "hint": "A failing cable or port: swap the cable first.",
                "debounce": True,
            }
        if name.lower() == UPLINK and port["busy"] is not None and port["busy"] > SATURATED:
            out[f"network:switch-uplink-full:{key}"] = {
                "title": f"{name} link is nearly full",
                "message": f"Port {key} ({name}) has averaged {round(port['busy'] * 100)}% of its "
                           f"{_mbps(port['speed_mbps'])} link for {BUSY_MINUTES} minutes.",
                "severity": "warn",
                "hint": "Something is saturating the connection; open Network → Host network to find which host.",
                "debounce": True,
            }
    return out


def alerts() -> dict[str, dict]:
    return evaluate(monitor.snapshot())
