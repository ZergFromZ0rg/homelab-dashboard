import { pinKey } from "./containerPins";
import { containerUrl } from "./containerLink";
import { formatBytes } from "./format";
import { useSettings } from "./settings";

// One compact row per pinned container — status dot, name, CPU / RAM, and
// start-or-stop + restart. Plus jumps to the tabs where the rest lives.

function QaRow({ t, busy, onControl, showLink, showLiveActivity }) {
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

  return (
    <div className="qa-row">
      <span className={`status-dot status-dot--${running ? "ok" : "bad"}`} />
      <div className="qa-name-wrap">
        <div className="qa-name-line">
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
          <span className="qa-host">{t.host}</span>
        </div>
        {live && (
          <span className="qa-live" title={`${live.app}: ${live.detail}`}>
            {live.detail}
          </span>
        )}
      </div>
      <div className="qa-stats">
        <span className="qa-stat">{cpu != null ? `${cpu}%` : "—"}</span>
        <span className="qa-stat">{ram != null ? formatBytes(ram) : "—"}</span>
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

function QuickActions({ pins, containers, onControl, onNavigate }) {
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
              />
            ))}
          </div>
        ))
      )}

      <div className="qa-group qa-group--nav">
        <button type="button" className="qa-btn" onClick={() => onNavigate("deploy")}>
          Deploy →
        </button>
        <button
          type="button"
          className="qa-btn"
          onClick={() => onNavigate("containers")}
        >
          Containers →
        </button>
      </div>
    </div>
  );
}

export default QuickActions;
