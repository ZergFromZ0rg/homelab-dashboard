import { useCallback, useEffect, useState } from "react";
import ConnectionsPanel from "./ConnectionsPanel";
import ServicesTab from "./ServicesTab";
import { IconButton } from "./Icon";
import { formatBytesPerSec } from "./format";
import { hostColor } from "./hostColor";
import { createNetwork, fetchNetworks, removeNetwork, setMembership } from "./networksApi";

// One server's network, all of it: traffic, interfaces, published ports,
// Docker networks with who's on them (and the controls to change that),
// and who it's talking to. Pick the server at the top; the service checks
// — which probe things *from* the dashboard — sit underneath.

function Fact({ label, value }) {
  return (
    <span className="stat-item">
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

// Every host port a container publishes, as one row per mapping.
function publishedPorts(containers) {
  const rows = [];
  for (const c of containers || []) {
    for (const [key, hostPorts] of Object.entries(c.ports || {})) {
      const [port, proto] = key.split("/");
      for (const hostPort of hostPorts || []) {
        rows.push({ hostPort: Number(hostPort), port, proto, container: c.name });
      }
    }
  }
  return rows.sort((a, b) => a.hostPort - b.hostPort || a.proto.localeCompare(b.proto));
}

function NewNetworkForm({ onCreate, onCancel }) {
  const [name, setName] = useState("");
  const [subnet, setSubnet] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="net-new"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onCreate({ name: name.trim(), subnet: subnet.trim(), internal });
        setBusy(false);
      }}
    >
      <input
        className="deploy-input"
        placeholder="name, e.g. media"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <input
        className="deploy-input"
        placeholder="subnet (optional), e.g. 10.20.0.0/24"
        value={subnet}
        onChange={(e) => setSubnet(e.target.value)}
      />
      <label className="deploy-check" title="No route out: containers on it can only reach each other">
        <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
        Internal
      </label>
      <button type="submit" className="btn btn--sm" disabled={!name.trim() || busy}>
        Create
      </button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function NetworkRow({ network, containers, onAct }) {
  const [adding, setAdding] = useState("");
  const onIt = new Set(network.containers.map((c) => c.name));
  const candidates = (containers || [])
    .map((c) => c.name)
    .filter((n) => !onIt.has(n))
    .sort();
  const canAttach = !["host", "none"].includes(network.name);

  return (
    <div className={`net-row ${network.builtin ? "net-row--builtin" : ""}`}>
      <div className="net-line">
        <span className="net-name">
          <strong>{network.name}</strong>
          {network.compose_project && (
            <span className="chip" title="Created by this compose project">
              {network.compose_project}
            </span>
          )}
          {network.internal && <span className="chip chip--warn">internal</span>}
          {network.builtin && <span className="chip">docker</span>}
        </span>
        <span className="net-cell">{network.driver}</span>
        <span className="net-cell net-mono">{network.subnets.join(", ") || "—"}</span>
        <span className="net-cell net-mono">{network.gateways.join(", ") || "—"}</span>
        <span className="net-cell net-mono">{network.containers.length}</span>
        <span className="check-cell-actions">
          {!network.builtin && (
            <IconButton
              icon="trash"
              label="Remove network"
              danger
              onClick={() => {
                if (window.confirm(`Remove network ${network.name}?`)) {
                  onAct(() => removeNetwork(network.host, network.id));
                }
              }}
            />
          )}
        </span>
      </div>

      {(network.containers.length > 0 || canAttach) && (
        <div className="net-members">
          {network.containers.map((m) => (
            <span key={m.id} className="net-member">
              <span className="net-member-name">{m.name}</span>
              {m.ipv4 && <span className="net-mono">{m.ipv4}</span>}
              {network.name !== "host" && (
                <button
                  type="button"
                  className="net-member-x"
                  title={`Disconnect ${m.name} from ${network.name}`}
                  aria-label={`Disconnect ${m.name}`}
                  onClick={() => {
                    if (window.confirm(`Disconnect ${m.name} from ${network.name}?`)) {
                      onAct(() => setMembership(network.host, network.id, m.name, false));
                    }
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}

          {canAttach && candidates.length > 0 && (
            <span className="net-attach">
              <select
                className="deploy-input"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                aria-label={`Container to connect to ${network.name}`}
              >
                <option value="">+ connect…</option>
                {candidates.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {adding && (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={async () => {
                    await onAct(() => setMembership(network.host, network.id, adding, true));
                    setAdding("");
                  }}
                >
                  Connect
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function HostNetwork({ host, machine, containers }) {
  const [data, setData] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      fetchNetworks(host)
        .then(setData)
        .catch((e) => setData({ available: false, reason: e.message, networks: [] })),
    [host]
  );

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  // Every change goes through here: run it, show the agent's reason if it
  // refused, and reload the list either way.
  const act = async (fn) => {
    setError("");
    try {
      const result = await fn();
      if (result && result.success === false) setError(result.error || "The agent refused.");
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      load();
    }
  };

  const ports = publishedPorts(containers);
  const interfaces = machine?.interfaces || [];
  const nets = (data?.networks || []).map((n) => ({ ...n, host }));
  const userNets = nets.filter((n) => !n.builtin).length;

  return (
    <div className="net-host" style={{ "--host-color": hostColor(host) }}>
      <div className="stat-strip">
        <Fact label="Down" value={`↓ ${formatBytesPerSec(machine?.network_rx)}`} />
        <Fact label="Up" value={`↑ ${formatBytesPerSec(machine?.network_tx)}`} />
        <Fact label="Interfaces" value={interfaces.length || "—"} />
        <Fact label="Networks" value={data ? userNets : "…"} />
        <Fact label="Ports" value={ports.length} />
      </div>

      <div className="net-grid">
        <div className="net-col">
          <section className="overview-card">
            <div className="overview-card-head">
              <h2>Interfaces</h2>
            </div>
            <table className="net-table">
              <thead>
                <tr>
                  <th>Interface</th>
                  <th>Down</th>
                  <th>Up</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {interfaces.map((i) => (
                  <tr key={i.device}>
                    <td>
                      <strong>{i.name}</strong>
                      {i.device !== i.name && <span className="net-dim"> {i.device}</span>}
                    </td>
                    <td className="net-mono">↓ {formatBytesPerSec(i.rx_bps)}</td>
                    <td className="net-mono">↑ {formatBytesPerSec(i.tx_bps)}</td>
                    <td className="net-dim" title="An overlay link — not counted in the host's download/upload totals">
                      {i.in_total === false ? "overlay" : ""}
                    </td>
                  </tr>
                ))}
                {!interfaces.length && (
                  <tr>
                    <td colSpan={4} className="net-dim">No interface data from Prometheus.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="overview-card">
            <div className="overview-card-head">
              <h2>Published ports</h2>
              <span className="overview-card-count">{ports.length}</span>
            </div>
            <table className="net-table">
              <thead>
                <tr>
                  <th>Host port</th>
                  <th>Container</th>
                  <th>Inside</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ports.map((p) => (
                  <tr key={`${p.hostPort}-${p.proto}-${p.container}`}>
                    <td className="net-mono">
                      <strong>{p.hostPort}</strong>
                      <span className="net-dim">/{p.proto}</span>
                    </td>
                    <td>{p.container}</td>
                    <td className="net-mono net-dim">{p.port}</td>
                    <td>
                      {p.proto === "tcp" && (
                        <a
                          className="net-open"
                          href={`http://${host}:${p.hostPort}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          open ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
                {!ports.length && (
                  <tr>
                    <td colSpan={4} className="net-dim">Nothing is published on this host.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </div>

        <section className="overview-card net-networks">
          <div className="overview-card-head">
            <h2>Docker networks</h2>
            <span className="overview-card-count">{userNets}</span>
            {!creating && data?.available && (
              <button type="button" className="ov-panel-link" onClick={() => setCreating(true)}>
                + New network
              </button>
            )}
          </div>

          {creating && (
            <div className="net-new-wrap">
              <NewNetworkForm
                onCancel={() => setCreating(false)}
                onCreate={async (values) => {
                  const result = await act(() => createNetwork(host, values));
                  if (result?.success) setCreating(false);
                }}
              />
            </div>
          )}

          {error && (
            <div className="net-error">
              <p className="form-error">{error}</p>
            </div>
          )}

          {data && !data.available ? (
            <p className="net-unavailable">{data.reason}</p>
          ) : (
            <div className="net-list">
              <div className="net-line net-head" role="presentation">
                <span>Network</span>
                <span>Driver</span>
                <span>Subnet</span>
                <span>Gateway</span>
                <span>On it</span>
                <span />
              </div>
              {nets.map((n) => (
                <NetworkRow key={n.id} network={n} containers={containers} onAct={act} />
              ))}
              {!data && <p className="net-dim net-pad">Reading {host}…</p>}
            </div>
          )}
        </section>
      </div>

      <section className="overview-card net-conns">
        <ConnectionsPanel host={host} />
      </section>
    </div>
  );
}

function NetworkTab({ machines, containers, checks, connected }) {
  const hosts = Object.keys(machines).sort();
  const [picked, setPicked] = useState(null);
  const host = hosts.includes(picked) ? picked : hosts[0];

  return (
    <section className="network-tab">
      {hosts.length === 0 ? (
        <div className="empty-state">
          {connected === false ? "Connecting…" : "No servers reporting yet."}
        </div>
      ) : (
        <>
          <div className="net-hosts" role="tablist" aria-label="Server">
            {hosts.map((h) => (
              <button
                key={h}
                type="button"
                role="tab"
                aria-selected={h === host}
                className={`net-host-tab ${h === host ? "active" : ""}`}
                style={{ "--host-color": hostColor(h) }}
                onClick={() => setPicked(h)}
              >
                <span className={`status-dot status-dot--${machines[h].online ? "ok" : "bad"}`} />
                {h}
              </button>
            ))}
          </div>

          <HostNetwork
            key={host}
            host={host}
            machine={machines[host]}
            containers={containers[host]}
          />
        </>
      )}

      <div className="net-checks">
        <ServicesTab checks={checks} connected={connected} embedded />
      </div>
    </section>
  );
}

export default NetworkTab;
