import asyncio
import os
import time
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

import requests

from backend.prometheus import get_machine_stats, get_machine_history
from backend.docker import get_all_containers, control_container
from backend.pins import PinStore
from backend.todos import TodoStore
from backend.service_activity_overrides import ServiceActivityOverrideStore
from backend.log import system as system_log
from backend import activity
from backend import alerts
from backend import live_history
from backend import service_activity
from backend import resource_activity
from backend import auth
from backend import scheduler_api
from backend.registry import registry
from backend.scheduler_api import deployments, merge_agent_snapshot


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = scheduler_api.spawn_loops()
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()


app = FastAPI(lifespan=lifespan)
app.include_router(scheduler_api.router)

pins = PinStore()
todos = TodoStore()
service_activity_overrides = ServiceActivityOverrideStore()

# The host the dashboard itself runs on, if any — it gets its own
# top-level section instead of being shown as just another node.
#
# Auto-detected: Docker sets a container's HOSTNAME env var to its own
# short container ID by default, and every agent already reports that
# same ID for this container in its container list (an agent lists every
# container on its host, this one included). So whichever registered
# agent reports a container ID matching our own HOSTNAME is the host
# we're running on — no configuration needed. MAIN_HOST overrides this
# when set, for setups where that detection doesn't apply (HOSTNAME
# overridden in compose, or the dashboard runs on a host with no agent).
SELF_CONTAINER_ID = os.getenv("HOSTNAME", "").strip()
MAIN_HOST_OVERRIDE = os.getenv("MAIN_HOST", "").strip() or None


def _detect_main_host(agent_data: dict) -> str | None:
    if not SELF_CONTAINER_ID:
        return None

    for host, data in agent_data.items():
        for container in data.get("containers", []):
            container_id = container.get("id") or ""

            if container_id and (
                SELF_CONTAINER_ID.startswith(container_id)
                or container_id.startswith(SELF_CONTAINER_ID)
            ):
                return host

    return None


# One templated next-step per issue-key family, for the Overview
# "Recommendations" list. Rebalance moves come separately (with buttons).
def _recommendation(key: str, host: str | None) -> str:
    where = host or "the host"
    if key.endswith(":ram"):
        return f"Free memory on {where} or move a workload off it."
    if key.endswith(":cpu"):
        return f"{where} CPU is saturated — find the runaway container."
    if key.endswith(":offline"):
        return f"{where} is unreachable — check its power and network."
    if key.endswith(":agent"):
        return f"{where} is up but homelab-agent isn't responding — restart that container."
    if key.endswith(":stale"):
        return f"{where} hasn't checked in — confirm homelab-agent is still running."
    if key.startswith("deploy:"):
        return "Redeploy the failed workload, or check its container logs."
    return ""


def _overview(machines: dict, deployment_dumps: list[dict], stale_nodes: set[str]) -> dict:
    """At-a-glance fleet health for the landing page: the same breaches the
    alert loop watches, plus stale nodes, turned into a flat issue list and
    a set of plain next-steps. Deterministic — no LLM."""
    issues: list[dict] = []
    recs: list[str] = []

    for key, alert in alerts.evaluate(machines, deployment_dumps).items():
        severity = "warn" if key.endswith((":ram", ":cpu")) else "bad"
        issues.append(
            {
                "key": key,
                "title": alert["title"],
                "message": alert["message"],
                "severity": severity,
            }
        )
        rec = _recommendation(key, alert.get("host"))
        if rec and rec not in recs:
            recs.append(rec)

    for name in sorted(stale_nodes):
        key = f"host:{name}:stale"
        issues.append(
            {
                "key": key,
                "title": f"{name} stale",
                "message": f"{name} hasn't refreshed its registration recently",
                "severity": "warn",
            }
        )
        rec = _recommendation(key, name)
        if rec not in recs:
            recs.append(rec)

    return {"ok": not issues, "issues": issues, "recommendations": recs}


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.getenv(
            "ALLOWED_ORIGINS",
            "http://localhost:5173",
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"status": "homelab backend online"}


@app.get("/api/nodes")
def list_nodes():
    return registry.listing()


@app.post("/api/nodes")
def register_node(
    payload: dict,
    x_register_token: str | None = Header(default=None),
):
    auth.check_token(x_register_token)

    name = str(payload.get("name", "")).strip()
    url = str(payload.get("url", "")).strip().rstrip("/")

    if not name or not url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="name and an http(s) url are required",
        )

    registry.register(name, url)
    return {"ok": True, "name": name}


@app.delete("/api/nodes/{name}")
def delete_node(
    name: str,
    x_register_token: str | None = Header(default=None),
):
    auth.check_token(x_register_token)
    return {"ok": registry.remove(name)}


