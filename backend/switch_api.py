"""Switch routes: read-only, from the collector's cache."""

from fastapi import APIRouter

from backend import switch

router = APIRouter(prefix="/api/switch")


@router.get("")
def overview():
    return switch.monitor.snapshot()
