// Manual per-container service_activity overrides (Settings → Containers
// → live-activity) live on the backend (GET/PUT
// /api/service-activity-overrides) and ride the WebSocket payload — an
// override changes what the backend actually probes, so it has to be the
// same on every browser, unlike the rest of Settings (display-only
// localStorage prefs).
//
// Mirrors containerPins.js / todosApi.js; the value here is a
// { "host/name": "qbittorrent" | "jellyfin" | "none" } map rather than a
// list.

const CACHE_KEY = "homelab.serviceActivityOverrides";

export function loadCachedServiceActivityOverrides() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function cacheServiceActivityOverrides(overrides) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(overrides));
  } catch {
    // ignore
  }
}

export async function putServiceActivityOverrides(overrides) {
  const response = await fetch("/api/service-activity-overrides", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overrides }),
  });
  if (!response.ok) {
    throw new Error(
      `PUT /api/service-activity-overrides failed: ${response.status}`
    );
  }
  const body = await response.json();
  return body.overrides && typeof body.overrides === "object"
    ? body.overrides
    : overrides;
}
