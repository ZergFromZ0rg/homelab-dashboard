import { useState } from "react";
import TokenBox from "./TokenBox";

const TYPES = [
  { value: "http", label: "Website / API", hint: "GET a URL and expect a healthy answer." },
  { value: "tcp", label: "Port", hint: "Open a TCP connection to host:port." },
  { value: "dns", label: "DNS lookup", hint: "Resolve a hostname." },
];

const TARGET_HELP = {
  http: { placeholder: "192.168.1.10:8096 or https://jellyfin.example.com", label: "Address" },
  tcp: { placeholder: "192.168.1.10:22", label: "Host and port" },
  dns: { placeholder: "example.com", label: "Hostname" },
};

// One-click starting points for the two checks everyone wants.
const PRESETS = [
  { name: "Internet", type: "tcp", target: "1.1.1.1:443" },
  { name: "DNS", type: "dns", target: "example.com" },
];

function blank(check) {
  return {
    name: check?.name ?? "",
    type: check?.type ?? "http",
    target: check?.target ?? "",
    interval: check?.interval ?? 60,
    timeout: check?.timeout ?? 5,
    expect_status: check?.expect_status ?? "",
    verify_tls: check?.verify_tls ?? true,
  };
}

// Add a check, or edit `check` when given. The backend validates and
// normalizes the address (a bare LAN address becomes http://...), so this
// only has to send what was typed.
function CheckForm({ check, onSubmit, onCancel }) {
  const [values, setValues] = useState(() => blank(check));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(Boolean(check));

  const set = (patch) => {
    setValues((v) => ({ ...v, ...patch }));
    setError("");
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        ...values,
        interval: Number(values.interval),
        timeout: Number(values.timeout),
        expect_status: values.type === "http" && values.expect_status !== "" ? Number(values.expect_status) : null,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const help = TARGET_HELP[values.type];

  return (
    <form className="check-form" onSubmit={submit}>
      {!check && (
        <div className="check-presets">
          <span>Quick add:</span>
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="btn btn--sm"
              onClick={() => set({ ...p, interval: 60, timeout: 5 })}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      <div className="segmented" role="group" aria-label="Check type">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            className={values.type === t.value ? "active" : ""}
            aria-pressed={values.type === t.value}
            onClick={() => set({ type: t.value })}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="check-form-grid">
        <label className="deploy-field">
          <span className="deploy-label">Name</span>
          <input
            className="deploy-input"
            value={values.name}
            maxLength={60}
            placeholder="Jellyfin"
            onChange={(e) => set({ name: e.target.value })}
            required
          />
        </label>
        <label className="deploy-field">
          <span className="deploy-label">{help.label}</span>
          <input
            className="deploy-input"
            value={values.target}
            placeholder={help.placeholder}
            onChange={(e) => set({ target: e.target.value })}
            required
          />
        </label>
      </div>

      <button
        type="button"
        className="btn btn--sm btn--ghost check-form-toggle"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
      >
        {advanced ? "Hide options" : "More options"}
      </button>

      {advanced && (
        <div className="check-form-grid">
          <label className="deploy-field">
            <span className="deploy-label">Check every (seconds)</span>
            <input
              className="deploy-input"
              type="number"
              min="10"
              max="3600"
              value={values.interval}
              onChange={(e) => set({ interval: e.target.value })}
            />
          </label>
          <label className="deploy-field">
            <span className="deploy-label">Give up after (seconds)</span>
            <input
              className="deploy-input"
              type="number"
              min="1"
              max="30"
              step="0.5"
              value={values.timeout}
              onChange={(e) => set({ timeout: e.target.value })}
            />
          </label>
          {values.type === "http" && (
            <>
              <label className="deploy-field">
                <span className="deploy-label">Expected status (blank = any below 400)</span>
                <input
                  className="deploy-input"
                  type="number"
                  min="100"
                  max="599"
                  value={values.expect_status}
                  placeholder="200"
                  onChange={(e) => set({ expect_status: e.target.value })}
                />
              </label>
              <label className="settings-check check-form-tls">
                <input
                  type="checkbox"
                  checked={!values.verify_tls}
                  onChange={(e) => set({ verify_tls: !e.target.checked })}
                />
                Accept a self-signed certificate
              </label>
            </>
          )}
        </div>
      )}

      <p className="settings-hint">
        Checks run from the dashboard's own container, so use the address the
        dashboard can reach — for something on the same machine that's its
        LAN address, not <code>localhost</code>.
      </p>

      <TokenBox />

      {error && <p className="cred-error">{error}</p>}

      <div className="check-form-actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Saving…" : check ? "Save changes" : "Add check"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default CheckForm;
