import { DEMO, demoDiskUsage } from "../demoData";
import { jsonOrThrow } from "./apiAuth";

// GET /api/disk/{host}?path= — what's taking the space under a folder. The
// agent scans in the background; `state` is "scanning" until it's "done".
export function fetchDiskUsage(host, path, { refresh = false } = {}) {
  if (DEMO) return Promise.resolve(demoDiskUsage(host, path));
  const params = new URLSearchParams({ path, refresh: refresh ? "true" : "false" });
  return fetch(`/api/disk/${encodeURIComponent(host)}?${params}`).then(jsonOrThrow);
}