@app.post("/api/containers/{host}/{container_id}/{action}")
async def container_action(
    host: str,
    container_id: str,
    action: str,
):
    try:
        result = await asyncio.to_thread(
            control_container,
            registry.all(),
            host,
            container_id,
            action,
        )

        return result

    except ValueError as error:
        return {
            "success": False,
            "error": str(error),
        }

    except requests.RequestException as error:
        return {
            "success": False,
            "error": f"agent unreachable: {error}",
        }


@app.get("/api/pins")
def list_pins():
    """Containers the user pinned to the top of the Containers tab. Pure UI
    state, shared across browsers; also included in every /ws tick."""
    return {"pins": pins.all()}


@app.put("/api/pins")
def set_pins(payload: dict):
    keys = payload.get("pins")
    if not isinstance(keys, list):
        raise HTTPException(status_code=400, detail="'pins' must be a list of strings")
    return {"pins": pins.replace(keys)}


@app.get("/api/service-activity-overrides")
def list_service_activity_overrides():
    """Manual per-container overrides for service_activity's probing
    (Settings → Containers → live-activity). Shared across browsers —
    an override changes what the backend actually probes, not just what
    one browser displays. Also included in every /ws tick."""
    return {"overrides": service_activity_overrides.all()}


@app.put("/api/service-activity-overrides")
def set_service_activity_overrides(payload: dict):
    overrides = payload.get("overrides")
    if not isinstance(overrides, dict):
        raise HTTPException(status_code=400, detail="'overrides' must be an object")
    return {"overrides": service_activity_overrides.replace(overrides)}


@app.get("/api/activity")
def list_activity():
    """Recent fleet events (container/host/deploy transitions) for the
    Overview feed. Also included in every /ws tick."""
    return {"activity": activity.recent()}


@app.get("/api/todos")
def list_todos():
    """The Overview to-do list. Shared across browsers; also in every /ws tick."""
    return {"todos": todos.all()}


@app.put("/api/todos")
def set_todos(payload: dict):
    items = payload.get("todos")
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="'todos' must be a list")
    return {"todos": todos.replace(items)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            nodes = registry.all()

            machines = await asyncio.to_thread(get_machine_stats)
            history = await asyncio.to_thread(get_machine_history)

            agent_data = await asyncio.to_thread(
                get_all_containers,
                nodes,
            )

            # ``agent_reachable`` is distinct from ``online`` (Prometheus
            # "up"): a host can be scraped fine while its agent is down, so
            # its container list is empty but not because it has none.
            containers, offline_hosts = merge_agent_snapshot(
                machines, agent_data
            )

            live_overrides = service_activity_overrides.all()

            # Sampling happens in the reconcile loop (always on); here we
            # just read the rolling series back for the payload.
            for host, conts in containers.items():
                history.setdefault(host, {})["gpu_temperature"] = (
                    live_history.gpu_temp_history(host)
                )
                for container in conts:
                    container["heartbeat"] = live_history.container_heartbeat(
                        host, container["id"]
                    )

                    # A handful of apps (qBittorrent, Jellyfin, ...) can say
                    # whether they're actively in use right now. Only the
                    # cache-miss path does real HTTP calls, off the event
                    # loop — most ticks just read the last result back.
                    if service_activity.stale(host, container, live_overrides):
                        live = await asyncio.to_thread(
                            service_activity.refresh, host, container, live_overrides
                        )
                    else:
                        live = service_activity.peek(host, container, live_overrides)

                    # No app-specific answer (no probe matched, no creds,
                    # or it's simply idle) — fall back to "does this
                    # container's CPU/network look spiked versus its own
                    # recent baseline". override == "none" opts a
                    # container out of both, not just the API probe.
                    override = live_overrides.get(
                        service_activity.override_key(host, container)
                    )
                    if not live and override != "none":
                        live = resource_activity.busy(host, container)

                    if live:
                        container["live_activity"] = live

            main_host = MAIN_HOST_OVERRIDE or _detect_main_host(agent_data)

            deployments.reconcile(containers, offline_hosts)

            dumps = [d.model_dump() for d in deployments.all()]
            stale_nodes = {n["name"] for n in registry.listing() if n["stale"]}

            await websocket.send_json({
                "type": "dashboard_update",
                "machines": machines,
                "containers": containers,
                "main_host": main_host,
                "history": history,
                "deployments": dumps,
                "pins": pins.all(),
                "todos": todos.all(),
                "service_activity_overrides": live_overrides,
                "activity": activity.recent(),
                "overview": _overview(machines, dumps, stale_nodes),
                "server_time": time.time(),
            })

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        system_log.debug("dashboard client disconnected")
