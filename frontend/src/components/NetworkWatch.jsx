import { useCallback, useEffect, useState } from "react";
import { fetchAutoCapture, fetchWatch, saveAutoCapture, setWatch, tryAutoCapture } from "./watchApi";
import { formatAge } from "./format";

// Two opt-in watchers, off until switched on.
//
// Network watch: this host listens for ARP claims and DHCP replies — and only
// those; a kernel filter keeps everything else out — and says when the gateway's
// address changes hands, an address is claimed by two devices, or a second DHCP
// server answers. Warnings and worse become alerts (Overview, ntfy).
//
// Auto-capture: when a service check goes down, the dashboard takes a short,
// headers-only capture of that connection and keeps it under Saved captures.

const POLL_MS = 8000;
const SEVERITY = { bad: "Alert", warn: "Warning", info: "Info" };
const DURATIONS = [10, 20, 30, 60, 120];
const KEEPS = [3, 5, 10, 20, 30];

function Findings({ findings, now }) {
  if (!findings.length) {
    return <p className="lan-empty">Nothing has looked wrong. A new device on the network is listed here too, as information.</p>;
  }
  return (
    <div className="lan-scroll watch-findings">
      <table className="net-table lan-table pcap-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Level</th>
            <th>What</th>
            <th className="pcap-r" title="Times it was seen again">Seen</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.id} className={`watch-row watch-row--${f.severity}`}>
              <td className="net-dim" title={new Date(f.last * 1000).toLocaleString()}>{formatAge(now - f.last)}</td>
              <td><span className={`watch-level watch-level--${f.severity}`}>{SEVERITY[f.severity] || f.severity}</span></td>
              <td>
                <div className="watch-what">
                  <strong>{f.title}</strong>
                  <span className="watch-message">{f.message}</span>
                  {f.hint && <span className="watch-hint">{f.hint}</span>}
                </div>
              </td>
              <td className="net-mono net-dim pcap-r">{f.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AutoCapture({ host }) {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAutoCapture()
      .then((body) => alive && setSettings(body))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  const change = async (changes) => {
    setError("");
    try {
      setSettings(await saveAutoCapture(changes));
    } catch (e) {
      setError(e.message);
    }
  };

  const tryIt = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const made = await tryAutoCapture(host);
      setNote(`Kept “${made.name}” — ${made.packets.toLocaleString()} packets, under Packets → Saved captures.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <p className="lan-meta">{error || "Reading settings…"}</p>;
  return (
    <div className="watch-card">
      <div className="watch-head">
        <div>
          <strong>Auto-capture when a check goes down</strong>
          <p className="lan-meta">
            Takes a short capture of that check's own connection and keeps it as an <em>auto</em> capture. It starts once the
            check counts as down, so it records the failure continuing, not its first second. Headers only, never
            promiscuous, a few an hour, and only the newest are kept.
          </p>
        </div>
        <button
          type="button"
          className={`btn ${settings.enabled ? "btn--ghost" : "btn--primary"}`}
          aria-pressed={settings.enabled}
          onClick={() => change({ enabled: !settings.enabled })}
        >
          {settings.enabled ? "Turn off" : "Turn on"}
        </button>
      </div>
      <div className="lan-bar watch-options">
        <label className="pcap-option">
          Capture for
          <select value={settings.duration} onChange={(e) => change({ duration: Number(e.target.value) })}>
            {DURATIONS.map((s) => <option key={s} value={s}>{s} s</option>)}
          </select>
        </label>
        <label className="pcap-option">
          Keep the newest
          <select value={settings.keep} onChange={(e) => change({ keep: Number(e.target.value) })}>
            {KEEPS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className="pcap-spacer" />
        <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={tryIt} title={`Take one now on ${host}, to see what you would get`}>
          {busy ? `Capturing on ${host}…` : `Try it on ${host}`}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {note && <p className="lan-meta">{note}</p>}
    </div>
  );
}

function NetworkWatch({ host }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchWatch(host));
      setError("");
    } catch (e) {
      setError(e.message);
    }
    setNow(Date.now() / 1000);
  }, [host]);

  useEffect(() => {
    let alive = true;
    fetchWatch(host)
      .then((body) => alive && (setStatus(body), setNow(Date.now() / 1000)))
      .catch((e) => alive && setError(e.message));
    const timer = setInterval(() => alive && load(), POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [host, load]);

  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await setWatch(host, !status?.enabled));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const on = Boolean(status?.enabled);
  const trouble = (status?.active || []).length;

  return (
    <div className="lan watch">
      <div className="watch-card">
        <div className="watch-head">
          <div>
            <strong>Network watch on {host}</strong>
            <p className="lan-meta">
              Listens for ARP claims and DHCP replies — nothing else reaches it — and raises an alert when the gateway's address
              changes hands, two devices claim one address, or a second DHCP server answers. A new device is noted as information.
              It records no traffic.
            </p>
          </div>
          <button type="button" className={`btn ${on ? "btn--ghost" : "btn--primary"}`} disabled={busy || !status} aria-pressed={on} onClick={toggle}>
            {on ? "Turn off" : "Turn on"}
          </button>
        </div>

        {error && <p className="form-error">{error}</p>}

        {status && on && (
          <div className="pcap-stats watch-stats">
            <div className="pcap-stat">
              <span className={`pcap-state ${status.state === "watching" ? "pcap-state--capturing" : status.state === "error" ? "pcap-state--error" : ""}`}>
                {status.state === "watching" ? "● watching" : status.state === "error" ? "not running" : status.state}
              </span>
              <span className="net-dim">{status.iface || "—"}{status.gateway ? ` · gateway ${status.gateway}` : ""}</span>
            </div>
            <div className="pcap-stat"><strong className="net-mono">{status.devices.toLocaleString()}</strong><span className="net-dim">devices learned</span></div>
            <div className="pcap-stat">
              <strong className={`net-mono ${trouble ? "pcap-warn" : ""}`}>{trouble}</strong>
              <span className="net-dim">{trouble === 1 ? "alert active" : "alerts active"}</span>
            </div>
            <div className="pcap-stat" title={(status.dhcp_servers || []).map((s) => `${s.ip} ${s.mac || ""}`).join("\n")}>
              <strong className="net-mono">{(status.dhcp_servers || []).length}</strong>
              <span className="net-dim">DHCP server{(status.dhcp_servers || []).length === 1 ? "" : "s"} seen</span>
            </div>
          </div>
        )}
        {status && on && status.state === "error" && status.error && <p className="form-error">{status.error}</p>}
        {status && on && status.learning && (
          <p className="lan-meta">
            Learning the network: for the first few minutes devices are noted, not announced as new, and what it learns is kept
            across restarts.
          </p>
        )}
      </div>

      {on && status && <Findings findings={status.findings || []} now={now} />}
      {!on && status && !error && (
        <p className="lan-empty">
          Off. Turn it on to be told when something on the network starts impersonating your router or hands out addresses it
          shouldn't. Anything it finds is also an alert on the Overview, and on your phone if ntfy is set up.
        </p>
      )}

      <AutoCapture host={host} />
    </div>
  );
}

export default NetworkWatch;
