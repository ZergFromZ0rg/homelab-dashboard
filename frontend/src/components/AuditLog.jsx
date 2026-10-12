import { useCallback, useEffect, useState } from "react";
import { jsonOrThrow } from "./apiAuth";
import { hostColor } from "./hostColor";

// Settings → History. Two records, newest first, each with its own
// retention: Actions (who did what — the audit log, a year by default) and
// Events (what happened to the fleet — 30 days by default; the Overview
// timeline shows the latest). One line each; details in the tooltip.

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

const DAYS = (d) => (d === 0 ? "forever" : d >= 365 ? `${d / 365} year${d > 365 ? "s" : ""}` : `${d} days`);

function Retention() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    fetch("/api/history/settings").then(jsonOrThrow).then(setCfg).catch(() => {});
  }, []);
  if (!cfg) return null;
  const save = (key, value) =>
    fetch("/api/history/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: Number(value) }),
    })
      .then(jsonOrThrow)
      .then(setCfg)
      .catch(() => {});
  return (
    <div className="audit-retention">
      {[
        ["audit_days", "Keep actions"],
        ["activity_days", "Keep events"],
      ].map(([key, label]) => (
        <label key={key}>
          {label}
          <select value={cfg[key]} onChange={(e) => save(key, e.target.value)}>
            {cfg.choices[key].map((d) => (
              <option key={d} value={d}>{DAYS(d)}</option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

function AuditLog() {
  const [mode, setMode] = useState("actions");
  const [entries, setEntries] = useState(null);
  const [q, setQ] = useState("");
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback((query, before) => {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (query) params.set("q", query);
    if (before) params.set("before", String(before));
    const url = mode === "actions" ? `/api/audit?${params}` : `/api/activity?${params}`;
    return fetch(url)
      .then(jsonOrThrow)
      .then((body) => {
        const rows = mode === "actions"
          ? body.entries
          : body.activity.map((e) => ({ at: e.at, who: e.kind.replace(/_/g, " "), action: e.text, host: e.host, ok: !/down|fail|unhealthy|rolled/.test(e.kind) }));
        setMore(rows.length === PAGE);
        return rows;
      })
      .catch((e) => {
        setError(e.message);
        return [];
      });
  }, [mode]);

  useEffect(() => {
    const timer = setTimeout(() => load(q).then(setEntries), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [q, load]);

  const older = () =>
    load(q, entries.at(-1)?.at).then((next) => setEntries((cur) => [...cur, ...next]));

  return (
    <div className="audit">
      <div className="audit-top">
        <div className="segmented" role="group" aria-label="Which history">
          {[
            ["actions", "Actions"],
            ["events", "Events"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "active" : ""}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                setEntries(null);
              }}
              title={value === "actions" ? "Who did what: changes, sensitive reads, sign-ins, automatic actions" : "What happened to the fleet: containers, hosts, deployments"}
            >
              {label}
            </button>
          ))}
        </div>
        <Retention />
      </div>
      <input
        className="deploy-input"
        type="search"
        placeholder={mode === "actions" ? "Filter — a host, a person, a path, “shell”…" : "Filter — a container, a host, “restart”…"}
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
