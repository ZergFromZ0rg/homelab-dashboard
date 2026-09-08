import asyncio
import os
import time
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

import requests

from backend.prometheus import get_machine_stats, get_machine_history
from backend.docker import (
    get_all_containers,
    control_container,
    deploy_container,
    remove_container,
    deploy_stack,
    remove_stack,
    agent_spec_payload,
)
from backend.registry import NodeRegistry
from backend.deployments import DeploymentStore
from backend.pins import PinStore
from backend.models import (
    DeploymentSpec,
    DeploymentRecord,
    PlacementResponse,
    StackSpec,
)
from backend.compose import ComposeError
from backend.log import scheduler as sched_log, system as system_log
from backend import live_history
from backend import scheduler
from backend import rebalance
from backend import autorebalance
from backend import alerts
from backend import stacks
from backend import llm

@asynccontextmanager
async def lifespan(_: FastAPI):
    tasks = [
        asyncio.create_task(_reconcile_loop()),
        asyncio.create_task(_auto_rebalance_loop()),
        asyncio.create_task(_alert_loop()),
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()


app = FastAPI(lifespan=lifespan)

registry = NodeRegistry()
deployments = DeploymentStore()
pins = PinStore()
alert_monitor = alerts.AlertMonitor()

# ``API_TOKEN`` is the new name; ``REGISTER_TOKEN`` stays as an alias so
# existing deployments keep working. When set, it gates every mutating
# route — node register/delete, container control, and all deploy routes.
REGISTER_TOKEN = (
    os.getenv("API_TOKEN", "").strip() or os.getenv("REGISTER_TOKEN", "").strip()
)

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


def _check_token(supplied: str | None) -> None:
    if REGISTER_TOKEN and supplied != REGISTER_TOKEN:
        raise HTTPException(status_code=401, detail="invalid registration token")


def _offline_machine(reachable: bool) -> dict:
    return {
        "online": reachable,
        "cpu": None,
        "cpu_cores": None,
        "cpu_physical_cores": None,
        "cpu_model": None,
        "ram": None,
        "ram_total_bytes": None,
        "temperature": None,
        "uptime": None,
        "load1": None,
        "network_rx": None,
        "network_tx": None,
        "filesystems": [],
        "disk_io": [],
    }


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
    _check_token(x_register_token)

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
    _check_token(x_register_token)
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


# ---------------------------------------------------------------------------
# Scheduler / deployments
# ---------------------------------------------------------------------------


def _build_fleet():
    """Synchronous fleet snapshot for the REST scheduler routes.

    Same machine/gpu merge the /ws loop does, minus the live_history
    sampling (a preview request shouldn't write history). Returns
    ``(nodes, machines, containers, offline_hosts, stale_hosts)``.
    """
    nodes = registry.all()
    machines = get_machine_stats()
    agent_data = get_all_containers(nodes)

    containers: dict[str, list] = {}
    offline_hosts: set[str] = set()

    for host, data in agent_data.items():
        machines.setdefault(host, _offline_machine(data.get("reachable", False)))
        machines[host]["gpu"] = data.get("gpu")
        machines[host]["agent_reachable"] = data.get("reachable", False)
        containers[host] = data.get("containers", [])
        if not data.get("reachable", False):
            offline_hosts.add(host)

    stale_hosts = {n["name"] for n in registry.listing() if n["stale"]}
    return nodes, machines, containers, offline_hosts, stale_hosts


def _fallback_reason(ranked, target: str) -> str:
    top = next((r for r in ranked if r.node == target), None)
    runner_up = next((r for r in ranked if r.node != target and r.eligible), None)
    if not top:
        return ""
    parts = [f"{target} scored {top.score}"]
    if top.reasons:
        parts.append("; ".join(top.reasons[:2]))
    if runner_up:
        parts.append(f"next best was {runner_up.node} at {runner_up.score}")
    return " — ".join(parts)


def _score(spec: DeploymentSpec):
    """Run the LLM constraint parse + deterministic scoring for a spec.

    Returns ``(effective_spec, ranked, recommended, explanation,
    parsed_constraints, warnings)``.
    """
    _, machines, containers, _, stale_hosts = _build_fleet()

    warnings: list[str] = []
    parsed = None
    effective = spec

    if spec.constraints.notes:
        parsed, warnings = llm.parse_constraints(
            spec.constraints.notes, list(machines.keys())
        )
        if parsed is not None:
            effective = spec.model_copy(update={"constraints": parsed})

    ranked = scheduler.score_nodes(
        effective,
        machines,
        stale_hosts=stale_hosts,
        deployments=[d.model_dump() for d in deployments.all()],
        containers=containers,
    )
    recommended = scheduler.recommended_node(ranked)
    explanation = llm.explain_placement(effective, ranked)

    if effective.stateful():
        warnings.append(
            "This spec has volumes — a named volume stays on its node and "
            "will not follow a later reschedule."
        )

    return effective, ranked, recommended, explanation, parsed, warnings


def _pick_target(node: str | None, recommended: str | None, ranked) -> str:
    """Resolve and validate the deploy target; raises HTTPException 409."""
    target = node or recommended
    eligible = {r.node for r in ranked if r.eligible}
    if target is None:
        raise HTTPException(status_code=409, detail="no eligible node for this spec")
    if target not in eligible:
        raise HTTPException(
            status_code=409,
            detail=f"{target} is not an eligible target for this spec",
        )
    return target


def _run_agent_deploy(
    record: DeploymentRecord,
    nodes: dict,
    *,
    event: str = "deployed",
    automatic: bool = False,
) -> DeploymentRecord:
    """Send the record's workload to its ``placed_on`` agent and fold the
    result back into the record. Shared by create + redeploy, both kinds.
    ``event`` is the log entry on success (``deployed`` or ``moved``)."""
    target = record.placed_on
    try:
        if record.kind == "stack":
            result = deploy_stack(
                nodes, target, stacks.agent_stack_payload(record.stack)
            )
        else:
            result = deploy_container(
                nodes, target, agent_spec_payload(record.spec.model_dump())
            )
    except ValueError as error:
        deployments.update(record.id, status="failed", error=str(error))
        return deployments.log_event(record.id, "failed", str(error))
    except requests.RequestException as error:
        deployments.update(
            record.id, status="failed", error=f"agent unreachable: {error}"
        )
        return deployments.log_event(record.id, "failed", f"agent unreachable: {error}")

    if not result.get("success", False):
        detail = result.get("error") or "agent rejected the deployment"
        deployments.update(record.id, status="failed", error=detail)
        return deployments.log_event(record.id, "failed", detail)

    ref = result.get("project") if record.kind == "stack" else result.get("id")
    deployments.update(
        record.id,
        status="running",
        agent_container_id=ref,
        error=None,
        deployed_at=time.time(),
    )
    prefix = "auto-moved to" if automatic else ("moved to" if event == "moved" else "running on")
    return deployments.log_event(
        record.id,
        event,
        f"{prefix} {target}"
        + (f" (score {record.score:.0f})" if record.score is not None else ""),
        automatic=automatic,
    )


@app.post("/api/deployments", response_model=None)
async def create_deployment(
    spec: DeploymentSpec,
    dry_run: bool = False,
    node: str | None = None,
    x_register_token: str | None = Header(default=None),
):
    _check_token(x_register_token)

    effective, ranked, recommended, explanation, parsed, warnings = (
        await asyncio.to_thread(_score, spec)
    )

    if dry_run:
        return PlacementResponse(
            spec=effective,
            ranked=ranked,
            recommended=recommended,
            explanation=explanation,
            parsed_constraints=parsed,
            warnings=warnings,
        )

    target = _pick_target(node, recommended, ranked)

    record = DeploymentRecord(
        kind="container",
        spec=effective,
        status="placing",
        placed_on=target,
        score=next((r.score for r in ranked if r.node == target), None),
        reason=explanation or _fallback_reason(ranked, target),
        alternatives=[
            {"node": r.node, "score": r.score, "eligible": r.eligible}
            for r in ranked
            if r.node != target
        ][:4],
    )
    record.log("created", f"placing on {target}")
    deployments.add(record)
    sched_log.info("deploy %s: %s -> %s (score %s)", record.id[:8], record.kind, target, record.score)
    return _run_agent_deploy(record, registry.all())


@app.post("/api/stacks", response_model=None)
async def create_stack_deployment(
    stack: StackSpec,
    dry_run: bool = False,
    node: str | None = None,
    x_register_token: str | None = Header(default=None),
):
    _check_token(x_register_token)

    try:
        synthetic, parsed, stack_warnings = stacks.plan_stack(stack)
    except ComposeError as error:
        raise HTTPException(
            status_code=400, detail=f"could not parse the compose file: {error}"
        )

    effective, ranked, recommended, explanation, parsed_c, warnings = (
        await asyncio.to_thread(_score, synthetic)
    )
    warnings = stack_warnings + [
        w for w in warnings if "named volume stays on its node" not in w
    ]

    if dry_run:
        return PlacementResponse(
            spec=effective,
            ranked=ranked,
            recommended=recommended,
            explanation=explanation,
            parsed_constraints=parsed_c,
            warnings=warnings,
            stack_services=stacks.service_summary(parsed),
        )

    target = _pick_target(node, recommended, ranked)

    record = DeploymentRecord(
        kind="stack",
        spec=effective,
        stack=stack,
        status="placing",
        placed_on=target,
        score=next((r.score for r in ranked if r.node == target), None),
        reason=explanation or _fallback_reason(ranked, target),
        alternatives=[
            {"node": r.node, "score": r.score, "eligible": r.eligible}
            for r in ranked
            if r.node != target
        ][:4],
    )
    record.log("created", f"placing on {target}")
    deployments.add(record)
    sched_log.info("deploy %s: %s -> %s (score %s)", record.id[:8], record.kind, target, record.score)
    return _run_agent_deploy(record, registry.all())


@app.get("/api/deployments")
def list_deployments():
    return [d.model_dump() for d in deployments.all()]


@app.get("/api/fleet")
async def fleet_summary():
    """At-a-glance: per-node headroom, how much the scheduler has committed
    vs the fleet's online capacity, and a status tally."""
    _, machines, _, _, _ = await asyncio.to_thread(_build_fleet)
    records = deployments.all()

    nodes = []
    cap_ram = cap_vcpu = cap_cores = 0.0
    for name, m in sorted(machines.items()):
        online = bool(m.get("online"))
        vcpu = m.get("cpu_cores")  # logical
        phys = m.get("cpu_physical_cores")
        ram_total = m.get("ram_total_bytes")
        cpu, ram = m.get("cpu"), m.get("ram")
        free_ram_mb = (
            int(ram_total * (1 - ram / 100) / (1024 * 1024))
            if isinstance(ram_total, (int, float)) and isinstance(ram, (int, float))
            else None
        )
        free_vcpu = (
            round(vcpu * (1 - cpu / 100), 2)
            if isinstance(vcpu, (int, float)) and isinstance(cpu, (int, float))
            else None
        )
        if online and isinstance(ram_total, (int, float)):
            cap_ram += ram_total / (1024 * 1024)
        if online and isinstance(vcpu, (int, float)):
            cap_vcpu += vcpu
        if online and isinstance(phys, (int, float)):
            cap_cores += phys
        nodes.append(
            {
                "name": name,
                "online": online,
                "free_ram_mb": free_ram_mb,
                "free_vcpu": free_vcpu,
                "vcpu": vcpu,
                "physical_cores": phys,
                "has_gpu": bool((m.get("gpu") or {}).get("devices")),
                "managed": sum(
                    1
                    for r in records
                    if r.placed_on == name and r.status in ("running", "placing")
                ),
            }
        )

    live = [r for r in records if r.status in ("running", "placing")]
    committed_ram = sum(r.spec.resources.memory_mb or 0 for r in live)
    committed_vcpu = sum(r.spec.resources.cpus or 0 for r in live)

    tally: dict[str, int] = {}
    for r in records:
        tally[r.status] = tally.get(r.status, 0) + 1

    return {
        "nodes": nodes,
        "capacity": {
            "memory_mb": int(cap_ram),
            "vcpu": round(cap_vcpu, 1),
            "physical_cores": round(cap_cores, 1) or None,
        },
        "committed": {"memory_mb": committed_ram, "vcpu": round(committed_vcpu, 2)},
        "deployments": tally,
    }


@app.get("/api/rebalance")
async def rebalance_suggestions():
    _, machines, containers, _, stale_hosts = await asyncio.to_thread(
        _build_fleet
    )
    suggestions = await asyncio.to_thread(
        rebalance.suggest_moves,
        machines,
        containers,
        deployments.all(),
        stale_hosts=stale_hosts,
    )
    return {
        "suggestions": suggestions,
        "checked_at": time.time(),
        "auto": autorebalance.enabled(),
    }


def _teardown(nodes: dict, record: DeploymentRecord) -> None:
    if not (
        record.placed_on and record.agent_container_id and record.placed_on in nodes
    ):
        return
    try:
        if record.kind == "stack":
            remove_stack(nodes, record.placed_on, record.agent_container_id)
        else:
            remove_container(nodes, record.placed_on, record.agent_container_id)
    except (ValueError, requests.RequestException):
        pass


def _relocate(
    record: DeploymentRecord,
    target: str,
    *,
    reason: str,
    spec: DeploymentSpec | None = None,
    score: float | None = None,
    automatic: bool = False,
    mark_auto_move: bool = False,
) -> DeploymentRecord:
    """Move a deployment to ``target``: tear it down where it is, deploy on
    the new node, and — if that fails — try to bring it back on the node it
    was on so a bad move doesn't just leave the workload down."""
    nodes = registry.all()
    origin = record.placed_on
    same_node = target == origin

    _teardown(nodes, record)

    updates: dict = {"status": "placing", "placed_on": target, "reason": reason, "error": None}
    if spec is not None:
        updates["spec"] = spec
    if score is not None:
        updates["score"] = score
    if mark_auto_move:
        updates["last_auto_move"] = time.time()
    updated = deployments.update(record.id, **updates)

    event = "deployed" if same_node else "moved"
    result = _run_agent_deploy(updated, nodes, event=event, automatic=automatic)

    if (
        result
        and result.status == "failed"
        and origin
        and not same_node
        and origin in nodes
    ):
        deployments.log_event(
            record.id, "failed", f"{target} rejected it — rolling back to {origin}"
        )
        rolled = deployments.update(
            record.id, status="placing", placed_on=origin, error=None
        )
        result = _run_agent_deploy(rolled, nodes, event="deployed")
    return result


def _move_deployment(record: DeploymentRecord, target: str, reason: str) -> None:
    """Auto-rebalancer / auto-reschedule move. The interactive path is the
    /redeploy endpoint."""
    _relocate(
        record, target, reason=reason, automatic=True, mark_auto_move=True
    )


RECONCILE_INTERVAL_SECONDS = 5


async def _reconcile_loop() -> None:
    """Keep deployment statuses fresh even with no dashboard client open —
    the /ws loop only runs while someone is watching, but node-offline and
    health detection (and the auto-rebalancer that depends on them) must
    run regardless."""
    while True:
        await asyncio.sleep(RECONCILE_INTERVAL_SECONDS)
        try:
            _, _, containers, offline_hosts, _ = await asyncio.to_thread(
                _build_fleet
            )
            deployments.reconcile(containers, offline_hosts)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - loop must survive
            system_log.warning("reconcile cycle failed: %s", error)


async def _auto_rebalance_loop() -> None:
    if not autorebalance.enabled():
        return
    sched_log.info(
        "auto-rebalance on: every %.0fs, min gain %.0f, cooldown %.0fs "
        "(also reschedules stateless workloads off offline nodes)",
        autorebalance.INTERVAL_SECONDS,
        autorebalance.MIN_GAIN,
        autorebalance.COOLDOWN_SECONDS,
    )
    while True:
        await asyncio.sleep(autorebalance.INTERVAL_SECONDS)
        try:
            _, machines, containers, _, stale_hosts = await asyncio.to_thread(
                _build_fleet
            )
            suggestions = await asyncio.to_thread(
                rebalance.suggest_moves,
                machines,
                containers,
                deployments.all(),
                stale_hosts=stale_hosts,
            )
            dumps = [d.model_dump() for d in deployments.all()]
            records = {d["id"]: d for d in dumps}

            for move in autorebalance.plan_moves(suggestions, records):
                record = deployments.get(move["deployment_id"])
                if record is None:
                    continue
                sched_log.info(
                    "auto-rebalance: %s %s -> %s (+%s)",
                    record.id[:8],
                    move["from_node"],
                    move["to_node"],
                    move["gain"],
                )
                await asyncio.to_thread(
                    _move_deployment, record, move["to_node"], move["reason"]
                )

            # Stranded on a dead node — reschedule the stateless ones.
            for stranded in autorebalance.plan_reschedules(dumps):
                record = deployments.get(stranded["id"])
                if record is None:
                    continue
                await asyncio.to_thread(_reschedule_offline, record)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - loop must survive
            system_log.warning("auto-rebalance cycle failed: %s", error)


async def _alert_loop() -> None:
    """Watch the fleet and POST to ALERT_WEBHOOK_URL on state changes.
    No-op unless that URL is set."""
    if not alerts.enabled():
        return
    sched_log.info(
        "alerts on: webhook every %.0fs, RAM>%.0f%%, CPU>%.0f%% "
        "(%d checks before firing)",
        alerts.INTERVAL_SECONDS,
        alerts.RAM_PERCENT,
        alerts.CPU_PERCENT,
        alerts.BREACH_CYCLES,
    )
    while True:
        await asyncio.sleep(alerts.INTERVAL_SECONDS)
        try:
            _, machines, _, _, _ = await asyncio.to_thread(_build_fleet)
            dumps = [d.model_dump() for d in deployments.all()]
            events = alert_monitor.poll(machines, dumps)
            for event in events:
                level = sched_log.warning if event["status"] == "firing" else sched_log.info
                level("alert %s: %s", event["status"], event["message"])
                await asyncio.to_thread(alerts.post, event)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - loop must survive
            system_log.warning("alert cycle failed: %s", error)


def _reschedule_offline(record: DeploymentRecord) -> None:
    """Score a stranded deployment against the live fleet and, if a healthy
    node wins, move it there."""
    dead_node = record.placed_on
    spec = record.spec.model_copy(
        update={
            "constraints": record.spec.constraints.model_copy(
                update={
                    "node_not_in": sorted(
                        set(record.spec.constraints.node_not_in or []) | {dead_node}
                    )
                }
            )
        }
    )
    _, ranked, recommended, _, _, _ = _score(spec)
    if not recommended or recommended == dead_node:
        return
    sched_log.warning(
        "auto-reschedule: %s off offline %s -> %s",
        record.id[:8],
        dead_node,
        recommended,
    )
    _move_deployment(
        record,
        recommended,
        f"{dead_node} went offline; rescheduled to {recommended}",
    )


@app.get("/api/deployments/{deployment_id}")
def get_deployment(deployment_id: str):
    record = deployments.get(deployment_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown deployment")
    return record.model_dump()


@app.post("/api/deployments/{deployment_id}/redeploy", response_model=None)
async def redeploy(
    deployment_id: str,
    exclude_current: bool = True,
    node: str | None = None,
    x_register_token: str | None = Header(default=None),
):
    _check_token(x_register_token)

    record = deployments.get(deployment_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown deployment")

    # A stack re-scores from its own compose file; a container from its spec.
    if record.kind == "stack":
        score_spec, _, _ = stacks.plan_stack(record.stack)
    else:
        score_spec = record.spec

    if exclude_current and record.placed_on and not node:
        blocked = set(score_spec.constraints.node_not_in or []) | {record.placed_on}
        score_spec = score_spec.model_copy(
            update={
                "constraints": score_spec.constraints.model_copy(
                    update={"node_not_in": sorted(blocked)}
                )
            }
        )

    effective, ranked, recommended, explanation, _, _ = await asyncio.to_thread(
        _score, score_spec
    )
    target = node or recommended
    eligible_nodes = {r.node for r in ranked if r.eligible}

    if target is None or target not in eligible_nodes:
        raise HTTPException(
            status_code=409, detail="no eligible node for a redeploy"
        )

    return await asyncio.to_thread(
        _relocate,
        record,
        target,
        reason=explanation or _fallback_reason(ranked, target),
        spec=effective,
        score=next((r.score for r in ranked if r.node == target), None),
    )


@app.delete("/api/deployments/{deployment_id}", response_model=None)
async def delete_deployment(
    deployment_id: str,
    keep_container: bool = False,
    volumes: bool = False,
    x_register_token: str | None = Header(default=None),
):
    _check_token(x_register_token)

    record = deployments.get(deployment_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown deployment")

    removed = False
    error = None

    if not keep_container and record.placed_on and record.agent_container_id:
        try:
            if record.kind == "stack":
                result = await asyncio.to_thread(
                    remove_stack,
                    registry.all(),
                    record.placed_on,
                    record.agent_container_id,
                    volumes=volumes,
                )
            else:
                result = await asyncio.to_thread(
                    remove_container,
                    registry.all(),
                    record.placed_on,
                    record.agent_container_id,
                )
            removed = bool(result.get("success", True))
            if not removed:
                error = result.get("error") or "agent could not tear it down"
        except (ValueError, requests.RequestException) as exc:
            error = f"could not tear down on the agent: {exc}"

    deployments.remove(deployment_id)
    sched_log.info(
        "removed %s (%s on %s)%s",
        deployment_id[:8],
        record.kind,
        record.placed_on,
        "" if removed or keep_container else " — agent teardown failed",
    )
    return {"ok": True, "removed_container": removed, "error": error}


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

            containers = {
                host: data.get("containers", [])
                for host, data in agent_data.items()
            }

            live_container_keys = set()

            for host, data in agent_data.items():
                machines.setdefault(
                    host,
                    _offline_machine(data.get("reachable", False)),
                )
                machines[host]["gpu"] = data.get("gpu")
                # Distinct from ``online`` (which is Prometheus "up"): a host
                # can be scraped fine while its agent is unreachable, in
                # which case its container list is empty but not because it
                # has no containers.
                machines[host]["agent_reachable"] = data.get("reachable", False)

                gpu_devices = (data.get("gpu") or {}).get("devices") or []
                gpu_temp = gpu_devices[0].get("temperature_c") if gpu_devices else None
                live_history.record_gpu_temp(host, gpu_temp)

                history.setdefault(host, {})["gpu_temperature"] = (
                    live_history.gpu_temp_history(host)
                )

                for container in data.get("containers", []):
                    live_history.record_container_sample(
                        host,
                        container["id"],
                        container["status"],
                        container.get("health"),
                    )
                    live_container_keys.add((host, container["id"]))
                    container["heartbeat"] = live_history.container_heartbeat(
                        host, container["id"]
                    )

            live_history.prune_containers(live_container_keys)
            await asyncio.to_thread(live_history.maybe_persist)

            main_host = MAIN_HOST_OVERRIDE or _detect_main_host(agent_data)

            offline_hosts = {
                host
                for host, data in agent_data.items()
                if not data.get("reachable", False)
            }
            deployments.reconcile(containers, offline_hosts)

            await websocket.send_json({
                "type": "dashboard_update",
                "machines": machines,
                "containers": containers,
                "main_host": main_host,
                "history": history,
                "deployments": [d.model_dump() for d in deployments.all()],
                "pins": pins.all(),
                "server_time": time.time(),
            })

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        system_log.debug("dashboard client disconnected")
