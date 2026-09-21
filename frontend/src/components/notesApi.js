import { DEMO, demoNotesSeed } from "../demoData";

// Notes live on the backend (/api/notes) so they're the same on every
// device. A save says which version it was based on; if the note changed
// elsewhere the backend answers 409 and the thrown error carries the
// current copy as `error.conflict`.

async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));

  if (response.status === 409 && data.current) {
    throw Object.assign(new Error(data.detail || "This note was changed somewhere else."), {
      conflict: data.current,
    });
  }
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : `Request failed: ${response.status}`);
  }
  return data;
}

// /?demo has no backend: keep the notes in memory so the widget is usable.
let demoNotes = DEMO ? demoNotesSeed() : null;

function demoSave(id, body) {
  const note = demoNotes.find((n) => n.id === id);
  if (!note) throw new Error("no such note");
  if (note.body !== body) {
    note.body = body;
    note.updated_at = Date.now() / 1000;
  }
  return { ...note };
}

export async function listNotes() {
  if (DEMO) return demoNotes.map((n) => ({ ...n })).sort((a, b) => b.updated_at - a.updated_at);
  return (await request("GET", "/api/notes")).notes;
}

export async function createNote(body = "") {
  if (DEMO) {
    const t = Date.now() / 1000;
    const note = { id: `demo${Math.random().toString(16).slice(2, 8)}`, body, created_at: t, updated_at: t };
    demoNotes = [note, ...demoNotes];
    return { ...note };
  }
  return request("POST", "/api/notes", { body });
}

export async function saveNote(id, body, baseUpdatedAt) {
  if (DEMO) return demoSave(id, body);
  return request("PUT", `/api/notes/${id}`, { body, base_updated_at: baseUpdatedAt ?? null });
}

export async function deleteNote(id) {
  if (DEMO) {
    demoNotes = demoNotes.filter((n) => n.id !== id);
    return { deleted: id };
  }
  return request("DELETE", `/api/notes/${id}`);
}
