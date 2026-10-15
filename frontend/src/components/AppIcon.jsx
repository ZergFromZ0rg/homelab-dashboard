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

// `logo` is a better picture when the caller has one (see containerIcon.js);
// it is tried first, then the favicon, then the letter. The letter shows until
// an image has actually loaded, so a slow or unreachable host never leaves an
// empty box.
function AppIcon({ url, label, logo, className = "app-tile-icon" }) {
  const sources = [logo, faviconUrl(url)].filter(Boolean);
  // Keyed on the list so a new `logo` or `url` starts over from the first.
  return <Pictured key={sources.join("|")} sources={sources} label={label} className={className} />;
}

function Pictured({ sources, label, className }) {
  const [tried, setTried] = useState(0); // sources that already failed
  const [loaded, setLoaded] = useState(false);
  const icon = sources[tried];

  return (
    <span className={`${className} app-icon`}>
      {!loaded && (
        <span
          className="app-tile-letter"
          style={{ "--avatar": avatarColor(label) }}
          aria-hidden="true"
        >
          {(label || "?").charAt(0).toUpperCase()}
        </span>
      )}
      {icon && (
        <img
          key={icon}
          src={icon}
          alt=""
          className={loaded ? "" : "app-icon-pending"}
          onLoad={(e) =>
            // A 1×1 pixel or empty response is "no icon", not an icon.
            e.currentTarget.naturalWidth > 1 ? setLoaded(true) : setTried((n) => n + 1)
          }
          onError={() => setTried((n) => n + 1)}
        />
      )}
    </span>
  );
}

export default AppIcon;
