"""Synthesizes the One Morning Summary (overnight events, degrading signals, and action items)."""

from __future__ import annotations

import time

def _ago(seconds: float) -> str:
    if seconds < 60:
        return f"{int(seconds)}s"
    if seconds < 3600:
        return f"{int(seconds / 60)}m"
    if seconds < 86400:
        return f"{int(seconds / 3600)}h"
    return f"{int(seconds / 86400)}d"

def synthesize(
    machines: dict,
    containers: dict,
    activity_entries: list[dict],
    alert_entries: list[dict],
    deployments: list[dict],
    check_summaries: list[dict],
    backups_summary: dict | None,
    rebalance_suggestions: list[dict] | None = None,
    now: float | None = None,
) -> dict:
    if now is None:
        now = time.time()

    # Look back 14 hours for "overnight"
    cutoff = now - (14 * 3600)
    
    overnight = []
    degrading = []
    needs_action = []

    # 1. OVERNIGHT EVENTS
    for entry in activity_entries:
        if entry.get("at", 0) >= cutoff:
            # We want to highlight significant overnight events.
            kind = entry.get("kind", "")
            if kind in ("update", "update_done", "autorebalance", "container_restart", "container_unhealthy", "backup_done"):
                overnight.append({
                    "kind": kind,
                    "text": entry.get("text", ""),
                    "at": entry.get("at"),
                    "host": entry.get("host"),
                    "tone": "bad" if kind == "container_unhealthy" else ("warn" if kind == "container_restart" else "ok")
                })

    # Sort overnight descending by time
    overnight.sort(key=lambda x: x.get("at", 0), reverse=True)
    # Take top 10 most relevant to avoid spam
    overnight_highlights = overnight[:10]

    # 2. DEGRADING & NEEDS ACTION (per host and container)
    for host, m in machines.items():
        # Host facts: OS updates, reboot, systemd failures
        facts = m.get("host_facts") or {}
        
        # Degrading: Failed systemd units
        failed_units = facts.get("failed_units") or []
        if failed_units:
            degrading.append({
                "key": f"services:{host}",
                "title": f"{len(failed_units)} service(s) failed on {host}",
                "detail": ", ".join(failed_units[:3]),
                "severity": "bad",
                "host": host
            })
            
        # Degrading: OS Updates pending (if we have a lot or security updates, we flag it in degrading)
        os_updates = facts.get("os_updates") or 0
        security_updates = facts.get("security_updates") or 0
        if os_updates > 0:
            sec_text = f" ({security_updates} security)" if security_updates else ""
            degrading.append({
                "key": f"os_updates:{host}",
                "title": f"{os_updates} pending OS updates on {host}",
                "detail": f"Updates available{sec_text}",
                "severity": "warn" if security_updates > 0 else "info",
                "host": host
            })
            # Action: Install OS Updates
            needs_action.append({
                "id": f"os_upgrade:{host}",
                "type": "os_upgrade",
                "title": f"Install {os_updates} OS updates on {host}",
                "subtitle": f"{security_updates} security updates" if security_updates else "Standard packages",
                "host": host,
                "button_label": "Install updates",
                "action": {
                    "method": "POST",
                    "url": f"/api/hosts/{host}/os-updates/upgrade",
                    "confirm": f"Install {os_updates} updates on {host}?"
                }
            })

        # Action: Reboot Required
        if facts.get("reboot_required"):
            needs_action.append({
                "id": f"reboot:{host}",
                "type": "reboot",
                "title": f"Reboot needed on {host}",
                "subtitle": "System requires reboot after updates",
                "host": host,
                "button_label": "Reboot host",
                "action": {
                    "method": "POST",
                    "url": f"/api/hosts/{host}/reboot",
                    "confirm": f"Reboot {host}?"
                }
            })

        # Degrading: Disks filling up
        for fs in m.get("filesystems") or []:
            days = fs.get("days_until_full")
            if isinstance(days, (int, float)) and days <= 7:
                mount = fs.get("mountpoint") or fs.get("device") or "?"
                whole = int(days + 0.5)
                used = fs.get("used_percent") or 0
                degrading.append({
                    "key": f"diskfull:{host}:{mount}",
                    "title": f"{mount} on {host} filling up",
                    "detail": f"Full in ~{whole} days ({used:.0f}% used)",
                    "severity": "bad" if days <= 2 else "warn",
                    "host": host
                })

        # Action: Container Updates (if available)
        host_containers = containers.get(host) or []
        updatable = [c for c in host_containers if c.get("update", {}).get("can_update")]
        if updatable:
            needs_action.append({
                "id": f"container_updates:{host}",
                "type": "container_updates",
                "title": f"Update {len(updatable)} containers on {host}",
                "subtitle": ", ".join([c.get("name", "?") for c in updatable[:3]]),
                "host": host,
                "button_label": "Update all",
                "action": {
                    "method": "POST",
                    "url": f"/api/updates/{host}",
                    "body": {"containers": [c["name"] for c in updatable]},
                    "confirm": f"Update {len(updatable)} containers on {host}?"
                }
            })

        # Degrading: Restarting/flapping containers
        for c in host_containers:
            cname = c.get("name") or c.get("id") or "?"
            restarts = c.get("restart_count") or 0
            # Simple heuristic for flapping
            if c.get("status") == "restarting" or restarts >= 5:
                degrading.append({
                    "key": f"container_restarting:{host}:{cname}",
                    "title": f"{cname} keeps restarting",
                    "detail": f"Restarted {restarts} times on {host}",
                    "severity": "bad",
                    "host": host
                })

    # Degrading: Backups failing or stale
    if backups_summary:
        if backups_summary.get("attention", 0) > 0:
            degrading.append({
                "key": "backups:failing",
                "title": "Backups failing or stale",
                "detail": f"{backups_summary['attention']} backup(s) need attention",
                "severity": "bad",
                "host": None
            })

    # Action: Rebalance recommendations
    if rebalance_suggestions:
        for rec in rebalance_suggestions:
            container_name = rec.get("container_name") or rec.get("container_id", "?")
            from_node = rec.get("from_node", "?")
            to_node = rec.get("to_node", "?")
            needs_action.append({
                "id": f"rebalance:{container_name}",
                "type": "rebalance",
                "title": f"Move {container_name} from {from_node} to {to_node}",
                "subtitle": f"Score gain: {rec.get('gain', 0)}",
                "host": from_node,
                "button_label": "Approve move",
                "action": {
                    "method": "POST",
                    "url": "/api/rebalance/apply",
                    "body": {"container_id": rec.get("container_id"), "target_node": to_node},
                    "confirm": f"Move {container_name} to {to_node}?"
                }
            })

    return {
        "timestamp": now,
        "overnight": {
            "since_timestamp": cutoff,
            "events_count": len(overnight),
            "highlights": overnight_highlights
        },
        "degrading": degrading,
        "needs_action": needs_action
    }
