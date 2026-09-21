import { useState } from "react";
import AppTile from "./AppTile";
import Card from "./Card";
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

// A check's target is a URL for http checks and a bare host (or host:port)
// for tcp/ping/dns — both reduce to the hostname a link would point at.
function hostOf(target) {
  if (!target) return null;
  try {
    return new URL(target.includes("://") ? target : `http://${target}`)
      .hostname.toLowerCase();
  } catch {
    return null;
  }
}

// hostname -> worst status any check reports for it, so a tile shows "down"
// when any probe of that host is failing. Paused checks aren't watching
// anything right now, so they don't colour a tile at all.
const STATUS_RANK = { down: 0, pending: 1, up: 2 };

function watchedHosts(checks) {
  const out = {};
  for (const check of checks) {
    const host = hostOf(check.target);
    if (!host || check.paused || !(check.status in STATUS_RANK)) continue;
    const seen = out[host];
    if (seen == null || STATUS_RANK[check.status] < STATUS_RANK[seen]) {
      out[host] = check.status;
    }
  }
  return out;
}

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `l${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function LinksCard({ checks = [] }) {
  const { settings, update } = useSettings();
  const links = settings.links;
  const watched = watchedHosts(checks);
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
        <div className="app-tiles">
          {links.map((l) => (
            <AppTile
              key={l.id}
              link={l}
              status={watched[hostOf(l.url)]}
              onRemove={() => remove(l.id)}
            />
          ))}
        </div>
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
