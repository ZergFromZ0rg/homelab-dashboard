import { useEffect, useRef } from "react";

// Settings live in a right-hand drawer opened from the header gear, so they
// are one click from any tab and never replace the screen you were looking
// at. Esc or a click on the scrim closes it.
function SettingsDrawer({ open, onClose, children }) {
  const panelRef = useRef(null);
  // The parent passes a fresh onClose every render (every 2 s data tick).
  // Reading it through a ref keeps the effect below to open/close only —
  // depending on it directly re-ran the effect each tick, and its focus()
  // pulled the caret out of whatever settings field you were typing in.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    // The page behind stays put while the drawer scrolls.
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="drawer-root">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="drawer-head">
          <h2>Settings</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close settings"
            title="Close (Esc)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export default SettingsDrawer;
