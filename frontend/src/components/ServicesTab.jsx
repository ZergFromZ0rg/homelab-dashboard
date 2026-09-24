import { useState } from "react";
import CheckCard from "./CheckCard";
import CheckForm from "./CheckForm";
import { createCheck } from "./checksApi";
import { formatLatency } from "./format";
import { useNow } from "./useNow";

function Fact({ label, value, sub, bad }) {
  return (
    <div className={`fact ${bad ? "fact--bad" : ""}`}>
      <span className="fact-label">{label}</span>
      <strong className="fact-value">{value}</strong>
      {sub && <span className="fact-sub">{sub}</span>}
    </div>
  );
}

const ORDER = { down: 0, up: 1, pending: 2, paused: 3 };

// Is each thing actually answering? HTTP / TCP / DNS probes run from the
// dashboard backend on a schedule, with latency and uptime history.
function ServicesTab({ checks, connected }) {
  const now = useNow(1000).getTime() / 1000;
  const [adding, setAdding] = useState(false);

  const down = checks.filter((c) => c.status === "down").length;
  const up = checks.filter((c) => c.status === "up").length;
  const latencies = checks.filter((c) => c.latency_ms != null).map((c) => c.latency_ms);
  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
  // "Down" used to be its own tile, repeating the Up tile's own sub-line;
  // the slowest responder is the thing worth a tile of its own.
  const slowest = checks
    .filter((c) => c.status === "up" && c.latency_ms != null)
    .sort((a, b) => b.latency_ms - a.latency_ms)[0];
  const uptimes = checks.map((c) => c.uptime_24h).filter((v) => v != null);
  const uptime = uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null;

  const sorted = [...checks].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name)
  );

  return (
    <section className="services-tab">
      {checks.length > 0 && (
        <div className="facts-row">
          <Fact
            label="Answering"
            value={`${up} / ${checks.length}`}
            bad={down > 0}
          />
          <Fact label="Avg latency" value={formatLatency(avg)} />
          <Fact
            label="Slowest"
            value={slowest ? formatLatency(slowest.latency_ms) : "—"}
            sub={slowest?.name}
          />
          <Fact label="Uptime · 24 h" value={uptime == null ? "—" : `${uptime.toFixed(2)}%`} />
        </div>
      )}

      <div className="services-head">
        <h2 title="Probes run from the dashboard every minute (by default) and turn red after two failures in a row.">
          Service checks
        </h2>
        {!adding && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            + Add check
          </button>
        )}
      </div>

      {adding && (
        <div className="check check--editing">
          <CheckForm
            onCancel={() => setAdding(false)}
            onSubmit={async (values) => {
              await createCheck(values);
              setAdding(false);
            }}
          />
        </div>
      )}

      {checks.length === 0 && !adding ? (
        <div className="empty-state">
          {connected === false
            ? "Connecting…"
            : "No checks yet. Add one to see whether Jellyfin, your router, DNS or the internet are actually answering."}
        </div>
      ) : (
        <div className="checks-table">
          <div className="check-head-row" role="presentation">
            <span />
            <span>Service</span>
            <span>Now</span>
            <span>Recent</span>
            <span>24 h</span>
            <span>7 d</span>
            <span>30 d</span>
            <span />
          </div>
          {sorted.map((check) => (
            <CheckCard key={check.id} check={check} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

export default ServicesTab;
