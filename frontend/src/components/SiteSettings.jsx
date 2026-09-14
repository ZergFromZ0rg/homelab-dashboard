import { useMemo } from "react";
import {
  useSettings,
  GRAPH_WINDOW_OPTIONS,
  HOME_CARD_OPTIONS,
} from "./settings";

function splitPinKey(key) {
  const idx = key.indexOf("/");
  if (idx === -1) return { host: "", name: key };
  return { host: key.slice(0, idx), name: key.slice(idx + 1) };
}

function SettingsCard({ title, children }) {
  return (
    <section className="overview-card">
      <div className="overview-card-head">
        <h2>{title}</h2>
      </div>
      <div className="overview-card-body">{children}</div>
    </section>
  );
}

function SiteSettings({ pins, containers }) {
  const { settings, update, reset } = useSettings();

  const pinnedList = useMemo(
    () =>
      pins
        .map((key) => {
          const { host, name } = splitPinKey(key);
          const running = (containers[host] || []).some(
            (c) => c.name === name && c.status === "running"
          );
          return { key, host, name, running };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    [pins, containers]
  );

  const existingGroups = useMemo(() => {
    const set = new Set(Object.values(settings.pinGroups).filter(Boolean));
    return [...set].sort();
  }, [settings.pinGroups]);

  const setHomeCard = (key, value) =>
    update({ homeCards: { ...settings.homeCards, [key]: value } });

  const setPinGroup = (key, label) => {
    const next = { ...settings.pinGroups };
    if (label) next[key] = label;
    else delete next[key];
    update({ pinGroups: next });
  };

  return (
    <div className="settings-tab">
      <SettingsCard title="Graphs">
        <label className="settings-row">
          <span>Time window</span>
          <select
            value={settings.graphWindowMinutes}
            onChange={(e) =>
              update({ graphWindowMinutes: Number(e.target.value) })
            }
          >
            {GRAPH_WINDOW_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          How much history the CPU / RAM / network / temperature graphs on
          the System Stats tab show.
        </p>
      </SettingsCard>

      <SettingsCard title="Containers">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.showContainerUptime}
            onChange={(e) =>
              update({ showContainerUptime: e.target.checked })
            }
          />
          Show container uptime
        </label>
        <p className="settings-hint">
          Hides the UPTIME stat on each container row in the Containers tab.
        </p>
      </SettingsCard>

      <SettingsCard title="Home menu">
        <p className="settings-hint">
          Choose which cards show on the Overview tab.
        </p>
        <div className="settings-checklist">
          {HOME_CARD_OPTIONS.map((opt) => (
            <label className="settings-check" key={opt.key}>
              <input
                type="checkbox"
                checked={settings.homeCards[opt.key]}
                onChange={(e) => setHomeCard(opt.key, e.target.checked)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title="Quick actions">
        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.quickActionLinks}
            onChange={(e) => update({ quickActionLinks: e.target.checked })}
          />
          Link container name to its web UI
        </label>

        <p className="settings-hint">
          Group pinned containers on the Overview tab by giving them the
          same label (e.g. "Media").
        </p>

        {pinnedList.length === 0 ? (
          <p className="overview-empty">
            Pin a container (★ on its row in the Containers tab) to group it
            here.
          </p>
        ) : (
          <div className="settings-pin-groups">
            {pinnedList.map((p) => (
              <div className="settings-pin-row" key={p.key}>
                <span
                  className={`status-dot status-dot--${p.running ? "ok" : "bad"}`}
                />
                <span className="settings-pin-name" title={`${p.name} · ${p.host}`}>
                  {p.name}
                </span>
                <input
                  type="text"
                  list="settings-pin-groups-list"
                  placeholder="Group (e.g. Media)"
                  value={settings.pinGroups[p.key] || ""}
                  onChange={(e) => setPinGroup(p.key, e.target.value)}
                />
              </div>
            ))}
            <datalist id="settings-pin-groups-list">
              {existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
        )}
      </SettingsCard>

      <div className="settings-reset">
        <button
          type="button"
          className="qa-btn"
          onClick={() => {
            if (window.confirm("Reset all site customization to defaults?")) {
              reset();
            }
          }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

export default SiteSettings;
