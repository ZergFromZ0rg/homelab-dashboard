import { DEMO, demoBackups, demoBackupArchives, demoBackupTargets } from "../demoData";
import { authHeaders, jsonOrThrow } from "./apiAuth";

// Volume backups. The job list is cheap and contacts no agent, so the tab
// polls it; everything else is on demand. A backup takes minutes, so
// "run now" returns as soon as the work is handed off and the poll picks
// up the result.
const DEMO_WRITE = "Demo mode — nothing is backed up.";

function send(method, url, body) {
  if (DEMO) return Promise.reject(new Error(DEMO_WRITE));

  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(jsonOrThrow);
}

export function fetchBackups() {
  if (DEMO) return Promise.resolve(demoBackups());
  return fetch("/api/backups").then(jsonOrThrow);
}

// What a host can back up, and whether it can store backups. The form is
// built from this, so a host that can't store anything has to come back
// with the reason rather than an empty list.
export function fetchBackupTargets(host) {
  if (DEMO) return Promise.resolve(demoBackupTargets(host));
  return fetch(`/api/backups/targets/${encodeURIComponent(host)}`, {
    headers: authHeaders(),
  }).then(jsonOrThrow);
}

export function fetchBackupArchives(id) {
  if (DEMO) return Promise.resolve(demoBackupArchives(id));
  return fetch(`/api/backups/${id}/archives`, { headers: authHeaders() })
    .then(jsonOrThrow);
}

export const createBackup = (spec) => send("POST", "/api/backups", spec);
export const updateBackup = (id, patch) => send("PUT", `/api/backups/${id}`, patch);
export const deleteBackup = (id) => send("DELETE", `/api/backups/${id}`);
export const runBackup = (id) => send("POST", `/api/backups/${id}/run`);
export const deleteArchives = (id, names) =>
  send("POST", `/api/backups/${id}/archives/delete`, { names });

// Reads the archive back on the host that holds it — the whole thing,
// through gzip, every tar member. Takes as long as the archive is big.
export const verifyArchive = (id, name) =>
  send("POST", `/api/backups/${id}/archives/verify`, { name });
