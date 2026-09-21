// Thin wrappers around the deployment routes (token handling: apiAuth.js).
import { DEMO, demoRebalance } from "../demoData";
import { authHeaders, jsonOrThrow } from "./apiAuth";

// /?demo has no backend behind it. Reads answer from a fixture; anything
// that would change state says so instead of 404ing.
const DEMO_WRITE = "Demo mode \u2014 changes aren't saved.";

function demoRefusal() {
  return Promise.reject(new Error(DEMO_WRITE));
}

export function previewPlacement(spec) {
  if (DEMO) return demoRefusal();
  return fetch("/api/deployments?dry_run=1", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(spec),
  }).then(jsonOrThrow);
}

export function deploy(spec, node) {
  if (DEMO) return demoRefusal();
  const query = node ? `?node=${encodeURIComponent(node)}` : "";
  return fetch(`/api/deployments${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(spec),
  }).then(jsonOrThrow);
}

export function previewStack(stack) {
  if (DEMO) return demoRefusal();
  return fetch("/api/stacks?dry_run=1", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(stack),
  }).then(jsonOrThrow);
}

export function deployStack(stack, node) {
  if (DEMO) return demoRefusal();
  const query = node ? `?node=${encodeURIComponent(node)}` : "";
  return fetch(`/api/stacks${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(stack),
  }).then(jsonOrThrow);
}

export function redeploy(id, { excludeCurrent = true, node } = {}) {
  if (DEMO) return demoRefusal();
  const params = new URLSearchParams({ exclude_current: String(excludeCurrent) });
  if (node) params.set("node", node);
  return fetch(`/api/deployments/${id}/redeploy?${params}`, {
    method: "POST",
    headers: authHeaders(),
  }).then(jsonOrThrow);
}

export function fetchRebalance() {
  if (DEMO) return Promise.resolve(demoRebalance());
  return fetch("/api/rebalance", { headers: authHeaders() }).then(jsonOrThrow);
}

export function removeDeployment(id, { keepContainer = false } = {}) {
  if (DEMO) return demoRefusal();
  const params = new URLSearchParams({ keep_container: String(keepContainer) });
  return fetch(`/api/deployments/${id}?${params}`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then(jsonOrThrow);
}
