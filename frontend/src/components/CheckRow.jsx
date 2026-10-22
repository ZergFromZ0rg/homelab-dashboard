import AppIcon from "./AppIcon";
import Sparkline from "./Sparkline";
import { shortStatus, STATUS_TONE, TYPE_LABEL, uptimeTone } from "./checkStatus";

// One check as one line of the Uptime list: its dot, name and kind, how it is
// answering in a word, a short trend and the day's uptime. Everything else
// (history, the other uptimes, the actions) is in the detail beside the list.
function CheckRow({ check, depth = 0, selected, now, onSelect }) {
  const points = (check.recent || []).filter((v) => v != null).map((v) => ({ v }));
  const { status } = check;

  return (
    <button
      type="button"
      className={`up-row up-row--${status} ${check.suppressed_by ? "up-row--behind" : ""} ${selected ? "is-selected" : ""}`}
      aria-current={selected || undefined}
      onClick={() => onSelect(check.id)}
    >
      <span className={`status-dot status-dot--${STATUS_TONE[status] || "none"}`} />
      <AppIcon url={check.target} label={check.name} className="app-tile-icon ov-icon" />
      <span className="up-name" title={check.target} style={depth ? { paddingLeft: depth * 14 } : undefined}>
        {depth > 0 && <span className="check-branch" aria-hidden="true">↳</span>}
        <strong>{check.name}</strong>
        <span className="chip">{TYPE_LABEL[check.type]}</span>
        {check.origin && (
          <span className="chip" title={`Checked from ${check.origin}'s agent, not from the dashboard`}>
            from {check.origin}
          </span>
        )}
        {check.probe_error && (
          <span className="chip chip--warn" title={check.probe_error}>
            can't probe
          </span>
        )}
      </span>
      <span className={`up-now up-now--${status}`}>{shortStatus(check, now)}</span>
      <span className="up-spark">
        <Sparkline points={points} variant="rx" height={16} />
      </span>
      <span className={`up-pct check-uptime--${uptimeTone(check.uptime_24h)}`}>
        {check.uptime_24h == null ? "—" : `${check.uptime_24h}%`}
      </span>
    </button>
  );
}

export default CheckRow;
