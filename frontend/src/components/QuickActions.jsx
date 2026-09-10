import { pinKey } from "./containerPins";
import { formatBytes } from "./format";

// One compact row per pinned container — status dot, name, CPU / RAM, and
// start-or-stop + restart. Plus jumps to the tabs where the rest lives.

function QaRow({ t, busy, onControl }) {
  const running = t.status === "running";
  const primary = running ? "Stop" : "Start";
  const cpu = t.stats?.cpu_percent;
  const ram = t.stats?.memory?.used_bytes;

  const act = (verb) => {
    if (window.confirm(`${verb} ${t.name} on ${t.host}?`)) {
      onControl.run(t.host, t.id, verb.toLowerCase());
    }
  };

  return (
    <div className="qa-row">
      <span className={`status-dot status-dot--${running ? "ok" : "bad"}`} />
      <span className="qa-name" title={`${t.name} · ${t.host}`}>
        {t.name}
      </span>
      <span className="qa-stat">{cpu != null ? `${cpu}%` : "—"}</span>
      <span className="qa-stat">{ram != null ? formatBytes(ram) : "—"}</span>
      <div className="qa-row-btns">
        <button
          type="button"
          className="qa-btn"
          disabled={busy}
          onClick={() => act(primary)}
        >
          {busy ? "…" : primary}
        </button>
        <button
          type="button"
          className="qa-btn"
          disabled={busy}
          onClick={() => act("Restart")}
        >
          Restart
        </button>
      </div>
    </div>
  );
}

function QuickActions({ pins, containers, onControl, onNavigate }) {
  const pinned = new Set(pins);
  const targets = [];
  for (const [host, list] of Object.entries(containers)) {
    for (const c of list) {
      if (pinned.has(pinKey(host, c.name))) targets.push({ host, ...c });
    }
  }
  targets.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="quick-actions">
      {targets.length === 0 ? (
        <p className="overview-empty">
          Pin a container (★ on its row in the Containers tab) for one-click
          control here.
        </p>
      ) : (
        <div className="qa-rows">
          {targets.map((t) => (
            <QaRow
              key={`${t.host}-${t.id}`}
              t={t}
              busy={Boolean(onControl.pending[`${t.host}-${t.id}`])}
              onControl={onControl}
            />
          ))}
        </div>
      )}

      <div className="qa-group qa-group--nav">
        <button type="button" className="qa-btn" onClick={() => onNavigate("deploy")}>
          Deploy →
        </button>
        <button
          type="button"
          className="qa-btn"
          onClick={() => onNavigate("containers")}
        >
          Containers →
        </button>
      </div>
    </div>
  );
}

export default QuickActions;
