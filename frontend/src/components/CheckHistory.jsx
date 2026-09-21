import { useState } from "react";
import Sparkline from "./Sparkline";
import { fetchCheckHistory } from "./checksApi";
import { usePolled } from "./usePolled";

const RANGES = [
  { value: "3h", label: "3 h" },
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
];

function barState(point) {
  if (point.n === 0) return "empty";
  if (point.up === point.n) return "up";
  if (point.up === 0) return "down";
  return "partial";
}

function barTitle(point, bucketSeconds) {
  const when = new Date(point.t * 1000);
  const stamp =
    bucketSeconds >= 3600
      ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })
      : when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (point.n === 0) return `${stamp} — no data`;
  const ms = point.ms_avg != null ? ` · ${Math.round(point.ms_avg)} ms avg` : "";
  return `${stamp} — ${point.up}/${point.n} checks passed${ms}`;
}

// Uptime bars (one per time slot) and the latency line for a chosen range.
function CheckHistory({ check }) {
  const [range, setRange] = useState("24h");
  const { data, error, loading } = usePolled(
    () => fetchCheckHistory(check.id, range),
    `${check.id}:${range}`,
    30_000
  );

  const latency = data?.points
    .filter((p) => p.ms_avg != null)
    .map((p) => ({ v: p.ms_avg }));
  const peak = data ? Math.max(0, ...data.points.map((p) => p.ms_max ?? 0)) : 0;

  return (
    <div className="check-history">
      <div className="check-history-head">
        <div className="segmented segmented--sm" role="group" aria-label="History range">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              className={range === r.value ? "active" : ""}
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
        {data && (
          <span className="check-history-uptime">
            {data.uptime != null ? `${data.uptime}% up` : "no data yet"}
            {peak > 0 && ` · peak ${Math.round(peak)} ms`}
          </span>
        )}
      </div>

      {loading && <p className="overview-empty">Loading…</p>}
      {!loading && !data && <p className="overview-empty">Couldn't load history{error ? ` (${error})` : ""}.</p>}

      {data && (
        <>
          <div className="heartbeat">
            <div className="heartbeat-bars heartbeat-bars--tall">
              {data.points.map((p) => (
                <div
                  key={p.t}
                  className={`heartbeat-bar heartbeat-bar--${barState(p)}`}
                  title={barTitle(p, data.bucket_seconds)}
                />
              ))}
            </div>
          </div>

          {latency.length > 1 ? (
            <>
              <Sparkline points={latency} variant="rx" height={44} />
              <div className="sparkline-axis">
                <span>{RANGES.find((r) => r.value === range).label} ago</span>
                <span>now</span>
              </div>
            </>
          ) : (
            <p className="overview-empty">Not enough successful checks yet to draw latency.</p>
          )}
        </>
      )}
    </div>
  );
}

export default CheckHistory;
