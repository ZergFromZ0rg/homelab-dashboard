import asyncio
import os
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect

import requests

from backend.prometheus import get_machine_stats
from backend.docker import get_all_containers, control_container
from backend.registry import NodeRegistry

app = FastAPI()

registry = NodeRegistry()

REGISTER_TOKEN = os.getenv("REGISTER_TOKEN", "").strip()

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
        "ram": None,
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

            agent_data = await asyncio.to_thread(
                get_all_containers,
                nodes,
            )

            containers = {
                host: data.get("containers", [])
                for host, data in agent_data.items()
            }

            for host, data in agent_data.items():
                machines.setdefault(
                    host,
                    _offline_machine(data.get("reachable", False)),
                )
                machines[host]["gpu"] = data.get("gpu")

            await websocket.send_json({
                "type": "dashboard_update",
                "machines": machines,
                "containers": containers,
            })

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        print("Client disconnected")
