import { useState } from "react";
import { avatarColor } from "./containerLink";

// A service's own /favicon.ico, or a lettered avatar when there's no URL to
// ask or the icon fails to load (no favicon, or an http:// icon blocked as
// mixed content on an https:// dashboard). No icon pack, no per-app setup.
function faviconUrl(href) {
  if (!/^https?:\/\//i.test(href || "")) return null;
  try {
    return new URL("/favicon.ico", href).href;
  } catch {
    return null;
  }
}

// The letter shows until the icon has actually loaded, so a slow or
// unreachable host never leaves an empty box.
function AppIcon({ url, label, className = "app-tile-icon" }) {
  const [state, setState] = useState("loading");
  const icon = state === "broken" ? null : faviconUrl(url);

  return (
    <span className={`${className} app-icon`}>
      {state !== "ok" && (
        <span
          className="app-tile-letter"
          style={{ background: avatarColor(label) }}
          aria-hidden="true"
        >
          {(label || "?").charAt(0).toUpperCase()}
        </span>
      )}
      {icon && (
        <img
          src={icon}
          alt=""
          className={state === "ok" ? "" : "app-icon-pending"}
          onLoad={(e) =>
            // A 1×1 pixel or empty response is "no icon", not an icon.
            setState(e.currentTarget.naturalWidth > 1 ? "ok" : "broken")
          }
          onError={() => setState("broken")}
        />
      )}
    </span>
  );
}

export default AppIcon;
