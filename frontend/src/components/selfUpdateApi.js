// The header "Update" button's API calls. Not part of the WebSocket
// payload or a useServerList — fetched on mount and polled only while an
// update is actually running, since there's nothing to stream the rest
// of the time.

import { authHeaders } from "./apiAuth";

export async function getSelfUpdateStatus() {
  const response = await fetch("/api/self-update");
  if (!response.ok) {
    throw new Error(`GET /api/self-update failed: ${response.status}`);
  }
  return response.json();
}

export async function triggerSelfUpdate() {
  const response = await fetch("/api/self-update", {
    method: "POST",
    headers: authHeaders(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || `POST /api/self-update failed: ${response.status}`);
  }
  return body;
}
