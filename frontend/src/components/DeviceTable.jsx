import { useCallback, useEffect, useState } from "react";
import { fetchDevices } from "./piholeApi";
import DeviceDetail from "./DeviceDetail";
import { FILTERS, filterDevices, hiddenCount } from "./deviceFilter";
import { formatAge } from "./format";
import { formatLinkSpeed, speedHint, speedTone } from "./switchApi";
import { useLocalStorage } from "./useLocalStorage";

// Every device Pi-hole has seen, one row per MAC. Click a row to open it:
// its day, what it asks for and what gets blocked, and the controls — name,
// kind, notes (kept here, not in Pi-hole) and its blocking group. Servers
// are pinned at the top. Amber marks what you haven't identified yet.

const POLL_MS = 30000;
const SOURCES = {
  label: "your name",
  pihole: "comment in Pi-hole",
  static: "static lease",
  hostname: "hostname",
  vendor: "maker",
  mac: "no name known",
};

function Row({ device, open, onToggle }) {
  const online = device.online;
  const dot = online === true ? "ok" : "off";
  const unidentified = device.kind === "unknown";
  return (
    <tr className={`dev-row ${open ? "dev-row--open" : ""} ${device.new ? "dev-row--new" : ""}`} onClick={onToggle} aria-selected={open}>
      <td>
        <span
          className={`status-dot status-dot--${dot}`}
          title={online === true ? "Online" : online === false ? "Not seen lately" : "Doesn't use Pi-hole for DNS, so its state isn't known"}
        />
      </td>
      <td>
        <span className="dev-name" title={`Named from: ${SOURCES[device.name_source] || device.name_source}`}>{device.name}</span>
        {device.notes && <span className="dev-note" title={device.notes}> · {device.notes}</span>}
        {device.new && <span className="dev-tag dev-tag--warn" title="Joined the network recently and nobody has named it yet">new</span>}
        {device.port && (
          <span
            className={`dev-tag ${speedTone(device.port) === "bad" ? "dev-tag--warn" : ""}`}
            title={`Switch port ${device.port.port}${device.port.up ? "" : " (no link)"}. ${speedHint(device.port)}`}
          >
            {device.port.port} · {device.port.up ? formatLinkSpeed(device.port.speed_mbps) : "down"}
          </span>
        )}
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
        {device.ip_type !== "dynamic" && <span className="dev-tag" title="Reserved in Pi-hole">static</span>}
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

  if (!data) return <p className="lan-empty">{error ? `Couldn't load devices: ${error}` : "Loading devices…"}</p>;

  const all = data.devices || [];
  const shown = filterDevices(all, { filter, showHidden, query });
  const hidden = hiddenCount(all);
  const openRow = open ? all.find((d) => d.mac === open) : null;

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
          <label className="deploy-check" title="Devices not seen for a week">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show {hidden} hidden
          </label>
        )}
        {error && <span className="dev-error">Showing the last list ({error})</span>}
      </div>

      <div className={`dev-layout ${openRow ? "dev-layout--open" : ""}`}>
        {shown.length === 0 ? (
          <p className="lan-empty">{all.length ? "No device matches." : "Pi-hole hasn't seen any devices yet."}</p>
        ) : (
          <div className="lan-scroll dev-scroll">
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
                {shown.map((d) => (
                  <Row key={d.mac} device={d} open={open === d.mac} onToggle={() => setOpen(open === d.mac ? null : d.mac)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {openRow && (
          <DeviceDetail
            key={openRow.mac}
            mac={openRow.mac}
            row={openRow}
            kinds={data.kinds || []}
            groups={data.groups || []}
            onClose={() => setOpen(null)}
            onSaved={load}
          />
        )}
      </div>
    </div>
  );
}

export default DeviceTable;
