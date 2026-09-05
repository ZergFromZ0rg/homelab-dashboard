import { avatarColor, containerUrl } from "./containerLink";
import Heartbeat from "./Heartbeat";

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

function ContainerAvatar({ name }) {
  return (
    <div
      className="container-avatar"
      style={{ background: avatarColor(name) }}
      aria-hidden="true"
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function ContainerRow({ container, host, hostCores, pending, onControl }) {
  const key = `${host}-${container.id}`;
  const action = pending[key];
  const busy = Boolean(action);

  const protectedContainer =
    container.protected || container.name === "homelab-agent";

  const stats = container.stats;
  const memory = stats?.memory;
  const network = stats?.network;
  const blockIo = stats?.block_io;

  const url = containerUrl(host, container.ports);
  const cpuPercent = stats?.cpu_percent;
  const ramPercent = memory?.percent;

  // Docker's cpu_percent is 100% per core (a container fully using 6 cores
  // shows 600%), so a flat cap at 100 makes a single-core container look
  // just as "full" as one saturating the whole host. Scale the bar against
  // the host's actual core count instead; the number itself stays as
  // Docker reports it, since that raw value is still the useful one.
  const cpuCapacity = hostCores ? hostCores * 100 : 100;
  const cpuBarPercent = Math.min(100, ((cpuPercent ?? 0) / cpuCapacity) * 100);

  return (
    <div className="container-row">
      <div className="container-main">
        <div className="container-title">
          <div className="container-identity">
            <ContainerAvatar name={container.name} />

            <div className="container-name-block">
              {url ? (
                <a
                  className="container-link"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${url}`}
                >
                  {container.name}
                </a>
              ) : (
                <strong>{container.name}</strong>
              )}
              <span>{container.image}</span>
            </div>
          </div>

          <div className="container-badges">
            {container.deployed_by === "homelab-dashboard" && (
              <span className="container-badge-scheduled" title="Placed by the scheduler">
                scheduled
              </span>
            )}

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

        <Heartbeat heartbeat={container.heartbeat} />

        <div className="container-primary-stats">
          <div>
            <span>CPU</span>
            <strong>
              {cpuPercent != null ? `${cpuPercent}%` : "—"}
              {hostCores != null && cpuPercent > 100 && (
                <small> · {(cpuPercent / 100).toFixed(1)} cores</small>
              )}
            </strong>
            <div
              className="mini-bar"
              title={
                hostCores != null
                  ? `${cpuBarPercent.toFixed(1)}% of host (${hostCores} cores)`
                  : undefined
              }
            >
              <div
                className="mini-bar-fill mini-bar-fill--cpu"
                style={{ width: `${cpuBarPercent}%` }}
              />
            </div>
          </div>

          <div>
            <span>RAM</span>
            <strong>
              {memory?.used_bytes != null
                ? formatBytes(memory.used_bytes)
                : "—"}
              {ramPercent != null && (
                <small> · {ramPercent}%</small>
              )}
            </strong>
            <div className="mini-bar">
              <div
                className="mini-bar-fill mini-bar-fill--ram"
                style={{ width: `${Math.min(ramPercent ?? 0, 100)}%` }}
              />
            </div>
          </div>
        </div>

        <div className="container-stats-grid">
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
