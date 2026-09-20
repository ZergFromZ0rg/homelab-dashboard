import asyncio
import os
import time
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect

import requests

from backend.prometheus import get_machine_stats, get_machine_history
from backend.docker import get_all_containers, control_container
from backend.pins import PinStore
from backend.todos import TodoStore
from backend.service_activity_credentials import ServiceActivityCredentialStore
from backend.log import system as system_log
from backend import activity
from backend import alerts
from backend import personal
from backend import live_history
from backend import service_activity
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
service_activity_credentials = ServiceActivityCredentialStore()

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
# Keys look like ``host:<name>:<kind>[:<extra>]`` or
# ``container:<host>:<name>:<kind>`` or ``deploy:<id>``.
def _recommendation(key: str, host: str | None) -> str:
    where = host or "the host"
    parts = key.split(":")

    if parts[0] == "deploy":
        return "Redeploy the failed workload, or check its container logs."

    if parts[0] == "container":
        name = parts[2] if len(parts) > 2 else "the container"
        kind = parts[3] if len(parts) > 3 else ""
        if kind == "unhealthy":
            return f"Read {name}'s logs on {where} (docker logs {name}) — its healthcheck is failing."
        if kind == "restarting":
            return f"{name} is crash-looping on {where} — read its logs (docker logs {name}) to see why it exits."
        return ""

    kind = parts[2] if len(parts) > 2 else ""
    return {
        "ram": f"Free memory on {where} or move a workload off it.",
        "cpu": f"{where} CPU is saturated — find the runaway container.",
        "offline": f"{where} is unreachable — check its power and network.",
        "agent": f"{where} is up but homelab-agent isn't responding — restart that container.",
        "stale": f"{where} hasn't checked in — confirm homelab-agent is still running.",
        "temp": f"{where} is running hot — check its fans, dust and airflow.",
        "gpu-temp": f"{where}'s GPU is running hot — check its fan and case airflow.",
        "disk": f"Free space on {where} — clear old logs and images (docker system prune) or extend the volume.",
        "diskfull": f"{where} is filling up — find what's growing (docker system df, du -sh) before it hits 100%.",
        "backup": f"Check homelab-agent's logs on {where} and its BACKUP_REPO / GITHUB_TOKEN settings.",
    }.get(kind, "")


def _overview(
    machines: dict,
    deployment_dumps: list[dict],
    stale_nodes: set[str],
    containers: dict | None = None,
) -> dict:
    """At-a-glance fleet health for the landing page: the same breaches the
    alert loop watches, plus stale nodes, turned into a flat issue list and
    a set of plain next-steps. Deterministic — no LLM."""
    issues: list[dict] = []
    recs: list[str] = []

    for key, alert in alerts.evaluate(machines, deployment_dumps, containers).items():
        severity = alert.get("severity") or (
            "warn" if key.endswith((":ram", ":cpu")) else "bad"
        )
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

    # Worst first; the sort is stable so equal severities keep their order.
    issues.sort(key=lambda issue: issue["severity"] != "bad")

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


@app.get("/api/service-activity-credentials")
def get_service_activity_credentials():
    """Which service_activity apps have credentials configured — never
    the credential values themselves (write-only from the API's point of
    view). Not part of the /ws payload — fetched once when Settings
    opens, not something that needs to stream."""
    return {"configured": service_activity_credentials.configured()}


@app.put("/api/service-activity-credentials")
def set_service_activity_credentials(payload: dict):
    """Body: {"app": "qbittorrent", "credentials": {"username": ..., "password": ...}}
    (or {"app": "jellyfin", "credentials": {"api_key": ...}}). Merges into
    that app's stored fields — a blank value clears just that field."""
    app_name = payload.get("app")
    fields = payload.get("credentials")

    if not isinstance(fields, dict):
        raise HTTPException(status_code=400, detail="'credentials' must be an object")

    try:
        service_activity_credentials.set(app_name, fields)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return {"configured": service_activity_credentials.configured()}


@app.delete("/api/service-activity-credentials/{app_name}")
def clear_service_activity_credentials(app_name: str):
    service_activity_credentials.clear(app_name)
    return {"configured": service_activity_credentials.configured()}


@app.get("/api/activity")
def list_activity():
    """Recent fleet events (container/host/deploy transitions) for the
    Overview feed. Also included in every /ws tick."""
    return {"activity": activity.recent()}


def _personal(fn, *args):
    """Run a Personal-tab provider call; a dead upstream is a 502, bad
    input (already range-checked by FastAPI) a 400."""
    try:
        return fn(*args)
    except personal.PersonalDataError as error:
        raise HTTPException(status_code=502, detail=str(error))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@app.get("/api/personal/weather")
def personal_weather(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    units: str = "metric",
):
    """Current conditions + a 5-day forecast for a point (Open-Meteo,
    cached server-side). The location itself is a per-browser preference,
    so it comes in on every call rather than being stored here."""
    return _personal(personal.get_weather, lat, lon, units)


@app.get("/api/personal/places")
def personal_places(q: str = Query(min_length=2, max_length=80)):
    """City search for picking a weather location."""
    return {"places": _personal(personal.search_places, q)}


@app.get("/api/personal/word")
def personal_word():
    """Today's Wiktionary word of the day."""
    return _personal(personal.get_word_of_the_day)


@app.get("/api/todos")
def list_todos():
    """The to-do list (Personal tab). Shared across browsers; also in every /ws tick."""
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

            live_credentials = service_activity_credentials.all()

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
                    if service_activity.stale(host, container):
                        live = await asyncio.to_thread(
                            service_activity.refresh,
                            host,
                            container,
                            live_credentials,
                        )
                    else:
                        live = service_activity.peek(host, container)

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
                "activity": activity.recent(),
                "overview": _overview(machines, dumps, stale_nodes, containers),
                "server_time": time.time(),
            })

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        system_log.debug("dashboard client disconnected")
