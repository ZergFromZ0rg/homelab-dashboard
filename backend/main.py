import asyncio
import os
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from backend.prometheus import get_machine_stats
from backend.docker import get_all_containers, control_container

app = FastAPI()

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

@app.post("/api/containers/{host}/{container_id}/{action}")
async def container_action(
    host: str,
    container_id: str,
    action: str,
):
    try:
        result = await asyncio.to_thread(
            control_container,
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

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            machines = await asyncio.to_thread(
                get_machine_stats
            )

            agent_data = await asyncio.to_thread(
                get_all_containers
            )

            containers = {
                host: data.get("containers", [])
                for host, data in agent_data.items()
            }

            for host, data in agent_data.items():
                if host in machines:
                    machines[host]["gpu"] = data.get("gpu")

            await websocket.send_json({
                "type": "dashboard_update",
                "machines": machines,
                "containers": containers,
            })

            await asyncio.sleep(2)

    except WebSocketDisconnect:
        print("Client disconnected")
