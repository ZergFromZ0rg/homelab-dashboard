import { useState } from "react";
import { avatarColor, containerUrl } from "./containerLink";
import { needsAttention } from "./containerSort";
import { formatBytes, formatBytesPerSec } from "./format";
import Heartbeat from "./Heartbeat";
import RebuildButton from "./RebuildButton";
import { useSettings } from "./settings";
import { hostColor } from "./hostColor";

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

function Detail({ label, value, sub }) {
  return (
    <div className="crow-detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

// One container as a single dense table row. The columns line up with
// ContainerTableHead; everything that doesn't fit on one line (heartbeat
// history, cumulative traffic, image size, ...) is behind the chevron.
function ContainerRow({
  container,
  host,
  hostCores,
  staleAge,
  pending,
  errors,
  onControl,
  onClearError,
  pinned,
  onTogglePin,
  showHost,
}) {
  const {
    settings: { showLiveActivity, highRestartCount },
  } = useSettings();
  const [open, setOpen] = useState(false);

  const live = container.live_activity;
  const showLive = showLiveActivity && Boolean(live);

  const key = `${host}-${container.id}`;
  const action = pending[key];
  const busy = Boolean(action);
  const error = errors?.[key];
  const attention = needsAttention(container, highRestartCount);
  const running = container.status === "running";

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
  // A container with no memory cap reports limit_bytes 0 and, with it,
  // percent 0 — indistinguishable from "using nothing" unless we call out
  // the missing limit explicitly.
  const hasRamLimit = memory?.limit_bytes > 0;

  // Docker's cpu_percent is 100% per logical CPU (a container fully using
  // 6 threads shows 600%), so a flat cap at 100 makes a single-threaded
  // container look just as "full" as one saturating the whole host. Scale
  // the bar against the host's logical-CPU count instead; the number
  // itself stays as Docker reports it.
  const cpuCapacity = hostCores ? hostCores * 100 : 100;
  const cpuBarPercent = Math.min(100, ((cpuPercent ?? 0) / cpuCapacity) * 100);

  return (
    <div
      className={[
        "crow",
        pinned && "crow--pinned",
        attention && "crow--attention",
        !running && "crow--off",
        open && "crow--open",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="crow-line">
        <button
          type="button"
          className={`pin-btn ${pinned ? "pinned" : ""}`}
          onClick={onTogglePin}
          aria-pressed={pinned}
          title={pinned ? "Unpin container" : "Pin container to top"}
        >
          {pinned ? "★" : "☆"}
        </button>

        <div className="c-name">
          <ContainerAvatar name={container.name} />
          <div className="c-name-block">
            <div className="c-name-line">
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
                <span
                  className="chip chip--host"
                  style={{ color: hostColor(host), borderColor: hostColor(host) }}
                >
                  {host}
                </span>
              )}
              {showLive && (
                <span className="chip chip--live" title={`${live.app}: ${live.detail}`}>
                  {live.detail}
                </span>
              )}
              {container.deployed_by === "homelab-dashboard" && (
                <span className="chip chip--accent" title="Placed by the scheduler">
                  scheduled
                </span>
              )}
            </div>
            <span className="c-image" title={container.image}>
              {container.image}
            </span>
          </div>
        </div>

        <div className="c-state">
          <div className="c-state-line">
            <span className={`container-status ${container.status}`}>
              {action ? `${action}…` : container.status}
            </span>
            {container.health && (
              <span className={`container-health ${container.health}`}>
                {container.health}
              </span>
            )}
            {staleAge != null && (
              <span
                className="container-status stale"
                title={`${host}'s agent hasn't responded in ${staleAge}s — the numbers here may be a little old`}
              >
                stale
              </span>
            )}
          </div>
          <Heartbeat heartbeat={container.heartbeat} compact />
        </div>

        <div className="c-cpu">
          <span className="c-value">
            {cpuPercent != null ? `${cpuPercent}%` : "—"}
            {hostCores != null && cpuPercent > 100 && (
              <small> · {(cpuPercent / 100).toFixed(1)} vCPU</small>
            )}
          </span>
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
        </div>

        <div className="c-ram">
          <span className="c-value">
            {memory?.used_bytes != null ? formatBytes(memory.used_bytes) : "—"}
            {hasRamLimit ? (
              <small>
                {" "}
                / {formatBytes(memory.limit_bytes)} · {ramPercent}%
              </small>
            ) : (
              memory?.used_bytes != null && <small> · no limit</small>
            )}
          </span>
          {hasRamLimit ? (
            <div className="mini-bar">
              <div
                className="mini-bar-fill mini-bar-fill--ram"
                style={{ width: `${Math.min(ramPercent ?? 0, 100)}%` }}
              />
            </div>
          ) : (
            <div className="mini-bar mini-bar--none" />
          )}
        </div>

        <div className="c-net">
          <span title="Download">↓ {formatBytesPerSec(network?.rx_bps)}</span>
          <span title="Upload">↑ {formatBytesPerSec(network?.tx_bps)}</span>
        </div>

        <div className="c-uptime">{formatStartedAt(container.started_at)}</div>

        <div className="c-actions">
          {/* Outside the protected branch on purpose: "Protected" is about
              not stopping or deleting the agent, but replacing it with a
              newer build is exactly what you want to do from here. */}
          {container.rebuild && (
            <RebuildButton
              host={host}
              container={container}
              target={container.rebuild}
            />
          )}

          {protectedContainer ? (
            <span className="protected-label">Protected</span>
          ) : (
            <>
              {!running && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => onControl(host, container.id, "start")}
                >
                  Start
                </button>
              )}
              {running && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => confirmControl("Stop")}
                >
                  Stop
                </button>
              )}
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy}
                onClick={() => confirmControl("Restart")}
              >
                Restart
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn--sm btn--ghost crow-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={open ? "Hide details" : "Show details"}
          >
            <span className="crow-chevron">▾</span>
          </button>
        </div>
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

      {open && (
        <div className="crow-detail">
          <Heartbeat heartbeat={container.heartbeat} />
          <div className="crow-detail-grid">
            <Detail
              label="Network in"
              value={formatBytesPerSec(network?.rx_bps)}
              sub={network?.rx_bytes != null ? `${formatBytes(network.rx_bytes)} total` : null}
            />
            <Detail
              label="Network out"
              value={formatBytesPerSec(network?.tx_bps)}
              sub={network?.tx_bytes != null ? `${formatBytes(network.tx_bytes)} total` : null}
            />
            <Detail
              label="Disk read"
              value={formatBytesPerSec(blockIo?.read_bps)}
              sub={blockIo?.read_bytes != null ? `${formatBytes(blockIo.read_bytes)} total` : null}
            />
            <Detail
              label="Disk write"
              value={formatBytesPerSec(blockIo?.write_bps)}
              sub={blockIo?.write_bytes != null ? `${formatBytes(blockIo.write_bytes)} total` : null}
            />
            <Detail label="Restarts" value={container.restart_count ?? "—"} />
            <Detail
              label="Image size"
              value={
                container.size?.image_bytes != null
                  ? formatBytes(container.size.image_bytes)
                  : "—"
              }
            />
            <Detail
              label="Root filesystem"
              value={
                container.size?.rootfs_bytes != null
                  ? formatBytes(container.size.rootfs_bytes)
                  : "—"
              }
            />
            <Detail
              label="Container"
              value={container.id}
              sub={container.compose_project ? `stack: ${container.compose_project}` : null}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default ContainerRow;
