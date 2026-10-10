import { formatBytes } from "./format";

// A real progress bar: `percent` 0–100 fills it; null (not known yet, e.g.
// the scan before a backup starts) makes it a sliding indeterminate one.
// `label` is what is happening; bytes, when given, read "12 MB / 80 MB".
function ProgressBar({ percent, label, done, total, className = "" }) {
  const known = percent != null && Number.isFinite(percent);
  const pct = known ? Math.max(0, Math.min(100, percent)) : null;
  const bytes = total > 0 ? `${formatBytes(done || 0)} / ${formatBytes(total)}` : null;
  return (
    <div className={`pbar-wrap ${className}`}>
      <div
        className={`pbar ${known ? "" : "pbar--indeterminate"}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(pct) : undefined}
      >
        <span style={known ? { width: `${pct}%` } : undefined} />
      </div>
      <span className="pbar-text">
        {label && <span className="pbar-label">{label}</span>}
        {known && <strong>{Math.round(pct)}%</strong>}
        {bytes && <span className="pbar-bytes">{bytes}</span>}
      </span>
    </div>
  );
}

export default ProgressBar;
