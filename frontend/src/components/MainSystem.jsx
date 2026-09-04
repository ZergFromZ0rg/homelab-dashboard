import MachineVitals from "./MachineVitals";
import ContainerRow from "./ContainerRow";
import { sortContainers } from "./containerSort";

function MainSystem({ host, machine, containers, sortBy, onControl }) {
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
        <div className="main-system-containers-header">
          <h3>Containers</h3>
          <span className={`host-running-count ${runningCount === 0 ? "none" : ""}`}>
            {runningCount}/{sorted.length} running
          </span>
        </div>

        {sorted.length === 0 ? (
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
        )}
      </div>
    </section>
  );
}

export default MainSystem;
