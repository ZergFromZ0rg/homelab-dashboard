import { useCallback, useEffect, useState } from "react";
import { fetchDevices, saveDevice } from "./piholeApi";
import { FILTERS, filterDevices, hiddenCount } from "./deviceFilter";
import { formatAge } from "./format";
import { useLocalStorage } from "./useLocalStorage";

// Every device Pi-hole has seen, one row per MAC. Click a row to name it,
// set its kind and add notes; those live here, not in Pi-hole. Servers are
// pinned at the top. Amber marks what you haven't identified yet.

const POLL_MS = 30000;
const SOURCES = {
  label: "your name",
  pihole: "comment in Pi-hole",
  static: "static lease",
  hostname: "hostname",
  vendor: "maker",
  mac: "no name known",
};

function Editor({ device, kinds, onSave, onCancel }) {
  const [name, setName] = useState(device.label);
  const [kind, setKind] = useState(device.kind_source === "label" ? device.kind : "");
  const [notes, setNotes] = useState(device.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(device.mac, { name, kind, notes });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <tr className="dev-editor">
      <td colSpan={8}>
        <form className="dev-form" onSubmit={submit}>
          <input
            className="deploy-input"
            value={name}
            maxLength={60}
            autoFocus
            placeholder={`Name (now: ${device.name})`}
            aria-label={`Name for ${device.mac}`}
            onChange={(e) => setName(e.target.value)}
          />
          <select className="deploy-input" value={kind} aria-label="Kind" onChange={(e) => setKind(e.target.value)}>
            <option value="">Kind: {device.kind} (automatic)</option>
            {kinds.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <input
            className="deploy-input dev-notes"
            value={notes}
            maxLength={300}
            placeholder="Notes"
            aria-label="Notes"
            onChange={(e) => setNotes(e.target.value)}
          />
          <button type="submit" className="btn btn--sm" disabled={busy}>Save</button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>Cancel</button>
          {error && <span className="dev-error">{error}</span>}
        </form>
      </td>
    </tr>
  );
}

function Row({ device, open, onToggle }) {
  const online = device.online;
  const dot = online === true ? "ok" : "off";
  const unidentified = device.kind === "unknown";
  return (
    <tr className={`dev-row ${open ? "dev-row--open" : ""}`} onClick={onToggle}>
      <td>
        <span
          className={`status-dot status-dot--${dot}`}
          title={online === true ? "Online" : online === false ? "Not seen lately" : "Doesn't use Pi-hole for DNS, so its state isn't known"}
        />
      </td>
      <td>
        <span className="dev-name" title={`Named from: ${SOURCES[device.name_source] || device.name_source}`}>{device.name}</span>
        {device.notes && <span className="dev-note" title={device.notes}> · {device.notes}</span>}
        {device.private_mac && (
          <span className="dev-tag dev-tag--warn" title="Uses a private (randomized) address, so it can't be identified by its maker">private MAC</span>
        )}
      </td>
      <td>
        <span className={`dev-kind ${unidentified ? "dev-kind--warn" : ""}`} title={device.kind_source ? `From: ${device.kind_source}` : "Not set yet"}>
          {device.kind}
        </span>
      </td>
      <td className="net-mono">
        {device.ip || "—"}
        {device.ip_type !== "dynamic" && <span className="dev-tag" title={device.ip_type === "static-lease" ? "Reserved in Pi-hole" : "Set on the device itself"}>static</span>}
      </td>
      <td className="net-dim">{device.vendor || "—"}</td>
      <td className="pcap-r net-mono">{device.queries_24h != null ? device.queries_24h.toLocaleString() : "—"}</td>
      <td className="pcap-r net-mono">{device.block_rate != null ? `${device.block_rate}%` : "—"}</td>
      <td className="net-dim">{device.last_seen ? formatAge(Date.now() / 1000 - device.last_seen) : "—"}</td>
    </tr>
  );
}

function DeviceTable() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useLocalStorage("piholeDeviceFilter", "all");
  const [showHidden, setShowHidden] = useLocalStorage("piholeDeviceHidden", false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await fetchDevices());
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const save = async (mac, fields) => {
    await saveDevice(mac, fields);
    setOpen(null);
    await load();
  };

  if (!data) return <p className="lan-empty">{error ? `Couldn't load devices: ${error}` : "Loading devices…"}</p>;

  const all = data.devices || [];
  const shown = filterDevices(all, { filter, showHidden, query });
  const hidden = hiddenCount(all);

  return (
    <div className="dev">
      <div className="dev-bar">
        <div className="hsys-tabs" role="tablist" aria-label="Device filter">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <input
          className="deploy-input dev-search"
          placeholder="Search name, IP, MAC…"
          value={query}
          aria-label="Search devices"
          onChange={(e) => setQuery(e.target.value)}
        />
        {hidden > 0 && (
          <label className="deploy-check" title="Pi-hole's own entries and devices not seen for a week">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show {hidden} hidden
          </label>
        )}
        {error && <span className="dev-error">Showing the last list ({error})</span>}
      </div>

      {shown.length === 0 ? (
        <p className="lan-empty">{all.length ? "No device matches." : "Pi-hole hasn't seen any devices yet."}</p>
      ) : (
        <div className="lan-scroll">
          <table className="net-table lan-table dev-table">
            <thead>
              <tr>
                <th aria-label="State" />
                <th>Name</th>
                <th>Kind</th>
                <th>Address</th>
                <th>Maker</th>
                <th className="pcap-r" title="DNS queries from this device today">Queries</th>
                <th className="pcap-r" title="Share of those Pi-hole blocked">Blocked</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {shown.flatMap((d) => [
                <Row key={d.mac} device={d} open={open === d.mac} onToggle={() => setOpen(open === d.mac ? null : d.mac)} />,
                open === d.mac && (
                  <Editor key={`${d.mac}-edit`} device={d} kinds={data.kinds || []} onSave={save} onCancel={() => setOpen(null)} />
                ),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default DeviceTable;
