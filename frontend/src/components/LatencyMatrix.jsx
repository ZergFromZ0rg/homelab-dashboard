import { fetchMatrix } from "./checksApi";
import { formatLatency } from "./format";
import { hostColor } from "./hostColor";
import { usePolled } from "./usePolled";

// Latency between your machines: a row pings a column from the row's own
// agent. The cells are ordinary ping checks (Services → "Between hosts"), so
// this only appears once at least one exists; an empty pair is just "—".
function LatencyMatrix() {
  const { data } = usePolled(fetchMatrix, "matrix", 15_000);
  const hosts = data?.hosts ?? [];
  const cells = new Map((data?.cells ?? []).map((c) => [`${c.from}>${c.to}`, c]));
  if (cells.size === 0) return null;

  return (
    <div className="latency-matrix" role="table" aria-label="Latency between hosts">
      <div className="latency-matrix-row" role="row" style={{ "--cols": hosts.length }}>
        <span className="latency-matrix-corner" role="columnheader" title="Row pings column">from ↓ to →</span>
        {hosts.map((h) => (
          <span key={h} role="columnheader" className="latency-matrix-host" style={{ color: hostColor(h) }}>
            {h}
          </span>
        ))}
      </div>
      {hosts.map((from) => (
        <div key={from} className="latency-matrix-row" role="row" style={{ "--cols": hosts.length }}>
          <span role="rowheader" className="latency-matrix-host" style={{ color: hostColor(from) }}>
            {from}
          </span>
          {hosts.map((to) => {
            const cell = cells.get(`${from}>${to}`);
            if (from === to || !cell) {
              return <span key={to} role="cell" className="latency-matrix-cell latency-matrix-cell--none">—</span>;
            }
            const state = cell.status === "down" ? "down" : cell.status === "degraded" ? "slow" : cell.latency_ms == null ? "none" : "up";
            const title = [
              `${from} → ${to}`,
              cell.status === "down" ? cell.detail : null,
              cell.p95_ms_24h != null ? `p95 ${formatLatency(cell.p95_ms_24h)} · 24 h` : null,
              cell.uptime_24h != null ? `${cell.uptime_24h.toFixed(2)}% up · 24 h` : null,
            ]
              .filter(Boolean)
              .join("\n");
            return (
              <span key={to} role="cell" className={`latency-matrix-cell latency-matrix-cell--${state}`} title={title}>
                {cell.status === "down" ? "down" : formatLatency(cell.latency_ms)}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default LatencyMatrix;
