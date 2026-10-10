"""Pi-hole routes: read-only, served from the collector's cache. The browser
never calls Pi-hole itself."""

from fastapi import APIRouter

from backend import pihole

router = APIRouter(prefix="/api/pihole")


@router.get("")
def overview():
    return pihole.collector.snapshot()


@router.get("/devices")
def devices():
    return {"devices": pihole.collector.devices()}
