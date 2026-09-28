import asyncio
import os
import time
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, WebSocket, WebSocketDisconnect


from backend.prometheus import get_machine_stats, get_machine_history
from backend.docker import get_all_containers
from backend.log import system as system_log
from backend import activity
from backend import alert_history
from backend import alerts
from backend import checks
from backend import checks_api
from backend import prometheus_link
from backend import live_history
from backend import service_activity
from backend import auth
from backend import auth_api
from backend import passkeys
from backend import scheduler_api
from backend import terminal
from backend import files_api
from backend import compose_api
from backend import updates_api
from backend import volume_backup_api
from backend import volume_backups
from backend.registry import registry
from backend import audit_log, fleet_api, host_tools_api, personal_api
from backend.hosts import MAIN_HOST_OVERRIDE, detect_main_host
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
app.include_router(auth_api.router)
app.include_router(scheduler_api.router)
app.include_router(checks_api.router)
app.include_router(volume_backup_api.router)
app.include_router(terminal.router)
app.include_router(files_api.router)
app.include_router(compose_api.router)
app.include_router(updates_api.router)
app.include_router(fleet_api.router)
app.include_router(host_tools_api.router)
app.include_router(personal_api.router)

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

    return {
        "ok": not issues,
        "issues": issues,
        "recommendations": recs,
        # AUTH: the standing mark. Every route that can touch a host is
        # gated, but a gate with no token is a gate standing open, and that
        # is invisible unless something says so.
        #
        # Its own field rather than an issue, deliberately: an issue that
        # can never be cleared would mean the Attention panel is never
        # clean, and "no issues detected" is a signal worth keeping honest.
        # This is a posture, not an incident.
        "security": _security_posture(),
    }


def _security_posture() -> dict:
    if passkeys.store.enabled() or auth.API_TOKEN:
        return {"authenticated": True, "message": None, "hint": None}

    return {
        "authenticated": False,
        "message": (
            "This dashboard is unauthenticated. Anyone who can reach it can "
            "stop containers, rebuild hosts, change agent settings and store "
            "service credentials."
        ),
        "hint": (
            "Add a passkey in Settings → Passkeys to require a Face ID / "
            "Touch ID sign-in. Passkeys need HTTPS — see docs/deployment.md "
            "(Login). Scripts can still use API_TOKEN."
        ),
    }


# Added before CORS so CORS stays outermost and a 401 still carries its
# headers.
app.add_middleware(auth_api.SessionGate)
# Added after the gate, so outside it: refused attempts are recorded too.
app.add_middleware(audit_log.AuditMiddleware)
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


# One payload per tick, shared by every open dashboard. Building it costs
# ~100 ms of CPU (the Prometheus queries dominate) and it used to be built
# per connection: three open tabs meant three times the queries and three
# reconciles of the scheduler's state per tick — the dashboard idled at
# ~15% of a core for that alone.
TICK_SECONDS = 2
_tick: dict = {"at": 0.0, "payload": None}
_tick_lock = asyncio.Lock()


async def _build_update() -> dict:
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

    live_credentials = personal_api.service_activity_credentials.all()

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

    main_host = MAIN_HOST_OVERRIDE or detect_main_host(agent_data)

    deployments.reconcile(containers, offline_hosts)

    dumps = [d.model_dump() for d in deployments.all()]
    stale_nodes = {n["name"] for n in registry.listing() if n["stale"]}
    check_summaries = checks.service.summaries()

    return {
        "type": "dashboard_update",
        "machines": machines,
        "containers": containers,
        "main_host": main_host,
        "history": history,
        "deployments": dumps,
        "pins": personal_api.pins.all(),
        "todos": personal_api.todos.all(),
        "activity": activity.recent(),
        "alerts": alert_history.recent(),
        "checks": check_summaries,
        "backups": volume_backups.summary(),
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
    }


async def shared_update() -> dict:
    async with _tick_lock:
        if _tick["payload"] is None or time.time() - _tick["at"] >= TICK_SECONDS - 0.25:
            _tick["payload"] = await _build_update()
            _tick["at"] = time.time()
        return _tick["payload"]


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            await websocket.send_json(await shared_update())
            await asyncio.sleep(TICK_SECONDS)

    except WebSocketDisconnect:
        system_log.debug("dashboard client disconnected")
