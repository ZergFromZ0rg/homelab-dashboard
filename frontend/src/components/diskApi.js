import { DEMO, demoDiskDelete, demoDiskUsage } from "../demoData";
import { authHeaders, jsonOrThrow } from "./apiAuth";

// GET /api/disk/{host}?path= — what's taking the space under a folder. The
// agent scans in the background; `state` is "scanning" until it's "done".
export function fetchDiskUsage(host, path, { refresh = false } = {}) {
  if (DEMO) return Promise.resolve(demoDiskUsage(host, path));
  const params = new URLSearchParams({ path, refresh: refresh ? "true" : "false" });
  return fetch(`/api/disk/${encodeURIComponent(host)}?${params}`).then(jsonOrThrow);
}

// POST /api/disk/{host}/delete — resolves to {success, freed_bytes} or
// {success: false, error} with the agent's reason (system path, in use by a
// container, ...).
export function deleteDiskPath(host, path) {
  if (DEMO) return Promise.resolve(demoDiskDelete(host, path));
  return fetch(`/api/disk/${encodeURIComponent(host)}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path }),
  }).then(jsonOrThrow);
}
