"""One record per device, keyed by MAC, merged from what Pi-hole knows.

IPs and hostnames change; the MAC does not. Sources, strongest first for the
name: the label you gave it here, the comment you gave the client in Pi-hole,
the DHCP lease's hostname, the name Pi-hole resolved, then the maker.

Pure: takes the collector's inputs and your labels, returns rows. No network.
"""

from __future__ import annotations

ONLINE_WINDOW = 10 * 60  # seconds since its last DNS query
GHOST_AFTER = 7 * 24 * 3600


def private_mac(mac: str) -> bool:
    """Randomized ("private") addresses set the locally-administered bit: the
    second hex digit is 2, 6, A or E."""
    return len(mac) > 1 and mac[1].lower() in "26ae"


def _is_mac(value: str) -> bool:
    return value.count(":") == 5


def _short(host: str | None) -> str:
    """"phone.lan" -> "phone"; a lease with no name arrives as "*"."""
    host = (host or "").strip()
    return "" if host in ("", "*") else host.split(".")[0]


def merge(inputs: dict, names: dict[str, str], meta: dict[str, dict], now: float) -> list[dict]:
    extras = inputs.get("extras") or {}
    clients = extras.get("clients") or {}
    groups = extras.get("groups") or {}
    queries, blocked = extras.get("queries") or {}, extras.get("blocked") or {}
    static = {s["mac"]: s for s in extras.get("static") or []}
    static_by_ip = {s["ip"]: s for s in extras.get("static") or []}
    leases = {lease["mac"]: lease for lease in inputs.get("leases") or [] if lease.get("mac")}

    rows: dict[str, dict] = {}
    for device in inputs.get("devices") or []:
        mac = device["mac"]
        if not _is_mac(mac):
            # "ip-127.0.0.1", "ip-192.168.0.132 / pi.hole": Pi-hole's own
            # traffic, with no hardware address behind it.
            ip = (device["ips"][0]["ip"] if device.get("ips") else "")
            if ip in static_by_ip and static_by_ip[ip]["mac"] not in rows:
                # the thinkpad asks DNS as "ip-192.168.0.132"; it keeps its real MAC
                rows[static_by_ip[ip]["mac"]] = {"_device": {**device, "mac": static_by_ip[ip]["mac"]}}
            continue
        rows[mac] = {"_device": device}
    for mac, entry in static.items():
        rows.setdefault(mac, {"_device": None})
    for mac in leases:
        rows.setdefault(mac, {"_device": None})

    out = []
    for mac, row in rows.items():
        device = row["_device"] or {}
        lease, entry, client = leases.get(mac), static.get(mac), clients.get(mac)
        ips = sorted(device.get("ips") or [], key=lambda i: i.get("last_seen") or 0, reverse=True)
        ip = (lease or {}).get("ip") or (entry or {}).get("ip") or (ips[0]["ip"] if ips else "")
        hostname = _short((lease or {}).get("name")) or next((_short(i.get("name")) for i in ips if _short(i.get("name"))), "")
        label = (names.get(mac) or "").strip()
        comment = ((client or {}).get("comment") or "").strip()
        vendor = device.get("vendor") or ""
        if label:
            name, source = label, "label"
        elif comment:
            name, source = comment, "pihole"
        elif entry and entry.get("name"):
            name, source = entry["name"], "static"
        elif hostname:
            name, source = hostname, "hostname"
        elif vendor:
            name, source = vendor, "vendor"
        else:
            name, source = mac, "mac"

        mine = meta.get(mac) or {}
        group_names = [groups.get(g, "") for g in (client or {}).get("groups") or []]
        if mine.get("kind"):
            kind, kind_source = mine["kind"], "label"
        elif entry:
            kind, kind_source = "server", "static lease"
        elif "personal" in group_names:
            kind, kind_source = "personal", "Pi-hole group"
        else:
            kind, kind_source = "unknown", ""

        last_query = device.get("last_query")
        recent = last_query is not None and now - last_query < ONLINE_WINDOW
        leased = bool(lease and (lease.get("expires") or 0) > now)
        # Only a reservation is known to be static; anything else may be a
        # phone whose lease lapsed while it was away.
        ip_type = "static-lease" if entry else "dynamic"
        if not device:
            online = None  # never asked DNS: can't tell from here
        else:
            online = recent and (leased or ip_type == "static-lease")

        total, blocked_n = queries.get(ip), blocked.get(ip)
        rate = round(100 * blocked_n / total, 1) if total and blocked_n is not None else (0.0 if total else None)
        seen = last_query or 0
        ghost = ""
        if device and not leased and not entry and now - seen > GHOST_AFTER:
            ghost = "stale"

        out.append({
            "mac": mac, "name": name, "name_source": source, "label": label,
            "kind": kind, "kind_source": kind_source, "notes": mine.get("notes", ""),
            "ip": ip, "ip_type": ip_type, "hostname": hostname, "vendor": vendor,
            "private_mac": private_mac(mac),
            "online": online,
            "first_seen": device.get("first_seen"), "last_seen": last_query,
            "queries_24h": total, "blocked_24h": blocked_n, "block_rate": rate,
            "groups": [g for g in group_names if g],
            "group_ids": list((client or {}).get("groups") or []),
            "ghost": ghost,
        })
    out.sort(key=lambda r: (r["kind"] != "server", r["name"].lower()))
    return out
