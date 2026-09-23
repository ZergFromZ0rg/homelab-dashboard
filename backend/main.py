import asyncio
import os
import time
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect

import requests

from backend.prometheus import get_machine_stats, get_machine_history
from backend.docker import get_all_containers, control_container
from backend.pins import PinStore
from backend.todos import TodoStore
from backend.notes import Conflict, NoteStore
from backend.service_activity_credentials import ServiceActivityCredentialStore
from backend.log import system as system_log
from backend import activity
from backend import agent_config
from backend import alert_history
from backend import alerts
from backend import checks
from backend import connections
from backend import container_history
from backend import checks_api
from backend import personal
from backend import prometheus_link
from backend import rebuilds
from backend import live_history
from backend import service_activity
from backend import auth
from backend import scheduler_api
from backend import volume_backup_api
from backend import volume_backups
from backend.registry import registry
from backend.scheduler_api import deployments, merge_agent_snapshot


@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = scheduler_api.spawn_loops()
    tasks.append(asyncio.create_task(checks.service.run_forever()))
    tasks.append(asyncio.create_task(volume_backup_api.run_forever()))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        # Save check history so a restart doesn't lose the last minute.
        checks.service.persist()


app = FastAPI(lifespan=lifespan)
app.include_router(scheduler_api.router)
app.include_router(checks_api.router)
app.include_router(volume_backup_api.router)

pins = PinStore()
todos = TodoStore()
notes = NoteStore()
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
    check_summaries: list[dict] | None = None,
    nodes: dict | None = None,
    prometheus_jobs: list[str] | None = None,
) -> dict:
    """At-a-glance fleet health for the landing page: the same breaches the
    alert loop watches, plus stale nodes, turned into a flat issue list and
    a set of plain next-steps. Deterministic — no LLM."""
    issues: list[dict] = []
    recs: list[str] = []

    for key, alert in alerts.evaluate(
        machines, deployment_dumps, containers, check_summaries,
        volume_backups.store.all(),
    ).items():
        severity = alerts.severity_of(key, alert)
        issues.append(
            {
                "key": key,
                "title": alert["title"],
                "message": alert["message"],
                "severity": severity,
            }
        )
        rec = alert.get("hint") or _recommendation(key, alert.get("host"))
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

    # An agent whose name doesn't match a Prometheus job. Worth surfacing
    # because it's invisible otherwise: the host card renders "online"
    # with every gauge blank.
    link_issues, link_steps = prometheus_link.issues(
        nodes or {}, prometheus_jobs or []
    )
    issues.extend(link_issues)
    for step in link_steps:
        if step not in recs:
            recs.append(step)

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


def _agent_for(host: str) -> str:
    nodes = registry.all()
    if host not in nodes:
        raise HTTPException(status_code=404, detail="Unknown host")
    return nodes[host]["url"].rstrip("/")


@app.post("/api/rebuild/{host}")
def start_rebuild(
    host: str,
    payload: dict | None = None,
    x_register_token: str | None = Header(default=None),
):
    """Ask a host's agent to pull and rebuild a container's Compose project.

    Token-gated here as well as on the agent: this is the one dashboard
    route that makes a host run arbitrary code from a repo.
    """
    auth.check_token(x_register_token)

    body = payload or {}
    container = str(body.get("container") or "").strip()
    if not container:
        raise HTTPException(status_code=400, detail="container is required")

    try:
        return rebuilds.start(
            _agent_for(host), container, pull=bool(body.get("pull", True))
        )
    except rebuilds.RebuildError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


@app.post("/api/fleet/rebuild")
def rebuild_fleet(
    payload: dict | None = None,
    x_register_token: str | None = Header(default=None),
):
    """Update every agent, or the named ones.

    Each agent rebuilds its own project and hands the work to a throwaway
    container, so this returns as soon as the jobs exist rather than
    waiting for builds that take minutes.
    """
    auth.check_token(x_register_token)

    body = payload or {}
    hosts = body.get("hosts")
    if hosts is not None and not isinstance(hosts, list):
        raise HTTPException(status_code=400, detail="hosts must be a list")

    nodes = registry.all()
    if not nodes:
        raise HTTPException(status_code=400, detail="no agents are registered")

    main_host = MAIN_HOST_OVERRIDE or _detect_main_host(
        get_all_containers(nodes)
    )

    return rebuilds.fleet(nodes, hosts, main_host)


