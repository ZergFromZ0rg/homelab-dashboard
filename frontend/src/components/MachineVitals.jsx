import Sparkline from "./Sparkline";
import Gauge from "./Gauge";

// Reference ceiling for the CPU temperature gauge ring — not a real limit,
// just a "how close to uncomfortably hot" scale so the ring fills
// proportionally instead of needing its own 0-100 metric.
const CPU_TEMP_GAUGE_MAX = 90;

function formatUptime(seconds) {
  if (seconds == null) return "—";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);

  return `${days}d ${hours}h`;
}

function formatBytes(bytes) {
  if (bytes == null) return "—";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond == null) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function diskName(filesystem) {
  if (filesystem.mountpoint === "/mnt/cooldrive") {
    return "Cooldrive";
  }

  if (filesystem.mountpoint === "/") {
    return "System";
  }

  return filesystem.mountpoint;
}

function MachineVitals({ machine, history }) {
  const netMax = Math.max(
    1,
    ...(history?.network_rx || []).map((p) => p.v ?? 0),
    ...(history?.network_tx || []).map((p) => p.v ?? 0)
  ) * 1.15;

  return (
    <>
      {machine.cpu_model && (
        <div className="cpu-model" title={machine.cpu_model}>
          {machine.cpu_model}
        </div>
      )}

      <div className="gauge-row">
        <div className="gauge-stat">
          <Gauge value={machine.cpu} size={48} strokeWidth={5} />
          <div className="gauge-stat-info">
            <span>
              CPU
              {machine.cpu_physical_cores != null &&
              machine.cpu_cores != null &&
              machine.cpu_physical_cores !== machine.cpu_cores
                ? ` · ${machine.cpu_physical_cores}c/${machine.cpu_cores}t`
                : machine.cpu_cores != null
                ? ` · ${machine.cpu_cores}t`
                : ""}
            </span>
            <Sparkline
              points={history?.cpu}
              max={100}
              variant="cpu"
              height={30}
              showAxis
            />
          </div>
        </div>

        <div className="gauge-stat">
          <Gauge
            value={
              machine.temperature != null
                ? (machine.temperature / CPU_TEMP_GAUGE_MAX) * 100
                : null
            }
            label={machine.temperature != null ? `${machine.temperature}°` : "—"}
            size={48}
            strokeWidth={5}
          />
          <div className="gauge-stat-info">
            <span>CPU TEMP</span>
            <Sparkline
              points={history?.temperature}
              variant="cpu"
              height={30}
              showAxis
            />
          </div>
        </div>

        <div className="gauge-stat">
          <Gauge value={machine.ram} size={48} strokeWidth={5} />
          <div className="gauge-stat-info">
            <span>
              RAM
              {machine.ram_total_bytes != null
                ? ` · ${formatBytes(machine.ram_total_bytes)}`
                : ""}
            </span>
            <Sparkline
              points={history?.ram}
              max={100}
              variant="ram"
              height={30}
              showAxis
            />
          </div>
        </div>

        <div className="compact-stats">
          <span>
            LOAD <strong>{machine.load1 ?? "—"}</strong>
          </span>
          <span>
            UPTIME <strong>{formatUptime(machine.uptime)}</strong>
          </span>
        </div>
      </div>

      <div className="network-stats">
        <div>
          <span>DOWNLOAD</span>
          <strong>↓ {formatSpeed(machine.network_rx)}</strong>
          <Sparkline points={history?.network_rx} max={netMax} variant="rx" />
        </div>

        <div>
          <span>UPLOAD</span>
          <strong>↑ {formatSpeed(machine.network_tx)}</strong>
          <Sparkline points={history?.network_tx} max={netMax} variant="tx" />
        </div>
      </div>

      {machine.gpu?.available !== false &&
        (machine.gpu?.devices?.[0] || machine.gpu) &&
        (() => {
          const gpu = machine.gpu.devices?.[0] || machine.gpu;

          // Agents that can't reach NVML report a name like
          // "NVIDIA GPU 10DE:2187" — split the trailing PCI id onto its
          // own muted line instead of letting it wrap mid-name.
          const pciMatch = (gpu.name || "").match(
            /^(.*?)[\s(]*([0-9a-f]{4}:[0-9a-f]{4})\)?$/i
          );
          const gpuName = (pciMatch?.[1] || gpu.name || "Detected GPU").trim();
          const pciId = pciMatch?.[2];

          return (
            <div className="gpu-stats">
              <div>
                <span>GPU{machine.agent_stale_age != null ? " · stale" : ""}</span>
                <strong>{gpuName}</strong>
                {pciId && <small>{pciId.toUpperCase()}</small>}
                {gpu.vendor && <small>{gpu.vendor.toUpperCase()}</small>}
              </div>

              {gpu.utilization_percent != null && (
                <div>
                  <span>UTILIZATION</span>
                  <strong>{gpu.utilization_percent}%</strong>
                </div>
              )}

              {(gpu.memory_used_mb != null || gpu.memory_total_mb != null) && (
                <div>
                  <span>VRAM</span>
                  <strong>
                    {gpu.memory_used_mb ?? "—"} / {gpu.memory_total_mb ?? "—"}{" "}
                    MB
                  </strong>
                </div>
              )}

              {gpu.temperature_c != null && (
                <div>
                  <span>GPU TEMP</span>
                  <strong>{gpu.temperature_c}°C</strong>
                  <Sparkline points={history?.gpu_temperature} variant="cpu" />
                </div>
              )}

              {(gpu.power_draw_w != null || gpu.power_limit_w != null) && (
                <div>
                  <span>POWER</span>
                  <strong>
                    {gpu.power_draw_w ?? "—"} / {gpu.power_limit_w ?? "—"} W
                  </strong>
                </div>
              )}

              {gpu.fan_percent != null && (
                <div>
                  <span>FAN</span>
                  <strong>{gpu.fan_percent}%</strong>
                </div>
              )}
            </div>
          );
        })()}

      {machine.disk_io?.length > 0 && (
        <div className="disk-io-list">
          {machine.disk_io.map((disk) => (
            <div className="disk-io-row" key={disk.device}>
              <strong>{disk.name}</strong>
              <span>↓ {formatSpeed(disk.read_bps)}</span>
              <span>↑ {formatSpeed(disk.write_bps)}</span>
            </div>
          ))}
        </div>
      )}

      {machine.filesystems?.length > 0 && (
        <div className="storage-section">
          <span className="storage-title">STORAGE</span>

          {machine.filesystems.map((filesystem) => (
            <div
              className="disk"
              key={`${filesystem.device}-${filesystem.mountpoint}`}
            >
              <div className="disk-header">
                <div>
                  <strong>{diskName(filesystem)}</strong>
                  <span>{filesystem.mountpoint}</span>
                </div>

                <strong>
                  {filesystem.used_percent}%
                  {filesystem.free_bytes != null && (
                    <small> · {formatBytes(filesystem.free_bytes)} free</small>
                  )}
                </strong>
              </div>

              <div className="disk-bar">
                <div
                  className="disk-bar-fill"
                  style={{
                    width: `${Math.min(filesystem.used_percent, 100)}%`,
                  }}
                />
              </div>

              <div className="disk-details">
                <span>{formatBytes(filesystem.used_bytes)} used</span>
                <span>{formatBytes(filesystem.total_bytes)} total</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default MachineVitals;
