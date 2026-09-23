// Compact per-host health for the Overview: a tile per machine with its
// headline bars. Each tile jumps to the Servers tab for the full card.

import { diskLabel } from "./diskLabel";
import { hostColor } from "./hostColor";

function Bar({ label, pct }) {
  const known = typeof pct === "number";
  const hot = known && pct >= 85;
  return (
    <div className="host-bar">
      <span className="host-bar-label" title={label}>
        {label}
      </span>
      <div className="mini-bar">
        <div
          className={`mini-bar-fill ${hot ? "mini-bar-fill--hot" : "mini-bar-fill--cpu"}`}
          style={{ width: `${known ? Math.min(100, Math.max(0, pct)) : 0}%` }}
        />
      </div>
      <span className="host-bar-pct">{known ? `${Math.round(pct)}%` : "—"}</span>
    </div>
  );
}

function HostSummary({ machines, containers, onOpen }) {
  const names = Object.keys(machines).sort();
  if (names.length === 0) {
    return <p className="overview-empty">No hosts reporting yet.</p>;
  }

  return (
    <div className="host-summary">
      {names.map((name) => {
        const m = machines[name];
        const conts = containers[name] || [];
        const running = conts.filter((c) => c.status === "running").length;
        const gpu = m.gpu?.devices?.[0]?.utilization_percent;
        const offline = !m.online;
        // The fullest disk is the one that will bite first.
        const fullest = [...(m.filesystems || [])].sort(
          (a, b) => (b.used_percent ?? 0) - (a.used_percent ?? 0)
        )[0];

        return (
          <button
            type="button"
            key={name}
            className={`host-tile ${offline ? "host-tile--off" : ""}`}
            onClick={() => onOpen?.(name)}
            title={`Open ${name} in Servers`}
            style={{ "--host-color": hostColor(name) }}
          >
            <span className="host-tile-head">
              <span className={`status-dot status-dot--${offline ? "bad" : "ok"}`} />
              <span className="host-tile-name" style={{ color: hostColor(name) }}>
                {name}
              </span>
              <span className="host-tile-count">
                {offline ? "offline" : `${running}/${conts.length} running`}
              </span>
            </span>

            {!offline && (
              <span className="host-tile-bars">
                <Bar label="CPU" pct={m.cpu} />
                <Bar label="RAM" pct={m.ram} />
                {fullest && <Bar label={diskLabel(fullest)} pct={fullest.used_percent} />}
                {gpu != null && <Bar label="GPU" pct={gpu} />}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default HostSummary;
