import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCapture, fetchCaptureInterfaces, pcapUrl, startCapture, stopCapture } from "./captureApi";
import { formatBytes } from "./format";
import Icon from "./Icon";
import { useLocalStorage } from "./useLocalStorage";

// A live packet sniffer for one host. "Start" runs a raw-socket capture on
// that host's network for a fixed time (the agent stops it by itself); the
// page polls and shows three things: the packets as they arrive, the
// conversations they belong to, and how traffic splits by protocol.
//
// Totals, conversations and protocols count every matching packet. The packet
// list is a sample once traffic passes ~120 packets a second, and says so.
// Only headers are kept unless "Include payload" is on, and then 64 bytes.

const POLL_MS = 1000;
const KEEP = 3000; // packets held in the page
const SHOWN = 500; // rows drawn
const DURATIONS = [[30, "30 s"], [60, "1 min"], [180, "3 min"], [300, "5 min"], [600, "10 min"]];
const PROTOCOLS = ["tcp", "udp", "icmp", "arp", "dns", "tls"];
const DEFAULTS = { iface: "", duration: 60, host: "", port: "", proto: "", payload: false };
const LIVE = new Set(["capturing"]);

const endpoint = (ip, port) => (port ? (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`) : ip);

function rate(series) {
  const tail = series.slice(-3);
  if (!tail.length) return { pkts: 0, bytes: 0 };
  return {
    pkts: Math.round(tail.reduce((n, p) => n + p.pkts, 0) / tail.length),
    bytes: Math.round(tail.reduce((n, p) => n + p.bytes, 0) / tail.length),
  };
}

function Throughput({ series }) {
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

function Protocols({ protocols }) {
  const rows = Object.entries(protocols).sort((a, b) => b[1].bytes - a[1].bytes);
  const total = rows.reduce((n, [, v]) => n + v.bytes, 0) || 1;
  if (!rows.length) return <p className="lan-empty">No traffic yet.</p>;
  return (
    <div className="pcap-protos">
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

function Flows({ flows, onFilter }) {
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
        </tr>
      </thead>
      <tbody>
        {flows.map((f) => (
          <tr key={`${f.proto}|${f.a}|${f.a_port}|${f.b}|${f.b_port}`} className="pcap-click" onClick={() => onFilter(f.a)} title={`Show packets involving ${f.a}`}>
            <td><span className={`pcap-proto pcap-proto--${f.proto.toLowerCase()}`}>{f.proto}</span></td>
            <td className="net-mono">{endpoint(f.a, f.a_port)} <span className="net-dim">↔</span> {endpoint(f.b, f.b_port)}</td>
            <td className="pcap-name" title={f.name || undefined}>{f.name || <span className="net-dim">—</span>}</td>
            <td className="net-mono pcap-r">{f.pkts.toLocaleString()}</td>
            <td className="net-mono pcap-r">{formatBytes(f.bytes)}</td>
            <td className="net-mono net-dim pcap-r">{f.out} / {f.in}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HexDump({ hex }) {
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

function Detail({ packet, started, onClose }) {
  const rows = [
    ["Time", `+${(packet.ts - started).toFixed(6)} s`],
    ["Interface", `${packet.iface} (${packet.dir === "out" ? "leaving this host" : "arriving"})`],
    ["From", `${endpoint(packet.src, packet.sport)}${packet.src_mac ? `  ·  ${packet.src_mac}` : ""}`],
    ["To", `${endpoint(packet.dst, packet.dport)}${packet.dst_mac ? `  ·  ${packet.dst_mac}` : ""}`],
    ["Protocol", `${packet.proto}${packet.svc ? ` · ${packet.svc}` : ""}${packet.ip ? ` · IPv${packet.ip}` : ""}`],
    ["Length", `${packet.len} bytes on the wire${packet.ttl != null ? `, TTL ${packet.ttl}` : ""}`],
    ...(packet.sni ? [["Server name", packet.sni]] : []),
    ["Info", packet.info || "—"],
  ];
  return (
    <div className="pcap-detail">
      <div className="pcap-detail-head">
        <strong>Packet {packet.n}</strong>
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

function PacketCapture({ host }) {
  const [options, setOptions] = useLocalStorage("pcapOptions", DEFAULTS);
  const opt = { ...DEFAULTS, ...options };
  const [ifaces, setIfaces] = useState({ default: null, interfaces: [] });
  const [job, setJob] = useState(null);
  const [packets, setPackets] = useState([]);
  const [error, setError] = useState("");
  const [view, setView] = useLocalStorage("pcapView", "packets");
  const [filter, setFilter] = useState("");
  // The rows frozen by "Pause list" (null while following live).
  const [frozen, setFrozen] = useState(null);
  const [selected, setSelected] = useState(null);
  const last = useRef(0);
  const live = useRef(true);
  const listRef = useRef(null);
  const stick = useRef(true); // following the newest row until the reader scrolls up

  const apply = useCallback((body) => {
    if (!live.current) return;
    const { packets: fresh = [], ...rest } = body;
    setJob(rest);
    if (fresh.length) {
      last.current = Math.max(last.current, ...fresh.map((p) => p.n));
      setPackets((prev) => [...prev, ...fresh].slice(-KEEP));
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      apply(await fetchCapture(host, last.current));
    } catch (e) {
      if (live.current) setError(e.message);
    }
  }, [host, apply]);

  useEffect(() => {
    live.current = true;
    fetchCaptureInterfaces(host).then((i) => live.current && setIfaces(i)).catch(() => {});
    poll(); // picks up a capture that is already running
    return () => { live.current = false; };
  }, [host, poll]);

  const running = LIVE.has(job?.state);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [running, poll]);

  const set = (patch) => setOptions({ ...opt, ...patch });

  const start = async () => {
    setError("");
    setPackets([]);
    setSelected(null);
    setFrozen(null);
    stick.current = true;
    last.current = 0;
    const filterBody = {};
    if (opt.host.trim()) filterBody.host = opt.host.trim();
    if (String(opt.port).trim()) filterBody.port = opt.port;
    if (opt.proto) filterBody.proto = opt.proto;
    try {
      apply(await startCapture(host, {
        iface: opt.iface || ifaces.default || undefined,
        duration: Number(opt.duration),
        filter: filterBody,
        payload: Boolean(opt.payload),
      }));
    } catch (e) {
      setError(e.message);
    }
  };

  const stop = async () => {
    try {
      apply(await stopCapture(host));
    } catch (e) {
      setError(e.message);
    }
  };

  const started = job?.started_at || 0;
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = q
      ? packets.filter((p) => `${p.src} ${p.dst} ${p.sport || ""} ${p.dport || ""} ${p.proto} ${p.svc || ""} ${p.info || ""} ${p.sni || ""}`.toLowerCase().includes(q))
      : packets;
    return rows.slice(-SHOWN);
  }, [packets, filter]);

  // Keep the newest rows in view unless the list is paused or the reader
  // has scrolled up to look at something.
  const paused = frozen != null;
  const shown = frozen || visible;
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current && !paused && view === "packets") el.scrollTop = el.scrollHeight;
  }, [visible, paused, view]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const idle = !job || job.state === "idle";
  const now = rate(job?.series || []);
  const filterText = [opt.host && `host ${opt.host}`, opt.port && `port ${opt.port}`, opt.proto].filter(Boolean).join(", ");

  return (
    <div className="lan pcap">
      <div className="lan-bar">
        {running ? (
          <button type="button" className="btn btn--primary" onClick={stop}>Stop</button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={start}>{idle ? "Start capture" : "Capture again"}</button>
        )}
        <select aria-label="Interface" value={opt.iface} disabled={running} onChange={(e) => set({ iface: e.target.value })}>
          <option value="">{ifaces.default ? `${ifaces.default} (default)` : "Default interface"}</option>
          {ifaces.interfaces.filter((i) => i !== ifaces.default).map((i) => <option key={i} value={i}>{i}</option>)}
          <option value="any">all interfaces (duplicates)</option>
        </select>
        <select aria-label="Duration" value={opt.duration} disabled={running} onChange={(e) => set({ duration: e.target.value })}>
          {DURATIONS.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
        </select>
        <input className="lan-filter pcap-field" placeholder="Host IP" aria-label="Only this host" disabled={running} value={opt.host} onChange={(e) => set({ host: e.target.value })} />
        <input className="lan-filter pcap-field pcap-field--port" placeholder="Port" inputMode="numeric" aria-label="Only this port" disabled={running} value={opt.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, "") })} />
        <select aria-label="Protocol" value={opt.proto} disabled={running} onChange={(e) => set({ proto: e.target.value })}>
          <option value="">Any protocol</option>
          {PROTOCOLS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
        </select>
        <label className="lan-auto" title="Keep the first 64 bytes after the headers too. Off by default, so a capture holds who talked to whom, not what was said.">
          <input type="checkbox" checked={Boolean(opt.payload)} disabled={running} onChange={(e) => set({ payload: e.target.checked })} />
          Include payload
        </label>
        {!idle && job.totals?.pkts > 0 && (
          <a className="btn btn--sm btn--ghost pcap-save" href={pcapUrl(host)} title="Open in Wireshark — the packets listed here, as a .pcap file">
            <Icon name="download" /> .pcap
          </a>
        )}
      </div>

      {error && <p className="form-error">{error}</p>}
      {job?.error && <p className="form-error">{job.error}</p>}

      {idle && !error && (
        <p className="lan-empty">
          Captures packets on {host}'s network for a set time and shows them live — who talked to whom, over what,
          how much, DNS lookups as they happen. Choose an interface and optionally narrow it to one host, port or
          protocol, then start. Nothing is written to disk; download the .pcap to keep it.
        </p>
      )}

      {!idle && (
        <>
          <div className="pcap-stats">
            <div className="pcap-stat">
              <span className={`pcap-state pcap-state--${job.state}`}>{running ? "● capturing" : job.state === "error" ? "failed" : job.state}</span>
              <span className="net-dim">{job.iface}{filterText ? ` · ${filterText}` : ""}{job.payload ? " · with payload" : ""}</span>
            </div>
            <div className="pcap-stat"><strong className="net-mono">{(job.totals?.pkts || 0).toLocaleString()}</strong><span className="net-dim">packets</span></div>
            <div className="pcap-stat"><strong className="net-mono">{formatBytes(job.totals?.bytes || 0)}</strong><span className="net-dim">total</span></div>
            <div className="pcap-stat"><strong className="net-mono">{formatBytes(now.bytes)}/s</strong><span className="net-dim">{now.pkts} pkt/s</span></div>
            <Throughput series={job.series || []} />
          </div>
          {job.unlisted > 0 && (
            <p className="lan-meta pcap-note">
              Busy: {job.unlisted.toLocaleString()} packets are counted in the totals but left out of the list (it shows up to 120 a second).
            </p>
          )}

          <div className="lan-bar">
            <div className="lan-view" role="group" aria-label="View">
              {[["packets", "Packets"], ["flows", `Conversations${job.flows?.length ? ` ${job.flows.length}` : ""}`], ["protocols", "Protocols"]].map(([id, label]) => (
                <button key={id} type="button" aria-pressed={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>
              ))}
            </div>
            {view === "packets" && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setFrozen(paused ? null : visible)} aria-pressed={paused}>
                {paused ? "Resume list" : "Pause list"}
              </button>
            )}
            <input
              className="lan-filter"
              type="search"
              placeholder="Filter list…"
              aria-label="Filter packets"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          {view === "packets" && (
            <div className="pcap-split">
              <div className="lan-scroll" ref={listRef} onScroll={onScroll}>
                <table className="net-table lan-table pcap-table pcap-packets">
                  <thead>
                    <tr>
                      <th className="pcap-r">#</th>
                      <th className="pcap-r">Time</th>
                      <th>Source</th>
                      <th>Destination</th>
                      <th>Proto</th>
                      <th className="pcap-r">Len</th>
                      <th>Info</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.n} className={`pcap-click ${selected?.n === p.n ? "pcap-row--selected" : ""}`} onClick={() => setSelected(p)}>
                        <td className="net-mono net-dim pcap-r">{p.n}</td>
                        <td className="net-mono net-dim pcap-r">{(p.ts - started).toFixed(3)}</td>
                        <td className="net-mono">{endpoint(p.src, p.sport)}</td>
                        <td className="net-mono">{endpoint(p.dst, p.dport)}</td>
                        <td><span className={`pcap-proto pcap-proto--${(p.app || p.proto).toLowerCase().replace(/[^a-z0-9]/g, "")}`}>{p.app ? p.app.toUpperCase() : p.proto}</span></td>
                        <td className="net-mono pcap-r">{p.len}</td>
                        <td className="pcap-info" title={p.info}>
                          {p.sni ? <>Client Hello → <strong className="pcap-sni">{p.sni}</strong></> : p.info}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shown.length === 0 && <p className="lan-empty">{running ? "Waiting for packets…" : filter ? "Nothing in the list matches." : "No packets were captured."}</p>}
              </div>
              {selected && <Detail packet={selected} started={started} onClose={() => setSelected(null)} />}
            </div>
          )}

          {view === "flows" && (
            <div className="lan-scroll">
              <Flows
                flows={(job.flows || []).filter((f) => !filter.trim() || `${f.a} ${f.b} ${f.a_port} ${f.b_port} ${f.proto} ${f.name || ""}`.toLowerCase().includes(filter.trim().toLowerCase()))}
                onFilter={(ip) => { setFilter(ip); setView("packets"); }}
              />
            </div>
          )}

          {view === "protocols" && <Protocols protocols={job.protocols || {}} />}
        </>
      )}
    </div>
  );
}

export default PacketCapture;
