import { useCallback, useEffect, useState } from "react";
import Sparkline from "./Sparkline";
import { allowDomain, fetchDeviceDetail, markKnown, saveDevice, setDeviceGroup, unallowDomain } from "./piholeApi";
import { formatDuration, formatWhen } from "./format";

// One device, opened from the table: its day as a line, what it asks for and
// what gets refused, the latest queries, and the buttons that change things.
// Allowing a domain is for every device, so it asks first and can be undone.


// "Special" domains (iCloud Private Relay, Firefox's canary domain) are refused
// on purpose by a Pi-hole setting; the allow list can't lift them.
function Special() {
  return (
    <span className="net-dim" title="Pi-hole refuses this on purpose (for example iCloud Private Relay). The allow list doesn't change it; it's a setting in Pi-hole.">
      special
    </span>
  );
}

function Allow({ domain }) {
  const [state, setState] = useState("idle"); // idle | ask | busy | done
  const [error, setError] = useState("");

  const run = async (fn, next) => {
    setState("busy");
    setError("");
    try {
      await fn(domain);
      setState(next);
    } catch (e) {
      setError(e.message);
      setState(next === "done" ? "ask" : "done");
    }
  };

  if (state === "done") {
    return (
      <span className="dd-allow">
        <span className="net-dim">Allowed</span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => run(unallowDomain, "idle")}>Undo</button>
      </span>
    );
  }
  if (state === "ask" || state === "busy") {
    return (
      <span className="dd-allow">
        <span className="net-dim" title="The allow list applies to every device">For everyone?</span>
        <button type="button" className="btn btn--sm" disabled={state === "busy"} onClick={() => run(allowDomain, "done")}>Allow</button>
        <button type="button" className="btn btn--sm btn--ghost" disabled={state === "busy"} onClick={() => setState("idle")}>No</button>
        {error && <span className="dev-error" title={error}>failed</span>}
      </span>
    );
  }
  return (
    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setState("ask")} title={`Let ${domain} through`}>
      Allow
    </button>
  );
}

function Label({ device, kinds, onSaved }) {
  const [name, setName] = useState(device.label);
  const [kind, setKind] = useState(device.kind_source === "label" ? device.kind : "");
  const [notes, setNotes] = useState(device.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="dd-form"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveDevice(device.mac, { name, kind, notes }));
      }}
    >
      <input className="deploy-input" value={name} maxLength={60} placeholder={`Name (now: ${device.name})`} aria-label="Name" onChange={(e) => setName(e.target.value)} />
      <select className="deploy-input" value={kind} aria-label="Kind" onChange={(e) => setKind(e.target.value)}>
        <option value="">Kind: {device.kind} (automatic)</option>
        {kinds.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      <input className="deploy-input" value={notes} maxLength={300} placeholder="Notes" aria-label="Notes" onChange={(e) => setNotes(e.target.value)} />
      <div className="dd-actions">
        <button type="submit" className="btn btn--sm" disabled={busy}>Save</button>
        {device.new && (
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => run(() => markKnown(device.mac))} title="You know what this is: stop flagging it as new">
            Mark known
          </button>
        )}
        {error && <span className="dev-error">{error}</span>}
      </div>
    </form>
  );
}

function Group({ device, groups, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ids = device.group_ids || [];
  const change = async (value) => {
    setBusy(true);
    setError("");
    try {
      await setDeviceGroup(device.mac, Number(value));
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dd-group">
      <span className="net-dim" title="Which Pi-hole group the device is in decides which blocklists apply. Put it in no-blocking to stop blocking for it alone.">
        Blocking group
      </span>
      <select
        className="deploy-input"
        disabled={busy}
        value={ids.length === 1 ? ids[0] : ""}
        aria-label="Blocking group"
        onChange={(e) => change(e.target.value)}
      >
        {ids.length !== 1 && <option value="" disabled>{ids.length ? "several groups" : "not set"}</option>}
        {groups.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
      {error && <span className="dev-error">{error}</span>}
    </div>
  );
}

function DeviceDetail({ mac, row, kinds, groups, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await fetchDeviceDetail(mac));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [mac]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const saved = async () => {
    await onSaved();
    await load();
  };

  const device = row;
  const detail = data?.detail;
  const series = detail?.series || [];

  return (
    <aside className="dd" aria-label={`Details for ${device.name}`}>
      <div className="dd-head">
        <div>
          <strong>{device.name}</strong>
          <span className="net-mono net-dim"> {device.mac}</span>
        </div>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose} aria-label="Close details">×</button>
      </div>

      <div className="dd-facts net-dim">
        {device.ip || "no address"} · {device.vendor || (device.private_mac ? "private (randomized) MAC" : "maker unknown")}
        {device.private_mac && device.vendor ? " · private MAC" : ""}
      </div>

      <Group device={device} groups={groups} onSaved={saved} />

      <section className="dd-section">
        <h4>Queries today</h4>
        {error ? (
          <p className="dev-error">{error}</p>
        ) : !data ? (
          <p className="net-dim">Reading Pi-hole…</p>
        ) : series.length ? (
          <>
            <Sparkline points={series} variant="rx" height={40} />
            <div className="sparkline-axis"><span>24h ago</span><span>now</span></div>
          </>
        ) : (
          <p className="net-dim">{detail ? "Too quiet for Pi-hole to chart on its own." : "No address to look up."}</p>
        )}
      </section>

      {detail && (
        <>
          <section className="dd-section">
            <h4>
              Most blocked{" "}
              <span className="net-dim">
                · its last {detail.sample} queries{detail.since ? `, ${formatDuration(Date.now() / 1000 - detail.since)}` : ""}
              </span>
            </h4>
            {detail.top_blocked.length === 0 ? (
              <p className="net-dim">Nothing blocked.</p>
            ) : (
              <ul className="dd-list">
                {detail.top_blocked.slice(0, 6).map((d) => (
                  <li key={d.domain}>
                    <span className="dd-domain" title={d.domain}>{d.domain}</span>
                    <span className="net-mono net-dim">{d.count}×</span>
                    {d.allowable ? <Allow domain={d.domain} /> : <Special />}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="dd-section">
            <h4>Latest queries</h4>
            <ul className="dd-list dd-recent">
              {detail.recent.slice(0, 20).map((q, i) => (
                <li key={`${q.time}-${i}`} className={q.blocked ? "dd-blocked" : ""}>
                  <span className="net-mono net-dim">{formatWhen(q.time)}</span>
                  <span className="dd-domain" title={`${q.domain} · ${q.status}`}>{q.domain}</span>
                  {q.allowable ? <Allow domain={q.domain} /> : q.blocked ? <Special /> : <span className="net-dim">{q.status?.toLowerCase().replace("_", " ")}</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <section className="dd-section">
        <h4>Label</h4>
        <Label key={device.mac + device.label + device.kind + device.notes} device={device} kinds={kinds} onSaved={saved} />
      </section>
    </aside>
  );
}

export default DeviceDetail;
