// What became of a rebuild click (state lives in useRebuild.js), as a chip next
// to the container or repo it was for; × clears a finished one. The buttons
// that start a rebuild are in the row's More menu and on the repo line.
export function RebuildNote({ note, onDismiss }) {
  if (!note) return null;
  return (
    <span className={`chip chip--status chip--${note.tone}`} title={note.title} role="status">
      {note.text}
      {note.dismiss && (
        <button type="button" className="chip-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </span>
  );
}
