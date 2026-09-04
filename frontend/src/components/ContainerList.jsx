import { useState } from "react";
import ContainerRow from "./ContainerRow";
import { sortContainers } from "./containerSort";

function ContainerList({ containers, sortBy, onControl }) {
  const [collapsed, setCollapsed] = useState({});

  const hosts = Object.keys(containers).sort();

  function toggleHost(host) {
    setCollapsed((current) => ({
      ...current,
      [host]: !current[host],
    }));
  }

  return (
    <section className="containers-section">
      <div className="section-header">
        <div>
          <p className="eyebrow">Docker</p>
          <h2>Containers</h2>
        </div>
      </div>

      {hosts.length === 0 && (
        <div className="empty-state">No agents reporting containers yet.</div>
      )}

      {hosts.map((host) => {
        const hostContainers = sortContainers(containers[host], sortBy);

        const runningCount = hostContainers.filter(
          (container) => container.status === "running"
        ).length;

        const isCollapsed = Boolean(collapsed[host]);

        return (
          <div
            className={`host-group ${isCollapsed ? "" : "expanded"}`}
            key={host}
          >
            <button
              type="button"
              className="host-header"
              onClick={() => toggleHost(host)}
              aria-expanded={!isCollapsed}
            >
              <span className="host-toggle">▾</span>
              <span className="host-name">{host}</span>

              <span className="host-summary">
                <span
                  className={`host-running-count ${
                    runningCount === 0 ? "none" : ""
                  }`}
                >
                  {runningCount}/{hostContainers.length} running
                </span>
              </span>
            </button>

            {!isCollapsed && (
              <div className="container-list">
                {hostContainers.map((container) => (
                  <ContainerRow
                    key={`${host}-${container.id}`}
                    container={container}
                    host={host}
                    pending={onControl.pending}
                    onControl={onControl.run}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export default ContainerList;
