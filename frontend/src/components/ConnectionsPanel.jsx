import { useState } from "react";
import { fetchConnections } from "./connectionsApi";
import { formatBytes } from "./format";

// Who this host is talking to, from its agent's conntrack table.
//
// Collapsed until asked: the table is large on a busy host and it's the
// only part of a host card that isn't already in the /ws payload, so
// opening the panel is what triggers the fetch.
//
// src/dst are shown the way conntrack records them — src opened the
// connection — rather than being relabelled "local" and "remote". Which
// end is this host isn't in the table, and guessing it from address ranges
// gets inbound LAN connections backwards.
function PeerRow({ peer }) {
  const port = peer.dport != null ? `:${peer.dport}` : "";

  return (
    <tr>
      <td className="conn-peer">
        <span>{peer.src}</span>
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
                      <th title="Bytes from src to dst">→</th>
                      <th title="Bytes back from dst to src">←</th>
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
