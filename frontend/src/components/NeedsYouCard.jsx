import { useEffect, useState } from "react";
import Card from "./Card";
import { useActionRuns } from "./actionRuns";

// Re-render every so often so "Installing… 4m" keeps moving.
function useNow(ms = 15000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function ago(seconds) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
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
function RunStatus({ run, now, onDismiss }) {
  const busy = run.state === "running" || run.state === "starting";
  const tone = busy ? "warn" : run.state === "done" ? "ok" : "bad";
  const label = busy
    ? `${run.state === "starting" ? "Starting" : RUNNING_LABEL[run.type] || "Running"}… ${ago(Math.max(0, now - run.startedAt) / 1000)}`
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

// Where the detail behind each kind of item lives: the host's Manage page for
// OS updates, the Containers tab for image updates.
function detailsTarget(item) {
  if (item.type === "os_upgrade" || item.type === "reboot") {
    return ["servers", { host: item.host, action: "os-updates" }];
  }
  if (item.type === "container_updates") return ["containers", { filter: "updates" }];
  return null;
}

// What needs you, in one short list: what's wrong first (a dot and an arrow to
// look at it), then what is waiting on a yes (a button). Everything else —
// the feed of what happened, the full attention list — is in God.
function NeedsYouCard({ overview, alerts, summary, machines, ready, onNavigate }) {
  const now = useNow();
  const { runs, start, dismiss } = useActionRuns(machines);

  const firing = alerts.filter((a) => a.resolved_at == null);
  const problems = [
    ...overview.issues.map((i) => ({ key: i.key, tone: i.severity, text: i.title, title: i.message })),
    ...firing
      .filter((a) => !overview.issues.some((i) => i.key === a.key))
      .map((a) => ({ key: `alert-${a.key}-${a.at}`, tone: a.severity || "bad", text: a.title, title: a.message })),
  ];

  // Actions you've clicked stay listed (with their status) after the next
  // tick drops them from "needs a yes".
  const waiting = summary?.needs_action || [];
  const shown = new Set(waiting.map((a) => a.id));
  const acted = Object.values(runs)
    .filter((r) => !shown.has(r.id))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r) => ({ id: r.id, title: r.title }));
  const actions = [...waiting, ...acted];

  const total = problems.length + actions.length;
  const clear = ready && total === 0;

  const run = (item) => {
    if (item.action.confirm && !window.confirm(item.action.confirm)) return;
    start(item);
  };

  return (
    <Card title="Needs you" count={clear || !ready ? null : total} className="sh-need sh-fill">
      {!ready ? (
        <p className="sh-empty">Waiting for the first update…</p>
      ) : clear ? (
        <p className="sh-clear">
          <span className="status-dot status-dot--ok" />
          All clear
        </p>
      ) : (
        <ul className="ny-list">
          {problems.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                className={`ny-row ny-row--${p.tone}`}
                title={p.title}
                onClick={() => onNavigate(p.key.startsWith("check:") ? "network" : "containers")}
              >
                <span className={`status-dot status-dot--${p.tone}`} />
                <span className="ny-text">{p.text}</span>
                <span className="ov-go" aria-hidden="true">→</span>
              </button>
            </li>
          ))}
          {actions.map((item) => {
            const target = detailsTarget(item);
            const tip = item.subtitle ? `${item.title} — ${item.subtitle}` : item.title;
            return (
              <li key={item.id} className="ny-row ny-row--action">
                <span className="status-dot status-dot--none" />
                {target ? (
                  <button type="button" className="ny-text ny-link" title={tip} onClick={() => onNavigate(...target)}>
                    {item.title}
                  </button>
                ) : (
                  <span className="ny-text" title={tip}>
                    {item.title}
                  </span>
                )}
                {runs[item.id] ? (
                  <RunStatus run={runs[item.id]} now={now} onDismiss={() => dismiss(item.id)} />
                ) : (
                  <button type="button" className="btn btn--sm btn--primary" onClick={() => run(item)}>
                    {item.button_label}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export default NeedsYouCard;
