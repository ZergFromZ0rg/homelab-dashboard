import { useEffect, useMemo, useRef, useState } from "react";
import { hostColor } from "./hostColor";
import { KINDS, layout, shortName } from "./topology";

// The LAN as a map: Internet → router → every device that answered, your own
// servers on the inner ring. Nodes glide to their new place as the scan finds
// more; devices seen on an earlier scan but missing now stay as faded ghosts.
// Devices come in already classified (see topology.js).

const MARGIN_X = 60; // room for a label past the outermost node
const MARGIN_TOP = 56; // the Internet pill
const MARGIN_BOTTOM = 56;

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
      <title>{`${d.custom || d.hostname || d.node || d.guess?.kind || d.ip} · ${d.ip}${d.vendor ? ` · ${d.vendor}` : ""}${d.gone ? " · not seen this scan" : ""}`}</title>
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

function Detail({ d, onClose, onRename }) {
  return (
    <div className="nmap-detail">
      <div className="nmap-detail-head">
        <strong>{d.custom || d.hostname || d.node || d.guess?.kind || d.ip}</strong>
        <span className="net-dim" title={d.guess ? `Guess: ${d.guess.why}` : undefined}>{d.guess?.kind || KINDS[d.kind]}</span>
        <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close details">×</button>
      </div>
      <dl>
        {!d.node && onRename && (
          <>
            <dt>Name</dt>
            <dd>
              <input
                key={d.key}
                className="lan-rename"
                defaultValue={d.custom || ""}
                placeholder={d.hostname || d.guess?.kind || "Name this device"}
                maxLength={60}
                aria-label={`Name for ${d.ip}`}
                onBlur={(e) => e.target.value.trim() !== (d.custom || "") && onRename(d.key, e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            </dd>
          </>
        )}
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
export default function NetworkMap({ devices, gateway, subnet, scanning, onRename }) {
  const [selected, setSelected] = useState(null);
  const router = devices.find((d) => d.kind === "router");
  const mapped = useMemo(() => devices.filter((d) => d !== router), [devices, router]);
  // The drawing is 1:1 with the pixels it gets, so text stays crisp and the
  // rings stretch to whatever shape the pane is.
  const box = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const watch = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: Math.round(width), h: Math.round(height) });
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const rx = Math.max(120, size.w / 2 - MARGIN_X);
  const ry = Math.max(120, size.h / 2 - Math.max(MARGIN_TOP, MARGIN_BOTTOM));
  const { positions } = useMemo(() => layout(mapped, { rx, ry }), [mapped, rx, ry]);
  const top = -size.h / 2 + 4;
  const picked = devices.find((d) => d.key === selected) || null;
  const kinds = [...new Set(devices.map((d) => d.kind))];

  return (
    <div className="nmap">
      <div className="nmap-stage" ref={box}>
      <svg
        className="nmap-svg"
        viewBox={`${-size.w / 2} ${-size.h / 2} ${size.w} ${size.h}`}
        role="img"
        aria-label={`Network map: ${devices.length} devices on ${subnet || "the LAN"}`}
      >
        <g className="nmap-links">
          <line x1="0" y1="0" x2="0" y2={top + 12} className="nmap-link nmap-link--wan" />
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
      </div>

      <div className="nmap-foot">
        <span className="nmap-legend">
          {kinds.map((k) => (
            <span key={k} className={`nmap-key nmap-key--${k}`}>
              <i />
              {KINDS[k]}
            </span>
          ))}
        </span>
        {picked && <Detail d={picked} onClose={() => setSelected(null)} onRename={onRename} />}
      </div>
    </div>
  );
}
