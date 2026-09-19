import { useState } from "react";
import Card from "./Card";
import { avatarColor } from "./containerLink";
import { useSettings } from "./settings";

// A bare address gets a scheme: http:// for the kind of thing a homelab
// serves without TLS (an IP, localhost, a single-label name, *.local/.lan/
// .home/.internal), https:// otherwise. "javascript:alert(1)" therefore
// becomes "https://javascript:alert(1)", which isn't a valid URL, and an
// explicit ftp:// / file:// is refused — only http(s) links are kept.
function withScheme(raw) {
  if (raw.includes("://")) return raw;
  const host = raw.split(/[/:?#]/)[0];
  const local =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    !host.includes(".") ||
    /\.(local|lan|home|internal)$/i.test(host);
  return `${local ? "http" : "https"}://${raw}`;
}

function normalizeUrl(input) {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(withScheme(raw));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `l${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function LinksCard() {
  const { settings, update } = useSettings();
  const links = settings.links;
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  const reset = () => {
    setAdding(false);
    setLabel("");
    setUrl("");
    setError("");
  };

  const add = () => {
    const href = normalizeUrl(url);
    if (!href) {
      setError("Enter a web address (http or https).");
      return;
    }
    const name = label.trim() || new URL(href).hostname.replace(/^www\./, "");
    update({ links: [...links, { id: newId(), label: name, url: href }] });
    reset();
  };

  const remove = (id) => update({ links: links.filter((l) => l.id !== id) });

  return (
    <Card
      title="Quick links"
      count={links.length || null}
      actions={
        !adding && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(true)}>
            + Add
          </button>
        )
      }
    >
      {links.length === 0 && !adding && (
        <p className="overview-empty">
          Your bookmarks — routers, dashboards, anything you open every day.
        </p>
      )}

      {links.length > 0 && (
        <ul className="links-list">
          {links.map((l) => (
            <li key={l.id} className="link-item">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="link-main">
                <span className="link-avatar" style={{ background: avatarColor(l.label) }} aria-hidden="true">
                  {l.label.charAt(0).toUpperCase()}
                </span>
                <span className="link-text">
                  <strong>{l.label}</strong>
                  <small>{new URL(l.url).host}</small>
                </span>
              </a>
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                onClick={() => remove(l.id)}
                aria-label={`Remove ${l.label}`}
                title="Remove"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <form
          className="links-form"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            className="deploy-input"
            placeholder="Name (optional)"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className="deploy-input"
            placeholder="Address, e.g. 192.168.1.1 or router.local"
            value={url}
            autoFocus
            onChange={(e) => {
              setUrl(e.target.value);
              setError("");
            }}
          />
          {error && <p className="cred-error">{error}</p>}
          <div className="links-form-actions">
            <button type="submit" className="btn btn--sm">Add link</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}
    </Card>
  );
}

export default LinksCard;
