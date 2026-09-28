import { useCallback, useEffect, useState } from "react";
import { jsonOrThrow } from "./apiAuth";
import { hostColor } from "./hostColor";

// Settings → Audit log: who did what, newest first, kept for months (the
// Overview timeline only holds hours). One line each; what it named, from
// where and how it went are in the row's tooltip.

const PAGE = 100;

function when(ts) {
  const d = new Date(ts * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function summary(target) {
  if (!target) return "";
  return Object.entries(target)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join(" · ");
}

function AuditLog() {
  const [entries, setEntries] = useState(null);
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback((query, before) => {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (query) params.set("q", query);
    if (before) params.set("before", String(before));
    return fetch(`/api/audit?${params}`)
      .then(jsonOrThrow)
      .then((body) => {
        setMore(body.entries.length === PAGE);
        return body.entries;
      })
      .catch((e) => {
        setError(e.message);
        return [];
      });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => load(q).then(setEntries), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [q, load]);

  const older = () =>
    load(q, entries.at(-1)?.at).then((next) => setEntries((cur) => [...cur, ...next]));

  return (
    <div className="audit">
      <input
        className="deploy-input"
        type="search"
        placeholder="Filter — a host, a person, a path, “shell”…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <p className="cred-error">{error}</p>}
      {entries?.length === 0 && <p className="audit-empty">Nothing recorded{q ? " matches" : " yet"}.</p>}
      <ul className="audit-list">
        {entries?.map((e, i) => (
          <li
            key={`${e.at}-${i}`}
            className={e.ok ? "" : "audit-bad"}
            title={[summary(e.target), e.detail, e.ip && `from ${e.ip}`, e.status && `HTTP ${e.status}`, e.ms != null && `${e.ms} ms`]
              .filter(Boolean)
              .join("\n")}
          >
            <span className="audit-when">{when(e.at)}</span>
            <span className="audit-who">{e.who}</span>
            <span className="audit-action">
              {e.action}
              {e.target?.path && <span className="audit-dim"> {e.target.path}</span>}
              {e.target?.container && <span className="audit-dim"> {e.target.container}</span>}
            </span>
            {e.host && (
              <span className="audit-host" style={{ color: hostColor(e.host) }}>{e.host}</span>
            )}
          </li>
        ))}
      </ul>
      {more && (
        <button type="button" className="btn btn--sm" onClick={older}>
          Older
        </button>
      )}
    </div>
  );
}

export default AuditLog;
