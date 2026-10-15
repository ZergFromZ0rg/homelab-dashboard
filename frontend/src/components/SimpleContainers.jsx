import { useMemo, useState } from "react";
import AppIcon from "./AppIcon";
import { allContainers } from "./allContainers";
import Card from "./Card";
import ContainerTiles from "./ContainerTiles";
import { IconButton } from "./Icon";
import { containerIconUrl } from "./containerIcon";
import { containerLink, linkProblem } from "./containerLink";
import { pinKey } from "./containerPins";
import { formatBytes, formatBytesPerSec, formatStartedAt } from "./format";
import { hostColor } from "./hostColor";
import { useLocalStorage } from "./useLocalStorage";

// The Containers card on Simple: one line per container with what you read it
// for — state, CPU, memory, network, uptime — and stop / restart at the end of
// the row. A grid of logo tiles is the other view. Stopped containers sort
// first, then by name.

// A number with a thin bar under it. `pct` is 0-100, or null for no bar.
function Meter({ pct, tone }) {
  if (pct == null) return <span className="sh-meter sh-meter--none" />;
  return (
    <span className="sh-meter">
      <i className={tone ? `sh-meter--${tone}` : ""} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

function ContainerLine({ c, pendingAct, onAct }) {
  const up = c.status === "running";
  const busy = Boolean(pendingAct);
  const url = containerLink(c.host, c);
  const problem = url ? linkProblem(c.host, c) : null;
  const stats = c.stats;
  const memory = stats?.memory;
  const network = stats?.network;

  const cpu = up ? stats?.cpu_percent : null;
  const limit = memory?.limit_bytes;
  const ramPct = up && limit ? (memory.used_bytes / limit) * 100 : null;
  const pill = up ? "ok" : c.status === "exited" || c.status === "dead" ? "bad" : "none";
  const quiet = (n) => (n ? "" : " sh-dim");

  return (
    <tr className={up ? "" : "sh-row--off"}>
      <td className="sh-col-name">
        <span className="sh-name">
          <AppIcon url={url} label={c.name} logo={containerIconUrl(c)} className="app-tile-icon sh-row-icon" />
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url}${problem ? ` — ${problem}` : ""}`}>
              {c.name}
            </a>
          ) : (
            <span title={c.image}>{c.name}</span>
          )}
        </span>
      </td>
      <td style={{ color: hostColor(c.host) }}>{c.host}</td>
      <td>
        <span className={`status-pill status-pill--${pill}`}>{pendingAct ? `${pendingAct}…` : c.status}</span>
        {c.health && c.health !== "healthy" && <span className={`container-health ${c.health} sh-health`}>{c.health}</span>}
      </td>
      <td className="num" title={cpu != null ? `${cpu.toFixed(1)}% of one core` : undefined}>
        {cpu != null && (
          <span className="sh-cell">
            <Meter pct={cpu} />
            {cpu.toFixed(1)}%
          </span>
        )}
      </td>
      <td className="num" title={up && limit ? `${formatBytes(memory.used_bytes)} of ${formatBytes(limit)}` : undefined}>
        {up && memory?.used_bytes != null && (
          <span className="sh-cell">
            <Meter pct={ramPct} tone={ramPct > 90 ? "bad" : ramPct > 75 ? "warn" : "ram"} />
            {formatBytes(memory.used_bytes)}
          </span>
        )}
      </td>
      <td className="num sh-net sh-c-net">
        {up && network ? (
          <>
            <span className={quiet(network.rx_bps)} title="Download">↓ {formatBytesPerSec(network.rx_bps)}</span>
            <span className={quiet(network.tx_bps)} title="Upload">↑ {formatBytesPerSec(network.tx_bps)}</span>
          </>
        ) : null}
      </td>
      <td className="num sh-up sh-c-up">{up ? formatStartedAt(c.started_at) : ""}</td>
      <td className="sh-actions">
        <IconButton
          icon={up ? "stop" : "play"}
          label={up ? "Stop" : "Start"}
          working={pendingAct === (up ? "stop" : "start")}
          disabled={busy}
          onClick={() => onAct(c, up ? "Stop" : "Start")}
        />
        <IconButton icon="refresh" label="Restart" working={pendingAct === "restart"} disabled={busy} onClick={() => onAct(c, "Restart")} />
      </td>
    </tr>
  );
}

function SimpleContainers({ containers, pins, onControl }) {
  const [filter, setFilter] = useState("");
  const [saved, setView] = useLocalStorage("homelab.simpleContainers", "list");
  const view = saved === "tiles" ? "tiles" : "list";

  const all = useMemo(() => allContainers(containers), [containers]);
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return all
      .filter((c) => !q || `${c.name} ${c.host}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const down = (c) => (c.status === "running" ? 1 : 0);
        return down(a) - down(b) || a.name.localeCompare(b.name);
      });
  }, [all, filter]);
  const running = all.filter((c) => c.status === "running");

  // The pinned ones are the row of tiles above the briefing, so the grid
  // doesn't repeat them — unless you are searching, when every match shows.
  const pinned = new Set(pins);
  const tiles = filter.trim() ? rows : rows.filter((c) => !pinned.has(pinKey(c.host, c.name)));

  const act = (c, verb) => {
    if (window.confirm(`${verb} ${c.name} on ${c.host}?`)) {
      onControl.run(c.host, c.id, verb.toLowerCase());
    }
  };

  return (
    <Card
      title="Containers"
      count={`${running.length}/${all.length}`}
      actions={
        <>
          <input
            className="sh-filter"
            type="search"
            placeholder="Find…"
            aria-label="Find a container"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="sh-view" role="group" aria-label="Show containers as">
            <IconButton icon="list" label="List" active={view === "list"} aria-pressed={view === "list"} onClick={() => setView("list")} />
            <IconButton icon="grid" label="Tiles" active={view === "tiles"} aria-pressed={view === "tiles"} onClick={() => setView("tiles")} />
          </span>
        </>
      }
      className="sh-table-card sh-fill"
    >
      <div className="sh-table-scroll">
        {view === "tiles" ? (
          tiles.length ? (
            <ContainerTiles rows={tiles} />
          ) : (
            <p className="sh-empty">
              {all.length === 0 ? "No containers reported yet." : filter.trim() ? "No match." : "Everything is pinned above."}
            </p>
          )
        ) : (
          <table className="sh-table">
            <thead>
              <tr>
                <th>Container</th>
                <th>Host</th>
                <th>State</th>
                <th className="num">CPU</th>
                <th className="num">Memory</th>
                <th className="num sh-c-net">Network</th>
                <th className="num sh-c-up">Up</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <ContainerLine key={`${c.host}-${c.id}`} c={c} pendingAct={onControl.pending[`${c.host}-${c.id}`]} onAct={act} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="sh-empty">
                    {all.length ? "No match." : "No containers reported yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

export default SimpleContainers;
