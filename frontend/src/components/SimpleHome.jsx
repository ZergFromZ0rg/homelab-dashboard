import { useMemo, useState } from "react";
import AppIcon from "./AppIcon";
import CalendarCard from "./CalendarCard";
import Card from "./Card";
import FirstRun from "./FirstRun";
import { Meter } from "./HostSummary";
import { IconButton } from "./Icon";
import TodoList from "./TodoList";
import { containerUrl } from "./containerLink";
import { diskLabel } from "./diskLabel";
import { formatBytes } from "./format";
import { hostColor } from "./hostColor";
import { formatUptime } from "./machineInfo";
import { pinKey } from "./containerPins";
import { useSettings } from "./settings";
import { useNow } from "./useNow";

// The Simple page: a board you can read from across the room. Three columns —
// time, calendar and to-dos on the left; pinned apps as icon tiles over one
// plain container table in the middle; the servers, four headline numbers and
// what needs attention on the right. Everything else lives in Advanced.

function partOfDay(hour) {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function Clock() {
  const now = useNow(1000);
  const {
    settings: { displayName },
  } = useSettings();
  const name = displayName.trim();
  return (
    <section className="sh-clock">
      <time dateTime={now.toISOString()}>
        {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </time>
      <span>{now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span>
      <small>
        {partOfDay(now.getHours())}
        {name ? `, ${name}` : ""}
      </small>
    </section>
  );
}

function allContainers(containers) {
  return Object.entries(containers).flatMap(([host, list]) => list.map((c) => ({ host, ...c })));
}

function AppGrid({ pins, containers, onNavigate }) {
  const pinned = new Set(pins);
  const apps = allContainers(containers)
    .filter((c) => pinned.has(pinKey(c.host, c.name)))
    .sort((a, b) => a.name.localeCompare(b.name));

  // A pinned container with no published web port still gets a tile; it just
  // isn't a link.
  if (apps.length === 0) {
    return (
      <p className="sh-empty">
        Pin containers to put them here as quick links.{" "}
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => onNavigate("containers")}>
          Open Containers
        </button>{" "}
        and press ★ on a row.
      </p>
    );
  }

  return (
    <div className="sh-apps">
      {apps.map((c) => {
        const url = containerUrl(c.host, c.ports);
        const running = c.status === "running";
        const tile = (
          <>
            <AppIcon url={url} label={c.name} className="app-tile-icon sh-app-icon" />
            <span className={`status-dot status-dot--${running ? "ok" : "bad"} sh-app-dot`} />
            <span className="sh-app-name">{c.name}</span>
          </>
        );
        const title = `${c.name} on ${c.host}${running ? "" : ` — ${c.status}`}${url ? ` · ${url}` : ""}`;
        return url ? (
          <a
            key={`${c.host}/${c.id}`}
            className={`sh-app ${running ? "" : "sh-app--off"}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
          >
            {tile}
          </a>
        ) : (
          <span key={`${c.host}/${c.id}`} className={`sh-app sh-app--static ${running ? "" : "sh-app--off"}`} title={title}>
            {tile}
          </span>
        );
      })}
    </div>
  );
}

function ContainerTable({ containers, onControl }) {
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return allContainers(containers)
      .filter((c) => !q || `${c.name} ${c.host}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const down = (c) => (c.status === "running" ? 1 : 0);
        return down(a) - down(b) || a.name.localeCompare(b.name);
      });
  }, [containers, filter]);

  const all = allContainers(containers);
  const running = all.filter((c) => c.status === "running");
  const cpu = running.reduce((n, c) => n + (c.stats?.cpu_percent || 0), 0);
  const mem = running.reduce((n, c) => n + (c.stats?.memory?.used_bytes || 0), 0);

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
        <input
          className="sh-filter"
          type="search"
          placeholder="Find…"
          aria-label="Find a container"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      }
      className="sh-table-card sh-fill"
    >
      <div className="sh-table-scroll">
        <table className="sh-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Host</th>
              <th className="num">CPU</th>
              <th className="num">Memory</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const up = c.status === "running";
              const busy = Boolean(onControl.pending[`${c.host}-${c.id}`]);
              const url = containerUrl(c.host, c.ports);
              return (
                <tr key={`${c.host}-${c.id}`} className={up ? "" : "sh-row--off"}>
                  <td>
                    <span className="sh-name">
                      <span className={`status-dot status-dot--${up ? "ok" : "bad"}`} title={c.status} />
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" title={`Open ${url}`}>
                          {c.name}
                        </a>
                      ) : (
                        c.name
                      )}
                    </span>
                  </td>
                  <td style={{ color: hostColor(c.host) }}>{c.host}</td>
                  <td className="num">{up && c.stats?.cpu_percent != null ? `${c.stats.cpu_percent.toFixed(1)}%` : ""}</td>
                  <td className="num">{up && c.stats?.memory?.used_bytes != null ? formatBytes(c.stats.memory.used_bytes) : ""}</td>
                  <td className="sh-actions">
                    <IconButton
                      icon={up ? "stop" : "play"}
                      label={busy ? "Working…" : up ? "Stop" : "Start"}
                      disabled={busy}
                      onClick={() => act(c, up ? "Stop" : "Start")}
                    />
                    <IconButton icon="refresh" label="Restart" disabled={busy} onClick={() => act(c, "Restart")} />
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="sh-empty">
                  {all.length ? "No match." : "No containers reported yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="sh-table-foot">
        <span>{all.length} containers</span>
        <span>
          CPU {cpu.toFixed(1)}% · Memory {formatBytes(mem)}
        </span>
      </div>
    </Card>
  );
}

function HostCard({ name, machine: m, containers, onOpen }) {
  const list = containers || [];
  const running = list.filter((c) => c.status === "running").length;
  const disks = [...(m.filesystems || [])]
    .sort((a, b) => (b.used_percent ?? 0) - (a.used_percent ?? 0))
    .slice(0, 3);

  return (
    <button type="button" className="sh-host" onClick={() => onOpen(name)} title={`Show ${name} in full`}>
      <span className="sh-host-head">
        <span className={`status-dot status-dot--${m.online ? "ok" : "bad"}`} />
        <strong style={{ color: hostColor(name) }}>{name}</strong>
        <span className="sh-host-meta">
          {m.online ? `up ${formatUptime(m.uptime)}` : "offline"}
          {m.online && m.temperature != null ? ` · ${Math.round(m.temperature)}°C` : ""}
          {m.online ? ` · ${running}/${list.length}` : ""}
        </span>
      </span>
      {m.online && (
        <span className="sh-host-meters">
          <Meter label="CPU" pct={m.cpu} />
          <Meter label="RAM" pct={m.ram} />
          {disks.map((fs) => (
            <Meter key={fs.mountpoint || fs.device || diskLabel(fs)} label={diskLabel(fs)} pct={fs.used_percent} />
          ))}
        </span>
      )}
    </button>
  );
}

function Tile({ value, label, tone, onClick }) {
  return (
    <button type="button" className={`sh-tile ${tone ? `sh-tile--${tone}` : ""}`} onClick={onClick}>
      <strong>{value}</strong>
      <span>{label}</span>
    </button>
  );
}

function Alerts({ overview, alerts, ready, onNavigate }) {
  const firing = alerts.filter((a) => a.resolved_at == null);
  const rows = [
    ...overview.issues.map((i) => ({ key: i.key, tone: i.severity, text: i.title, title: i.message })),
    ...firing
      .filter((a) => !overview.issues.some((i) => i.key === a.key))
      .map((a) => ({ key: `alert-${a.key}-${a.at}`, tone: a.severity || "bad", text: a.title, title: a.message })),
  ];
  const clear = ready && rows.length === 0;
  return (
    <Card title="Alerts" count={clear || !ready ? null : rows.length} className="sh-alerts sh-fill">
      {!ready ? (
        <p className="sh-empty">Waiting for the first update…</p>
      ) : clear ? (
        <p className="ov-clear">
          <span className="status-dot status-dot--ok" />
          All clear
        </p>
      ) : (
        <ul className="ov-issue-list">
          {rows.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                className={`ov-issue ov-issue--${r.tone}`}
                title={r.title}
                onClick={() => onNavigate(r.key.startsWith("check:") ? "network" : "containers")}
              >
                <span className={`status-dot status-dot--${r.tone}`} />
                <strong>{r.text}</strong>
                <span className="ov-go" aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SimpleHome({
  overview,
  machines,
  containers,
  backups,
  checks,
  alerts,
  pins,
  todos,
  onSetTodos,
  openTodos,
  ready,
  briefing,
  onControl,
  onNavigate,
}) {
  const {
    settings: { personalCards: show },
  } = useSettings();
  const hosts = Object.keys(machines).sort();
  const online = hosts.filter((h) => machines[h].online).length;
  const all = allContainers(containers);
  const running = all.filter((c) => c.status === "running").length;
  const issues = overview.issues.length;

  return (
    <div className="simple-home">
      <FirstRun machines={machines} backups={backups} onNavigate={onNavigate} />
      <div className="sh-grid">
        <aside className="sh-col sh-col--left">
          <Clock />
          {show.calendar && <CalendarCard />}
          {show.todo && (
            <Card title="To-do" count={openTodos || null} className="sh-todo sh-fill">
              <TodoList todos={todos} onChange={onSetTodos} compact />
            </Card>
          )}
        </aside>

        <main className="sh-col sh-col--mid">
          <AppGrid pins={pins} containers={containers} onNavigate={onNavigate} />
          {briefing}
          <ContainerTable containers={containers} onControl={onControl} />
        </main>

        <aside className="sh-col sh-col--right">
          <Card title="Servers" count={hosts.length || null} className="sh-servers">
            <div className="sh-hosts">
              {hosts.length === 0 && <p className="sh-empty">{ready ? "No hosts reporting yet." : "Connecting…"}</p>}
              {hosts.map((h) => (
                <HostCard
                  key={h}
                  name={h}
                  machine={machines[h]}
                  containers={containers[h]}
                  onOpen={(host) => onNavigate("servers", { host })}
                />
              ))}
            </div>
          </Card>
          <div className="sh-tiles">
            <Tile value={`${online}/${hosts.length}`} label="Hosts up" tone={online < hosts.length ? "bad" : null} onClick={() => onNavigate("servers")} />
            <Tile value={`${running}/${all.length}`} label="Running" onClick={() => onNavigate("containers")} />
            <Tile value={ready ? issues : "—"} label="Issues" tone={issues ? "bad" : null} onClick={() => onNavigate("containers")} />
            <Tile
              value={backups?.total ? `${backups.ok}/${backups.total}` : "—"}
              label="Backups"
              tone={ready && backups?.attention ? "bad" : null}
              onClick={() => onNavigate("backups")}
            />
          </div>
          <Alerts overview={overview} alerts={alerts} ready={ready} onNavigate={onNavigate} />
        </aside>
      </div>
    </div>
  );
}

export default SimpleHome;
