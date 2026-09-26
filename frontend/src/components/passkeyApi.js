import { jsonOrThrow } from "./apiAuth";

// Passkey login. The server sends WebAuthn options as JSON (binary fields
// base64url-encoded); the browser API wants ArrayBuffers — these two
// helpers are the whole translation layer.

function toBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function toB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Browsers only expose passkeys on https (or http://localhost).
export const passkeysSupported =
  typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return jsonOrThrow(res);
}

export async function getAuthStatus() {
  const res = await fetch("/api/auth/status");
  return jsonOrThrow(res);
}

export async function registerPasskey(name) {
  const { ceremony, options } = await post("/api/auth/register/options");
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({
        ...c,
        id: toBytes(c.id),
      })),
    },
  });
  return post("/api/auth/register/verify", {
    ceremony,
    name,
    credential: {
      id: credential.id,
      rawId: toB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toB64url(credential.response.clientDataJSON),
        attestationObject: toB64url(credential.response.attestationObject),
        transports: credential.response.getTransports?.() ?? [],
      },
      clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    },
  });
}

export async function signInWithPasskey() {
  const { ceremony, options } = await post("/api/auth/login/options");
  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({
        ...c,
        id: toBytes(c.id),
      })),
    },
  });
  const r = credential.response;
  return post("/api/auth/login/verify", {
    ceremony,
    credential: {
      id: credential.id,
      rawId: toB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toB64url(r.clientDataJSON),
        authenticatorData: toB64url(r.authenticatorData),
        signature: toB64url(r.signature),
        userHandle: r.userHandle ? toB64url(r.userHandle) : null,
      },
      clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
    },
  });
}

export const signOut = () => post("/api/auth/logout");

export async function listPasskeys() {
  return jsonOrThrow(await fetch("/api/auth/passkeys"));
}

export async function renamePasskey(id, name) {
  const res = await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return jsonOrThrow(res);
}

export async function removePasskey(id) {
  const res = await fetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return jsonOrThrow(res);
}

// A user dismissing the Face ID / Touch ID sheet isn't an error worth a red
// line; everything else is.
export function passkeyError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "AbortError") return "";
  if (error?.name === "InvalidStateError") return "This device already has a passkey here.";
  return error?.message || "Something went wrong.";
}
