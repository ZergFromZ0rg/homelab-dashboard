import { fetchSwitch, formatLinkSpeed, formatMbps, speedHint, speedTone } from "./switchApi";
import { usePolled } from "./usePolled";
import { useNow } from "./useNow";
import { formatAge } from "./format";

// The switch, port by port: link, speed, traffic and errors, read from
// Prometheus (snmp_exporter does the talking to the switch). A port you've
// described on the switch is one you care about; an undescribed one is listed
// only while something is plugged into it, so a new device is noticed.

const POLL_MS = 15000;
const STATES = {
  up: ["ok", "Up"],
  down: ["bad", "Not answering"],
  unreachable: ["warn", "Prometheus unreachable"],
  loading: ["off", "Loading"],
};

function Port({ port }) {
  const tone = speedTone(port);
  const errors = port.errors_24h;
  return (
    <tr className={port.up ? "" : "sw-row--down"}>
      <td>
        <span className={`status-dot status-dot--${port.up ? "ok" : "bad"}`} title={port.up ? "Link up" : "No link"} />
      </td>
      <td>
        <span className="dev-name">{port.name}</span>
        {!port.labelled && (
          <span className="dev-tag dev-tag--warn" title="Something is plugged in but the port has no description on the switch (Switching → Ports → Description)">
            no label
          </span>
        )}
      </td>
      <td className="net-mono">{port.port}</td>
      <td className={`net-mono sw-speed ${tone ? `sw-speed--${tone}` : ""}`} title={speedHint(port)}>
        {port.up ? formatLinkSpeed(port.speed_mbps) : "—"}
      </td>
      <td className="pcap-r net-mono">{port.up ? formatMbps(port.received_bps) : "—"}</td>
      <td className="pcap-r net-mono">{port.up ? formatMbps(port.sent_bps) : "—"}</td>
      <td className={`pcap-r net-mono ${errors > 0 ? "sw-errors--warn" : ""}`}>{errors != null ? errors.toLocaleString() : "—"}</td>
    </tr>
  );
}

function SwitchPanel() {
  const { data: snapshot, error, loading } = usePolled(fetchSwitch, "switch", POLL_MS);
  const now = useNow(15000);

  if (loading) return <p className="lan-empty">Loading…</p>;
  if (!snapshot) return <p className="lan-empty">Couldn't ask the dashboard about the switch: {error}</p>;

  if (snapshot.state === "unconfigured") {
    return (
      <p className="lan-empty">
        Prometheus has no job named <code>switch</code>. Run snmp_exporter against the switch and add a scrape job
        with that name (<code>SWITCH_JOB</code> in the dashboard's <code>.env</code> changes it).
      </p>
    );
  }

  const [tone, label] = STATES[snapshot.state] || STATES.unreachable;
  const ports = snapshot.ports || [];

  return (
    <div className="sw">
      <div className="sw-head">
        <span className={`status-dot status-dot--${tone}`} />
        <strong>Switch</strong>
        <span className={`sw-state sw-state--${tone}`}>{label}</span>
        {snapshot.instance && <span className="net-mono net-dim">{snapshot.instance}</span>}
        {snapshot.error && <span className="sw-error" title={snapshot.error}>{snapshot.error}</span>}
        {snapshot.stale && snapshot.updated_at && (
          <span className="net-dim">Showing the last ports it returned, {formatAge(now.getTime() / 1000 - snapshot.updated_at)}.</span>
        )}
      </div>

      {snapshot.state === "down" && (
        <p className="lan-empty">
          Prometheus can't read the switch. Check its power, then <code>docker logs snmp-exporter</code> on bigboy.
        </p>
      )}

      {ports.length > 0 && (
        <div className="lan-scroll">
          <table className="net-table lan-table">
            <thead>
              <tr>
                <th aria-label="Link" />
                <th>Port</th>
                <th>#</th>
                <th title="Negotiated link speed">Link</th>
                <th className="pcap-r" title="Traffic the switch is sending to the device">To device <small>Mbps</small></th>
                <th className="pcap-r" title="Traffic the device is sending to the switch">From device <small>Mbps</small></th>
                <th className="pcap-r" title="Damaged packets, in and out, over the last 24 hours">Errors 24h</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((port) => (
                <Port key={port.index} port={port} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default SwitchPanel;
