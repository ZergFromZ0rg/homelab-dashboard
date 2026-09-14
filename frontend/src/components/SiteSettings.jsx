import { useMemo, useState } from "react";
import {
  useSettings,
  GRAPH_WINDOW_OPTIONS,
  HOME_CARD_OPTIONS,
  LIVE_ACTIVITY_OVERRIDE_OPTIONS,
} from "./settings";

function splitPinKey(key) {
  const idx = key.indexOf("/");
  if (idx === -1) return { host: "", name: key };
  return { host: key.slice(0, idx), name: key.slice(idx + 1) };
}

// Mirrors backend/service_activity._PROBES — just for the "auto: X" hint
// next to each override row, not used to decide anything.
function autoMatchLabel(image) {
  const img = (image || "").toLowerCase();
  if (img.includes("qbittorrent")) return "qBittorrent";
  if (img.includes("jellyfin")) return "Jellyfin";
  return null;
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

function SiteSettings({
  pins,
  containers,
  serviceActivityOverrides,
  onSetServiceActivityOverrides,
}) {
  const { settings, update, reset } = useSettings();
  const [overrideFilter, setOverrideFilter] = useState("");

  const allContainers = useMemo(() => {
    const list = [];
    for (const [host, conts] of Object.entries(containers || {})) {
      for (const c of conts) {
        list.push({ key: `${host}/${c.name}`, host, name: c.name, image: c.image });
      }
    }
    return list.sort(
      (a, b) => a.host.localeCompare(b.host) || a.name.localeCompare(b.name)
    );
  }, [containers]);

  const filteredContainers = useMemo(() => {
    const needle = overrideFilter.trim().toLowerCase();
    if (!needle) return allContainers;
    return allContainers.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.host.toLowerCase().includes(needle) ||
        (c.image || "").toLowerCase().includes(needle)
    );
  }, [allContainers, overrideFilter]);

  const setOverride = (key, value) => {
    const next = { ...serviceActivityOverrides };
    if (value) next[key] = value;
    else delete next[key];
    onSetServiceActivityOverrides(next);
  };

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

        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.showLiveActivity}
            onChange={(e) => update({ showLiveActivity: e.target.checked })}
          />
          Show live-activity badges
        </label>
        <p className="settings-hint">
          For containers the backend knows how to ask (currently
          qBittorrent, Jellyfin) — e.g. "2 downloading" or "1 user
          streaming" — shown on the container row and in Quick Actions.
          Needs credentials set on the backend (QBITTORRENT_USERNAME /
          JELLYFIN_API_KEY, see .env.example).
        </p>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.showResourceActivity}
            onChange={(e) =>
              update({ showResourceActivity: e.target.checked })
            }
          />
          Include resource-spike guesses as a fallback
        </label>
        <p className="settings-hint">
          When a container has no app-specific answer (no probe for it, no
          credentials, or the API check failed), flag it as "busy" — amber
          badge, not green — when its CPU or network use spikes well above
          its own recent baseline. Works for any container, no credentials
          needed, but it's a guess (a backup job would also look "busy").
        </p>
      </SettingsCard>

      <SettingsCard title="Live-activity overrides">
        <p className="settings-hint">
          Containers are probed by image name automatically. Override one
          here to force it to a specific app (a custom/renamed image, or
          to pick one instance if you run more than one) or turn probing
          off for it entirely — including the resource-spike fallback
          above — applies fleet-wide, the same on every browser.
        </p>

        {allContainers.length === 0 ? (
          <p className="overview-empty">No containers reporting yet.</p>
        ) : (
          <>
            <input
              type="text"
              className="settings-override-filter"
              placeholder="Filter by name, image, or host…"
              value={overrideFilter}
              onChange={(e) => setOverrideFilter(e.target.value)}
            />
            <div className="settings-override-rows">
              {filteredContainers.map((c) => {
                const detected = autoMatchLabel(c.image);
                return (
                  <div className="settings-override-row" key={c.key}>
                    <span
                      className="settings-override-name"
                      title={`${c.name} · ${c.host} · ${c.image || ""}`}
                    >
                      {c.name}
                      <span className="settings-override-host">{c.host}</span>
                    </span>
                    <span className="settings-override-detected">
                      {detected ? `auto: ${detected}` : ""}
                    </span>
                    <select
                      value={serviceActivityOverrides[c.key] || ""}
                      onChange={(e) => setOverride(c.key, e.target.value)}
                    >
                      {LIVE_ACTIVITY_OVERRIDE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
              {filteredContainers.length === 0 && (
                <p className="overview-empty">
                  No containers match "{overrideFilter}".
                </p>
              )}
            </div>
          </>
        )}
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
