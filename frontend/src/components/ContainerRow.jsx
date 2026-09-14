import { avatarColor, containerUrl } from "./containerLink";
import { needsAttention } from "./containerSort";
import { formatBytes, formatBytesPerSec } from "./format";
import Heartbeat from "./Heartbeat";
import Stat from "./Stat";
import { useSettings } from "./settings";

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

function ContainerRow({
  container,
  host,
  hostCores,
  pending,
  errors,
  onControl,
  onClearError,
  pinned,
  onTogglePin,
  showHost,
}) {
  const {
    settings: { showContainerUptime, showLiveActivity, showResourceActivity },
  } = useSettings();

  const live = container.live_activity;
  const showLive =
    showLiveActivity &&
    live &&
    (live.source !== "resource" || showResourceActivity);

  const key = `${host}-${container.id}`;
  const action = pending[key];
  const busy = Boolean(action);
  const error = errors?.[key];
  const attention = needsAttention(container);

  // Stop and restart both drop the service — easy to hit by mistake in a
  // dense list, so make them deliberate.
  const confirmControl = (verb) => {
    if (window.confirm(`${verb} ${container.name} on ${host}?`)) {
      onControl(host, container.id, verb.toLowerCase());
    }
  };

  const protectedContainer =
    container.protected || container.name === "homelab-agent";

  const stats = container.stats;
  const memory = stats?.memory;
  const network = stats?.network;
  const blockIo = stats?.block_io;

  const url = containerUrl(host, container.ports);
  const cpuPercent = stats?.cpu_percent;
  const ramPercent = memory?.percent;

  // Docker's cpu_percent is 100% per logical CPU (a container fully using
  // 6 threads shows 600%), so a flat cap at 100 makes a single-threaded
  // container look just as "full" as one saturating the whole host. Scale
  // the bar against the host's logical-CPU count instead; the number
  // itself stays as Docker reports it.
  const cpuCapacity = hostCores ? hostCores * 100 : 100;
  const cpuBarPercent = Math.min(100, ((cpuPercent ?? 0) / cpuCapacity) * 100);

  return (
    <div
      className={`container-row ${pinned ? "container-row--pinned" : ""} ${
        attention ? "container-row--attention" : ""
      }`}
    >
      <div className="container-main">
        <div className="container-title">
          <div className="container-identity">
            <button
              type="button"
              className={`pin-btn ${pinned ? "pinned" : ""}`}
              onClick={onTogglePin}
              aria-pressed={pinned}
              title={pinned ? "Unpin container" : "Pin container to top"}
            >
              {pinned ? "★" : "☆"}
            </button>

            <ContainerAvatar name={container.name} />

            <div className="container-name-block">
              <div className="container-name-line">
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
                {showHost && (
                  <span className="container-host-chip">{host}</span>
                )}
              </div>
              <span>{container.image}</span>
            </div>
          </div>

          <div className="container-badges">
            {showLive && (
              <span
                className={`container-badge-live ${
                  live.source === "resource" ? "container-badge-live--resource" : ""
                }`}
                title={live.app ? `${live.app}: ${live.detail}` : live.detail}
              >
                {live.detail}
              </span>
            )}

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
          <Stat
            label="CPU"
            value={
              <>
                {cpuPercent != null ? `${cpuPercent}%` : "—"}
                {hostCores != null && cpuPercent > 100 && (
                  <small> · {(cpuPercent / 100).toFixed(1)} vCPU</small>
                )}
              </>
            }
          >
            <div
              className="mini-bar"
              title={
                hostCores != null
                  ? `${cpuBarPercent.toFixed(1)}% of host (${hostCores} vCPU)`
                  : undefined
              }
            >
              <div
                className="mini-bar-fill mini-bar-fill--cpu"
                style={{ width: `${cpuBarPercent}%` }}
              />
            </div>
          </Stat>

          <Stat
            label="RAM"
            value={
              <>
                {memory?.used_bytes != null
                  ? formatBytes(memory.used_bytes)
                  : "—"}
                {ramPercent != null && <small> · {ramPercent}%</small>}
              </>
            }
          >
            <div className="mini-bar">
              <div
                className="mini-bar-fill mini-bar-fill--ram"
                style={{ width: `${Math.min(ramPercent ?? 0, 100)}%` }}
              />
            </div>
          </Stat>
        </div>

        <div className="container-stats-grid">
          <Stat label="NET ↓" value={formatBytesPerSec(network?.rx_bps)} />
          <Stat label="NET ↑" value={formatBytesPerSec(network?.tx_bps)} />
          <Stat label="DISK ↓" value={formatBytesPerSec(blockIo?.read_bps)} />
          <Stat label="DISK ↑" value={formatBytesPerSec(blockIo?.write_bps)} />
          {showContainerUptime && (
            <Stat label="UPTIME" value={formatStartedAt(container.started_at)} />
          )}
          <Stat label="RESTARTS" value={container.restart_count ?? "—"} />
          <Stat
            label="IMAGE"
            value={
              container.size?.image_bytes != null
                ? formatBytes(container.size.image_bytes)
                : "—"
            }
          />
          <Stat
            label="ROOTFS"
            value={
              container.size?.rootfs_bytes != null
                ? formatBytes(container.size.rootfs_bytes)
                : "—"
            }
          />
        </div>
      </div>

      <div className="container-actions">
        {protectedContainer ? (
          <span className="protected-label">Protected</span>
        ) : (
          <>
            <div className="container-action-buttons">
              {container.status !== "running" && (
                <button
                  disabled={busy}
                  onClick={() => onControl(host, container.id, "start")}
                >
                  Start
                </button>
              )}

              {container.status === "running" && (
                <button disabled={busy} onClick={() => confirmControl("Stop")}>
                  Stop
                </button>
              )}

              <button disabled={busy} onClick={() => confirmControl("Restart")}>
                Restart
              </button>
            </div>

            {error && (
              <button
                type="button"
                className="container-control-error"
                onClick={() => onClearError?.(key)}
                title="Dismiss"
              >
                {error}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default ContainerRow;
