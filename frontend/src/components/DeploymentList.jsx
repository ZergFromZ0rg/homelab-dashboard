// Live list of scheduler-managed deployments (from the /ws payload).

import { useState } from "react";
import { containerUrl } from "./containerLink";
import { redeploy, removeDeployment } from "./deployApi";

// spec ports ([{container, host, proto}]) -> the {"80/tcp": ["8080"]} shape
// containerUrl() expects.
function specPortsMap(ports) {
  const map = {};
  for (const p of ports ?? []) {
    map[`${p.container}/${p.proto ?? "tcp"}`] = [String(p.host)];
  }
  return map;
}

const STATUS_LABEL = {
  placing: "placing",
  running: "running",
  failed: "failed",
  node_offline: "node offline",
  stopped: "stopped",
};

const EVENT_MARK = {
  created: "+",
  deployed: "▸",
  moved: "→",
  recovered: "✓",
  failed: "✕",
  node_offline: "⚠",
};

function relativeTime(seconds) {
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function EventLog({ events }) {
  const [open, setOpen] = useState(false);
  if (!events?.length) return null;

  const shown = open ? events : events.slice(-2);

  return (
    <div className="deployment-events">
      {shown.map((e, i) => (
        <div key={i} className={`deployment-event ${e.automatic ? "auto" : ""}`}>
          <span className="deployment-event-mark">{EVENT_MARK[e.kind] ?? "·"}</span>
          <span className="deployment-event-detail">
            {e.automatic ? "auto: " : ""}
            {e.detail || e.kind}
          </span>
          <span className="deployment-event-time">{relativeTime(e.at)}</span>
        </div>
      ))}
      {events.length > 2 && (
        <button
          type="button"
          className="deployment-events-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "less" : `${events.length - 2} more`}
        </button>
      )}
    </div>
  );
}

function DeploymentCard({ record, onError }) {
  const [busy, setBusy] = useState(null);

  async function act(fn, label) {
    setBusy(label);
    onError(null);
    try {
      await fn();
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(null);
    }
  }

  const spec = record.spec;
  const isStack = record.kind === "stack";
  const title = isStack ? record.stack?.name : spec.name || spec.image;
  const url =
    !isStack && record.status === "running" && record.placed_on
      ? containerUrl(record.placed_on, specPortsMap(spec.ports))
      : null;

  return (
    <div className="deployment-card">
      <div className="deployment-head">
        <span className={`deployment-status deployment-status--${record.status}`}>
          {STATUS_LABEL[record.status] ?? record.status}
        </span>
        {isStack && <span className="deployment-kind">stack</span>}
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {title}
          </a>
        ) : (
          <strong>{title}</strong>
        )}
        {record.placed_on && <span className="deployment-node">on {record.placed_on}</span>}
        {record.score != null && (
          <span className="deployment-score">score {record.score.toFixed(0)}</span>
        )}
      </div>

      <div className="deployment-image">
        {isStack ? `${spec.resources?.memory_mb ?? "?"} MB · compose project` : spec.image}
      </div>
      {record.reason && <p className="deployment-reason">{record.reason}</p>}
      {record.error && <p className="deployment-error">{record.error}</p>}

      <EventLog events={record.events} />

      <div className="deployment-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => redeploy(record.id), "redeploy")}
        >
          {busy === "redeploy" ? "…" : "Redeploy elsewhere"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            act(() => removeDeployment(record.id), "remove")
          }
        >
          {busy === "remove" ? "…" : "Remove"}
        </button>
      </div>
    </div>
  );
}

function DeploymentList({ deployments }) {
  const [error, setError] = useState(null);
  const records = [...(deployments ?? [])].sort(
    (a, b) => b.created_at - a.created_at
  );

  return (
    <section className="deployment-list">
      <div className="section-header">
        <p className="eyebrow">Managed</p>
        <h2>Deployments ({records.length})</h2>
      </div>

      {error && <p className="placement-warning">⚠ {error}</p>}

      {records.length === 0 ? (
        <div className="empty-state">Nothing deployed through the scheduler yet.</div>
      ) : (
        records.map((record) => (
          <DeploymentCard key={record.id} record={record} onError={setError} />
        ))
      )}
    </section>
  );
}

export default DeploymentList;
