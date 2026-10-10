"""Pi-hole routes: read-only from the collector's cache, plus the labels you
give devices. The browser never calls Pi-hole itself."""

import time

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse

from backend import auth, device_meta, device_names, network_devices, pihole

router = APIRouter(prefix="/api/pihole")


@router.get("")
def overview():
    return pihole.collector.snapshot()


@router.get("/devices")
def devices():
    inputs = pihole.collector.device_inputs()
    rows = network_devices.merge(inputs, device_names.names.all(), device_meta.meta.all(), time.time())
    return {"devices": rows, "updated_at": inputs["updated_at"], "kinds": list(device_meta.KINDS)}


@router.put("/devices/{mac}")
def label(mac: str, payload: dict, x_register_token: str | None = Header(default=None)):
    """Name, kind and notes for one device. Fields left out stay as they are;
    blank ones are cleared."""
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
        return JSONResponse(status_code=400, content={"error": str(error)})
    return {"ok": True}
