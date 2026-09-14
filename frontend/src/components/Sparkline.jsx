import { windowPoints } from "./historyWindow";

const WIDTH = 100;

function Sparkline({
  points,
  height = 26,
  max,
  variant = "",
  showAxis = false,
  windowMinutes,
}) {
  const clean = windowPoints(points, windowMinutes).filter((p) => p.v != null);

  let chart;

  if (clean.length < 2) {
    chart = (
      <div
        className="sparkline-empty"
        style={{ height }}
        aria-hidden="true"
      />
    );
  } else {
    const values = clean.map((p) => p.v);
    const effectiveMax = max ?? (Math.max(...values) * 1.15 || 1);
    const n = clean.length;

    const coords = clean.map((p, i) => ({
      x: (i / (n - 1)) * WIDTH,
      y: height - Math.min(1, p.v / effectiveMax) * height,
    }));

    const linePath = coords
      .map(
        (c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`
      )
      .join(" ");

    const fillPath = `${linePath} L ${coords[n - 1].x.toFixed(2)} ${height} L 0 ${height} Z`;

    chart = (
      <svg
        className={`sparkline sparkline--${variant}`}
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        aria-hidden="true"
      >
        <path className="sparkline-fill" d={fillPath} />
        <path className="sparkline-line" d={linePath} />
      </svg>
    );
  }

  return (
    <div className="sparkline-wrap">
      {chart}
      {showAxis && (
        <div className="sparkline-axis">
          <span>{windowMinutes ?? 30}m ago</span>
          <span>now</span>
        </div>
      )}
    </div>
  );
}

export default Sparkline;
