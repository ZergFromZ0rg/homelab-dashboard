// The Overview's per-host tile: ring gauges for the numbers that decide
// whether a machine is healthy (CPU, RAM, fullest disk, GPU if it has one)
// and how many of its containers are up. Every tile is the same shape, so
// the servers read as one even row. A click opens the Servers tab.

import Gauge from "./Gauge";
import { diskLabel } from "./diskLabel";
import { hostColor } from "./hostColor";

function Ring({ label, value }) {
  return (
    <span className="host-ring">
      <Gauge value={value} size={58} strokeWidth={5} />
      <span className="host-ring-label" title={label}>
        {label}
      </span>
    </span>
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
              <span className="host-tile-name" style={{ color: hostColor(name) }}>
                {name}
              </span>
              <span className={`host-tile-state host-tile-state--${offline ? "bad" : "ok"}`}>
                <span className={`status-dot status-dot--${offline ? "bad" : "ok"}`} />
                {offline ? "offline" : "online"}
              </span>
            </span>

            <span className="host-tile-rings">
              <Ring label="CPU" value={offline ? null : m.cpu} />
              <Ring label="RAM" value={offline ? null : m.ram} />
              <Ring
                label={fullest ? diskLabel(fullest) : "Disk"}
                value={offline ? null : fullest?.used_percent}
              />
              {gpu != null && <Ring label="GPU" value={offline ? null : gpu} />}
            </span>

            <span className="host-tile-foot">
              <span>
                <strong>{running}</strong> / {conts.length} containers running
              </span>
              <span className="host-tile-go" aria-hidden="true">→</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default HostSummary;
