import { ACTIVITY_DOT } from "./activityKinds";
import { formatDuration, formatWhen } from "./format";
import { useNow } from "./useNow";

// Alert history and fleet activity as one list, newest first — "what
// happened" in a single place. Alerts that are still firing sit on top,
// since they're the ones you can still do something about. An alert shows
// once, at the moment it fired (or resolved, if we never saw it start).

const TONE = { good: "ok", info: "none", warn: "warn", bad: "bad" };

function Timeline({ alerts = [], activity = [] }) {
  const now = useNow(30000).getTime() / 1000;

  const firing = alerts
    .filter((a) => a.resolved_at == null)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .map((a) => ({
      key: `f-${a.key}-${a.at}`,
      at: a.at,
      tone: a.severity || "bad",
      text: a.title,
      title: a.message,
      tag: `firing${a.at != null ? ` · ${formatDuration(now - a.at)}` : ""}`,
      firing: true,
    }));

  const past = [
    ...alerts
      .filter((a) => a.resolved_at != null)
      .map((a) => ({
        key: `r-${a.key}-${a.resolved_at}`,
        at: a.resolved_at,
        tone: "ok",
        text: `${a.title} — resolved`,
        title: a.message,
      })),
    ...activity.map((e, i) => ({
      key: `a-${e.at}-${i}`,
      at: e.at,
      tone: TONE[ACTIVITY_DOT[e.kind]] || "none",
      text: e.text,
    })),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const rows = [...firing, ...past];

  if (rows.length === 0) {
    return <p className="overview-empty">Nothing has happened yet.</p>;
  }

  return (
    <ul className="timeline">
      {rows.map((r) => (
        <li key={r.key} className={`timeline-row ${r.firing ? "timeline-row--firing" : ""}`} title={r.title}>
          <span className={`status-dot status-dot--${r.tone}`} />
          <span className="timeline-text">{r.text}</span>
          {r.tag ? (
            <span className={`timeline-tag timeline-tag--${r.tone}`}>{r.tag}</span>
          ) : (
            <time className="timeline-time">{formatWhen(r.at)}</time>
          )}
        </li>
      ))}
    </ul>
  );
}

export default Timeline;
