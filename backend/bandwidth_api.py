"""Bandwidth and internet speed routes. Reads come from caches; a speed test
runs in the background and the page polls for its result."""

import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend import bandwidth, speedtest, switch

router = APIRouter(prefix="/api")


class Schedule(BaseModel):
    every_hours: int


@router.get("/bandwidth")
def devices():
    return bandwidth.monitor.snapshot()


@router.get("/speedtest")
def results():
    return speedtest.test.snapshot(switch.monitor.snapshot())


@router.post("/speedtest/run", status_code=202)
def run():
    if speedtest.test.running:
        raise HTTPException(status_code=409, detail="A test is already running")

    def go():
        try:
            speedtest.test.run(manual=True)
        except speedtest.SpeedTestError:
            pass  # kept as the card's error

    threading.Thread(target=go, daemon=True).start()
    snapshot = speedtest.test.snapshot(switch.monitor.snapshot())
    return {**snapshot, "running": True}


@router.put("/speedtest/schedule")
def schedule(body: Schedule):
    try:
        speedtest.test.set_every(body.every_hours)
    except ValueError as failure:
        raise HTTPException(status_code=422, detail=str(failure)) from failure
    return speedtest.test.snapshot(switch.monitor.snapshot())
