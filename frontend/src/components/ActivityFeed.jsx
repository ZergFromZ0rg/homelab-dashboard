import { formatWhen } from "./format";
import { ACTIVITY_DOT } from "./activityKinds";

// The reconcile loop records fleet transitions to /api/activity; they
// also ride the /ws payload. Newest first.


function ActivityFeed({ activity }) {
  if (!activity || activity.length === 0) {
    return <p className="overview-empty">No activity recorded yet.</p>;
  }

  return (
    <ul className="activity-feed">
      {activity.map((e, i) => (
        <li key={`${e.at}-${i}`} className="activity-item">
          <span className={`activity-dot activity-dot--${ACTIVITY_DOT[e.kind] || "info"}`} />
          <time className="activity-time">{formatWhen(e.at)}</time>
          <span className="activity-text">{e.text}</span>
        </li>
      ))}
    </ul>
  );
}

export default ActivityFeed;
