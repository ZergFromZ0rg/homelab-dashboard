import asyncio
import os
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

import requests

from backend.prometheus import get_machine_stats, get_machine_history
from backend.docker import get_all_containers, control_container
from backend.registry import NodeRegistry
from backend import live_history

app = FastAPI()

registry = NodeRegistry()

REGISTER_TOKEN = os.getenv("REGISTER_TOKEN", "").strip()

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

            await websocket.send_json({
                "type": "dashboard_update",
                "machines": machines,
                "containers": containers,
                "main_host": main_host,
                "history": history,
            })

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        print("Client disconnected")
