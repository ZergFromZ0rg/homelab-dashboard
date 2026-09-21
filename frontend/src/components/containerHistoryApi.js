import { DEMO, demoContainerHistory } from "../demoData";

// GET /api/containers/{host}/{name}/history — off the /ws payload, fetched
// when a container's details are opened.
export function fetchContainerHistory(host, name, range) {
  if (DEMO) return Promise.resolve(demoContainerHistory(name, range));

  const url =
    `/api/containers/${encodeURIComponent(host)}/` +
    `${encodeURIComponent(name)}/history?range=${encodeURIComponent(range)}`;

  return fetch(url).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `Request failed: ${response.status}`);
    return body;
  });
}
