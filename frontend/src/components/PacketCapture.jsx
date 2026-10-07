import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchCapture, fetchCaptureInterfaces, pcapUrl, savedPcapUrl, startCapture, stopCapture } from "./captureApi";
import { compileFilter } from "./captureFilter";
import { BAD, endpoint, rate } from "./captureUi";
import { formatBytes } from "./format";
import Icon from "./Icon";
import PacketStream from "./PacketStream";
import { Detail, Flows, Protocols, Throughput } from "./PacketViews";
import SavedCaptures from "./SavedCaptures";
import { useLocalStorage } from "./useLocalStorage";

// A live packet sniffer for one host. "Start" runs a raw-socket capture on
// that host's network for a fixed time (the agent stops it by itself); the
// page polls and shows the packets as they arrive, the conversations they
// belong to, and how traffic splits by protocol — with TCP trouble
// (retransmissions, resets, zero windows) flagged as it happens.
//
// Two filters, two jobs. The *capture* filter (next to Start) decides what the
// agent records at all; the *display* filter (above the list) narrows what is
// shown of what was recorded and can be changed freely while it runs, on live
// and saved captures alike. Both take the same tcpdump-style expressions.
//
// Totals, conversations and protocols count every matching packet. The packet
// list is a sample once traffic passes ~120 packets a second (600 with whole
// packets kept) and says so. Only headers are kept unless a payload mode is
// chosen; "Follow stream" needs whole packets.

const POLL_MS = 1000;
const KEEP = 3000; // packets held in the page
const SHOWN = 500; // rows drawn
const DURATIONS = [[30, "30 s"], [60, "1 min"], [180, "3 min"], [300, "5 min"], [600, "10 min"]];
const PAYLOADS = [["none", "Headers only"], ["64", "First 64 bytes"], ["full", "Full packets"]];
// Remembered between visits. Payload and promiscuous are deliberately not:
// they widen what is recorded, so each capture starts from the careful setting.
const DEFAULTS = { iface: "", duration: 60, expr: "" };
const SESSION_DEFAULTS = { payload: "none", promisc: false };
const LIVE = new Set(["capturing"]);
// Click-to-fill examples (tcpdump-style; the agent parses them for the capture
// filter, this page for the display filter).
const EXAMPLES = [
  ["One host", "host 192.168.1.10"],
  ["Web traffic", "tcp and (port 80 or port 443)"],
  ["Everything but SSH", "not port 22"],
  ["Into Jellyfin", "tcp and dst port 8096"],
  ["One subnet, no ARP", "net 192.168.1.0/24 and not arp"],
  ["DNS lookups", "dns"],
  ["Who is asking for an address", "dhcp"],
  ["Plain-HTTP to one name", "http and name nas.lan"],
  ["A site over TLS", "tls and sni *.github.com"],
  ["TCP in trouble", "problem"],
  ["Big packets", "len > 1000"],
];
const SYNTAX = [
  ["host IP · net CIDR", "src / dst narrow it: dst host 10.0.0.5, src net 192.168.1.0/24"],
  ["port N · portrange A-B", "tcp / udp narrow it: tcp dst port 8096"],
  ["tcp udp icmp icmp6 arp ip ip6", "a protocol on its own"],
  ["dns tls http dhcp ntp", "what the capture could read inside the packet"],
  ["retransmit reset zerowindow dupack gap · problem", "TCP trouble the capture flagged (problem = any of them)"],
  ["ether host MAC", "src / dst work here too"],
  ["len > N · less N · greater N", "packet size in bytes"],
  ["sni NAME · name NAME", "a TLS server name · that, an HTTP Host or a DHCP host name; sni *.example.com also matches example.com"],
  ["and · or · not · ( )", "also && || !  —  and binds tighter than or"],
];

