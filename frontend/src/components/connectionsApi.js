import { DEMO, demoConnections } from "../demoData";
import { authHeaders, jsonOrThrow } from "./apiAuth";

// GET /api/connections/{host} — deliberately not on the /ws payload, so
// this is the only way the panel gets its data. `refresh` skips the
// backend's 30s cache for the panel's own reload button.
export function fetchConnections(host, { refresh = false } = {}) {
  if (DEMO) return Promise.resolve(demoConnections(host));

  const query = refresh ? "?refresh=true" : "";
  return fetch(
    `/api/connections/${encodeURIComponent(host)}${query}`,
    { headers: authHeaders() }
  ).then(jsonOrThrow);
}
