import { pinKey } from "./containerPins";
import { containerUrl } from "./containerLink";
import { formatBytes } from "./format";
import { useSettings } from "./settings";
import { hostColor } from "./hostColor";
import AppIcon from "./AppIcon";

// One tile per pinned container — its web UI's icon, name and host, status,
// CPU / RAM, and start-or-stop + restart. Same-size tiles in a grid, so the
// pinned set reads like an app launcher rather than a list.

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
    <div className={`qa-tile ${running ? "" : "qa-tile--stopped"}`}>
      <div className="qa-tile-head">
        <AppIcon url={url} label={t.name} className="app-tile-icon qa-tile-icon" />
        <div className="qa-name-wrap">
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
        </div>
        <span
          className={`status-dot status-dot--${dotState}`}
          title={dotTitle ?? (running ? "running" : t.status)}
        />
      </div>

      <span
        className={`qa-live ${live ? "qa-live--on" : ""}`}
        title={live ? `${live.app}: ${live.detail}` : undefined}
      >
        {live ? live.detail : running ? "running" : t.status}
      </span>

      <div className="qa-stats">
        <span className="qa-stat">
          CPU <strong>{cpu != null ? `${cpu}%` : "—"}</strong>
        </span>
        <span className="qa-stat">
          RAM <strong>{ram != null ? formatBytes(ram) : "—"}</strong>
        </span>
      </div>

      <div className="qa-row-btns">
        <button
          type="button"
          className="qa-btn"
          disabled={busy}
          onClick={() => act(primary)}
        >
          {busy ? "…" : primary}
        </button>
        <button
          type="button"
          className="qa-btn"
          disabled={busy}
          onClick={() => act("Restart")}
        >
          Restart
        </button>
      </div>
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
