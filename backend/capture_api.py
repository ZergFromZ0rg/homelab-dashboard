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

from backend import auth
from backend.docker import agent_headers
from backend.hosts import agent_for as _agent

router = APIRouter(prefix="/api/capture/{host}")

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
