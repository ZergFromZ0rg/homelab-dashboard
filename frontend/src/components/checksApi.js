import { DEMO, demoCheckHistory } from "../demoData";
import { authHeaders, jsonOrThrow } from "./apiAuth";

function send(method, url, body) {
  if (DEMO) return Promise.reject(new Error("Demo mode — changes aren't saved."));
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(jsonOrThrow);
}

export const createCheck = (spec) => send("POST", "/api/checks", spec);
export const updateCheck = (id, patch) => send("PUT", `/api/checks/${id}`, patch);
export const deleteCheck = (id) => send("DELETE", `/api/checks/${id}`);
export const runCheck = (id) => send("POST", `/api/checks/${id}/run`);

export function fetchCheckHistory(id, range) {
  if (DEMO) return Promise.resolve(demoCheckHistory(id, range));
  return fetch(`/api/checks/${id}/history?range=${range}`).then(jsonOrThrow);
}
