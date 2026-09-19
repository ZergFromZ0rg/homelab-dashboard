import { useSettings, HEARTBEAT_WINDOW_OPTIONS } from "./settings";

// The backend always sends 120 one-minute buckets (the full 2h it keeps)
// — finer than any single display needs — so we slice to the selected
// window and merge into a fixed number of visual bars here rather than
// asking the backend for a different resolution per window size.
const DISPLAY_BARS = 30;

function windowLabel(minutes) {
  const opt = HEARTBEAT_WINDOW_OPTIONS.find((o) => o.value === minutes);
  return opt ? opt.label : `${minutes}m`;
}

// A merged bar is "down" if any of its native buckets saw downtime (a
// single unhealthy minute inside an otherwise-fine hour should still
// show), else "up" if any saw uptime, else no data.
function mergeGroup(group) {
  const known = group.filter((b) => b != null);
  if (known.length === 0) return null;
  return known.includes("down") ? "down" : "up";
}

// `compact` is the inline table variant: bars only, no uptime text.
function Heartbeat({ heartbeat, compact = false }) {
  const {
    settings: { heartbeatWindowMinutes: windowMinutes },
  } = useSettings();

  if (!heartbeat) return null;

  const { buckets, bucket_seconds: bucketSeconds } = heartbeat;
  const wantedBuckets = Math.min(
    buckets.length,
    Math.round((windowMinutes * 60) / bucketSeconds)
  );
  const sliced = buckets.slice(buckets.length - wantedBuckets);

  const groupSize = Math.max(1, Math.ceil(sliced.length / DISPLAY_BARS));
  const bars = [];
  for (let i = 0; i < sliced.length; i += groupSize) {
    bars.push(mergeGroup(sliced.slice(i, i + groupSize)));
  }

  const known = sliced.filter((b) => b != null);
  const upCount = known.filter((b) => b === "up").length;
  const uptimePercent = known.length
    ? Math.round((upCount / known.length) * 1000) / 10
    : null;

  return (
    <div className={`heartbeat ${compact ? "heartbeat--compact" : ""}`}>
      <div className="heartbeat-bars">
        {bars.map((state, i) => (
          <div
            key={i}
            className={`heartbeat-bar heartbeat-bar--${state ?? "empty"}`}
            title={state ?? "no data"}
          />
        ))}
      </div>

      {!compact ? (
        <span className="heartbeat-uptime">
          {uptimePercent != null ? `${uptimePercent}%` : "—"} (
          {windowLabel(windowMinutes)})
        </span>
      ) : null}
    </div>
  );
}

export default Heartbeat;
