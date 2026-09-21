// Thin wrappers around the deployment routes (token handling: apiAuth.js).
import { authHeaders, jsonOrThrow } from "./apiAuth";

export function previewPlacement(spec) {
  return fetch("/api/deployments?dry_run=1", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(spec),
  }).then(jsonOrThrow);
}

export function deploy(spec, node) {
  const query = node ? `?node=${encodeURIComponent(node)}` : "";
  return fetch(`/api/deployments${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(spec),
  }).then(jsonOrThrow);
}

export function previewStack(stack) {
  return fetch("/api/stacks?dry_run=1", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(stack),
  }).then(jsonOrThrow);
}

export function deployStack(stack, node) {
  const query = node ? `?node=${encodeURIComponent(node)}` : "";
  return fetch(`/api/stacks${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(stack),
  }).then(jsonOrThrow);
}

export function redeploy(id, { excludeCurrent = true, node } = {}) {
  const params = new URLSearchParams({ exclude_current: String(excludeCurrent) });
  if (node) params.set("node", node);
  return fetch(`/api/deployments/${id}/redeploy?${params}`, {
    method: "POST",
    headers: authHeaders(),
  }).then(jsonOrThrow);
}

export function fetchRebalance() {
  return fetch("/api/rebalance", { headers: authHeaders() }).then(jsonOrThrow);
}

export function removeDeployment(id, { keepContainer = false } = {}) {
  const params = new URLSearchParams({ keep_container: String(keepContainer) });
  return fetch(`/api/deployments/${id}?${params}`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then(jsonOrThrow);
}
