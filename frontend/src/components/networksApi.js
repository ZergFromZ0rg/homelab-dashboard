import { DEMO, demoNetworkAction, demoNetworks } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// Docker networks per host (GET /api/networks/{host}) and the four changes
// the agent allows. Mutations resolve to `{success, error?}`; the error is
// the agent's own reason, worth showing as written.

const base = (host) => `/api/networks/${encodeURIComponent(host)}`;

export function fetchNetworks(host) {
  if (DEMO) return Promise.resolve(demoNetworks(host));
  return fetch(base(host)).then(jsonOrThrow);
}

function send(method, url, body) {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(jsonOrThrow);
}

export function createNetwork(host, { name, subnet, internal }) {
  if (DEMO) return Promise.resolve(demoNetworkAction(host, "create", { name, subnet, internal }));
  return send("POST", base(host), { name, subnet: subnet || null, internal });
}

export function removeNetwork(host, network) {
  if (DEMO) return Promise.resolve(demoNetworkAction(host, "remove", { network }));
  return send("DELETE", `${base(host)}/${encodeURIComponent(network)}`);
}

export function setMembership(host, network, container, connect) {
  if (DEMO) {
    return Promise.resolve(
      demoNetworkAction(host, connect ? "connect" : "disconnect", { network, container })
    );
  }
  return send(
    "POST",
    `${base(host)}/${encodeURIComponent(network)}/${connect ? "connect" : "disconnect"}`,
    { container }
  );
}
