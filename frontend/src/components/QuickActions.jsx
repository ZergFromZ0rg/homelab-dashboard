import { pinKey } from "./containerPins";
import { containerUrl } from "./containerLink";
import { formatBytes } from "./format";
import { useSettings } from "./settings";
import { hostColor } from "./hostColor";
import AppIcon from "./AppIcon";
import { IconButton } from "./Icon";

// One line per pinned container — status, its web UI's icon, name and
// host, live activity, CPU / RAM, and start-or-stop + restart as icons.

function QaRow({ t, busy, onControl, showLink, showLiveActivity, staleAge }) {
  const running = t.status === "running";
  const primary = running ? "Stop" : "Start";
  const cpu = t.stats?.cpu_percent;
  const ram = t.stats?.memory?.used_bytes;
  const url = showLink ? containerUrl(t.host, t.ports) : null;
  const live = showLiveActivity ? t.live_activity : null;

  const act = (verb) => {
    if (window.confirm(`${verb} ${t.name} on ${t.host}?`)) {
      onControl.run(t.host, t.id, verb.toLowerCase());
    }
  };

  // A container only ever shows up here at all when its host's agent is
  // reachable (an unreachable agent reports an empty container list, so
  // there'd be nothing to pin in the first place — see
  // backend/docker.py's get_host_data). The real "this might be a little
  // old" signal is staleness: the backend is briefly serving its last-good
  // snapshot through a poll hiccup rather than blanking the host.
  const stale = staleAge != null;
  const dotState = stale ? "warn" : running ? "ok" : "bad";
  const dotTitle = stale
    ? `${t.host}'s agent hasn't responded in ${staleAge}s — status may be stale`
    : undefined;

  return (
    <div className={`qa-line ${running ? "" : "qa-line--stopped"}`}>
      <span className={`status-dot status-dot--${dotState}`} title={dotTitle ?? t.status} />
      <AppIcon url={url} label={t.name} className="app-tile-icon ov-icon" />
      <span className="qa-name-wrap">
        {url ? (
          <a
            className="qa-name qa-name-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${url}`}
          >
            {t.name}
          </a>
        ) : (
          <span className="qa-name" title={t.name}>
            {t.name}
          </span>
        )}
        <span className="qa-host" style={{ color: hostColor(t.host) }}>
          {t.host}
        </span>
      </span>
      <span
        className={`qa-live ${live ? "qa-live--on" : ""}`}
        title={live ? `${live.app}: ${live.detail}` : undefined}
      >
        {live ? live.detail : running ? "" : t.status}
      </span>
      <span className="qa-stats">
        <span>{cpu != null ? `${cpu}%` : "—"}</span>
        <span>{ram != null ? formatBytes(ram) : "—"}</span>
      </span>
      <span className="qa-btns">
        <IconButton
          icon={running ? "stop" : "play"}
          label={busy ? "Working…" : primary}
          disabled={busy}
          onClick={() => act(primary)}
        />
        <IconButton
          icon="refresh"
          label="Restart"
          disabled={busy}
          onClick={() => act("Restart")}
        />
      </span>
    </div>
  );
}

function QuickActions({ pins, containers, machines, onControl }) {
  const {
    settings: { pinGroups, quickActionLinks, showLiveActivity },
  } = useSettings();

  const pinned = new Set(pins);
  const targets = [];
  for (const [host, list] of Object.entries(containers)) {
    for (const c of list) {
      const key = pinKey(host, c.name);
      if (pinned.has(key)) targets.push({ host, key, ...c });
    }
  }
  targets.sort((a, b) => a.name.localeCompare(b.name));

  // Group by the label set in Settings → Site customization; containers
  // without one fall into a single unlabeled group. Skip the group
  // headers entirely when nobody's labeled anything — the common case.
  const groups = new Map();
  for (const t of targets) {
    const label = pinGroups[t.key] || "";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(t);
  }
  const labeled = [...groups.keys()].some((label) => label);
  const groupOrder = [...groups.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="quick-actions">
      {targets.length === 0 ? (
        <p className="overview-empty">
          Pin a container (★ on its row in the Containers tab) for one-click
          control here.
        </p>
      ) : (
        groupOrder.map((label) => (
          <div className="qa-rows" key={label || "__ungrouped"}>
            {labeled && (
              <div className="qa-group-label">{label || "Ungrouped"}</div>
            )}
            {groups.get(label).map((t) => (
              <QaRow
                key={`${t.host}-${t.id}`}
                t={t}
                busy={Boolean(onControl.pending[`${t.host}-${t.id}`])}
                onControl={onControl}
                showLink={quickActionLinks}
                showLiveActivity={showLiveActivity}
                staleAge={machines?.[t.host]?.agent_stale_age}
              />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

export default QuickActions;
