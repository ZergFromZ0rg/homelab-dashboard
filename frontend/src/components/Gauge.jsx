function Gauge({ value, size = 52, strokeWidth = 5 }) {
  const pct = value == null ? null : Math.max(0, Math.min(100, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - (pct ?? 0) / 100);

  const level = pct == null ? "" : pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";

  return (
    <div className="gauge" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="gauge-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        {pct != null && (
          <circle
            className={`gauge-fill gauge-fill--${level}`}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>

      <div className="gauge-value">{pct != null ? `${Math.round(pct)}%` : "—"}</div>
    </div>
  );
}

export default Gauge;
