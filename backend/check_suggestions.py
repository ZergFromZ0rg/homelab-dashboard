"""Checks the dashboard could add for you: "nothing watches this yet".

Built from what the dashboard already knows — every registered host and every
running container that publishes a TCP port — minus anything an existing check
already covers and anything you dismissed. Nothing is created until you accept
it, and the list is recomputed on demand, so it never goes stale.

    host        ping the host's LAN address (its first private IPv4)
    container   its main published port: a Website check for the usual web
                ports, a Port check for everything else (databases, SSH, ...)

Accepting probes each website once and quietly downgrades it to a Port check
if the page answers with an error status (a login wall or 401 would otherwise
show up red from day one).
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

from backend import checks
from backend.env import env_str
from backend.jsonstore import read_json, write_json_atomic

DISMISSED_FILE = Path(env_str("CHECK_SUGGESTIONS_FILE", "/data/check_suggestions.json"))

# Same list the container rows use to pick "the" web port.
WEB_PORTS = (80, 443, 3000, 3001, 5000, 8000, 8080, 8081, 8082, 8083, 8096, 8888, 9000, 9090, 9091)
HTTPS_PORTS = (443, 8443)
VERIFY_TIMEOUT = 3.0


class Dismissed:
    """Keys of suggestions the user said no to (``/data/check_suggestions.json``)."""

    def __init__(self, path: Path = DISMISSED_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        data = read_json(self.path, [])
        self._keys: set[str] = {k for k in data if isinstance(k, str)} if isinstance(data, list) else set()

    def all(self) -> set[str]:
        with self._lock:
            return set(self._keys)

    def add(self, keys: list[str]) -> None:
        with self._lock:
            self._keys.update(k for k in keys if isinstance(k, str))
            write_json_atomic(self.path, sorted(self._keys), label="check suggestions")


dismissed = Dismissed()


def _main_port(ports: dict) -> int | None:
    """The host port a person would open: a usual web port if there is one,
    otherwise the lowest published TCP port."""
    found: list[int] = []
    for key, host_ports in (ports or {}).items():
        port, _, proto = key.partition("/")
        if proto != "tcp" or not port.isdigit():
            continue
        for host_port in host_ports or []:
            if str(host_port).isdigit():
                found.append(int(host_port))
    if not found:
        return None
    web = [p for p in found if p in WEB_PORTS]
    return min(web) if web else min(found)


def _host_address(host: str, lan: dict, nodes: dict) -> str:
    for entry in lan.get(host) or []:
        ip = entry.get("ip") if isinstance(entry, dict) else entry
        if ip:
            return ip
    return urlsplit(nodes.get(host, {}).get("url", "")).hostname or host


def _covered(existing: list[dict]) -> tuple[set[tuple[str, int]], set[str]]:
    """What current checks already watch: (host, port) pairs and ping hosts."""
    pairs: set[tuple[str, int]] = set()
    pinged: set[str] = set()
    for c in existing:
        target = c["target"]
        if c["type"] == "ping":
            pinged.add(target.lower())
        elif c["type"] in ("http", "keyword"):
            parts = urlsplit(target)
            port = parts.port or (443 if parts.scheme == "https" else 80)
            pairs.add(((parts.hostname or "").lower(), port))
        elif c["type"] in ("tcp", "tls"):
            host, _, port = target.rpartition(":")
            pairs.add((host.lower(), int(port)))
    return pairs, pinged


def suggest(containers: dict[str, list], nodes: dict, lan: dict, existing: list[dict], skip: set[str]) -> list[dict]:
    pairs, pinged = _covered(existing)
    out: list[dict] = []

    def aliases(host: str) -> set[str]:
        """Every name an existing check might use for this host."""
        found = {host.lower(), _host_address(host, lan, nodes).lower()}
        found.add((urlsplit(nodes[host].get("url", "")).hostname or "").lower())
        return found - {""}

    for host in sorted(nodes):
        address = _host_address(host, lan, nodes)
        key = f"host:{host}"
        if key in skip or aliases(host) & pinged:
            continue
        out.append({
            "key": key, "group": "Hosts", "name": host, "type": "ping", "target": address,
            "reason": "is this machine reachable", "host": host,
        })

    # The snapshot's shape: host -> that host's container list.
    flat = [(host, c) for host, items in (containers or {}).items() for c in items or []]
    for host, container in sorted(flat, key=lambda hc: (hc[0], hc[1].get("name") or "")):
        name = container.get("name")
        if not name or container.get("status") != "running" or host not in nodes:
            continue
        port = _main_port(container.get("ports") or {})
        if port is None:
            continue
        address = _host_address(host, lan, nodes)
        key = f"container:{host}:{name}"
        if key in skip or any((a, port) in pairs for a in aliases(host)):
            continue

        web = port in WEB_PORTS or port in HTTPS_PORTS
        scheme = "https" if port in HTTPS_PORTS else "http"
        out.append({
            "key": key,
            "group": host,
            "name": name,
            "type": "http" if web else "tcp",
            "target": f"{scheme}://{address}:{port}" if web else f"{address}:{port}",
            "reason": f"{name} on {host}, port {port}",
            "host": host,
            "aliases": sorted(aliases(host)),
            # A self-signed certificate is the norm on a LAN service.
            "verify_tls": scheme != "https",
        })
    # The same container on two hosts (an agent, a reverse proxy) needs the
    # host in its name to be told apart in the table.
    seen: dict[str, int] = {}
    for item in out:
        if item["group"] != "Hosts":
            seen[item["name"]] = seen.get(item["name"], 0) + 1
    for item in out:
        if seen.get(item["name"], 0) > 1 and item["group"] != "Hosts":
            item["name"] = f"{item['name']} ({item['group']})"
    return out


def _settle(item: dict) -> dict:
    """Probe a website suggestion once; an answer that isn't healthy but
    proves the port is open becomes a Port check instead."""
    if item["type"] != "http":
        return item
    spec = {
        "type": "http", "target": item["target"], "timeout": VERIFY_TIMEOUT,
        "verify_tls": item.get("verify_tls", True),
    }
    if checks.probe(spec).ok:
        return item
    parts = urlsplit(item["target"])
    return {
        **item,
        "type": "tcp",
        "target": f"{parts.hostname}:{parts.port or 80}",
    }


def settle(items: list[dict]) -> list[dict]:
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=min(8, len(items))) as pool:
        return list(pool.map(_settle, items))


def accept(store: checks.CheckStore, items: list[dict]) -> list[dict]:
    """Create a check for each (already filtered) suggestion. Stops quietly at
    the check limit; returns the specs that were created.

    Hosts go first: a container's check is grouped under its host and depends
    on that host's ping check (one just made, or one you already had), so a
    dead machine raises one alert instead of one per container."""
    created: list[dict] = []
    host_check: dict[str, str] = {}
    ordered = sorted(settle(items), key=lambda i: i["group"] != "Hosts")

    for item in ordered:
        is_host = item["group"] == "Hosts"
        payload = {k: item[k] for k in ("name", "type", "target") if k in item}
        payload["group"] = item["group"]
        if item["type"] == "http":
            payload["verify_tls"] = item.get("verify_tls", True)
        if not is_host:
            parent = host_check.get(item.get("host", ""))
            if parent is None:
                aliases = set(item.get("aliases") or [])
                parent = next(
                    (c["id"] for c in store.all() if c["type"] == "ping" and c["target"].lower() in aliases),
                    None,
                )
            payload["parent"] = parent
        try:
            spec = store.create(payload)
        except ValueError:
            break
        created.append(spec)
        if is_host:
            host_check[item["host"]] = spec["id"]
    return created
