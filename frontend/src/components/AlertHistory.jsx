import { formatDuration, formatWhen } from "./format";
import { useNow } from "./useNow";

// Episodes from /api/alerts — one per alert key, opened when it fired and
// closed when it resolved. Before this the only record of a 3am page was
// whatever the webhook receiver kept.
//
// Still-firing episodes sit on top (they're the ones you can still act
// on); everything else is most-recently-resolved first.
function ordered(alerts) {
  const firing = alerts.filter((a) => a.resolved_at == null);
  const done = alerts.filter((a) => a.resolved_at != null);
  firing.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  done.sort((a, b) => b.resolved_at - a.resolved_at);
  return [...firing, ...done];
}

function span(alert, nowSeconds) {
  if (alert.at == null) return null; // resolved something we never saw start
  const end = alert.resolved_at ?? nowSeconds;
  return formatDuration(end - alert.at);
}

function AlertHistory({ alerts }) {
  const now = useNow(30000);

  if (!alerts || alerts.length === 0) {
    return <p className="overview-empty">No alerts recorded yet.</p>;
  }

  const nowSeconds = now.getTime() / 1000;

  return (
    <ul className="alert-history">
      {ordered(alerts).map((a, i) => {
        const firing = a.resolved_at == null;
        const length = span(a, nowSeconds);

        return (
          <li
            key={`${a.key}-${a.at ?? a.resolved_at}-${i}`}
            className={`alert-entry ${firing ? "alert-entry--firing" : ""}`}
          >
            <span
              className={`status-dot status-dot--${
                firing ? a.severity || "bad" : "ok"
              }`}
            />
            <div className="alert-entry-text">
              <strong>{a.title}</strong>
              <span className="alert-entry-message">{a.message}</span>
            </div>
            <div
              className="alert-entry-when"
              title={
                firing
                  ? `Firing since ${formatWhen(a.at)}`
                  : `${formatWhen(a.at)} → ${formatWhen(a.resolved_at)}`
              }
            >
              <span className="alert-entry-state">
                {firing ? "firing" : "resolved"}
                {length ? ` · ${length}` : ""}
              </span>
              <time className="alert-entry-time">
                {formatWhen(a.at ?? a.resolved_at)}
              </time>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default AlertHistory;
