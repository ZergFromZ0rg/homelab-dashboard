"""Passkey login end to end, with a software authenticator: real P-256
keys, real CBOR, real signatures — the same bytes a phone would send."""

import base64
import hashlib
import json
import os

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from backend import auth, main, passkeys

ORIGIN = "https://thinkpad.example.ts.net"
RP_ID = "thinkpad.example.ts.net"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class Authenticator:
    """One passkey on one device."""

    def __init__(self, rp_id=RP_ID, origin=ORIGIN):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred_id = os.urandom(16)
        self.rp_id, self.origin = rp_id, origin
        self.count = 0

    def _client_data(self, kind, challenge):
        return json.dumps(
            {"type": kind, "challenge": challenge, "origin": self.origin, "crossOrigin": False}
        ).encode()

    def create(self, options):
        numbers = self.key.public_key().public_numbers()
        cose = cbor2.dumps(
            {1: 2, 3: -7, -1: 1, -2: numbers.x.to_bytes(32, "big"), -3: numbers.y.to_bytes(32, "big")}
        )
        auth_data = (
            hashlib.sha256(self.rp_id.encode()).digest()
            + bytes([0x01 | 0x04 | 0x40])  # user present, verified, attested data
            + self.count.to_bytes(4, "big")
            + bytes(16)  # aaguid
            + len(self.cred_id).to_bytes(2, "big")
            + self.cred_id
            + cose
        )
        client_data = self._client_data("webauthn.create", options["challenge"])
        return {
            "id": b64(self.cred_id),
            "rawId": b64(self.cred_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64(client_data),
                "attestationObject": b64(
                    cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
                ),
            },
        }

    def get(self, options):
        self.count += 1
        auth_data = (
            hashlib.sha256(self.rp_id.encode()).digest()
            + bytes([0x01 | 0x04])
            + self.count.to_bytes(4, "big")
        )
        client_data = self._client_data("webauthn.get", options["challenge"])
        signature = self.key.sign(
            auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256())
        )
        return {
            "id": b64(self.cred_id),
            "rawId": b64(self.cred_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64(client_data),
                "authenticatorData": b64(auth_data),
                "signature": b64(signature),
                "userHandle": b64(passkeys.store.user_id),
            },
        }


@pytest.fixture
def client():
    return TestClient(main.app, base_url=ORIGIN, headers={"Origin": ORIGIN})


def register(client, device, name=None):
    start = client.post("/api/auth/register/options").json()
    return client.post(
        "/api/auth/register/verify",
        json={"ceremony": start["ceremony"], "credential": device.create(start["options"]), "name": name},
    )


def login(client, device):
    start = client.post("/api/auth/login/options").json()
    return client.post(
        "/api/auth/login/verify",
        json={"ceremony": start["ceremony"], "credential": device.get(start["options"])},
    )


def test_open_until_first_passkey(client):
    assert client.get("/api/auth/status").json() == {
        "enabled": False, "signed_in": False, "rp_ids": []
    }
    assert client.get("/api/todos").status_code == 200


def test_first_passkey_turns_login_on_and_signs_this_browser_in(client):
    resp = register(client, Authenticator(), name="  My   Mac ")
    assert resp.status_code == 200
    assert resp.json()["passkey"]["name"] == "My Mac"
    assert client.get("/api/todos").status_code == 200
    status = client.get("/api/auth/status").json()
    assert status == {"enabled": True, "signed_in": True, "rp_ids": [RP_ID]}

    stranger = TestClient(main.app, base_url=ORIGIN, headers={"Origin": ORIGIN})
    assert stranger.get("/api/todos").status_code == 401
    assert stranger.get("/api/auth/status").json()["signed_in"] is False


def test_login_logout_roundtrip(client):
    device = Authenticator()
    register(client, device)
    client.post("/api/auth/logout")
    assert client.get("/api/todos").status_code == 401

    assert login(client, device).status_code == 200
    assert client.get("/api/todos").status_code == 200


def test_unknown_or_forged_passkey_is_rejected(client):
    register(client, Authenticator())
    client.post("/api/auth/logout")
    assert login(client, Authenticator()).status_code == 401

    # Right credential id, wrong private key.
    real = Authenticator()
    fresh = TestClient(main.app, base_url=ORIGIN, headers={"Origin": ORIGIN})
    passkeys.store.reset()
    register(fresh, real)
    fresh.post("/api/auth/logout")
    forger = Authenticator()
    forger.cred_id = real.cred_id
    assert login(fresh, forger).status_code == 401


