// Credentials for the live-activity probes (qBittorrent, Jellyfin),
// entered from Settings instead of the backend's .env. Unlike
// pins/todos/overrides this deliberately does NOT ride the WebSocket
// payload or a shared useServerList — it's fetched once when Settings
// opens (GET only ever returns which apps are configured, never the
// secret values) and written with a per-app PUT/DELETE rather than a
// full-state replace, since the frontend never holds today's values to
// echo back.
//
// /?demo has no backend: report nothing configured and refuse writes, so
// opening Settings there doesn't fire a 404.
import { DEMO } from "../demoData";

const DEMO_WRITE = "Demo mode \u2014 changes aren't saved.";

export async function getServiceActivityCredentialsStatus() {
  if (DEMO) return {};
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
  if (DEMO) throw new Error(DEMO_WRITE);
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
  if (DEMO) throw new Error(DEMO_WRITE);
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
