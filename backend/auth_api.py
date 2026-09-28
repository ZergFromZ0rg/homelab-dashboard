"""Passkey login routes (``/api/auth/*``) and the gate that enforces it.

The relying-party id is the hostname the browser is on, read from the
``Origin`` header — so the same install works at ``localhost`` in dev and
at ``thinkpad.<tailnet>.ts.net`` behind ``tailscale serve`` without a
setting. A passkey is bound to the hostname it was made on; login checks the
signed origin against the hostname stored with that passkey, so a passkey
can't be replayed from anywhere else.
"""

from __future__ import annotations

import json
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import bytes_to_base64url, base64url_to_bytes
from webauthn.helpers.exceptions import InvalidAuthenticationResponse, InvalidRegistrationResponse
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    CredentialDeviceType,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from backend import auth
from backend import notify
from backend import passkeys
from backend.log import system as system_log

router = APIRouter(prefix="/api/auth")

RP_NAME = "Homelab"


# --- helpers -------------------------------------------------------------


def _origin(request: Request) -> tuple[str, str]:
    """(origin, rp_id) for this request. Browsers only offer passkeys in a
    secure context — https, or http on localhost."""
    origin = request.headers.get("origin") or ""
    parsed = urlparse(origin)
    host = parsed.hostname or ""
    if not host:
        raise HTTPException(status_code=400, detail="missing Origin header")
    if parsed.scheme != "https" and host != "localhost":
        raise HTTPException(
            status_code=400,
            detail="passkeys need HTTPS — open the dashboard over https",
        )
    return origin, host


def _token(request: Request) -> str | None:
    return request.cookies.get(passkeys.SESSION_COOKIE)


def _signed_in(request: Request) -> bool:
    return passkeys.store.check_session(_token(request))


def _set_session(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        passkeys.SESSION_COOKIE,
        token,
        max_age=passkeys.SESSION_TTL,
        httponly=True,
        samesite="strict",
        secure=(request.headers.get("origin") or "").startswith("https://"),
        path="/",
    )


def _options(options) -> dict:
    return json.loads(options_to_json(options))


# --- routes --------------------------------------------------------------


@router.get("/status")
def status(request: Request):
    enabled = passkeys.store.enabled()
    return {
        "enabled": enabled,
        "signed_in": enabled and _signed_in(request),
        "elevated_until": passkeys.store.elevated_until(_token(request)) if enabled else None,
        "step_up": auth.STEP_UP,
        "rp_ids": passkeys.store.rp_ids(),
    }


@router.post("/register/options")
def register_options(request: Request):
    # Open while no passkey exists (login is off, so this adds nothing an
    # anonymous caller couldn't already do); after that, signed-in only.
    if passkeys.store.enabled() and not _signed_in(request):
        raise HTTPException(status_code=401, detail="sign in to add a passkey")
    _, rp_id = _origin(request)
    ceremony, challenge = passkeys.store.new_challenge("register", rp_id)
    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=RP_NAME,
        user_id=passkeys.store.user_id,
        user_name="homelab",
        user_display_name="Homelab dashboard",
        challenge=challenge,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=base64url_to_bytes(cid))
            for cid in passkeys.store.credential_ids(rp_id)
        ],
    )
    return {"ceremony": ceremony, "options": _options(options)}