function PacketCapture({ host }) {
  const [options, setOptions] = useLocalStorage("pcapOptions", DEFAULTS);
  const [session, setSession] = useState(SESSION_DEFAULTS);
  const [ifaces, setIfaces] = useState({ default: null, interfaces: [] });
  // The saved interface may not exist on this host (the setting is shared by all of them).
  const iface = options.iface === "any" || ifaces.interfaces.includes(options.iface) ? options.iface : "";
  const opt = { ...DEFAULTS, ...options, ...session, iface };
  const payload = opt.payload;
  const [job, setJob] = useState(null);
  const [packets, setPackets] = useState([]);
  const [error, setError] = useState("");
  const [help, setHelp] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [viewing, setViewing] = useState(null); // a saved capture opened read-only: {meta, capture}
  const [stream, setStream] = useState(null); // the flow being followed
  const [view, setView] = useLocalStorage("pcapView", "packets");
  const [filter, setFilter] = useState("");
  // "Pause list" freezes the list at this packet number (null while following live).
  const [frozenAt, setFrozenAt] = useState(null);
  const [selected, setSelected] = useState(null);
  const last = useRef(0);
  const seenStart = useRef(null); // when the capture we are holding began
  const live = useRef(true);
  const listRef = useRef(null);
  const stick = useRef(true); // following the newest row until the reader scrolls up

  // `restarted`: someone started another capture on this host, so its packet
  // numbering began again and what we hold belongs to the old one — replace it.
  const apply = useCallback((body, restarted = false) => {
    if (!live.current) return;
    const { packets: fresh = [], ...rest } = body;
    setJob(rest);
    if (restarted) {
      last.current = 0;
      setSelected(null);
      setStream(null);
      setFrozenAt(null);
    }
    if (fresh.length) {
      last.current = Math.max(last.current, ...fresh.map((p) => p.n));
      setPackets((prev) => [...(restarted ? [] : prev), ...fresh].slice(-KEEP));
    } else if (restarted) {
      setPackets([]);
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      let body = await fetchCapture(host, last.current);
      const restarted = Boolean(seenStart.current && body.started_at && body.started_at !== seenStart.current);
      if (restarted) body = await fetchCapture(host, 0);
      if (body.started_at) seenStart.current = body.started_at;
      apply(body, restarted);
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

  const set = (patch) => setOptions({ ...options, ...patch });
  const setSessionOption = (patch) => setSession((current) => ({ ...current, ...patch }));

  const start = async () => {
    setError("");
    setPackets([]);
    setSelected(null);
    setFrozenAt(null);
    setViewing(null);
    setStream(null);
    stick.current = true;
    last.current = 0;
    seenStart.current = null;
    const filterBody = opt.expr.trim() ? { expr: opt.expr.trim() } : {};
    try {
      apply(await startCapture(host, {
        iface: iface || ifaces.default || undefined,
        duration: Number(opt.duration),
        filter: filterBody,
        payload,
        promisc: Boolean(opt.promisc) && iface !== "any",
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

  const openSaved = ({ meta, capture }) => {
    setViewing({ meta, capture });
    setSavedOpen(false);
    setStream(null);
    setSelected(null);
    setFrozenAt(null);
    setError("");
  };

  // What is on screen: the saved capture being viewed, or the live one.
  const data = viewing ? viewing.capture : job;
  const savedPackets = viewing?.capture.packets;
  const pool = useMemo(() => (viewing ? savedPackets || [] : packets), [viewing, savedPackets, packets]);
  const started = data?.started_at || 0;

  // The display filter: an expression if it parses, otherwise plain text
  // search (with the reason shown), so typing a word still finds things.
  const display = useMemo(() => {
    const text = filter.trim();
    if (!text) return { test: null, error: "" };
    try {
      return { test: compileFilter(text), error: "" };
    } catch (e) {
      const q = text.toLowerCase();
      return {
        test: (p) => `${p.src} ${p.dst} ${p.sport || ""} ${p.dport || ""} ${p.proto} ${p.svc || ""} ${p.info || ""} ${p.sni || ""} ${p.name || ""}`.toLowerCase().includes(q),
        error: e.message,
      };
    }
  }, [filter]);

  const paused = frozenAt != null;
  const visible = useMemo(() => {
    const list = paused ? pool.filter((p) => p.n <= frozenAt) : pool;
    return (display.test ? list.filter(display.test) : list).slice(-SHOWN);
  }, [pool, display, paused, frozenAt]);
  const matchedFlows = useMemo(() => {
    const flows = data?.flows || [];
    if (!display.test) return flows;
    // A conversation passes when a packet standing in for it would.
    return flows.filter((f) => display.test({
      proto: f.proto, ip: f.a.includes(":") ? 6 : 4, src: f.a, sport: f.a_port || undefined, dst: f.b, dport: f.b_port || undefined,
      sni: f.name, name: f.name, issues: Object.keys(f.issues || {}), len: Math.round(f.bytes / Math.max(1, f.pkts)),
      info: f.name || "", svc: "",
    }));
  }, [data, display]);

  // Keep the newest rows in view unless the list is paused or the reader
  // has scrolled up to look at something.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current && !paused && !viewing && view === "packets") el.scrollTop = el.scrollHeight;
  }, [visible, paused, viewing, view]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const showIssue = (word) => { setFilter(word); setView("packets"); };

  const idle = !data || data.state === "idle";
  const now = rate(data?.series || []);
  const f = data?.filter || {};
  const filterText = [f.expr, f.host && `host ${f.host}`, f.port && `port ${f.port}`, f.proto].filter(Boolean).join(" · ");
  const trouble = Object.values(data?.issues || {}).reduce((n, c) => n + c, 0);
  const canSave = !viewing && Boolean(job && job.state !== "idle" && job.totals?.pkts > 0);

  return (
    <div className="lan pcap">
      <div className="lan-bar">
        {running ? (
          <button type="button" className="btn btn--primary" onClick={stop}>Stop</button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={start}>{!job || job.state === "idle" ? "Start capture" : "Capture again"}</button>
        )}
        <select aria-label="Interface" value={iface} disabled={running} onChange={(e) => set({ iface: e.target.value })}>
          <option value="">{ifaces.default ? `${ifaces.default} (default)` : "Default interface"}</option>
          {ifaces.interfaces.filter((i) => i !== ifaces.default).map((i) => <option key={i} value={i}>{i}</option>)}
          <option value="any">all interfaces (duplicates)</option>
        </select>
        <select aria-label="Duration" value={opt.duration} disabled={running} onChange={(e) => set({ duration: e.target.value })}>
          {DURATIONS.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
        </select>
        <input
          className="pcap-expr"
          placeholder="Capture filter — e.g. host 192.168.1.10 and port 443"
          aria-label="Capture filter expression"
          spellCheck={false}
          autoComplete="off"
          disabled={running}
          value={opt.expr}
          onChange={(e) => set({ expr: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && !running) start(); }}
        />
        <button type="button" className="btn btn--sm btn--ghost" aria-expanded={help} onClick={() => setHelp((h) => !h)} title="Filter syntax and examples">
          {help ? "Hide help" : "Filter help"}
        </button>
      </div>

      <div className="lan-bar pcap-options">
        <label className="pcap-option" title="What is kept of each packet. Headers only holds who talked to whom, not what was said. Full packets is what Follow stream needs, and holds the content of unencrypted traffic.">
          Payload
          <select aria-label="Payload kept" value={payload} disabled={running} onChange={(e) => setSessionOption({ payload: e.target.value })}>
            {PAYLOADS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="lan-auto" title="Also receive packets addressed to other devices. Only useful when this host sits on a switch mirror (SPAN) port or a hub; on an ordinary port it changes nothing.">
          <input type="checkbox" checked={Boolean(opt.promisc) && iface !== "any"} disabled={running || iface === "any"} onChange={(e) => setSessionOption({ promisc: e.target.checked })} />
          Promiscuous
        </label>
        <span className="pcap-spacer" />
        <button type="button" className="btn btn--sm btn--ghost" aria-expanded={savedOpen} onClick={() => setSavedOpen((o) => !o)} title="Captures kept on the dashboard">
          {savedOpen ? "Hide saved" : canSave ? "Save / saved" : "Saved captures"}
        </button>
        {!idle && data.totals?.pkts > 0 && (
          <a className="btn btn--sm btn--ghost" href={viewing ? savedPcapUrl(viewing.meta.id) : pcapUrl(host)} title="Open in Wireshark — the packets listed here, as a .pcap file">
            <Icon name="download" /> .pcap
          </a>
        )}
      </div>

      {help && (
        <div className="pcap-help">
          <div className="pcap-examples">
            {EXAMPLES.map(([label, expr]) => (
              <button
                key={expr}
                type="button"
                className="pcap-example"
                onClick={() => (running || viewing ? setFilter(expr) : set({ expr }))}
                title={`${expr} — ${running || viewing ? "fills the display filter" : "fills the capture filter"}`}
              >
                <span>{label}</span>
                <code>{expr}</code>
              </button>
            ))}
          </div>
          <dl className="pcap-syntax">
            {SYNTAX.map(([form, note]) => (
              <div key={form}><dt className="net-mono">{form}</dt><dd>{note}</dd></div>
            ))}
            <div><dt className="net-mono">capture vs display</dt><dd>The capture filter (top) decides what is recorded and is fixed once started. The display filter (above the list) narrows what is shown, any time, on live and saved captures.</dd></div>
          </dl>
        </div>
      )}

      {savedOpen && <SavedCaptures host={host} canSave={canSave} onOpen={openSaved} />}

      {viewing && (
        <div className="pcap-banner">
          <span>
            Viewing saved capture <strong>{viewing.meta.name}</strong> from {viewing.meta.host} — read-only.
          </span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => { setViewing(null); setStream(null); setSelected(null); }}>Back to live</button>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
      {!viewing && job?.error && <p className="form-error">{job.error}</p>}

      {idle && !error && (
        <p className="lan-empty">
          Captures packets on {host}'s network for a set time and shows them live — who talked to whom, over what,
          how much, DNS lookups, TLS names, plain-HTTP requests, DHCP and NTP, and TCP trouble as it happens. Choose an
          interface and optionally a capture filter such as
          {" "}<code>host 192.168.1.10 and port 443</code> (see Filter help), then start. Nothing is written to disk
          until you save a capture; download the .pcap to open it in Wireshark.
        </p>
      )}

      {!idle && (
        <>
          <div className="pcap-stats">
            <div className="pcap-stat">
              <span className={`pcap-state pcap-state--${data.state}`}>{!viewing && running ? "● capturing" : data.state === "error" ? "failed" : data.state}</span>
              <span className="net-dim pcap-filter-text" title={filterText || undefined}>
                {data.iface}{filterText ? ` · ${filterText}` : ""}
                {data.payload && data.payload !== "none" ? ` · ${data.payload === "full" ? "full packets" : "64 B payload"}` : ""}
                {data.promisc ? " · promiscuous" : ""}
              </span>
            </div>
            <div className="pcap-stat"><strong className="net-mono">{(data.totals?.pkts || 0).toLocaleString()}</strong><span className="net-dim">packets</span></div>
            <div className="pcap-stat"><strong className="net-mono">{formatBytes(data.totals?.bytes || 0)}</strong><span className="net-dim">total</span></div>
            {!viewing && <div className="pcap-stat"><strong className="net-mono">{formatBytes(now.bytes)}/s</strong><span className="net-dim">{now.pkts} pkt/s</span></div>}
            {trouble > 0 && (
              <button type="button" className="pcap-stat pcap-stat--btn" onClick={() => showIssue("problem")} title="Show the TCP packets the capture flagged">
                <strong className="net-mono pcap-warn">{trouble.toLocaleString()}</strong><span className="net-dim">TCP problems</span>
              </button>
            )}
            <Throughput series={data.series || []} />
          </div>
          {data.drops > 0 && (
            <p className="pcap-alert" role="alert">
              The kernel dropped {data.drops.toLocaleString()} packet{data.drops === 1 ? "" : "s"} because they arrived faster than this could read them.
              Counts are a little low; narrow the capture filter or capture for less time.
            </p>
          )}
          {data.unlisted > 0 && (
            <p className="lan-meta pcap-note">
              Busy: {data.unlisted.toLocaleString()} packets are counted in the totals but left out of the list (it shows up to {data.payload === "full" ? 600 : 120} a second).
            </p>
          )}

          {stream ? (
            <PacketStream packets={pool} flow={stream} onClose={() => setStream(null)} />
          ) : (
            <>
              <div className="lan-bar">
                <div className="lan-view" role="group" aria-label="View">
                  {[["packets", "Packets"], ["flows", `Conversations${data.flows?.length ? ` ${data.flows.length}` : ""}`], ["protocols", "Protocols"]].map(([id, label]) => (
                    <button key={id} type="button" aria-pressed={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>
                  ))}
                </div>
                {view === "packets" && !viewing && (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setFrozenAt(paused ? null : pool[pool.length - 1]?.n ?? 0)} aria-pressed={paused}>
                    {paused ? "Resume list" : "Pause list"}
                  </button>
                )}
                <div className="pcap-display">
                  <input
                    className={`pcap-expr pcap-expr--display ${filter.trim() && display.error ? "pcap-expr--text" : ""}`}
                    type="search"
                    placeholder="Display filter — e.g. tcp and not port 22, problem, name *.lan"
                    aria-label="Display filter"
                    spellCheck={false}
                    autoComplete="off"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  {filter.trim() && (
                    <span className={`pcap-display-note ${display.error ? "pcap-display-note--text" : ""}`} title={display.error || undefined}>
                      {display.error ? `text search · ${display.error}` : view === "flows" ? `${matchedFlows.length} of ${data.flows?.length || 0} conversations` : `${visible.length.toLocaleString()} of ${pool.length.toLocaleString()}`}
                    </span>
                  )}
                </div>
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
                        {visible.map((p) => (
                          <tr
                            key={p.n}
                            className={`pcap-click ${selected?.n === p.n ? "pcap-row--selected" : ""} ${p.issues?.length ? (p.issues.some((i) => BAD.has(i)) ? "pcap-row--bad" : "pcap-row--warn") : ""}`}
                            tabIndex={0}
                            aria-selected={selected?.n === p.n}
                            onClick={() => setSelected(p)}
                            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSelected(p))}
                          >
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
                    {visible.length === 0 && <p className="lan-empty">{running ? "Waiting for packets…" : filter ? "Nothing in the list matches." : "No packets were captured."}</p>}
                  </div>
                  {selected && <Detail packet={selected} started={started} onClose={() => setSelected(null)} onFollow={setStream} />}
                </div>
              )}

              {view === "flows" && (
                <div className="lan-scroll">
                  <Flows
                    flows={matchedFlows}
                    onFilter={(ip) => { setFilter(`host ${ip}`); setView("packets"); }}
                    onFollow={setStream}
                  />
                </div>
              )}

              {view === "protocols" && <Protocols protocols={data.protocols || {}} issues={data.issues} onShow={showIssue} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default PacketCapture;
