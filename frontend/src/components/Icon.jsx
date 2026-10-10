// A handful of line icons for per-item actions, so a card can carry
// pause / edit / delete as small icon buttons instead of a row of words.
// Stroke icons in currentColor; `play` and `stop` are filled shapes.

const PATHS = {
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </>
  ),
  pause: (
    <>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </>
  ),
  play: <path d="M8 5.5v13l11-6.5z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6.5 7l1 13h9l1-13" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 15l3.5-4 3 2.5L20 7" />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4" width="17" height="4.5" rx="1" />
      <path d="M5.5 8.5V20h13V8.5" />
      <path d="M10 12.5h4" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  chevron: <path d="M6 9l6 6 6-6" />,
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7 10.5l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V5" />
      <path d="M7 9.5l5-5 5 5" />
      <path d="M5 20h14" />
    </>
  ),
  folder: <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  folderPlus: (
    <>
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M12 10.5v5" />
      <path d="M9.5 13h5" />
    </>
  ),
  filePlus: (
    <>
      <path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M12 11v5" />
      <path d="M9.5 13.5h5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3" />
    </>
  ),
  move: (
    <>
      <path d="M4 12h15" />
      <path d="M14 7l5 5-5 5" />
    </>
  ),
  logs: (
    <>
      <path d="M5 6h14" />
      <path d="M5 10h10" />
      <path d="M5 14h14" />
      <path d="M5 18h8" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <circle cx="15" cy="7" r="2" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5" />
      <path d="M12.5 15h4.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  packets: (
    <>
      <path d="M3 12h3l2.5-6 4 12 2.5-6H21" />
    </>
  ),
  hammer: (
    <>
      <path d="M13.5 8.5L5 17a1.8 1.8 0 0 0 2.5 2.5L16 11" />
      <path d="M11 6l3-3 7 7-3 3z" />
    </>
  ),
};

const FILLED = new Set(["play", "stop"]);

function Icon({ name, size = 16 }) {
  const filled = FILLED.has(name);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

// A square ghost button holding one icon. `label` is both the tooltip and
// the accessible name, since there's no visible text.
// `working` shows a spinner in place of the icon while the button's action
// is being carried out (see [aria-busy] in App.css) and blocks a second click.
export function IconButton({ icon, label, danger, active, working, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`icon-action ${danger ? "icon-action--danger" : ""} ${
        active ? "icon-action--active" : ""
      } ${className}`}
      title={working ? `${label} — working…` : label}
      aria-label={label}
      aria-busy={working || undefined}
      {...props}
      disabled={props.disabled || working}
    >
      <Icon name={icon} />
    </button>
  );
}

export default Icon;
