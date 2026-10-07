import { useMemo, useState } from "react";
import { hostColor } from "./hostColor";
import { KINDS, layout, shortName } from "./topology";

// The LAN as a map: Internet → router → every device that answered, your own
// servers on the inner ring. Nodes glide to their new place as the scan finds
// more; devices seen on an earlier scan but missing now stay as faded ghosts.
// Devices come in already classified (see topology.js).

const PAD = 70;

function Node({ d, pos, selected, onSelect }) {
  const color = d.node ? hostColor(d.node) : undefined;
  return (
    <g
      className={`nmap-node nmap-node--${d.kind} ${d.gone ? "nmap-node--gone" : ""} ${d.isNew ? "nmap-node--new" : ""} ${selected ? "nmap-node--sel" : ""}`}
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)`, ...(color ? { "--host-color": color } : null) }}
      onClick={() => onSelect(d.key)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(d.key)}
      tabIndex={0}
      role="button"
      aria-label={`${shortName(d)} ${d.ip}`}
    >
      <title>{`${d.hostname || d.node || d.ip} · ${d.ip}${d.vendor ? ` · ${d.vendor}` : ""}${d.gone ? " · not seen this scan" : ""}`}</title>
      <circle r={d.node ? 17 : 13} className="nmap-dot" />
      <text y={d.node ? 33 : 29} className="nmap-label">
        {shortName(d).slice(0, 14)}
      </text>
      <text y={d.node ? 44 : 40} className="nmap-sub">
        {d.ip}
      </text>
    </g>
  );
}

function Detail({ d, onClose }) {
  return (
    <div className="nmap-detail">
      <div className="nmap-detail-head">
        <strong>{d.hostname || d.node || d.ip}</strong>
        <span className="net-dim">{KINDS[d.kind]}</span>
        <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close details">×</button>
      </div>
      <dl>
        <dt>IP</dt>
        <dd className="net-mono">{d.ip}</dd>
        <dt>MAC</dt>
        <dd className="net-mono">{d.mac || "—"}</dd>
        <dt>Maker</dt>
        <dd>{d.vendor || (d.randomized ? "Private address" : "—")}</dd>
        {d.gone ? (
          <>
            <dt>Last seen</dt>
            <dd>{new Date(d.last).toLocaleString()}</dd>
          </>
        ) : (
          <>
            <dt>Ports</dt>
            <dd>
              {d.ports == null
                ? "checking…"
                : d.ports.length
                  ? d.ports.map((p) => `${p.service} ${p.port}`).join(", ")
                  : "none open"}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

// devices: [{key, ip, mac, hostname, vendor, ports, kind, node, isNew, gone}]
export default function NetworkMap({ devices, gateway, subnet, scanning }) {
  const [selected, setSelected] = useState(null);
  const router = devices.find((d) => d.kind === "router");
  const mapped = useMemo(() => devices.filter((d) => d !== router), [devices, router]);
  const { positions, radius } = useMemo(() => layout(mapped), [mapped]);
  const extent = radius + PAD;
  const top = -(extent + 20);
  const picked = devices.find((d) => d.key === selected) || null;
  const kinds = [...new Set(devices.map((d) => d.kind))];

  return (
    <div className="nmap">
      <svg
        className="nmap-svg"
        viewBox={`${-extent} ${top} ${extent * 2} ${extent * 2 + 20 + 40}`}
        role="img"
        aria-label={`Network map: ${devices.length} devices on ${subnet || "the LAN"}`}
      >
        <g className="nmap-links">
          <line x1="0" y1="0" x2="0" y2={top + 24} className="nmap-link nmap-link--wan" />
          {mapped.map((d) => {
            const p = positions.get(d.key);
            return p ? (
              <line
                key={d.key}
                x1="0"
                y1="0"
                x2={p.x}
                y2={p.y}
                className={`nmap-link ${d.gone ? "nmap-link--gone" : ""}`}
                style={d.node ? { "--host-color": hostColor(d.node) } : undefined}
              />
            ) : null;
          })}
        </g>

        <g className="nmap-node nmap-node--internet" style={{ transform: `translate(0px, ${top + 12}px)` }}>
          <rect x="-34" y="-12" width="68" height="24" rx="12" className="nmap-dot" />
          <text y="4" className="nmap-label">Internet</text>
        </g>

        <g
          className={`nmap-node nmap-node--router ${scanning ? "nmap-node--pulse" : ""} ${selected === router?.key ? "nmap-node--sel" : ""}`}
          onClick={() => router && setSelected(router.key)}
          role={router ? "button" : undefined}
          tabIndex={router ? 0 : undefined}
        >
          <circle r="22" className="nmap-dot" />
          <text y="38" className="nmap-label">{router ? shortName(router) : "Router"}</text>
          <text y="49" className="nmap-sub">{router?.ip || gateway || "gateway unknown"}</text>
        </g>

        {mapped.map((d) => {
          const pos = positions.get(d.key);
          return pos ? <Node key={d.key} d={d} pos={pos} selected={selected === d.key} onSelect={setSelected} /> : null;
        })}
      </svg>

      <div className="nmap-foot">
        <span className="nmap-legend">
          {kinds.map((k) => (
            <span key={k} className={`nmap-key nmap-key--${k}`}>
              <i />
              {KINDS[k]}
            </span>
          ))}
        </span>
        {picked && <Detail d={picked} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
