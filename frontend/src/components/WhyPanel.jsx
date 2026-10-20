import { useState } from "react";
import { formatBytes, formatBytesPerSec, formatWhen } from "./format";
import { RowAction } from "./RowActions";
import { usePolled } from "./usePolled";
import { fetchWhy } from "./whyApi";

// "Why is it using this?" for one container: the verdict on top, then each
// finding with the number it rests on. Worked out on the backend from the
// container's own history, the host's load and the activity feed — the page
// only lays it out, and the suggestions are buttons for things the row can
// already do, never something it runs on its own.

const ACTIONS = {
  logs: { icon: "logs", label: "Open logs" },
  compose: { icon: "sliders", label: "Edit compose" },
  details: { icon: "chart", label: "Show history" },
};

const percent = (v) => (v == null ? "—" : `${v >= 10 ? Math.round(v) : v.toFixed(1)}%`);

function usual(range, format) {
  if (!range) return "not enough history yet";
  return `${format(range.median)} · up to ${format(range.p90)} nine times in ten`;
}

function Evidence({ data }) {
  const { now, usual: base, host, neighbours, events } = data.evidence;
  const rows = [
    ["CPU now", percent(now.cpu_percent)],
    ["CPU usually", usual(base?.cpu, percent)],
    ["Memory now", formatBytes(now.memory_bytes) + (now.memory_limit_bytes ? ` of ${formatBytes(now.memory_limit_bytes)}` : " (no limit)")],
    ["Memory usually", usual(base?.memory, formatBytes)],
    ["Disk", `read ${formatBytesPerSec(now.disk_read_bps)} · write ${formatBytesPerSec(now.disk_write_bps)}`],
    ["Network", `in ${formatBytesPerSec(now.net_rx_bps)} · out ${formatBytesPerSec(now.net_tx_bps)}`],
    [`${host.name} overall`, `CPU ${percent(host.cpu_percent)} · RAM ${percent(host.ram_percent)}`],
  ];

  return (
    <div className="why-evidence">
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {neighbours.length > 0 && (
        <p>
          Busiest beside it: {neighbours.map((n) => `${n.name} ${n.cpu ? percent(n.cpu) : formatBytes(n.mem)}`).join(", ")}
        </p>
      )}
      {events.length > 0 && (
        <ul>
          {events.map((e) => (
            <li key={`${e.at}-${e.text}`}>
              <time>{formatWhen(e.at)}</time> {e.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// actions: { logs?, compose?, details? } — only what this row can actually do.
function WhyPanel({ host, container, actions, onClose }) {
  const [evidence, setEvidence] = useState(false);
  const { data, error } = usePolled(() => fetchWhy(host, container), `${host}/${container.name}`, 20000);

  return (
    <div className="crow-why" role="region" aria-label={`Why ${container.name} is using what it is`}>
      <div className="why-head">
        <span className={`why-headline ${data?.attention ? "why-headline--attention" : ""}`}>
          {data ? data.headline : error ? "Couldn't work that out" : "Looking at its history…"}
        </span>
        <button type="button" className="icon-btn icon-btn--sm" aria-label="Close" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {error && <p className="why-error">{error}</p>}

      {data && (
        <>
          <ul className="why-list">
            {data.findings.map((f) => (
              <li key={f.key} className={`why-item why-item--${f.level}`}>
                <span className="why-dot" aria-hidden="true" />
                <span className="why-title">{f.title}</span>
                {f.at != null && (
                  <time className="why-when" title="When this began or happened">
                    {formatWhen(f.at)}
                  </time>
                )}
                {f.detail && <span className="why-detail">{f.detail}</span>}
              </li>
            ))}
          </ul>

          {data.suggestions.length > 0 && (
            <div className="why-suggestions">
              {data.suggestions.map((s) => {
                const action = ACTIONS[s.action];
                const run = actions[s.action];
                return (
                  <div key={s.action} className="why-suggest">
                    {action && run && <RowAction icon={action.icon} label={action.label} onClick={run} />}
                    <span>{s.text}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="why-foot">
            <button type="button" className="why-evidence-toggle" aria-expanded={evidence} onClick={() => setEvidence((v) => !v)}>
              {evidence ? "Hide the numbers" : "Show the numbers"}
            </button>
            <span>
              From {data.evidence.history_hours} h of this container's history, {data.host}'s load and the activity feed.
            </span>
          </div>

          {evidence && <Evidence data={data} />}
        </>
      )}
    </div>
  );
}

export default WhyPanel;
