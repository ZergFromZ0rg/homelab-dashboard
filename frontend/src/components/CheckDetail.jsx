import { useState } from "react";
import AppIcon from "./AppIcon";
import CheckHistory from "./CheckHistory";
import { deleteCheck, runCheck, updateCheck } from "./checksApi";
import { describeCheck, TYPE_LABEL, uptimeTone } from "./checkStatus";
import { formatAge, formatLatency } from "./format";

// Second-level precision: on a monitoring page "just now" hides whether the
// last probe was 3s or 55s ago.
function checkedAgo(seconds) {
  const age = Math.max(0, seconds);
  return age < 60 ? `${Math.round(age)}s ago` : formatAge(age);
}

function Cell({ label, children, tone }) {
  return (
    <div className="up-d-cell">
      <dt>{label}</dt>
      <dd className={tone ? `check-uptime--${tone}` : undefined}>{children}</dd>
    </div>
  );
}

const pct = (v) => (v == null ? "—" : `${v}%`);

// One check in full: what it is, how it is answering, its actions, its figures,
// and its history for the range you pick. `onEdit` opens the form in this pane.
function CheckDetail({ check, now, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const act = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(/token/i.test(err.message) ? `${err.message} — enter it under "Add check".` : err.message);
    } finally {
      setBusy(false);
    }
  };

  const { headline, sub } = describeCheck(check, now);
  const target =
    check.type === "keyword"
      ? `${check.target} · ${check.keyword_mode === "absent" ? "must not contain" : "must contain"} "${check.keyword}"`
      : check.target;

  return (
    <div className="up-d">
      <header className="up-d-head">
        <div className="up-d-title">
          <AppIcon url={check.target} label={check.name} className="app-tile-icon ov-icon" />
          <h3>{check.name}</h3>
          <span className="chip">{TYPE_LABEL[check.type]}</span>
          {check.origin && (
            <span className="chip" title={`Checked from ${check.origin}'s agent, not from the dashboard`}>
              from {check.origin}
            </span>
          )}
        </div>
        <div className={`up-d-state up-d-state--${check.status}`}>
          <strong>{headline}</strong>
          {sub && <span>{sub}</span>}
        </div>
        <code className="up-d-target" title={target}>{target}</code>
        <div className="up-d-actions">
          <button type="button" className="btn btn--sm" disabled={busy || check.paused} onClick={() => act(() => runCheck(check.id))}>
            Check now
          </button>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act(() => updateCheck(check.id, { paused: !check.paused }))}>
            {check.paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete the check "${check.name}" and its history?`)) act(() => deleteCheck(check.id));
            }}
          >
            Delete
          </button>
        </div>
        {error && <p className="cred-error">{error}</p>}
      </header>

      <dl className="up-d-stats">
        <Cell label="Typical">{formatLatency(check.p50_ms_24h)}</Cell>
        <Cell label="Slowest (p95)">{formatLatency(check.p95_ms_24h)}</Cell>
        <Cell label="Checked">{check.checked_at != null ? checkedAgo(now - check.checked_at) : "—"}</Cell>
        <Cell label="Up · 24 h" tone={uptimeTone(check.uptime_24h)}>{pct(check.uptime_24h)}</Cell>
        <Cell label="Up · 7 d" tone={uptimeTone(check.uptime_7d)}>{pct(check.uptime_7d)}</Cell>
        <Cell label="Up · 30 d" tone={uptimeTone(check.uptime_30d)}>{pct(check.uptime_30d)}</Cell>
      </dl>

      <CheckHistory key={check.id} check={check} />
    </div>
  );
}

export default CheckDetail;
