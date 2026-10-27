import "./fleet.css";
import Panel from "./Panel";
import { busiest } from "./fleetFacts";
import { formatBytes } from "./format";
import { hostColor } from "./hostColor";
import { useLocalStorage } from "./useLocalStorage";

const VIEWS = [
  ["cpu", "CPU"],
  ["memory", "Memory"],
];

// Docker counts 100% per CPU, so a busy container reads over 100.
const cpu = (value) => `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;

// Who is using the most, across every server: the running containers by CPU or by
// memory, each with a bar against the biggest. A click opens it on Containers.
function BusiestPanel({ containers, onOpen }) {
  const [by, setBy] = useLocalStorage("homelab.busiestBy", "cpu");
  const view = VIEWS.some(([id]) => id === by) ? by : "cpu";
  const rows = busiest(containers, view);

  return (
    <Panel
      title="Busiest"
      hint="The running containers using the most, on every server"
      className="hv-busiest"
      actions={
        <div className="segmented segmented--sm" role="group" aria-label="Rank by">
          {VIEWS.map(([id, label]) => (
            <button key={id} type="button" className={view === id ? "active" : ""} aria-pressed={view === id} onClick={() => setBy(id)}>
              {label}
            </button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="overview-empty">Nothing is reporting its usage yet.</p>
      ) : (
        rows.map((row) => (
          <button key={`${row.host}/${row.id}`} type="button" className="hv-row" onClick={() => onOpen(row.name)} title={`${row.name} on ${row.host}`}>
            <span className="hv-name">
              <span className="hv-name-text">{row.name}</span>
              <span className="hv-host" style={{ color: hostColor(row.host) }}>
                {row.host}
              </span>
            </span>
            <span className="hv-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(3, Math.round(row.share * 100))}%` }} />
            </span>
            <span className="hv-val">{view === "cpu" ? cpu(row.value) : formatBytes(row.value)}</span>
          </button>
        ))
      )}
    </Panel>
  );
}

export default BusiestPanel;
