import { useState } from "react";
import ContainerRow from "./ContainerRow";
import SortControl from "./SortControl";
import { sortContainers } from "./containerSort";

function HostGroup({ host, containers, hostCores, agentReachable, onControl }) {
  const [collapsed, setCollapsed] = useState(true);
  const [sortBy, setSortBy] = useState("name");

  const sorted = sortContainers(containers, sortBy);
  const runningCount = sorted.filter((c) => c.status === "running").length;
  const unhealthyCount = sorted.filter(
    (c) => c.health === "unhealthy"
  ).length;
  const stoppedCount = sorted.length - runningCount;
  const unreachable = agentReachable === false && sorted.length === 0;

  return (
    <div className="host-group">
      <div className={`host-header ${collapsed ? "" : "expanded"}`}>
        <button
          type="button"
          className="host-toggle-btn"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
        >
          <span className="host-toggle">▾</span>
          <span className="host-name">{host}</span>
          {unreachable ? (
            <span className="host-issue host-issue--bad">agent unreachable</span>
          ) : (
            <>
              <span
                className={`host-running-count ${runningCount === 0 ? "none" : ""}`}
              >
                {runningCount}/{sorted.length} running
              </span>
              {stoppedCount > 0 && (
                <span className="host-issue">{stoppedCount} stopped</span>
              )}
              {unhealthyCount > 0 && (
                <span className="host-issue host-issue--bad">
                  {unhealthyCount} unhealthy
                </span>
              )}
            </>
          )}
        </button>

        <div className="host-controls">
          <SortControl value={sortBy} onChange={setSortBy} />
        </div>
      </div>

      {!collapsed && (
        <div className="container-list">
          {sorted.map((container) => (
            <ContainerRow
              key={container.id}
              container={container}
              host={host}
              hostCores={hostCores}
              pending={onControl.pending}
              onControl={onControl.run}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ContainerList({ containers, machines, onControl }) {
  const hosts = Object.keys(containers).sort();

  return (
    <section className="containers-section">
      {hosts.length === 0 && (
        <div className="empty-state">No agents reporting containers yet.</div>
      )}

      {hosts.map((host) => (
        <HostGroup
          key={host}
          host={host}
          containers={containers[host]}
          hostCores={machines?.[host]?.cpu_cores}
          agentReachable={machines?.[host]?.agent_reachable}
          onControl={onControl}
        />
      ))}
    </section>
  );
}

export default ContainerList;
