import { linkLabel } from "./containerLink";
import { matchesPort, portRows } from "./containerPorts";
import { hostColor } from "./hostColor";

// The Containers tab's other view: every port the containers hold, a card per
// host (a port belongs to a host, not to the fleet — 8080 on two machines is
// two different ports). Published ports show what they map to; a
// host-network container's ports are the ones the agent saw it listening on.
function HostPorts({ host, rows, filtering }) {
  const containers = new Set(rows.map((r) => r.container)).size;

  return (
    <div className="host-group" style={{ "--host-color": hostColor(host) }}>
      <div className="host-header expanded">
        <div className="host-toggle-btn">
          <span className="host-name">{host}</span>
          <span className="net-dim">
            {rows.length} port{rows.length === 1 ? "" : "s"} · {containers} container{containers === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <div className="container-list">
        {rows.length === 0 ? (
          <p className="net-dim net-pad">{filtering ? "No port matches." : "No container publishes a port here."}</p>
        ) : (
          <table className="net-table ports-table">
            <thead>
              <tr>
                <th>Port</th>
                <th>Container</th>
                <th>Inside</th>
                <th>Opens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.port}-${r.proto}-${r.container}-${i}`}
                  className={r.running ? "" : "ports-row--off"}
                  title={r.running ? undefined : `${r.container} is stopped — this port is free until it starts`}
                >
                  <td className="net-mono">
                    <strong>{r.port}</strong>
                    <span className="net-dim">/{r.proto}</span>
                  </td>
                  <td>{r.container}</td>
                  <td className="net-mono net-dim">{r.hostNetwork ? "host network" : `→ ${r.inside}`}</td>
                  <td>
                    {r.url && (
                      <a className="net-open" href={r.url} target="_blank" rel="noopener noreferrer">
                        ↗ {linkLabel(r.url)}
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PortsView({ containers, hosts, query }) {
  const groups = hosts
    .map((host) => ({ host, rows: portRows(host, containers[host]).filter((r) => matchesPort(r, query)) }))
    // Searching hides the hosts with nothing to show; otherwise every host
    // stays, so one that publishes nothing says so instead of vanishing.
    .filter((g) => !query || g.rows.length > 0);

  if (groups.length === 0) return <div className="empty-state">No port matches “{query}”.</div>;

  return groups.map((g) => <HostPorts key={g.host} host={g.host} rows={g.rows} filtering={Boolean(query)} />);
}

export default PortsView;
