import { IconButton } from "./Icon";

// The rebuild action for a container row (state lives in useRebuild.js):
// an icon among the row's actions, and the status its click leaves behind.
function RebuildButton({ rebuild }) {
  return (
    <IconButton
      icon="hammer"
      label={rebuild.running ? "Rebuilding…" : rebuild.title}
      working={rebuild.running}
      onClick={rebuild.run}
    />
  );
}

// The persistent status a click leaves behind; × clears a finished one.
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

export default RebuildButton;
