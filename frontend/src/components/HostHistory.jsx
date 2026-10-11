import TimeChart from "./TimeChart";
import { fetchHostHistory, RANGES, stepLabel } from "./hostHistoryApi";
import { formatBytes } from "./format";
import { usePolled } from "./usePolled";
import { useLocalStorage } from "./useLocalStorage";

// One host over hours to months. The range row scopes every chart, so they
// always show the same slice. Each point is the average over its step (the peak,
// for temperature): the step is said beside the picker, since a month of
// 2-hour points hides a 10-minute spike and the reader should know it.

const percent = (v, terse) => (terse ? `${Math.round(v)}%` : `${v.toFixed(v < 10 ? 1 : 0)}%`);
const degrees = (v, terse) => (terse ? `${Math.round(v)}°` : `${v.toFixed(0)}°C`);
const load = (v) => v.toFixed(2);
const watts = (v, terse) => (terse ? `${Math.round(v)}W` : `${v.toFixed(0)} W`);
const rate = (v, terse) => `${formatBytes(v).replace(" ", terse ? "" : " ")}/s`;

const REFRESH_MS = 60000;
const NONE = "No data in this range yet.";

function Chart({ label, points, valueKey = "v", format, tone = "cpu", max, base }) {
  return (
    <TimeChart label={label} points={points} valueKey={valueKey} format={format} tone={tone} max={max} base={base} emptyText={NONE} />
  );
}

function Gpu({ gpu }) {
  const has = (key) => gpu.points.some((p) => p[key] != null);
  return (
    <>
      {has("utilization") && <Chart label={`${gpu.name} · load`} points={gpu.points} valueKey="utilization" format={percent} max={100} />}
      {has("active") && <Chart label={`${gpu.name} · active`} points={gpu.points} valueKey="active" format={percent} max={100} />}
      {has("memory") && <Chart label={`${gpu.name} · VRAM`} points={gpu.points} valueKey="memory" format={percent} tone="ram" max={100} />}
      {has("temperature") && <Chart label={`${gpu.name} · temperature`} points={gpu.points} valueKey="temperature" format={degrees} tone="temp" />}
      {has("power") && <Chart label={`${gpu.name} · power`} points={gpu.points} valueKey="power" format={watts} tone="ram" />}
    </>
  );
}

function HostHistory({ host }) {
  const [range, setRange] = useLocalStorage("historyRange", "24h");
  const chosen = RANGES.includes(range) ? range : "24h";

  // Refetched on a host or range change (the key) and refreshed while open.
  // usePolled keeps the last good data across a failed refresh.
  const { data, error, loading } = usePolled(
    () => fetchHostHistory(host, chosen),
    `${host}/${chosen}`,
    REFRESH_MS,
  );
  const s = data?.series || {};
  const gpus = data?.gpus || [];

  return (
    <div className="overview-card hist">
      <div className="ccharts-head">
        <div className="segmented segmented--sm" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r} type="button" className={chosen === r ? "active" : ""} aria-pressed={chosen === r} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        {data && <span className="net-dim" title="Each point averages this much time (temperature shows the peak)">each point {stepLabel(data.step)}</span>}
        {data && data.prometheus === false && (
          <span className="hist-warn" title={data.error || "No node_exporter job for this host"}>
            {data.error ? "Prometheus can't be reached: host graphs are missing" : "No Prometheus job for this host: only its GPU has history"}
          </span>
        )}
        {error && <span className="hist-warn">{error}</span>}
      </div>

      <div className={`ccharts-body hist-body ${loading && data ? "is-loading" : ""}`}>
        {(data?.prometheus ?? true) && (
          <>
            <Chart label="CPU" points={s.cpu} format={percent} max={100} />
            <Chart label="Memory" points={s.ram} format={percent} tone="ram" max={100} />
            <Chart label="CPU temperature (peak)" points={s.temperature} format={degrees} tone="temp" />
            <Chart label="Load (1 min)" points={s.load} format={load} />
            <Chart label="Network down" points={s.network_rx} format={rate} tone="ram" base={1024} />
            <Chart label="Network up" points={s.network_tx} format={rate} base={1024} />
            {(s.disks || []).map((d) => (
              <Chart key={d.device} label={`Disk full · ${d.mountpoint}`} points={d.points} format={percent} max={100} tone="temp" />
            ))}
          </>
        )}
        {gpus.map((gpu) => (
          <Gpu key={gpu.key} gpu={gpu} />
        ))}
      </div>
    </div>
  );
}

export default HostHistory;
