import { DEMO, demoHostConfig } from "../demoData";
import { jsonOrThrow } from "./apiAuth";
import { confirmedFetch } from "./confirmedFetch";

// One host's agent settings. The agent decides what a setting means and
// what it will accept; this just carries the answer, refusals included —
// they name the exact fix.
export function fetchHostConfig(host) {
  if (DEMO) return Promise.resolve(demoHostConfig(host));

  return fetch(`/api/hosts/${encodeURIComponent(host)}/config`, {
  }).then(jsonOrThrow);
}

export function saveHostConfig(host, settings) {
  if (DEMO) return Promise.reject(new Error("Demo mode — nothing is saved."));

  return confirmedFetch(`/api/hosts/${encodeURIComponent(host)}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  }).then(jsonOrThrow);
}
