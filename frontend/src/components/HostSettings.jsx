import { useState } from "react";
import { fetchHostConfig, saveHostConfig } from "./hostConfigApi";

// One host's agent settings, on that host's card.
//
// Here rather than in a global Settings page because these belong to a
// machine, not to the dashboard: "which directories may bigboy back up"
// is a fact about bigboy, and reading it next to bigboy's disks and
// containers is how you decide it.
//
// Settings the container fixed at startup — a bind mount, the runtime —
// are shown greyed with the reason. Hiding them would send someone
// hunting for a switch that isn't there; pretending they are editable
// would be worse.

function Field({ setting, value, onChange, disabled }) {
  const { kind, key, label, help, danger } = setting;
  const locked = disabled || !setting.editable;

  if (kind === "bool") {
    return (
      <label className={`hs-field hs-field--check ${danger ? "hs-danger" : ""}`}>
        <input
          type="checkbox"
          checked={value === "1"}
          disabled={locked}
          onChange={(e) => onChange(key, e.target.checked ? "1" : "")}
        />
        <span>
          <strong>{label}</strong>
          <em>{help}</em>
        </span>
      </label>
    );
  }

  return (
    <label className="hs-field">
      <strong>{label}</strong>
      <input
        type={kind === "secret" ? "password" : kind === "number" ? "number" : "text"}
        value={value}
        disabled={locked}
        placeholder={
          kind === "secret" && setting.set
            ? "set — type to replace"
            : kind === "paths"
              ? "/home/you/stack, /srv/data"
              : ""
        }
        onChange={(e) => onChange(key, e.target.value)}
      />
      <em>{help}</em>
    </label>
  );
}

function HostSettings({ host }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({});
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const body = await fetchHostConfig(host);
      setData(body);
      setEdits({});
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Fetched on the click, like the Connections panel: the click is the
  // trigger, and most of the time nobody is looking at this.
  function toggle() {
    if (!open && data === null && !busy) load();
    setOpen(!open);
  }

  const settings = data?.settings || [];
  const groups = [...new Set(settings.map((s) => s.group))];
  const valueOf = (s) => (edits[s.key] !== undefined ? edits[s.key] : s.value);
  const dirty = Object.keys(edits).length > 0;

  const change = (key, value) => {
    setSaved(null);
    setEdits((was) => ({ ...was, [key]: value }));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await saveHostConfig(host, edits);
      setData({ ...data, settings: out.settings || settings });
      setEdits({});
      setSaved(
        out.applied?.length
          ? `Saved ${out.applied.length} setting${out.applied.length > 1 ? "s" : ""}.`
          : "Nothing changed."
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conn-panel">
      <button
        type="button"
        className={`conn-toggle ${open ? "expanded" : ""}`}
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="host-toggle">▾</span>
        SETTINGS
        {data && !data.writable && <span className="conn-count">read-only</span>}
      </button>

      {open && (
        <div className="host-settings">
          {busy && !data && <p className="settings-hint">Reading {host}…</p>}
          {error && <p className="form-error">{error}</p>}

          {data && !data.writable && (
            <p className="hs-locked">{data.why_not}</p>
          )}

          {groups.map((group) => (
            <div key={group} className="hs-group">
              <h4>{group}</h4>
              {settings
                .filter((s) => s.group === group)
                .map((s) => (
                  <div key={s.key}>
                    <Field
                      setting={s}
                      value={valueOf(s)}
                      onChange={change}
                      disabled={busy}
                    />
                    {s.scope === "host" && (
                      <p className="hs-host-scope">
                        Set where the container starts — {s.source === "unset"
                          ? "not set"
                          : `currently from the ${s.source}`}
                        . Change it in this host's <code>.env</code> and
                        recreate the agent.
                      </p>
                    )}
                  </div>
                ))}
            </div>
          ))}

          {data?.writable && (
            <div className="hs-actions">
              <button
                type="button"
                className="btn"
                disabled={!dirty || busy}
                onClick={save}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              {dirty && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => setEdits({})}
                >
                  Discard
                </button>
              )}
              {saved && <span className="hs-saved">{saved}</span>}
              <span className="settings-hint">
                Applies immediately — nothing restarts.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default HostSettings;
