import { useCallback, useEffect, useState } from "react";
import ConnectionsPanel from "./ConnectionsPanel";
import LanScan from "./LanScan";
import Sparkline from "./Sparkline";
import { windowPoints } from "./historyWindow";
import { useSettings } from "./settings";
import ServicesTab from "./ServicesTab";
import { IconButton } from "./Icon";
import { formatBytesPerSec } from "./format";
import { hostColor } from "./hostColor";
import { useLocalStorage } from "./useLocalStorage";
import { useFitHeight } from "./useFitHeight";
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

// Where the node's download and upload come from: each container's own in /
// out, busiest first, against the node's total. The remainder is traffic that
// isn't a container's — the host itself, and containers on the host network.
function TrafficByService({ machine, containers = [] }) {
  const rows = containers
    .filter((c) => c.status === "running")
    .map((c) => ({
      name: c.name,
      id: c.id,
      rx: c.stats?.network?.rx_bps ?? 0,
      tx: c.stats?.network?.tx_bps ?? 0,
    }))
    .sort((a, b) => b.rx + b.tx - (a.rx + a.tx));
  const sumRx = rows.reduce((n, r) => n + r.rx, 0);
  const sumTx = rows.reduce((n, r) => n + r.tx, 0);
  const otherRx = Math.max(0, (machine?.network_rx ?? 0) - sumRx);
  const otherTx = Math.max(0, (machine?.network_tx ?? 0) - sumTx);
  const all = [...rows, { name: "Host and everything else", id: "__other", rx: otherRx, tx: otherTx, other: true }];
  const peak = Math.max(1, ...all.map((r) => Math.max(r.rx, r.tx)));

  return (
    <section className="overview-card net-services">
      <div className="overview-card-head">
        <h2>Traffic by service</h2>
        <span className="overview-card-count">{rows.length}</span>
        <span className="net-services-note">per container, this moment</span>
      </div>
      <div className="net-svc">
        <div className="net-svc-row net-svc-head" role="presentation">
          <span>Service</span>
          <span>↓ In</span>
          <span>↑ Out</span>
        </div>
        {all.map((r) => (
          <div key={r.id} className={`net-svc-row ${r.other ? "net-svc-row--other" : ""} ${r.rx + r.tx < 1 ? "net-svc-row--idle" : ""}`}>
            <span className="net-svc-name" title={r.name}>{r.name}</span>
            <span className="net-svc-cell">
              <i style={{ width: `${(r.rx / peak) * 100}%` }} className="rx" />
              <b>{formatBytesPerSec(r.rx)}</b>
            </span>
            <span className="net-svc-cell">
              <i style={{ width: `${(r.tx / peak) * 100}%` }} className="tx" />
              <b>{formatBytesPerSec(r.tx)}</b>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function HostNetwork({ host, machine, containers, history, part = "network" }) {
  const {
    settings: { graphWindowMinutes: windowMinutes },
  } = useSettings();
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
  const trafficMax =
    Math.max(
      1,
      ...windowPoints(history?.network_rx, windowMinutes).map((p) => p.v ?? 0),
      ...windowPoints(history?.network_tx, windowMinutes).map((p) => p.v ?? 0)
    ) * 1.15;
  const nets = (data?.networks || []).map((n) => ({ ...n, host }));
  const userNets = nets.filter((n) => !n.builtin).length;

  return (
    <div className="net-host" style={{ "--host-color": hostColor(host) }}>

      {part === "network" && (
      <>
      <div className="net-top">
      <div className="net-traffic">
        {[
          ["Down", "rx", machine?.network_rx, history?.network_rx],
          ["Up", "tx", machine?.network_tx, history?.network_tx],
        ].map(([label, variant, now, points]) => (
          <div className="net-trend" key={variant}>
            <div className="net-trend-head">
              <span>{label}</span>
              <strong>{formatBytesPerSec(now)}</strong>
            </div>
            <Sparkline
              points={points}
              max={trafficMax}
              variant={variant}
              height={34}
              windowMinutes={windowMinutes}
            />
          </div>
        ))}
      </div>
      <TrafficByService machine={machine} containers={containers} />
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
      </>
      )}

      {part === "devices" && (
        <section className="overview-card net-fill">
          <LanScan host={host} />
        </section>
      )}

      {part === "connections" && (
        <section className="overview-card net-conns net-fill">
          <ConnectionsPanel host={host} defaultOpen />
        </section>
      )}
    </div>
  );
}

function NetworkTab({ machines, containers, checks, connected, history = {} }) {
  const fit = useFitHeight();
  const hosts = Object.keys(machines).sort();
  const [picked, setPicked] = useLocalStorage("networkHost", null);
  const [section, setSection] = useLocalStorage("networkSection", "network");
  const host = hosts.includes(picked) ? picked : hosts[0];
  const down = checks.filter((c) => c.status === "down").length;
  const perHost = section !== "checks";

  const sections = [
    ["network", "Host network", null],
    ["devices", "Devices", null],
    ["connections", "Connections", null],
    ["checks", "Service checks", down ? `${down} down` : checks.length || null],
  ];

  return (
    <section className="network-tab fit-page" ref={fit}>
      <div className="net-bar">
        <div className="hsys-tabs" role="tablist" aria-label="Network">
          {sections.map(([id, label, badge]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={section === id ? "active" : ""}
              onClick={() => setSection(id)}
            >
              {label}
              {badge != null && <span className={`hsys-badge ${id === "checks" && down ? "hsys-badge--bad" : ""}`}>{badge}</span>}
            </button>
          ))}
        </div>

        {perHost && hosts.length > 0 && (
          <div className="net-hosts net-hosts--bar" role="tablist" aria-label="Server">
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
        )}
      </div>

      {perHost && hosts.length === 0 && (
        <div className="empty-state">{connected === false ? "Connecting…" : "No servers reporting yet."}</div>
      )}

      {perHost && hosts.length > 0 && (
        <div className="fit-pane">
          <HostNetwork
            key={`${host}-${section}`}
            host={host}
            machine={machines[host]}
            containers={containers[host]}
            history={history[host]}
            part={section}
          />
        </div>
      )}

      {section === "checks" && (
        <div className="net-checks fit-pane">
          <ServicesTab checks={checks} connected={connected} />
        </div>
      )}
    </section>
  );
}

export default NetworkTab;
