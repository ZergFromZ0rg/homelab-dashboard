// Credentials for the live-activity probes (qBittorrent, Jellyfin),
// entered from Settings instead of the backend's .env. Unlike
// pins/todos/overrides this deliberately does NOT ride the WebSocket
// payload or a shared useServerList — it's fetched once when Settings
// opens (GET only ever returns which apps are configured, never the
// secret values) and written with a per-app PUT/DELETE rather than a
// full-state replace, since the frontend never holds today's values to
// echo back.

export async function getServiceActivityCredentialsStatus() {
  const response = await fetch("/api/service-activity-credentials");
  if (!response.ok) {
    throw new Error(
      `GET /api/service-activity-credentials failed: ${response.status}`
    );
  }
  const body = await response.json();
  return body.configured || {};
}

export async function putServiceActivityCredentials(app, credentials) {
  const response = await fetch("/api/service-activity-credentials", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app, credentials }),
  });
  if (!response.ok) {
    throw new Error(
      `PUT /api/service-activity-credentials failed: ${response.status}`
    );
  }
  const body = await response.json();
  return body.configured || {};
}

export async function clearServiceActivityCredentials(app) {
  const response = await fetch(
    `/api/service-activity-credentials/${encodeURIComponent(app)}`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    throw new Error(
      `DELETE /api/service-activity-credentials/${app} failed: ${response.status}`
    );
  }
  const body = await response.json();
  return body.configured || {};
}
