import AppIcon from "./AppIcon";
import { containerIconUrl } from "./containerIcon";
import { containerLink, linkProblem } from "./containerLink";
import { formatBytes } from "./format";
import { hostColor } from "./hostColor";

// One container as a square tile: its name over its logo, a status dot in the
// corner, and the host as a coloured edge along the bottom. Opens the web UI
// when there is one. Everything else (host, state, load, address) is in the
// tooltip. Used by the pinned row and the Containers grid on Simple.
//
// `editing` turns the tile into an "unpin" button (the pinned row's remove
// mode).

function tooltip(c, url, problem, running) {
  const load = [];
  if (running && c.stats?.cpu_percent != null) load.push(`${c.stats.cpu_percent.toFixed(1)}% CPU`);
  if (running && c.stats?.memory?.used_bytes != null) load.push(formatBytes(c.stats.memory.used_bytes));
  return [`${c.name} on ${c.host}${running ? "" : ` — ${c.status}`}`, load.join(" · "), url, problem]
    .filter(Boolean)
    .join(" · ");
}

export function ContainerTile({ c, editing, onUnpin }) {
  const url = containerLink(c.host, c);
  const running = c.status === "running";
  const problem = url ? linkProblem(c.host, c) : null;
  const cls = `sh-app ${running ? "" : "sh-app--off"}`;
  const style = { "--host": hostColor(c.host) };
  const body = (
    <>
      <span className="sh-app-name">{c.name}</span>
      <AppIcon url={url} label={c.name} logo={containerIconUrl(c)} className="app-tile-icon sh-app-icon" />
      <span className={`status-dot status-dot--${running ? "ok" : "bad"} sh-app-dot`} />
    </>
  );

  if (editing) {
    return (
      <button
        type="button"
        className={`${cls} sh-app--removable`}
        style={style}
        title={`Unpin ${c.name}`}
        aria-label={`Unpin ${c.name}`}
        onClick={() => onUnpin(c)}
      >
        {body}
        <span className="sh-app-minus" aria-hidden="true">−</span>
      </button>
    );
  }
  const title = tooltip(c, url, problem, running);
  return url ? (
    <a className={cls} style={style} href={url} target="_blank" rel="noopener noreferrer" title={title}>
      {body}
    </a>
  ) : (
    <span className={`${cls} sh-app--static`} style={style} title={title}>
      {body}
    </span>
  );
}

function ContainerTiles({ rows }) {
  return (
    <div className="sh-apps-grid">
      {rows.map((c) => (
        <ContainerTile key={`${c.host}/${c.id}`} c={c} />
      ))}
    </div>
  );
}

export default ContainerTiles;
