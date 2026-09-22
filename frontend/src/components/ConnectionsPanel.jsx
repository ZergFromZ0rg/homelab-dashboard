import { useState } from "react";
import { fetchConnections } from "./connectionsApi";
import { formatBytes } from "./format";

// Who this host is talking to, from its agent's conntrack table.
//
// Collapsed until asked: the table is large on a busy host and it's the
// only part of a host card that isn't already in the /ws payload, so
// opening the panel is what triggers the fetch.
//
// A row reads one of two ways.
//
// When the agent recognised one end as a container, it has already worked
// out which end is this host and handed back rx/tx from the host's point
// of view — so the row says "jellyfin ← 192.168.1.40:8096" and the arrows
// mean what you'd expect.
//
// When it didn't, the flow belongs to the host itself, and the agent
// names the *process* holding the socket instead — "sshd → 10.0.2.1:22".
//
// Either way the endpoints of an unattributed row stay exactly as
// conntrack recorded them: src opened the connection, and the byte columns
// are that connection's two directions rather than the host's.
// Relabelling those would mean guessing which end is local, which address
// ranges can't tell you — both sides of an inbound LAN connection are
// private. A row with neither a container nor a process is dimmed.
function PeerRow({ peer }) {
  const attributed = Boolean(peer.container);

  if (!attributed) {
    const port = peer.dport != null ? `:${peer.dport}` : "";
    return (
      <tr className={peer.process ? "" : "conn-row--raw"}>
        <td className="conn-peer">
          {peer.process ? (
            <strong className="conn-owner conn-owner--host" title={`pid ${peer.pid}`}>
              {peer.process}
            </strong>
          ) : (
            <span>{peer.src}</span>
          )}
          <span className="conn-arrow">→</span>
          <span>
            {peer.dst}
            {port}
          </span>
        </td>
        <td className="conn-proto">{peer.proto}</td>
        <td className="conn-bytes">
          {peer.orig_bytes != null ? formatBytes(peer.orig_bytes) : "—"}
        </td>
        <td className="conn-bytes">
          {peer.reply_bytes != null ? formatBytes(peer.reply_bytes) : "—"}
        </td>
        <td className="conn-flows" title={(peer.states || []).join(", ")}>
          {peer.flows}
        </td>
      </tr>
    );
  }

  const inbound = peer.direction === "in";
  const port = peer.peer_port != null ? `:${peer.peer_port}` : "";

  return (
    <tr>
      <td className="conn-peer">
        <strong className="conn-owner">{peer.container}</strong>
        <span className="conn-arrow" title={inbound ? "inbound" : "outbound"}>
          {inbound ? "←" : "→"}
        </span>
        <span>
          {peer.peer_container || peer.peer}
          {port}
        </span>
      </td>
      <td className="conn-proto">{peer.proto}</td>
      <td className="conn-bytes" title="Received by this host">
        {peer.rx_bytes != null ? formatBytes(peer.rx_bytes) : "—"}
      </td>
      <td className="conn-bytes" title="Sent by this host">
        {peer.tx_bytes != null ? formatBytes(peer.tx_bytes) : "—"}
      </td>
      <td className="conn-flows" title={(peer.states || []).join(", ")}>
        {peer.flows}
      </td>
    </tr>
  );
}

function ConnectionsPanel({ host }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load(refresh) {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchConnections(host, { refresh }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Fetching on the click rather than in an effect keyed on `open`: the
  // click *is* the trigger, and an effect would re-run on every unrelated
  // state change the panel makes while it's open.
  function toggle() {
    if (!open && data === null && !loading) load(false);
    setOpen(!open);
  }

  return (
    <div className="conn-panel">
      <button
        type="button"
        className={`conn-toggle ${open ? "expanded" : ""}`}
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="host-toggle">▾</span>
        CONNECTIONS
        {data?.available && (
          <span className="conn-count">{data.conversations_total}</span>
        )}
      </button>

      {open && (
        <div className="conn-body">
          {loading && <p className="overview-empty">Reading the table…</p>}

          {error && <p className="conn-note conn-note--bad">{error}</p>}

          {!loading && !error && data && !data.available && (
            <p className="conn-note">{data.reason}</p>
          )}

          {!loading && !error && data?.available && (
            <>
              {data.attributed === false && (
                <p className="conn-note">
                  This agent couldn't reach its Docker daemon, so nothing is
                  matched to a container — endpoints are shown as conntrack
                  recorded them.
                </p>
              )}

              {data.attributed && data.processes === false && (
                <p className="conn-note">
                  {data.processes_hint ||
                    "Traffic that isn't a container's can't be named on " +
                      "this host — its socket tables weren't readable."}
                </p>
              )}

              {!data.accounting && (
                <p className="conn-note">
                  Byte counts are off on this host — flows only. Enable them
                  with <code>sysctl -w net.netfilter.nf_conntrack_acct=1</code>.
                </p>
              )}

              {data.peers.length === 0 ? (
                <p className="overview-empty">No tracked conversations.</p>
              ) : (
                <table className="conn-table">
                  <thead>
                    <tr>
                      <th>Conversation</th>
                      <th>Proto</th>
                      <th title="Received by this host">↓</th>
                      <th title="Sent by this host">↑</th>
                      <th title="Connections held open">Flows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.peers.map((peer) => (
                      <PeerRow
                        key={`${peer.proto}-${peer.src}-${peer.dst}-${peer.dport}`}
                        peer={peer}
                      />
                    ))}
                  </tbody>
                </table>
              )}

              <div className="conn-foot">
                <span>
                  {data.truncated
                    ? `top ${data.peers.length} of ${data.conversations_total}`
                    : `${data.conversations_total} conversations`}
                  {data.flows_total != null && ` · ${data.flows_total} flows`}
                </span>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => load(true)}
                >
                  Refresh
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ConnectionsPanel;
