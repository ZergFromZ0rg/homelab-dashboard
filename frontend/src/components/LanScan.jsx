import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchNodeAddresses, fetchScan, startScan } from "./lanApi";
import { hostColor } from "./hostColor";
import { useLocalStorage } from "./useLocalStorage";

// What is on this host's LAN, live. "Scan now" sweeps the subnet from the
// chosen host; devices appear as they are found, then their open ports and
// names fill in. Devices that weren't there on the previous scan get a "new"
// mark — the point of scanning twice. Optional auto-scan keeps it fresh.

const POLL_MS = 1000;
const AUTO_MS = 60_000;
const WEB = new Set(["http", "jellyfin", "https"]);

const ipKey = (ip) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

function Ports({ ip, ports }) {
  if (ports == null) return <span className="net-dim">…</span>;
  if (ports.length === 0) return <span className="net-dim">—</span>;
  return (
    <span className="lan-ports">
      {ports.map((p) =>
        WEB.has(p.service) ? (
          <a
            key={p.port}
            className="lan-port lan-port--web"
            href={`${p.service === "https" || p.port === 443 ? "https" : "http"}://${ip}:${p.port}`}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${ip}:${p.port}`}
          >
            {p.service} {p.port}
          </a>
        ) : (
          <span key={p.port} className="lan-port">{p.service} {p.port}</span>
        )
      )}
    </span>
  );
}

function LanScan({ host }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [nodes, setNodes] = useState({});
  const [auto, setAuto] = useLocalStorage("lanAuto", false);
  const [known, setKnown] = useLocalStorage("lanKnown", {});
  // What the previous scan of this host saw, held for the scan on screen.
  const baseline = useRef(null);
  const live = useRef(true);

  const poll = useCallback(async () => {
    try {
      const body = await fetchScan(host);
      if (live.current) setJob(body);
      return body;
    } catch (e) {
      if (live.current) setError(e.message);
      return null;
    }
  }, [host]);

  const scan = useCallback(async () => {
    setError("");
    baseline.current = new Set(known[host] || []);
    try {
      const body = await startScan(host);
      setJob(body);
    } catch (e) {
      setError(e.message);
    }
  }, [host, known]);

  useEffect(() => {
    live.current = true;
    baseline.current = new Set(known[host] || []);
    poll();
    return () => {
      live.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per host
  }, [host]);

  // Which devices are the dashboard's own nodes, by IP or MAC.
  useEffect(() => {
    let alive = true;
    fetchNodeAddresses()
      .then((body) => alive && setNodes(body.nodes || {}))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const byAddress = useMemo(() => {
    const map = new Map();
    for (const [name, addrs] of Object.entries(nodes)) {
      for (const a of addrs) {
        map.set(a.ip, name);
        if (a.mac) map.set(a.mac.toLowerCase(), name);
      }
    }
    return map;
  }, [nodes]);
  const nodeOf = (d) => byAddress.get(d.ip) || (d.mac && byAddress.get(d.mac.toLowerCase())) || null;

  const scanning = job?.state === "scanning";
  useEffect(() => {
    if (!scanning) return undefined;
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [scanning, poll]);

  // A finished scan becomes the next scan's baseline.
  const finishedAt = job?.state === "done" ? job.finished_at : null;
  useEffect(() => {
    if (!finishedAt) return;
    setKnown((all) => ({ ...all, [host]: job.devices.map((d) => d.mac || d.ip) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per finished scan
  }, [finishedAt, host]);

  useEffect(() => {
    if (!auto) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && job?.state !== "scanning") scan();
    }, AUTO_MS);
    return () => clearInterval(timer);
  }, [auto, scan, job?.state]);

  const firstScan = !baseline.current || baseline.current.size === 0;
  const devices = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...(job?.devices || [])]
      .filter((d) => !q || `${d.ip} ${d.mac || ""} ${d.hostname || ""} ${nodeOf(d) || ""} ${(d.ports || []).map((p) => p.service).join(" ")}`.toLowerCase().includes(q))
      .sort((a, b) => ipKey(a.ip) - ipKey(b.ip));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeOf follows byAddress
  }, [job, filter, byAddress]);

  const isNew = (d) => !firstScan && !baseline.current.has(d.mac || d.ip);
  const newCount = (job?.devices || []).filter(isNew).length;
  const ownCount = (job?.devices || []).filter((d) => nodeOf(d)).length;
  const pct = job?.total ? Math.round((job.scanned / job.total) * 100) : 0;
  const idle = !job || job.state === "idle";

  return (
    <div className="lan">
      <div className="lan-bar">
        <button type="button" className="btn btn--primary" onClick={scan} disabled={scanning}>
          {scanning ? "Scanning…" : idle ? "Scan the network" : "Scan again"}
        </button>
        <label className="lan-auto" title="Scan again every minute while this page is open">
          <input type="checkbox" checked={Boolean(auto)} onChange={(e) => setAuto(e.target.checked)} />
          Auto-scan
        </label>
        {job?.subnet && (
          <span className="lan-meta">
            {job.subnet} from {host} · {job.devices.length} device{job.devices.length === 1 ? "" : "s"}
            {ownCount > 0 && <> · {ownCount} yours</>}
            {newCount > 0 && <strong className="lan-new-count"> · {newCount} new</strong>}
          </span>
        )}
        <input
          className="lan-filter"
          type="search"
          placeholder="Filter…"
          aria-label="Filter devices"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {scanning && (
        <div className="lan-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${job.phase === "sweeping" ? pct : 100}%` }} />
          <em>{job.phase === "sweeping" ? `Sweeping ${job.scanned}/${job.total}` : job.phase === "arp" ? "Reading MAC addresses" : "Checking ports"}</em>
        </div>
      )}

      {(error || job?.error) && <p className="form-error">{error || job.error}</p>}

      {idle && !error && (
        <p className="lan-empty">
          Sweeps the network {host} is on and lists every device that answers — name, MAC, open ports.
          Run it twice and anything new is marked.
        </p>
      )}

      {devices.length > 0 && (
        <table className="net-table lan-table">
          <thead>
            <tr>
              <th>IP</th>
              <th>Name</th>
              <th>MAC</th>
              <th>Open ports</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => {
              const node = nodeOf(d);
              return (
              <tr
                key={d.ip}
                className={`${isNew(d) ? "lan-row--new" : ""} ${node ? "lan-row--node" : ""}`}
                style={node ? { "--host-color": hostColor(node) } : undefined}
              >
                <td className="net-mono">
                  {d.ip}
                  {isNew(d) && <span className="chip chip--warn">new</span>}
                </td>
                <td>
                  {node ? (
                    <span className="lan-node" style={{ "--host-color": hostColor(node) }} title={d.via === "self" ? `${node} — the host running this scan` : `${node} — one of your nodes`}>
                      <span className="lan-node-dot" />
                      {node}
                      {d.via === "self" && <em>scanner</em>}
                    </span>
                  ) : (
                    d.hostname || <span className="net-dim">—</span>
                  )}
                </td>
                <td className="net-mono net-dim">{d.mac || "—"}</td>
                <td><Ports ip={d.ip} ports={d.ports} /></td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default LanScan;