@app.get("/api/rebuild/{host}/{job_id}")
def rebuild_job(host: str, job_id: str):
    try:
        return rebuilds.job(_agent_for(host), job_id)
    except rebuilds.RebuildError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


@app.get("/api/hosts/{host}/config")
def host_config(host: str, x_register_token: str | None = Header(default=None)):
    """What this host's agent can be told, and what it already is.

    Readable on a host that doesn't accept settings too — the answer
    carries the reason and the one line that changes it, which is more use
    than an empty page.
    """
    auth.check_token(x_register_token)

    try:
        return agent_config.read(_agent_for(host))
    except agent_config.ConfigError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


@app.put("/api/hosts/{host}/config")
def set_host_config(
    host: str,
    payload: dict,
    x_register_token: str | None = Header(default=None),
):
    """Change settings on one host's agent.

    Token-gated like the rebuild route: turning on rebuilds, or widening
    which directories may leave a host, is the same class of decision.
    """
    auth.check_token(x_register_token)

    settings = payload.get("settings")

    if not isinstance(settings, dict):
        raise HTTPException(status_code=400, detail="settings must be an object")

    try:
        return agent_config.write(_agent_for(host), settings)
    except agent_config.ConfigError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error))


@app.get("/api/containers/{host}/{name}/history")
def container_history_route(host: str, name: str, range: str = "24h"):
    """CPU and memory for one container over hours or days.

    Off the /ws payload deliberately: it's only wanted while someone has a
    container's details open, and sending every container's week to every
    client every two seconds would be absurd.
    """
    try:
        return container_history.history(host, name, range)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@app.get("/api/connections/{host}")
def host_connections(host: str, refresh: bool = False):
    """Who one host is talking to, from its agent's conntrack table.

    Deliberately off the /ws payload: a busy host's table is large and only
    interesting while someone is looking at it. Cached for 30s; ``refresh``
    forces a re-read for the panel's own reload.
    """
    base_url = _agent_for(host)
    return {"host": host, **connections.for_host(host, base_url, refresh=refresh)}


@app.get("/api/alerts")
def list_alerts():
    """What the alert monitor has fired, newest first. An entry with a
    null ``resolved_at`` is still firing."""
    return {"alerts": alert_history.recent()}


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


@app.get("/api/notes")
def list_notes():
    """Personal-tab notes, newest edit first."""
    return {"notes": notes.all()}


@app.post("/api/notes", status_code=201)
def create_note(payload: dict | None = None):
    try:
        return notes.create((payload or {}).get("body", ""))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@app.put("/api/notes/{note_id}")
def save_note(note_id: str, payload: dict):
    """Save one note. ``base_updated_at`` is the version being edited; if it
    has since changed (another device), this answers 409 with the current
    copy instead of overwriting it."""
    base = payload.get("base_updated_at")
    if base is not None and (isinstance(base, bool) or not isinstance(base, (int, float))):
        raise HTTPException(status_code=400, detail="'base_updated_at' must be a number")
    try:
        note = notes.update(note_id, payload.get("body"), base)
    except Conflict as conflict:
        return JSONResponse(
            status_code=409,
            content={"detail": "This note was changed somewhere else.", "current": conflict.current},
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    if note is None:
        raise HTTPException(status_code=404, detail="no such note")
    return note


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: str):
    if not notes.delete(note_id):
        raise HTTPException(status_code=404, detail="no such note")
    return {"deleted": note_id}


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
            # Taken before merge_agent_snapshot adds stubs for agent-only
            # hosts, so this really is "what Prometheus knows about".
            prometheus_jobs = list(machines)
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
            check_summaries = checks.service.summaries()

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
                "alerts": alert_history.recent(),
                "checks": check_summaries,
                "overview": _overview(
                    machines,
                    dumps,
                    stale_nodes,
                    containers,
                    check_summaries,
                    nodes=nodes,
                    # Prometheus keys its data by job; `machines` came from
                    # it, so its keys are exactly the jobs that exist.
                    prometheus_jobs=prometheus_jobs,
                ),
                "server_time": time.time(),
            })

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        system_log.debug("dashboard client disconnected")
