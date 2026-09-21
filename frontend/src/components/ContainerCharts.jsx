import { useState } from "react";
import TimeChart from "./TimeChart";
import { fetchContainerHistory } from "./containerHistoryApi";
import { formatBytes } from "./format";
import { usePolled } from "./usePolled";

// CPU and memory for one container, over hours or days.
//
// The range row sits above both charts and scopes both, so the two always
// show the same slice — a per-chart range would let you compare a spike
// against a window that doesn't contain it.
const RANGES = [
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const formatPercent = (v, terse) =>
  terse ? `${Math.round(v)}%` : `${v.toFixed(v < 10 ? 1 : 0)}%`;
const formatMemory = (v, terse) =>
  terse ? formatBytes(v).replace(" ", "") : formatBytes(v);

function ContainerCharts({ host, name, open }) {
  const [range, setRange] = useState("24h");

  // Re-fetched on a range change (the key) and refreshed while the panel
  // stays open. usePolled keeps the last good data across a failed
  // refresh, so a blip doesn't blank the charts.
  const { data, error, loading } = usePolled(
    () => fetchContainerHistory(host, name, range),
    open ? `${host}/${name}/${range}` : null,
    open ? 60000 : 0
  );

  return (
    <div className="ccharts">
      <div className="ccharts-head">
        <span className="ccharts-title">History</span>
        <div className="segmented segmented--sm" role="group" aria-label="Time range">
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
      </div>

      {error && <p className="tchart-empty">{error}</p>}

      {/* Hold the previous render while refetching rather than collapsing
          the panel — no layout jump when the range changes. */}
      <div className={`ccharts-body ${loading && data ? "is-loading" : ""}`}>
        <TimeChart
          label="CPU"
          points={data?.points}
          valueKey="cpu"
          format={formatPercent}
          tone="cpu"
        />
        <TimeChart
          label="Memory"
          points={data?.points}
          valueKey="mem"
          format={formatMemory}
          tone="ram"
          base={1024}
        />
      </div>
    </div>
  );
}

export default ContainerCharts;
