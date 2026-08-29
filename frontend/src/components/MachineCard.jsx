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

function MachineCard({ name, machine }) {
  return (
    <div className={`machine-card ${machine.online ? "online" : "offline"}`}>
      <div className="machine-header">
        <h2>{name}</h2>

        <span className="status">
          <span className="status-dot" />
          {machine.online ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <div className="stats">
        <div>
          <span>CPU</span>
          <strong>{machine.cpu != null ? `${machine.cpu}%` : "—"}</strong>
        </div>

        <div>
          <span>RAM</span>
          <strong>{machine.ram != null ? `${machine.ram}%` : "—"}</strong>
        </div>

        <div>
          <span>TEMP</span>
          <strong>
            {machine.temperature != null
              ? `${machine.temperature}°C`
              : "—"}
          </strong>
        </div>

        <div>
          <span>LOAD</span>
          <strong>{machine.load1 ?? "—"}</strong>
        </div>

        <div>
          <span>UPTIME</span>
          <strong>{formatUptime(machine.uptime)}</strong>
        </div>
      </div>

      <div className="network-stats">
        <div>
          <span>DOWNLOAD</span>
          <strong>↓ {formatSpeed(machine.network_rx)}</strong>
        </div>

        <div>
          <span>UPLOAD</span>
          <strong>↑ {formatSpeed(machine.network_tx)}</strong>
        </div>
      </div>

      {machine.gpu?.available !== false &&
        (machine.gpu?.devices?.[0] || machine.gpu) && (() => {
          const gpu = machine.gpu.devices?.[0] || machine.gpu;

          return (
            <div className="gpu-stats">
              <div>
                <span>GPU</span>
                <strong>{gpu.name || "Detected GPU"}</strong>
                {gpu.vendor && <small>{gpu.vendor.toUpperCase()}</small>}
              </div>

              {gpu.utilization_percent != null && (
                <div>
                  <span>UTILIZATION</span>
                  <strong>{gpu.utilization_percent}%</strong>
                </div>
              )}

              {(gpu.memory_used_mb != null ||
                gpu.memory_total_mb != null) && (
                <div>
                  <span>VRAM</span>
                  <strong>
                    {gpu.memory_used_mb ?? "—"} /{" "}
                    {gpu.memory_total_mb ?? "—"} MB
                  </strong>
                </div>
              )}

              {gpu.temperature_c != null && (
                <div>
                  <span>GPU TEMP</span>
                  <strong>{gpu.temperature_c}°C</strong>
                </div>
              )}

              {(gpu.power_draw_w != null ||
                gpu.power_limit_w != null) && (
                <div>
                  <span>POWER</span>
                  <strong>
                    {gpu.power_draw_w ?? "—"} /{" "}
                    {gpu.power_limit_w ?? "—"} W
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
            <div
              className="disk-io-row"
              key={disk.device}
            >
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

                <strong>{filesystem.used_percent}%</strong>
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
                <span>
                  {formatBytes(filesystem.used_bytes)} used
                </span>

                <span>
                  {formatBytes(filesystem.total_bytes)} total
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default MachineCard;
