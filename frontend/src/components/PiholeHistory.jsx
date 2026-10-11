import TimeChart from "./TimeChart";
import { coverageNote, DNS_RANGES, fetchPiholeHistory } from "./piholeHistoryApi";
import { stepLabel } from "./hostHistoryApi";
import { usePolled } from "./usePolled";
import { useLocalStorage } from "./useLocalStorage";

// DNS over hours to months, read from Pi-hole's own long-term database. The range
// row scopes everything below it: the two charts, the totals and the three
// "most" tables.

const REFRESH_MS = 60000;
const perHour = (v, terse) => (terse ? `${Math.round(v)}` : `${Math.round(v).toLocaleString()}/h`);
const percent = (v, terse) => (terse ? `${Math.round(v)}%` : `${v.toFixed(1)}%`);

function Top({ title, rows, name, hint }) {
  if (!rows?.length) return null;
  const peak = Math.max(...rows.map((r) => r.count));
  return (
    <div className="dh-top" title={hint}>
      <div className="dh-head dh-head--flush">{title}</div>
      <table className="net-table">
        <tbody>
          {rows.map((r) => (
            <tr key={name(r)}>
              <td className="dh-name" title={name(r)}>{name(r)}</td>
              <td className="pcap-r net-mono">{r.count.toLocaleString()}</td>
              <td className="dh-bar"><span style={{ width: `${Math.max(3, Math.round((100 * r.count) / peak))}%` }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PiholeHistory() {
  const [range, setRange] = useLocalStorage("dnsRange", "7d");
  const chosen = DNS_RANGES.includes(range) ? range : "7d";
  const { data, error, loading } = usePolled(() => fetchPiholeHistory(chosen), chosen, REFRESH_MS);
  const note = coverageNote(data);
  const s = data?.summary;

  return (
    <div className="dns-hist">
      <div className="ccharts-head">
        <div className="segmented segmented--sm" role="group" aria-label="Time range">
          {DNS_RANGES.map((r) => (
            <button key={r} type="button" className={chosen === r ? "active" : ""} aria-pressed={chosen === r} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        {data && <span className="net-dim" title="Each point averages this much time, shown as queries per hour">each point {stepLabel(data.step)}</span>}
        {note && <span className="hist-warn" title="Pi-hole's database only goes back to when it was set up; a longer range fills in over time">{note}</span>}
        {error && <span className="hist-warn">{error}</span>}
      </div>

      {s && (
        <div className="dns-hist-totals">
          <span><strong>{s.queries?.toLocaleString() ?? "—"}</strong> queries</span>
          <span><strong>{s.blocked_pct != null ? `${s.blocked_pct}%` : "—"}</strong> blocked</span>
          <span><strong>{s.clients ?? "—"}</strong> devices</span>
        </div>
      )}

      <div className={`ccharts-body hist-body ${loading && data ? "is-loading" : ""}`}>
        <TimeChart label="Queries per hour" points={data?.points} valueKey="queries_per_hour" format={perHour} tone="cpu" emptyText="No queries in this range yet." />
        <TimeChart label="Blocked" points={data?.points} valueKey="blocked_pct" format={percent} tone="temp" max={Math.max(20, Math.ceil(Math.max(0, ...(data?.points || []).map((p) => p.blocked_pct ?? 0)) / 10) * 10)} emptyText="No queries in this range yet." />
      </div>

      {data && (
        <div className="dns-tops">
          <Top title="Most asked" rows={data.top_asked} name={(r) => r.domain} />
          <Top title="Most blocked" rows={data.top_blocked} name={(r) => r.domain} hint="Includes names Pi-hole refuses on purpose (iCloud Private Relay, the Firefox canary domain)" />
          <Top title="Busiest devices" rows={data.top_clients} name={(r) => r.name} />
        </div>
      )}
    </div>
  );
}

export default PiholeHistory;
