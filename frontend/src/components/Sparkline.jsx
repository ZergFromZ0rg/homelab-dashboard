const WIDTH = 100;

function Sparkline({ points, height = 26, max, variant = "" }) {
  const clean = (points || []).filter((p) => p.v != null);

  if (clean.length < 2) {
    return (
      <div className="sparkline-empty" style={{ height }} aria-hidden="true" />
    );
  }

  const values = clean.map((p) => p.v);
  const effectiveMax = max ?? (Math.max(...values) * 1.15 || 1);
  const n = clean.length;

  const coords = clean.map((p, i) => ({
    x: (i / (n - 1)) * WIDTH,
    y: height - Math.min(1, p.v / effectiveMax) * height,
  }));

  const linePath = coords
    .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`)
    .join(" ");

  const fillPath = `${linePath} L ${coords[n - 1].x.toFixed(2)} ${height} L 0 ${height} Z`;

  return (
    <svg
      className={`sparkline sparkline--${variant}`}
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="sparkline-fill" d={fillPath} />
      <path className="sparkline-line" d={linePath} />
    </svg>
  );
}

export default Sparkline;
