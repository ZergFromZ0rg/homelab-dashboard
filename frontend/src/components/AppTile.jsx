import { useState } from "react";
import { avatarColor } from "./containerLink";

// A link rendered as an app tile: the service's own favicon, its name, and
// a status dot when one of the Services checks is already watching that
// host.
//
// The icon is the service's /favicon.ico — no icon pack, no per-link setup,
// and nothing to keep in sync. It's also the part most likely to fail (a
// service without one, or an http:// link on an https:// dashboard, which
// the browser blocks as mixed content), so a failed load falls back to the
// same lettered avatar the list used to show rather than a broken image.
function faviconUrl(href) {
  try {
    return new URL("/favicon.ico", href).href;
  } catch {
    return null;
  }
}

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
  const [broken, setBroken] = useState(false);
  const icon = broken ? null : faviconUrl(link.url);
  const letter = link.label.charAt(0).toUpperCase();

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
        <span className="app-tile-icon">
          {icon ? (
            <img
              src={icon}
              alt=""
              loading="lazy"
              onError={() => setBroken(true)}
            />
          ) : (
            <span
              className="app-tile-letter"
              style={{ background: avatarColor(link.label) }}
              aria-hidden="true"
            >
              {letter}
            </span>
          )}
        </span>
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
