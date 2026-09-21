import { useState } from "react";
import CheckForm from "./CheckForm";
import CheckHistory from "./CheckHistory";
import Sparkline from "./Sparkline";
import { deleteCheck, runCheck, updateCheck } from "./checksApi";
import { formatAge, formatDuration, formatLatency } from "./format";

const TYPE_LABEL = { http: "HTTP", keyword: "KEYWORD", ping: "PING", tcp: "TCP", dns: "DNS" };

// Second-level precision: on a monitoring page "just now" hides whether the
// last probe was 3s or 55s ago.
function checkedAgo(seconds) {
  const age = Math.max(0, seconds);
  return age < 60 ? `${Math.round(age)}s ago` : formatAge(age);
}

function uptimeTone(value) {
  if (value == null) return "none";
  if (value >= 99.5) return "ok";
  if (value >= 95) return "warn";
  return "bad";
}

function Uptime({ label, value }) {
  return (
    <div className="check-uptime">
      <span>{label}</span>
      <strong className={`check-uptime--${uptimeTone(value)}`}>
        {value == null ? "—" : `${value}%`}
      </strong>
    </div>
  );
}

// One service check: its state and latency now, a sparkline, uptime over
// 24h / 7d / 30d, and (behind the chevron) charts for longer ranges.
function CheckCard({ check, now }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
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

  if (editing) {
    return (
      <article className="check check--editing">
        <CheckForm
          check={check}
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            await updateCheck(check.id, values);
            setEditing(false);
          }}
        />
      </article>
    );
  }

  const { status } = check;
  const points = check.recent.filter((v) => v != null).map((v) => ({ v }));

  let headline;
  let sub;
  if (status === "down") {
    headline = "Down";
    sub = `${check.down_since ? `for ${formatDuration(now - check.down_since)} · ` : ""}${check.detail ?? ""}`;
  } else if (status === "paused") {
    headline = "Paused";
    sub = "Not being checked";
  } else if (status === "pending") {
    headline = "Checking…";
    sub = "Waiting for the first result";
  } else {
    headline = formatLatency(check.latency_ms);
    sub = check.detail ?? "";
  }

  return (
    <article className={`check check--${status} ${open ? "check--open" : ""}`}>
      <div className="check-head">
        <span className={`status-dot status-dot--${status === "up" ? "ok" : status === "down" ? "bad" : "none"}`} />
        <div className="check-title">
          <strong>{check.name}</strong>
          <span className="chip">{TYPE_LABEL[check.type]}</span>
          {status === "up" && check.failing > 0 && (
            <span className="chip chip--warn" title={check.detail ?? undefined}>
              {check.failing} failed
            </span>
          )}
        </div>
        {check.type === "http" || check.type === "keyword" ? (
          <a
            className="check-target"
            href={check.target}
            target="_blank"
            rel="noopener noreferrer"
            title="Open"
          >
            {check.target}
          </a>
        ) : (
          <span className="check-target">{check.target}</span>
        )}
      </div>

      {check.type === "keyword" && (
        <div className="check-keyword-line">
          {check.keyword_mode === "absent" ? "Fails if the page contains" : "Page must contain"}{" "}
          <q>{check.keyword}</q>
        </div>
      )}

      <div className="check-main">
        <div>
          <div className={`check-headline check-headline--${status}`}>{headline}</div>
          <div className="check-sub" title={sub}>
            {sub}
            {check.checked_at != null && status !== "paused" && (
              <span> · {checkedAgo(now - check.checked_at)}</span>
            )}
          </div>
        </div>
        <div className="check-spark">
          <Sparkline points={points} variant="rx" height={34} />
        </div>
      </div>

      <div className="check-uptimes">
        <Uptime label="24 h" value={check.uptime_24h} />
        <Uptime label="7 d" value={check.uptime_7d} />
        <Uptime label="30 d" value={check.uptime_30d} />
        <div className="check-uptime">
          <span>Avg</span>
          <strong>{formatLatency(check.avg_ms_24h)}</strong>
        </div>
      </div>

      {error && <p className="cred-error">{error}</p>}

      <div className="check-actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy || check.paused}
          onClick={() => act(() => runCheck(check.id))}
        >
          Check now
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy}
          onClick={() => act(() => updateCheck(check.id, { paused: !check.paused }))}
        >
          {check.paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete the check "${check.name}" and its history?`)) {
              act(() => deleteCheck(check.id));
            }
          }}
        >
          Delete
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost check-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "Hide history" : "Show history"}
        >
          History <span className="crow-chevron">▾</span>
        </button>
      </div>

      {open && <CheckHistory check={check} />}
    </article>
  );
}

export default CheckCard;
