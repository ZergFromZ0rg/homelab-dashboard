import MainSystem from "./MainSystem";
import MachineCard from "./MachineCard";

// Every host's full vitals, one full-width card per server: the Servers
// tab is the place for detail, so each card has the width to show it all.
function HostGrid({ machines, containers, history, mainHost }) {
  const hasMainHost = Boolean(mainHost && machines[mainHost]);
  const others = Object.keys(machines)
    .filter((name) => name !== mainHost)
    .sort();

  if (!hasMainHost && others.length === 0) {
    return <p className="overview-empty">No hosts reporting yet.</p>;
  }

  return (
    <div className="machine-list">
      {hasMainHost && (
        <MainSystem
          host={mainHost}
          machine={machines[mainHost]}
          history={history[mainHost]}
          containers={containers?.[mainHost]}
        />
      )}

      {others.map((name) => (
        <MachineCard
          key={name}
          name={name}
          machine={machines[name]}
          history={history[name]}
          containers={containers?.[name]}
        />
      ))}
    </div>
  );
}

export default HostGrid;
