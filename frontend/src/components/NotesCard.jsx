import { useCallback, useEffect, useRef, useState } from "react";
import Card from "./Card";
import NoteEditor from "./NoteEditor";
import { formatAge } from "./format";
import { noteTitle, notePreview } from "./noteText";
import { createNote, listNotes } from "./notesApi";
import { useNow } from "./useNow";

const REFRESH_MS = 30_000;

// Free-text notes, shared across devices. A list of notes (first line =
// title) that opens into an autosaving editor.
function NotesCard() {
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [filter, setFilter] = useState("");
  const now = useNow(30_000).getTime() / 1000;

  // Don't refresh the list from under an editor that's open.
  const openRef = useRef(null);
  useEffect(() => {
    openRef.current = openId;
  });

  const reload = useCallback(async () => {
    try {
      setNotes(await listNotes());
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = () =>
      listNotes()
        .then((list) => {
          if (cancelled) return;
          setNotes(list);
          setError("");
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        });

    load();
    const id = setInterval(() => {
      if (openRef.current == null) load();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const create = async () => {
    try {
      const note = await createNote("");
      setNotes((list) => [note, ...(list ?? [])]);
      setOpenId(note.id);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const onSaved = useCallback((saved) => {
    setNotes((list) => (list ?? []).map((n) => (n.id === saved.id ? saved : n)));
  }, []);

  const onDeleted = useCallback(
    (id) => {
      setNotes((list) => (list ?? []).filter((n) => n.id !== id));
      setOpenId(null);
    },
    []
  );

  const onClose = useCallback(() => {
    setOpenId(null);
    reload();
  }, [reload]);

  const open = notes?.find((n) => n.id === openId);
  const needle = filter.trim().toLowerCase();
  const shown = (notes ?? [])
    .filter((n) => !needle || n.body.toLowerCase().includes(needle))
    .sort((a, b) => b.updated_at - a.updated_at);

  return (
    <Card
      title="Notes"
      count={notes?.length || null}
      actions={
        !open && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={create}>
            + New note
          </button>
        )
      }
    >
      {error && <p className="cred-error">{error}</p>}

      {open ? (
        <NoteEditor
          key={open.id}
          note={open}
          onSaved={onSaved}
          onClose={onClose}
          onDeleted={onDeleted}
        />
      ) : notes == null ? (
        !error && <p className="overview-empty">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="overview-empty">
          Nothing here yet. Jot down a command, a plan, a wifi password you keep
          forgetting — it's saved on the server, so it's on every device.
        </p>
      ) : (
        <>
          {notes.length > 4 && (
            <input
              type="search"
              className="deploy-input notes-filter"
              placeholder="Search notes…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Search notes"
            />
          )}
          {shown.length === 0 ? (
            <p className="overview-empty">No notes match.</p>
          ) : (
            <ul className="notes-list">
              {shown.map((n) => (
                <li key={n.id}>
                  <button type="button" className="note-row" onClick={() => setOpenId(n.id)}>
                    <span className="note-row-title">{noteTitle(n.body)}</span>
                    {notePreview(n.body) && (
                      <span className="note-row-preview">{notePreview(n.body)}</span>
                    )}
                    <span className="note-row-time">{formatAge(Math.max(0, now - n.updated_at))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

export default NotesCard;
