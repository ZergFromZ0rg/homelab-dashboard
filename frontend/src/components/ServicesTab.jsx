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
  const uptimes = checks.map((c) => c.uptime_24h).filter((v) => v != null);
  const uptime = uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null;

  const sorted = [...checks].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name)
  );

  return (
    <section className="services-tab">
      {checks.length > 0 && (
        <div className="facts-row">
          <Fact label="Up" value={`${up} / ${checks.length}`} bad={down > 0} sub={down ? `${down} down` : "all answering"} />
          <Fact label="Down" value={down} bad={down > 0} />
          <Fact label="Avg latency" value={formatLatency(avg)} sub="across services" />
          <Fact label="Uptime · 24 h" value={uptime == null ? "—" : `${uptime.toFixed(2)}%`} />
        </div>
      )}

      <div className="services-head">
        <div>
          <h2>Service checks</h2>
          <p className="settings-hint">
            Probes run from the dashboard every minute (by default) and turn
            red after two failures in a row.
          </p>
        </div>
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
        <div className="checks-grid">
          {sorted.map((check) => (
            <CheckCard key={check.id} check={check} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

export default ServicesTab;
