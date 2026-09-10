// The reconcile loop records fleet transitions to /api/activity; they
// also ride the /ws payload. Newest first.

const DOT = {
  container_start: "good",
  container_healthy: "good",
  node_up: "good",
  agent_up: "good",
  deploy: "good",
  move: "info",
  container_stop: "info",
  container_restart: "warn",
  container_unhealthy: "bad",
  node_down: "bad",
  agent_down: "bad",
  deploy_failed: "bad",
};

function when(at) {
  const d = new Date(at * 1000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function ActivityFeed({ activity }) {
  if (!activity || activity.length === 0) {
    return <p className="overview-empty">No activity recorded yet.</p>;
  }

  return (
    <ul className="activity-feed">
      {activity.map((e, i) => (
        <li key={`${e.at}-${i}`} className="activity-item">
          <span className={`activity-dot activity-dot--${DOT[e.kind] || "info"}`} />
          <time className="activity-time">{when(e.at)}</time>
          <span className="activity-text">{e.text}</span>
        </li>
      ))}
    </ul>
  );
}

export default ActivityFeed;
