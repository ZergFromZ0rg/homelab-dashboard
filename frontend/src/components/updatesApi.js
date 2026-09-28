import { jsonOrThrow } from "./apiAuth";

// /api/updates/{host} — start an image update (named containers, or all
// with an update), follow the job, or force a registry check.

const base = (host) => `/api/updates/${encodeURIComponent(host)}`;

export const startUpdate = (host, containers) =>
  fetch(base(host), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(containers ? { containers } : {}),
  }).then(jsonOrThrow);

export const fetchUpdateJob = (host, id) =>
  fetch(`${base(host)}/jobs/${encodeURIComponent(id)}`).then(jsonOrThrow);

export const checkUpdates = (host) =>
  fetch(`${base(host)}/check`, { method: "POST" }).then(jsonOrThrow);
