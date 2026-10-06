import { useState } from "react";

const TYPES = [
  { value: "http", label: "Website / API", hint: "GET a URL and expect a healthy answer." },
  {
    value: "keyword",
    label: "Website + text",
    hint: "Like Website / API, and the page must also contain some text — catches an error page served with a 200.",
  },
  {
    value: "ping",
    label: "Ping",
    hint: "One ICMP echo (IPv4). Some hosts and networks drop ping — use a Port check if that's yours.",
  },
  { value: "tcp", label: "Port", hint: "Open a TCP connection to host:port." },
  { value: "dns", label: "DNS lookup", hint: "Resolve a hostname." },
  {
    value: "tls",
    label: "Certificate",
    hint: "Goes red when the HTTPS certificate is about to expire (or already has) — the thing that works until the day it doesn't.",
  },
];

const TARGET_HELP = {
  http: { placeholder: "192.168.1.10:8096 or https://jellyfin.example.com", label: "Address" },
  keyword: { placeholder: "192.168.1.10:8096 or https://jellyfin.example.com", label: "Address" },
  ping: { placeholder: "192.168.1.1 or router.local", label: "Host or IP" },
  tcp: { placeholder: "192.168.1.10:22", label: "Host and port" },
  dns: { placeholder: "example.com", label: "Hostname" },
  tls: { placeholder: "example.com or 192.168.1.10:8443", label: "Host (and port, default 443)" },
};

const isWeb = (type) => type === "http" || type === "keyword";
const usesTls = (type) => isWeb(type) || type === "tls";

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
    keyword: check?.keyword ?? "",
    keyword_mode: check?.keyword_mode ?? "present",
    warn_days: check?.warn_days ?? 14,
    slow_ms: check?.slow_ms ?? "",
    parent: check?.parent ?? "",
    group: check?.group ?? "",
  };
}

// Add a check, or edit `check` when given. The backend validates and
// normalizes the address (a bare LAN address becomes http://...), so this
// only has to send what was typed.
function CheckForm({ check, onSubmit, onCancel, others = [], groups = [] }) {
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
        expect_status: isWeb(values.type) && values.expect_status !== "" ? Number(values.expect_status) : null,
        keyword: values.type === "keyword" ? values.keyword : null,
        warn_days: values.type === "tls" ? Number(values.warn_days) : null,
        slow_ms: values.slow_ms === "" ? null : Number(values.slow_ms),
        parent: values.parent || null,
        group: values.group.trim() || null,
      });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const help = TARGET_HELP[values.type];
  const typeHint = TYPES.find((t) => t.value === values.type)?.hint;

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
            onClick={() =>
              set({
                type: t.value,
                // A certificate changes over weeks: look hourly, not every minute.
                ...(!check && values.interval === (values.type === "tls" ? 3600 : 60)
                  ? { interval: t.value === "tls" ? 3600 : 60 }
                  : {}),
              })
            }
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
      </div>

      <p className="settings-hint check-type-hint">{typeHint}</p>

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

      {values.type === "keyword" && (
        <div className="check-keyword">
          <label className="deploy-field">
            <span className="deploy-label">Text to look for</span>
            <input
              className="deploy-input"
              value={values.keyword}
              maxLength={200}
              placeholder="Jellyfin"
              onChange={(e) => set({ keyword: e.target.value })}
              required
            />
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={values.keyword_mode === "absent"}
              onChange={(e) => set({ keyword_mode: e.target.checked ? "absent" : "present" })}
            />
            Fail if this text <em>is</em> on the page (e.g. "error") instead of when it's missing
          </label>
          <p className="settings-hint">
            Not case-sensitive. Looks in the first 512 KB of the page. Latency
            is the time to download it.
          </p>
        </div>
      )}

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
          <label className="deploy-field">
            <span className="deploy-label">Slow above (ms, blank = never)</span>
            <input
              className="deploy-input"
              type="number"
              min="1"
              max="60000"
              value={values.slow_ms}
              placeholder="300"
              title="Answering slower than this for two checks in a row marks it slow — still up, but flagged"
              onChange={(e) => set({ slow_ms: e.target.value })}
            />
          </label>
          <label className="deploy-field">
            <span className="deploy-label">Group</span>
            <input
              className="deploy-input"
              list="check-groups"
              value={values.group}
              maxLength={40}
              placeholder="Network, bigboy…"
              onChange={(e) => set({ group: e.target.value })}
            />
            <datalist id="check-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          {others.length > 0 && (
            <label className="deploy-field">
              <span className="deploy-label">Depends on</span>
              <select
                className="deploy-input"
                value={values.parent}
                title="While that check is down, this one is shown as 'behind' it and doesn't alert on its own"
                onChange={(e) => set({ parent: e.target.value })}
              >
                <option value="">Nothing</option>
                {others
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {values.type === "tls" && (
            <label className="deploy-field">
              <span className="deploy-label">Warn when fewer than (days) are left</span>
              <input
                className="deploy-input"
                type="number"
                min="1"
                max="365"
                value={values.warn_days}
                onChange={(e) => set({ warn_days: e.target.value })}
              />
            </label>
          )}
          {usesTls(values.type) && (
            <label className="settings-check check-form-tls">
              <input
                type="checkbox"
                checked={!values.verify_tls}
                onChange={(e) => set({ verify_tls: !e.target.checked })}
              />
              Accept a self-signed certificate
            </label>
          )}
          {isWeb(values.type) && (
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
            </>
          )}
        </div>
      )}

      <p className="settings-hint">
        Checks run from the dashboard's own container, so use the address the
        dashboard can reach — for something on the same machine that's its
        LAN address, not <code>localhost</code>.
      </p>


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
