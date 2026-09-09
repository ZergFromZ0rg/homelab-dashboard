function Heartbeat({ heartbeat }) {
  if (!heartbeat) return null;

  const { buckets, uptime_percent: uptimePercent } = heartbeat;

  return (
    <div className="heartbeat">
      <div className="heartbeat-bars">
        {buckets.map((state, i) => (
          <div
            key={i}
            className={`heartbeat-bar heartbeat-bar--${state ?? "empty"}`}
            title={state ?? "no data"}
          />
        ))}
      </div>

      <span className="heartbeat-uptime">
        {uptimePercent != null ? `${uptimePercent}%` : "—"} (2h)
      </span>
    </div>
  );
}

export default Heartbeat;
