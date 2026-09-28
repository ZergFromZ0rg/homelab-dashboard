import MachineCard from "./MachineCard";

// Every host's full vitals, one full-width card per server, the dashboard's
// own host first. Each folds to a one-line header.
function HostGrid({ machines, containers, history, mainHost }) {
  const names = Object.keys(machines).sort((a, b) =>
    a === mainHost ? -1 : b === mainHost ? 1 : a.localeCompare(b)
  );

  if (names.length === 0) {
    return <p className="overview-empty">No hosts reporting yet.</p>;
  }

  return (
    <div className="machine-list">
      {names.map((name) => (
        <MachineCard
          key={name}
          name={name}
          machine={machines[name]}
          history={history[name]}
          containers={containers?.[name]}
          main={name === mainHost}
        />
      ))}
    </div>
  );
}

export default HostGrid;
