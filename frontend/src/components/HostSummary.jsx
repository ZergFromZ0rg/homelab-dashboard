// Per-host health as compact bar rows. The full gauges + sparklines +
// storage breakdown stay on the System Stats tab.

function Bar({ label, pct }) {
  const known = typeof pct === "number";
  const hot = known && pct >= 85;
  return (
    <div className="host-bar">
      <span className="host-bar-label">{label}</span>
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

function diskPct(machine) {
  const fs = machine.filesystems || [];
  if (fs.length === 0) return null;
  return Math.max(...fs.map((f) => f.used_percent ?? 0));
}

function HostSummary({ machines, containers }) {
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

        return (
          <div key={name} className={`host-row ${offline ? "host-row--off" : ""}`}>
            <div className="host-row-head">
              <span
                className={`status-dot status-dot--${offline ? "bad" : "ok"}`}
              />
              <span className="host-row-name">{name}</span>
              <span className="host-row-count">
                {offline ? "offline" : `${running} running`}
              </span>
            </div>

            {!offline && (
              <div className="host-row-bars">
                <Bar label="CPU" pct={m.cpu} />
                <Bar label="RAM" pct={m.ram} />
                <Bar label="DISK" pct={diskPct(m)} />
                {gpu != null && <Bar label="GPU" pct={gpu} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default HostSummary;
