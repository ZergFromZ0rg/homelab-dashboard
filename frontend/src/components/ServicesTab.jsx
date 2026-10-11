import { useState } from "react";
import CheckCard from "./CheckCard";
import CheckForm from "./CheckForm";
import CheckIncidents from "./CheckIncidents";
import CheckSuggestions from "./CheckSuggestions";
import LatencyMatrix from "./LatencyMatrix";
import { createCheck } from "./checksApi";
import { arrange, isAnswering, isBehind, isRootDown } from "./checkStatus";
import { formatLatency } from "./format";
import { useLocalStorage } from "./useLocalStorage";
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

// Is each thing actually answering? HTTP / TCP / DNS probes run from the
// dashboard backend on a schedule, with latency and uptime history.
// `essential` is the look-only version (Advanced): what is up and how it has
// been, without adding, editing, pausing or deleting, the latency matrix or
// the suggestions. God keeps all of that.
function ServicesTab({ checks, connected, hosts = [], essential = false }) {
  const now = useNow(1000).getTime() / 1000;
  const [adding, setAdding] = useState(false);
  const [showIncidents, setShowIncidents] = useState(false);

  const [collapsed, setCollapsed] = useLocalStorage("checkGroupsCollapsed", {});

  const down = checks.filter(isRootDown).length;
  const behind = checks.filter(isBehind).length;
  const slow = checks.filter((c) => c.status === "degraded").length;
  const up = checks.filter(isAnswering).length;
  // Median of the checks' own medians ("typical"), and the worst 95th
  // percentile — the one number that shows a spike an average hides.
  const medians = checks.map((c) => c.p50_ms_24h).filter((v) => v != null).sort((a, b) => a - b);
  const typical = medians.length ? medians[Math.floor(medians.length / 2)] : null;
  const worst = checks
    .filter((c) => c.p95_ms_24h != null)
    .sort((a, b) => b.p95_ms_24h - a.p95_ms_24h)[0];
  const uptimes = checks.map((c) => c.uptime_24h).filter((v) => v != null);
  const uptime = uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null;
  const incidents = checks.reduce((n, c) => n + (c.incidents_24h ?? 0), 0);

  const groups = arrange(checks);
  const grouped = groups.some((g) => g.name !== "");
  const groupNames = [...new Set(checks.map((c) => c.group).filter(Boolean))].sort();

  return (
    <section className="services-tab">
      {checks.length > 0 && (
        <div className={`facts-row facts-row--checks ${down ? "facts-row--bad" : ""}`}>
          <Fact
            label="Answering"
            value={`${up} / ${checks.length}`}
            bad={down > 0}
            sub={[slow && `${slow} slow`, behind && `${behind} behind a down check`].filter(Boolean).join(" · ") || undefined}
          />
          <Fact label="Typical" value={formatLatency(typical)} sub="p50" />
          <Fact
            label="Slowest"
            value={worst ? formatLatency(worst.p95_ms_24h) : "—"}
            sub={worst ? `p95 · ${worst.name}` : undefined}
          />
          <Fact label="Uptime · 24 h" value={uptime == null ? "—" : `${uptime.toFixed(2)}%`} />
          <button
            type="button"
            className={`fact fact--button ${incidents ? "fact--warn" : ""}`}
            aria-expanded={showIncidents}
            title="Downtime episodes, newest first"
            onClick={() => setShowIncidents((v) => !v)}
          >
            <span className="fact-label">Incidents · 24 h</span>
            <strong className="fact-value">{incidents}</strong>
            <span className="fact-sub">{showIncidents ? "hide" : "show"}</span>
          </button>
        </div>
      )}

      {showIncidents && <CheckIncidents now={now} />}

      {!essential && <LatencyMatrix />}

      {!essential && <CheckSuggestions />}

      <div className="services-head">
        <h2 title="Probes run from the dashboard every minute (by default) and turn red after two failures in a row.">
          Service checks
        </h2>
        {!adding && !essential && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            + Add check
          </button>
        )}
      </div>

      {adding && (
        <div className="check check--editing">
          <CheckForm
            others={checks}
            groups={groupNames}
            hosts={hosts}
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
            : essential
              ? "No checks yet. They are added in God mode."
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
          {groups.map((group) => {
            const shut = grouped && Boolean(collapsed[group.name]);
            return (
              <div key={group.name} className="check-group">
                {grouped && (
                  <button
                    type="button"
                    className="check-group-head"
                    aria-expanded={!shut}
                    onClick={() => setCollapsed({ ...collapsed, [group.name]: !shut })}
                  >
                    <span className="check-group-caret">{shut ? "▸" : "▾"}</span>
                    <strong>{group.name || "Other"}</strong>
                    <span className="check-group-count">{group.rows.length}</span>
                    {group.down > 0 && <span className="chip chip--bad">{group.down} down</span>}
                    {group.slow > 0 && <span className="chip chip--warn">{group.slow} slow</span>}
                  </button>
                )}
                {!shut &&
                  group.rows.map(({ check, depth }) => (
                    <CheckCard
                      key={check.id}
                      check={check}
                      now={now}
                      depth={depth}
                      all={checks}
                      groups={groupNames}
                      hosts={hosts}
                      readOnly={essential}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default ServicesTab;
