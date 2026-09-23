import AppIcon from "./AppIcon";

// A link rendered as an app tile: the service's own favicon, its name, and
// a status dot when one of the Services checks is already watching that
// host.
//
// The icon is the service's /favicon.ico (see AppIcon), falling back to a
// lettered avatar.

// Links are stored in localStorage, so a blob written by an older build
// (or hand-edited) can hold something `new URL` won't parse. Showing the
// raw string beats throwing during render and blanking the whole tab.
function hostLabel(href) {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

function AppTile({ link, status, onRemove }) {
  return (
    <div className={`app-tile ${status ? `app-tile--${status}` : ""}`}>
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="app-tile-link"
        title={`${link.label} — ${hostLabel(link.url)}${
          status ? ` (${status})` : ""
        }`}
      >
        <AppIcon url={link.url} label={link.label} />
        <span className="app-tile-label">{link.label}</span>
      </a>

      {/* Only shown for a link a check is already watching — a tile with no
          dot means "not checked", not "unknown". */}
      {status && (
        <span
          className={`app-tile-dot status-dot status-dot--${
            status === "up" ? "ok" : status === "down" ? "bad" : "none"
          }`}
          title={`This host is ${status} (Services)`}
        />
      )}

      <button
        type="button"
        className="app-tile-remove"
        onClick={onRemove}
        aria-label={`Remove ${link.label}`}
        title="Remove"
      >
        ✕
      </button>
    </div>
  );
}

export default AppTile;
