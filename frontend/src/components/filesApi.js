import { DEMO, demoDiskUsage } from "../demoData";
import { AUTH_REQUIRED_EVENT, jsonOrThrow } from "./apiAuth";

// /api/files/{host}/... — the file browser. Reads work anywhere; changes
// only inside the host's writable roots (its owner's home and the compose
// stack folders), and the agent says why when it refuses. A 409 is a
// conflict (exists already / changed on disk) and carries `conflict: true`
// so the caller can offer to overwrite.

const base = (host) => `/api/files/${encodeURIComponent(host)}`;

async function call(url, init) {
  const response = await fetch(url, init);
  try {
    return await jsonOrThrow(response);
  } catch (error) {
    if (response.status === 409) error.conflict = true;
    throw error;
  }
}

const post = (host, route, body, method = "POST") =>
  call(`${base(host)}/${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function demoListing(host, path) {
  const resolved = path === "~" ? "/home/zerg" : path;
  const usage = demoDiskUsage(host, resolved);
  return {
    path: resolved,
    parent: usage.parent,
    writable: resolved.startsWith("/home/zerg"),
    why_not: resolved.startsWith("/home/zerg") ? null : "outside the folders this host allows writing to",
    home: "/home/zerg",
    entries: usage.entries.map((e) => ({
      name: e.name,
      path: e.path,
      kind: e.kind,
      size: e.kind === "file" ? e.bytes : null,
      modified: e.modified,
      target: e.target,
    })),
  };
}

export function listFolder(host, path) {
  if (DEMO) return Promise.resolve(demoListing(host, path));
  return call(`${base(host)}/list?${new URLSearchParams({ path })}`);
}

export function readText(host, path) {
  if (DEMO) {
    return Promise.resolve({
      path,
      content: "# demo file\nservices:\n  web:\n    image: nginx:alpine\n",
      modified: 0,
      writable: false,
      why_not: "demo mode",
    });
  }
  return call(`${base(host)}/text?${new URLSearchParams({ path })}`);
}

// `modified` is the mtime the file was opened at (null for a new file);
// the agent refuses with a conflict if it changed since.
export const saveText = (host, path, content, modified) =>
  post(host, "text", { path, content, modified }, "PUT");

export const renameEntry = (host, path, name) => post(host, "rename", { path, name });

export const makeFolder = (host, path) => post(host, "mkdir", { path });

export function downloadUrl(host, path, { inline = false } = {}) {
  const query = new URLSearchParams({ path });
  if (inline) query.set("inline", "true");
  return `${base(host)}/download?${query}`;
}

// XHR rather than fetch, for upload progress. Resolves to the agent's
// answer; rejects with its reason (and `conflict` on a 409).
export function uploadFile(host, path, file, { overwrite = false, onProgress } = {}) {
  if (DEMO) return Promise.reject(new Error("Uploads are off in demo mode"));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ path, overwrite: overwrite ? "true" : "false" });
    xhr.open("POST", `${base(host)}/upload?${query}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new Error("upload failed — connection lost"));
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON; fall through with the status
      }
      if (xhr.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      const error = new Error(body.error || body.detail || `upload failed (${xhr.status})`);
      if (xhr.status === 409) error.conflict = true;
      reject(error);
    };
    xhr.send(file);
  });
}
