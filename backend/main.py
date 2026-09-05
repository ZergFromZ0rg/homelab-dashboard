import asyncio
import os
import time
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

import requests

from backend.prometheus import get_machine_stats, get_machine_history
from backend.docker import (
    get_all_containers,
    control_container,
    deploy_container,
    remove_container,
    agent_spec_payload,
)
from backend.registry import NodeRegistry
from backend.deployments import DeploymentStore
from backend.models import DeploymentSpec, DeploymentRecord, PlacementResponse
from backend import live_history
from backend import scheduler
from backend import rebalance
from backend import llm

app = FastAPI()

registry = NodeRegistry()
deployments = DeploymentStore()

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

    # A manual override must still be an eligible node.
    target = node or recommended
    eligible_nodes = {r.node for r in ranked if r.eligible}

    if target is None:
        raise HTTPException(
            status_code=409, detail="no eligible node for this spec"
        )
    if target not in eligible_nodes:
        raise HTTPException(
            status_code=409,
            detail=f"{target} is not an eligible target for this spec",
        )

    nodes = registry.all()
    record = DeploymentRecord(
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
    deployments.add(record)

    try:
        result = await asyncio.to_thread(
            deploy_container,
            nodes,
            target,
            agent_spec_payload(effective.model_dump()),
        )
    except ValueError as error:
        return deployments.update(record.id, status="failed", error=str(error))
    except requests.RequestException as error:
        return deployments.update(
            record.id, status="failed", error=f"agent unreachable: {error}"
        )

    if not result.get("success", False):
        return deployments.update(
            record.id,
            status="failed",
            error=result.get("error") or "agent rejected the deployment",
        )

    return deployments.update(
        record.id,
        status="running",
        agent_container_id=result.get("id"),
        error=None,
    )


@app.get("/api/deployments")
def list_deployments():
    return [d.model_dump() for d in deployments.all()]


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
    return {"suggestions": suggestions, "checked_at": time.time()}


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

    spec = record.spec
    if exclude_current and record.placed_on and not node:
        blocked = set(spec.constraints.node_not_in or []) | {record.placed_on}
        spec = spec.model_copy(
            update={
                "constraints": spec.constraints.model_copy(
                    update={"node_not_in": sorted(blocked)}
                )
            }
        )

    effective, ranked, recommended, explanation, _, _ = await asyncio.to_thread(
        _score, spec
    )
    target = node or recommended
    eligible_nodes = {r.node for r in ranked if r.eligible}

    if target is None or target not in eligible_nodes:
        raise HTTPException(
            status_code=409, detail="no eligible node for a redeploy"
        )

    nodes = registry.all()

    # Best-effort teardown of the old container before starting the new one.
    if record.placed_on and record.agent_container_id:
        try:
            await asyncio.to_thread(
                remove_container, nodes, record.placed_on, record.agent_container_id
            )
        except (ValueError, requests.RequestException):
            pass

    deployments.update(
        deployment_id,
        status="placing",
        placed_on=target,
        score=next((r.score for r in ranked if r.node == target), None),
        reason=explanation or _fallback_reason(ranked, target),
        error=None,
    )

    try:
        result = await asyncio.to_thread(
            deploy_container,
            nodes,
            target,
            agent_spec_payload(effective.model_dump()),
        )
    except (ValueError, requests.RequestException) as error:
        return deployments.update(
            deployment_id, status="failed", error=f"{error}"
        )

    if not result.get("success", False):
        return deployments.update(
            deployment_id,
            status="failed",
            error=result.get("error") or "agent rejected the redeploy",
        )

    return deployments.update(
        deployment_id,
        status="running",
        agent_container_id=result.get("id"),
        error=None,
    )


@app.delete("/api/deployments/{deployment_id}", response_model=None)
async def delete_deployment(
    deployment_id: str,
    keep_container: bool = False,
    x_register_token: str | None = Header(default=None),
):
    _check_token(x_register_token)

    record = deployments.get(deployment_id)
    if record is None:
        raise HTTPException(status_code=404, detail="unknown deployment")

    removed_container = False
    error = None

    if (
        not keep_container
        and record.placed_on
        and record.agent_container_id
    ):
        try:
            await asyncio.to_thread(
                remove_container,
                registry.all(),
                record.placed_on,
                record.agent_container_id,
            )
            removed_container = True
        except (ValueError, requests.RequestException) as exc:
            error = f"could not remove container: {exc}"

    deployments.remove(deployment_id)
    return {"ok": True, "removed_container": removed_container, "error": error}


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
            })

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        print("Client disconnected")
