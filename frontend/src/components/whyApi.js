import { DEMO, demoWhy } from "../demoData";

// GET /api/containers/{host}/{name}/why — what a container is doing to its
// host and what changed. `container` is only used by the demo, which has no
// backend to ask.
export function fetchWhy(host, container) {
  if (DEMO) return Promise.resolve(demoWhy(host, container.name, container));

  const url = `/api/containers/${encodeURIComponent(host)}/${encodeURIComponent(container.name)}/why`;

  return fetch(url).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `Request failed: ${response.status}`);
    return body;
  });
}
