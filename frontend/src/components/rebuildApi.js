import { DEMO } from "../demoData";
import { authHeaders, jsonOrThrow } from "./apiAuth";

// POST /api/rebuild/{host} starts a job; GET .../{id} polls it. The agent
// does the pull and the build, which takes minutes — hence the job rather
// than a request held open.
const DEMO_WRITE = "Demo mode — nothing is rebuilt.";

export function startRebuild(host, container, { pull = true } = {}) {
  if (DEMO) return Promise.reject(new Error(DEMO_WRITE));

  return fetch(`/api/rebuild/${encodeURIComponent(host)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ container, pull }),
  }).then(jsonOrThrow);
}

export function fetchRebuildJob(host, jobId) {
  if (DEMO) return Promise.reject(new Error(DEMO_WRITE));

  return fetch(
    `/api/rebuild/${encodeURIComponent(host)}/${encodeURIComponent(jobId)}`,
    { headers: authHeaders() }
  ).then(jsonOrThrow);
}

// Update every stale agent at once. The dashboard orders them so its own
// host goes last — rebuilding that one drops the connection you're
// watching from.
export function rebuildFleet(hosts) {
  if (DEMO) return Promise.reject(new Error(DEMO_WRITE));

  return fetch("/api/fleet/rebuild", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(hosts?.length ? { hosts } : {}),
  }).then(jsonOrThrow);
}
