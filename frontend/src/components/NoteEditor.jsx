import { useCallback, useEffect, useRef, useState } from "react";
import { deleteNote, saveNote } from "./notesApi";

const SAVE_DELAY_MS = 800;
const MAX_LENGTH = 20000;

const STATUS_TEXT = {
  saved: "Saved",
  saving: "Saving…",
  dirty: "Unsaved changes…",
};

// One note, saved automatically shortly after you stop typing. Saves are
// queued (never two in flight) and each carries the version it was based
// on, so an edit made on another device turns into a visible conflict
// instead of being overwritten.
function NoteEditor({ note, onSaved, onClose, onDeleted }) {
  const [text, setText] = useState(note.body);
  const [status, setStatus] = useState("saved");
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(null);

  const textRef = useRef(note.body);
  const savedRef = useRef(note.body);
  const baseRef = useRef(note.updated_at);
  const conflictRef = useRef(null);
  const timerRef = useRef(null);
  const queueRef = useRef(Promise.resolve());

  useEffect(() => {
    conflictRef.current = conflict;
  });

  const runSave = useCallback(
    async (force) => {
      const body = textRef.current;
      if (body === savedRef.current && !force) return;

      setStatus("saving");
      try {
        const saved = await saveNote(note.id, body, force ? null : baseRef.current);
        baseRef.current = saved.updated_at;
        savedRef.current = saved.body;
        onSaved(saved);
        setStatus(textRef.current === saved.body ? "saved" : "dirty");
        setMessage("");
      } catch (error) {
        if (error.conflict) {
          setConflict(error.conflict);
          setStatus("conflict");
        } else {
          setMessage(error.message);
          setStatus("error");
        }
      }
    },
    [note.id, onSaved]
  );

  // Chain saves so a second one always starts from the first one's result.
  const save = useCallback(
    (force = false) => {
      queueRef.current = queueRef.current.then(() => runSave(force));
      return queueRef.current;
    },
    [runSave]
  );

  const edit = (value) => {
    const next = value.slice(0, MAX_LENGTH);
    textRef.current = next;
    setText(next);
    if (!conflictRef.current) {
      setStatus("dirty");
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => save(), SAVE_DELAY_MS);
    }
  };

  // Leaving the tab mid-typing shouldn't drop the last few keystrokes.
  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      if (textRef.current !== savedRef.current && !conflictRef.current) {
        saveNote(note.id, textRef.current, baseRef.current).catch(() => {});
      }
    },
    [note.id]
  );

  const back = async () => {
    clearTimeout(timerRef.current);
    if (textRef.current.trim() === "" && !conflictRef.current) {
      // A note you opened and never wrote in isn't worth keeping.
      try {
        await deleteNote(note.id);
        onDeleted(note.id);
        return;
      } catch {
        // fall through and just close it
      }
    }
    if (!conflictRef.current) await save();
    onClose();
  };

  const remove = async () => {
    if (textRef.current.trim() && !window.confirm("Delete this note?")) return;
    clearTimeout(timerRef.current);
    try {
      await deleteNote(note.id);
      onDeleted(note.id);
    } catch (error) {
      setMessage(error.message);
      setStatus("error");
    }
  };

  const useTheirs = () => {
    textRef.current = conflict.body;
    savedRef.current = conflict.body;
    baseRef.current = conflict.updated_at;
    setText(conflict.body);
    onSaved(conflict);
    setConflict(null);
    setStatus("saved");
  };

  const keepBoth = () => {
    const merged = `${textRef.current}\n\n--- the other version ---\n\n${conflict.body}`.slice(0, MAX_LENGTH);
    textRef.current = merged;
    setText(merged);
    baseRef.current = conflict.updated_at;
    setConflict(null);
    save();
  };

  const keepMine = () => {
    setConflict(null);
    save(true);
  };

  return (
    <div className="note-editor">
      <div className="note-editor-bar">
        <button type="button" className="btn btn--sm btn--ghost" onClick={back}>
          ← All notes
        </button>
        <span className={`note-status note-status--${status}`}>
          {status === "error" ? message : STATUS_TEXT[status] ?? ""}
          {status === "error" && (
            <button type="button" className="note-retry" onClick={() => save()}>
              Retry
            </button>
          )}
        </span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={remove}>
          Delete
        </button>
      </div>

      {conflict && (
        <div className="note-conflict" role="alert">
          <strong>This note was changed on another device.</strong>
          <div className="note-conflict-actions">
            <button type="button" className="btn btn--sm" onClick={keepBoth}>
              Keep both
            </button>
            <button type="button" className="btn btn--sm" onClick={useTheirs}>
              Use their version
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={keepMine}>
              Overwrite with mine
            </button>
          </div>
        </div>
      )}

      <textarea
        className="note-textarea"
        value={text}
        onChange={(e) => edit(e.target.value)}
        placeholder="Start typing — it saves automatically."
        aria-label="Note"
        autoFocus
        spellCheck
      />

      {text.length > MAX_LENGTH * 0.75 && (
        <div className="note-count">
          {text.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}
        </div>
      )}
    </div>
  );
}

export default NoteEditor;
