import { lazy, Suspense, useState } from "react";
import { containerLink, linkLabel, linkProblem, publishedPorts } from "./containerLink";
import AppIcon from "./AppIcon";
import { containerIconUrl } from "./containerIcon";
import Icon from "./Icon";
import { needsAttention } from "./containerSort";
import { formatBytes, formatBytesPerSec, formatStartedAt, formatWhen } from "./format";
import ContainerCharts from "./ContainerCharts";
import Heartbeat from "./Heartbeat";
import { RebuildNote } from "./RebuildButton";
import { RowAction, RowMenu } from "./RowActions";
import { needsPull, repoSummary } from "./repoState";
import { useRebuild } from "./useRebuild";
import { useSettings } from "./settings";
import { hostColor } from "./hostColor";
import { requestContainerCapture } from "./captureRequest";
import { useTerminal } from "./terminalContext";
import { useUpdates } from "./updatesContext";

const ContainerSettings = lazy(() => import("./ContainerSettings"));

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
  const terminal = useTerminal();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const updates = useUpdates();
  const update = container.update;
  const hostJob = updates?.jobs[host];
  const updating =
    (hostJob?.state === "running" || hostJob?.state === "starting") &&
    (hostJob.projects.length === 0 || hostJob.projects.includes(container.compose_project));

  const rebuild = useRebuild(host, container, container.rebuild);
  const repo = container.repo;

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

  const url = containerLink(host, container);
  const urlProblem = url ? linkProblem(host, container) : null;
  // No web page: say what it does listen on, so "no link" isn't a blank.
  const ports = url ? [] : publishedPorts(container);
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
          {/* The web UI's own icon when it has one, else a lettered avatar. */}
          <AppIcon url={url} label={container.name} logo={containerIconUrl(container)} className="app-tile-icon c-icon" />
          <div className="c-name-block" title={container.image}>
            <div className="c-name-line">
              {url ? (
                <a
                  className="container-link"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={urlProblem ? `Open ${url} — ${urlProblem}` : `Open ${url}`}
                >
                  {container.name}
                  {urlProblem && <span className="link-warn" aria-hidden="true">!</span>}
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
            </div>
            <div className="c-name-sub">
              {url ? (
                <a
                  className="c-addr"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={urlProblem ? `Open ${url} — ${urlProblem}` : `Open ${url}`}
                >
                  <span className="c-addr-go" aria-hidden="true">↗</span>
                  {linkLabel(url)}
                </a>
              ) : ports.length > 0 ? (
                <span className="c-addr c-addr--ports" title="Publishes these ports, but no web page answered on them">
                  {ports.slice(0, 3).map((p) => `:${p}`).join(" ")}
                  {ports.length > 3 ? ` +${ports.length - 3}` : ""}
                </span>
              ) : null}
              {/* What else to know about it, after the address. */}
              {showLive && (
                <span className="chip chip--live" title={`${live.app}: ${live.detail}`}>
                  {live.detail}
                </span>
              )}
              {(update?.state === "available" || updating) && (
                <button
                  type="button"
                  className="chip chip--accent chip--button"
                  aria-busy={updating || undefined}
                  disabled={!update?.can_update || Boolean(hostJob && hostJob.state !== "done" && hostJob.state !== "rolled_back" && hostJob.state !== "failed")}
                  title={
                    updating
                      ? "Pulling the new image, recreating, watching it come up"
                      : `A newer image is on the registry (checked ${formatWhen(update.checked_at)}). ` +
                        (update.can_update
                          ? "Click to pull it and recreate — rolled back if it doesn't come up."
                          : update.why_not)
                  }
                  onClick={() => {
                    if (window.confirm(`Update ${container.name} on ${host}? It will be recreated with the newer image.`)) {
                      updates.start(host, [container.name]);
                    }
                  }}
                >
                  {updating ? (hostJob.progress?.percent != null ? `updating ${Math.round(hostJob.progress.percent)}%` : "updating…") : "image update"}
                </button>
              )}
              {needsPull(repo) && (
                <span className="chip chip--warn" title={`${repo.owner}/${repo.name}: ${repoSummary(repo).title}`}>
                  new commits
                </span>
              )}
              {container.deployed_by === "homelab-dashboard" && (
                <span className="chip chip--accent" title="Placed by the scheduler">
                  scheduled
                </span>
              )}
              <RebuildNote note={rebuild.note} onDismiss={rebuild.dismiss} />
            </div>
          </div>
        </div>

        <div className="c-state">
          <div className="c-state-line">
            <span className={`status-pill status-pill--${running ? "ok" : container.status === "exited" || container.status === "dead" ? "bad" : "none"}`}>
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
          {terminal && (
            <RowAction
              icon="logs"
              label="Logs"
              title="Read what this container prints, live"
              onClick={() => terminal.open({ host, target: "logs", container: container.id, name: container.name })}
            />
          )}

          {protectedContainer ? (
            <span
              className="protected-label"
              title="Protected — the agent can't be stopped or restarted from here"
            >
              <Icon name="lock" size={14} />
              Protected
            </span>
          ) : (
            <>
              <RowAction
                icon="refresh"
                label="Restart"
                title="Stop it and start it again"
                working={action === "restart"}
                disabled={busy}
                onClick={() => confirmControl("Restart")}
              />
              {running ? (
                <RowAction
                  icon="stop"
                  label="Stop"
                  title="Stop this container"
                  tone="danger"
                  working={action === "stop"}
                  disabled={busy}
                  onClick={() => confirmControl("Stop")}
                />
              ) : (
                <RowAction
                  icon="play"
                  label="Start"
                  title="Start this container"
                  tone="ok"
                  working={action === "start"}
                  disabled={busy}
                  onClick={() => onControl(host, container.id, "start")}
                />
              )}
            </>
          )}

          <RowMenu
            items={[
              running &&
                terminal?.available(host) && {
                  icon: "terminal",
                  label: "Open a shell",
                  hint: "A terminal inside this container",
                  onClick: () =>
                    terminal.open({ host, target: "container", container: container.id, name: container.name }),
                },
              running && {
                icon: "packets",
                label: "Capture its traffic",
                hint: "Record its network packets (Network → Packets)",
                onClick: () => requestContainerCapture(host, container.name),
              },
              {
                icon: "sliders",
                label: "Edit its compose file",
                hint: "Change its image, ports, volumes or environment",
                onClick: () => setSettingsOpen(true),
              },
              // Outside the protected branch on purpose: "Protected" is about
              // not stopping or deleting the agent, but replacing it with a
              // newer build is exactly what you want to do from here.
              container.rebuild && {
                icon: "hammer",
                label: rebuild.running ? "Redeploying…" : needsPull(repo) ? "Pull & redeploy" : "Redeploy",
                hint: rebuild.title,
                disabled: rebuild.running,
                onClick: rebuild.run,
              },
              {
                icon: "chevron",
                label: open ? "Hide details" : "Show details",
                hint: "History charts, disk and network totals",
                onClick: () => setOpen((v) => !v),
              },
            ]}
          />
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

      {settingsOpen && (
        <Suspense fallback={null}>
          <ContainerSettings host={host} container={container} onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}

      {open && (
        <div className="crow-detail">
          <Heartbeat heartbeat={container.heartbeat} />
          <ContainerCharts host={host} name={container.name} open={open} />
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
