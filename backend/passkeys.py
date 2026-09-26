"""Passkey (WebAuthn) login: the stored credentials, the sessions they open,
and the in-flight challenges between an ``options`` call and its ``verify``.

Login is **off until the first passkey is added** and on from then on — the
same "unset = open" rule ``API_TOKEN`` follows, so a fresh install needs no
setup and adding one passkey is the whole switch. The server only ever holds
public keys; Face ID / Touch ID / Windows Hello happen in the browser.

One file on the ``/data`` volume holds it all. Session tokens are stored
hashed, so a copied ``auth.json`` can't be replayed as a login.

Lost every device? ``docker exec homelab-dashboard-api python -m
backend.passkeys reset`` removes all passkeys and sessions, which turns
login back off until you add a new one.
"""

from __future__ import annotations

import hashlib
import secrets
import sys
import threading
import time
import uuid
from pathlib import Path

from backend.env import env_str
from backend.jsonstore import read_json, write_json_atomic

AUTH_FILE = Path(env_str("AUTH_FILE", "/data/auth.json"))

SESSION_COOKIE = "hl_session"
SESSION_TTL = 30 * 24 * 3600  # sliding: every use pushes it out again
# last_seen is only rewritten to disk this often — a 2 s /ws poll must not
# turn into a file write every 2 s.
TOUCH_EVERY = 3600
CHALLENGE_TTL = 300
MAX_PASSKEYS = 20
MAX_NAME_LENGTH = 60


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class PasskeyStore:
    def __init__(self, path: Path = AUTH_FILE):
        self.path = Path(path)
        self._lock = threading.Lock()
        data = read_json(self.path, {})
        if not isinstance(data, dict):
            data = {}
        self._user_id: str = data.get("user_id") or secrets.token_hex(16)
        self._passkeys: list[dict] = [
            p for p in data.get("passkeys", []) if isinstance(p, dict) and p.get("id")
        ]
        self._sessions: dict[str, dict] = {
            k: v for k, v in (data.get("sessions") or {}).items() if isinstance(v, dict)
        }
        # ceremony id -> {"challenge": bytes, "kind": str, "expires": float}
        self._challenges: dict[str, dict] = {}

    # --- persistence -----------------------------------------------------

    def _save_locked(self) -> None:
        write_json_atomic(
            self.path,
            {
                "user_id": self._user_id,
                "passkeys": self._passkeys,
                "sessions": self._sessions,
            },
            label="auth",
        )

    # --- state -----------------------------------------------------------

    @property
    def user_id(self) -> bytes:
        return bytes.fromhex(self._user_id)

    def enabled(self) -> bool:
        """Login is enforced once at least one passkey exists."""
        with self._lock:
            return bool(self._passkeys)

    def rp_ids(self) -> list[str]:
        """Hostnames the passkeys were made for — the login screen on the
        wrong URL (plain http, an IP) uses this to point at the right one."""
        with self._lock:
            return sorted({p["rp_id"] for p in self._passkeys})

    # --- passkeys --------------------------------------------------------

    def passkeys(self) -> list[dict]:
        with self._lock:
            return [
                {k: v for k, v in p.items() if k not in ("public_key", "sign_count")}
                for p in self._passkeys
            ]

    def passkey(self, credential_id: str) -> dict | None:
        with self._lock:
            for p in self._passkeys:
                if p["id"] == credential_id:
                    return dict(p)
        return None

    def credential_ids(self, rp_id: str) -> list[str]:
        with self._lock:
            return [p["id"] for p in self._passkeys if p["rp_id"] == rp_id]

    def add_passkey(
        self,
        *,
        credential_id: str,
        public_key: str,
        sign_count: int,
        rp_id: str,
        name: str,
        synced: bool,
    ) -> dict:
        now = time.time()
        entry = {
            "id": credential_id,
            "public_key": public_key,
            "sign_count": sign_count,
            "rp_id": rp_id,
            "name": _clean_name(name) or "Passkey",
            "synced": synced,
            "created_at": now,
            "last_used_at": now,
        }
        with self._lock:
            if len(self._passkeys) >= MAX_PASSKEYS:
                raise ValueError(f"at most {MAX_PASSKEYS} passkeys")
            self._passkeys = [p for p in self._passkeys if p["id"] != credential_id]
            self._passkeys.append(entry)
            self._save_locked()
        return {k: v for k, v in entry.items() if k not in ("public_key", "sign_count")}

    def record_use(self, credential_id: str, sign_count: int) -> None:
        with self._lock:
            for p in self._passkeys:
                if p["id"] == credential_id:
                    p["sign_count"] = sign_count
                    p["last_used_at"] = time.time()
                    self._save_locked()
                    return

    def rename(self, credential_id: str, name: str) -> bool:
        name = _clean_name(name)
        if not name:
            return False
        with self._lock:
            for p in self._passkeys:
                if p["id"] == credential_id:
                    p["name"] = name
                    self._save_locked()
                    return True
        return False

    def remove(self, credential_id: str) -> bool:
        """Remove a passkey and every session it opened. Removing the last
        one turns login off."""
        with self._lock:
            before = len(self._passkeys)
            self._passkeys = [p for p in self._passkeys if p["id"] != credential_id]
            if len(self._passkeys) == before:
                return False
            self._sessions = {
                k: v
                for k, v in self._sessions.items()
                if v.get("passkey") != credential_id
            }
            self._save_locked()
            return True

    def reset(self) -> None:
        with self._lock:
            self._passkeys = []
            self._sessions = {}
            self._save_locked()

    # --- challenges ------------------------------------------------------

    def new_challenge(self, kind: str, rp_id: str) -> tuple[str, bytes]:
        ceremony = uuid.uuid4().hex
        challenge = secrets.token_bytes(32)
        now = time.time()
        with self._lock:
            self._challenges = {
                k: v for k, v in self._challenges.items() if v["expires"] > now
            }
            self._challenges[ceremony] = {
                "challenge": challenge,
                "kind": kind,
                "rp_id": rp_id,
                "expires": now + CHALLENGE_TTL,
            }
        return ceremony, challenge

    def take_challenge(self, ceremony: str, kind: str) -> dict | None:
        """Single use: a challenge is gone after its first verify attempt,
        right or wrong."""
        with self._lock:
            entry = self._challenges.pop(str(ceremony), None)
        if not entry or entry["kind"] != kind or entry["expires"] < time.time():
            return None
        return entry

    # --- sessions --------------------------------------------------------

    def open_session(self, credential_id: str) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            self._sessions = {
                k: v
                for k, v in self._sessions.items()
                if now - v.get("last_seen", 0) < SESSION_TTL
            }
            self._sessions[_hash(token)] = {
                "passkey": credential_id,
                "created": now,
                "last_seen": now,
            }
            self._save_locked()
        return token

    def check_session(self, token: str | None) -> bool:
        if not token:
            return False
        key = _hash(token)
        now = time.time()
        with self._lock:
            session = self._sessions.get(key)
            if not session:
                return False
            if now - session.get("last_seen", 0) >= SESSION_TTL:
                del self._sessions[key]
                self._save_locked()
                return False
            if now - session["last_seen"] >= TOUCH_EVERY:
                session["last_seen"] = now
                self._save_locked()
            return True

    def close_session(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            if self._sessions.pop(_hash(token), None) is not None:
                self._save_locked()


def _clean_name(name: object) -> str:
    return " ".join(str(name or "").split())[:MAX_NAME_LENGTH]


def device_name(user_agent: str) -> str:
    """A starting name for a new passkey, from the browser that made it.
    Renamable; it only has to beat "Passkey" for telling devices apart."""
    ua = user_agent or ""
    for needle, label in (
        ("iPhone", "iPhone"),
        ("iPad", "iPad"),
        ("Android", "Android"),
        ("Macintosh", "Mac"),
        ("Windows", "Windows"),
        ("CrOS", "Chromebook"),
        ("Linux", "Linux"),
    ):
        if needle in ua:
            return label
    return "Passkey"


store = PasskeyStore()


if __name__ == "__main__":
    if sys.argv[1:] == ["reset"]:
        count = len(store.passkeys())
        store.reset()
        print(f"Removed {count} passkey(s) and all sessions. Login is off until "
              "you add a passkey again. Restart the container to apply.")
    else:
        print("usage: python -m backend.passkeys reset")
        sys.exit(2)
