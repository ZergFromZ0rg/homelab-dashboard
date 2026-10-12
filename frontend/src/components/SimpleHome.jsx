import { useEffect, useRef, useState } from "react";
import AppIcon from "./AppIcon";
import Card from "./Card";
import FirstRun from "./FirstRun";
import { Meter } from "./HostSummary";
import NeedsYouCard from "./NeedsYouCard";
import TodoList from "./TodoList";
import { WeatherLine } from "./WeatherCard";
import { containerLink, linkProblem } from "./containerLink";
import { diskLabel } from "./diskLabel";
import { hostColor } from "./hostColor";
import { pinKey, togglePin } from "./containerPins";
import { useSettings } from "./settings";
import { useNow } from "./useNow";
import { useFitHeight } from "./useFitHeight";

// The Simple page: a place to glance at, not a console. A top band with the
// time (and the weather in a line) beside your pinned apps; under it three
// cards — what needs you, how the servers are doing, your to-dos. Everything
// you dig into lives in God.

function partOfDay(hour) {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function Clock({ weather }) {
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
      <div className="sh-clock-main">
        <time dateTime={now.toISOString()}>
          {clock}
          {period && <small>{period}</small>}
        </time>
        <span>
          <b>{now.toLocaleDateString(undefined, { weekday: "long" })}</b>
          {now.toLocaleDateString(undefined, { month: "long", day: "numeric" })}
        </span>
      </div>
      {weather && <WeatherLine />}
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
          const url = containerLink(c.host, c);
          const running = c.status === "running";
          const tile = (
            <>
              <AppIcon url={url} label={c.name} className="app-tile-icon sh-app-icon" />
              <span className={`status-dot status-dot--${running ? "ok" : "bad"} sh-app-dot`} />
              <span className="sh-app-name">{c.name}</span>
            </>
          );
          const problem = url ? linkProblem(c.host, c) : null;
          const title = `${c.name} on ${c.host}${running ? "" : ` — ${c.status}`}${url ? ` · ${url}` : ""}${problem ? ` — ${problem}` : ""}`;
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

// One server: its name and the three meters worth a glance — CPU, memory and
// the fullest disk. Uptime, temperature and the rest are on its God page.
function HostCard({ name, machine: m, onOpen }) {
  const fullest = [...(m.filesystems || [])].sort((x, y) => (y.used_percent ?? 0) - (x.used_percent ?? 0))[0];

  return (
    <button type="button" className="sh-host" onClick={() => onOpen(name)} title={`Show ${name} in full`}>
      <span className="sh-host-head">
        <span className={`status-dot status-dot--${m.online ? "ok" : "bad"}`} />
        <strong style={{ color: hostColor(name) }}>{name}</strong>
        {!m.online && <span className="sh-host-meta">offline</span>}
      </span>
      {m.online && (
        <span className="sh-host-meters">
          <Meter label="CPU" pct={m.cpu} />
          <Meter label="RAM" pct={m.ram} />
          {fullest && <Meter label={diskLabel(fullest)} pct={fullest.used_percent} />}
        </span>
      )}
    </button>
  );
}

function SimpleHome({
  overview,
  machines,
  containers,
  backups,
  alerts,
  pins,
  onSetPins,
  todos,
  onSetTodos,
  openTodos,
  ready,
  morningSummary,
  onNavigate,
}) {
  const {
    settings: { personalCards: show },
  } = useSettings();
  const hosts = Object.keys(machines).sort();

  const fit = useFitHeight(4, 520);

  return (
    <div className="simple-home" ref={fit}>
      <FirstRun machines={machines} backups={backups} onNavigate={onNavigate} />
      <div className="sh-grid">
        <div className="sh-top">
          <Clock weather={show.weather} />
          <AppGrid pins={pins} containers={containers} onSetPins={onSetPins} />
        </div>

        <div className="sh-main">
          <div className="sh-col sh-col--wide">
            <NeedsYouCard
              overview={overview}
              alerts={alerts}
              summary={morningSummary}
              machines={machines}
              ready={ready}
              onNavigate={onNavigate}
            />

            {show.todo && (
              <Card title="To-do" count={openTodos || null} className="sh-todo sh-fill">
                <TodoList todos={todos} onChange={onSetTodos} compact />
              </Card>
            )}
          </div>

          <div className="sh-col">
            <Card title="Servers" count={hosts.length || null} className="sh-servers sh-fill">
              <div className="sh-hosts">
                {hosts.length === 0 && <p className="sh-empty">{ready ? "No hosts reporting yet." : "Connecting…"}</p>}
                {hosts.map((h) => (
                  <HostCard key={h} name={h} machine={machines[h]} onOpen={(host) => onNavigate("servers", { host })} />
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SimpleHome;
