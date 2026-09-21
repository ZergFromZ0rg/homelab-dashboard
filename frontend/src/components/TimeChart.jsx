import { useState } from "react";
import { useElementWidth } from "./useElementWidth";

// One measure over time, as a line.
//
// Deliberately one measure per chart. CPU percent and memory bytes on
// shared axes would need two y-scales, which makes the crossing point of
// the two lines meaningless — the reader infers a relationship that is an
// artefact of how the axes were chosen. Two charts, stacked, sharing an
// x-axis, is the honest form.
//
// Drawn at measured pixel size rather than a scaled viewBox so the 2px
// line and the hairline grid stay the widths they claim to be.

const PAD = { top: 10, right: 10, bottom: 20, left: 46 };
const HEIGHT = 120;
const MAX_TICKS = 4;

// Ticks land on round numbers, not on max/n. Dividing the peak by three
// gives axes labelled 6.7% / 13% / 20%, which is three numbers nobody can
// compare at a glance.
//
// `base` is 10 for percentages and 1024 for bytes, so memory steps land on
// 256 MB / 512 MB / 1 GB rather than 250 MB / 500 MB.
function niceScale(maxValue, base) {
  if (!(maxValue > 0)) return { ceiling: 1, step: 1 };

  // A decade of base 1024 is 1024 wide, so it needs far more steps to
  // walk than a decade of base 10 does — with only [1,2,5,10] a 344 MB
  // peak finds nothing that fits and falls back to max/4, which is how
  // you end up with an axis labelled 86 MB.
  const multiples =
    base === 1024
      ? [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]
      : [1, 2, 2.5, 5, 10, 25, 50];

  let magnitude = base ** Math.floor(Math.log(maxValue) / Math.log(base));

  for (let decade = 0; decade < 3; decade += 1) {
    for (const multiple of multiples) {
      const step = multiple * magnitude;
      const ticks = Math.ceil(maxValue / step);
      if (ticks >= 1 && ticks <= MAX_TICKS) return { ceiling: step * ticks, step };
    }
    magnitude *= base;
  }

  return { ceiling: maxValue, step: maxValue / MAX_TICKS };
}

// What locates a point depends on how much time is on screen. A 24-hour
// window labelled with clock times alone reads as six minutes when its
// ends happen to land near the same hour — the day has to be on there
// the moment the span can cross one.
function timeLabel(seconds, spanSeconds) {
  const d = new Date(seconds * 1000);
  const clock = { hour: "2-digit", minute: "2-digit" };

  if (spanSeconds <= 12 * 3600) {
    return d.toLocaleTimeString([], clock);
  }

  if (spanSeconds <= 48 * 3600) {
    const day = d.toLocaleDateString([], { weekday: "short" });
    return `${day} ${d.toLocaleTimeString([], clock)}`;
  }

  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function TimeChart({ label, points, valueKey, format, tone = "cpu", max, base = 10 }) {
  const [ref, width] = useElementWidth();
  const [cursor, setCursor] = useState(null);

  const usable = (points || []).filter((p) => p[valueKey] != null);

  if (usable.length < 2) {
    return (
      <div className="tchart" ref={ref}>
        <div className="tchart-head">
          <span className="tchart-label">{label}</span>
        </div>
        <p className="tchart-empty">
          Not enough history yet — this fills in as the container runs.
        </p>
      </div>
    );
  }

  const values = usable.map((p) => p[valueKey]);
  const { ceiling, step } = max
    ? { ceiling: max, step: max / MAX_TICKS }
    : niceScale(Math.max(...values), base);
  const plotWidth = Math.max(0, width - PAD.left - PAD.right);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const x = (i) => PAD.left + (plotWidth * i) / (usable.length - 1);
  const y = (v) => PAD.top + plotHeight * (1 - Math.min(v, ceiling) / ceiling);

  const line = usable.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p[valueKey])}`).join(" ");
  const area =
    `${line} L${x(usable.length - 1)},${PAD.top + plotHeight} ` +
    `L${x(0)},${PAD.top + plotHeight} Z`;

  const span = usable.at(-1).t - usable[0].t;
  const latest = usable.at(-1)[valueKey];
  const active = cursor == null ? null : usable[cursor];

  function moveTo(clientX, target) {
    const box = target.getBoundingClientRect();
    const ratio = (clientX - box.left - PAD.left) / (plotWidth || 1);
    const index = Math.round(ratio * (usable.length - 1));
    setCursor(Math.max(0, Math.min(usable.length - 1, index)));
  }

  return (
    <div className="tchart" ref={ref}>
      <div className="tchart-head">
        <span className="tchart-label">{label}</span>
        {/* The value leads; the reader already knows which chart they're in. */}
        <span className={`tchart-now tchart-now--${tone}`}>
          {format(active ? active[valueKey] : latest)}
          <small>{active ? timeLabel(active.t, span) : "now"}</small>
        </span>
      </div>

      {width > 0 && (
        <svg
          className={`tchart-svg tchart-svg--${tone}`}
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${label} over time`}
          tabIndex={0}
          onPointerMove={(e) => moveTo(e.clientX, e.currentTarget)}
          onPointerLeave={() => setCursor(null)}
          onBlur={() => setCursor(null)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const from = cursor ?? usable.length - 1;
            const next = from + (e.key === "ArrowRight" ? 1 : -1);
            setCursor(Math.max(0, Math.min(usable.length - 1, next)));
          }}
        >
          {/* Solid hairlines, one shade off the surface. Dashes would read
              as thresholds; these are just a grid. */}
          {Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => {
            const value = step * i;
            return (
              <g key={i}>
                <line
                  className="tchart-grid"
                  x1={PAD.left}
                  x2={PAD.left + plotWidth}
                  y1={y(value)}
                  y2={y(value)}
                />
                <text className="tchart-ytick" x={PAD.left - 6} y={y(value) + 3}>
                  {format(value, true)}
                </text>
              </g>
            );
          })}

          <path className="tchart-area" d={area} />
          <path className="tchart-line" d={line} />

          {active && (
            <g>
              <line
                className="tchart-cursor"
                x1={x(cursor)}
                x2={x(cursor)}
                y1={PAD.top}
                y2={PAD.top + plotHeight}
              />
              <circle
                className="tchart-dot"
                cx={x(cursor)}
                cy={y(active[valueKey])}
                r="3.5"
              />
            </g>
          )}

          <text className="tchart-xtick" x={PAD.left} y={HEIGHT - 6}>
            {timeLabel(usable[0].t, span)}
          </text>
          {plotWidth > 260 && (
            <text
              className="tchart-xtick tchart-xtick--mid"
              x={PAD.left + plotWidth / 2}
              y={HEIGHT - 6}
            >
              {timeLabel(usable[Math.floor(usable.length / 2)].t, span)}
            </text>
          )}
          <text
            className="tchart-xtick tchart-xtick--end"
            x={PAD.left + plotWidth}
            y={HEIGHT - 6}
          >
            {timeLabel(usable.at(-1).t, span)}
          </text>
        </svg>
      )}
    </div>
  );
}

export default TimeChart;
