import { DEMO, demoHostConfig } from "../demoData";
import { authHeaders, jsonOrThrow } from "./apiAuth";

// One host's agent settings. The agent decides what a setting means and
// what it will accept; this just carries the answer, refusals included —
// they name the exact fix.
export function fetchHostConfig(host) {
  if (DEMO) return Promise.resolve(demoHostConfig(host));

  return fetch(`/api/hosts/${encodeURIComponent(host)}/config`, {
    headers: authHeaders(),
  }).then(jsonOrThrow);
}

export function saveHostConfig(host, settings) {
  if (DEMO) return Promise.reject(new Error("Demo mode — nothing is saved."));

  return fetch(`/api/hosts/${encodeURIComponent(host)}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ settings }),
  }).then(jsonOrThrow);
}
