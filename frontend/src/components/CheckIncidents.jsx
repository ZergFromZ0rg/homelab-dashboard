import { fetchIncidents } from "./checksApi";
import { formatDuration, formatWhen } from "./format";
import { usePolled } from "./usePolled";

// One line per downtime episode: when it started, how long it lasted, and
// what the probe said. `list` is passed in by CheckHistory (one check);
// without it the whole fleet's last week is fetched.
export function IncidentRows({ incidents, now, showName = true }) {
  return (
    <ul className={`incident-list ${showName ? "" : "incident-list--solo"}`}>
      {incidents.map((i) => (
        <li key={`${i.check_id}:${i.start}`} className={i.end == null ? "incident incident--ongoing" : "incident"}>
          <span className="incident-when">{formatWhen(i.start)}</span>
          {showName && <strong className="incident-name">{i.name}</strong>}
          <span className="incident-len">
            {i.end == null ? `down ${formatDuration(now - i.start)} — ongoing` : `down ${formatDuration(i.end - i.start)}`}
          </span>
          <span className="incident-detail" title={i.detail ?? undefined}>{i.detail ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

function CheckIncidents({ now }) {
  const { data, error, loading } = usePolled(() => fetchIncidents(168), "incidents", 30_000);
  const list = data?.incidents ?? [];

  return (
    <div className="check-incidents">
      {loading && <p className="overview-empty">Loading…</p>}
      {!loading && !data && <p className="overview-empty">Couldn't load incidents{error ? ` (${error})` : ""}.</p>}
      {data && list.length === 0 && <p className="overview-empty">No downtime in the last 7 days.</p>}
      {list.length > 0 && <IncidentRows incidents={list} now={now} />}
    </div>
  );
}

export default CheckIncidents;
