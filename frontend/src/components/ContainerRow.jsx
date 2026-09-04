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

function formatStartedAt(value) {
  if (!value || value.startsWith("0001-")) return "—";

  const started = new Date(value);
  const now = new Date();

  const seconds = Math.floor((now - started) / 1000);

  if (seconds < 0) return "—";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;

  return `${minutes}m`;
}

function ContainerRow({ container, host, pending, onControl }) {
  const key = `${host}-${container.id}`;
  const action = pending[key];
  const busy = Boolean(action);

  const protectedContainer =
    container.protected || container.name === "homelab-agent";

  const stats = container.stats;
  const memory = stats?.memory;
  const network = stats?.network;
  const blockIo = stats?.block_io;

  return (
    <div className="container-row">
      <div className="container-main">
        <div className="container-title">
          <div>
            <strong>{container.name}</strong>
            <span>{container.image}</span>
          </div>

          <div className="container-badges">
            {container.health && (
              <span className={`container-health ${container.health}`}>
                {container.health}
              </span>
            )}

            <span className={`container-status ${container.status}`}>
              {action ? `${action}...` : container.status}
            </span>
          </div>
        </div>

        <div className="container-stats-grid">
          <div>
            <span>CPU</span>
            <strong>
              {stats?.cpu_percent != null ? `${stats.cpu_percent}%` : "—"}
            </strong>
          </div>

          <div>
            <span>RAM</span>
            <strong>
              {memory?.used_bytes != null
                ? formatBytes(memory.used_bytes)
                : "—"}
            </strong>
            <small>{memory?.percent != null ? `${memory.percent}%` : ""}</small>
          </div>

          <div>
            <span>NET ↓</span>
            <strong>
              {network?.rx_bps != null
                ? `${formatBytes(network.rx_bps)}/s`
                : "—"}
            </strong>
          </div>

          <div>
            <span>NET ↑</span>
            <strong>
              {network?.tx_bps != null
                ? `${formatBytes(network.tx_bps)}/s`
                : "—"}
            </strong>
          </div>

          <div>
            <span>DISK ↓</span>
            <strong>
              {blockIo?.read_bps != null
                ? `${formatBytes(blockIo.read_bps)}/s`
                : "—"}
            </strong>
          </div>

          <div>
            <span>DISK ↑</span>
            <strong>
              {blockIo?.write_bps != null
                ? `${formatBytes(blockIo.write_bps)}/s`
                : "—"}
            </strong>
          </div>

          <div>
            <span>UPTIME</span>
            <strong>{formatStartedAt(container.started_at)}</strong>
          </div>

          <div>
            <span>RESTARTS</span>
            <strong>{container.restart_count ?? "—"}</strong>
          </div>

          <div>
            <span>IMAGE</span>
            <strong>
              {container.size?.image_bytes != null
                ? formatBytes(container.size.image_bytes)
                : "—"}
            </strong>
          </div>

          <div>
            <span>WRITABLE</span>
            <strong>
              {container.size?.writable_bytes != null
                ? formatBytes(container.size.writable_bytes)
                : "—"}
            </strong>
          </div>

          <div>
            <span>ROOTFS</span>
            <strong>
              {container.size?.rootfs_bytes != null
                ? formatBytes(container.size.rootfs_bytes)
                : "—"}
            </strong>
          </div>
        </div>
      </div>

      <div className="container-actions">
        {protectedContainer ? (
          <span className="protected-label">Protected</span>
        ) : (
          <>
            {container.status !== "running" && (
              <button
                disabled={busy}
                onClick={() => onControl(host, container.id, "start")}
              >
                Start
              </button>
            )}

            {container.status === "running" && (
              <button
                disabled={busy}
                onClick={() => onControl(host, container.id, "stop")}
              >
                Stop
              </button>
            )}

            <button
              disabled={busy}
              onClick={() => onControl(host, container.id, "restart")}
            >
              Restart
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default ContainerRow;
