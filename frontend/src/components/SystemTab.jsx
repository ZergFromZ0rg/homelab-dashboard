import { HostSystemPanels } from "./HostSystem";
import HostSettings from "./HostSettings";
import HostRecovery from "./HostRecovery";
import HostShellButton from "./HostShellButton";
import { formatBytes, formatDaysUntilFull } from "./format";
import { formatUptime, gpuDevices } from "./machineInfo";
import { diskLabel } from "./diskLabel";
import { hostColor } from "./hostColor";
import { useLocalStorage } from "./useLocalStorage";

function Fact({ label, value, title }) {
  if (value == null || value === "") return null;
  return (
    <span className="stat-item" title={title}>
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

// God mode: one machine at a time, everything open — the hardware, its
// disks, systemd services, the journal, OS updates, power, the agent's
// settings and what you'd lose if it died. The server cards on Overview
// keep the same controls folded away.
function SystemTab({ machines, connected }) {
  const hosts = Object.keys(machines).sort();
  const [picked, setPicked] = useLocalStorage("systemHost", null);
  const host = hosts.includes(picked) ? picked : hosts[0];

  if (!host) {
    return <div className="empty-state">{connected === false ? "Connecting…" : "No servers reporting yet."}</div>;
  }

  const m = machines[host];
  const d = m.details || {};
  const gpus = gpuDevices(m);
  const disks = [...(m.filesystems || [])].sort((a, b) => (b.used_percent ?? 0) - (a.used_percent ?? 0));
  const threads = m.cpu_cores;
  const cores = m.cpu_physical_cores;

  return (
    <section className="system-tab" style={{ "--host-color": hostColor(host) }}>
      <div className="system-bar">
        <div className="net-hosts" role="tablist" aria-label="Server">
          {hosts.map((h) => (
            <button
              key={h}
              type="button"
              role="tab"
              aria-selected={h === host}
              className={`net-host-tab ${h === host ? "active" : ""}`}
              style={{ "--host-color": hostColor(h) }}
              onClick={() => setPicked(h)}
            >
              <span className={`status-dot status-dot--${machines[h].online ? "ok" : "bad"}`} />
              {h}
            </button>
          ))}
        </div>
        <HostShellButton host={host} />
      </div>

      <div className="stat-strip">
        <Fact label="OS" value={d.os} />
        <Fact label="Kernel" value={d.kernel} />
        <Fact label="Arch" value={d.arch} />
        <Fact label="CPU" value={m.cpu_model} />
        <Fact label="Cores" value={threads ? (cores ? `${cores}c / ${threads}t` : `${threads}t`) : null} />
        <Fact label="RAM" value={m.ram_total_bytes != null ? formatBytes(m.ram_total_bytes) : null} />
        <Fact label="GPU" value={gpus.map((g) => g.name).filter(Boolean).join(", ") || null} />
        <Fact label="Up" value={m.online ? formatUptime(m.uptime) : "offline"} />
        <Fact label="Agent" value={m.agent_version?.source?.short || m.agent_version?.state} title={`Agent ${m.agent_version?.state || "version unknown"}`} />
      </div>

      {!m.terminal && (
        <p className="settings-hint system-off">
          Host control is off on {host}'s agent — set <code>TERMINAL_ENABLED=1</code> in its{" "}
          <code>.env</code> to manage services, updates and power from here.
        </p>
      )}

      <div className="system-grid">
        <div className="overview-card system-col">
          <div className="overview-card-head"><h2>Machine</h2></div>
          <div className="overview-card-body">
            {m.terminal ? <HostSystemPanels host={host} machine={m} /> : <p className="mb-empty">Not available.</p>}
          </div>
        </div>

        <div className="system-col">
          <div className="overview-card">
            <div className="overview-card-head">
              <h2>Disks</h2>
              <span className="overview-card-count">{disks.length}</span>
            </div>
            <table className="net-table">
              <thead>
                <tr><th>Disk</th><th>Mount</th><th>Size</th><th>Used</th><th>Full in</th></tr>
              </thead>
              <tbody>
                {disks.map((fs) => (
                  <tr key={`${fs.device}-${fs.mountpoint}`} title={fs.device}>
                    <td>{diskLabel(fs)}</td>
                    <td className="net-mono net-dim">{fs.mountpoint}</td>
                    <td className="net-mono">{fs.total_bytes != null ? formatBytes(fs.total_bytes) : "—"}</td>
                    <td className={`net-mono ${fs.used_percent >= 90 ? "system-bad" : fs.used_percent >= 70 ? "system-warn" : ""}`}>
                      {fs.used_percent != null ? `${Math.round(fs.used_percent)}%` : "—"}
                    </td>
                    <td className="net-mono net-dim">
                      {fs.days_until_full != null ? formatDaysUntilFull(fs.days_until_full) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overview-card system-panels">
            <HostSettings key={`s-${host}`} host={host} defaultOpen />
            <HostRecovery key={`r-${host}`} host={host} defaultOpen />
          </div>
        </div>
      </div>
    </section>
  );
}

export default SystemTab;
