"""Pi-hole numbers as Prometheus metrics, so Grafana shows what the dashboard does.

Rendered from the collector's cache and the merged device table; nothing here
talks to Pi-hole. Every figure is a gauge: Pi-hole's "queries" and "blocked"
are over a sliding 24 hours, not a counter that only goes up, so they are named
``*_24h`` (a ``*_total`` would invite ``rate()``, which would be wrong).

Devices are labelled with the name you gave them here, plus their MAC, which
doesn't change when you rename one. IPs are left off: a DHCP lease moving
would start a new series every time.
"""

from __future__ import annotations

MAX_DEVICES = 200
CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


def _escape(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _labels(**labels: str) -> str:
    return "{" + ",".join(f'{k}="{_escape(v)}"' for k, v in labels.items()) + "}"


def _number(value) -> str:
    return repr(float(value)) if isinstance(value, float) else str(int(value))


class _Out:
    def __init__(self):
        self.lines: list[str] = []

    def metric(self, name: str, help_text: str, samples: list[tuple[str, float]]) -> None:
        if not samples:
            return
        self.lines.append(f"# HELP {name} {help_text}")
        self.lines.append(f"# TYPE {name} gauge")
        for labels, value in samples:
            self.lines.append(f"{name}{labels} {_number(value)}")


def render(snapshot: dict, rows: list[dict], new: int = 0) -> str:
    """The exposition text. ``snapshot`` is the collector's; ``rows`` the merged devices."""
    out = _Out()
    summary = snapshot.get("summary") or {}
    out.metric("pihole_up", "1 if the dashboard reached Pi-hole on its last poll.",
               [("", 1 if snapshot.get("reachable") else 0)])
    if snapshot.get("updated_at"):
        out.metric("pihole_last_poll_timestamp_seconds", "When Pi-hole last answered the dashboard.",
                   [("", snapshot["updated_at"])])
    blocking = snapshot.get("blocking") or {}
    if blocking:
        out.metric("pihole_blocking_enabled", "1 if ad blocking is on, 0 if paused.", [("", 1 if blocking.get("enabled") else 0)])
    if summary:
        total, blocked = summary.get("total", 0), summary.get("blocked", 0)
        out.metric("pihole_queries_24h", "DNS queries in the last 24 hours (a sliding window, not a counter).", [("", total)])
        out.metric("pihole_blocked_24h", "Queries Pi-hole refused in the last 24 hours (a sliding window, not a counter).", [("", blocked)])
        out.metric("pihole_block_ratio", "Share of the last 24 hours' queries that were blocked, 0 to 1.",
                   [("", round(blocked / total, 4) if total else 0.0)])
        out.metric("pihole_gravity_domains", "Domains on the blocklists.", [("", summary.get("gravity_domains", 0))])
    if snapshot.get("leases_total") is not None:
        out.metric("pihole_dhcp_leases", "Active DHCP leases.", [("", snapshot["leases_total"])])

    shown = [r for r in rows if not r.get("ghost")]
    out.metric("pihole_clients_known", "Devices Pi-hole has seen, not counting its own entries or long-gone ones.", [("", len(shown))])
    out.metric("pihole_clients_online", "Devices online now: recent DNS queries and a live lease or reservation.",
               [("", sum(1 for r in shown if r.get("online") is True))])
    out.metric("pihole_new_devices", "Devices that joined recently and haven't been named or marked known.", [("", new)])

    device = [r for r in shown[:MAX_DEVICES]]

    def ident(r: dict) -> str:
        return _labels(name=r["name"], mac=r["mac"], kind=r.get("kind") or "unknown")

    out.metric("pihole_device_queries_24h", "Queries from this device in the last 24 hours.",
               [(ident(r), r["queries_24h"]) for r in device if r.get("queries_24h") is not None])
    out.metric("pihole_device_blocked_24h", "Of those, how many Pi-hole refused.",
               [(ident(r), r["blocked_24h"]) for r in device if r.get("blocked_24h") is not None])
    out.metric("pihole_device_online", "1 if the device is online now, 0 if not. Absent when it doesn't use Pi-hole for DNS.",
               [(ident(r), 1 if r["online"] else 0) for r in device if r.get("online") is not None])
    return "\n".join(out.lines) + "\n"
