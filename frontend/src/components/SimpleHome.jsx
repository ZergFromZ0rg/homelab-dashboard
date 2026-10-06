import { useEffect, useMemo, useRef, useState } from "react";
import AppIcon from "./AppIcon";
import CalendarCard from "./CalendarCard";
import Card from "./Card";
import FirstRun from "./FirstRun";
import { Meter } from "./HostSummary";
import { IconButton } from "./Icon";
import TodoList from "./TodoList";
import WeatherCard from "./WeatherCard";
import { containerUrl } from "./containerLink";
import { diskLabel } from "./diskLabel";
import { formatBytes } from "./format";
import { hostColor } from "./hostColor";
import { formatUptime } from "./machineInfo";
import { pinKey, togglePin } from "./containerPins";
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
  // The hour and minutes big, "PM" small beside them: the locale's own
  // "p.m." at clock size wrapped onto a second line.
  const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).formatToParts(now);
  const clock = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
  const period = parts.find((p) => p.type === "dayPeriod")?.value.replace(/\./g, "").toUpperCase();
  return (
    <section className="sh-clock" title={`${partOfDay(now.getHours())}${name ? `, ${name}` : ""}`}>
      <time dateTime={now.toISOString()}>
        {clock}
        {period && <small>{period}</small>}
      </time>
      <span>
        <b>{now.toLocaleDateString(undefined, { weekday: "long" })}</b>
        {now.toLocaleDateString(undefined, { month: "long", day: "numeric" })}
      </span>
    </section>
  );
}

function allContainers(containers) {
  return Object.entries(containers).flatMap(([host, list]) => list.map((c) => ({ host, ...c })));
}

// Pinned containers as one row of icon tiles, in the order they were pinned.
// The row scrolls sideways with no scrollbar (wheel, trackpad or swipe), and
// the "+" tile stays pinned to its right edge: tap it to pick another
// container, hold it and every tile turns red with a "−" — tap one to take
// it off the row. Tap "+" again (or Esc) to leave that mode.
const HOLD_MS = 500;

function AppGrid({ pins, containers, onSetPins }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const row = useRef(null);
  const hold = useRef({ timer: null, fired: false });

  const everything = allContainers(containers);
  const byKey = new Map(everything.map((c) => [pinKey(c.host, c.name), c]));
  const apps = pins.map((k) => byKey.get(k)).filter(Boolean);
  const pinned = new Set(pins);
  const choices = everything
    .filter((c) => !pinned.has(pinKey(c.host, c.name)))
    .sort((a, b) => a.name.localeCompare(b.name));

  // A vertical wheel turn scrolls the row sideways. Registered by hand: React's
  // wheel handler is passive and can't cancel the page's own scrolling.
  useEffect(() => {
    const el = row.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!editing) return undefined;
    const onKey = (e) => e.key === "Escape" && setEditing(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  useEffect(() => {
    if (editing && apps.length === 0) setEditing(false);
  }, [editing, apps.length]);

  const startHold = () => {
    hold.current.fired = false;
    clearTimeout(hold.current.timer);
    hold.current.timer = setTimeout(() => {
      hold.current.fired = true;
      setAdding(false);
      setEditing(true);
    }, HOLD_MS);
  };
  const endHold = () => clearTimeout(hold.current.timer);

  const onPlus = () => {
    if (hold.current.fired) {
      hold.current.fired = false; // the release of a hold isn't a tap
      return;
    }
    if (editing) setEditing(false);
    else setAdding((v) => !v);
  };

  const unpin = (c) => onSetPins(pins.filter((k) => k !== pinKey(c.host, c.name)));

  const add = (c) => {
    onSetPins(togglePin(pins, pinKey(c.host, c.name)));
    setAdding(false);
    // Bring the new tile into view at the end of the row.
    requestAnimationFrame(() => row.current?.scrollTo({ left: row.current.scrollWidth, behavior: "smooth" }));
  };

  return (
    <div className="sh-apps-wrap">
      <div className={`sh-apps ${editing ? "sh-apps--editing" : ""}`} ref={row}>
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
          const cls = `sh-app ${running ? "" : "sh-app--off"}`;
          const key = `${c.host}/${c.id}`;
          if (editing) {
            return (
              <button
                type="button"
                key={key}
                className={`${cls} sh-app--removable`}
                title={`Unpin ${c.name}`}
                aria-label={`Unpin ${c.name}`}
                onClick={() => unpin(c)}
              >
                {tile}
                <span className="sh-app-minus" aria-hidden="true">−</span>
              </button>
            );
          }
          return url ? (
            <a key={key} className={cls} href={url} target="_blank" rel="noopener noreferrer" title={title}>
              {tile}
            </a>
          ) : (
            <span key={key} className={`${cls} sh-app--static`} title={title}>
              {tile}
            </span>
          );
        })}
        <button
          type="button"
          className={`sh-app sh-app--add ${adding || editing ? "sh-app--active" : ""}`}
          onClick={onPlus}
          onPointerDown={startHold}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          onContextMenu={(e) => e.preventDefault()}
          title={editing ? "Done" : "Pin a container (hold to remove some)"}
          aria-expanded={adding}
        >
          <span className="sh-app-plus">{editing ? "✓" : "+"}</span>
          <span className="sh-app-name">{editing ? "Done" : "Add"}</span>
        </button>
      </div>
      {adding && (
        <div className="sh-picker" role="menu">
          {choices.length === 0 ? (
            <span className="sh-empty">Everything is already pinned.</span>
          ) : (
            choices.map((c) => (
              <button type="button" role="menuitem" key={`${c.host}/${c.id}`} className="sh-pick" onClick={() => add(c)}>
                {c.name}
                <small style={{ color: hostColor(c.host) }}>{c.host}</small>
              </button>
            ))
          )}
        </div>
      )}
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
        <span>
          {all.length} containers · {running.length} running
          {all.length - running.length > 0 ? ` · ${all.length - running.length} stopped` : ""}
        </span>
        <span title="Memory used by the running containers, all hosts added together">{formatBytes(mem)} RAM</span>
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
  onSetPins,
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
          {show.weather && <WeatherCard compact />}
          {show.todo && (
            <Card title="To-do" count={openTodos || null} className="sh-todo sh-fill">
              <TodoList todos={todos} onChange={onSetTodos} compact />
            </Card>
          )}
        </aside>

        <main className="sh-col sh-col--mid">
          <AppGrid pins={pins} containers={containers} onSetPins={onSetPins} />
          {briefing}
          <ContainerTable containers={containers} onControl={onControl} />
        </main>

        <aside className="sh-col sh-col--right">
          <Card title="Servers" count={hosts.length || null} className="sh-servers sh-fill">
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
