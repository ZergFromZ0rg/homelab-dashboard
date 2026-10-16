import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";

// The actions on a container row: a few labelled buttons for what you do most,
// and a "More" menu for the rest where every entry says what it does. Icons
// alone made the row a wall of small glyphs nobody could read.

// tone: "danger" for something that takes a service down, "ok" for starting one.
export function RowAction({ icon, label, title, tone, working, active, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`row-action ${tone ? `row-action--${tone}` : ""} ${active ? "row-action--active" : ""} ${className}`}
      title={working ? `${label} — working…` : title || label}
      aria-busy={working || undefined}
      {...props}
      disabled={props.disabled || working}
    >
      <Icon name={icon} size={15} />
      <span>{label}</span>
    </button>
  );
}

// items: [{ icon, label, hint, onClick, disabled }]; null/false entries are skipped.
export function RowMenu({ items, label = "More" }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const button = useRef(null);
  const menu = useRef(null);
  const shown = items.filter(Boolean);

  // Placed under the button, or above it when there's no room, from the
  // button's own position: the row clips anything that sticks out of it, so
  // the menu lives on the body.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const height = menu.current?.offsetHeight ?? 220;
    const below = window.innerHeight - r.bottom;
    setPlace({
      right: Math.max(8, window.innerWidth - r.right),
      ...(below >= height + 12 || r.top < height + 12 ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onDown = (e) => {
      if (!menu.current?.contains(e.target) && !button.current?.contains(e.target)) close();
    };
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  if (shown.length === 0) return null;

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`row-action ${open ? "row-action--active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Shell, packet capture, compose settings, details and more"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" size={15} />
        <span>{label}</span>
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="row-menu" role="menu" style={place ?? { visibility: "hidden", top: 0, right: 0 }}>
            {shown.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className="row-menu-item"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                <Icon name={item.icon} size={16} />
                <span>
                  <strong>{item.label}</strong>
                  {item.hint && <small>{item.hint}</small>}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
