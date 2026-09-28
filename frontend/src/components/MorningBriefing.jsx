import { useActionRuns } from "./actionRuns";

function _ago(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function OvernightList({ overnight }) {
  if (!overnight || overnight.events_count === 0) {
    return <p className="mb-empty">Quiet night. No significant events.</p>;
  }
  return (
    <ul className="mb-list mb-list--overnight">
      {overnight.highlights.map((ev, i) => (
        <li key={i} className={`mb-item mb-item--${ev.tone}`}>
          <span className={`status-dot status-dot--${ev.tone}`} />
          <span className="mb-text">{ev.text}</span>
          <span className="mb-time">{_ago(Date.now() / 1000 - ev.at)}</span>
        </li>
      ))}
      {overnight.events_count > overnight.highlights.length && (
        <li className="mb-more">+{overnight.events_count - overnight.highlights.length} more events</li>
      )}
    </ul>
  );
}

function DegradingList({ degrading, onNavigate }) {
  if (!degrading || degrading.length === 0) {
    return <p className="mb-empty">All systems nominal. No degrading signals.</p>;
  }
  return (
    <ul className="mb-list mb-list--degrading">
      {degrading.map(item => (
        <li key={item.key} className={`mb-card mb-card--${item.severity}`}>
          <strong>{item.title}</strong>
          <span className="mb-detail">{item.detail}</span>
          {item.host && <button className="btn btn--sm mb-jump" onClick={() => onNavigate("servers", { host: item.host })}>View host</button>}
        </li>
      ))}
    </ul>
  );
}

const RUNNING_LABEL = {
  os_upgrade: "Installing",
  container_updates: "Updating",
  reboot: "Rebooting",
  rebalance: "Moving",
};

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Stands in for the button once it's clicked: what's happening now, or how
// it ended and when. Details (apt output, per-project results) in the tooltip.
function RunStatus({ run, onDismiss }) {
  const busy = run.state === "running" || run.state === "starting";
  const tone = busy ? "warn" : run.state === "done" ? "ok" : "bad";
  const label = busy
    ? `${run.state === "starting" ? "Starting" : RUNNING_LABEL[run.type] || "Running"}… ${_ago((Date.now() - run.startedAt) / 1000)}`
    : `${run.note} · ${clock(run.endedAt)}`;
  const title = [`Started ${clock(run.startedAt)}`, run.detail].filter(Boolean).join("\n");
  return (
    <span className={`mb-run mb-run--${tone}`} title={title} role="status">
      <span className={`status-dot status-dot--${tone}${busy ? " mb-run-pulse" : ""}`} />
      <span className="mb-run-label">{label}</span>
      {!busy && (
        <button type="button" className="mb-run-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </span>
  );
}

function ActionQueue({ actions, machines }) {
  const { runs, start, dismiss } = useActionRuns(machines);

  // Items you've acted on stay listed (with their status) after the next
  // tick drops them from "needs a yes".
  const listed = actions || [];
  const shown = new Set(listed.map((a) => a.id));
  const acted = Object.values(runs)
    .filter((r) => !shown.has(r.id))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r) => ({ id: r.id, title: r.title }));
  const items = [...listed, ...acted];

  if (items.length === 0) {
    return <p className="mb-empty">You're all caught up! No approvals needed.</p>;
  }

  const run = (item) => {
    if (item.action.confirm && !window.confirm(item.action.confirm)) return;
    start(item);
  };

  return (
    <ul className="mb-list mb-list--actions">
      {items.map((item) => (
        <li key={item.id} className="mb-action-card">
          <div className="mb-action-info">
            <strong>{item.title}</strong>
            {item.subtitle && <span>{item.subtitle}</span>}
          </div>
          {runs[item.id] ? (
            <RunStatus run={runs[item.id]} onDismiss={() => dismiss(item.id)} />
          ) : (
            <button className="btn btn--primary" onClick={() => run(item)}>
              {item.button_label}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function MorningBriefing({ summary, machines, onNavigate }) {
  if (!summary) return null;

  return (
    <div className="morning-briefing">
      <div className="mb-header">
        <h2>Morning Briefing</h2>
      </div>
      <div className="mb-columns">
        <section className="mb-column">
          <h3>What happened overnight</h3>
          <OvernightList overnight={summary.overnight} />
        </section>
        
        <section className="mb-column">
          <h3>What's degrading</h3>
          <DegradingList degrading={summary.degrading} onNavigate={onNavigate} />
        </section>

        <section className="mb-column">
          <h3>What needs a yes</h3>
          <ActionQueue actions={summary.needs_action} machines={machines} />
        </section>
      </div>
    </div>
  );
}

export default MorningBriefing;
