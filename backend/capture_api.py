"""Packet capture routes, proxied to each homelab-agent's ``/capture``.

The agent runs a raw-socket sniffer in a throwaway container on the host's
network; the dashboard starts and stops it and polls what it has seen.
Capturing traffic is sensitive even on your own LAN, so starting, stopping
and downloading all need the same gate as the other changing routes, and
the audit log records start, stop and the download (see audit_log.py).
"""

from __future__ import annotations

import requests
from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse, Response

from backend import auth, autocapture, capture_store
from backend.docker import agent_headers
from backend.hosts import agent_for as _agent

router = APIRouter(prefix="/api/capture/{host}")
saved_router = APIRouter(prefix="/api/captures")
auto_router = APIRouter(prefix="/api/autocapture")

TIMEOUT = 40  # starting reads the host's interfaces through a helper container
PCAP_TIMEOUT = 30


def _fail(error: Exception) -> JSONResponse:
    return JSONResponse(status_code=502, content={"error": f"couldn't reach this agent: {error}"})


def _reason(response: requests.Response) -> JSONResponse | None:
    if response.status_code == 404:
        return JSONResponse(status_code=502, content={"error": "this agent can't capture packets yet — rebuild it"})
    if response.status_code == 401:
        return JSONResponse(
            status_code=502,
            content={"error": "the agent rejected the dashboard's token — AGENT_TOKEN must match on both"},
        )
    return None


def _call(method: str, host: str, path: str = "", **kwargs) -> JSONResponse:
    try:
        response = requests.request(
            method, f"{_agent(host)}/capture{path}", headers=agent_headers(), timeout=TIMEOUT, **kwargs
        )
    except requests.RequestException as error:
        return _fail(error)
    refused = _reason(response)
    if refused:
        return refused
    try:
        body = response.json()
    except ValueError:
        body = {"error": f"agent answered {response.status_code}"}
    return JSONResponse(status_code=response.status_code, content=body)


@router.get("/interfaces")
def interfaces(host: str):
    return _call("GET", host, "/interfaces")


@router.get("")
def status(host: str, after: int = 0):
    return _call("GET", host, params={"after": max(0, after)})


@router.post("")
def start(host: str, body: dict | None = None, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return _call("POST", host, json=body or {})


@router.delete("")
def stop(host: str, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return _call("DELETE", host)


@router.get("/pcap")
def pcap(host: str, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    try:
        response = requests.get(
            f"{_agent(host)}/capture/pcap", headers=agent_headers(), timeout=PCAP_TIMEOUT
        )
    except requests.RequestException as error:
        return _fail(error)
    refused = _reason(response)
    if refused:
        return refused
    return Response(
        content=response.content,
        media_type="application/vnd.tcpdump.pcap",
        headers={"Content-Disposition": f'attachment; filename="{host}-capture.pcap"'},
    )


@router.post("/save")
def save(host: str, body: dict | None = None, x_register_token: str | None = Header(default=None)):
    """Copy the agent's current capture (its whole packet list) into the
    dashboard's saved captures."""
    auth.check_token(x_register_token)
    try:
        snapshot = requests.get(
            f"{_agent(host)}/capture", params={"after": 0, "limit": 3000}, headers=agent_headers(), timeout=TIMEOUT
        )
    except requests.RequestException as error:
        return _fail(error)
    refused = _reason(snapshot)
    if refused:
        return refused
    try:
        data = snapshot.json()
    except ValueError:
        return JSONResponse(status_code=502, content={"error": f"agent answered {snapshot.status_code}"})
    if not isinstance(data, dict) or data.get("state") in (None, "idle"):
        return JSONResponse(status_code=409, content={"error": "there is no capture on this host to save"})
    try:
        return capture_store.save(host, (body or {}).get("name"), data)
    except capture_store.StoreError as error:
        return JSONResponse(status_code=409, content={"error": str(error)})


@saved_router.get("")
def saved_list():
    return {"captures": capture_store.list_all()}


def _missing() -> JSONResponse:
    return JSONResponse(status_code=404, content={"error": "no such saved capture"})


@saved_router.get("/{capture_id}")
def saved_open(capture_id: str, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    found = capture_store.read(capture_id)
    return found if found else _missing()


@saved_router.get("/{capture_id}/pcap")
def saved_pcap(capture_id: str, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    found = capture_store.pcap(capture_id)
    if not found:
        return _missing()
    content, meta = found
    stem = "".join(c if c.isalnum() or c in "-_" else "-" for c in meta["name"]).strip("-") or capture_id
    return Response(
        content=content,
        media_type="application/vnd.tcpdump.pcap",
        headers={"Content-Disposition": f'attachment; filename="{stem}.pcap"'},
    )


@saved_router.patch("/{capture_id}")
def saved_rename(capture_id: str, body: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    meta = capture_store.rename(capture_id, str(body.get("name") or ""))
    return meta if meta else _missing()


@saved_router.delete("/{capture_id}")
def saved_delete(capture_id: str, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    return {"deleted": True} if capture_store.delete(capture_id) else _missing()


# --- automatic capture when an alert fires ----------------------------------------------

@auto_router.get("")
def auto_settings():
    return autocapture.settings()


@auto_router.put("")
def auto_update(body: dict, x_register_token: str | None = Header(default=None)):
    auth.check_token(x_register_token)
    try:
        return autocapture.update(body)
    except ValueError as error:
        return JSONResponse(status_code=400, content={"error": str(error)})


@auto_router.post("/{host}/test")
def auto_test(host: str, x_register_token: str | None = Header(default=None)):
    """Take one automatic capture now, on this host, to see it work."""
    auth.check_token(x_register_token)
    try:
        return autocapture.run_now(host)
    except autocapture.Refused as why:
        return JSONResponse(status_code=409, content={"error": str(why)})
    except requests.RequestException as error:
        return _fail(error)
