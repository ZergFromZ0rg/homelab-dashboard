import { useMemo } from "react";
import { formatBytes } from "./format";
import { followStream } from "./captureStream";

// One TCP connection's payload in order, client text in one colour and the
// server's in another — what you'd get from Wireshark's "Follow TCP stream".
// Built from the packets on screen; a capture that kept headers only has
// nothing to show and says how to get it.

const endpoint = (ip, port) => (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`);

function PacketStream({ packets, flow, onClose }) {
  const stream = useMemo(() => followStream(packets, flow), [packets, flow]);
  const [, a, ap, b, bp] = flow.split("|");

  return (
    <div className="pcap-stream">
      <div className="pcap-stream-head">
        <strong>TCP stream</strong>
        <span className="net-mono net-dim">{endpoint(a, ap)} ⇄ {endpoint(b, bp)}</span>
        <button type="button" className="btn btn--sm btn--ghost pcap-stream-close" onClick={onClose}>Back to packets</button>
      </div>

      {!stream && <p className="lan-empty">None of this connection's packets are in the list any more.</p>}

      {stream && (
        <>
          <div className="pcap-stream-meta">
            <span className="pcap-stream-key pcap-stream-key--client">client {stream.client}: {formatBytes(stream.bytes.client)}</span>
            {stream.server && <span className="pcap-stream-key pcap-stream-key--server">server {stream.server}: {formatBytes(stream.bytes.server)}</span>}
            {stream.gaps > 0 && (
              <span className="pcap-stream-warn" title="Packets the capture missed, or that were left out of the list on a busy link">
                {stream.gaps} gap{stream.gaps === 1 ? "" : "s"} · {formatBytes(stream.missing)} missing
              </span>
            )}
          </div>

          {stream.headersOnly > 0 && stream.chunks.every((c) => c.gap) && (
            <p className="lan-empty">
              This capture kept headers only, so there is no payload to follow. Capture again with
              {" "}<strong>Payload: Full packets</strong>.
            </p>
          )}
          {stream.headersOnly > 0 && stream.chunks.some((c) => c.text) && (
            <p className="lan-meta pcap-note">{stream.headersOnly} segment{stream.headersOnly === 1 ? "" : "s"} had no payload kept and are missing below.</p>
          )}
          {stream.segments === 0 && <p className="lan-empty">This connection carried no data in the packets listed (handshake or acknowledgements only).</p>}

          <div className="pcap-stream-body">
            {stream.chunks.map((c, i) =>
              c.gap ? (
                <div key={i} className="pcap-stream-gap">— {formatBytes(c.gap)} not captured —</div>
              ) : (
                <pre key={i} className={`pcap-stream-chunk pcap-stream-chunk--${c.dir}`}>{c.text}</pre>
              )
            )}
            {stream.capped && <div className="pcap-stream-gap">— stopped at 200 KB —</div>}
          </div>
        </>
      )}
    </div>
  );
}

export default PacketStream;
