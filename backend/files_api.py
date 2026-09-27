"""File browser routes, proxied to each homelab-agent's ``/files/*``.

The agent does the work and the refusing — reads anywhere, writes only
under its roots (the owner's home and the compose stack folders), as the
file's owner. See homelab-agent's files.py. This passes requests through,
keeps the agent's status (400 refused, 409 conflict) and error text, and
streams bytes both ways rather than holding a file in memory.

Changing anything needs the same gate as delete (``auth.check_token``)
on top of the session.
"""

from __future__ import annotations

import asyncio
import tempfile

import requests
from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse

from backend import auth
from backend.docker import agent_headers
from backend.hosts import agent_for as _agent

router = APIRouter(prefix="/api/files/{host}")

TIMEOUT = 30
TRANSFER_TIMEOUT = 3600
CHUNK = 1024 * 1024
PASSED_HEADERS = ("content-type", "content-length", "content-disposition")


def _relay(response: requests.Response) -> JSONResponse:
    if response.status_code == 404:
        return JSONResponse(
            status_code=502,
            content={"error": "this agent has no file browser yet — rebuild it"},
        )
    if response.status_code == 401:
        return JSONResponse(
            status_code=502,
            content={"error": "the agent rejected the dashboard's token — AGENT_TOKEN must match on both"},
        )
    try:
        body = response.json()
    except ValueError:
        body = {"error": f"agent answered {response.status_code}"}
    return JSONResponse(status_code=response.status_code, content=body)


def _call(method: str, url: str, **kwargs) -> JSONResponse:
    try:
        response = requests.request(
            method, url, headers=agent_headers(), timeout=kwargs.pop("timeout", TIMEOUT), **kwargs
        )
    except requests.RequestException as error:
        return JSONResponse(status_code=502, content={"error": f"couldn't reach this agent: {error}"})
    return _relay(response)


@router.get("/list")
def list_folder(host: str, path: str = "~"):
    return _call("GET", f"{_agent(host)}/files/list", params={"path": path})


@router.get("/text")
def read_text(host: str, path: str):
    return _call("GET", f"{_agent(host)}/files/text", params={"path": path})


@router.put("/text")
def save_text(host: str, body: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return _call("PUT", f"{_agent(host)}/files/text", json=body)


@router.post("/rename")
def rename(host: str, body: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return _call("POST", f"{_agent(host)}/files/rename", json=body)


@router.post("/mkdir")
def make_folder(host: str, body: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return _call("POST", f"{_agent(host)}/files/mkdir", json=body)


@router.get("/download")
def download(host: str, path: str, inline: bool = False):
    try:
        response = requests.get(
            f"{_agent(host)}/files/download",
            params={"path": path, "inline": "true" if inline else "false"},
            headers=agent_headers(),
            timeout=TRANSFER_TIMEOUT,
            stream=True,
        )
    except requests.RequestException as error:
        return JSONResponse(status_code=502, content={"error": f"couldn't reach this agent: {error}"})
    if not response.ok:
        with response:
            return _relay(response)

    def body():
        with response:
            yield from response.iter_content(CHUNK)

    headers = {k: v for k, v in response.headers.items() if k.lower() in PASSED_HEADERS}
    return StreamingResponse(body(), headers=headers)


@router.post("/upload")
async def upload(
    host: str,
    request: Request,
    path: str,
    overwrite: bool = False,
    x_register_token: str | None = Header(default=None),
):
    """The request body is the file. Spooled to disk, then streamed on: the
    agent needs the size before it starts, and memory shouldn't hold a
    video."""
    auth.check_token(x_register_token)
    base = _agent(host)
    with tempfile.TemporaryFile() as spool:
        async for chunk in request.stream():
            spool.write(chunk)
        spool.seek(0)
        return await asyncio.to_thread(
            _call,
            "POST",
            f"{base}/files/upload",
            params={"path": path, "overwrite": "true" if overwrite else "false"},
            data=spool,
            timeout=TRANSFER_TIMEOUT,
        )
