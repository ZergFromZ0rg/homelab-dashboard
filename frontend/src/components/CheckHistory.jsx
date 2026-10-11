import { useState } from "react";
import TimeChart from "./TimeChart";
import { IncidentRows } from "./CheckIncidents";
import { fetchCheckHistory } from "./checksApi";
import { formatLatency } from "./format";
import { useNow } from "./useNow";
import { usePolled } from "./usePolled";

const RANGES = [
  { value: "3h", label: "3 h" },
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
  { value: "90d", label: "90 d" },
];

const percent = (v, terse) => (terse ? `${Math.round(v)}%` : `${v.toFixed(v < 10 ? 1 : 0)}%`);
const milliseconds = (v, terse) => (terse ? `${Math.round(v)}` : formatLatency(v));

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
  const ms =
    point.ms_avg != null
      ? ` · ${Math.round(point.ms_avg)} ms avg` +
        (point.ms_p95 != null ? `, p95 ${Math.round(point.ms_p95)} ms` : "")
      : "";
  return `${stamp} — ${point.up}/${point.n} checks passed${ms}`;
}

// Uptime bars (one per time slot) and the latency line for a chosen range.
function CheckHistory({ check }) {
  const [range, setRange] = useState("24h");
  const now = useNow(1000).getTime() / 1000;
  const { data, error, loading } = usePolled(
    () => fetchCheckHistory(check.id, range),
    `${check.id}:${range}`,
    30_000
  );

  // Loss and jitter exist only for a ping that sends several echoes.
  const lossy = data?.points.some((p) => p.loss_avg != null);
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
            {data.p50 != null && ` · p50 ${formatLatency(data.p50)}`}
            {data.p95 != null && ` · p95 ${formatLatency(data.p95)}`}
            {peak > 0 && ` · peak ${formatLatency(peak)}`}
            {data.loss != null && ` · ${data.loss}% loss`}
            {data.jitter != null && ` · ${data.jitter} ms jitter`}
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

          <div className="ccharts-body check-charts">
            <TimeChart label="Latency (average)" points={data.points} valueKey="ms_avg" format={milliseconds} tone="cpu" emptyText="Not enough successful checks yet to draw latency." />
            {lossy && <TimeChart label="Packet loss (average)" points={data.points} valueKey="loss_avg" format={percent} tone="temp" emptyText="No loss data in this range." />}
            {lossy && <TimeChart label="Jitter (average)" points={data.points} valueKey="jitter_avg" format={milliseconds} tone="ram" emptyText="No jitter data in this range." />}
          </div>

          {data.incidents?.length > 0 && (
            <IncidentRows incidents={data.incidents.slice(0, 6)} now={now} showName={false} />
          )}
        </>
      )}
    </div>
  );
}

export default CheckHistory;