def test_challenge_is_single_use(client):
    device = Authenticator()
    register(client, device)
    client.post("/api/auth/logout")
    start = client.post("/api/auth/login/options").json()
    body = {"ceremony": start["ceremony"], "credential": device.get(start["options"])}
    assert client.post("/api/auth/login/verify", json=body).status_code == 200
    assert client.post("/api/auth/login/verify", json=body).status_code == 400


def test_passkey_from_another_site_is_rejected(client):
    device = Authenticator()
    register(client, device)
    client.post("/api/auth/logout")
    # A browser signs its real origin into clientData; a phishing page's
    # origin must fail even with a valid key and signature.
    device.origin = "https://evil.example"
    assert login(client, device).status_code == 401
    device.origin = ORIGIN
    assert login(client, device).status_code == 200


def test_second_passkey_needs_a_session(client):
    register(client, Authenticator())
    client.post("/api/auth/logout")
    assert client.post("/api/auth/register/options").status_code == 401
    assert login(client, Authenticator()).status_code == 401


def test_add_rename_remove(client):
    first = Authenticator()
    register(client, first)
    assert register(client, Authenticator(), name="iPhone").status_code == 200
    keys = client.get("/api/auth/passkeys").json()["passkeys"]
    assert len(keys) == 2 and all("public_key" not in k for k in keys)

    phone = next(k for k in keys if k["name"] == "iPhone")
    renamed = client.patch(f"/api/auth/passkeys/{phone['id']}", json={"name": "Phone"}).json()
    assert {k["name"] for k in renamed["passkeys"]} >= {"Phone"}

    resp = client.delete(f"/api/auth/passkeys/{phone['id']}").json()
    assert resp["enabled"] is True and len(resp["passkeys"]) == 1


def test_removing_the_passkey_you_signed_in_with_ends_that_session(client):
    device = Authenticator()
    register(client, device)
    cid = b64(device.cred_id)
    assert client.delete(f"/api/auth/passkeys/{cid}").json()["enabled"] is False
    # Login is off again, so the dashboard is open — not locked.
    assert client.get("/api/todos").status_code == 200


def test_plain_http_is_refused_with_a_reason():
    http = TestClient(main.app, headers={"Origin": "http://thinkpad:8081"})
    resp = http.post("/api/auth/register/options")
    assert resp.status_code == 400 and "HTTPS" in resp.json()["detail"]


def test_localhost_http_is_allowed_for_dev():
    dev = TestClient(main.app, headers={"Origin": "http://localhost:5173"})
    assert dev.post("/api/auth/register/options").status_code == 200


def test_websocket_needs_a_session(client):
    register(client, Authenticator())
    stranger = TestClient(main.app, base_url=ORIGIN)
    with pytest.raises(Exception):
        with stranger.websocket_connect("/ws"):
            pass


def test_agent_registration_and_api_token_still_work(client, monkeypatch):
    register(client, Authenticator())
    stranger = TestClient(main.app)
    # Agents' register route stays reachable; it checks its own token.
    assert stranger.post("/api/nodes", json={}).status_code != 401

    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")
    assert stranger.get("/api/todos", headers={"X-Register-Token": "s3cret"}).status_code == 200
    assert stranger.get("/api/todos", headers={"X-Register-Token": "nope"}).status_code == 401


def test_session_token_is_stored_hashed(tmp_path, client):
    register(client, Authenticator())
    token = client.cookies.get(passkeys.SESSION_COOKIE)
    assert token and token not in passkeys.store.path.read_text()


def test_sessions_survive_a_restart(client):
    register(client, Authenticator())
    token = client.cookies.get(passkeys.SESSION_COOKIE)
    reloaded = passkeys.PasskeyStore(passkeys.store.path)
    assert reloaded.enabled() and reloaded.check_session(token)


def test_overview_stops_flagging_no_login_once_a_passkey_exists(client):
    assert main._security_posture()["authenticated"] is bool(auth.API_TOKEN)
    register(client, Authenticator())
    assert main._security_posture()["authenticated"] is True


def test_a_session_passes_the_api_token_gate_and_only_for_that_request(client, monkeypatch):
    """The token box is gone from the UI: a signed-in browser's session has
    to satisfy API_TOKEN on mutating routes. A request without the cookie on
    the same client must not inherit that."""
    register(client, Authenticator())
    monkeypatch.setattr(auth, "API_TOKEN", "s3cret")

    assert client.put("/api/service-activity-credentials",
                      json={"app": "jellyfin", "credentials": {"api_key": "k"}}).status_code == 200

    cookie = client.cookies.get(passkeys.SESSION_COOKIE)
    client.cookies.clear()
    assert client.put("/api/service-activity-credentials",
                      json={"app": "jellyfin", "credentials": {"api_key": "k"}}).status_code == 401
    client.cookies.set(passkeys.SESSION_COOKIE, cookie)
