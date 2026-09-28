import { jsonOrThrow } from "./apiAuth";
import { confirmedFetch } from "./confirmedFetch";

// /api/compose/{host}/... — a container's compose files, a checked diff of
// an edit, and applying it as a job (save, up -d, watch, roll back if it
// doesn't come up). See homelab-agent's compose_edit.py.

const base = (host) => `/api/compose/${encodeURIComponent(host)}`;

export const fetchComposeSettings = (host, container) =>
  fetch(`${base(host)}/containers/${encodeURIComponent(container)}`).then(jsonOrThrow);

const post = (host, route, body) =>
  fetch(`${base(host)}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(jsonOrThrow);

export const previewCompose = (host, body) => post(host, "preview", body);
export const applyCompose = (host, body) =>
  confirmedFetch(`${base(host)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(jsonOrThrow);

export const fetchComposeJob = (host, id) =>
  fetch(`${base(host)}/jobs/${encodeURIComponent(id)}`).then(jsonOrThrow);
