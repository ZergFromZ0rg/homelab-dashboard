import { useState } from "react";
import CheckForm from "./CheckForm";
import CheckHistory from "./CheckHistory";
import Sparkline from "./Sparkline";
import AppIcon from "./AppIcon";
import { IconButton } from "./Icon";
import { deleteCheck, runCheck, updateCheck } from "./checksApi";
import { formatAge, formatDuration, formatLatency } from "./format";

const TYPE_LABEL = { http: "HTTP", keyword: "Keyword", ping: "Ping", tcp: "TCP", dns: "DNS" };

const STATUS_TONE = { up: "ok", down: "bad", paused: "none", pending: "none" };

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

function Uptime({ value }) {
  return (
    <span className={`check-cell-num check-uptime--${uptimeTone(value)}`}>
      {value == null ? "—" : `${value}%`}
    </span>
  );
}

// One service check as one table row (columns line up with CheckTableHead
// in ServicesTab): what it is, how it's answering now, the recent trend,
// uptime over 24h / 7d / 30d, and icon actions. Longer-range charts open
// underneath.
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
      <div className="check check--editing">
        <CheckForm
          check={check}
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            await updateCheck(check.id, values);
            setEditing(false);
          }}
        />
      </div>
    );
  }

  const { status } = check;
  const points = check.recent.filter((v) => v != null).map((v) => ({ v }));

  let headline;
  let sub;
  if (status === "down") {
    headline = "Down";
    sub = `${check.down_since ? `${formatDuration(now - check.down_since)} · ` : ""}${check.detail ?? ""}`;
  } else if (status === "paused") {
    headline = "Paused";
    sub = "";
  } else if (status === "pending") {
    headline = "Checking…";
    sub = "";
  } else {
    headline = formatLatency(check.latency_ms);
    sub = "";
  }

  const target =
    check.type === "keyword"
      ? `${check.target} · ${check.keyword_mode === "absent" ? "must not contain" : "must contain"} "${check.keyword}"`
      : check.target;

  return (
    <div className={`check-row check-row--${status} ${open ? "check-row--open" : ""}`}>
      <div className="check-line">
        <span className="check-cell-icon">
          <span className={`status-dot status-dot--${STATUS_TONE[status] || "none"}`} />
          <AppIcon url={check.target} label={check.name} className="app-tile-icon ov-icon" />
        </span>

        <span className="check-cell-name" title={target}>
          <span className="check-title">
            <strong>{check.name}</strong>
            <span className="chip">{TYPE_LABEL[check.type]}</span>
            {status === "up" && check.failing > 0 && (
              <span className="chip chip--warn" title={check.detail ?? undefined}>
                {check.failing} failed
              </span>
            )}
          </span>
        </span>

        <span
          className="check-cell-now"
          title={[
            check.detail,
            check.checked_at != null ? `checked ${checkedAgo(now - check.checked_at)}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined}
        >
          <strong className={`check-now check-now--${status}`}>{headline}</strong>
          {sub && <small>{sub}</small>}
        </span>

        <span className="check-cell-spark">
          <Sparkline points={points} variant="rx" height={26} />
        </span>

        <Uptime value={check.uptime_24h} />
        <Uptime value={check.uptime_7d} />
        <Uptime value={check.uptime_30d} />

        <span className="check-cell-actions">
          <IconButton
            icon="refresh"
            label="Check now"
            disabled={busy || check.paused}
            onClick={() => act(() => runCheck(check.id))}
          />
          <IconButton
            icon="chart"
            label={open ? "Hide history" : "Show history"}
            active={open}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          />
          <IconButton
            icon={check.paused ? "play" : "pause"}
            label={check.paused ? "Resume" : "Pause"}
            disabled={busy}
            onClick={() => act(() => updateCheck(check.id, { paused: !check.paused }))}
          />
          <IconButton icon="edit" label="Edit" disabled={busy} onClick={() => setEditing(true)} />
          <IconButton
            icon="trash"
            label="Delete"
            danger
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete the check "${check.name}" and its history?`)) {
                act(() => deleteCheck(check.id));
              }
            }}
          />
        </span>
      </div>

      {error && <p className="cred-error check-row-error">{error}</p>}
      {open && (
        <div className="check-row-detail">
          <CheckHistory check={check} />
        </div>
      )}
    </div>
  );
}

export default CheckCard;
