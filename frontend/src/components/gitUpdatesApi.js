import { jsonOrThrow } from "./apiAuth";
import { confirmedFetch } from "./confirmedFetch";

export const fetchGitUpdates = (signal) =>
  fetch("/api/git-updates", { signal }).then(jsonOrThrow);

export const setGitUpdates = (host, projectId, enabled) =>
  confirmedFetch(`/api/git-updates/${encodeURIComponent(host)}/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  }).then(jsonOrThrow);
