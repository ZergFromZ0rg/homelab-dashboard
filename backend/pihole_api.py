"""Pi-hole routes. Reading is from the collector's cache (a device's detail reads
the query log when you open it). Changing anything is a click and goes through
the same gate as the other changing routes. The browser never calls Pi-hole."""

import re
import time

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse

from backend import auth, device_meta, device_names, network_devices, pihole, pihole_alerts, switch

router = APIRouter(prefix="/api/pihole")

_DOMAIN = re.compile(r"^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$")
MAX_PAUSE_MINUTES = 24 * 60


def _fail(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _guard(fn):
    """Run a Pi-hole call; turn its failures into a message the UI can show."""
    if not pihole.collector.configured:
        return _fail("Pi-hole isn't connected (PIHOLE_URL / PIHOLE_APP_PASSWORD)", 503)
    try:
        return fn()
    except pihole.PiholeError as error:
        return _fail(str(error), 502)


def _rows() -> tuple[list[dict], dict]:
    inputs = pihole.collector.device_inputs()
    rows = network_devices.merge(inputs, device_names.names.all(), device_meta.meta.all(), time.time())
    fresh = pihole_alerts.known.new()
    for row in rows:
        row["new"] = row["mac"] in fresh
    switch.attach_ports(rows, switch.monitor.snapshot())
    return rows, inputs


@router.get("")
def overview():
    return pihole.collector.snapshot()


@router.get("/devices")
def devices():
    rows, inputs = _rows()
    groups = [{"id": i, "name": n} for i, n in sorted((inputs["extras"].get("groups") or {}).items())]
    return {"devices": rows, "updated_at": inputs["updated_at"], "kinds": list(device_meta.KINDS), "groups": groups}


@router.get("/devices/{mac}")
def device(mac: str):
    """One device: its day as a line, what it asks for and what is refused, latest queries."""
    rows, _ = _rows()
    row = next((r for r in rows if r["mac"] == mac.lower()), None)
    if not row:
        return _fail("no such device", 404)
    if not row["ip"]:
        return {"device": row, "detail": None}
    return _guard(lambda: {"device": row, "detail": pihole.collector.device_detail(row["ip"])})


@router.put("/devices/{mac}")
def label(mac: str, payload: dict, x_register_token: str | None = Header(default=None)):
    """Name, kind and notes for one device. Fields left out stay as they are;
    blank ones are cleared. Saving one counts as having accounted for it."""
    auth.check_token(x_register_token)
    try:
        if "name" in payload:
            device_names.names.set(mac, str(payload["name"] or ""))
        if "kind" in payload or "notes" in payload:
            device_meta.meta.set(
                mac,
                kind=None if "kind" not in payload else str(payload["kind"] or ""),
                notes=None if "notes" not in payload else str(payload["notes"] or ""),
            )
    except ValueError as error:
        return _fail(str(error))
    pihole_alerts.known.acknowledge(mac)
    return {"ok": True}


@router.post("/devices/{mac}/known")
def mark_known(mac: str, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    pihole_alerts.known.acknowledge(mac)
    return {"ok": True}


@router.put("/devices/{mac}/group")
def set_group(mac: str, payload: dict, x_register_token: str | None = Header(default=None)):
    """Move a device to one Pi-hole group (e.g. Default <-> no-blocking)."""
    auth.check_token(x_register_token)
    groups = pihole.collector.device_inputs()["extras"].get("groups") or {}
    try:
        group = int(payload.get("group"))
    except (TypeError, ValueError):
        return _fail("group must be a group id")
    if group not in groups:
        return _fail("no such group")
    return _guard(lambda: (pihole.collector.set_client_groups(mac, [group]), {"ok": True})[1])


@router.post("/blocking")
def blocking(payload: dict, x_register_token: str | None = Header(default=None)):
    """Pause blocking for some minutes (or until resumed), or turn it back on."""
    auth.check_token(x_register_token)
    enabled = bool(payload.get("enabled"))
    minutes = payload.get("minutes")
    if not enabled and minutes is not None:
        try:
            minutes = int(minutes)
        except (TypeError, ValueError):
            return _fail("minutes must be a number")
        if not 1 <= minutes <= MAX_PAUSE_MINUTES:
            return _fail(f"minutes must be between 1 and {MAX_PAUSE_MINUTES}")
    seconds = minutes * 60 if (not enabled and minutes) else None
    return _guard(lambda: (pihole.collector.set_blocking(enabled, seconds), pihole.collector.snapshot())[1])


def _clean_domain(value) -> str | None:
    domain = str(value or "").strip().lower().rstrip(".")
    return domain if _DOMAIN.match(domain) else None


@router.post("/allow")
def allow(payload: dict, x_register_token: str | None = Header(default=None)):
    """Let a domain through for every device. Undo with DELETE /allow/{domain}."""
    auth.check_token(x_register_token)
    domain = _clean_domain(payload.get("domain"))
    if not domain:
        return _fail("that doesn't look like a domain name")
    return _guard(lambda: (pihole.collector.allow_domain(domain, "allowed from the dashboard"), {"ok": True, "domain": domain})[1])


@router.delete("/allow/{domain}")
def unallow(domain: str, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    clean = _clean_domain(domain)
    if not clean:
        return _fail("that doesn't look like a domain name")
    return _guard(lambda: (pihole.collector.unallow_domain(clean), {"ok": True, "domain": clean})[1])
