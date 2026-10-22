import AppIcon from "./AppIcon";
import { shortStatus } from "./checkStatus";
import { formatLatency } from "./format";
import { useNow } from "./useNow";

const ORDER = { down: 0, degraded: 1, pending: 2, up: 3, paused: 4 };
const DOT = { up: "ok", down: "bad", degraded: "warn" };

function hint(c) {
  if (c.status === "down") return `${c.name} is down — ${c.suppressed_by ? `behind ${c.suppressed_by.name}` : (c.detail ?? "")}`;
  if (c.status === "degraded") {
    return c.lossy && !c.slow ? `${c.name} is losing packets — over ${c.max_loss}%` : `${c.name} is slow — over ${formatLatency(c.slow_ms)}`;
  }
  return c.target;
}

// Uptime checks as a dense two-column list: dot, icon, name and one short status
// ("down 18m", "89 ms"). Down sorts first and is the only thing in color; a check
// behind a down one is quiet, because the one it is behind is the news.
// `onOpen(check)` is the click.
function ServiceList({ checks, onOpen }) {
  const now = useNow(30000).getTime() / 1000;
  const sorted = [...checks].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || Number(Boolean(a.suppressed_by)) - Number(Boolean(b.suppressed_by)) || a.name.localeCompare(b.name)
  );

  return (
    <div className="ov-services">
      {sorted.map((c) => (
        <button
          type="button"
          key={c.id}
          className={`ov-service ov-service--${c.status} ${c.suppressed_by ? "ov-service--behind" : ""}`}
          onClick={() => onOpen?.(c)}
          title={hint(c)}
        >
          <span className={`status-dot status-dot--${DOT[c.status] ?? "none"}`} />
          <AppIcon url={c.target} label={c.name} className="app-tile-icon ov-icon" />
          <span className="ov-service-name">{c.name}</span>
          <span className="ov-service-ms">{shortStatus(c, now)}</span>
        </button>
      ))}
    </div>
  );
}

export default ServiceList;
