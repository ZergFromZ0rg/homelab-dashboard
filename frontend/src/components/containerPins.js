// Pins live on the backend (GET/PUT /api/pins) and ride the WebSocket
// payload, so they're the same on every browser. localStorage keeps a
// copy only so the first paint after a reload — before the first WS tick
// — shows the right rows instead of flashing unpinned.

const CACHE_KEY = "homelab.pinnedContainers";

// Containers are pinned by host + name rather than id, so a pin survives
// the container being recreated (a redeploy or `docker compose up` gives
// it a fresh id but the same name).
export function pinKey(host, name) {
  return `${host}/${name}`;
}

export function loadCachedPins() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cachePins(keys) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(keys));
  } catch {
    // ignore
  }
}

export function togglePin(keys, key) {
  return keys.includes(key)
    ? keys.filter((k) => k !== key)
    : [...keys, key];
}

export async function putPins(keys) {
  const response = await fetch("/api/pins", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pins: keys }),
  });
  if (!response.ok) throw new Error(`PUT /api/pins failed: ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.pins) ? body.pins : keys;
}
