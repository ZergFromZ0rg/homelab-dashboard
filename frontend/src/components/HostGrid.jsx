import MachineCard from "./MachineCard";

// Every host's full vitals as a row of slides: one server per screen width,
// the dashboard's own host first. Swipe or scroll sideways for the next one;
// each slide scrolls on its own when the card is taller than the window.
function HostGrid({ machines, containers, history, mainHost }) {
  const names = Object.keys(machines).sort((a, b) =>
    a === mainHost ? -1 : b === mainHost ? 1 : a.localeCompare(b)
  );

  if (names.length === 0) {
    return <p className="overview-empty">No hosts reporting yet.</p>;
  }

  return (
    <div className="ovw-hosts">
      <div className="ovw-track">
        {names.map((name) => (
          <div className="ovw-slide" key={name}>
            <MachineCard
              name={name}
              machine={machines[name]}
              history={history[name]}
              containers={containers?.[name]}
              main={name === mainHost}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default HostGrid;