@router.post("/register/verify")
async def register_verify(request: Request):
    first = not passkeys.store.enabled()
    if not first and not _signed_in(request):
        raise HTTPException(status_code=401, detail="sign in to add a passkey")
    body = await request.json()
    origin, rp_id = _origin(request)
    pending = passkeys.store.take_challenge(body.get("ceremony"), "register")
    if not pending or pending["rp_id"] != rp_id:
        raise HTTPException(status_code=400, detail="expired — try again")
    try:
        verified = verify_registration_response(
            credential=body.get("credential"),
            expected_challenge=pending["challenge"],
            expected_rp_id=rp_id,
            expected_origin=origin,
            require_user_verification=True,
        )
    except (InvalidRegistrationResponse, ValueError, TypeError, KeyError) as error:
        raise HTTPException(status_code=400, detail=f"passkey rejected: {error}")

    credential_id = bytes_to_base64url(verified.credential_id)
    try:
        entry = passkeys.store.add_passkey(
            credential_id=credential_id,
            public_key=bytes_to_base64url(verified.credential_public_key),
            sign_count=verified.sign_count,
            rp_id=rp_id,
            name=body.get("name") or passkeys.device_name(request.headers.get("user-agent", "")),
            synced=verified.credential_device_type == CredentialDeviceType.MULTI_DEVICE,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    system_log.info("passkey added: %s (%s)", entry["name"], rp_id)
    notify.security("Passkey added", f"“{entry['name']}” can now sign in to the dashboard. If that wasn't you, remove it in Settings → Passkeys.")

    response = JSONResponse({"passkey": entry, "enabled": True})
    # The first passkey switches login on — sign this browser in with it,
    # or adding it would lock you out of the page you're looking at.
    if first:
        _set_session(response, request, passkeys.store.open_session(credential_id))
    return response


@router.post("/login/options")
def login_options(request: Request):
    _, rp_id = _origin(request)
    ceremony, challenge = passkeys.store.new_challenge("login", rp_id)
    # No allow-list: passkeys are discoverable, so the browser offers
    # whichever ones it holds for this site — no username to type.
    options = generate_authentication_options(
        rp_id=rp_id,
        challenge=challenge,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    return {"ceremony": ceremony, "options": _options(options)}


def _verify_assertion(request: Request, body: dict, kind: str) -> dict:
    """Check a signed passkey assertion; returns the stored passkey."""
    origin, rp_id = _origin(request)
    pending = passkeys.store.take_challenge(body.get("ceremony"), kind)
    if not pending or pending["rp_id"] != rp_id:
        raise HTTPException(status_code=400, detail="expired — try again")
    credential = body.get("credential") or {}
    stored = passkeys.store.passkey(str(credential.get("id", "")))
    if not stored or stored["rp_id"] != rp_id:
        raise HTTPException(status_code=401, detail="this passkey isn't registered here")
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=pending["challenge"],
            expected_rp_id=rp_id,
            expected_origin=origin,
            credential_public_key=base64url_to_bytes(stored["public_key"]),
            credential_current_sign_count=stored["sign_count"],
            require_user_verification=True,
        )
    except (InvalidAuthenticationResponse, ValueError, TypeError, KeyError) as error:
        system_log.warning("passkey %s rejected: %s", kind, error)
        raise HTTPException(status_code=401, detail="passkey rejected")
    passkeys.store.record_use(stored["id"], verified.new_sign_count)
    return stored


@router.post("/login/verify")
async def login_verify(request: Request):
    stored = _verify_assertion(request, await request.json(), "login")
    response = JSONResponse({"signed_in": True})
    _set_session(response, request, passkeys.store.open_session(stored["id"]))
    return response


@router.post("/elevate/options")
def elevate_options(request: Request):
    """Confirm with a passkey before something dangerous. Same ceremony as
    signing in, for an already signed-in session."""
    _require_session(request)
    _, rp_id = _origin(request)
    ceremony, challenge = passkeys.store.new_challenge("elevate", rp_id)
    options = generate_authentication_options(
        rp_id=rp_id,
        challenge=challenge,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    return {"ceremony": ceremony, "options": _options(options)}


@router.post("/elevate/verify")
async def elevate_verify(request: Request):
    _require_session(request)
    _verify_assertion(request, await request.json(), "elevate")
    return {"elevated_until": passkeys.store.elevate(_token(request))}


@router.post("/logout")
def logout(request: Request):
    passkeys.store.close_session(_token(request))
    response = JSONResponse({"signed_in": False})
    response.delete_cookie(passkeys.SESSION_COOKIE, path="/")
    return response


def _require_session(request: Request) -> None:
    # These routes sit under /api/auth, which the gate lets through, so they
    # check for themselves.
    if passkeys.store.enabled() and not _signed_in(request):
        raise HTTPException(status_code=401, detail="sign in required")


@router.get("/passkeys")
def list_passkeys(request: Request):
    _require_session(request)
    return {"passkeys": passkeys.store.passkeys()}


@router.patch("/passkeys/{credential_id}")
async def rename_passkey(credential_id: str, request: Request):
    _require_session(request)
    body = await request.json()
    if not passkeys.store.rename(credential_id, body.get("name", "")):
        raise HTTPException(status_code=404, detail="no such passkey, or empty name")
    return {"passkeys": passkeys.store.passkeys()}


@router.delete("/passkeys/{credential_id}")
def delete_passkey(credential_id: str, request: Request):
    _require_session(request)
    auth.require_elevated()
    if not passkeys.store.remove(credential_id):
        raise HTTPException(status_code=404, detail="no such passkey")
    system_log.info("passkey removed: %s", credential_id[:12])
    notify.security("Passkey removed", "A passkey was removed from the dashboard.")
    return {"passkeys": passkeys.store.passkeys(), "enabled": passkeys.store.enabled()}


# --- the gate ------------------------------------------------------------


def _open_path(method: str, path: str) -> bool:
    if path.startswith("/api/auth/"):
        return True
    # Agents register themselves here on a timer; the route checks
    # X-Register-Token itself.
    if method == "POST" and path == "/api/nodes":
        return True
    return not (path.startswith("/api/") or path == "/ws" or path.startswith("/ws/"))


class SessionGate:
    """ASGI middleware: once a passkey exists, every ``/api`` route and the
    ``/ws`` socket need a session cookie — or, for scripts, the
    ``X-Register-Token`` when ``API_TOKEN`` is set. A plain HTTP middleware
    would miss the websocket, which is where all the fleet data flows."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        method = scope.get("method", "GET")
        session = self._session(scope)
        if session:
            # Reset after: requests on one keep-alive connection can share a
            # context, and the next one may carry no cookie at all.
            marker = auth.session_ok.set(True)
            which = auth.session_token.set(session)
            try:
                return await self.app(scope, receive, send)
            finally:
                auth.session_ok.reset(marker)
                auth.session_token.reset(which)
        if self._token(scope):
            marker = auth.token_ok.set(True)
            try:
                return await self.app(scope, receive, send)
            finally:
                auth.token_ok.reset(marker)
        if (
            (scope["type"] == "http" and method == "OPTIONS")
            or _open_path(method, scope["path"])
            or not passkeys.store.enabled()
            or self._allowed(scope)
        ):
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            # Closing before accept makes the server answer the upgrade with
            # 403; the client re-checks /api/auth/status when the socket drops.
            await receive()
            await send({"type": "websocket.close", "code": 4401})
            return
        response = JSONResponse({"detail": "sign in required"}, status_code=401)
        await response(scope, receive, send)

    @staticmethod
    def _session(scope) -> str | None:
        """The token of a valid passkey session cookie, if there is one. It
        also satisfies the API_TOKEN gate on mutating routes — see
        auth.session_ok."""
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        for part in headers.get("cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == passkeys.SESSION_COOKIE:
                return value if passkeys.store.check_session(value) else None
        return None

    @staticmethod
    def _token(scope) -> bool:
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        token = headers.get("x-register-token")
        return bool(auth.API_TOKEN and token and auth.token_matches(token))

    @staticmethod
    def _allowed(scope) -> bool:
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        token = headers.get("x-register-token")
        if auth.API_TOKEN and token and auth.token_matches(token):
            return True
        for part in headers.get("cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == passkeys.SESSION_COOKIE:
                return passkeys.store.check_session(value)
        return False
