import { BAD, DIRECTION, ISSUE_NAMES, ISSUE_WORDS, endpoint, flowKey } from "./captureUi";
import { label } from "./captureNames";
import { formatBytes } from "./format";

// An address as the reader should see it: its name where one is known (with the
// address and where the name came from on hover), the plain address where not.
export function Endpoint({ names, ip, port, show }) {
  const found = show ? names.get((ip || "").toLowerCase()) : null;
  return (
    <span title={found ? `${found.name} · ${endpoint(ip, port)} · ${found.kind}` : undefined}>
      {label(names, ip, port, { names: show })}
    </span>
  );
}

// The read-only pieces of the packet viewer: the throughput chart, protocol and
// conversation tables, and one packet's detail and hex. State lives in
// PacketCapture; these only draw what they are given.

export function Throughput({ series }) {
  const points = series.slice(-120);
  if (points.length < 2) return <div className="pcap-chart pcap-chart--empty" aria-hidden="true" />;
  const max = Math.max(...points.map((p) => p.bytes), 1);
  const step = 100 / points.length;
  return (
    <svg className="pcap-chart" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="Bytes per second">
      {points.map((p, i) => {
        const h = Math.max(0.6, (p.bytes / max) * 30);
        return <rect key={p.ts} x={i * step} y={32 - h} width={Math.max(step - 0.4, 0.3)} height={h} />;
      })}
    </svg>
  );
}

export function Protocols({ protocols, issues = {}, onShow }) {
  const rows = Object.entries(protocols).sort((a, b) => b[1].bytes - a[1].bytes);
  const total = rows.reduce((n, [, v]) => n + v.bytes, 0) || 1;
  const trouble = Object.entries(issues).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return <p className="lan-empty">No traffic yet.</p>;
  return (
    <div className="pcap-protos">
      {trouble.length > 0 && (
        <div className="pcap-issues">
          <strong>TCP trouble</strong>
          {trouble.map(([name, n]) => (
            <button key={name} type="button" className={`pcap-issue ${BAD.has(name) ? "pcap-issue--bad" : ""}`} onClick={() => onShow(ISSUE_WORDS[name])} title="Show these packets">
              {n.toLocaleString()} {(ISSUE_NAMES[name] || name).toLowerCase()}
            </button>
          ))}
        </div>
      )}
      {rows.map(([name, v]) => (
        <div key={name} className="pcap-proto-row">
          <span className={`pcap-proto pcap-proto--${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`}>{name}</span>
          <span className="pcap-bar"><span style={{ width: `${Math.max(1, (v.bytes / total) * 100)}%` }} /></span>
          <span className="net-mono pcap-num">{formatBytes(v.bytes)}</span>
          <span className="net-mono net-dim pcap-num">{v.pkts.toLocaleString()} pkts</span>
          <span className="net-mono net-dim pcap-num">{Math.round((v.bytes / total) * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

export function Flows({ flows, names, showNames, onFilter, onFollow }) {
  if (!flows.length) return <p className="lan-empty">No conversations yet.</p>;
  return (
    <table className="net-table lan-table pcap-table">
      <thead>
        <tr>
          <th>Proto</th>
          <th>Between</th>
          <th>Server name</th>
          <th className="pcap-r">Packets</th>
          <th className="pcap-r">Bytes</th>
          <th className="pcap-r" title="Packets leaving this host / arriving at it">Out / in</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {flows.map((f) => (
          <tr
            key={flowKey(f)}
            className="pcap-click"
            tabIndex={0}
            onClick={() => onFilter(f.a)}
            onKeyDown={(e) => e.key === "Enter" && onFilter(f.a)}
            title={`Show packets involving ${f.a}`}
          >
            <td><span className={`pcap-proto pcap-proto--${f.proto.toLowerCase()}`}>{f.proto}</span></td>
            <td className="net-mono">
              <Endpoint names={names} show={showNames} ip={f.a} port={f.a_port} /> <span className="net-dim">↔</span>{" "}
              <Endpoint names={names} show={showNames} ip={f.b} port={f.b_port} />
            </td>
            <td className="pcap-name" title={f.name || undefined}>{f.name || <span className="net-dim">—</span>}</td>
            <td className="net-mono pcap-r">{f.pkts.toLocaleString()}</td>
            <td className="net-mono pcap-r">{formatBytes(f.bytes)}</td>
            <td className="net-mono net-dim pcap-r">
              {f.out} / {f.in}
              {Object.keys(f.issues || {}).length > 0 && (
                <span className="pcap-flow-issues" title={Object.entries(f.issues).map(([k, n]) => `${n} ${ISSUE_NAMES[k] || k}`).join(", ")}> ⚠</span>
              )}
            </td>
            <td className="pcap-r">
              {f.proto === "TCP" && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={(e) => { e.stopPropagation(); onFollow(flowKey(f)); }} title="Rebuild this connection's payload">Follow</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HexDump({ hex }) {
  const rows = [];
  for (let i = 0; i < hex.length; i += 32) {
    const chunk = hex.slice(i, i + 32).match(/../g) || [];
    rows.push({
      offset: (i / 2).toString(16).padStart(4, "0"),
      bytes: chunk.join(" "),
      text: chunk.map((b) => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }).join(""),
    });
  }
  return (
    <pre className="pcap-hex">
      {rows.map((r) => `${r.offset}  ${r.bytes.padEnd(47, " ")}  ${r.text}`).join("\n")}
    </pre>
  );
}

export function Detail({ packet, started, names, onClose, onFollow }) {
  // "jellyfin (172.18.0.2:8096) · mac" — the name and the address, both, here.
  const who = (ip, port, mac) => {
    const found = names.get((ip || "").toLowerCase());
    const address = endpoint(ip, port);
    return `${found ? `${found.name} (${address})` : address}${mac ? `  ·  ${mac}` : ""}`;
  };
  const rows = [
    ["Time", `+${(packet.ts - started).toFixed(6)} s`],
    ["Interface", `${packet.iface} (${DIRECTION[packet.dir] || "arriving"})`],
    ["From", who(packet.src, packet.sport, packet.src_mac)],
    ["To", who(packet.dst, packet.dport, packet.dst_mac)],
    ["Protocol", `${packet.proto}${packet.svc ? ` · ${packet.svc}` : ""}${packet.ip ? ` · IPv${packet.ip}` : ""}`],
    ["Length", `${packet.len} bytes on the wire${packet.ttl != null ? `, TTL ${packet.ttl}` : ""}`],
    ...(packet.seq != null ? [["TCP", `[${packet.flags}] seq ${packet.seq} ack ${packet.ack} win ${packet.win}${packet.plen ? ` · ${packet.plen} bytes of data` : ""}`]] : []),
    ...(packet.sni ? [["Server name", packet.sni]] : []),
    ...(packet.name ? [["Name", packet.name]] : []),
    ...(packet.issues?.length ? [["Problems", packet.issues.map((i) => ISSUE_NAMES[i] || i).join(", ")]] : []),
    ["Info", packet.info || "—"],
  ];
  return (
    <div className="pcap-detail">
      <div className="pcap-detail-head">
        <strong>Packet {packet.n}</strong>
        {packet.proto === "TCP" && packet.flow && (
          <button type="button" className="btn btn--sm btn--ghost pcap-follow" onClick={() => onFollow(packet.flow)}>Follow stream</button>
        )}
        <button type="button" className="icon-action" onClick={onClose} aria-label="Close packet" title="Close">
          ×
        </button>
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd className="net-mono">{v}</dd></div>
        ))}
      </dl>
      <HexDump hex={packet.hex || ""} />
    </div>
  );
}

