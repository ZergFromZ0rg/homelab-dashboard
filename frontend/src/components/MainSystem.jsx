import { useState } from "react";
import MachineVitals from "./MachineVitals";
import ContainerRow from "./ContainerRow";
import SortControl from "./SortControl";
import { sortContainers } from "./containerSort";

function MainSystem({ host, machine, containers, onControl }) {
  const [collapsed, setCollapsed] = useState(false);
  const [sortBy, setSortBy] = useState("name");

  const sorted = sortContainers(containers, sortBy);
  const runningCount = sorted.filter((c) => c.status === "running").length;

  return (
    <section className={`main-system ${machine.online ? "online" : "offline"}`}>
      <div className="main-system-header">
        <div>
          <p className="eyebrow">Main System</p>
          <h2>{host}</h2>
        </div>

        <span className="status">
          <span className="status-dot" />
          {machine.online ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <MachineVitals machine={machine} />

      <div className="main-system-containers">
        <div
          className={`host-header ${
            !collapsed && sorted.length > 0 ? "expanded" : ""
          }`}
        >
          <button
            type="button"
            className="host-toggle-btn"
            onClick={() => setCollapsed((current) => !current)}
            aria-expanded={!collapsed}
          >
            <span className="host-toggle">▾</span>
            <span className="host-name">Containers</span>
            <span
              className={`host-running-count ${runningCount === 0 ? "none" : ""}`}
            >
              {runningCount}/{sorted.length} running
            </span>
          </button>

          <div className="host-controls">
            <SortControl value={sortBy} onChange={setSortBy} />
          </div>
        </div>

        {!collapsed &&
          (sorted.length === 0 ? (
            <div className="empty-state">No containers reported yet.</div>
          ) : (
            <div className="container-list">
              {sorted.map((container) => (
                <ContainerRow
                  key={container.id}
                  container={container}
                  host={host}
                  pending={onControl.pending}
                  onControl={onControl.run}
                />
              ))}
            </div>
          ))}
      </div>
    </section>
  );
}

export default MainSystem;
