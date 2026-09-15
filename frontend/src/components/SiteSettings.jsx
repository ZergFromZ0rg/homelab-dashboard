import { useEffect, useMemo, useState } from "react";
import {
  useSettings,
  GRAPH_WINDOW_OPTIONS,
  HEARTBEAT_WINDOW_OPTIONS,
  HOME_CARD_OPTIONS,
} from "./settings";
import {
  getServiceActivityCredentialsStatus,
  putServiceActivityCredentials,
  clearServiceActivityCredentials,
} from "./serviceActivityCredentialsApi";

function splitPinKey(key) {
  const idx = key.indexOf("/");
  if (idx === -1) return { host: "", name: key };
  return { host: key.slice(0, idx), name: key.slice(idx + 1) };
}

// Keep in sync with backend/service_activity_credentials.REQUIRED_FIELDS.
const CREDENTIAL_APPS = [
  {
    app: "qbittorrent",
    label: "qBittorrent",
    why: "So the dashboard can log in and ask which torrents are actively transferring — that's what turns into the \"3 downloading, 5 seeding\" badge.",
    how: 'The same login you use for its Web UI. If you haven\'t set one: in qBittorrent, go to Settings → Web UI → set a username and password there first, then enter that same pair here.',
    fields: [
      { key: "username", label: "Username", type: "text" },
      { key: "password", label: "Password", type: "password" },
    ],
  },
  {
    app: "jellyfin",
    label: "Jellyfin",
    why: "So the dashboard can ask which sessions are actively playing something — that's what turns into the \"1 user streaming (name)\" badge.",
    how: "In Jellyfin: Dashboard → API Keys (under Advanced) → the + button → give it any name (e.g. \"homelab-dashboard\") → copy the key it generates and paste it here.",
    fields: [{ key: "api_key", label: "API key", type: "password" }],
  },
];

function emptyValues(fields) {
  return Object.fromEntries(fields.map((f) => [f.key, ""]));
}

function CredentialForm({ def, configured, onSave, onClear }) {
  const [values, setValues] = useState(() => emptyValues(def.fields));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const filled = def.fields
    .map((f) => [f.key, values[f.key].trim()])
    .filter(([, v]) => v);

  const save = async () => {
    if (filled.length === 0) return;
    setSaving(true);
    setError("");
    try {
      await onSave(def.app, Object.fromEntries(filled));
      setValues(emptyValues(def.fields));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(`Remove the stored ${def.label} credentials?`)) return;
    setSaving(true);
    setError("");
    try {
      await onClear(def.app);
      setValues(emptyValues(def.fields));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cred-row">
      <div className="cred-row-head">
        <span className="cred-app-name">{def.label}</span>
        <span className={`cred-status ${configured ? "cred-status--ok" : ""}`}>
          {configured ? "configured" : "not set"}
        </span>
      </div>
      {def.why && <p className="cred-why">{def.why}</p>}
      {def.how && <p className="cred-how">How to get it: {def.how}</p>}
      <div className="cred-fields">
        {def.fields.map((f) => (
          <input
            key={f.key}
            type={f.type}
            autoComplete="off"
            placeholder={configured ? `New ${f.label.toLowerCase()}` : f.label}
            value={values[f.key]}
            onChange={(e) =>
              setValues((v) => ({ ...v, [f.key]: e.target.value }))
            }
          />
        ))}
        <button
          type="button"
          className="qa-btn"
          disabled={filled.length === 0 || saving}
          onClick={save}
        >
          {saving ? "…" : "Save"}
        </button>
        {configured && (
          <button
            type="button"
            className="qa-btn"
            disabled={saving}
            onClick={clear}
          >
            Clear
          </button>
        )}
      </div>
      {error && <p className="cred-error">{error}</p>}
    </div>
  );
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

  const [credentialsConfigured, setCredentialsConfigured] = useState({});

  useEffect(() => {
    let cancelled = false;
    getServiceActivityCredentialsStatus()
      .then((configured) => {
        if (!cancelled) setCredentialsConfigured(configured);
      })
      .catch((error) => {
        console.error("Failed to load live-activity credential status:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
        <label className="settings-row">
          <span>Heartbeat window</span>
          <select
            value={settings.heartbeatWindowMinutes}
            onChange={(e) =>
              update({ heartbeatWindowMinutes: Number(e.target.value) })
            }
          >
            {HEARTBEAT_WINDOW_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          How far back the up/down heartbeat bar on each container row
          looks — a shorter window means each bar covers less time, so a
          brief blip is easier to spot.
        </p>

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
          Matched automatically by image name.
        </p>

        <label className="settings-row">
          <span>Restart-loop threshold</span>
          <input
            className="deploy-input"
            style={{ width: "60px" }}
            type="number"
            min="1"
            step="1"
            value={settings.highRestartCount}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value >= 1) {
                update({ highRestartCount: Math.round(value) });
              }
            }}
          />
        </label>
        <p className="settings-hint">
          A container with at least this many restarts (or a failing
          healthcheck) floats to the top of its host group with a red edge
          marker.
        </p>
      </SettingsCard>

      <SettingsCard title="Live-activity credentials">
        <p className="settings-hint">
          Needed for the badges above to work. Saved on the backend
          (`/data/service_activity_credentials.json`) — a
          QBITTORRENT_USERNAME/PASSWORD or JELLYFIN_API_KEY env var still
          works too and is used if nothing's set here.
        </p>
        {CREDENTIAL_APPS.map((def) => (
          <CredentialForm
            key={def.app}
            def={def}
            configured={Boolean(credentialsConfigured[def.app])}
            onSave={async (app, fields) => {
              const configured = await putServiceActivityCredentials(
                app,
                fields
              );
              setCredentialsConfigured(configured);
            }}
            onClear={async (app) => {
              const configured = await clearServiceActivityCredentials(app);
              setCredentialsConfigured(configured);
            }}
          />
        ))}
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
