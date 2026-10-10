"""Read-only ways out of the Pi-hole data: Prometheus metrics, and tools for an AI agent.

Neither can change anything. The metrics route also takes a bearer token of its
own (``METRICS_TOKEN``), so Prometheus can scrape it without a passkey session
and without holding a credential that could change the dashboard — see the
session gate."""

import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from backend import device_meta, device_names, network_context, network_devices, pihole, pihole_alerts, pihole_metrics

router = APIRouter()


@router.get("/api/pihole/metrics")
def metrics():
    if not pihole.collector.configured:
        return PlainTextResponse("Pi-hole isn't connected\n", status_code=404)
    inputs = pihole.collector.device_inputs()
    rows = network_devices.merge(inputs, device_names.names.all(), device_meta.meta.all(), time.time())
    return PlainTextResponse(
        pihole_metrics.render(pihole.collector.snapshot(), rows, new=len(pihole_alerts.known.new())),
        media_type=pihole_metrics.CONTENT_TYPE,
    )


@router.get("/api/agent/tools")
def tools():
    """The network tools an agent can call, as tool-calling definitions."""
    return {"tools": network_context.definitions()}


@router.get("/api/agent/tools/{name}")
def run_tool(name: str, request: Request):
    """Run one tool. Arguments are query parameters (``?device=firestick``)."""
    result = network_context.call(name, dict(request.query_params))
    if result is None:
        return JSONResponse(status_code=404, content={"error": f"no tool called {name}"})
    return result
