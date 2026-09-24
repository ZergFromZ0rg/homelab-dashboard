// The Overview's servers panel: one line per host — name, status, a short
// bar each for CPU, RAM and the fullest disk, and containers running. Bars
// turn amber at 70% and red at 90% (the same levels the gauges use), so a
// busy machine stands out and a healthy one stays quiet. A click opens the
// Servers tab.

import { diskLabel } from "./diskLabel";
import { hostColor } from "./hostColor";

function level(pct) {
  if (pct == null) return "none";
  if (pct >= 90) return "crit";
  if (pct >= 70) return "warn";
  return "ok";
}

function Meter({ label, pct }) {
  const known = typeof pct === "number";
  return (
    <span className={`ov-meter ov-meter--${level(pct)}`} title={label}>
      <span className="ov-meter-label">{label}</span>
      <span className="ov-meter-bar">
        <span style={{ width: `${known ? Math.min(100, Math.max(0, pct)) : 0}%` }} />
      </span>
      <span className="ov-meter-pct">{known ? `${Math.round(pct)}%` : "—"}</span>
    </span>
  );
}

function HostSummary({ machines, containers, onOpen }) {
  const names = Object.keys(machines).sort();
  if (names.length === 0) {
    return <p className="overview-empty">No hosts reporting yet.</p>;
  }

  return (
    <div className="ov-hosts">
      {names.map((name) => {
        const m = machines[name];
        const conts = containers[name] || [];
        const running = conts.filter((c) => c.status === "running").length;
        const offline = !m.online;
        // The fullest disk is the one that will bite first.
        const fullest = [...(m.filesystems || [])].sort(
          (a, b) => (b.used_percent ?? 0) - (a.used_percent ?? 0)
        )[0];

        return (
          <button
            type="button"
            key={name}
            className={`ov-host ${offline ? "ov-host--off" : ""}`}
            onClick={() => onOpen?.(name)}
            title={`Open ${name} in Servers`}
          >
            <span className="ov-host-name">
              <span className={`status-dot status-dot--${offline ? "bad" : "ok"}`} />
              <span style={{ color: hostColor(name) }}>{name}</span>
            </span>

            {offline ? (
              <span className="ov-host-offline">offline</span>
            ) : (
              <>
                <Meter label="CPU" pct={m.cpu} />
                <Meter label="RAM" pct={m.ram} />
                <Meter
                  label={fullest ? diskLabel(fullest) : "Disk"}
                  pct={fullest?.used_percent}
                />
              </>
            )}

            <span className="ov-host-count">
              {running}/{conts.length}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default HostSummary;
